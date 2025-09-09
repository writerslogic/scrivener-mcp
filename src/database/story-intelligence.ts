/**
 * Story Intelligence Service
 * AI-powered analysis and recommendations for story improvement
 */

import type { GraphAnalytics } from './graph-analytics.js';
import type { Neo4jManager } from './neo4j-manager.js';
import type { SQLiteManager } from './sqlite-manager.js';
import { unique } from '../utils/common.js';

export interface PlotHole {
	type: 'continuity' | 'logic' | 'character' | 'timeline';
	severity: 'minor' | 'major' | 'critical';
	description: string;
	location: { documentId: string; title: string };
	suggestion: string;
}

export interface CharacterArcIssue {
	characterId: string;
	characterName: string;
	issue: string;
	affectedChapters: string[];
	recommendation: string;
}

export interface PacingIssue {
	chapters: string[];
	issue: 'too_slow' | 'too_fast' | 'uneven' | 'repetitive';
	description: string;
	suggestion: string;
}

export interface StoryRecommendation {
	category: 'plot' | 'character' | 'pacing' | 'structure' | 'theme';
	priority: 'low' | 'medium' | 'high';
	title: string;
	description: string;
	actionItems: string[];
	estimatedImpact: number; // 1-10
}

export interface TimelineEvent {
	id: string;
	date: string; // story date
	time?: string; // story time
	event: string;
	documentId: string;
	characters: string[];
	location?: string;
	importance: 'minor' | 'moderate' | 'major';
}

export class StoryIntelligence {
	constructor(
		private sqliteManager: SQLiteManager | null,
		private neo4jManager: Neo4jManager | null,
		private graphAnalytics: GraphAnalytics | null
	) {}

	/**
	 * Detect potential plot holes using pattern analysis
	 */
	async detectPlotHoles(): Promise<PlotHole[]> {
		const holes: PlotHole[] = [];

		if (!this.sqliteManager || !this.neo4jManager?.isAvailable()) {
			return holes;
		}

		// Check for continuity issues
		const continuityIssues = await this.checkContinuity();
		holes.push(...continuityIssues);

		// Check for character consistency
		const characterIssues = await this.checkCharacterConsistency();
		holes.push(...characterIssues);

		// Check for timeline issues
		const timelineIssues = await this.checkTimelineConsistency();
		holes.push(...timelineIssues);

		// Check for unresolved plot threads
		const unresolvedThreads = await this.checkUnresolvedThreads();
		holes.push(...unresolvedThreads);

		return holes.sort((a, b) => {
			const severityOrder = { critical: 0, major: 1, minor: 2 };
			return severityOrder[a.severity] - severityOrder[b.severity];
		});
	}

	/**
	 * Analyze character arc progression
	 */
	async analyzeCharacterArcs(): Promise<CharacterArcIssue[]> {
		if (!this.sqliteManager || !this.neo4jManager?.isAvailable()) {
			return [];
		}

		const issues: CharacterArcIssue[] = [];

		// Get character arc data
		const arcs = this.sqliteManager.query(`
			SELECT
				ca.*,
				c.name as character_name,
				d.title as chapter_title
			FROM character_arcs ca
			JOIN characters c ON ca.character_id = c.id
			LEFT JOIN documents d ON ca.chapter_id = d.id
			ORDER BY ca.character_id, ca.order_index
		`) as any[];

		// Group by character
		const characterArcs = new Map<string, any[]>();
		for (const arc of arcs) {
			if (!characterArcs.has(arc.character_id)) {
				characterArcs.set(arc.character_id, []);
			}
			characterArcs.get(arc.character_id)!.push(arc);
		}

		// Analyze each character's arc
		for (const [charId, charArcs] of characterArcs) {
			const analysis = this.analyzeCharacterProgression(charArcs);

			if (analysis.issues.length > 0) {
				issues.push({
					characterId: charId,
					characterName: charArcs[0].character_name,
					issue: analysis.issues.join('; '),
					affectedChapters: analysis.affectedChapters,
					recommendation: analysis.recommendation,
				});
			}
		}

		// Check for missing arcs (characters without development)
		const charactersWithoutArcs = await this.neo4jManager.query(`
			MATCH (c:Character)
			WHERE NOT exists((c)-[:HAS_ARC]->())
			AND size((c)-[:APPEARS_IN]->()) > 3
			RETURN c.id as id, c.name as name
		`);

		for (const record of charactersWithoutArcs.records) {
			issues.push({
				characterId: record.get('id'),
				characterName: record.get('name'),
				issue: 'Character lacks defined arc despite multiple appearances',
				affectedChapters: [],
				recommendation: 'Develop character progression or reduce appearances',
			});
		}

		return issues;
	}

	/**
	 * Analyze story pacing
	 */
	async analyzePacing(): Promise<PacingIssue[]> {
		if (!this.sqliteManager) return [];

		const issues: PacingIssue[] = [];

		// Get chapter data with metrics
		const chapters = this.sqliteManager.query(`
			SELECT
				d.id,
				d.title,
				d.word_count,
				d.order_index,
				COUNT(DISTINCT sb.id) as beat_count,
				AVG(sb.tension_level) as avg_tension,
				(SELECT COUNT(*) FROM characters c WHERE (d.synopsis LIKE '%' || c.name || '%' OR d.notes LIKE '%' || c.name || '%')) as char_count
			FROM documents d
			LEFT JOIN scene_beats sb ON d.id = sb.document_id
			WHERE d.type = 'chapter'
			GROUP BY d.id
			ORDER BY d.order_index
		`) as any[];

		// Check for pacing issues
		for (let i = 0; i < chapters.length - 2; i++) {
			const current = chapters[i];
			const next = chapters[i + 1];
			const afterNext = chapters[i + 2];

			// Check for sudden pacing changes
			if (current.avg_tension && next.avg_tension) {
				const tensionDiff = Math.abs(current.avg_tension - next.avg_tension);
				if (tensionDiff > 5) {
					issues.push({
						chapters: [current.title, next.title],
						issue: 'uneven',
						description: `Sudden tension change from ${current.avg_tension.toFixed(1)} to ${next.avg_tension.toFixed(1)}`,
						suggestion: 'Add transitional scenes to smooth the pacing',
					});
				}
			}

			// Check for repetitive patterns
			if (
				current.beat_count === next.beat_count &&
				next.beat_count === afterNext.beat_count
			) {
				issues.push({
					chapters: [current.title, next.title, afterNext.title],
					issue: 'repetitive',
					description: 'Similar scene structure across multiple chapters',
					suggestion: 'Vary scene structure and rhythm',
				});
			}
		}

		// Check overall pacing
		const avgWordCount = chapters.reduce((sum, ch) => sum + ch.word_count, 0) / chapters.length;
		const slowChapters = chapters.filter(
			(ch) => ch.word_count > avgWordCount * 1.5 && ch.avg_tension < 5
		);

		if (slowChapters.length > chapters.length * 0.3) {
			issues.push({
				chapters: slowChapters.map((ch) => ch.title),
				issue: 'too_slow',
				description: 'Multiple long chapters with low tension',
				suggestion: 'Increase conflict or trim exposition in these chapters',
			});
		}

		return issues;
	}

	/**
	 * Generate smart story recommendations
	 */
	async generateRecommendations(): Promise<StoryRecommendation[]> {
		const recommendations: StoryRecommendation[] = [];

		// Analyze various aspects
		const [plotHoles, arcIssues, pacingIssues, graphAnalysis] = await Promise.all([
			this.detectPlotHoles(),
			this.analyzeCharacterArcs(),
			this.analyzePacing(),
			this.graphAnalytics?.analyzeNarrativeStructure(),
		]);

		// Generate plot recommendations
		if (plotHoles.filter((h) => h.severity === 'critical').length > 0) {
			recommendations.push({
				category: 'plot',
				priority: 'high',
				title: 'Critical Plot Issues Detected',
				description:
					'Your story has critical plot inconsistencies that need immediate attention',
				actionItems: plotHoles
					.filter((h: PlotHole) => h.severity === 'critical')
					.map((h: PlotHole) => `Fix: ${h.description} in ${h.location.title}`),
				estimatedImpact: 9,
			});
		}

		// Generate character recommendations
		if (arcIssues.length > 0) {
			const priority = arcIssues.length > 3 ? 'high' : 'medium';
			recommendations.push({
				category: 'character',
				priority,
				title: 'Character Development Opportunities',
				description: `${arcIssues.length} character(s) need arc refinement`,
				actionItems: arcIssues.map(
					(i: CharacterArcIssue) => `${i.characterName}: ${i.recommendation}`
				),
				estimatedImpact: 7,
			});
		}

		// Generate pacing recommendations
		const slowPacing = pacingIssues.filter((p) => p.issue === 'too_slow');
		if (slowPacing.length > 0) {
			recommendations.push({
				category: 'pacing',
				priority: 'medium',
				title: 'Pacing Improvement Needed',
				description: 'Several chapters have pacing issues that affect reader engagement',
				actionItems: slowPacing.map((p: PacingIssue) => p.suggestion),
				estimatedImpact: 6,
			});
		}

		// Generate structure recommendations based on graph analysis
		if (graphAnalysis && graphAnalysis.structure === 'linear') {
			recommendations.push({
				category: 'structure',
				priority: 'medium',
				title: 'Add Subplot Complexity',
				description: 'Your story could benefit from additional plot threads',
				actionItems: [
					'Introduce a B-plot that complements the main story',
					'Develop secondary character storylines',
					'Add thematic subplots that reinforce your main theme',
				],
				estimatedImpact: 8,
			});
		}

		// Theme recommendations
		const themes = await this.analyzeThemes();
		if (themes.underdeveloped.length > 0) {
			recommendations.push({
				category: 'theme',
				priority: 'low',
				title: 'Strengthen Thematic Elements',
				description: 'Some themes could be more fully developed',
				actionItems: themes.underdeveloped.map((t) => `Develop theme: ${t}`),
				estimatedImpact: 5,
			});
		}

		return recommendations.sort((a, b) => {
			const priorityOrder = { high: 0, medium: 1, low: 2 };
			return priorityOrder[a.priority] - priorityOrder[b.priority];
		});
	}

	/**
	 * Build story timeline from content
	 */
	async buildTimeline(): Promise<TimelineEvent[]> {
		if (!this.sqliteManager) return [];

		// Extract temporal references from documents
		const documents = this.sqliteManager.query(`
			SELECT id, title, content, order_index
			FROM documents
			WHERE type IN ('chapter', 'scene')
			ORDER BY order_index
		`) as any[];

		const timeline: TimelineEvent[] = [];
		let currentStoryDate = 'Day 1'; // Default starting point

		for (const doc of documents) {
			const events = this.extractTimelineEvents(doc, currentStoryDate);
			timeline.push(...events);

			// Update current story date if found in text
			const dateMatch = doc.content?.match(
				/(\d{1,2}[\s\w]+later|next\s+\w+|following\s+\w+)/i
			);
			if (dateMatch) {
				currentStoryDate = this.parseRelativeDate(currentStoryDate, dateMatch[1]);
			}
		}

		// Store timeline in database
		await this.storeTimeline(timeline);

		return timeline;
	}

	/**
	 * Helper methods
	 */
	private async checkContinuity(): Promise<PlotHole[]> {
		const holes: PlotHole[] = [];

		// Check for objects/items that appear without introduction
		const itemReferences = await this.neo4jManager!.query(`
			MATCH (d1:Document)-[:MENTIONS]->(item:Item)
			WHERE NOT exists((earlier:Document)-[:MENTIONS]->(item))
			AND earlier.order_index < d1.order_index
			RETURN d1.id as doc_id, d1.title as title, item.name as item
		`);

		for (const record of itemReferences.records) {
			holes.push({
				type: 'continuity',
				severity: 'minor',
				description: `Item "${record.get('item')}" appears without introduction`,
				location: { documentId: record.get('doc_id'), title: record.get('title') },
				suggestion: 'Introduce the item earlier or add explanation for its appearance',
			});
		}

		return holes;
	}

	private async checkCharacterConsistency(): Promise<PlotHole[]> {
		const holes: PlotHole[] = [];

		// Check for character appearances after death/departure
		const inconsistencies = await this.neo4jManager!.query(`
			MATCH (c:Character)-[:DIES_IN|DEPARTS_IN]->(d1:Document)
			MATCH (c)-[:APPEARS_IN]->(d2:Document)
			WHERE d2.order_index > d1.order_index
			RETURN c.name as character, d1.title as exit_chapter, d2.title as reappear_chapter
		`);

		for (const record of inconsistencies.records) {
			holes.push({
				type: 'character',
				severity: 'critical',
				description: `${record.get('character')} appears after exit in ${record.get('exit_chapter')}`,
				location: {
					documentId: '',
					title: record.get('reappear_chapter'),
				},
				suggestion: 'Remove appearance or explain return',
			});
		}

		return holes;
	}

	private async checkTimelineConsistency(): Promise<PlotHole[]> {
		// Check for timeline inconsistencies
		// This would need more sophisticated temporal parsing
		return [];
	}

	private async checkUnresolvedThreads(): Promise<PlotHole[]> {
		const holes: PlotHole[] = [];

		if (!this.sqliteManager) return holes;

		// Check for plot threads that don't resolve
		const threads = this.sqliteManager.query(`
			SELECT id, name, status
			FROM plot_threads
			WHERE status IN ('setup', 'development')
		`) as any[];

		for (const thread of threads) {
			holes.push({
				type: 'continuity',
				severity: 'major',
				description: `Plot thread "${thread.name}" is unresolved`,
				location: { documentId: '', title: 'Multiple chapters' },
				suggestion: 'Add resolution or mark as intentionally open-ended',
			});
		}

		return holes;
	}

	private analyzeCharacterProgression(arcs: any[]): {
		issues: string[];
		affectedChapters: string[];
		recommendation: string;
	} {
		const issues: string[] = [];
		const affectedChapters: string[] = [];
		let recommendation = '';

		// Check for stagnant progression
		const uniqueStages = new Set(arcs.map((a) => a.stage));
		if (uniqueStages.size < arcs.length / 2) {
			issues.push('Character development is stagnant');
			recommendation = 'Add more distinct development stages';
		}

		// Check for regression without justification
		for (let i = 1; i < arcs.length; i++) {
			if (arcs[i].emotional_state === arcs[0].emotional_state && i > arcs.length / 2) {
				issues.push('Character returns to initial state without growth');
				affectedChapters.push(arcs[i].chapter_title);
			}
		}

		// Check for missing conflict resolution
		const hasConflict = arcs.some((a) => a.conflict);
		const hasResolution = arcs.some((a) => a.resolution);
		if (hasConflict && !hasResolution) {
			issues.push('Conflict lacks resolution');
			recommendation = 'Add resolution to character conflict';
		}

		return {
			issues,
			affectedChapters,
			recommendation: recommendation || 'Review character progression',
		};
	}

	private async analyzeThemes(): Promise<{ dominant: string[]; underdeveloped: string[] }> {
		if (!this.sqliteManager) {
			return { dominant: [], underdeveloped: [] };
		}

		const themes = this.sqliteManager.query(`
			SELECT name, COUNT(*) as mentions
			FROM themes t
			JOIN document_relationships dr ON t.id = dr.target_id
			GROUP BY t.id
		`) as any[];

		const avgMentions = themes.reduce((sum, t) => sum + t.mentions, 0) / themes.length;

		return {
			dominant: themes.filter((t) => t.mentions > avgMentions * 1.5).map((t) => t.name),
			underdeveloped: themes.filter((t) => t.mentions < avgMentions * 0.5).map((t) => t.name),
		};
	}

	private extractTimelineEvents(doc: any, currentDate: string): TimelineEvent[] {
		const events: TimelineEvent[] = [];

		// Extract significant events (simplified - would need NLP in production)
		const eventPatterns = [
			/(\w+) arrived at (.+)/gi,
			/(\w+) discovered (.+)/gi,
			/(\w+) met (\w+)/gi,
			/The (.+) happened/gi,
		];

		for (const pattern of eventPatterns) {
			const matches = doc.content?.matchAll(pattern) || [];
			for (const match of matches) {
				events.push({
					id: `event-${doc.id}-${events.length}`,
					date: currentDate,
					event: match[0],
					documentId: doc.id,
					characters: this.extractCharacterNames(match[0]),
					importance: 'moderate',
				});
			}
		}

		return events;
	}

	private extractCharacterNames(text: string): string[] {
		// Simplified - would need entity recognition
		const properNouns = text.match(/[A-Z][a-z]+/g) || [];
		return unique(properNouns);
	}

	private parseRelativeDate(current: string, relative: string): string {
		// Simplified date parsing
		if (relative.includes('next day')) {
			const dayNum = parseInt(current.match(/\d+/)?.[0] || '1');
			return `Day ${dayNum + 1}`;
		}
		if (relative.includes('week later')) {
			const dayNum = parseInt(current.match(/\d+/)?.[0] || '1');
			return `Day ${dayNum + 7}`;
		}
		return current;
	}

	private async storeTimeline(events: TimelineEvent[]): Promise<void> {
		if (!this.sqliteManager) return;

		// Create timeline table if needed
		this.sqliteManager.execute(`
			CREATE TABLE IF NOT EXISTS timeline_events (
				id TEXT PRIMARY KEY,
				story_date TEXT,
				story_time TEXT,
				event TEXT,
				document_id TEXT,
				characters TEXT,
				location TEXT,
				importance TEXT,
				created_at TEXT DEFAULT CURRENT_TIMESTAMP
			)
		`);

		// Store events
		const stmt = this.sqliteManager.getDatabase().prepare(`
			INSERT OR REPLACE INTO timeline_events
			(id, story_date, story_time, event, document_id, characters, location, importance)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`);

		for (const event of events) {
			stmt.run(
				event.id,
				event.date,
				event.time || null,
				event.event,
				event.documentId,
				JSON.stringify(event.characters),
				event.location || null,
				event.importance
			);
		}
	}
}
