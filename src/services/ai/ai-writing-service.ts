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

/** Split text into ~chunkSize-character pieces on paragraph then sentence boundaries. */
function chunkText(text: string, chunkSize = 2000): string[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	if (trimmed.length <= chunkSize) return [trimmed];

	const chunks: string[] = [];
	let current = '';
	for (const para of trimmed.split(/\n\s*\n/)) {
		if (current.length + para.length + 2 > chunkSize && current) {
			chunks.push(current.trim());
			current = '';
		}
		if (para.length > chunkSize) {
			for (let i = 0; i < para.length; i += chunkSize) {
				chunks.push(para.slice(i, i + chunkSize).trim());
			}
		} else {
			current += (current ? '\n\n' : '') + para;
		}
	}
	if (current.trim()) chunks.push(current.trim());
	return chunks.filter(Boolean);
}

function parseJsonLoose(raw: string): unknown {
	const withoutFences = raw.replace(/```(?:json)?/gi, '').trim();
	const start = withoutFences.search(/[[{]/);
	if (start === -1) return null;
	const end = Math.max(withoutFences.lastIndexOf(']'), withoutFences.lastIndexOf('}'));
	try {
		return JSON.parse(withoutFences.slice(start, end + 1));
	} catch {
		return null;
	}
}

export class AIWritingService {
	private readonly ai: AIClient;
	private vectorStore: HMSVectorStore | null = null;

	constructor(ai: AIClient = new AIClient()) {
		this.ai = ai;
	}

	/** True when a chat provider is configured. */
	get isAvailable(): boolean {
		return this.ai.isAvailable;
	}

	/** Build or extend the vector store from documents (chunked for retrieval granularity). */
	async buildVectorStore(documents: ScrivenerDocument[]): Promise<void> {
		const docs: HMSDocument[] = [];
		for (const doc of documents) {
			const chunks = chunkText(doc.content || '');
			chunks.forEach((chunk, index) => {
				docs.push({
					pageContent: chunk,
					metadata: {
						id: chunks.length > 1 ? `${doc.id}#${index}` : doc.id,
						documentId: doc.id,
						title: doc.title || '',
						type: doc.type,
					},
				});
			});
		}

		if (docs.length === 0) return;
		if (!this.vectorStore) {
			// Lazy-load the native HMS store so callers that never use vector
			// features don't pay to load the Rust engine.
			const { HMSVectorStore } = await import('./hms-vector-store.js');
			this.vectorStore = new HMSVectorStore();
		}
		await this.vectorStore.addDocuments(docs);
		logger.info('Vector store updated', { chunks: docs.length, documents: documents.length });
	}

	/** Semantic search across the indexed documents. */
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

	/** Analyze writing style from samples, returning a structured analysis object. */
	async analyzeWritingStyle(samples: string[]): Promise<Record<string, unknown>> {
		const joined = samples.join('\n\n---\n\n').slice(0, 8000);
		const prompt =
			'Analyze the writing style of these samples and return JSON with fields: voice, tone, ' +
			'sentenceStructure, vocabularyComplexity, pacing, strengths (array), improvements (array).\n\n' +
			`Samples:\n${joined}`;

		const raw = await this.ai.chat(prompt, {
			system: 'You are a writing-style analyst. Respond with STRICT JSON only.',
			temperature: 0.2,
			maxTokens: 1200,
		});
		const parsed = parseJsonLoose(raw);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		logger.warn('Style analysis returned non-JSON; using minimal fallback');
		return { tone: 'neutral', complexity: 'medium', voice: 'descriptive', confidence: 0.5 };
	}

	/** Check plot consistency across documents, returning structured issues. */
	async checkPlotConsistency(documents: ScrivenerDocument[]): Promise<ConsistencyIssue[]> {
		const manuscript = documents
			.map((d) => `## ${d.title || d.id}\n${d.content || ''}`)
			.join('\n\n')
			.slice(0, 16000);

		const prompt =
			'Analyze this manuscript for plot, character, and timeline inconsistencies. Return a JSON ' +
			'array of issues: [{"issue":"...","severity":"low|medium|high","locations":["Chapter 1"],' +
			'"suggestion":"..."}]. Return [] if none found.\n\n' +
			`Manuscript:\n${manuscript}`;

		const raw = await this.ai.chat(prompt, {
			system: 'You are a developmental editor. Respond with STRICT JSON only.',
			temperature: 0.2,
			maxTokens: 1500,
		});
		const parsed = parseJsonLoose(raw);
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

	/** Drop the in-memory vector store so the next build starts fresh. */
	clearMemory(): void {
		this.vectorStore = null;
	}
}
