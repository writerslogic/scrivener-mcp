/**
 * Provider-agnostic AI client built on the official SDKs (no LangChain).
 *
 * Chat/completion defaults to Anthropic Claude when ANTHROPIC_API_KEY is set,
 * falling back to OpenAI, then OpenRouter (an OpenAI-compatible aggregator,
 * driven through the OpenAI SDK with a base-URL override). AI_PROVIDER selects
 * explicitly. When the selected provider fails with an account-level error
 * (invalid key, exhausted credit, quota, outage), chat() automatically retries
 * on the next configured provider, ending with the MCP client's own model via
 * sampling/createMessage when the client supports it -- which also makes chat
 * work with no API key at all. Embeddings use OpenAI or OpenRouter's proxy of
 * the OpenAI embeddings API (Anthropic has none), so semantic features require
 * one of those two keys regardless of the chat provider.
 */

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
	/** Sampling temperature. Default 0.7. */
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
}

type KeyProvider = Exclude<AIProvider, 'sampling'>;

const PROVIDER_ORDER: KeyProvider[] = ['anthropic', 'openai', 'openrouter'];

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
// OpenRouter namespaces model ids by vendor; mirror the Anthropic default.
const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-sonnet-4.6';
const DEFAULT_EMBED_MODEL = 'text-embedding-3-small';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * True when an error signals the provider account or service is unusable
 * (bad key, exhausted credit, quota, outage) rather than a bad request --
 * the cases where retrying the same call on another provider can succeed.
 */
export function isProviderUnavailable(error: unknown): boolean {
	const status = (error as { status?: unknown }).status;
	if (typeof status !== 'number') return false;
	if (status === 401 || status === 402 || status === 403 || status === 429 || status >= 500) {
		return true;
	}
	// Anthropic reports exhausted credit as a 400 invalid_request_error.
	return status === 400 && /credit|billing|quota/i.test(String((error as Error).message));
}

export class AIClient {
	private readonly anthropic?: Anthropic;
	private readonly openai?: OpenAI;
	private readonly openrouter?: OpenAI;
	readonly provider: AIProvider | null;
	readonly chatModel: string;

	constructor(options: AIClientOptions = {}) {
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

		// Build a client for every configured provider (constructors do no I/O)
		// so chat() can fall back when the primary fails at the account level.
		if (keys.anthropic) {
			this.anthropic = new Anthropic({ apiKey: keys.anthropic });
		}
		if (keys.openai) {
			this.openai = new OpenAI({ apiKey: keys.openai });
		}
		if (keys.openrouter) {
			this.openrouter = new OpenAI({
				apiKey: keys.openrouter,
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
			const result = await server.createMessage({
				messages: [{ role: 'user', content: { type: 'text', text: prompt } }],
				...(options.system ? { systemPrompt: options.system } : {}),
				maxTokens,
				temperature,
			});
			return result.content.type === 'text' ? result.content.text : '';
		}

		if (provider === 'anthropic' && this.anthropic) {
			const response = await this.anthropic.messages.create({
				model,
				max_tokens: maxTokens,
				temperature,
				...(options.system ? { system: options.system } : {}),
				messages: [{ role: 'user', content: prompt }],
			});
			return response.content
				.filter((block): block is Anthropic.TextBlock => block.type === 'text')
				.map((block) => block.text)
				.join('');
		}

		// OpenRouter speaks the OpenAI chat-completions protocol.
		const compatClient = provider === 'openai' ? this.openai : this.openrouter;
		if (compatClient) {
			const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
			if (options.system) messages.push({ role: 'system', content: options.system });
			messages.push({ role: 'user', content: prompt });
			const response = await compatClient.chat.completions.create({
				model,
				max_tokens: maxTokens,
				temperature,
				messages,
			});
			return response.choices[0]?.message?.content ?? '';
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
		if (!prompt || prompt.trim().length === 0) {
			throw createError(ErrorCode.INVALID_INPUT, null, 'chat() requires a non-empty prompt');
		}

		const chain = this.providerChain;
		if (chain.length === 0) {
			throw createError(
				ErrorCode.SERVICE_UNAVAILABLE,
				null,
				'No AI provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY.'
			);
		}

		let lastError: unknown;
		for (let i = 0; i < chain.length; i++) {
			const provider = chain[i];
			const model = i === 0 ? (options.model ?? this.chatModel) : this.modelFor(provider);
			try {
				return await this.chatWith(provider, prompt, options, model);
			} catch (error) {
				lastError = error;
				if (i === chain.length - 1 || !isProviderUnavailable(error)) throw error;
				logger.warn('AI provider unavailable; falling back', {
					from: provider,
					to: chain[i + 1],
					reason: (error as Error).message,
				});
			}
		}
		throw lastError;
	}

	/**
	 * Embed texts into vectors. Uses OpenAI, or OpenRouter's proxy of the
	 * OpenAI embeddings API (Anthropic has no embeddings API). Falls back
	 * from OpenAI to OpenRouter on account-level errors.
	 * @throws when neither OPENAI_API_KEY nor OPENROUTER_API_KEY is configured.
	 */
	async embed(texts: string[]): Promise<number[][]> {
		const primary = this.openai ?? this.openrouter;
		if (!primary) {
			throw createError(
				ErrorCode.SERVICE_UNAVAILABLE,
				null,
				'Embeddings require OPENAI_API_KEY or OPENROUTER_API_KEY (Anthropic has no embeddings API).'
			);
		}
		if (texts.length === 0) return [];
		const base = process.env.OPENAI_EMBED_MODEL ?? DEFAULT_EMBED_MODEL;
		const embedWith = (client: OpenAI) => {
			// OpenRouter namespaces model ids by vendor.
			const model =
				client === this.openrouter && !base.includes('/') ? `openai/${base}` : base;
			return client.embeddings.create({ model, input: texts });
		};

		try {
			const response = await embedWith(primary);
			return response.data.map((item) => item.embedding);
		} catch (error) {
			const fallback = primary === this.openai ? this.openrouter : undefined;
			if (!fallback || !isProviderUnavailable(error)) throw error;
			logger.warn('Embeddings provider unavailable; falling back to OpenRouter', {
				reason: (error as Error).message,
			});
			const response = await embedWith(fallback);
			return response.data.map((item) => item.embedding);
		}
	}
}
