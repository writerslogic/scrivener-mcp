/**
 * Neo4j Graph Analytics Module
 * Provides advanced graph analysis capabilities for story structure
 */

import { AppError, ErrorCode } from '../utils/common.js';
import type { Neo4jManager } from './neo4j-manager.js';

export interface CharacterNetwork {
	centralCharacters: Array<{
		id: string;
		name: string;
		centrality: number;
		connections: number;
	}>;
	clusters: Array<{
		id: string;
		members: string[];
		theme: string;
	}>;
	isolatedCharacters: string[];
}

export interface PlotComplexity {
	threadCount: number;
	intersectionPoints: number;
	averageThreadLength: number;
	complexityScore: number;
	criticalPaths: Array<{
		from: string;
		to: string;
		weight: number;
	}>;
}

export interface StoryFlow {
	chapters: Array<{
		id: string;
		intensity: number;
		charactersPresent: number;
		plotThreadsActive: number;
	}>;
	pacingScore: number;
	tensionCurve: number[];
	suggestedImprovements: string[];
}

export class GraphAnalytics {
	constructor(private neo4j: Neo4jManager) {}

	/**
	 * Analyze character network and relationships
	 */
	async analyzeCharacterNetwork(): Promise<CharacterNetwork> {
		if (!this.neo4j.isAvailable()) {
			throw new AppError('Neo4j not available', ErrorCode.DATABASE_ERROR);
		}

		// Calculate character centrality using PageRank
		const centralityResult = await this.neo4j.query(`
			CALL gds.graph.project.cypher(
				'character-network',
				'MATCH (c:Character) RETURN id(c) AS id',
				'MATCH (c1:Character)-[r:RELATES_TO]-(c2:Character)
				 RETURN id(c1) AS source, id(c2) AS target, 1.0 AS weight'
			)
			YIELD graphName, nodeCount, relationshipCount

			CALL gds.pageRank.stream('character-network')
			YIELD nodeId, score
			MATCH (c:Character) WHERE id(c) = nodeId
			RETURN c.id AS id, c.name AS name, score
			ORDER BY score DESC
			LIMIT 10
		`);

		// Find character clusters using Louvain community detection
		const clusterResult = await this.neo4j.query(`
			CALL gds.louvain.stream('character-network')
			YIELD nodeId, communityId
			MATCH (c:Character) WHERE id(c) = nodeId
			RETURN communityId, collect(c.name) AS members
		`);

		// Find isolated characters
		const isolatedResult = await this.neo4j.query(`
			MATCH (c:Character)
			WHERE NOT exists((c)-[:RELATES_TO]-())
			RETURN c.name AS name
		`);

		// Clean up graph projection
		await this.neo4j.query(`
			CALL gds.graph.drop('character-network', false) YIELD graphName
			RETURN graphName
		`);

		const central = centralityResult.records.map((r) => ({
			id: r.get('id'),
			name: r.get('name'),
			centrality: r.get('score'),
			connections: 0, // Will be calculated separately
		}));

		// Get connection counts
		for (const char of central) {
			const connResult = await this.neo4j.query(
				`
				MATCH (c:Character {id: $id})-[:RELATES_TO]-(other)
				RETURN count(DISTINCT other) AS connections
			`,
				{ id: char.id }
			);
			char.connections = connResult.records[0]?.get('connections') || 0;
		}

		const clusters = clusterResult.records.map((r, idx) => ({
			id: `cluster-${idx}`,
			members: r.get('members'),
			theme: this.inferClusterTheme(r.get('members')),
		}));

		const isolated = isolatedResult.records.map((r) => r.get('name'));

		return {
			centralCharacters: central,
			clusters,
			isolatedCharacters: isolated,
		};
	}

	/**
	 * Analyze plot thread complexity
	 */
	async analyzePlotComplexity(): Promise<PlotComplexity> {
		if (!this.neo4j.isAvailable()) {
			throw new AppError('Neo4j not available', ErrorCode.DATABASE_ERROR);
		}

		// Count plot threads
		const threadCountResult = await this.neo4j.query(`
			MATCH (p:PlotThread)
			RETURN count(p) AS count
		`);

		// Find intersection points (documents with multiple plot threads)
		const intersectionResult = await this.neo4j.query(`
			MATCH (d:Document)<-[:OCCURS_IN]-(p:PlotThread)
			WITH d, count(p) AS threadCount
			WHERE threadCount > 1
			RETURN count(d) AS intersections
		`);

		// Calculate average thread length
		const threadLengthResult = await this.neo4j.query(`
			MATCH (p:PlotThread)-[:OCCURS_IN]->(d:Document)
			WITH p, count(d) AS length
			RETURN avg(length) AS avgLength
		`);

		// Find critical paths (most connected plot threads)
		const criticalPathsResult = await this.neo4j.query(`
			MATCH (p1:PlotThread)-[:OCCURS_IN]->(d:Document)<-[:OCCURS_IN]-(p2:PlotThread)
			WHERE p1.id < p2.id
			WITH p1, p2, count(d) AS weight
			ORDER BY weight DESC
			LIMIT 5
			RETURN p1.name AS from, p2.name AS to, weight
		`);

		const threadCount = threadCountResult.records[0]?.get('count') || 0;
		const intersections = intersectionResult.records[0]?.get('intersections') || 0;
		const avgLength = threadLengthResult.records[0]?.get('avgLength') || 0;

		const criticalPaths = criticalPathsResult.records.map((r) => ({
			from: r.get('from'),
			to: r.get('to'),
			weight: r.get('weight'),
		}));

		// Calculate complexity score (0-100)
		const complexityScore = Math.min(
			100,
			threadCount * 10 + intersections * 15 + avgLength * 5 + criticalPaths.length * 10
		);

		return {
			threadCount,
			intersectionPoints: intersections,
			averageThreadLength: avgLength,
			complexityScore,
			criticalPaths,
		};
	}

	/**
	 * Analyze story flow and pacing
	 */
	async analyzeStoryFlow(): Promise<StoryFlow> {
		if (!this.neo4j.isAvailable()) {
			throw new AppError('Neo4j not available', ErrorCode.DATABASE_ERROR);
		}

		// Get chapter-by-chapter analysis
		const chapterResult = await this.neo4j.query(`
			MATCH (d:Document {type: 'chapter'})
			OPTIONAL MATCH (d)<-[:APPEARS_IN]-(c:Character)
			OPTIONAL MATCH (d)<-[:OCCURS_IN]-(p:PlotThread)
			WITH d, count(DISTINCT c) AS chars, count(DISTINCT p) AS plots
			ORDER BY d.order, d.title
			RETURN d.id AS id, chars, plots
		`);

		const chapters = chapterResult.records.map((r) => {
			const chars = r.get('chars');
			const plots = r.get('plots');
			// Calculate intensity based on character and plot density
			const intensity = (chars * 0.3 + plots * 0.7) * 10;

			return {
				id: r.get('id'),
				intensity: Math.min(100, intensity),
				charactersPresent: chars,
				plotThreadsActive: plots,
			};
		});

		// Calculate tension curve
		const tensionCurve = chapters.map((ch) => ch.intensity);

		// Calculate pacing score based on variation
		const avgIntensity = tensionCurve.reduce((a, b) => a + b, 0) / tensionCurve.length;
		const variance =
			tensionCurve.reduce((sum, val) => sum + Math.pow(val - avgIntensity, 2), 0) /
			tensionCurve.length;
		const pacingScore = Math.min(100, Math.sqrt(variance) * 5);

		// Generate suggestions
		const suggestions = this.generateFlowSuggestions(chapters, tensionCurve);

		return {
			chapters,
			pacingScore,
			tensionCurve,
			suggestedImprovements: suggestions,
		};
	}

	/**
	 * Find potential character relationships based on co-occurrence
	 */
	async discoverRelationships(): Promise<
		Array<{
			character1: string;
			character2: string;
			strength: number;
			suggestedRelationType: string;
		}>
	> {
		if (!this.neo4j.isAvailable()) {
			throw new AppError('Neo4j not available', ErrorCode.DATABASE_ERROR);
		}

		const result = await this.neo4j.query(`
			MATCH (c1:Character)-[:APPEARS_IN]->(d:Document)<-[:APPEARS_IN]-(c2:Character)
			WHERE c1.id < c2.id
			AND NOT exists((c1)-[:RELATES_TO]-(c2))
			WITH c1, c2, count(d) AS cooccurrences
			WHERE cooccurrences > 2
			RETURN c1.name AS char1, c2.name AS char2, cooccurrences
			ORDER BY cooccurrences DESC
			LIMIT 10
		`);

		return result.records.map((r) => {
			const count = r.get('cooccurrences');
			return {
				character1: r.get('char1'),
				character2: r.get('char2'),
				strength: count,
				suggestedRelationType: this.suggestRelationType(count),
			};
		});
	}

	/**
	 * Analyze narrative structure patterns
	 */
	async analyzeNarrativeStructure(): Promise<{
		structure: 'linear' | 'branching' | 'circular' | 'episodic';
		keyMilestones: Array<{ chapter: string; event: string; impact: number }>;
		suggestions: string[];
	}> {
		if (!this.neo4j.isAvailable()) {
			throw new AppError('Neo4j not available', ErrorCode.DATABASE_ERROR);
		}

		// Analyze plot thread patterns
		const patternResult = await this.neo4j.query(`
			MATCH path = (start:PlotThread)-[:OCCURS_IN*]->(end:Document)
			WITH length(path) AS pathLength, count(*) AS frequency
			RETURN avg(pathLength) AS avgPath, max(pathLength) AS maxPath
		`);

		// Find key milestone chapters
		const milestoneResult = await this.neo4j.query(`
			MATCH (d:Document)
			OPTIONAL MATCH (d)<-[:OCCURS_IN]-(p:PlotThread)
			OPTIONAL MATCH (d)<-[:APPEARS_IN]-(c:Character)
			WITH d, count(DISTINCT p) AS plots, count(DISTINCT c) AS chars
			WHERE plots > 2 OR chars > 5
			RETURN d.title AS chapter, plots, chars
			ORDER BY plots DESC, chars DESC
			LIMIT 5
		`);

		const avgPath = patternResult.records[0]?.get('avgPath') || 0;
		const maxPath = patternResult.records[0]?.get('maxPath') || 0;

		// Determine structure type
		let structure: 'linear' | 'branching' | 'circular' | 'episodic';
		if (maxPath > avgPath * 2) {
			structure = 'branching';
		} else if (avgPath < 3) {
			structure = 'episodic';
		} else {
			structure = 'linear';
		}

		const milestones = milestoneResult.records.map((r) => ({
			chapter: r.get('chapter'),
			event: `${r.get('plots')} plot threads converge`,
			impact: r.get('plots') * 10 + r.get('chars') * 2,
		}));

		const suggestions = this.generateStructureSuggestions(structure, milestones);

		return {
			structure,
			keyMilestones: milestones,
			suggestions,
		};
	}

	/**
	 * Helper methods
	 */
	private inferClusterTheme(members: string[]): string {
		// Simple theme inference based on character names
		if (members.length <= 2) return 'partnership';
		if (members.length <= 4) return 'small group';
		return 'ensemble';
	}

	private suggestRelationType(cooccurrences: number): string {
		if (cooccurrences > 10) return 'close relationship';
		if (cooccurrences > 5) return 'frequent interaction';
		return 'occasional interaction';
	}

	private generateFlowSuggestions(_chapters: any[], tensionCurve: number[]): string[] {
		const suggestions: string[] = [];

		// Check for flat sections
		const flatSections = this.findFlatSections(tensionCurve);
		if (flatSections.length > 0) {
			suggestions.push(`Consider adding variation in chapters ${flatSections.join(', ')}`);
		}

		// Check for sudden drops
		for (let i = 1; i < tensionCurve.length; i++) {
			if (tensionCurve[i] < tensionCurve[i - 1] * 0.5) {
				suggestions.push(
					`Chapter ${i + 1} has a sudden intensity drop - consider smoothing transition`
				);
			}
		}

		// Check for missing climax
		const maxIntensity = Math.max(...tensionCurve);
		if (maxIntensity < 70) {
			suggestions.push('Story may benefit from a more intense climactic moment');
		}

		return suggestions;
	}

	private findFlatSections(curve: number[]): number[] {
		const flat: number[] = [];
		for (let i = 1; i < curve.length - 1; i++) {
			if (Math.abs(curve[i] - curve[i - 1]) < 5 && Math.abs(curve[i] - curve[i + 1]) < 5) {
				flat.push(i + 1);
			}
		}
		return flat;
	}

	private generateStructureSuggestions(structure: string, milestones: any[]): string[] {
		const suggestions: string[] = [];

		switch (structure) {
			case 'episodic':
				suggestions.push('Consider adding more connecting threads between episodes');
				break;
			case 'branching':
				suggestions.push(
					'Complex branching detected - ensure all threads resolve satisfactorily'
				);
				break;
			case 'linear':
				suggestions.push(
					'Linear structure is clear - consider adding subplot complexity if needed'
				);
				break;
		}

		if (milestones.length < 3) {
			suggestions.push('Story could benefit from more convergence points');
		}

		return suggestions;
	}
}
