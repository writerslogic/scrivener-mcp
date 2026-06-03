/**
 * Fractal Memory Service
 * Integrates Python fractal memory system with TypeScript MCP handlers
 * Uses high-performance better-sqlite3 for local storage
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { getLogger } from '../../core/logger.js';

const logger = getLogger('fractal-memory');

interface FractalSegment {
	id: string;
	scale: 'micro' | 'meso' | 'macro';
	text: string;
	chapterId: string;
	startPos: number;
	endPos: number;
	parentId?: string;
	sequenceNum: number;
	metadata?: Record<string, unknown>;
}

interface Entity {
	id: string;
	type: 'character' | 'location' | 'object' | 'concept';
	name: string;
	aliases?: string[];
	description?: string;
	properties?: Record<string, unknown>;
}

interface Motif {
	id: string;
	name: string;
	description?: string;
	patternType: 'theme' | 'symbol' | 'phrase' | 'structure';
	examples?: string[];
	clusterId?: number;
	strength: number;
}

interface RetrievalPolicy {
	name: string;
	scaleWeights: {
		micro: number;
		meso: number;
		macro: number;
	};
	entityBoost?: number;
	motifBoost?: number;
	recencyWeight?: number;
	frequencyWeight?: number;
}

interface SearchOptions {
	policy?: string;
	k?: number;
	chapterId?: string;
	includeEntities?: boolean;
	includeMotifs?: boolean;
}

interface SearchResult {
	segments: FractalSegment[];
	entities?: Entity[];
	motifs?: Motif[];
	score: number;
	metadata?: Record<string, unknown>;
}

export class FractalMemoryService {
	private db: Database.Database | null = null;
	private pythonProcess: any | null = null;
	private dbPath: string;
	private pythonScriptPath: string;
	private initialized: boolean = false;

	constructor(dbPath?: string) {
		this.dbPath = dbPath || path.join(process.cwd(), 'narrative_memory.db');
		this.pythonScriptPath = path.join(process.cwd(), 'fractal_memory_advanced.py');
	}

	/**
	 * Initialize the fractal memory service
	 */
	async initialize(): Promise<void> {
		if (this.initialized) {
			return;
		}

		try {
			await this.initializeDatabase();

			// Verify Python script exists
			if (!fs.existsSync(this.pythonScriptPath)) {
				logger.warn(
					'Python fractal memory script not found, some features will be limited'
				);
			}

			this.initialized = true;
			logger.info('Fractal memory service initialized');
		} catch (error) {
			logger.error('Failed to initialize fractal memory service', { error });
			throw error;
		}
	}

	/**
	 * Initialize SQLite database
	 */
	private async initializeDatabase(): Promise<void> {
		try {
			this.db = new Database(this.dbPath);

			const schemaPath = path.join(process.cwd(), 'src/services/memory/schema.sql');

			if (fs.existsSync(schemaPath)) {
				const schema = await fs.promises.readFile(schemaPath, 'utf-8');
				this.db.exec(schema);
				logger.info('Database schema initialized');
			} else {
				logger.warn('Schema file not found, database may need manual setup');
			}
		} catch (error) {
			logger.error('Failed to initialize database', { error });
			throw error;
		}
	}

	/**
	 * Ingest text into fractal memory system
	 */
	async ingestText(
		text: string,
		chapterId: string,
		options?: {
			forceRebuild?: boolean;
			extractEntities?: boolean;
			clusterMotifs?: boolean;
		}
	): Promise<void> {
		try {
			const result = await this.callPythonScript('ingest', {
				text,
				chapterId,
				...options,
			});

			if ((result as any).error) {
				throw new Error(`Ingestion failed: ${(result as any).error}`);
			}

			logger.info('Text ingested successfully', {
				chapterId,
				segments: (result as any).segmentCount,
				entities: (result as any).entityCount,
				motifs: (result as any).motifCount,
			});
		} catch (error) {
			logger.error('Failed to ingest text', { error });
			throw error;
		}
	}

	/**
	 * Search using fractal retrieval
	 */
	async search(
		query: string,
		options?: {
			policy?: 'line-fix' | 'scene-fix' | 'thematic' | 'continuity';
			k?: number;
			chapterId?: string;
			includeGraph?: boolean;
		}
	): Promise<SearchResult[]> {
		try {
			const result = await this.callPythonScript('search', {
				query,
				...options,
			});

			if ((result as any).error) {
				return this.searchFallback(query, options);
			}

			return (result as any).results;
		} catch (error) {
			logger.error('Search failed', { error });
			return this.searchFallback(query, options);
		}
	}

	/**
	 * Fallback search implementation in TypeScript
	 */
	private async searchFallback(query: string, options?: SearchOptions): Promise<SearchResult[]> {
		if (!this.db) {
			throw new Error('Database not initialized');
		}

		const policy = options?.policy || 'scene-fix';
		const limit = options?.k || 10;

		const sql = `
			SELECT 
				s.id, s.scale, s.text, s.chapter_id as chapterId,
				s.start_pos as startPos, s.end_pos as endPos,
				s.parent_id as parentId, s.sequence_num as sequenceNum
			FROM segments s
			WHERE s.text LIKE ?
			${options?.chapterId ? 'AND s.chapter_id = ?' : ''}
			ORDER BY 
				CASE s.scale 
					WHEN 'micro' THEN ${policy === 'line-fix' ? 1 : 3}
					WHEN 'meso' THEN 2
					WHEN 'macro' THEN ${policy === 'thematic' ? 1 : 3}
				END,
				s.sequence_num
			LIMIT ?
		`;

		const params = [`%${query}%`];
		if (options?.chapterId) {
			params.push(options.chapterId);
		}
		params.push(limit.toString());

		const rows = this.db.prepare(sql).all(...params) as any[];

		return rows.map((row) => ({
			segments: [row],
			score: 1.0,
			metadata: { policy, fallback: true },
		}));
	}

	/**
	 * Find co-occurrences of entities/motifs
	 */
	async findCoOccurrences(
		items: string[],
		options?: {
			itemTypes?: ('entity' | 'motif')[];
			minDistance?: number;
			maxDistance?: number;
		}
	): Promise<any[]> {
		try {
			const result = await this.callPythonScript('cooccurrences', {
				items,
				...options,
			});

			if ((result as any).error) {
				throw new Error(`Co-occurrence search failed: ${(result as any).error}`);
			}

			return (result as any).cooccurrences;
		} catch (error) {
			logger.error('Failed to find co-occurrences', { error });
			throw error;
		}
	}

	/**
	 * Check character continuity
	 */
	async checkContinuity(
		characterName: string,
		options?: {
			chapterId?: string;
			includeRelationships?: boolean;
		}
	): Promise<any> {
		if (!this.db) {
			throw new Error('Database not initialized');
		}

		const sql = `
			SELECT 
				character_name,
				chapter_id,
				scale,
				appearance_count,
				first_appearance_seq,
				last_appearance_seq,
				segment_ids
			FROM character_continuity
			WHERE character_name = ?
			${options?.chapterId ? 'AND chapter_id = ?' : ''}
			ORDER BY chapter_id, scale
		`;

		const params = [characterName];
		if (options?.chapterId) {
			params.push(options.chapterId);
		}

		const rows = this.db.prepare(sql).all(...params) as any[];

		return {
			character: characterName,
			continuity: rows,
			gaps: this.identifyContinuityGaps(rows),
		};
	}

	private identifyContinuityGaps(appearances: any[]): any[] {
		const gaps = [];

		for (let i = 1; i < appearances.length; i++) {
			const prev = appearances[i - 1];
			const curr = appearances[i];

			if (curr.first_appearance_seq - prev.last_appearance_seq > 10) {
				gaps.push({
					from: prev,
					to: curr,
					gapSize: curr.first_appearance_seq - prev.last_appearance_seq,
				});
			}
		}

		return gaps;
	}

	/**
	 * Track motif patterns
	 */
	async trackMotifs(options?: {
		chapterId?: string;
		minStrength?: number;
		patternType?: string;
	}): Promise<any[]> {
		if (!this.db) {
			throw new Error('Database not initialized');
		}

		let sql = `
			SELECT 
				motif_name,
				pattern_type,
				chapter_id,
				occurrence_count,
				avg_strength,
				segment_ids
			FROM motif_tracking
			WHERE 1=1
		`;

		const params: any[] = [];

		if (options?.chapterId) {
			sql += ' AND chapter_id = ?';
			params.push(options.chapterId);
		}

		if (options?.minStrength) {
			sql += ' AND avg_strength >= ?';
			params.push(options.minStrength);
		}

		if (options?.patternType) {
			sql += ' AND pattern_type = ?';
			params.push(options.patternType);
		}

		sql += ' ORDER BY avg_strength DESC, occurrence_count DESC';

		return this.db.prepare(sql).all(...params);
	}

	/**
	 * Update retrieval policy
	 */
	async updatePolicy(name: string, policy: Partial<RetrievalPolicy>): Promise<void> {
		if (!this.db) {
			throw new Error('Database not initialized');
		}

		const sql = `
			UPDATE memory_policies
			SET 
				scale_weights = ?,
				entity_boost = ?,
				motif_boost = ?,
				recency_weight = ?,
				frequency_weight = ?,
				updated_at = CURRENT_TIMESTAMP
			WHERE name = ?
		`;

		this.db
			.prepare(sql)
			.run(
				JSON.stringify(policy.scaleWeights),
				policy.entityBoost || 1.0,
				policy.motifBoost || 1.0,
				policy.recencyWeight || 0.1,
				policy.frequencyWeight || 0.1,
				name
			);
	}

	/**
	 * Call Python script for advanced operations
	 */
	private async callPythonScript(operation: string, params: unknown): Promise<unknown> {
		return new Promise((resolve) => {
			if (!fs.existsSync(this.pythonScriptPath)) {
				resolve({ error: 'Python script not available' });
				return;
			}

			const args = [
				this.pythonScriptPath,
				'--operation',
				operation,
				'--params',
				JSON.stringify(params),
				'--db',
				this.dbPath,
			];

			const python = spawn('python3', args);
			let output = '';
			let error = '';

			python.stdout.on('data', (data: Buffer) => {
				output += data.toString();
			});

			python.stderr.on('data', (data: Buffer) => {
				error += data.toString();
			});

			python.on('close', (code: number) => {
				if (code !== 0) {
					logger.error('Python script failed', { code, error });
					resolve({ error: error || 'Python script failed' });
				} else {
					try {
						const result = JSON.parse(output);
						resolve(result);
					} catch (e) {
						logger.error('Failed to parse Python output', { output, error: e });
						resolve({ error: 'Invalid Python output' });
					}
				}
			});

			python.on('error', (err: Error) => {
				logger.error('Failed to spawn Python process', { error: err });
				resolve({ error: 'Failed to spawn Python process' });
			});

			setTimeout(() => {
				python.kill();
				resolve({ error: 'Python script timeout' });
			}, 30000);
		});
	}

	/**
	 * Get analytics and performance metrics
	 */
	async getAnalytics(options?: {
		startDate?: Date;
		endDate?: Date;
		limit?: number;
	}): Promise<any> {
		if (!this.db) {
			throw new Error('Database not initialized');
		}

		const sql = `
			SELECT 
				COUNT(*) as total_queries,
				AVG(latency_ms) as avg_latency,
				AVG(results_count) as avg_results,
				AVG(relevance_score) as avg_relevance,
				policy,
				COUNT(CASE WHEN user_feedback = 'positive' THEN 1 END) as positive_feedback,
				COUNT(CASE WHEN user_feedback = 'negative' THEN 1 END) as negative_feedback
			FROM retrieval_analytics
			WHERE created_at BETWEEN ? AND ?
			GROUP BY policy
			ORDER BY total_queries DESC
			LIMIT ?
		`;

		const params = [
			(options?.startDate || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)).toISOString(),
			(options?.endDate || new Date()).toISOString(),
			options?.limit || 10,
		];

		const rows = this.db.prepare(sql).all(...params) as any[];

		return {
			metrics: rows,
			summary: this.summarizeAnalytics(rows),
		};
	}

	/**
	 * Summarize analytics
	 */
	private summarizeAnalytics(metrics: any[]): Record<string, unknown> {
		if (metrics.length === 0) return { totalQueries: 0 };

		const totalQueries = metrics.reduce((sum, m) => sum + Number(m.total_queries || 0), 0);
		const avgLatency =
			metrics.reduce(
				(sum, m) => sum + Number(m.avg_latency || 0) * Number(m.total_queries || 0),
				0
			) / totalQueries;
		const avgRelevance =
			metrics.reduce(
				(sum, m) => sum + Number(m.avg_relevance || 0) * Number(m.total_queries || 0),
				0
			) / totalQueries;

		return {
			totalQueries,
			avgLatency,
			avgRelevance,
			mostUsedPolicy: metrics[0]?.policy,
			satisfactionRate:
				metrics.reduce(
					(sum, m) =>
						sum +
						Number(m.positive_feedback || 0) /
							(Number(m.positive_feedback || 0) + Number(m.negative_feedback || 0) ||
								1),
					0
				) / metrics.length,
		};
	}

	/**
	 * Clean up resources
	 */
	async cleanup(): Promise<void> {
		if (this.pythonProcess) {
			this.pythonProcess.kill();
			this.pythonProcess = null;
		}

		if (this.db) {
			this.db.close();
			this.db = null;
		}

		this.initialized = false;
	}
}
