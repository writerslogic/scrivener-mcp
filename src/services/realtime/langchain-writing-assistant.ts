import { EnhancedLangChainService } from '../ai/langchain-service-enhanced.js';
import { AdvancedLangChainFeatures } from '../ai/langchain-advanced-features.js';
import { LangChainCache } from '../ai/langchain-optimizations.js';
import type { ScrivenerDocument } from '../../types/index.js';
import type { StyleGuide } from '../../memory-manager.js';
import { getLogger } from '../../core/logger.js';
import { generateScrivenerUUID } from '../../utils/scrivener-utils.js';
import { ApplicationError as AppError, ErrorCode } from '../../core/errors.js';
import { EventEmitter } from 'events';
import { AdaptiveTimeout, ProgressIndicators } from '../../utils/adaptive-timeout.js';

export interface WritingContext {
	document: ScrivenerDocument;
	currentPosition: number;
	selectedText: string;
	surroundingText: string;
	recentChanges: string[];
	writingGoals?: {
		wordCountTarget?: number;
		tone?: string;
		style?: string;
	};
}

export interface DocumentContext {
	document: ScrivenerDocument;
	relatedDocuments: Array<{ id: string; content: string; title: string }>;
	characterVoices: string[];
	themes: string[];
	writingStyle: Record<string, unknown>;
}

export interface WritingSuggestion {
	id: string;
	type: 'completion' | 'improvement' | 'correction' | 'alternative' | 'expansion';
	priority: 'high' | 'medium' | 'low';
	confidence: number;
	suggestion: string;
	explanation: string;
	preview: string;
	position: {
		start: number;
		end: number;
	};
	metadata: {
		wordCount: number;
		impact: string;
		category: string;
	};
}

export interface WritingIssue {
	id: string;
	type: 'grammar' | 'style' | 'clarity' | 'consistency' | 'flow' | 'character_voice';
	severity: 'error' | 'warning' | 'suggestion';
	message: string;
	position: {
		start: number;
		end: number;
	};
	suggestions: string[];
	autoFix?: string;
}

export interface StyleConsistency {
	score: number;
	issues: Array<{
		type: string;
		description: string;
		examples: string[];
		severity: 'high' | 'medium' | 'low';
	}>;
	trends: Array<{
		aspect: string;
		direction: 'improving' | 'declining' | 'stable';
		confidence: number;
	}>;
}

export interface PredictiveText {
	completions: Array<{
		text: string;
		confidence: number;
		type: 'word' | 'phrase' | 'sentence';
	}>;
	alternatives: Array<{
		original: string;
		suggestion: string;
		improvement: string;
	}>;
	nextSentence: string;
}

export interface WritingStream {
	onWrite: (text: string, position: number) => Promise<void>;
	onPause: (context: WritingContext) => Promise<void>;
	onDelete: (deletedText: string, position: number) => Promise<void>;
	onSelect: (selectedText: string, position: { start: number; end: number }) => Promise<void>;
}

export class RealtimeWritingAssistant extends EventEmitter {
	private langchain: EnhancedLangChainService;
	private advanced: AdvancedLangChainFeatures;
	private cache: LangChainCache;
	private logger: ReturnType<typeof getLogger>;

	private activeStreams: Map<string, WritingStream> = new Map();
	private activeSessions: Map<string, WritingSession> = new Map();
	private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
	private analysisQueue: Map<string, QueuedAnalysis> = new Map();

	constructor() {
		super();
		this.langchain = new EnhancedLangChainService();
		this.advanced = new AdvancedLangChainFeatures();
		this.cache = new LangChainCache();
		this.logger = getLogger('RealtimeWritingAssistant');
	}

	async initialize(): Promise<void> {
		// Initialize services if needed
		this.logger.info('Realtime writing assistant initialized');
	}

	async startSession(
		document: ScrivenerDocument,
		options?: {
			styleGuide?: StyleGuide;
			realTimeAnalysis?: boolean;
			suggestionLevel?: 'minimal' | 'balanced' | 'comprehensive';
			debounceMs?: number;
			assistanceType?: string;
			streamingEnabled?: boolean;
			contextWindow?: number;
		}
	): Promise<string> {
		const sessionId = `session_${document.id}_${Date.now()}`;
		const {
			styleGuide,
			realTimeAnalysis = true,
			suggestionLevel = 'balanced',
			debounceMs = 500,
			assistanceType: _assistanceType = 'general',
			streamingEnabled: _streamingEnabled = false,
			contextWindow: _contextWindow = 2000,
		} = options || {};

		try {
			this.logger.info(`Starting writing session for document: ${document.title}`);

			// Load document context and analyze style
			const context = await this.buildDocumentContext(document);
			const style = document.content
				? await this.analyzeWritingStyle([document.content])
				: null;

			// Initialize session
			const session: WritingSession = {
				id: sessionId,
				documentId: document.id,
				document,
				context,
				style,
				styleGuide,
				settings: {
					realTimeAnalysis,
					suggestionLevel,
					debounceMs,
				},
				statistics: {
					wordsWritten: 0,
					suggestionsGenerated: 0,
					suggestionsAccepted: 0,
					issuesDetected: 0,
					startTime: Date.now(),
				},
			};

			this.activeSessions.set(sessionId, session);

			// Build vector store for context-aware suggestions
			if (document.content || context.relatedDocuments?.length) {
				try {
					const vectorStoreDocuments: ScrivenerDocument[] = [
						{
							id: document.id,
							title: document.title,
							type: document.type,
							path: document.path,
							content: document.content || '',
							metadata: { title: document.title },
						},
						...(context.relatedDocuments || []).map(
							(doc: { id: string; content: string; title: string }): ScrivenerDocument => ({
								id: doc.id,
								title: doc.title,
								type: 'Text' as const,
								path: '',
								content: doc.content || '',
								metadata: { title: doc.title },
							})
						),
					];
					await this.langchain.buildVectorStore(vectorStoreDocuments);
				} catch (error) {
					this.logger.warn('Failed to build vector store for session', {
						error: (error as Error).message,
					});
				}
			}

			// Initialize writing stream
			const stream = this.createWritingStream(sessionId);
			this.activeStreams.set(sessionId, stream);

			this.emit('sessionStarted', { sessionId, document: document.title });
			return sessionId;
		} catch (error) {
			this.logger.error('Failed to start writing session', {
				error: (error as Error).message,
			});
			throw new AppError(
				'Writing session initialization failed',
				ErrorCode.INITIALIZATION_ERROR
			);
		}
	}

	private createWritingStream(sessionId: string): WritingStream {
		return {
			onWrite: async (text: string, position: number) => {
				await this.handleWrite(sessionId, text, position);
			},
			onPause: async (context: WritingContext) => {
				await this.handlePause(sessionId, context);
			},
			onDelete: async (deletedText: string, position: number) => {
				await this.handleDelete(sessionId, deletedText, position);
			},
			onSelect: async (selectedText: string, position: { start: number; end: number }) => {
				await this.handleSelect(sessionId, selectedText, position);
			},
		};
	}

	private async handleWrite(sessionId: string, text: string, position: number): Promise<void> {
		const session = this.activeSessions.get(sessionId);
		if (!session) return;

		try {
			// Update statistics
			session.statistics.wordsWritten += text.split(/\s+/).length;

			// Real-time analysis if enabled
			if (session.settings.realTimeAnalysis) {
				const issues = await this.detectIssues(text, session);

				if (issues.length > 0) {
					session.statistics.issuesDetected += issues.length;
					this.emit('issuesDetected', { sessionId, issues });
				}
			}

			// Debounced suggestions
			this.debouncedSuggestions(sessionId, text, position);

			this.emit('textWritten', {
				sessionId,
				text,
				position,
				wordCount: session.statistics.wordsWritten,
			});
		} catch (error) {
			this.logger.warn('Error handling write event', {
				sessionId,
				error: (error as Error).message,
			});
		}
	}

	private async handlePause(sessionId: string, context: WritingContext): Promise<void> {
		const session = this.activeSessions.get(sessionId);
		if (!session) return;

		try {
			// Clear any pending debounced operations
			const timer = this.debounceTimers.get(sessionId);
			if (timer) {
				clearTimeout(timer);
				this.debounceTimers.delete(sessionId);
			}

			// Generate comprehensive suggestions on pause
			const suggestions = await this.generateSuggestions(sessionId, context);

			if (suggestions.length > 0) {
				session.statistics.suggestionsGenerated += suggestions.length;
				this.emit('suggestionsReady', { sessionId, suggestions });
			}

			this.emit('writingPaused', { sessionId, context });
		} catch (error) {
			this.logger.warn('Error handling pause event', {
				sessionId,
				error: (error as Error).message,
			});
		}
	}

	private async handleDelete(
		sessionId: string,
		deletedText: string,
		position: number
	): Promise<void> {
		const session = this.activeSessions.get(sessionId);
		if (!session) return;

		try {
			// Track deletion for undo/redo suggestions
			session.statistics.wordsWritten = Math.max(
				0,
				session.statistics.wordsWritten - deletedText.split(/\s+/).length
			);

			this.emit('textDeleted', { sessionId, deletedText, position });
		} catch (error) {
			this.logger.warn('Error handling delete event', {
				sessionId,
				error: (error as Error).message,
			});
		}
	}

	private async handleSelect(
		sessionId: string,
		selectedText: string,
		position: { start: number; end: number }
	): Promise<void> {
		const session = this.activeSessions.get(sessionId);
		if (!session) return;

		try {
			// Generate selection-specific suggestions
			const suggestions = await this.generateSelectionSuggestions(
				sessionId,
				selectedText,
				position
			);

			if (suggestions.length > 0) {
				this.emit('selectionSuggestions', { sessionId, selectedText, suggestions });
			}

			this.emit('textSelected', { sessionId, selectedText, position });
		} catch (error) {
			this.logger.warn('Error handling select event', {
				sessionId,
				error: (error as Error).message,
			});
		}
	}

	private debouncedSuggestions(sessionId: string, text: string, position: number): void {
		const session = this.activeSessions.get(sessionId);
		if (!session) return;

		// Clear existing timer
		const existingTimer = this.debounceTimers.get(sessionId);
		if (existingTimer) {
			clearTimeout(existingTimer);
		}

		// Set new timer with adaptive timeout
		const predictTimeout = new AdaptiveTimeout({
			operation: 'predictive-text-generation',
			baseTimeout: session.settings.debounceMs + 5000,
			maxTimeout: session.settings.debounceMs + 15000,
			stallTimeout: 10000,
			progressIndicators: [ProgressIndicators.networkProgress('api.openai.com', 443)],
		});

		const timer = setTimeout(async () => {
			try {
				const predictions = await predictTimeout.wait(
					this.predictNext(text, position, session)
				);
				this.emit('predictiveText', { sessionId, predictions });
			} catch (error) {
				this.logger.warn('Predictive text generation failed', {
					error: (error as Error).message,
				});
			}
			this.debounceTimers.delete(sessionId);
		}, session.settings.debounceMs);

		this.debounceTimers.set(sessionId, timer);
	}

	private async detectIssues(text: string, _session: WritingSession): Promise<WritingIssue[]> {
		const issues: WritingIssue[] = [];

		try {
			// Grammar and style analysis
			const analysisPrompt = `Analyze this text for issues:

"${text}"

Check for:
1. Grammar errors
2. Style inconsistencies
3. Clarity issues
4. Flow problems
5. Character voice consistency (if applicable)

Return JSON array of issues with fields: type, severity, message, position, suggestions
Maximum 5 issues, focus on most important ones.`;

			const cacheKey = `issues_${this.hashText(text)}`;
			const cached = await this.cache.get(cacheKey);

			let result;
			if (cached) {
				result = { content: String(cached) };
			} else {
				result = await this.langchain.generateWithTemplate('issue_detection', text, {
					format: 'json',
					customPrompt: analysisPrompt,
				});
				await this.cache.set(cacheKey, result.content); // 5 min cache
			}

			const detectedIssues = JSON.parse(result.content);

			if (Array.isArray(detectedIssues)) {
				for (const issue of detectedIssues) {
					issues.push({
						id: generateScrivenerUUID(),
						type: issue.type || 'style',
						severity: issue.severity || 'suggestion',
						message: issue.message || 'Issue detected',
						position: issue.position || { start: 0, end: text.length },
						suggestions: Array.isArray(issue.suggestions) ? issue.suggestions : [],
						autoFix: issue.autoFix,
					});
				}
			}
		} catch (error) {
			this.logger.warn('Issue detection failed', { error: (error as Error).message });
		}

		return issues;
	}

	private async predictNext(
		text: string,
		position: number,
		session: WritingSession
	): Promise<PredictiveText> {
		try {
			const context = this.buildTextContext(text, position);

			const prompt = `Based on this writing context, predict what should come next:

Context: "${context.before}"
Current: "${context.current}"

Style: ${session.style ? JSON.stringify(session.style) : 'Unknown'}
Document type: ${session.document.type}

Provide:
1. 3 word completions
2. 2 phrase completions  
3. 1 sentence completion
4. 2 alternative phrasings for current text
5. Next full sentence suggestion

Return as JSON with fields: completions, alternatives, nextSentence`;

			const result = await this.langchain.generateWithTemplate('predictive_text', text, {
				format: 'json',
				customPrompt: prompt,
			});

			const predictions = JSON.parse(result.content);

			return {
				completions: [
					...(predictions.wordCompletions || []).map((text: string) => ({
						text,
						confidence: 0.8,
						type: 'word' as const,
					})),
					...(predictions.phraseCompletions || []).map((text: string) => ({
						text,
						confidence: 0.7,
						type: 'phrase' as const,
					})),
					...(predictions.sentenceCompletion
						? [
								{
									text: predictions.sentenceCompletion,
									confidence: 0.6,
									type: 'sentence' as const,
								},
							]
						: []),
				],
				alternatives: predictions.alternatives || [],
				nextSentence: predictions.nextSentence || '',
			};
		} catch (error) {
			this.logger.warn('Predictive text failed', { error: (error as Error).message });
			return { completions: [], alternatives: [], nextSentence: '' };
		}
	}

	private async generateSuggestions(
		sessionId: string,
		context: WritingContext
	): Promise<WritingSuggestion[]> {
		const session = this.activeSessions.get(sessionId);
		if (!session) return [];

		const suggestions: WritingSuggestion[] = [];

		try {
			const suggestionPrompt = `Analyze this writing and provide suggestions:

Text: "${context.surroundingText}"
Current position: ${context.currentPosition}
Selected: "${context.selectedText}"

Writing goals: ${context.writingGoals ? JSON.stringify(context.writingGoals) : 'None specified'}
Style guide: ${session.styleGuide ? JSON.stringify(session.styleGuide) : 'None'}

Provide ${this.getSuggestionCount(session.settings.suggestionLevel)} suggestions for:
1. Improvements to selected/nearby text
2. Style enhancements
3. Clarity improvements
4. Flow optimization

Return JSON array with fields: type, priority, confidence, suggestion, explanation, preview`;

			const result = await this.langchain.generateWithTemplate(
				'writing_suggestions',
				context.surroundingText,
				{
					format: 'json',
					customPrompt: suggestionPrompt,
				}
			);

			const generatedSuggestions = JSON.parse(result.content);

			if (Array.isArray(generatedSuggestions)) {
				for (const suggestion of generatedSuggestions) {
					suggestions.push({
						id: generateScrivenerUUID(),
						type: suggestion.type || 'improvement',
						priority: suggestion.priority || 'medium',
						confidence: Math.max(0, Math.min(1, suggestion.confidence || 0.7)),
						suggestion: suggestion.suggestion || '',
						explanation: suggestion.explanation || '',
						preview: suggestion.preview || suggestion.suggestion || '',
						position: {
							start: context.currentPosition,
							end: context.currentPosition + (context.selectedText?.length || 0),
						},
						metadata: {
							wordCount: (suggestion.suggestion || '').split(/\s+/).length,
							impact: suggestion.impact || 'medium',
							category: suggestion.category || 'general',
						},
					});
				}
			}
		} catch (error) {
			this.logger.warn('Suggestion generation failed', { error: (error as Error).message });
		}

		return suggestions.sort((a, b) => this.priorityScore(b) - this.priorityScore(a));
	}

	private async generateSelectionSuggestions(
		sessionId: string,
		selectedText: string,
		position: { start: number; end: number }
	): Promise<WritingSuggestion[]> {
		const session = this.activeSessions.get(sessionId);
		if (!session) return [];

		try {
			const prompt = `Provide specific suggestions for this selected text:

Selected: "${selectedText}"
Context: This is part of a ${session.document.type} document titled "${session.document.title}"

Suggest:
1. Alternative phrasings
2. Style improvements
3. Clarity enhancements
4. Expansion options

Return JSON array with type, suggestion, explanation, confidence fields.`;

			const result = await this.langchain.generateWithTemplate(
				'selection_suggestions',
				selectedText,
				{
					format: 'json',
					customPrompt: prompt,
				}
			);

			const suggestions = JSON.parse(result.content);

			return (Array.isArray(suggestions) ? suggestions : []).map((sug) => ({
				id: generateScrivenerUUID(),
				type: sug.type || 'alternative',
				priority: 'medium' as const,
				confidence: sug.confidence || 0.7,
				suggestion: sug.suggestion || '',
				explanation: sug.explanation || '',
				preview: sug.suggestion || '',
				position,
				metadata: {
					wordCount: (sug.suggestion || '').split(/\s+/).length,
					impact: 'medium',
					category: 'selection',
				},
			}));
		} catch (error) {
			this.logger.warn('Selection suggestions failed', { error: (error as Error).message });
			return [];
		}
	}

	async checkStyleConsistency(sessionId: string, text: string): Promise<StyleConsistency> {
		const session = this.activeSessions.get(sessionId);
		if (!session) {
			return { score: 0.5, issues: [], trends: [] };
		}

		try {
			const prompt = `Analyze style consistency in this text:

"${text}"

Compare against established style:
${session.style ? JSON.stringify(session.style) : 'No established style'}

Style guide requirements:
${session.styleGuide ? JSON.stringify(session.styleGuide) : 'No specific requirements'}

Provide:
1. Consistency score (0.0-1.0)
2. List of style issues with severity
3. Trends (improving/declining/stable) for different aspects

Return JSON with fields: score, issues, trends`;

			const result = await this.langchain.generateWithTemplate('style_consistency', text, {
				format: 'json',
				customPrompt: prompt,
			});

			const analysis = JSON.parse(result.content);

			return {
				score: Math.max(0, Math.min(1, analysis.score || 0.7)),
				issues: Array.isArray(analysis.issues) ? analysis.issues : [],
				trends: Array.isArray(analysis.trends) ? analysis.trends : [],
			};
		} catch (error) {
			this.logger.warn('Style consistency check failed', { error: (error as Error).message });
			return {
				score: 0.7,
				issues: [
					{
						type: 'analysis_failed',
						description: 'Style analysis unavailable',
						examples: [],
						severity: 'low',
					},
				],
				trends: [],
			};
		}
	}

	async applySuggestion(
		sessionId: string,
		suggestionId: string
	): Promise<{
		success: boolean;
		appliedText: string;
		newPosition: number;
	}> {
		const session = this.activeSessions.get(sessionId);
		if (!session) {
			throw new AppError('Session not found', ErrorCode.NOT_FOUND);
		}

		try {
			// Track suggestion acceptance
			session.statistics.suggestionsAccepted++;

			// In a real implementation, this would apply the suggestion to the document
			this.emit('suggestionApplied', { sessionId, suggestionId });

			return {
				success: true,
				appliedText: 'Suggestion applied', // Placeholder
				newPosition: 0, // Placeholder
			};
		} catch (error) {
			this.logger.error('Failed to apply suggestion', {
				sessionId,
				suggestionId,
				error: (error as Error).message,
			});
			return {
				success: false,
				appliedText: '',
				newPosition: 0,
			};
		}
	}

	getSession(sessionId: string): WritingSession | null {
		return this.activeSessions.get(sessionId) || null;
	}

	getSessionStatistics(sessionId: string): WritingSession['statistics'] | null {
		const session = this.activeSessions.get(sessionId);
		return session?.statistics || null;
	}

	async endSession(sessionId: string): Promise<{
		statistics: WritingSession['statistics'];
		summary: string;
	}> {
		const session = this.activeSessions.get(sessionId);
		if (!session) {
			throw new AppError('Session not found', ErrorCode.NOT_FOUND);
		}

		try {
			// Clear timers and streams
			const timer = this.debounceTimers.get(sessionId);
			if (timer) {
				clearTimeout(timer);
				this.debounceTimers.delete(sessionId);
			}

			this.activeStreams.delete(sessionId);
			this.analysisQueue.delete(sessionId);

			// Generate session summary
			const duration = Date.now() - session.statistics.startTime;
			const summary = await this.generateSessionSummary(session, duration);

			// Clean up
			this.activeSessions.delete(sessionId);

			this.emit('sessionEnded', { sessionId, statistics: session.statistics, summary });

			return {
				statistics: session.statistics,
				summary,
			};
		} catch (error) {
			this.logger.error('Failed to end session', {
				sessionId,
				error: (error as Error).message,
			});
			throw new AppError('Session termination failed', ErrorCode.OPERATION_FAILED);
		}
	}

	// Helper methods
	private async buildDocumentContext(document: ScrivenerDocument): Promise<DocumentContext> {
		// Build context from document and related materials
		return {
			document,
			relatedDocuments: [], // Would fetch related docs in real implementation
			characterVoices: [], // Would extract character info
			themes: [], // Would identify themes
			writingStyle: {}, // Would analyze existing style
		};
	}

	private async analyzeWritingStyle(samples: string[]): Promise<any> {
		if (samples.length === 0) return null;

		try {
			const combinedSample = samples.join('\n\n').slice(0, 2000);
			return this.advanced.analyzeWritingStyle(combinedSample);
		} catch {
			return null;
		}
	}

	private buildTextContext(
		text: string,
		position: number
	): { before: string; current: string; after: string } {
		const before = text.slice(Math.max(0, position - 200), position);
		const after = text.slice(position, Math.min(text.length, position + 200));
		const currentWord = this.getCurrentWord(text, position);

		return { before, current: currentWord, after };
	}

	private getCurrentWord(text: string, position: number): string {
		const wordStart = text.lastIndexOf(' ', position - 1) + 1;
		const wordEnd = text.indexOf(' ', position);
		return text.slice(wordStart, wordEnd === -1 ? text.length : wordEnd);
	}

	private getSuggestionCount(level: 'minimal' | 'balanced' | 'comprehensive'): number {
		switch (level) {
			case 'minimal':
				return 2;
			case 'balanced':
				return 4;
			case 'comprehensive':
				return 6;
			default:
				return 4;
		}
	}

	private priorityScore(suggestion: WritingSuggestion): number {
		const priorityValues = { high: 3, medium: 2, low: 1 };
		return priorityValues[suggestion.priority] * suggestion.confidence;
	}

	private hashText(text: string): string {
		let hash = 0;
		for (let i = 0; i < text.length; i++) {
			const char = text.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash = hash & hash;
		}
		return hash.toString();
	}

	private async generateSessionSummary(
		session: WritingSession,
		duration: number
	): Promise<string> {
		const hours = Math.floor(duration / (1000 * 60 * 60));
		const minutes = Math.floor((duration % (1000 * 60 * 60)) / (1000 * 60));

		return (
			`Writing session completed in ${hours}h ${minutes}m. ` +
			`Words written: ${session.statistics.wordsWritten}. ` +
			`Suggestions: ${session.statistics.suggestionsGenerated} generated, ${session.statistics.suggestionsAccepted} accepted. ` +
			`Issues detected: ${session.statistics.issuesDetected}.`
		);
	}
}

interface WritingSession {
	id: string;
	documentId: string;
	document: ScrivenerDocument;
	context: DocumentContext;
	style: Record<string, unknown>;
	styleGuide?: StyleGuide;
	settings: {
		realTimeAnalysis: boolean;
		suggestionLevel: 'minimal' | 'balanced' | 'comprehensive';
		debounceMs: number;
	};
	statistics: {
		wordsWritten: number;
		suggestionsGenerated: number;
		suggestionsAccepted: number;
		issuesDetected: number;
		startTime: number;
	};
}

interface QueuedAnalysis {
	type: string;
	text: string;
	timestamp: number;
}
