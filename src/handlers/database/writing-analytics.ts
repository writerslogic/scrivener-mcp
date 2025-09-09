/**
 * Advanced Writing Analytics Service
 * Provides deep insights into writing patterns, productivity, and quality
 */

import { AppError, ErrorCode } from '../../utils/common.js';
import type { Neo4jManager } from './neo4j-manager.js';
import type { SQLiteManager } from './sqlite-manager.js';

// Type definitions for database query results
interface WritingSessionData {
	date: string;
	words_written: number;
	duration_minutes: number;
	time_of_day: string;
	days_gap: number | null;
}

interface TimeProductivityData {
	time_period: string;
	avg_words: number;
	session_count: number;
}

interface SceneData {
	avg_length: number;
}

interface DialogueRatioData {
	dialogue_ratio: number;
}

interface TrendData {
	date: string;
	total_words: number;
	session_count: number;
	efficiency: number;
	revisions: number;
}

interface CharacterDialogueData {
	character_id: string;
	name: string;
	dialogue_samples: string;
	avg_sentence_length: number;
}

interface VocabularyData {
	character_id: string;
	unique_words: number;
	total_words: number;
}

interface SceneAnalysisData {
	id: string;
	title: string;
	content?: string;
	word_count: number;
	character_count: number;
	tension_level: number | null;
	beat_type?: string;
}

interface DialogueAnalysis {
	complexity: number;
	avgSentenceLength: number;
	phrases: string[];
	tone: string;
	patterns: string[];
	consistency: number;
}

export interface WritingPattern {
	mostProductiveTime: string;
	averageSessionLength: number;
	averageWordsPerSession: number;
	writingStreak: number;
	longestStreak: number;
	preferredSceneLength: number;
	dialogueToNarrativeRatio: number;
}

export interface ProductivityTrend {
	date: string;
	wordsWritten: number;
	sessionsCount: number;
	efficiency: number; // words per minute
	quality: number; // based on revision frequency
}

export interface CharacterVoiceAnalysis {
	characterId: string;
	name: string;
	vocabularyComplexity: number;
	sentenceLength: number;
	distinctPhrases: string[];
	emotionalTone: string;
	speakingPatterns: string[];
	consistency: number; // 0-100
}

export interface SceneEffectiveness {
	sceneId: string;
	title: string;
	purpose: 'action' | 'dialogue' | 'exposition' | 'transition';
	tensionLevel: number;
	characterCount: number;
	wordCount: number;
	effectiveness: number; // calculated score
	suggestions: string[];
}

export class WritingAnalytics {
	constructor(
		private sqliteManager: SQLiteManager | null,
		private neo4jManager: Neo4jManager | null
	) {}

	/**
	 * Analyze writing patterns and habits
	 */
	async analyzeWritingPatterns(): Promise<WritingPattern> {
		if (!this.sqliteManager) {
			throw new AppError('SQLite not available', ErrorCode.DATABASE_ERROR);
		}

		// Get writing sessions data
		const sessions = this.sqliteManager.query(`
			SELECT
				date,
				words_written,
				duration_minutes,
				time(date) as time_of_day,
				julianday(date) - julianday(LAG(date) OVER (ORDER BY date)) as days_gap
			FROM writing_sessions
			ORDER BY date DESC
			LIMIT 100
		`) as WritingSessionData[];

		// Calculate most productive time
		const timeProductivity = this.sqliteManager.query(`
			SELECT
				CASE
					WHEN CAST(strftime('%H', date) AS INTEGER) < 6 THEN 'Night'
					WHEN CAST(strftime('%H', date) AS INTEGER) < 12 THEN 'Morning'
					WHEN CAST(strftime('%H', date) AS INTEGER) < 18 THEN 'Afternoon'
					ELSE 'Evening'
				END as time_period,
				AVG(words_written) as avg_words,
				COUNT(*) as session_count
			FROM writing_sessions
			GROUP BY time_period
			ORDER BY avg_words DESC
			LIMIT 1
		`) as TimeProductivityData[];

		// Calculate writing streak
		let currentStreak = 0;
		let longestStreak = 0;
		let tempStreak = 1;

		for (let i = 0; i < sessions.length - 1; i++) {
			const gap = sessions[i].days_gap;
			if (gap !== null && gap <= 1) {
				tempStreak++;
			} else {
				longestStreak = Math.max(longestStreak, tempStreak);
				tempStreak = 1;
			}
		}
		currentStreak = tempStreak;
		longestStreak = Math.max(longestStreak, tempStreak);

		// Get scene length preferences
		const sceneLengths = this.sqliteManager.query(`
			SELECT AVG(word_count) as avg_length
			FROM documents
			WHERE type = 'scene' OR type = 'chapter'
		`) as SceneData[];

		// Calculate dialogue to narrative ratio
		const dialogueRatio = await this.calculateDialogueRatio();

		return {
			mostProductiveTime: timeProductivity[0]?.time_period || 'Unknown',
			averageSessionLength:
				sessions.reduce((acc, s) => acc + (s.duration_minutes || 0), 0) / sessions.length,
			averageWordsPerSession:
				sessions.reduce((acc, s) => acc + s.words_written, 0) / sessions.length,
			writingStreak: currentStreak,
			longestStreak,
			preferredSceneLength: sceneLengths[0]?.avg_length || 0,
			dialogueToNarrativeRatio: dialogueRatio,
		};
	}

	/**
	 * Track productivity trends over time
	 */
	async getProductivityTrends(days: number = 30): Promise<ProductivityTrend[]> {
		if (!this.sqliteManager) {
			throw new AppError('SQLite not available', ErrorCode.DATABASE_ERROR);
		}

		const trends = this.sqliteManager.query(`
			SELECT
				date,
				SUM(words_written) as total_words,
				COUNT(*) as session_count,
				AVG(words_written / NULLIF(duration_minutes, 0)) as efficiency,
				(SELECT COUNT(*) FROM document_revisions WHERE DATE(created_at) = DATE(ws.date)) as revisions
			FROM writing_sessions ws
			WHERE date >= datetime('now', '-${days} days')
			GROUP BY DATE(date)
			ORDER BY date
		`) as TrendData[];

		return trends.map((t) => ({
			date: t.date,
			wordsWritten: t.total_words,
			sessionsCount: t.session_count,
			efficiency: t.efficiency || 0,
			quality: t.revisions > 0 ? 100 - t.revisions * 10 : 100, // More revisions = lower initial quality
		}));
	}

	/**
	 * Analyze character voice consistency
	 */
	async analyzeCharacterVoices(): Promise<CharacterVoiceAnalysis[]> {
		if (!this.sqliteManager || !this.neo4jManager?.isAvailable()) {
			return [];
		}

		// Get character dialogue from Neo4j
		const result = await this.neo4jManager.query(`
			MATCH (c:Character)-[:SPEAKS_IN]->(d:Document)
			WITH c, collect(d.content) as dialogues
			RETURN c.id as id, c.name as name, dialogues
		`);

		const analyses: CharacterVoiceAnalysis[] = [];

		for (const record of result.records) {
			const dialogues = record.get('dialogues') || [];
			const allDialogue = dialogues.join(' ');

			// Analyze dialogue patterns
			const analysis = this.analyzeDialogue(allDialogue);

			analyses.push({
				characterId: record.get('id'),
				name: record.get('name'),
				vocabularyComplexity: analysis.complexity,
				sentenceLength: analysis.avgSentenceLength,
				distinctPhrases: analysis.phrases,
				emotionalTone: analysis.tone,
				speakingPatterns: analysis.patterns,
				consistency: analysis.consistency,
			});
		}

		return analyses;
	}

	/**
	 * Analyze scene effectiveness
	 */
	async analyzeSceneEffectiveness(): Promise<SceneEffectiveness[]> {
		if (!this.sqliteManager) {
			return [];
		}

		const scenes = this.sqliteManager.query(`
			SELECT
				d.id,
				d.title,
				d.content,
				d.word_count,
				sb.tension_level,
				sb.beat_type,
				(SELECT COUNT(DISTINCT c.id)
				 FROM characters c
				 WHERE d.content LIKE '%' || c.name || '%') as character_count
			FROM documents d
			LEFT JOIN scene_beats sb ON d.id = sb.document_id
			WHERE d.type IN ('scene', 'chapter')
		`) as SceneAnalysisData[];

		return scenes.map((scene) => {
			const effectiveness = this.calculateSceneEffectiveness(scene);
			return {
				sceneId: scene.id,
				title: scene.title,
				purpose: this.determineScenePurpose(scene),
				tensionLevel: scene.tension_level || 5,
				characterCount: scene.character_count,
				wordCount: scene.word_count,
				effectiveness: effectiveness.score,
				suggestions: effectiveness.suggestions,
			};
		});
	}

	/**
	 * Get personalized writing recommendations
	 */
	async getWritingRecommendations(): Promise<{
		immediate: string[];
		shortTerm: string[];
		longTerm: string[];
		exercises: Array<{ title: string; description: string; benefit: string }>;
	}> {
		const patterns = await this.analyzeWritingPatterns();
		const trends = await this.getProductivityTrends(7);
		const scenes = await this.analyzeSceneEffectiveness();

		const recommendations = {
			immediate: [] as string[],
			shortTerm: [] as string[],
			longTerm: [] as string[],
			exercises: [] as Array<{ title: string; description: string; benefit: string }>,
		};

		// Immediate recommendations based on recent trends
		if (trends.length > 0) {
			const recent = trends[trends.length - 1];
			if (recent.efficiency < 10) {
				recommendations.immediate.push(
					'Consider setting a timer for focused writing sprints'
				);
			}
			if (recent.wordsWritten < patterns.averageWordsPerSession * 0.5) {
				recommendations.immediate.push(
					"Today's output is below average - try a writing prompt to get started"
				);
			}
		}

		// Short-term recommendations
		if (patterns.writingStreak < 3) {
			recommendations.shortTerm.push(
				'Build consistency by writing daily, even if just 100 words'
			);
		}
		if (patterns.dialogueToNarrativeRatio < 0.2) {
			recommendations.shortTerm.push('Add more dialogue to bring scenes to life');
		} else if (patterns.dialogueToNarrativeRatio > 0.8) {
			recommendations.shortTerm.push('Balance dialogue with narrative description');
		}

		// Long-term recommendations
		if (patterns.preferredSceneLength > 3000) {
			recommendations.longTerm.push(
				'Consider breaking longer scenes into smaller, focused beats'
			);
		}
		if (scenes.filter((s) => s.effectiveness < 50).length > scenes.length * 0.3) {
			recommendations.longTerm.push(
				'Review scene structure - many scenes could be more effective'
			);
		}

		// Writing exercises
		recommendations.exercises = [
			{
				title: 'Character Voice Exercise',
				description: 'Write the same scene from three different character perspectives',
				benefit: 'Develops distinct character voices',
			},
			{
				title: 'Tension Building',
				description: 'Rewrite a low-tension scene with escalating conflict',
				benefit: 'Improves pacing and engagement',
			},
			{
				title: "Show Don't Tell",
				description: 'Convert exposition into action and dialogue',
				benefit: 'Creates more dynamic scenes',
			},
		];

		return recommendations;
	}

	/**
	 * Track and predict project completion
	 */
	async predictProjectCompletion(targetWords: number): Promise<{
		currentWords: number;
		targetWords: number;
		percentComplete: number;
		estimatedCompletionDate: string;
		recommendedDailyWords: number;
		onTrack: boolean;
	}> {
		if (!this.sqliteManager) {
			throw new AppError('SQLite not available', ErrorCode.DATABASE_ERROR);
		}

		// Get current word count
		const current = this.sqliteManager.queryOne(
			'SELECT SUM(word_count) as total FROM documents WHERE type != "trash"'
		) as { total: number } | null;

		// Get average daily word count over last 30 days
		const avgDaily = this.sqliteManager.queryOne(`
			SELECT AVG(daily_words) as avg_words FROM (
				SELECT DATE(date) as day, SUM(words_written) as daily_words
				FROM writing_sessions
				WHERE date >= datetime('now', '-30 days')
				GROUP BY DATE(date)
			)
		`) as { avg_words: number } | null;

		const currentWords = current?.total || 0;
		const remainingWords = targetWords - currentWords;
		const dailyAverage = avgDaily?.avg_words || 250;
		const daysToComplete = Math.ceil(remainingWords / dailyAverage);

		const completionDate = new Date();
		completionDate.setDate(completionDate.getDate() + daysToComplete);

		// Calculate recommended daily words for a 3-month timeline
		const recommendedDaily = Math.ceil(remainingWords / 90);

		return {
			currentWords,
			targetWords,
			percentComplete: (currentWords / targetWords) * 100,
			estimatedCompletionDate: completionDate.toISOString().split('T')[0],
			recommendedDailyWords: recommendedDaily,
			onTrack: dailyAverage >= recommendedDaily,
		};
	}

	/**
	 * Helper methods
	 */
	private async calculateDialogueRatio(): Promise<number> {
		if (!this.sqliteManager) return 0;

		const docs = this.sqliteManager.query(
			'SELECT synopsis, notes, word_count FROM documents WHERE type IN ("scene", "chapter")'
		) as Array<{ synopsis?: string; notes?: string; word_count: number }>;

		let dialogueWords = 0;
		let totalWords = 0;

		for (const doc of docs) {
			// Use word_count if available, otherwise estimate from synopsis/notes
			totalWords += doc.word_count || 0;

			// Check for dialogue in synopsis/notes (limited analysis)
			const text = `${doc.synopsis || ''} ${doc.notes || ''}`;
			if (text) {
				const dialogueMatches = text.match(/"[^"]+"/g) || [];
				dialogueWords += dialogueMatches.join(' ').split(/\s+/).length;
			}
		}

		return totalWords > 0 ? dialogueWords / totalWords : 0;
	}

	private analyzeDialogue(text: string): DialogueAnalysis {
		const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
		const words = text.split(/\s+/);

		// Find repeated phrases (3+ words appearing multiple times)
		const phrases = new Set<string>();
		for (let i = 0; i < words.length - 2; i++) {
			const phrase = words.slice(i, i + 3).join(' ');
			if (text.indexOf(phrase) !== text.lastIndexOf(phrase)) {
				phrases.add(phrase);
			}
		}

		// Detect emotional tone from word choices
		const emotionalWords = {
			angry: ['angry', 'furious', 'rage', 'hate'],
			sad: ['sad', 'tears', 'crying', 'depressed'],
			happy: ['happy', 'joy', 'laugh', 'smile'],
			fearful: ['afraid', 'scared', 'terrified', 'fear'],
		};

		let dominantTone = 'neutral';
		let maxCount = 0;
		for (const [tone, keywords] of Object.entries(emotionalWords)) {
			const count = keywords.filter((word) => text.toLowerCase().includes(word)).length;
			if (count > maxCount) {
				maxCount = count;
				dominantTone = tone;
			}
		}

		// Detect speaking patterns
		const patterns = [];
		if (text.includes('...')) patterns.push('uses ellipses');
		const exclamations = text.match(/!+/g)?.length || 0;
		const questions = text.match(/\?+/g)?.length || 0;
		if (exclamations > sentences.length * 0.3) patterns.push('exclamatory');
		if (questions > sentences.length * 0.3) patterns.push('questioning');

		return {
			complexity: (new Set(words).size / words.length) * 100,
			avgSentenceLength: words.length / sentences.length,
			phrases: Array.from(phrases).slice(0, 5),
			tone: dominantTone,
			patterns,
			consistency: 85, // Placeholder - would need historical data
		};
	}

	private determineScenePurpose(
		scene: SceneAnalysisData
	): 'action' | 'dialogue' | 'exposition' | 'transition' {
		const content = scene.content || '';
		const dialogueRatio = (content.match(/"[^"]+"/g) || []).join('').length / content.length;

		if (scene.beat_type) {
			// Ensure beat_type is one of the valid values
			const validTypes = ['action', 'dialogue', 'exposition', 'transition'] as const;
			if (validTypes.includes(scene.beat_type as any)) {
				return scene.beat_type as 'action' | 'dialogue' | 'exposition' | 'transition';
			}
		}
		if (dialogueRatio > 0.6) return 'dialogue';
		if (content.length < 500) return 'transition';
		if (content.includes('fight') || content.includes('chase') || content.includes('ran'))
			return 'action';
		return 'exposition';
	}

	private calculateSceneEffectiveness(scene: SceneAnalysisData): {
		score: number;
		suggestions: string[];
	} {
		let score = 50; // Base score
		const suggestions = [];

		// Tension contributes to effectiveness
		if (scene.tension_level) {
			score += (scene.tension_level - 5) * 5;
		}

		// Character interaction is good
		if (scene.character_count > 1) {
			score += scene.character_count * 5;
		} else if (scene.character_count === 0) {
			suggestions.push('Scene lacks character presence');
			score -= 10;
		}

		// Word count balance
		if (scene.word_count < 200) {
			suggestions.push('Scene may be too brief to develop properly');
			score -= 10;
		} else if (scene.word_count > 3000) {
			suggestions.push('Consider breaking this scene into smaller beats');
			score -= 5;
		}

		// Purpose alignment
		const purpose = this.determineScenePurpose(scene);
		if (purpose === 'transition' && scene.word_count > 1000) {
			suggestions.push('Transition scene is too long');
			score -= 10;
		}

		return {
			score: Math.max(0, Math.min(100, score)),
			suggestions,
		};
	}
}
