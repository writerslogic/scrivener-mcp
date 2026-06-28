/**
 * Provider-agnostic AI client built on the official SDKs (no LangChain).
 *
 * Chat/completion defaults to Anthropic Claude when ANTHROPIC_API_KEY is set,
 * falling back to OpenAI. Embeddings always use OpenAI -- Anthropic has no
 * embeddings API -- so semantic features require OPENAI_API_KEY regardless of
 * the chat provider.
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { getLogger } from '../../core/logger.js';
import { ErrorCode, createError } from '../../utils/common.js';

const logger = getLogger('ai-client');

export type AIProvider = 'anthropic' | 'openai';

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
	/** Force a provider; otherwise Anthropic is preferred when its key exists. */
	provider?: AIProvider;
	/** Override the default chat model. */
	model?: string;
}

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const DEFAULT_EMBED_MODEL = 'text-embedding-3-small';

export class AIClient {
	private readonly anthropic?: Anthropic;
	private readonly openai?: OpenAI;
	readonly provider: AIProvider | null;
	readonly chatModel: string;

	constructor(options: AIClientOptions = {}) {
		const anthropicKey = options.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
		const openaiKey = options.openaiApiKey ?? process.env.OPENAI_API_KEY;
		const wantsOpenAI = options.provider === 'openai';

		if (!wantsOpenAI && anthropicKey) {
			this.anthropic = new Anthropic({ apiKey: anthropicKey });
			this.provider = 'anthropic';
			this.chatModel =
				options.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
		} else if (openaiKey) {
			this.openai = new OpenAI({ apiKey: openaiKey });
			this.provider = 'openai';
			this.chatModel = options.model ?? process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
		} else {
			this.provider = null;
			this.chatModel = '';
		}

		// An OpenAI client is also needed for embeddings even when Claude handles chat.
		if (!this.openai && openaiKey) {
			this.openai = new OpenAI({ apiKey: openaiKey });
		}

		logger.info('AIClient initialized', {
			provider: this.provider ?? 'none',
			chatModel: this.chatModel || '(none)',
			embeddings: this.openai ? 'openai' : 'unavailable',
		});
	}

	/** True when a chat provider is configured. */
	get isAvailable(): boolean {
		return this.provider !== null;
	}

	/**
	 * Single-turn chat completion. Returns the assistant's text.
	 * @throws when no chat provider is configured.
	 */
	async chat(prompt: string, options: ChatOptions = {}): Promise<string> {
		if (!prompt || prompt.trim().length === 0) {
			throw createError(ErrorCode.INVALID_INPUT, null, 'chat() requires a non-empty prompt');
		}
		const maxTokens = options.maxTokens ?? 1024;
		const temperature = options.temperature ?? 0.7;

		if (this.provider === 'anthropic' && this.anthropic) {
			const response = await this.anthropic.messages.create({
				model: options.model ?? this.chatModel,
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

		if (this.provider === 'openai' && this.openai) {
			const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
			if (options.system) messages.push({ role: 'system', content: options.system });
			messages.push({ role: 'user', content: prompt });
			const response = await this.openai.chat.completions.create({
				model: options.model ?? this.chatModel,
				max_tokens: maxTokens,
				temperature,
				messages,
			});
			return response.choices[0]?.message?.content ?? '';
		}

		throw createError(
			ErrorCode.SERVICE_UNAVAILABLE,
			null,
			'No AI provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.'
		);
	}

	/**
	 * Embed texts into vectors. Uses OpenAI (Anthropic has no embeddings API).
	 * @throws when OPENAI_API_KEY is not configured.
	 */
	async embed(texts: string[]): Promise<number[][]> {
		if (!this.openai) {
			throw createError(
				ErrorCode.SERVICE_UNAVAILABLE,
				null,
				'Embeddings require OPENAI_API_KEY (Anthropic has no embeddings API).'
			);
		}
		if (texts.length === 0) return [];
		const model = process.env.OPENAI_EMBED_MODEL ?? DEFAULT_EMBED_MODEL;
		const response = await this.openai.embeddings.create({ model, input: texts });
		return response.data.map((item) => item.embedding);
	}
}
