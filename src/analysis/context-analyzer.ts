import type { DatabaseService } from '../handlers/database/database-service.js';
import { safeParse } from '../utils/common.js';
import type { ContentAnalyzer, ContentAnalysis } from './base-analyzer.js';

export interface ScrivenerDocument {
	id: string;
	title: string;
	type: 'Text' | 'Folder' | 'Other';
	synopsis?: string;
	notes?: string;
	wordCount: number;
	characterCount: number;
	children?: ScrivenerDocument[];
}

export interface ChapterContext {
	documentId: string;
	title: string;
	synopsis?: string;
	notes?: string;
	wordCount: number;
	characters: Array<{
		id: string;
		name: string;
		role?: string;
		appearances: number;
		lastMention?: string;
	}>;
	themes: Array<{
		name: string;
		prominence: number;
		examples: string[];
	}>;
	plotThreads: Array<{
		id: string;
		name: string;
		status: string;
		developments: string[];
	}>;
	previousChapter?: {
		id: string;
		title: string;
		summary: string;
	};
	nextChapter?: {
		id: string;
		title: string;
	};
	emotionalArc: {
		start: string;
		peak: string;
		end: string;
		overall: string;
	};
	pacing: {
		score: number;
		description: string;
		suggestions: string[];
	};
	keyEvents: string[];
	cliffhangers: string[];
	foreshadowing: string[];
	callbacks: string[];
}

export interface StoryContext {
	projectTitle: string;
	totalWordCount: number;
	chapterCount: number;
	characterArcs: Map<
		string,
		{
			character: string;
			introduction: string;
			development: string[];
			currentStatus: string;
			projectedArc: string;
		}
	>;
	themeProgression: Map<
		string,
		{
			theme: string;
			introduction: string;
			developments: string[];
			currentStrength: number;
		}
	>;
	plotThreads: Map<
		string,
		{
			thread: string;
			status: 'setup' | 'developing' | 'climax' | 'resolved';
			chapters: string[];
			keyEvents: string[];
		}
	>;
	overallPacing: {
		trend: 'accelerating' | 'steady' | 'decelerating' | 'variable';
		intensityPoints: Array<{ chapter: string; intensity: number }>;
		suggestions: string[];
	};
}

export class ContextAnalyzer {
	constructor(
		private databaseService: DatabaseService,
		private contentAnalyzer: ContentAnalyzer
	) {}

	/**
	 * Analyze a chapter and build its context
	 */
	async analyzeChapter(
		document: ScrivenerDocument,
		content: string,
		allDocuments: ScrivenerDocument[]
	): Promise<ChapterContext> {
		// Get basic analysis
		const basicAnalysis = await this.contentAnalyzer.analyzeContent(content, document.id);

		// Find previous and next chapters
		const chapterIndex = allDocuments.findIndex((d) => d.id === document.id);
		const previousChapter = chapterIndex > 0 ? allDocuments[chapterIndex - 1] : undefined;
		const nextChapter =
			chapterIndex < allDocuments.length - 1 ? allDocuments[chapterIndex + 1] : undefined;

		// Extract character mentions
		const characters = await this.extractCharacterMentions(document.id, content);

		// Extract themes
		const themes = await this.extractThemes(content, basicAnalysis);

		// Get plot threads for this chapter
		const plotThreads = await this.getChapterPlotThreads(document.id);

		// Analyze emotional arc
		const emotionalArc = this.analyzeEmotionalArc(content, basicAnalysis);

		// Extract key narrative elements
		const keyEvents = this.extractKeyEvents(content);
		const cliffhangers = this.extractCliffhangers(content);
		const foreshadowing = this.extractForeshadowing(content);
		const callbacks = this.extractCallbacks(content, allDocuments);

		// Build chapter context
		const context: ChapterContext = {
			documentId: document.id,
			title: document.title,
			synopsis: document.synopsis,
			notes: document.notes,
			wordCount: basicAnalysis.metrics.wordCount,
			characters,
			themes,
			plotThreads,
			previousChapter: previousChapter
				? {
						id: previousChapter.id,
						title: previousChapter.title,
						summary: previousChapter.synopsis || 'No synopsis available',
					}
				: undefined,
			nextChapter: nextChapter
				? {
						id: nextChapter.id,
						title: nextChapter.title,
					}
				: undefined,
			emotionalArc,
			pacing: {
				score:
					basicAnalysis.pacing?.overall === 'fast'
						? 0.8
						: basicAnalysis.pacing?.overall === 'slow'
							? 0.3
							: 0.5,
				description: this.describePacing(
					basicAnalysis.pacing?.overall === 'fast'
						? 0.8
						: basicAnalysis.pacing?.overall === 'slow'
							? 0.3
							: 0.5
				),
				suggestions: basicAnalysis.suggestions
					.filter((s) => s.suggestion?.includes('pacing'))
					.map((s) => s.suggestion),
			},
			keyEvents,
			cliffhangers,
			foreshadowing,
			callbacks,
		};

		// Store context in database
		await this.storeChapterContext(context);

		return context;
	}

	/**
	 * Build complete story context
	 */
	async buildStoryContext(
		_documents: ScrivenerDocument[],
		chapterContexts: ChapterContext[]
	): Promise<StoryContext> {
		const characterArcs = await this.buildCharacterArcs(chapterContexts);
		const themeProgression = await this.buildThemeProgression(chapterContexts);
		const plotThreads = await this.buildPlotThreadMap(chapterContexts);
		const overallPacing = this.analyzeOverallPacing(chapterContexts);

		const storyContext: StoryContext = {
			projectTitle: 'Project', // Would need to get from project metadata
			totalWordCount: chapterContexts.reduce((sum, ctx) => sum + ctx.wordCount, 0),
			chapterCount: chapterContexts.length,
			characterArcs,
			themeProgression,
			plotThreads,
			overallPacing,
		};

		// Store in database
		await this.storeStoryContext(storyContext);

		return storyContext;
	}

	/**
	 * Extract character mentions from content
	 */
	private async extractCharacterMentions(
		documentId: string,
		content: string
	): Promise<ChapterContext['characters']> {
		const characters: ChapterContext['characters'] = [];

		// Get known characters from database
		if (this.databaseService.getSQLite()) {
			const knownCharacters = this.databaseService
				.getSQLite()
				.query('SELECT id, name, role FROM characters') as Array<{
				id: string;
				name: string;
				role: string;
			}>;

			for (const char of knownCharacters) {
				const regex = new RegExp(`\\b${char.name}\\b`, 'gi');
				const matches = content.match(regex);

				if (matches && matches.length > 0) {
					// Find last mention position
					const lastIndex = content.lastIndexOf(char.name);
					const contextStart = Math.max(0, lastIndex - 50);
					const contextEnd = Math.min(content.length, lastIndex + 50);
					const lastMention = content.substring(contextStart, contextEnd).trim();

					characters.push({
						id: char.id,
						name: char.name,
						role: char.role,
						appearances: matches.length,
						lastMention,
					});

					// Create character-document relationship in Neo4j
					if (this.databaseService.getNeo4j()) {
						await this.databaseService.createRelationship(
							char.id,
							'character',
							documentId,
							'document',
							'APPEARS_IN',
							{ appearances: matches.length }
						);
					}
				}
			}
		}

		return characters;
	}

	/**
	 * Extract themes from content
	 */
	private async extractThemes(
		content: string,
		_analysis: ContentAnalysis
	): Promise<ChapterContext['themes']> {
		const themes: ChapterContext['themes'] = [];

		// Common theme keywords
		const themeKeywords = {
			love: ['love', 'romance', 'heart', 'passion', 'affection'],
			death: ['death', 'dying', 'mortality', 'grave', 'funeral'],
			power: ['power', 'control', 'authority', 'dominance', 'strength'],
			identity: ['identity', 'self', 'who am I', 'belonging', 'purpose'],
			family: ['family', 'mother', 'father', 'sibling', 'parent', 'child'],
			betrayal: ['betrayal', 'betray', 'deceive', 'lie', 'trust'],
			redemption: ['redemption', 'forgive', 'atone', 'second chance', 'salvation'],
			freedom: ['freedom', 'liberty', 'escape', 'prison', 'chains'],
		};

		for (const [theme, keywords] of Object.entries(themeKeywords)) {
			const examples: string[] = [];
			let totalMatches = 0;

			for (const keyword of keywords) {
				const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
				const matches = content.match(regex);

				if (matches) {
					totalMatches += matches.length;

					// Get example context
					const firstMatch = content.search(regex);
					if (firstMatch !== -1) {
						const start = Math.max(0, firstMatch - 30);
						const end = Math.min(content.length, firstMatch + keyword.length + 30);
						examples.push(content.substring(start, end).trim());
					}
				}
			}

			if (totalMatches > 0) {
				themes.push({
					name: theme,
					prominence: Math.min(1, totalMatches / 10), // Normalize to 0-1
					examples: examples.slice(0, 3), // Keep top 3 examples
				});
			}
		}

		// Sort by prominence
		themes.sort((a, b) => b.prominence - a.prominence);

		return themes;
	}

	/**
	 * Get plot threads for a chapter
	 */
	private async getChapterPlotThreads(
		documentId: string
	): Promise<ChapterContext['plotThreads']> {
		const threads: ChapterContext['plotThreads'] = [];

		if (this.databaseService.getSQLite()) {
			const plotThreads = this.databaseService.getSQLite().query(
				`SELECT id, name, status, developments
				 FROM plot_threads
				 WHERE json_extract(documents_involved, '$') LIKE '%${documentId}%'`
			) as Array<{ id: string; name: string; status: string; developments: string }>;

			for (const thread of plotThreads) {
				threads.push({
					id: thread.id,
					name: thread.name,
					status: thread.status,
					developments: thread.developments ? safeParse(thread.developments, []) : [],
				});
			}
		}

		return threads;
	}

	/**
	 * Analyze emotional arc of content
	 */
	private analyzeEmotionalArc(
		content: string,
		_analysis: ContentAnalysis
	): ChapterContext['emotionalArc'] {
		// Split content into thirds
		const third = Math.floor(content.length / 3);
		const start = content.substring(0, third);
		const middle = content.substring(third, third * 2);
		const end = content.substring(third * 2);

		// Analyze each section
		const startEmotion = this.detectDominantEmotion(start);
		const peakEmotion = this.detectDominantEmotion(middle);
		const endEmotion = this.detectDominantEmotion(end);

		// Determine overall arc
		let overall = 'steady';
		if (startEmotion === 'positive' && endEmotion === 'negative') {
			overall = 'falling';
		} else if (startEmotion === 'negative' && endEmotion === 'positive') {
			overall = 'rising';
		} else if (peakEmotion !== startEmotion && peakEmotion !== endEmotion) {
			overall = 'peak';
		}

		return {
			start: startEmotion,
			peak: peakEmotion,
			end: endEmotion,
			overall,
		};
	}

	/**
	 * Detect dominant emotion in text
	 */
	private detectDominantEmotion(text: string): string {
		const emotions = {
			positive: [
				'happy',
				'joy',
				'love',
				'excited',
				'pleased',
				'wonderful',
				'great',
				'amazing',
			],
			negative: [
				'sad',
				'angry',
				'fear',
				'hate',
				'terrible',
				'awful',
				'horrible',
				'disgusting',
			],
			tense: ['nervous', 'anxious', 'worried', 'stressed', 'pressure', 'tight', 'strained'],
			calm: ['peaceful', 'serene', 'quiet', 'relaxed', 'gentle', 'soft', 'tranquil'],
		};

		const scores: Record<string, number> = {};

		for (const [emotion, words] of Object.entries(emotions)) {
			scores[emotion] = 0;
			for (const word of words) {
				const regex = new RegExp(`\\b${word}\\b`, 'gi');
				const matches = text.match(regex);
				if (matches) {
					scores[emotion] += matches.length;
				}
			}
		}

		// Find dominant emotion
		let maxScore = 0;
		let dominantEmotion = 'neutral';

		for (const [emotion, score] of Object.entries(scores)) {
			if (score > maxScore) {
				maxScore = score;
				dominantEmotion = emotion;
			}
		}

		return dominantEmotion;
	}

	/**
	 * Extract key events from content
	 */
	private extractKeyEvents(content: string): string[] {
		const events: string[] = [];

		// Look for action indicators
		const actionPatterns = [
			/(?:suddenly|then|finally|at last)[^.!?]{10,50}[.!?]/gi,
			/(?:decided to|began to|started to)[^.!?]{10,50}[.!?]/gi,
			/(?:discovered|realized|understood|found out)[^.!?]{10,50}[.!?]/gi,
		];

		for (const pattern of actionPatterns) {
			const matches = content.match(pattern);
			if (matches) {
				events.push(...matches.slice(0, 2).map((m) => m.trim()));
			}
		}

		return events.slice(0, 5); // Top 5 events
	}

	/**
	 * Extract cliffhangers
	 */
	private extractCliffhangers(content: string): string[] {
		const cliffhangers: string[] = [];

		// Look at last few sentences
		const sentences = content.match(/[^.!?]+[.!?]/g) || [];
		const lastSentences = sentences.slice(-3);

		for (const sentence of lastSentences) {
			// Check for cliffhanger patterns
			if (
				sentence.includes('?') ||
				sentence.match(/but|however|suddenly|then/i) ||
				sentence.match(/little did|unknown to|unaware/i)
			) {
				cliffhangers.push(sentence.trim());
			}
		}

		return cliffhangers;
	}

	/**
	 * Extract foreshadowing
	 */
	private extractForeshadowing(content: string): string[] {
		const foreshadowing: string[] = [];

		const patterns = [
			/(?:would later|would soon|little did)[^.!?]{10,50}[.!?]/gi,
			/(?:if only|had I known|should have)[^.!?]{10,50}[.!?]/gi,
			/(?:ominous|foreboding|warning)[^.!?]{10,50}[.!?]/gi,
		];

		for (const pattern of patterns) {
			const matches = content.match(pattern);
			if (matches) {
				foreshadowing.push(...matches.slice(0, 2).map((m) => m.trim()));
			}
		}

		return foreshadowing;
	}

	/**
	 * Extract callbacks to previous chapters
	 */
	private extractCallbacks(content: string, _allDocuments: ScrivenerDocument[]): string[] {
		const callbacks: string[] = [];

		const patterns = [
			/(?:remembered|recalled|thought back)[^.!?]{10,50}[.!?]/gi,
			/(?:as before|like last time|once again)[^.!?]{10,50}[.!?]/gi,
			/(?:earlier|previously|before)[^.!?]{10,50}[.!?]/gi,
		];

		for (const pattern of patterns) {
			const matches = content.match(pattern);
			if (matches) {
				callbacks.push(...matches.slice(0, 2).map((m) => m.trim()));
			}
		}

		return callbacks;
	}

	/**
	 * Describe pacing score
	 */
	private describePacing(score: number): string {
		if (score < 0.3) return 'Very slow - may benefit from more action or dialogue';
		if (score < 0.5) return 'Slow - good for introspection and world-building';
		if (score < 0.7) return 'Moderate - balanced pacing';
		if (score < 0.85) return 'Fast - engaging and dynamic';
		return 'Very fast - intense and action-packed';
	}

	/**
	 * Build character arcs across chapters
	 */
	private async buildCharacterArcs(
		contexts: ChapterContext[]
	): Promise<StoryContext['characterArcs']> {
		const arcs = new Map<
			string,
			{
				character: string;
				introduction: string;
				development: string[];
				currentStatus: string;
				projectedArc: string;
			}
		>();

		// Track each character's journey
		const characterMap = new Map<
			string,
			Array<{
				chapter: string;
				appearances: number;
				lastMention?: string;
			}>
		>();

		for (const context of contexts) {
			for (const char of context.characters) {
				if (!characterMap.has(char.id)) {
					characterMap.set(char.id, []);
				}
				characterMap.get(char.id)!.push({
					chapter: context.title,
					appearances: char.appearances,
					lastMention: char.lastMention,
				});
			}
		}

		// Build arcs
		for (const [charId, appearances] of characterMap) {
			const firstAppearance = appearances[0];
			const lastAppearance = appearances[appearances.length - 1];

			arcs.set(charId, {
				character: charId,
				introduction: firstAppearance.chapter,
				development: appearances.slice(1, -1).map((a) => a.chapter),
				currentStatus: lastAppearance.lastMention || 'Active',
				projectedArc: 'Continuing', // Would need more analysis
			});
		}

		return arcs;
	}

	/**
	 * Build theme progression
	 */
	private async buildThemeProgression(
		contexts: ChapterContext[]
	): Promise<StoryContext['themeProgression']> {
		const progression = new Map<
			string,
			{
				theme: string;
				introduction: string;
				developments: string[];
				currentStrength: number;
			}
		>();

		// Track themes across chapters
		const themeMap = new Map<
			string,
			Array<{
				chapter: string;
				prominence: number;
				examples: string[];
			}>
		>();

		for (const context of contexts) {
			for (const theme of context.themes) {
				if (!themeMap.has(theme.name)) {
					themeMap.set(theme.name, []);
				}
				themeMap.get(theme.name)!.push({
					chapter: context.title,
					prominence: theme.prominence,
					examples: theme.examples,
				});
			}
		}

		// Build progression
		for (const [themeName, occurrences] of themeMap) {
			const firstOccurrence = occurrences[0];
			const avgProminence =
				occurrences.reduce((sum, o) => sum + o.prominence, 0) / occurrences.length;

			progression.set(themeName, {
				theme: themeName,
				introduction: firstOccurrence.chapter,
				developments: occurrences.map(
					(o) => `${o.chapter}: ${(o.prominence * 100).toFixed(0)}%`
				),
				currentStrength: avgProminence,
			});
		}

		return progression;
	}

	/**
	 * Build plot thread map
	 */
	private async buildPlotThreadMap(
		contexts: ChapterContext[]
	): Promise<StoryContext['plotThreads']> {
		const threads = new Map<
			string,
			{
				thread: string;
				status: 'setup' | 'developing' | 'climax' | 'resolved';
				chapters: string[];
				keyEvents: string[];
			}
		>();

		// Aggregate plot threads
		const threadMap = new Map<
			string,
			{
				name: string;
				status: 'setup' | 'developing' | 'climax' | 'resolved';
				chapters: string[];
				keyEvents: string[];
				developments: string[];
			}
		>();

		for (const context of contexts) {
			for (const thread of context.plotThreads) {
				if (!threadMap.has(thread.id)) {
					threadMap.set(thread.id, {
						name: thread.name,
						status: 'setup',
						chapters: [],
						keyEvents: [],
						developments: [],
					});
				}

				const data = threadMap.get(thread.id)!;
				data.chapters.push(context.title);
				data.developments.push(...thread.developments);
				data.keyEvents.push(...thread.developments.slice(0, 2));
			}
		}

		// Build thread map
		for (const [threadId, data] of threadMap) {
			threads.set(threadId, {
				thread: data.name,
				status: this.determineThreadStatus(data.developments),
				chapters: data.chapters,
				keyEvents: data.developments.slice(0, 5),
			});
		}

		return threads;
	}

	/**
	 * Determine thread status based on developments
	 */
	private determineThreadStatus(
		developments: string[]
	): 'setup' | 'developing' | 'climax' | 'resolved' {
		const lastDev = developments[developments.length - 1]?.toLowerCase() || '';

		if (lastDev.includes('resolved') || lastDev.includes('concluded')) return 'resolved';
		if (lastDev.includes('climax') || lastDev.includes('peak')) return 'climax';
		if (developments.length > 3) return 'developing';
		return 'setup';
	}

	/**
	 * Analyze overall pacing
	 */
	private analyzeOverallPacing(contexts: ChapterContext[]): StoryContext['overallPacing'] {
		const intensityPoints = contexts.map((ctx) => ({
			chapter: ctx.title,
			intensity: ctx.pacing.score,
		}));

		// Determine trend
		const firstHalf = intensityPoints.slice(0, Math.floor(intensityPoints.length / 2));
		const secondHalf = intensityPoints.slice(Math.floor(intensityPoints.length / 2));

		const firstAvg = firstHalf.reduce((sum, p) => sum + p.intensity, 0) / firstHalf.length;
		const secondAvg = secondHalf.reduce((sum, p) => sum + p.intensity, 0) / secondHalf.length;

		let trend: StoryContext['overallPacing']['trend'] = 'steady';
		if (secondAvg > firstAvg * 1.2) trend = 'accelerating';
		else if (secondAvg < firstAvg * 0.8) trend = 'decelerating';
		else if (Math.abs(secondAvg - firstAvg) < 0.1) trend = 'steady';
		else trend = 'variable';

		// Generate suggestions
		const suggestions: string[] = [];
		if (trend === 'decelerating') {
			suggestions.push('Consider adding more tension or conflict in later chapters');
		}
		if (trend === 'steady') {
			suggestions.push(
				'Pacing is consistent - consider varying intensity for dramatic effect'
			);
		}

		return {
			trend,
			intensityPoints,
			suggestions,
		};
	}

	/**
	 * Store chapter context in database
	 */
	private async storeChapterContext(context: ChapterContext): Promise<void> {
		await this.databaseService.storeContentAnalysis(
			context.documentId,
			'chapter_context',
			context
		);

		// Update document with enhanced metadata
		if (this.databaseService.getSQLite()) {
			const stmt = this.databaseService.getSQLite().getDatabase().prepare(`
				UPDATE documents
				SET context_data = ?,
				    last_analyzed = CURRENT_TIMESTAMP
				WHERE id = ?
			`);

			stmt.run([JSON.stringify(context), context.documentId]);
		}
	}

	/**
	 * Store story context in database
	 */
	private async storeStoryContext(context: StoryContext): Promise<void> {
		if (this.databaseService.getSQLite()) {
			// Convert Maps to objects for JSON storage
			const contextData = {
				...context,
				characterArcs: Object.fromEntries(context.characterArcs),
				themeProgression: Object.fromEntries(context.themeProgression),
				plotThreads: Object.fromEntries(context.plotThreads),
			};

			const stmt = this.databaseService.getSQLite().getDatabase().prepare(`
				INSERT OR REPLACE INTO project_metadata
				(key, value, updated_at)
				VALUES ('story_context', ?, CURRENT_TIMESTAMP)
			`);

			stmt.run([JSON.stringify(contextData)]);
		}
	}

	/**
	 * Get chapter context from database
	 */
	async getChapterContext(documentId: string): Promise<ChapterContext | null> {
		const history = await this.databaseService.getContentAnalysisHistory(
			documentId,
			'chapter_context'
		);

		if (history.length > 0) {
			return history[0].analysisData as ChapterContext;
		}

		return null;
	}

	/**
	 * Get story context from database
	 */
	async getStoryContext(): Promise<StoryContext | null> {
		if (this.databaseService.getSQLite()) {
			const result = this.databaseService
				.getSQLite()
				.queryOne(`SELECT value FROM project_metadata WHERE key = 'story_context'`) as
				| { value: string }
				| undefined;

			if (result) {
				const data = safeParse(result.value, {
					projectTitle: '',
					totalWordCount: 0,
					chapterCount: 0,
					overallPacing: {
						trend: 'steady' as const,
						intensityPoints: [],
						suggestions: [],
					},
					characterArcs: {},
					themeProgression: {},
					plotThreads: {},
				});
				// Convert objects back to Maps
				return {
					...data,
					characterArcs: new Map(Object.entries(data.characterArcs)),
					themeProgression: new Map(Object.entries(data.themeProgression)),
					plotThreads: new Map(Object.entries(data.plotThreads)),
				};
			}
		}

		return null;
	}
}
