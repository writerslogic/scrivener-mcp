/**
 * Fixed Graph Analytics with Memory Management and Query Optimization
 * Addresses memory leaks, N+1 queries, and production failures
 */

import type { Driver } from 'neo4j-driver';
import type { Session, Transaction, ManagedTransaction } from 'neo4j-driver';
import { getLogger } from '../core/logger.js';
import type { ValidationSchema } from '../utils/common.js';
import {
	AppError,
	ErrorCode,
	handleError,
	withErrorHandling,
	retry,
	measureExecution,
	validateInput,
	processBatch,
	truncate,
	generateHash,
	formatDuration,
	formatBytes,
	RateLimiter,
} from '../utils/common.js';
import { AsyncUtils } from '../utils/shared-patterns.js';

const logger = getLogger('graph-analytics');

interface CharacterNode {
	id: string;
	name: string;
	centrality: number;
	connections: number;
	cluster?: number;
}

interface CharacterNetwork {
	nodes: CharacterNode[];
	clusters: number;
	isolated: string[];
	density: number;
}

interface PlotAnalysis {
	threadCount: number;
	avgThreadLength: number;
	convergencePoints: number;
	complexity: number;
}

interface NarrativeStructure {
	chapters: ChapterInfo[];
	tensionCurve: number[];
	avgIntensity: number;
	climaxChapter: number;
}

interface ChapterInfo {
	id: string;
	title: string;
	characters: number;
	plotThreads: number;
	intensity: number;
}

export class GraphAnalytics {
	private driver: Driver;
	private readonly batchSize = 1000;
	private readonly scanLimit = 10000;
	private gdsAvailable: boolean | null = null;
	private rateLimiter: RateLimiter;
	private performanceMetrics = new Map<string, number[]>();
	private queryCache = new Map<string, { result: unknown; timestamp: number }>();
	private readonly cacheTimeout = 5 * 60 * 1000; // 5 minutes

	constructor(driver: Driver) {
		validateInput({ driver }, { driver: { required: true } });
		this.driver = driver;

		// Initialize rate limiter for graph operations
		this.rateLimiter = new RateLimiter(100, 60000); // 100 requests per minute

		// Setup cache cleanup
		setInterval(() => this.cleanupCache(), 60000); // Every minute
	}

	/**
	 * Cache management utilities
	 */
	private getCachedResult<T>(key: string): T | null {
		const cached = this.queryCache.get(key);
		if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
			return cached.result as T;
		}
		this.queryCache.delete(key);
		return null;
	}

	private setCachedResult(key: string, result: unknown): void {
		const hashKey = generateHash(key + JSON.stringify(result).substring(0, 100));
		logger.debug('Caching result', {
			cacheKey: truncate(key, 50),
			hash: truncate(hashKey, 12),
			resultSize: formatBytes(JSON.stringify(result).length),
			timestamp: new Date().toISOString(),
		});
		this.queryCache.set(key, { result, timestamp: Date.now() });
	}

	private cleanupCache(): void {
		const now = Date.now();
		for (const [key, cached] of this.queryCache.entries()) {
			if (now - cached.timestamp > this.cacheTimeout) {
				this.queryCache.delete(key);
			}
		}
	}

	/**
	 * Track performance metrics
	 */
	private trackPerformance(operation: string, duration: number): void {
		logger.debug('Performance tracking', {
			operation: truncate(operation, 50),
			duration: formatDuration(duration),
			timestamp: new Date().toISOString(),
		});
		if (!this.performanceMetrics.has(operation)) {
			this.performanceMetrics.set(operation, []);
		}

		const metrics = this.performanceMetrics.get(operation)!;
		metrics.push(duration);

		// Keep only recent metrics
		if (metrics.length > 100) {
			metrics.splice(0, metrics.length - 100);
		}
	}

	/**
	 * Check if Graph Data Science library is available with caching and error handling
	 */
	private async checkGDSAvailability(): Promise<boolean> {
		if (this.gdsAvailable !== null) {
			return this.gdsAvailable;
		}

		try {
			const session = this.driver.session();
			try {
				if (!this.rateLimiter.tryRemove()) {
					throw new AppError('Rate limit exceeded', ErrorCode.RATE_LIMITED);
				}

				const result = await retry(
					async () => {
						return await session.run(`
					CALL gds.version() YIELD version
					RETURN version
				`);
					},
					{ maxAttempts: 2, initialDelay: 500 }
				);

				this.gdsAvailable = result.records.length > 0;
				logger.info('GDS availability checked', { available: this.gdsAvailable });
				return this.gdsAvailable;
			} catch (error) {
				this.gdsAvailable = false;
				logger.debug('GDS not available, using fallback queries');
				return false;
			} finally {
				await session.close();
			}
		} catch (error) {
			handleError(error, 'GraphAnalytics.checkGDSAvailability');
			return false;
		}
	}

	/**
	 * Safely get numeric value from Neo4j result with validation
	 */
	// Note: Using 'any' here for Neo4j record compatibility - records can have various shapes and methods
	private safeGetNumber(records: Array<{ get: (field: string) => unknown }>, field: string, defaultValue = 0): number {
		validateInput(
			{ records, field },
			{
				records: { required: true },
				field: { required: true, type: 'string' },
			}
		);

		if (!records || records.length === 0) return defaultValue;

		const value = records[0].get(field);

		// Handle Neo4j Integer type
		if (value && typeof value === 'object' && 'toNumber' in value && typeof (value as any).toNumber === 'function') {
			return (value as any).toNumber();
		}

		return typeof value === 'number' ? value : defaultValue;
	}

	/**
	 * Analyze character network with GDS or fallback, caching, and performance tracking
	 */
	async analyzeCharacterNetwork(): Promise<CharacterNetwork> {
		const cacheKey = 'character-network-analysis';

		return measureExecution(async () => {
			// Check cache first
			const cached = this.getCachedResult<CharacterNetwork>(cacheKey);
			if (cached) {
				logger.debug('Using cached character network analysis');
				return cached;
			}

			try {
				if (!this.rateLimiter.tryRemove()) {
					throw new AppError('Rate limit exceeded', ErrorCode.RATE_LIMITED);
				}

				const hasGDS = await this.checkGDSAvailability();
				const result = hasGDS
					? await this.analyzeCharacterNetworkGDS()
					: await this.analyzeCharacterNetworkBasic();

				// Cache the result
				this.setCachedResult(cacheKey, result);

				logger.info('Character network analysis completed', {
					method: hasGDS ? 'GDS' : 'Basic',
					nodeCount: result.nodes.length,
					clusters: result.clusters,
					density: result.density.toFixed(3),
				});

				return result;
			} catch (error) {
				handleError(error, 'GraphAnalytics.analyzeCharacterNetwork');
				throw error;
			}
		}).then((result) => {
			this.trackPerformance('analyzeCharacterNetwork', result.ms);
			return result.result;
		});
	}

	/**
	 * GDS-based character network analysis
	 */
	private async analyzeCharacterNetworkGDS(): Promise<CharacterNetwork> {
		const graphName = `character-network-${Date.now()}`;
		const session = this.driver.session();

		try {
			return await session.executeRead(async (tx) => {
				// Create graph projection
				await tx.run(
					`
					CALL gds.graph.project.cypher(
						$graphName,
						'MATCH (c:Character) RETURN id(c) AS id',
						'MATCH (c1:Character)-[r:RELATES_TO]->(c2:Character) 
						 RETURN id(c1) AS source, id(c2) AS target, 
						 coalesce(r.weight, 1.0) AS weight'
					) YIELD graphName, nodeCount, relationshipCount
				`,
					{ graphName }
				);

				try {
					// Calculate centrality
					const centralityResult = await tx.run(
						`
						CALL gds.pageRank.stream($graphName)
						YIELD nodeId, score
						WITH gds.util.asNode(nodeId) AS char, score
						ORDER BY score DESC
						LIMIT 100
						RETURN char.id AS id, char.name AS name, score AS centrality
					`,
						{ graphName }
					);

					// Detect communities
					const clusterResult = await tx.run(
						`
						CALL gds.louvain.stream($graphName)
						YIELD nodeId, communityId
						WITH gds.util.asNode(nodeId) AS char, communityId
						RETURN char.id AS id, communityId AS cluster
						LIMIT 1000
					`,
						{ graphName }
					);

					// Find isolated characters
					const isolatedResult = await tx.run(`
						MATCH (c:Character)
						WHERE NOT (c)-[:RELATES_TO]-()
						RETURN c.id AS id, c.name AS name
						LIMIT 100
					`);

					// Get all connections in batch (avoiding N+1)
					const centralChars = centralityResult.records.map((r) => ({
						id: r.get('id'),
						name: r.get('name'),
						centrality: r.get('centrality'),
						connections: 0,
					}));

					if (centralChars.length > 0) {
						const connectionsResult = await tx.run(
							`
							MATCH (c:Character)-[:RELATES_TO]-(other)
							WHERE c.id IN $ids
							RETURN c.id AS id, count(DISTINCT other) AS connections
						`,
							{ ids: centralChars.map((c) => c.id) }
						);

						const connectionsMap = new Map(
							connectionsResult.records.map((r) => [
								r.get('id'),
								this.safeGetNumber([r], 'connections'),
							])
						);

						centralChars.forEach((char) => {
							char.connections = connectionsMap.get(char.id) || 0;
						});
					}

					// Add cluster information
					const clusterMap = new Map(
						clusterResult.records.map((r) => [
							r.get('id'),
							this.safeGetNumber([r], 'cluster'),
						])
					);

					centralChars.forEach((char: Record<string, unknown>) => {
						char.cluster = clusterMap.get(char.id);
					});

					// Calculate network density
					const densityResult = await tx.run(`
						MATCH (c:Character)
						WITH count(c) AS nodeCount
						MATCH ()-[r:RELATES_TO]->()
						WITH nodeCount, count(r) AS edgeCount
						RETURN toFloat(edgeCount) / (nodeCount * (nodeCount - 1)) AS density
					`);

					return {
						nodes: centralChars,
						clusters: new Set(clusterMap.values()).size,
						isolated: isolatedResult.records.map((r) => r.get('name')),
						density: this.safeGetNumber(densityResult.records, 'density'),
					};
				} finally {
					// Always cleanup graph projection
					await tx
						.run(
							`
						CALL gds.graph.drop($graphName, false) 
						YIELD graphName
						RETURN graphName
					`,
							{ graphName }
						)
						.catch((err) => {
							logger.error('Failed to drop graph projection', {
								graphName,
								error: err,
							});
						});
				}
			});
		} finally {
			await session.close();
		}
	}

	/**
	 * Basic character network analysis without GDS
	 */
	private async analyzeCharacterNetworkBasic(): Promise<CharacterNetwork> {
		const session = this.driver.session();

		try {
			return await session.executeRead(async (tx) => {
				// Get character centrality using degree
				const centralityResult = await tx.run(`
					MATCH (c:Character)
					OPTIONAL MATCH (c)-[r:RELATES_TO]-()
					WITH c, count(r) AS degree
					ORDER BY degree DESC
					LIMIT 100
					RETURN c.id AS id, c.name AS name, 
						   toFloat(degree) / 100 AS centrality,
						   degree AS connections
				`);

				const nodes = centralityResult.records.map((r) => ({
					id: r.get('id'),
					name: r.get('name'),
					centrality: this.safeGetNumber([r], 'centrality'),
					connections: this.safeGetNumber([r], 'connections'),
				}));

				// Find isolated characters
				const isolatedResult = await tx.run(`
					MATCH (c:Character)
					WHERE NOT (c)-[:RELATES_TO]-()
					RETURN c.name AS name
					LIMIT 100
				`);

				// Estimate clusters using connected components
				const clusterResult = await tx.run(`
					MATCH (c:Character)
					WITH c
					LIMIT 1000
					CALL {
						WITH c
						MATCH path = (c)-[:RELATES_TO*1..3]-(other:Character)
						RETURN min(id(c), min([n IN nodes(path) | id(n)])) AS clusterId
					}
					RETURN count(DISTINCT clusterId) AS clusterCount
				`);

				// Calculate density
				const densityResult = await tx.run(`
					MATCH (c:Character)
					WITH count(c) AS nodeCount
					MATCH ()-[r:RELATES_TO]->()
					WITH nodeCount, count(r) AS edgeCount
					RETURN CASE 
						WHEN nodeCount > 1 
						THEN toFloat(edgeCount) / (nodeCount * (nodeCount - 1))
						ELSE 0.0
					END AS density
				`);

				return {
					nodes,
					clusters: this.safeGetNumber(clusterResult.records, 'clusterCount', 1),
					isolated: isolatedResult.records.map((r) => r.get('name')),
					density: this.safeGetNumber(densityResult.records, 'density'),
				};
			});
		} finally {
			await session.close();
		}
	}

	/**
	 * Analyze plot threads
	 */
	async analyzePlotThreads(): Promise<PlotAnalysis> {
		const session = this.driver.session();

		try {
			return await session.executeRead(async (tx) => {
				// Get thread count
				const threadCountResult = await tx.run(`
					MATCH (p:PlotThread)
					RETURN count(p) AS count
				`);

				const threadCount = this.safeGetNumber(threadCountResult.records, 'count');

				if (threadCount === 0) {
					return {
						threadCount: 0,
						avgThreadLength: 0,
						convergencePoints: 0,
						complexity: 0,
					};
				}

				// Get average thread length
				const lengthResult = await tx.run(`
					MATCH (p:PlotThread)-[:OCCURS_IN]->(d:Document)
					WITH p, count(d) AS length
					RETURN avg(length) AS avgLength
				`);

				// Find convergence points (chapters with multiple threads)
				const convergenceResult = await tx.run(`
					MATCH (d:Document)<-[:OCCURS_IN]-(p:PlotThread)
					WITH d, count(DISTINCT p) AS threadCount
					WHERE threadCount > 1
					RETURN count(d) AS convergencePoints
				`);

				// Calculate complexity (interconnected threads)
				const complexityResult = await tx.run(`
					MATCH (p1:PlotThread)-[:RELATES_TO]-(p2:PlotThread)
					WHERE id(p1) < id(p2)
					RETURN count(*) AS connections
				`);

				return {
					threadCount,
					avgThreadLength: this.safeGetNumber(lengthResult.records, 'avgLength'),
					convergencePoints: this.safeGetNumber(
						convergenceResult.records,
						'convergencePoints'
					),
					complexity: this.safeGetNumber(complexityResult.records, 'connections'),
				};
			});
		} finally {
			await session.close();
		}
	}

	/**
	 * Analyze narrative structure
	 */
	async analyzeNarrativeStructure(): Promise<NarrativeStructure> {
		const session = this.driver.session();

		try {
			return await session.executeRead(async (tx) => {
				// Get chapters with limits to prevent OOM
				const chapterResult = await tx.run(
					`
					MATCH (d:Document {type: 'chapter'})
					WITH d 
					ORDER BY d.order, d.title 
					LIMIT $limit
					OPTIONAL MATCH (d)<-[:APPEARS_IN]-(c:Character)
					WITH d, count(DISTINCT c) AS charCount
					OPTIONAL MATCH (d)<-[:OCCURS_IN]-(p:PlotThread)
					WITH d, charCount, count(DISTINCT p) AS plotCount
					RETURN d.id AS id, d.title AS title,
						   charCount AS characters,
						   plotCount AS plotThreads,
						   (charCount + plotCount * 2) AS intensity
					ORDER BY d.order, d.title
				`,
					{ limit: this.batchSize }
				);

				const chapters: ChapterInfo[] = chapterResult.records.map((r) => ({
					id: r.get('id'),
					title: r.get('title'),
					characters: this.safeGetNumber([r], 'characters'),
					plotThreads: this.safeGetNumber([r], 'plotThreads'),
					intensity: this.safeGetNumber([r], 'intensity'),
				}));

				// Extract tension curve
				const tensionCurve = chapters.map((c) => c.intensity);

				// Calculate average intensity (handle empty array)
				const avgIntensity =
					tensionCurve.length > 0
						? tensionCurve.reduce((a, b) => a + b, 0) / tensionCurve.length
						: 0;

				// Find climax chapter (highest intensity)
				let climaxChapter = 0;
				let maxIntensity = 0;

				tensionCurve.forEach((intensity, index) => {
					if (intensity > maxIntensity) {
						maxIntensity = intensity;
						climaxChapter = index;
					}
				});

				return {
					chapters,
					tensionCurve,
					avgIntensity,
					climaxChapter,
				};
			});
		} finally {
			await session.close();
		}
	}

	/**
	 * Get timeline analysis
	 */
	async analyzeTimeline(): Promise<{
		events: Array<{ id: string; date: string; description: string }>;
		gaps: Array<{ start: string; end: string; days: number }>;
		density: number;
	}> {
		const session = this.driver.session();

		try {
			return await session.executeRead(async (tx) => {
				// Get timeline events
				const eventsResult = await tx.run(
					`
					MATCH (e:TimelineEvent)
					RETURN e.id AS id, e.date AS date, e.description AS description
					ORDER BY e.date
					LIMIT $limit
				`,
					{ limit: this.batchSize }
				);

				const events = eventsResult.records.map((r) => ({
					id: r.get('id'),
					date: r.get('date'),
					description: r.get('description'),
				}));

				// Find gaps in timeline
				const gaps: Array<{ start: string; end: string; days: number }> = [];

				for (let i = 1; i < events.length; i++) {
					const prevDate = new Date(events[i - 1].date);
					const currDate = new Date(events[i].date);
					const daysDiff = Math.floor(
						(currDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24)
					);

					if (daysDiff > 7) {
						gaps.push({
							start: events[i - 1].date,
							end: events[i].date,
							days: daysDiff,
						});
					}
				}

				// Calculate event density
				let density = 0;
				if (events.length >= 2) {
					const firstDate = new Date(events[0].date);
					const lastDate = new Date(events[events.length - 1].date);
					const totalDays = Math.floor(
						(lastDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24)
					);

					density = totalDays > 0 ? events.length / totalDays : 0;
				}

				return {
					events,
					gaps,
					density,
				};
			});
		} finally {
			await session.close();
		}
	}

	/**
	 * Run comprehensive analysis
	 */
	async runFullAnalysis(): Promise<{
		characters: CharacterNetwork;
		plot: PlotAnalysis;
		narrative: NarrativeStructure;
		timeline: Record<string, unknown>;
	}> {
		// Run analyses in parallel where possible
		const [characters, plot, narrative, timeline] = await Promise.all([
			this.analyzeCharacterNetwork(),
			this.analyzePlotThreads(),
			this.analyzeNarrativeStructure(),
			this.analyzeTimeline(),
		]);

		return {
			characters,
			plot,
			narrative,
			timeline,
		};
	}

	/**
	 * Get recommendation based on analysis
	 */
	async getRecommendations(): Promise<string[]> {
		const recommendations: string[] = [];
		const session = this.driver.session();

		try {
			await session.executeRead(async (tx) => {
				// Check for isolated characters
				const isolatedResult = await tx.run(`
					MATCH (c:Character)
					WHERE NOT (c)-[:RELATES_TO]-()
					RETURN count(c) AS count
				`);

				const isolatedCount = this.safeGetNumber(isolatedResult.records, 'count');

				if (isolatedCount > 0) {
					recommendations.push(
						`${isolatedCount} character(s) have no relationships. Consider connecting them to the story.`
					);
				}

				// Check for plot threads without resolution
				const unresolvedResult = await tx.run(`
					MATCH (p:PlotThread)
					WHERE NOT (p)-[:RESOLVES_IN]->()
					RETURN count(p) AS count
				`);

				const unresolvedCount = this.safeGetNumber(unresolvedResult.records, 'count');

				if (unresolvedCount > 0) {
					recommendations.push(
						`${unresolvedCount} plot thread(s) lack resolution. Consider adding conclusions.`
					);
				}

				// Check for sparse chapters
				const sparseResult = await tx.run(`
					MATCH (d:Document {type: 'chapter'})
					WHERE NOT (d)<-[:APPEARS_IN]-() AND NOT (d)<-[:OCCURS_IN]-()
					RETURN count(d) AS count
				`);

				const sparseCount = this.safeGetNumber(sparseResult.records, 'count');

				if (sparseCount > 0) {
					recommendations.push(
						`${sparseCount} chapter(s) have no character appearances or plot developments.`
					);
				}
			});
		} finally {
			await session.close();
		}

		return recommendations;
	}

	/**
	 * Enhanced batch analysis with transaction management and comprehensive error handling
	 */
	async performBatchAnalysis(documentIds: string[]): Promise<{
		characterNetworks: CharacterNetwork[];
		plotAnalyses: PlotAnalysis[];
		narrativeStructures: NarrativeStructure[];
		processingStats: {
			totalProcessed: number;
			successRate: number;
			avgProcessingTime: string;
			errors: string[];
		};
	}> {
		// Validate input using validation schema
		const schema: ValidationSchema = {
			documentIds: {
				required: true,
				type: 'array',
				minLength: 1,
				maxLength: 100,
			},
		};

		validateInput({ documentIds }, schema);

		const results = {
			characterNetworks: [] as CharacterNetwork[],
			plotAnalyses: [] as PlotAnalysis[],
			narrativeStructures: [] as NarrativeStructure[],
			processingStats: {
				totalProcessed: 0,
				successRate: 0,
				avgProcessingTime: '0ms',
				errors: [] as string[],
			},
		};

		const startTime = performance.now();
		logger.info('Starting batch analysis', {
			documentCount: documentIds.length,
			batchSize: this.batchSize,
			estimatedTime: formatDuration(documentIds.length * 1000),
		});

		try {
			// Process documents in batches using processBatch utility
			const batchProcessor = async (batch: string[]): Promise<unknown[]> => {
				await AsyncUtils.withTimeout(
					this.processBatchWithTransaction(batch, results),
					30000, // 30 second timeout per batch
					`Batch processing timeout for ${batch.length} documents`
				);
				return [];
			};

			await processBatch(documentIds, batchProcessor, this.batchSize);

			// Calculate final statistics
			const totalTime = performance.now() - startTime;
			const successCount =
				results.characterNetworks.length +
				results.plotAnalyses.length +
				results.narrativeStructures.length;

			results.processingStats = {
				totalProcessed: documentIds.length,
				successRate: Math.round((successCount / (documentIds.length * 3)) * 100) / 100,
				avgProcessingTime: formatDuration(totalTime / documentIds.length),
				errors: results.processingStats.errors,
			};

			logger.info('Batch analysis completed', {
				totalDocuments: documentIds.length,
				successRate: `${results.processingStats.successRate * 100}%`,
				totalTime: formatDuration(totalTime),
				errorCount: results.processingStats.errors.length,
			});

			return results;
		} catch (error) {
			const appError =
				error instanceof AppError
					? error
					: new AppError('Batch analysis failed', ErrorCode.PROCESSING_ERROR, {
							cause: error,
							documentCount: documentIds.length,
						});

			handleError(appError);
			throw appError;
		}
	}

	/**
	 * Process a batch with proper transaction management
	 */
	// Note: Using 'any' here to accommodate various result object structures from analytics processing
	private async processBatchWithTransaction(documentIds: string[], results: Record<string, unknown>): Promise<void> {
		const session: Session = this.driver.session();

		try {
			await session.executeWrite(async (tx: ManagedTransaction) => {
				for (const docId of documentIds) {
					try {
						// Validate document exists before processing
						const docCheck = await tx.run(
							'MATCH (d:Document {id: $id}) RETURN count(d) as count',
							{ id: docId }
						);

						if (this.safeGetNumber(docCheck.records, 'count') === 0) {
							throw new AppError(`Document not found: ${docId}`, ErrorCode.NOT_FOUND);
						}

						// Process document analytics within transaction
						await this.processDocumentInTransaction(tx, docId, results);
					} catch (error) {
						const errorMsg = `Failed to process document ${truncate(docId, 20)}: ${(error as Error).message}`;
						(results.processingStats as any).errors.push(errorMsg);
						logger.warn('Document processing failed', {
							docId: truncate(docId, 20),
							error: (error as Error).message,
						});
					}
				}
			});
		} finally {
			await session.close();
		}
	}

	/**
	 * Process individual document within transaction context
	 */
	private async processDocumentInTransaction(
		tx: ManagedTransaction,
		documentId: string,
		// Note: Using 'any' here to accommodate various result object structures
		results: Record<string, unknown>
	): Promise<void> {
		// Process character network for this document
		try {
			const networkData = await tx.run(
				`
				MATCH (d:Document {id: $docId})<-[:APPEARS_IN]-(c:Character)
				WITH d, collect(c) as characters
				UNWIND characters as char1
				UNWIND characters as char2
				WHERE id(char1) < id(char2)
				MATCH (char1)-[r:RELATES_TO]-(char2)
				RETURN char1.name as char1Name, char2.name as char2Name, 
					   count(r) as relationshipStrength
			`,
				{ docId: documentId }
			);

			if (networkData.records.length > 0) {
				// Build character network from transaction data
				const network = this.buildCharacterNetworkFromRecords(networkData.records);
				(results.characterNetworks as CharacterNetwork[]).push(network);
			}
		} catch (error) {
			logger.warn('Character network processing failed', {
				documentId: truncate(documentId, 20),
				error: (error as Error).message,
			});
		}

		// Process plot analysis for this document
		try {
			const plotData = await tx.run(
				`
				MATCH (d:Document {id: $docId})<-[:OCCURS_IN]-(p:PlotThread)
				RETURN count(p) as threadCount,
					   avg(p.length) as avgLength,
					   count(DISTINCT p.convergencePoint) as convergencePoints
			`,
				{ docId: documentId }
			);

			if (plotData.records.length > 0) {
				const analysis: PlotAnalysis = {
					threadCount: this.safeGetNumber(plotData.records, 'threadCount'),
					avgThreadLength: this.safeGetNumber(plotData.records, 'avgLength'),
					convergencePoints: this.safeGetNumber(plotData.records, 'convergencePoints'),
					complexity: 0, // Calculate based on the other metrics
				};
				analysis.complexity =
					(analysis.threadCount * analysis.convergencePoints) /
					Math.max(analysis.avgThreadLength, 1);
				(results.plotAnalyses as PlotAnalysis[]).push(analysis);
			}
		} catch (error) {
			logger.warn('Plot analysis processing failed', {
				documentId: truncate(documentId, 20),
				error: (error as Error).message,
			});
		}
	}

	/**
	 * Build character network from Neo4j records
	 */
	// Note: Using 'any' here for Neo4j record compatibility - records have .get() methods and complex structures
	private buildCharacterNetworkFromRecords(records: Array<{ get: (field: string) => unknown }>): CharacterNetwork {
		const nodeMap = new Map<string, CharacterNode>();
		let totalConnections = 0;

		records.forEach((record) => {
			const char1 = record.get('char1Name') as string;
			const char2 = record.get('char2Name') as string;
			const strength = this.safeGetNumber([record], 'relationshipStrength', 1);

			// Update or create nodes
			if (!nodeMap.has(char1)) {
				nodeMap.set(char1, {
					id: generateHash(char1),
					name: char1,
					centrality: 0,
					connections: 0,
				});
			}
			if (!nodeMap.has(char2)) {
				nodeMap.set(char2, {
					id: generateHash(char2),
					name: char2,
					centrality: 0,
					connections: 0,
				});
			}

			// Update connection counts
			nodeMap.get(char1)!.connections += strength;
			nodeMap.get(char2)!.connections += strength;
			totalConnections += strength;
		});

		const nodes = Array.from(nodeMap.values());
		const nodeCount = nodes.length;

		// Calculate centrality scores
		nodes.forEach((node) => {
			node.centrality = totalConnections > 0 ? node.connections / totalConnections : 0;
		});

		// Calculate network density
		const possibleConnections = nodeCount > 1 ? (nodeCount * (nodeCount - 1)) / 2 : 0;
		const density = possibleConnections > 0 ? totalConnections / possibleConnections : 0;

		return {
			nodes,
			clusters: Math.max(1, Math.ceil(nodeCount / 3)), // Simple clustering estimate
			isolated: nodes.filter((n) => n.connections === 0).map((n) => n.name),
			density,
		};
	}
}
