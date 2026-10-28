/**
 * RAG-style writing assistance backed by the direct-SDK AIClient (Claude
 * default) and the text-native HMS vector store. Replaces the LangChain-based
 * LangChainService consumed by the async job queue and the async handlers:
 * vector-store build, semantic search, context-grounded generation, style
 * analysis, and plot-consistency checks -- without any LangChain dependency.
 */

import { AIClient } from './ai-client.js';
import type { HMSVectorStore, HMSDocument } from './hms-vector-store.js';
import { getLogger } from '../../core/logger.js';
import { parseModelJson } from '../../utils/json-parse.js';
import { untrustedBlock } from '../../utils/prompt-input.js';
import { ErrorCode, createError } from '../../utils/common.js';
import type { ScrivenerDocument } from '../../types/index.js';

const logger = getLogger('ai-writing-service');

export interface RAGOptions {
	topK?: number;
	temperature?: number;
	maxTokens?: number;
}

export interface ConsistencyIssue {
	issue: string;
	severity: 'low' | 'medium' | 'high';
	locations: string[];
	suggestion: string;
}

/**
 * Join `parts` with `separator` up to `maxChars`, accumulating incrementally so the
 * full untrusted string is never materialized. Logs once when input is truncated so
 * the bound is transparent rather than silent.
 */
function accumulateToLimit(
	parts: string[],
	separator: string,
	maxChars: number,
	label: string
): string {
	let result = '';
	let truncated = false;
	for (const part of parts) {
		const sep = result ? separator : '';
		if (result.length + sep.length + part.length <= maxChars) {
			result += sep + part;
		} else {
			result += (sep + part).slice(0, maxChars - result.length);
			truncated = true;
			break;
		}
	}
	if (truncated) {
		logger.warn('Truncated untrusted input before embedding into prompt', { label, maxChars });
	}
	return result;
}

export class AIWritingService {
	private readonly ai: AIClient;
	private vectorStore: HMSVectorStore | null = null;
	private lifecycle: Promise<void> = Promise.resolve();

	constructor(ai: AIClient = new AIClient()) {
		this.ai = ai;
	}

	/** True when a chat provider is configured. */
	get isAvailable(): boolean {
		return this.ai.isAvailable;
	}

	private transition(operation: () => Promise<void>): Promise<void> {
		const pending = this.lifecycle.then(operation);
		this.lifecycle = pending.catch(() => undefined);
		return pending;
	}

	async buildVectorStore(documents: ScrivenerDocument[]): Promise<void> {
		return this.transition(async () => {
			const docs: HMSDocument[] = documents
				.filter((doc) => doc.content?.trim())
				.map((doc) => ({
					pageContent: doc.content || '',
					metadata: {
						id: doc.id,
						documentId: doc.id,
						title: doc.title || '',
						type: doc.type,
					},
					...(doc.path ? { sourceUri: doc.path } : {}),
					...(doc.metadata?.revision ? { version: doc.metadata.revision } : {}),
				}));
			if (!docs.length) return;
			if (this.vectorStore) await this.vectorStore.addDocuments(docs);
			else {
				const { HMSVectorStore } = await import('./hms-vector-store.js');
				this.vectorStore = await HMSVectorStore.fromDocuments(docs);
			}
			logger.info('Passage index updated', { documents: docs.length });
		});
	}

	/** Retrieve matching passages across the indexed documents. */
	async semanticSearch(query: string, topK: number = 5): Promise<HMSDocument[]> {
		if (!this.vectorStore) {
			throw createError(
				ErrorCode.INVALID_STATE,
				null,
				'Vector store not initialized. Call buildVectorStore first.'
			);
		}
		return this.vectorStore.similaritySearch(query, topK);
	}

	/**
	 * Generate a response grounded in the most relevant indexed passages.
	 * With topK: 0 (or no vector store yet) it falls back to context-free chat
	 * rather than failing, so callers degrade gracefully.
	 */
	async generateWithContext(prompt: string, options: RAGOptions = {}): Promise<string> {
		const topK = options.topK ?? 3;
		let context = '';
		if (topK > 0 && this.vectorStore) {
			const relevant = await this.vectorStore.similaritySearch(prompt, topK);
			context = relevant.map((doc) => doc.pageContent).join('\n\n---\n\n');
		}

		const system = context
			? 'You are a professional writing assistant. Use the provided manuscript context to keep ' +
				'suggestions accurate and consistent with the existing text.'
			: 'You are a professional writing assistant helping with a manuscript.';
		const fullPrompt = context
			? `Context from the manuscript:\n${context}\n\nRequest:\n${prompt}`
			: prompt;

		return this.ai.chat(fullPrompt, {
			system,
			temperature: options.temperature ?? 0.7,
			maxTokens: options.maxTokens ?? 1000,
		});
	}

	async analyzeWritingStyle(samples: string[]): Promise<Record<string, unknown>> {
		const joined = accumulateToLimit(
			samples,
			'\n\n---\n\n',
			8000,
			'analyzeWritingStyle samples'
		);
		const prompt =
			'Analyze the writing style of these samples and return JSON with fields: voice, tone, ' +
			'sentenceStructure, vocabularyComplexity, pacing, strengths (array), improvements (array).\n\n' +
			`Samples:\n${untrustedBlock(joined)}`;

		const raw = await this.ai.chat(prompt, {
			system: 'You are a writing-style analyst. Respond with STRICT JSON only.',
			temperature: 0.2,
			maxTokens: 1200,
		});
		const parsed = parseModelJson(raw, logger);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		logger.warn('Style analysis returned non-JSON; using minimal fallback');
		return { tone: 'neutral', complexity: 'medium', voice: 'descriptive', confidence: 0.5 };
	}

	async checkPlotConsistency(documents: ScrivenerDocument[]): Promise<ConsistencyIssue[]> {
		const sections = documents.map((d) => `## ${d.title || d.id}\n${d.content || ''}`);
		const manuscript = accumulateToLimit(
			sections,
			'\n\n',
			16000,
			'checkPlotConsistency manuscript'
		);

		const prompt =
			'Analyze this manuscript for plot, character, and timeline inconsistencies. Return a JSON ' +
			'array of issues: [{"issue":"...","severity":"low|medium|high","locations":["Chapter 1"],' +
			'"suggestion":"..."}]. Return [] if none found.\n\n' +
			`Manuscript:\n${untrustedBlock(manuscript)}`;

		const raw = await this.ai.chat(prompt, {
			system: 'You are a developmental editor. Respond with STRICT JSON only.',
			temperature: 0.2,
			maxTokens: 1500,
		});
		const parsed = parseModelJson(raw, logger);
		if (!Array.isArray(parsed)) return [];

		const severities = ['low', 'medium', 'high'];
		return parsed
			.map((item): ConsistencyIssue | null => {
				if (!item || typeof item !== 'object') return null;
				const obj = item as Record<string, unknown>;
				const issue = typeof obj.issue === 'string' ? obj.issue.trim() : '';
				if (!issue) return null;
				const severity =
					typeof obj.severity === 'string' && severities.includes(obj.severity)
						? (obj.severity as ConsistencyIssue['severity'])
						: 'medium';
				const locations = Array.isArray(obj.locations)
					? obj.locations.filter((l): l is string => typeof l === 'string')
					: [];
				const suggestion = typeof obj.suggestion === 'string' ? obj.suggestion : '';
				return { issue, severity, locations, suggestion };
			})
			.filter((i): i is ConsistencyIssue => i !== null);
	}

	clearMemory(): Promise<void> {
		return this.transition(async () => {
			await this.vectorStore?.close();
			this.vectorStore = null;
		});
	}

	close(): Promise<void> {
		return this.clearMemory();
	}
}
