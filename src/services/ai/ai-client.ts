// Provider fallback follows explicit unavailability responses; SDK requests are never replayed.
// Client sampling can supply chat without a provider key; embeddings require a configured provider.

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { getLogger } from '../../core/logger.js';
import { ErrorCode, createError } from '../../utils/common.js';
import { getSamplingServer } from './sampling-bridge.js';

const logger = getLogger('ai-client');

/**
 * 'sampling' is the MCP client's own model, reached via sampling/createMessage
 * -- available with no API key when the connected client supports it.
 */
export type AIProvider = 'anthropic' | 'openai' | 'openrouter' | 'sampling';

export interface ChatOptions {
	/** System prompt that frames the assistant's behavior. */
	system?: string;
	/** Maximum tokens to generate. Default 1024. */
	maxTokens?: number;
	/** OpenAI, OpenRouter and MCP sampling temperature. Default 0.7; Claude uses its API default. */
	temperature?: number;
	/** Override the configured chat model for this call. */
	model?: string;
}

export interface AIClientOptions {
	anthropicApiKey?: string;
	openaiApiKey?: string;
	openrouterApiKey?: string;
	/** Force a provider; falls back to the AI_PROVIDER env var, then Anthropic-preferred. */
	provider?: AIProvider;
	/** Override the default chat model. */
	model?: string;
	/** Timeout per provider request, including response bodies: 1 through 120000 ms. Default 60000. */
	timeoutMs?: number;
}

type KeyProvider = Exclude<AIProvider, 'sampling'>;

const PROVIDER_ORDER: KeyProvider[] = ['anthropic', 'openai', 'openrouter'];

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
// OpenRouter namespaces model ids by vendor; mirror the Anthropic default.
const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-sonnet-4.6';
const DEFAULT_EMBED_MODEL = 'text-embedding-3-small';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_EMBEDDING_INPUTS = 2048;
const MAX_EMBEDDING_DIMENSIONS = 16384;
const MAX_EMBEDDING_TEXT = 32768;
const MAX_EMBEDDING_CHARACTERS = 1024 * 1024;

/**
 * True when an error signals the provider account or service is unusable
 * (bad key, exhausted credit, quota, outage) rather than a bad request --
 * the cases where retrying the same call on another provider can succeed.
 */
export function isProviderUnavailable(error: unknown): boolean {
	if (!error || typeof error !== 'object') return false;
	const status = (error as { status?: unknown }).status;
	if (typeof status !== 'number' || !Number.isInteger(status)) return false;
	if (
		status === 401 ||
		status === 402 ||
		status === 403 ||
		status === 429 ||
		(status >= 500 && status <= 599)
	) {
		return true;
	}
	// Anthropic reports exhausted credit as a 400 invalid_request_error.
	const message = (error as { message?: unknown }).message;
	return status === 400 && typeof message === 'string' && /credit|billing|quota/i.test(message);
}

function completedText(provider: AIProvider, reason: unknown, text: unknown): string {
	const complete =
		provider === 'sampling'
			? reason === undefined || reason === 'endTurn' || reason === 'stopSequence'
			: provider === 'anthropic'
				? reason === 'end_turn' || reason === 'stop_sequence'
				: reason === 'stop';
	if (!complete) {
		const limited =
			typeof reason === 'string' &&
			['max_tokens', 'length', 'maxTokens', 'model_context_window_exceeded'].includes(reason);
		throw createError(
			ErrorCode.PROCESSING_ERROR,
			{ provider },
			limited
				? 'AI response reached its token or context limit; no complete result is available'
				: 'AI provider did not return a complete text response'
		);
	}
	if (typeof text !== 'string' || !text.trim())
		throw createError(ErrorCode.PROCESSING_ERROR, { provider }, 'AI provider returned no text');
	return text;
}

function embeddingVectors(response: OpenAI.CreateEmbeddingResponse, count: number): number[][] {
	const invalid = () =>
		createError(
			ErrorCode.PROCESSING_ERROR,
			null,
			'Embedding provider returned an incomplete or invalid vector batch'
		);
	if (!Array.isArray(response?.data) || response.data.length !== count) throw invalid();
	const vectors: number[][] = new Array(count);
	let dimensions: number | undefined;
	for (const item of response.data) {
		const index = item?.index;
		const vector = item?.embedding;
		if (
			!Number.isInteger(index) ||
			index < 0 ||
			index >= count ||
			vectors[index] !== undefined ||
			!Array.isArray(vector) ||
			!vector.length ||
			vector.length > MAX_EMBEDDING_DIMENSIONS ||
			(dimensions !== undefined && vector.length !== dimensions)
		)
			throw invalid();
		for (const value of vector)
			if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid();
		dimensions = vector.length;
		vectors[index] = vector;
	}
	return vectors;
}

export class AIClient {
	private readonly anthropic?: Anthropic;
	private readonly openai?: OpenAI;
	private readonly openrouter?: OpenAI;
	private readonly timeoutMs: number;
	readonly provider: AIProvider | null;
	readonly chatModel: string;

	constructor(options: AIClientOptions = {}) {
		const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
			throw new RangeError(
				`AI timeoutMs must be an integer from 1 through ${MAX_TIMEOUT_MS}`
			);
		}
		this.timeoutMs = timeoutMs;
		if (process.env.SCRIVENER_LOCAL_ONLY === 'true') {
			this.provider = null;
			this.chatModel = '';
			return;
		}
		const keys: Record<KeyProvider, string | undefined> = {
			anthropic: options.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY,
			openai: options.openaiApiKey ?? process.env.OPENAI_API_KEY,
			openrouter: options.openrouterApiKey ?? process.env.OPENROUTER_API_KEY,
		};

		const envProvider = process.env.AI_PROVIDER?.trim().toLowerCase();
		let requested = options.provider;
		if (!requested && envProvider) {
			if (envProvider === 'sampling' || (PROVIDER_ORDER as string[]).includes(envProvider)) {
				requested = envProvider as AIProvider;
			} else {
				logger.warn('Ignoring unknown AI_PROVIDER value', { value: envProvider });
			}
		}
		// Sampling availability is only knowable after the MCP initialize
		// handshake, so an explicit sampling request is honored here and
		// validated at call time instead.
		if (requested && requested !== 'sampling' && !keys[requested]) {
			logger.warn('Requested AI provider has no API key; falling back', { requested });
			requested = undefined;
		}

		// so chat() can fall back when the primary fails at the account level.
		if (keys.anthropic) {
			this.anthropic = new Anthropic({
				apiKey: keys.anthropic,
				timeout: timeoutMs,
				maxRetries: 0,
			});
		}
		if (keys.openai) {
			this.openai = new OpenAI({ apiKey: keys.openai, timeout: timeoutMs, maxRetries: 0 });
		}
		if (keys.openrouter) {
			this.openrouter = new OpenAI({
				apiKey: keys.openrouter,
				timeout: timeoutMs,
				maxRetries: 0,
				baseURL: OPENROUTER_BASE_URL,
				defaultHeaders: {
					'HTTP-Referer': 'https://github.com/writerslogic/scrivener-mcp',
					'X-Title': 'scrivener-mcp',
				},
			});
		}

		this.provider = requested ?? PROVIDER_ORDER.find((p) => keys[p]) ?? null;
		this.chatModel = this.provider ? (options.model ?? this.modelFor(this.provider)) : '';

		logger.info('AIClient initialized', {
			provider: this.provider ?? 'none',
			chatModel: this.chatModel || '(none)',
			embeddings: this.openai ? 'openai' : this.openrouter ? 'openrouter' : 'unavailable',
		});
	}

	/** True when a chat provider is configured or the MCP client supports sampling. */
	get isAvailable(): boolean {
		if (process.env.SCRIVENER_LOCAL_ONLY === 'true') return false;
		return this.provider !== null || getSamplingServer() !== null;
	}

	private modelFor(provider: AIProvider): string {
		if (provider === 'anthropic') {
			return process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
		}
		if (provider === 'openai') {
			return process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
		}
		if (provider === 'openrouter') {
			return process.env.OPENROUTER_MODEL ?? DEFAULT_OPENROUTER_MODEL;
		}
		// sampling: the MCP client chooses its own model.
		return '';
	}

	private clientFor(provider: KeyProvider): Anthropic | OpenAI | undefined {
		if (provider === 'anthropic') return this.anthropic;
		if (provider === 'openai') return this.openai;
		return this.openrouter;
	}

	/**
	 * The selected provider first, then every other configured one, with
	 * client-side sampling as the final fallback (or the primary when
	 * explicitly requested). Evaluated per call because sampling availability
	 * is only known after the MCP initialize handshake.
	 */
	private get providerChain(): AIProvider[] {
		if (process.env.SCRIVENER_LOCAL_ONLY === 'true') return [];
		const keyProviders = PROVIDER_ORDER.filter((p) => this.clientFor(p));
		const chain: AIProvider[] =
			this.provider && this.provider !== 'sampling'
				? [this.provider, ...keyProviders.filter((p) => p !== this.provider)]
				: [...keyProviders];
		if (this.provider === 'sampling') {
			chain.unshift('sampling');
		} else if (getSamplingServer()) {
			chain.push('sampling');
		}
		return chain;
	}

	private async chatWith(
		provider: AIProvider,
		prompt: string,
		options: ChatOptions,
		model: string
	): Promise<string> {
		const maxTokens = options.maxTokens ?? 1024;
		const temperature = options.temperature ?? 0.7;

		if (provider === 'sampling') {
			const server = getSamplingServer();
			if (!server) {
				throw createError(
					ErrorCode.SERVICE_UNAVAILABLE,
					null,
					'The connected MCP client does not support sampling.'
				);
			}
			const result = await server.createMessage(
				{
					messages: [{ role: 'user', content: { type: 'text', text: prompt } }],
					...(options.system ? { systemPrompt: options.system } : {}),
					maxTokens,
					temperature,
				},
				{
					timeout: this.timeoutMs,
					maxTotalTimeout: this.timeoutMs,
					resetTimeoutOnProgress: false,
				}
			);
			return completedText(
				provider,
				result.stopReason,
				result.content.type === 'text' ? result.content.text : undefined
			);
		}

		if (provider === 'anthropic' && this.anthropic) {
			const response = await this.anthropic.messages.create(
				{
					model,
					max_tokens: maxTokens,
					...(options.system ? { system: options.system } : {}),
					messages: [{ role: 'user', content: prompt }],
				},
				{ signal: AbortSignal.timeout(this.timeoutMs) }
			);
			const blocks = response.content.filter(
				(block): block is Anthropic.TextBlock => block?.type === 'text'
			);
			const text = blocks.every((block) => typeof block.text === 'string')
				? blocks.map((block) => block.text).join('')
				: undefined;
			return completedText(provider, response.stop_reason, text);
		}

		// OpenRouter speaks the OpenAI chat-completions protocol.
		const compatClient = provider === 'openai' ? this.openai : this.openrouter;
		if (compatClient) {
			const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
			if (options.system) messages.push({ role: 'system', content: options.system });
			messages.push({ role: 'user', content: prompt });
			const response = await compatClient.chat.completions.create(
				{
					model,
					max_tokens: maxTokens,
					temperature,
					messages,
				},
				{ signal: AbortSignal.timeout(this.timeoutMs) }
			);
			const choice = response.choices[0];
			return completedText(provider, choice?.finish_reason, choice?.message?.content);
		}

		throw createError(
			ErrorCode.SERVICE_UNAVAILABLE,
			null,
			`AI provider ${provider} is not configured.`
		);
	}

	/**
	 * Single-turn chat completion. Returns the assistant's text.
	 * When the selected provider fails at the account level (bad key, exhausted
	 * credit, quota, outage), the call is retried on the next configured
	 * provider using that provider's own default model, since model ids do not
	 * transfer across providers.
	 * @throws when no chat provider is configured, or on non-account errors.
	 */
	async chat(prompt: string, options: ChatOptions = {}): Promise<string> {
		if (typeof prompt !== 'string' || !prompt.trim()) {
			throw createError(ErrorCode.INVALID_INPUT, null, 'chat() requires a non-empty prompt');
		}
		if (!options || typeof options !== 'object' || Array.isArray(options))
			throw createError(ErrorCode.INVALID_INPUT, null, 'Chat options must be an object');
		const request = { ...options };

		const chain = this.providerChain;
		if (chain.length === 0) {
			throw createError(
				ErrorCode.SERVICE_UNAVAILABLE,
				null,
				'No AI provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY.'
			);
		}
		const models = chain.map((provider, index) =>
			index === 0 ? (request.model ?? this.chatModel) : this.modelFor(provider)
		);

		let lastError: unknown;
		for (let i = 0; i < chain.length; i++) {
			const provider = chain[i];
			try {
				return await this.chatWith(provider, prompt, request, models[i]);
			} catch (error) {
				lastError = error;
				if (i === chain.length - 1 || !isProviderUnavailable(error)) throw error;
				logger.warn('AI provider unavailable; falling back', {
					from: provider,
					to: chain[i + 1],
					status: (error as { status: number }).status,
				});
			}
		}
		throw lastError;
	}

	/**
	 * Embed texts into vectors. Uses OpenAI, or OpenRouter's proxy of the
	 * OpenAI embeddings API (Anthropic has no embeddings API). Falls back
	 * from OpenAI to OpenRouter on account-level errors.
	 * Accepts at most 2048 nonblank texts, 32768 UTF-16 characters per text,
	 * and 1 Mi UTF-16 characters in total. Provider token limits also apply.
	 * @throws when neither OPENAI_API_KEY nor OPENROUTER_API_KEY is configured.
	 */
	async embed(texts: string[]): Promise<number[][]> {
		if (process.env.SCRIVENER_LOCAL_ONLY === 'true')
			throw new Error('Provider requests are disabled in local-only mode');
		if (!Array.isArray(texts) || texts.length > MAX_EMBEDDING_INPUTS)
			throw new RangeError('Embedding input must contain at most 2048 texts');
		const inputs = [...texts];
		let characters = 0;
		for (const text of inputs) {
			if (typeof text !== 'string' || text.length > MAX_EMBEDDING_TEXT || !text.trim())
				throw new RangeError('Each embedding text must contain 1–32768 UTF-16 characters');
			characters += text.length;
			if (characters > MAX_EMBEDDING_CHARACTERS)
				throw new RangeError('Embedding input exceeds 1 Mi UTF-16 characters');
		}
		const primary = this.openai ?? this.openrouter;
		if (!primary) {
			throw createError(
				ErrorCode.SERVICE_UNAVAILABLE,
				null,
				'Embeddings require OPENAI_API_KEY or OPENROUTER_API_KEY (Anthropic has no embeddings API).'
			);
		}
		if (inputs.length === 0) return [];
		const base = process.env.OPENAI_EMBED_MODEL ?? DEFAULT_EMBED_MODEL;
		const embedWith = (client: OpenAI) => {
			// OpenRouter namespaces model ids by vendor.
			const model =
				client === this.openrouter && !base.includes('/') ? `openai/${base}` : base;
			return client.embeddings.create(
				{ model, input: inputs },
				{
					signal: AbortSignal.timeout(this.timeoutMs),
				}
			);
		};

		try {
			const response = await embedWith(primary);
			return embeddingVectors(response, inputs.length);
		} catch (error) {
			const fallback = primary === this.openai ? this.openrouter : undefined;
			if (!fallback || !isProviderUnavailable(error)) throw error;
			logger.warn('Embeddings provider unavailable; falling back to OpenRouter', {
				status: (error as { status: number }).status,
			});
			const response = await embedWith(fallback);
			return embeddingVectors(response, inputs.length);
		}
	}
}
