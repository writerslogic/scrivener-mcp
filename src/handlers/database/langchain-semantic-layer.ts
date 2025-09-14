import type { DatabaseService } from './database-service.js';
import { EnhancedLangChainService } from '../../services/ai/langchain-service-enhanced.js';
import { AdvancedLangChainFeatures } from '../../services/ai/langchain-advanced-features.js';
import { VectorStore } from '../../services/ai/vector-store.js';
import type { ScrivenerDocument } from '../../types/index.js';
import { getLogger } from '../../core/logger.js';
import { toDatabaseError } from '../../utils/database.js';

export interface VectorSearchResult {
	id: string;
	content: string;
	score: number;
	metadata?: Record<string, unknown>;
}

export interface DatabaseResult {
	id: string;
	title: string;
	content: string;
	[key: string]: unknown;
}

export interface StructuredQuery {
	text: string;
	filters?: Record<string, unknown>;
	limit?: number;
	[key: string]: unknown;
}

export interface DatabaseSchema {
	tables: Array<{
		name: string;
		columns: Array<{
			name: string;
			type: string;
			nullable?: boolean;
		}>;
	}>;
	relationships?: Array<{
		from: string;
		to: string;
		type: string;
	}>;
}

export interface SemanticQueryResult {
	documents: Array<{
		id: string;
		title: string;
		content: string;
		relevanceScore: number;
		explanation: string;
	}>;
	entities: Array<{
		name: string;
		type: 'character' | 'location' | 'concept' | 'theme';
		mentions: number;
		documents: string[];
	}>;
	relationships: Array<{
		from: string;
		to: string;
		type: string;
		strength: number;
		evidence: string[];
	}>;
	insights: {
		summary: string;
		themes: string[];
		patterns: string[];
		suggestions: string[];
	};
}

export interface KnowledgeGraph {
	nodes: Array<{
		id: string;
		label: string;
		type: string;
		properties: Record<string, unknown>;
		embeddings?: number[];
	}>;
	edges: Array<{
		id: string;
		from: string;
		to: string;
		type: string;
		properties: Record<string, unknown>;
		weight: number;
	}>;
	metadata: {
		totalNodes: number;
		totalEdges: number;
		lastUpdated: string;
		version: string;
	};
}

export interface EntityAnalysis {
	entity: string;
	type: string;
	mentions: Array<{
		documentId: string;
		documentTitle: string;
		context: string;
		sentiment: number;
		importance: number;
	}>;
	relationships: Array<{
		relatedEntity: string;
		relationship: string;
		strength: number;
		contexts: string[];
	}>;
	progression: Array<{
		chapter: number;
		development: string;
		significance: number;
	}>;
	insights: {
		characterization: string[];
		plot_relevance: string;
		thematic_connection: string[];
		inconsistencies: string[];
	};
	processingTime?: number;
	connections?: Array<{
		entity: string;
		type: string;
		strength: number;
	}>;
}

export class SemanticDatabaseLayer {
	private databaseService: DatabaseService;
	private langchain: EnhancedLangChainService;
	private advanced: AdvancedLangChainFeatures;
	private vectorStore: VectorStore;
	private logger: ReturnType<typeof getLogger>;
	private knowledgeGraphCache: KnowledgeGraph | null = null;
	private cacheTimeout = 30 * 60 * 1000; // 30 minutes
	private lastCacheUpdate = 0;

	constructor(databaseService: DatabaseService) {
		this.databaseService = databaseService;
		this.langchain = new EnhancedLangChainService();
		this.advanced = new AdvancedLangChainFeatures();
		this.vectorStore = new VectorStore();
		this.logger = getLogger('SemanticDatabaseLayer');
	}

	async initialize(): Promise<void> {
		try {
			await this.vectorStore.initialize();
			this.logger.info('Semantic database layer initialized');
		} catch (error) {
			this.logger.error('Failed to initialize semantic layer', {
				error: (error as Error).message,
			});
			throw toDatabaseError(error, 'semantic layer initialization');
		}
	}

	async semanticQuery(
		naturalLanguage: string,
		options?: {
			includeEntities?: boolean;
			includeRelationships?: boolean;
			maxResults?: number;
			threshold?: number;
		}
	): Promise<SemanticQueryResult> {
		try {
			this.logger.info(`Processing semantic query: ${naturalLanguage}`);

			const {
				includeEntities = true,
				includeRelationships = true,
				maxResults = 10,
				threshold = 0.7,
			} = options || {};

			// Step 1: Convert natural language to structured query
			const structuredQuery = await this.parseNaturalLanguageQuery(naturalLanguage);

			// Step 2: Execute semantic search
			const semanticResults = await this.executeSemanticSearch(structuredQuery, {
				maxResults,
				threshold,
			});

			// Step 3: Extract entities if requested
			const entities = includeEntities
				? await this.extractEntitiesFromQuery(naturalLanguage, semanticResults)
				: [];

			// Step 4: Analyze relationships if requested
			const relationships = includeRelationships
				? await this.analyzeRelationships(entities, semanticResults)
				: [];

			// Step 5: Generate insights
			const insights = await this.generateQueryInsights(
				naturalLanguage,
				semanticResults,
				entities
			);

			return {
				documents: semanticResults,
				entities,
				relationships,
				insights,
			};
		} catch (error) {
			this.logger.error('Semantic query failed', { error: (error as Error).message });
			throw toDatabaseError(error, 'semantic query');
		}
	}

	private async parseNaturalLanguageQuery(query: string): Promise<{
		intent: string;
		entities: string[];
		relationships: string[];
		temporal: string[];
		filters: Record<string, unknown>;
	}> {
		const prompt = `Parse this natural language query into structured components:

"${query}"

Extract:
1. Intent (search, analyze, compare, find_patterns, etc.)
2. Entities mentioned (characters, locations, themes, etc.)
3. Relationships implied (character interactions, cause-effect, etc.)
4. Temporal elements (time periods, sequences, etc.)
5. Filters (document types, date ranges, etc.)

Return as JSON with fields: intent, entities, relationships, temporal, filters`;

		const result = await this.langchain.generateWithTemplate('query_parsing', query, {
			format: 'json',
			customPrompt: prompt,
		});

		try {
			const parsed = JSON.parse(result.content);
			return {
				intent: parsed.intent || 'search',
				entities: Array.isArray(parsed.entities) ? parsed.entities : [],
				relationships: Array.isArray(parsed.relationships) ? parsed.relationships : [],
				temporal: Array.isArray(parsed.temporal) ? parsed.temporal : [],
				filters: parsed.filters || {},
			};
		} catch {
			return {
				intent: 'search',
				entities: [],
				relationships: [],
				temporal: [],
				filters: {},
			};
		}
	}

	private async executeSemanticSearch(
		structuredQuery: { intent: string; entities: string[]; relationships: string[] },
		options: { maxResults: number; threshold: number }
	): Promise<
		Array<{
			id: string;
			title: string;
			content: string;
			relevanceScore: number;
			explanation: string;
		}>
	> {
		try {
			// Build search query from structured components
			const searchTerms = [
				...structuredQuery.entities,
				...structuredQuery.relationships,
			].join(' ');

			// Perform vector similarity search
			const vectorResults = await this.vectorStore.similaritySearch(
				searchTerms,
				options.maxResults
			);

			// Enhance with traditional database search
			const dbResults = await this.performTraditionalSearch(searchTerms);

			// Merge and rank results
			const fullStructuredQuery: StructuredQuery = {
				text: searchTerms,
				...structuredQuery,
			};
			const mergedResults = await this.mergeAndRankResults(
				vectorResults,
				dbResults,
				fullStructuredQuery,
				options.threshold
			);

			// Generate explanations for each result
			const explainedResults = await Promise.all(
				mergedResults.slice(0, options.maxResults).map(async (result) => ({
					...result,
					explanation: await this.generateResultExplanation(result, structuredQuery),
				}))
			);

			return explainedResults;
		} catch (error) {
			this.logger.warn('Semantic search failed, falling back to traditional', {
				error: (error as Error).message,
			});
			return this.performTraditionalSearch(structuredQuery.entities.join(' '));
		}
	}

	private async performTraditionalSearch(searchTerms: string): Promise<
		Array<{
			id: string;
			title: string;
			content: string;
			relevanceScore: number;
			explanation: string;
		}>
	> {
		try {
			const searchService = this.databaseService.getSearchService();
			if (!searchService) {
				return [];
			}

			const results = (await searchService.search(searchTerms, {
				limit: 10,
			})) as unknown as Array<{
				id: string;
				title: string;
				content: string;
				score: number;
			}>;

			return results.map((result) => ({
				id: result.id,
				title: result.title,
				content: result.content.slice(0, 500),
				relevanceScore: result.score / 100,
				explanation: 'Traditional text match',
			}));
		} catch (error) {
			this.logger.warn('Traditional search failed', { error: (error as Error).message });
			return [];
		}
	}

	private async mergeAndRankResults(
		vectorResults: VectorSearchResult[],
		dbResults: DatabaseResult[],
		structuredQuery: StructuredQuery,
		threshold: number
	): Promise<
		Array<{
			id: string;
			title: string;
			content: string;
			relevanceScore: number;
		}>
	> {
		// Use structured query for query expansion and relevance boosting
		const queryTerms = structuredQuery.text.toLowerCase().split(/\s+/);
		const resultMap = new Map<
			string,
			{
				id: string;
				title: string;
				content: string;
				relevanceScore: number;
			}
		>();

		// Add vector results
		for (const result of vectorResults) {
			if (result.score >= threshold) {
				resultMap.set(result.id, {
					id: result.id,
					title: (result.metadata?.title as string) || result.id,
					content: result.content,
					relevanceScore: result.score,
				});
			}
		}

		// Merge database results
		for (const result of dbResults) {
			if ((result.relevanceScore as number) >= threshold) {
				const existing = resultMap.get(result.id);
				if (existing) {
					// Boost score for items found in both
					existing.relevanceScore = Math.min(
						1.0,
						existing.relevanceScore + (result.relevanceScore as number) * 0.3
					);
				} else {
					resultMap.set(result.id, {
						...result,
						relevanceScore: (result.relevanceScore as number) || 0,
					});
				}
			}
		}

		// Sort by relevance score
		return Array.from(resultMap.values()).sort((a, b) => b.relevanceScore - a.relevanceScore);
	}

	private async generateResultExplanation(
		result: { title: string; content: string; relevanceScore: number },
		query: { intent: string; entities: string[] }
	): Promise<string> {
		const prompt = `Explain why this document is relevant to the user's query:

Query Intent: ${query.intent}
Query Entities: ${query.entities.join(', ')}
Document: "${result.title}"
Relevance Score: ${result.relevanceScore.toFixed(2)}

Content Preview: ${result.content.slice(0, 200)}...

Provide a brief, clear explanation (1-2 sentences) of why this document matches the query.`;

		try {
			const explanation = await this.langchain.generateWithTemplate(
				'result_explanation',
				result.content,
				{
					maxLength: 100,
					customPrompt: prompt,
				}
			);

			return explanation.content;
		} catch {
			return `Matches query with ${(result.relevanceScore * 100).toFixed(0)}% relevance`;
		}
	}

	private async extractEntitiesFromQuery(
		query: string,
		results: Array<{ content: string }>
	): Promise<
		Array<{
			name: string;
			type: 'character' | 'location' | 'concept' | 'theme';
			mentions: number;
			documents: string[];
		}>
	> {
		// Extract query entities for entity-based analysis
		const queryEntities = await this.advanced.extractEntities(query);
		try {
			const combinedContent = results.map((r) => r.content).join('\n\n');
			const entities = await this.advanced.extractEntities(combinedContent);

			return entities.map((entity) => ({
				name: entity.name,
				type: this.mapEntityType(entity.type),
				mentions: entity.mentions || 1,
				documents: results
					.filter((r) => r.content.toLowerCase().includes(entity.name.toLowerCase()))
					.map((_, index) => `doc_${index}`),
			}));
		} catch (error) {
			this.logger.warn('Entity extraction failed', { error: (error as Error).message });
			return [];
		}
	}

	private mapEntityType(type: string): 'character' | 'location' | 'concept' | 'theme' {
		switch (type.toLowerCase()) {
			case 'person':
			case 'character':
				return 'character';
			case 'place':
			case 'location':
				return 'location';
			case 'theme':
			case 'idea':
				return 'theme';
			default:
				return 'concept';
		}
	}

	private async analyzeRelationships(
		entities: Array<{ name: string; type: string }>,
		results: Array<{ content: string }>
	): Promise<
		Array<{
			from: string;
			to: string;
			type: string;
			strength: number;
			evidence: string[];
		}>
	> {
		if (entities.length < 2) return [];

		try {
			const combinedContent = results.map((r) => r.content).join('\n\n');
			const relationships = await this.advanced.analyzeRelationships(
				entities.map((e) => ({
					name: e.name,
					type: e.type as 'character' | 'location' | 'organization' | 'event' | 'object',
					context: combinedContent,
					mentions: 1,
				}))
			);

			return relationships.map((rel) => ({
				from: rel.entity1,
				to: rel.entity2,
				type: rel.relationship,
				strength: rel.strength,
				evidence: [rel.relationship],
			}));
		} catch (error) {
			this.logger.warn('Relationship analysis failed', { error: (error as Error).message });
			return [];
		}
	}

	private async generateQueryInsights(
		query: string,
		results: Array<{ content: string }>,
		entities: Array<{ name: string }>
	): Promise<{
		summary: string;
		themes: string[];
		patterns: string[];
		suggestions: string[];
	}> {
		const prompt = `Based on this query and search results, provide insights:

Query: "${query}"
Found ${results.length} relevant documents
Key entities: ${entities.map((e) => e.name).join(', ')}

Content summary: ${results.map((r) => r.content.slice(0, 100)).join('... ')}...

Provide:
1. Summary of findings (2-3 sentences)
2. Key themes identified (3-5 items)
3. Patterns observed (3-5 items)
4. Suggestions for further exploration (3-5 items)

Format as JSON: {summary, themes: [], patterns: [], suggestions: []}`;

		try {
			const result = await this.langchain.generateWithTemplate('insight_generation', query, {
				format: 'json',
				customPrompt: prompt,
			});

			const insights = JSON.parse(result.content);
			return {
				summary: insights.summary || 'Analysis completed',
				themes: Array.isArray(insights.themes) ? insights.themes : [],
				patterns: Array.isArray(insights.patterns) ? insights.patterns : [],
				suggestions: Array.isArray(insights.suggestions) ? insights.suggestions : [],
			};
		} catch (error) {
			this.logger.warn('Insight generation failed', { error: (error as Error).message });
			return {
				summary: 'Search completed successfully',
				themes: [],
				patterns: [],
				suggestions: ['Try refining your search terms', 'Explore related documents'],
			};
		}
	}

	async intelligentSync(documents: ScrivenerDocument[]): Promise<{
		knowledgeGraph: KnowledgeGraph;
		insights: {
			newEntities: number;
			newRelationships: number;
			updatedNodes: number;
			conflicts: string[];
		};
	}> {
		try {
			this.logger.info(`Performing intelligent sync for ${documents.length} documents`);

			// Extract knowledge graph from documents
			const knowledgeGraph = await this.extractKnowledgeGraph(documents);

			// Sync to databases
			await this.syncToGraph(knowledgeGraph);

			// Update vector store
			await this.updateVectorStore(documents);

			// Cache the knowledge graph
			this.knowledgeGraphCache = knowledgeGraph;
			this.lastCacheUpdate = Date.now();

			// Generate insights about the sync
			const insights = await this.generateSyncInsights(knowledgeGraph);

			this.logger.info('Intelligent sync completed', {
				nodes: knowledgeGraph.nodes.length,
				edges: knowledgeGraph.edges.length,
			});

			return { knowledgeGraph, insights };
		} catch (error) {
			this.logger.error('Intelligent sync failed', { error: (error as Error).message });
			throw toDatabaseError(error, 'knowledge graph sync');
		}
	}

	private async extractKnowledgeGraph(documents: ScrivenerDocument[]): Promise<KnowledgeGraph> {
		const nodes: KnowledgeGraph['nodes'] = [];
		const edges: KnowledgeGraph['edges'] = [];
		const nodeIds = new Set<string>();

		for (const doc of documents) {
			if (!doc.content) continue;

			try {
				// Extract entities from document
				const entities = await this.advanced.extractEntities(doc.content);

				// Create nodes for entities
				for (const entity of entities) {
					const nodeId = `${entity.type}_${entity.name.replace(/\s+/g, '_')}`;

					if (!nodeIds.has(nodeId)) {
						nodes.push({
							id: nodeId,
							label: entity.name,
							type: entity.type,
							properties: {
								first_mention: doc.id,
								mentions: 1,
								description: entity.name,
							},
						});
						nodeIds.add(nodeId);
					} else {
						// Update existing node
						const existingNode = nodes.find((n) => n.id === nodeId);
						if (existingNode) {
							existingNode.properties.mentions =
								(existingNode.properties.mentions as number) + 1;
						}
					}
				}

				// Extract relationships
				if (entities.length > 1) {
					const relationships = await this.advanced.analyzeRelationships(
						entities.map((e) => ({
							name: e.name,
							type: e.type as
								| 'character'
								| 'location'
								| 'organization'
								| 'event'
								| 'object',
							context: doc.content || '',
							mentions: 1,
						}))
					);

					for (const rel of relationships) {
						const fromId = `${
							entities.find((e) => e.name === rel.entity1)?.type
						}_${rel.entity1.replace(/\s+/g, '_')}`;
						const toId = `${
							entities.find((e) => e.name === rel.entity2)?.type
						}_${rel.entity2.replace(/\s+/g, '_')}`;

						if (fromId && toId && nodeIds.has(fromId) && nodeIds.has(toId)) {
							edges.push({
								id: `${fromId}_${rel.type}_${toId}`,
								from: fromId,
								to: toId,
								type: rel.type,
								properties: {
									document: doc.id,
									confidence: rel.strength,
									relationship: rel.relationship,
								},
								weight: rel.strength,
							});
						}
					}
				}
			} catch (error) {
				this.logger.warn(`Failed to extract knowledge from document ${doc.id}`, {
					error: (error as Error).message,
				});
			}
		}

		return {
			nodes,
			edges,
			metadata: {
				totalNodes: nodes.length,
				totalEdges: edges.length,
				lastUpdated: new Date().toISOString(),
				version: '1.0',
			},
		};
	}

	private async syncToGraph(knowledgeGraph: KnowledgeGraph): Promise<void> {
		const neo4j = this.databaseService.getNeo4j();
		if (!neo4j) {
			this.logger.warn('Neo4j not available, skipping graph sync');
			return;
		}

		try {
			// Create nodes
			for (const node of knowledgeGraph.nodes) {
				await neo4j.upsertNode(node.type, node.id, {
					name: node.label,
					...node.properties,
				});
			}

			// Create relationships
			for (const edge of knowledgeGraph.edges) {
				await neo4j.createRelationship(
					edge.from,
					'Entity',
					edge.to,
					'Entity',
					edge.type,
					edge.properties
				);
			}
		} catch (error) {
			this.logger.warn('Graph sync to Neo4j failed', { error: (error as Error).message });
		}
	}

	private async updateVectorStore(documents: ScrivenerDocument[]): Promise<void> {
		try {
			const vectorDocs = documents.map((doc) => ({
				id: doc.id,
				content: doc.content || '',
				metadata: {
					title: doc.title,
					type: doc.type,
					wordCount: doc.wordCount,
					synopsis: doc.synopsis,
				},
			}));

			await this.vectorStore.addDocuments(vectorDocs);
		} catch (error) {
			this.logger.warn('Vector store update failed', { error: (error as Error).message });
		}
	}

	private async generateSyncInsights(knowledgeGraph: KnowledgeGraph): Promise<{
		newEntities: number;
		newRelationships: number;
		updatedNodes: number;
		conflicts: string[];
	}> {
		// This would compare with previous version in a real implementation
		return {
			newEntities: knowledgeGraph.nodes.length,
			newRelationships: knowledgeGraph.edges.length,
			updatedNodes: 0,
			conflicts: [],
		};
	}

	async crossReferenceAnalysis(entity: string): Promise<EntityAnalysis> {
		try {
			this.logger.info(`Performing cross-reference analysis for: ${entity}`);

			// Find all mentions across documents
			const mentions = await this.findEntityMentions(entity);

			// Analyze relationships
			const relationships = await this.analyzeEntityRelationships(entity, mentions);

			// Track progression through the story
			const progression = await this.analyzeEntityProgression(entity, mentions);

			// Generate insights
			const insights = await this.generateEntityInsights(entity, mentions, relationships);

			return {
				entity,
				type: await this.determineEntityType(entity),
				mentions,
				relationships,
				progression,
				insights,
			};
		} catch (error) {
			this.logger.error(`Cross-reference analysis failed for ${entity}`, {
				error: (error as Error).message,
			});
			throw toDatabaseError(error, `cross-reference analysis for ${entity}`);
		}
	}

	private async findEntityMentions(entity: string): Promise<EntityAnalysis['mentions']> {
		try {
			const vectorResults = await this.vectorStore.findMentions(entity);

			const mentions = await Promise.all(
				vectorResults.map(async (result) => {
					const sentiment = await this.analyzeMentionSentiment(result.context, entity);
					const importance = await this.calculateMentionImportance(
						result.context,
						entity
					);

					return {
						documentId: result.documentId,
						documentTitle: result.title || 'Unknown',
						context: result.context,
						sentiment,
						importance,
					};
				})
			);

			return mentions.sort((a, b) => b.importance - a.importance);
		} catch (error) {
			this.logger.warn(`Failed to find mentions for ${entity}`, {
				error: (error as Error).message,
			});
			return [];
		}
	}

	private async analyzeMentionSentiment(context: string, entity: string): Promise<number> {
		try {
			const prompt = `Analyze the sentiment toward "${entity}" in this context:

"${context}"

Return a sentiment score from -1.0 (very negative) to 1.0 (very positive), with 0 being neutral.
Return only the numeric score.`;

			const result = await this.langchain.generateWithTemplate(
				'sentiment_analysis',
				context,
				{
					entity,
					customPrompt: prompt,
				}
			);

			const score = parseFloat(result.content.trim());
			return isNaN(score) ? 0 : Math.max(-1, Math.min(1, score));
		} catch {
			return 0;
		}
	}

	private async calculateMentionImportance(context: string, entity: string): Promise<number> {
		try {
			const prompt = `Rate the importance of this mention of "${entity}" in the story:

"${context}"

Consider:
- Plot relevance
- Character development
- Thematic significance
- Story progression

Return importance score from 0.0 (trivial mention) to 1.0 (crucial plot point).
Return only the numeric score.`;

			const result = await this.langchain.generateWithTemplate(
				'importance_analysis',
				context,
				{
					entity,
					customPrompt: prompt,
				}
			);

			const score = parseFloat(result.content.trim());
			return isNaN(score) ? 0.5 : Math.max(0, Math.min(1, score));
		} catch {
			return 0.5;
		}
	}

	private async analyzeEntityRelationships(
		entity: string,
		mentions: EntityAnalysis['mentions']
	): Promise<EntityAnalysis['relationships']> {
		try {
			const contexts = mentions.map((m) => m.context).join('\n\n');
			const relationships = await this.advanced.analyzeRelationships([
				{
					name: entity,
					type: 'object',
					context: contexts,
					mentions: 1,
				},
			]);

			return relationships
				.filter((rel) => rel.entity1 === entity || rel.entity2 === entity)
				.map((rel) => ({
					relatedEntity: rel.entity1 === entity ? rel.entity2 : rel.entity1,
					relationship: rel.relationship,
					strength: rel.strength,
					contexts: [rel.relationship],
				}));
		} catch (error) {
			this.logger.warn(`Relationship analysis failed for ${entity}`, {
				error: (error as Error).message,
			});
			return [];
		}
	}

	private async analyzeEntityProgression(
		entity: string,
		mentions: EntityAnalysis['mentions']
	): Promise<EntityAnalysis['progression']> {
		// Analyze how the entity develops throughout the story
		const entityMentions = mentions.filter(m => m.context.includes(entity.toLowerCase()));
		
		// This would analyze how the entity develops throughout the story
		// For now, return a simplified version
		return mentions.map((mention, index) => ({
			chapter: index + 1,
			development: `Mention ${index + 1}: ${mention.context.slice(0, 100)}...`,
			significance: mention.importance,
		}));
	}

	private async generateEntityInsights(
		entity: string,
		mentions: EntityAnalysis['mentions'],
		relationships: EntityAnalysis['relationships']
	): Promise<EntityAnalysis['insights']> {
		const prompt = `Analyze this entity across the story and provide insights:

Entity: ${entity}
Total mentions: ${mentions.length}
Key relationships: ${relationships.map((r) => `${r.relatedEntity} (${r.relationship})`).join(', ')}

Sample contexts:
${mentions
	.slice(0, 3)
	.map((m) => `- ${m.context.slice(0, 200)}...`)
	.join('\n')}

Provide insights as JSON:
{
  "characterization": ["trait1", "trait2", ...],
  "plot_relevance": "description of plot importance",
  "thematic_connection": ["theme1", "theme2", ...],
  "inconsistencies": ["issue1", "issue2", ...]
}`;

		try {
			const result = await this.langchain.generateWithTemplate('entity_insights', entity, {
				format: 'json',
				customPrompt: prompt,
			});

			const insights = JSON.parse(result.content);
			return {
				characterization: Array.isArray(insights.characterization)
					? insights.characterization
					: [],
				plot_relevance: insights.plot_relevance || 'Analysis unavailable',
				thematic_connection: Array.isArray(insights.thematic_connection)
					? insights.thematic_connection
					: [],
				inconsistencies: Array.isArray(insights.inconsistencies)
					? insights.inconsistencies
					: [],
			};
		} catch (error) {
			this.logger.warn(`Insight generation failed for ${entity}`, {
				error: (error as Error).message,
			});
			return {
				characterization: [],
				plot_relevance: 'Analysis unavailable',
				thematic_connection: [],
				inconsistencies: [],
			};
		}
	}

	private async determineEntityType(entity: string): Promise<string> {
		// Simple heuristics - in practice this would use the extracted entity data
		if (entity.match(/^[A-Z][a-z]+ [A-Z][a-z]+$/)) return 'character';
		if (entity.match(/^[A-Z][a-z]+$/)) return 'character';
		return 'concept';
	}

	async getKnowledgeGraph(): Promise<KnowledgeGraph | null> {
		const now = Date.now();

		if (this.knowledgeGraphCache && now - this.lastCacheUpdate < this.cacheTimeout) {
			return this.knowledgeGraphCache;
		}

		// Cache expired or not exists, return null to trigger rebuild
		return null;
	}

	async nl2sql(
		naturalLanguage: string,
		schema?: DatabaseSchema
	): Promise<{
		sql: string;
		explanation: string;
		confidence: number;
	}> {
		const prompt = `Convert this natural language query to SQL:

"${naturalLanguage}"

Database schema (if relevant):
${schema ? JSON.stringify(schema, null, 2) : 'Standard Scrivener project database with documents, characters, themes tables'}

Return JSON with fields:
- sql: The SQL query
- explanation: Brief explanation of what the query does
- confidence: Confidence level (0.0-1.0)

Focus on SELECT queries for safety. Use appropriate JOINs and WHERE clauses.`;

		try {
			const result = await this.langchain.generateWithTemplate('nl2sql', naturalLanguage, {
				format: 'json',
				customPrompt: prompt,
			});

			const parsed = JSON.parse(result.content);
			return {
				sql: parsed.sql || 'SELECT 1;',
				explanation: parsed.explanation || 'Query conversion failed',
				confidence: Math.max(0, Math.min(1, parsed.confidence || 0.5)),
			};
		} catch (error) {
			this.logger.warn('NL2SQL conversion failed', { error: (error as Error).message });
			return {
				sql: 'SELECT 1;',
				explanation: 'Natural language to SQL conversion failed',
				confidence: 0,
			};
		}
	}

	async close(): Promise<void> {
		try {
			await this.vectorStore.close();
			this.knowledgeGraphCache = null;
			this.logger.info('Semantic database layer closed');
		} catch (error) {
			this.logger.error('Error closing semantic layer', { error: (error as Error).message });
		}
	}
}
