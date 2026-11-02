import { analysisEnvelope, type AnalysisEnvelope } from '../editorial/analysis-envelope.js';
import type { ManuscriptSource, SourceDocument } from '../editorial/types.js';
import type { AIWritingService } from './ai-writing-service.js';

export const MAX_SUGGESTION_PROMPT = 16000;
export const MAX_SUGGESTION_CONTEXT = 16000;

export interface SuggestionRequest {
	prompt: string;
	documentId?: string;
	useContext?: boolean;
}

export interface PreparedSuggestions extends SuggestionRequest {
	useContext: boolean;
	expectedRevision?: string;
}

export interface SuggestionResult {
	suggestions: string;
	envelope: AnalysisEnvelope;
	context:
		| { mode: 'none' }
		| {
				mode: 'saved-document';
				start: 0;
				end: number;
				sourceCharacters: number;
				truncated: boolean;
		  };
}

function validateRequest(request: SuggestionRequest, prepared = false): void {
	if (!request || typeof request !== 'object' || Array.isArray(request))
		throw new Error('Suggestion request must be an object');
	const keys = ['prompt', 'documentId', 'useContext', ...(prepared ? ['expectedRevision'] : [])];
	if (Object.keys(request).some((key) => !keys.includes(key)))
		throw new Error('Suggestion request contains unsupported fields');
	if (
		typeof request.prompt !== 'string' ||
		!request.prompt.trim() ||
		request.prompt.length > MAX_SUGGESTION_PROMPT
	)
		throw new Error('Suggestion prompt must contain 1–16000 UTF-16 characters');
	if (request.useContext !== undefined && typeof request.useContext !== 'boolean')
		throw new Error('useContext must be a boolean');
	if (
		request.documentId !== undefined &&
		(typeof request.documentId !== 'string' ||
			!request.documentId.trim() ||
			request.documentId.length > 255)
	)
		throw new Error('documentId must contain 1–255 characters');
	if (request.useContext && !request.documentId)
		throw new Error('documentId is required when useContext is true');
}

export class WritingSuggestions {
	constructor(
		private readonly writing: AIWritingService,
		private readonly projectId: string,
		private readonly projectPath: string | null,
		private readonly getSource?: () => ManuscriptSource
	) {}

	async prepare(request: SuggestionRequest): Promise<PreparedSuggestions> {
		validateRequest(request);
		const { prompt, documentId, useContext = false } = request;
		const snapshot = {
			prompt,
			...(documentId !== undefined ? { documentId } : {}),
			useContext,
		};
		if (!useContext) return snapshot;
		const document = await this.read(this.source(), documentId!);
		return { ...snapshot, expectedRevision: document.revision };
	}

	async generate(request: PreparedSuggestions, signal?: AbortSignal): Promise<SuggestionResult> {
		signal?.throwIfAborted();
		validateRequest(request, true);
		const { prompt, documentId, useContext, expectedRevision } = request;
		if (
			typeof useContext !== 'boolean' ||
			(useContext
				? typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)
				: expectedRevision !== undefined)
		)
			throw new Error('Suggestion context requires an admitted saved source revision');
		if (!this.writing.isAvailable) throw new Error('AI writing provider is unavailable');
		const source = useContext ? this.source() : undefined;
		const document = source ? await this.read(source, documentId!) : undefined;
		if (document && document.revision !== expectedRevision)
			throw new Error('Saved source changed before suggestion generation; refresh and retry');
		let excerpt: string | undefined;
		let context: SuggestionResult['context'] = { mode: 'none' };
		if (document) {
			let end = Math.min(document.text.length, MAX_SUGGESTION_CONTEXT);
			if (end < document.text.length && /[\uD800-\uDBFF]/.test(document.text[end - 1])) end--;
			excerpt = document.text.slice(0, end);
			context = {
				mode: 'saved-document',
				start: 0,
				end,
				sourceCharacters: document.text.length,
				truncated: end < document.text.length,
			};
		}
		const suggestions = await this.writing.generateWithContext(prompt, {
			signal,
			topK: 0,
			context: excerpt,
		});
		signal?.throwIfAborted();
		if (typeof suggestions !== 'string' || !suggestions.trim())
			throw new Error('Suggestion generation unavailable: the provider returned no text');
		if (source && (await this.read(source, documentId!)).revision !== expectedRevision)
			throw new Error('Saved source changed during suggestion generation; refresh and retry');
		const envelope = analysisEnvelope(
			this.projectId,
			'document',
			document ? [document] : [],
			{},
			'provider',
			{ operation: 'suggest_improvements', prompt, context },
			document ? 'saved-rtf' : 'supplied-text'
		);
		envelope.policy.revisionChecked = useContext;
		return { suggestions, envelope, context };
	}

	private source(): ManuscriptSource {
		const source = this.getSource?.();
		if (!source) throw new Error('Saved manuscript context requires an open project');
		if (source.projectId !== this.projectId || source.projectPath !== this.projectPath)
			throw new Error('Suggestion source belongs to a different project');
		return source;
	}

	private async read(source: ManuscriptSource, documentId: string): Promise<SourceDocument> {
		const document = await source.read(documentId);
		if (
			document.projectId !== this.projectId ||
			document.documentId !== documentId ||
			typeof document.revision !== 'string' ||
			!/^[a-f0-9]{64}$/.test(document.revision) ||
			typeof document.text !== 'string'
		)
			throw new Error('Saved suggestion source has invalid identity, revision or text');
		return { ...document };
	}
}
