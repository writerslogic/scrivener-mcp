import * as path from 'path';
import { ApplicationError as AppError, ErrorCode } from '../core/errors.js';
import { getLogger } from '../core/logger.js';
import { ensureDir, pathExists, safeReadFile, safeWriteFile } from '../utils/common.js';
import { Neo4jAutoInstaller } from './auto-installer.js';
import type { DatabaseConfig, ProjectDatabasePaths } from './config.js';
import { DEFAULT_DATABASE_CONFIG, generateDatabasePaths } from './config.js';
import { DatabaseSetup } from './database-setup.js';
import { GraphAnalytics } from './graph-analytics.js';
import { MigrationManager } from './migrations.js';
import { Neo4jManager } from './neo4j-manager.js';
import { SQLQueryBuilder } from './query-builder.js';
import { SearchService } from './search-service.js';
import { SQLiteManager } from './sqlite-manager.js';
import { StoryIntelligence } from './story-intelligence.js';
import { WritingAnalytics } from './writing-analytics.js';

const logger = getLogger('database');

interface TransactionLog {
	id: string;
	timestamp: Date;
	operations: Array<{
		type: 'sqlite' | 'neo4j';
		operation: string;
		data: unknown;
		status: 'pending' | 'prepared' | 'committed' | 'rolled_back';
	}>;
	status: 'in_progress' | 'prepared' | 'committed' | 'rolled_back';
}

export class DatabaseService {
	private sqliteManager: SQLiteManager | null = null;
	private neo4jManager: Neo4jManager | null = null;
	private config: DatabaseConfig;
	private paths: ProjectDatabasePaths;
	private transactionLog: Map<string, TransactionLog> = new Map();
	private initialized: boolean = false;
	private graphAnalytics: GraphAnalytics | null = null;
	private migrationManager: MigrationManager | null = null;
	private searchService: SearchService | null = null;
	private writingAnalytics: WritingAnalytics | null = null;
	private storyIntelligence: StoryIntelligence | null = null;

	constructor(projectPath: string, config?: Partial<DatabaseConfig>) {
		this.paths = generateDatabasePaths(projectPath);

		// Merge with defaults
		this.config = {
			sqlite: {
				...DEFAULT_DATABASE_CONFIG.sqlite,
				path: this.paths.sqliteDb,
				...(config?.sqlite || {}),
			},
			neo4j: {
				...DEFAULT_DATABASE_CONFIG.neo4j,
				uri: `bolt://localhost:7687`,
				...(config?.neo4j || {}),
			},
		};
	}

	/**
	 * Initialize both databases
	 */
	async initialize(): Promise<void> {
		if (this.initialized) {
			return;
		}

		// Ensure database directory exists
		await ensureDir(this.paths.databaseDir);

		// Get credentials from environment or config
		const projectPath = path.dirname(this.paths.databaseDir);
		const credentials = await DatabaseSetup.getCredentials({ projectPath });

		// Override Neo4j config with credentials if available
		if (credentials.neo4j.password) {
			this.config.neo4j = {
				...this.config.neo4j,
				...credentials.neo4j,
			};
		}

		// Check Neo4j availability and offer auto-installation
		const neo4jStatus = await DatabaseSetup.checkNeo4jAvailability();
		if (this.config.neo4j.enabled && !neo4jStatus.running) {
			logger.warn('Neo4j is not running');

			// Check if we should auto-install
			const autoInstall =
				process.env.NEO4J_AUTO_INSTALL === 'true' || this.config.neo4j.autoInstall === true;

			if (autoInstall) {
				logger.info('Attempting automatic Neo4j installation...');
				const installResult = await Neo4jAutoInstaller.install({
					method: 'auto',
					interactive: process.env.NEO4J_INTERACTIVE !== 'false',
					projectPath,
					autoStart: true,
				});

				if (installResult.success && installResult.credentials) {
					// Update config with new credentials
					this.config.neo4j = {
						...this.config.neo4j,
						...installResult.credentials,
					};
					logger.info('Neo4j installed successfully');
				} else {
					logger.warn('Auto-installation failed. Continuing with SQLite only');
					logger.info('For manual installation:', {
						instructions: DatabaseSetup.getSetupInstructions(),
					});
					this.config.neo4j.enabled = false;
				}
			} else {
				logger.warn('The application will continue with SQLite only');
				logger.info(
					'To enable automatic Neo4j installation: Set NEO4J_AUTO_INSTALL=true in your .env file or run: NEO4J_AUTO_INSTALL=true npm start'
				);
				logger.info('For manual installation:', {
					instructions: DatabaseSetup.getSetupInstructions(),
				});
				this.config.neo4j.enabled = false;
			}
		}

		// Save config
		await this.saveConfig();

		// Initialize SQLite
		if (this.config.sqlite.enabled) {
			this.sqliteManager = new SQLiteManager(this.config.sqlite.path);
			await this.sqliteManager.initialize();
		}

		// Initialize Neo4j
		if (this.config.neo4j.enabled) {
			this.neo4jManager = new Neo4jManager(
				this.config.neo4j.uri,
				this.config.neo4j.user,
				this.config.neo4j.password,
				this.config.neo4j.database
			);
			await this.neo4jManager.initialize();

			// Initialize graph analytics
			this.graphAnalytics = new GraphAnalytics(this.neo4jManager);
		}

		// Initialize migration manager and run migrations
		this.migrationManager = new MigrationManager(this.sqliteManager, this.neo4jManager);
		await this.migrationManager.migrate();

		// Initialize search service
		this.searchService = new SearchService(this.sqliteManager, this.neo4jManager);

		// Initialize analytics services
		this.writingAnalytics = new WritingAnalytics(this.sqliteManager, this.neo4jManager);
		this.storyIntelligence = new StoryIntelligence(
			this.sqliteManager,
			this.neo4jManager,
			this.graphAnalytics
		);

		this.initialized = true;
	}

	/**
	 * Check if database service is initialized
	 */
	isInitialized(): boolean {
		return this.initialized;
	}

	/**
	 * Save database configuration
	 */
	private async saveConfig(): Promise<void> {
		const configData = {
			...this.config,
			sqlite: {
				...this.config.sqlite,
				path: path.relative(this.paths.databaseDir, this.config.sqlite.path),
			},
			lastUpdated: new Date().toISOString(),
		};

		await safeWriteFile(this.paths.configFile, JSON.stringify(configData, null, 2));
	}

	/**
	 * Load database configuration
	 */
	static async loadConfig(projectPath: string): Promise<DatabaseConfig | null> {
		const paths = generateDatabasePaths(projectPath);

		if (!(await pathExists(paths.configFile))) {
			return null;
		}

		try {
			const configData = JSON.parse(await safeReadFile(paths.configFile));

			// Convert relative path back to absolute
			if (configData.sqlite?.path && !path.isAbsolute(configData.sqlite.path)) {
				configData.sqlite.path = path.join(paths.databaseDir, configData.sqlite.path);
			}

			return configData;
		} catch {
			console.error('Failed to load database config');
			return null;
		}
	}

	/**
	 * Get SQLite manager
	 */
	getSQLite(): SQLiteManager {
		if (!this.sqliteManager) {
			throw new AppError(
				'SQLite not initialized. Call initialize() first.',
				ErrorCode.DATABASE_ERROR
			);
		}
		return this.sqliteManager;
	}

	/**
	 * Get Neo4j manager
	 */
	getNeo4j(): Neo4jManager | null {
		return this.neo4jManager;
	}

	/**
	 * Begin a two-phase commit transaction
	 */
	async beginTransaction(): Promise<string> {
		const transactionId = `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

		this.transactionLog.set(transactionId, {
			id: transactionId,
			timestamp: new Date(),
			operations: [],
			status: 'in_progress',
		});

		// Begin transactions in both databases
		if (this.sqliteManager) {
			this.sqliteManager.beginTransaction();
		}

		return transactionId;
	}

	/**
	 * Prepare phase of two-phase commit
	 */
	async prepareTransaction(transactionId: string): Promise<boolean> {
		const txn = this.transactionLog.get(transactionId);
		if (!txn) {
			throw new AppError('Transaction not found', ErrorCode.DATABASE_ERROR);
		}

		try {
			// Mark all operations as prepared
			txn.operations.forEach((op) => {
				if (op.status === 'pending') {
					op.status = 'prepared';
				}
			});

			txn.status = 'prepared';
			return true;
		} catch (error) {
			await this.rollbackTransaction(transactionId);
			return false;
		}
	}

	/**
	 * Commit phase of two-phase commit
	 */
	async commitTransaction(transactionId: string): Promise<void> {
		const txn = this.transactionLog.get(transactionId);
		if (!txn || txn.status !== 'prepared') {
			throw new AppError('Transaction not prepared', ErrorCode.DATABASE_ERROR);
		}

		try {
			// Commit SQLite transaction
			if (this.sqliteManager) {
				this.sqliteManager.commit();
			}

			// Mark transaction as committed
			txn.status = 'committed';
			txn.operations.forEach((op) => (op.status = 'committed'));

			// Clean up old transaction logs
			this.cleanupTransactionLogs();
		} catch (error) {
			await this.rollbackTransaction(transactionId);
			throw error;
		}
	}

	/**
	 * Rollback a transaction
	 */
	async rollbackTransaction(transactionId: string): Promise<void> {
		const txn = this.transactionLog.get(transactionId);
		if (!txn) return;

		// Rollback SQLite
		if (this.sqliteManager) {
			this.sqliteManager.rollback();
		}

		// Mark transaction as rolled back
		txn.status = 'rolled_back';
		txn.operations.forEach((op) => (op.status = 'rolled_back'));
	}

	/**
	 * Sync document data with two-phase commit
	 */
	async syncDocumentData(documentData: {
		id: string;
		title: string;
		type: string;
		synopsis?: string;
		notes?: string;
		wordCount?: number;
		characterCount?: number;
	}): Promise<void> {
		const transactionId = await this.beginTransaction();
		const txn = this.transactionLog.get(transactionId)!;

		try {
			// Phase 1: Prepare SQLite operation
			if (this.sqliteManager) {
				const sqliteOp: (typeof txn.operations)[0] = {
					type: 'sqlite',
					operation: 'upsert_document',
					data: documentData,
					status: 'pending',
				};
				txn.operations.push(sqliteOp);

				const { sql, params } = SQLQueryBuilder.insert('documents', {
					id: documentData.id,
					title: documentData.title,
					type: documentData.type,
					synopsis: documentData.synopsis || null,
					notes: documentData.notes || null,
					word_count: documentData.wordCount || 0,
					character_count: documentData.characterCount || 0,
					modified_at: new Date().toISOString(),
				});

				const stmt = this.sqliteManager
					.getDatabase()
					.prepare(sql.replace('INSERT', 'INSERT OR REPLACE'));
				stmt.run(params);

				sqliteOp.status = 'prepared';
			}

			// Phase 1: Prepare Neo4j operation
			if (this.neo4jManager && this.neo4jManager.isAvailable()) {
				const neo4jOp: (typeof txn.operations)[0] = {
					type: 'neo4j',
					operation: 'upsert_document',
					data: documentData,
					status: 'pending',
				};
				txn.operations.push(neo4jOp);

				await this.neo4jManager.upsertDocument(documentData);
				neo4jOp.status = 'prepared';
			}

			// Phase 2: Prepare and commit
			const prepared = await this.prepareTransaction(transactionId);
			if (prepared) {
				await this.commitTransaction(transactionId);
			} else {
				throw new AppError('Failed to prepare transaction', ErrorCode.DATABASE_ERROR);
			}
		} catch (error) {
			await this.rollbackTransaction(transactionId);
			throw error;
		}
	}

	/**
	 * Sync character data between databases
	 */
	async syncCharacterData(characterData: {
		id: string;
		name: string;
		role?: string;
		description?: string;
		traits?: string[];
		notes?: string;
	}): Promise<void> {
		// Update SQLite
		if (this.sqliteManager) {
			const { sql, params } = SQLQueryBuilder.insert('characters', {
				id: characterData.id,
				name: characterData.name,
				role: characterData.role || null,
				description: characterData.description || null,
				traits: JSON.stringify(characterData.traits || []),
				notes: characterData.notes || null,
				modified_at: new Date().toISOString(),
			});

			const stmt = this.sqliteManager
				.getDatabase()
				.prepare(sql.replace('INSERT', 'INSERT OR REPLACE'));
			stmt.run(params);
		}

		// Update Neo4j if available
		if (this.neo4jManager) {
			await this.neo4jManager.upsertCharacter(characterData);
		}
	}

	/**
	 * Create relationships between entities
	 */
	async createRelationship(
		fromId: string,
		fromType: string,
		toId: string,
		toType: string,
		relationshipType: string,
		properties: Record<string, unknown> = {}
	): Promise<void> {
		// Store in SQLite relationships table
		if (this.sqliteManager) {
			if (fromType === 'document' && toType === 'document') {
				const stmt = this.sqliteManager.getDatabase().prepare(`
					INSERT OR REPLACE INTO document_relationships
					(source_document_id, target_document_id, relationship_type, notes)
					VALUES (?, ?, ?, ?)
				`);

				stmt.run([fromId, toId, relationshipType, JSON.stringify(properties)]);
			}
		}

		// Store in Neo4j
		if (this.neo4jManager) {
			const fromLabel = this.getNodeLabel(fromType);
			const toLabel = this.getNodeLabel(toType);

			await this.neo4jManager.createRelationship(
				fromId,
				fromLabel,
				toId,
				toLabel,
				relationshipType,
				properties
			);
		}
	}

	/**
	 * Store content analysis
	 */
	async storeContentAnalysis(
		documentId: string,
		analysisType: string,
		analysisData: any
	): Promise<void> {
		if (!this.sqliteManager) return;

		const stmt = this.sqliteManager.getDatabase().prepare(`
			INSERT INTO content_analysis (document_id, analysis_type, analysis_data)
			VALUES (?, ?, ?)
		`);

		stmt.run([documentId, analysisType, JSON.stringify(analysisData)]);
	}

	/**
	 * Get content analysis history
	 */
	async getContentAnalysisHistory(
		documentId: string,
		analysisType?: string
	): Promise<
		Array<{
			id: number;
			analysisType: string;
			analysisData: unknown;
			analyzedAt: string;
		}>
	> {
		if (!this.sqliteManager) return [];

		let sql = `
			SELECT id, analysis_type, analysis_data, analyzed_at
			FROM content_analysis
			WHERE document_id = ?
		`;
		const params = [documentId];

		if (analysisType) {
			sql += ` AND analysis_type = ?`;
			params.push(analysisType);
		}

		sql += ` ORDER BY analyzed_at DESC`;

		const results = this.sqliteManager.query(sql, params) as Array<{
			id: number;
			analysis_type: string;
			analysis_data: string;
			analyzed_at: string;
		}>;

		return results.map((row) => ({
			id: row.id,
			analysisType: row.analysis_type,
			analysisData: JSON.parse(row.analysis_data),
			analyzedAt: row.analyzed_at,
		}));
	}

	/**
	 * Record writing session
	 */
	async recordWritingSession(sessionData: {
		date: string;
		wordsWritten: number;
		durationMinutes: number;
		documentsWorkedOn: string[];
		notes?: string;
	}): Promise<void> {
		if (!this.sqliteManager) return;

		const stmt = this.sqliteManager.getDatabase().prepare(`
			INSERT INTO writing_sessions
			(date, words_written, duration_minutes, documents_worked_on, notes)
			VALUES (?, ?, ?, ?, ?)
		`);

		stmt.run([
			sessionData.date,
			sessionData.wordsWritten,
			sessionData.durationMinutes,
			JSON.stringify(sessionData.documentsWorkedOn),
			sessionData.notes || null,
		]);
	}

	/**
	 * Get writing statistics
	 */
	async getWritingStatistics(days = 30): Promise<{
		totalWords: number;
		totalSessions: number;
		averageWordsPerSession: number;
		dailyStats: Array<{
			date: string;
			words: number;
			sessions: number;
			duration: number;
		}>;
	}> {
		if (!this.sqliteManager) {
			return {
				totalWords: 0,
				totalSessions: 0,
				averageWordsPerSession: 0,
				dailyStats: [],
			};
		}

		// Get total stats
		const totalResult = this.sqliteManager.queryOne(`
			SELECT
				SUM(words_written) as total_words,
				COUNT(*) as total_sessions
			FROM writing_sessions
			WHERE date >= date('now', '-${days} days')
		`) as { total_words: number; total_sessions: number } | undefined;

		// Get daily stats
		const dailyResults = this.sqliteManager.query(`
			SELECT
				date,
				SUM(words_written) as words,
				COUNT(*) as sessions,
				SUM(duration_minutes) as duration
			FROM writing_sessions
			WHERE date >= date('now', '-${days} days')
			GROUP BY date
			ORDER BY date DESC
		`) as Array<{
			date: string;
			words: number;
			sessions: number;
			duration: number;
		}>;

		return {
			totalWords: totalResult?.total_words || 0,
			totalSessions: totalResult?.total_sessions || 0,
			averageWordsPerSession: totalResult?.total_sessions
				? Math.round((totalResult.total_words || 0) / totalResult.total_sessions)
				: 0,
			dailyStats: dailyResults,
		};
	}

	/**
	 * Get database status
	 */
	getStatus(): {
		sqlite: { enabled: boolean; connected: boolean; size?: number };
		neo4j: { enabled: boolean; connected: boolean; uri?: string };
		paths: ProjectDatabasePaths;
	} {
		const sqliteStatus: { enabled: boolean; connected: boolean; size?: number } = {
			enabled: this.config.sqlite.enabled,
			connected: this.sqliteManager !== null,
		};

		if (this.sqliteManager) {
			try {
				const stats = this.sqliteManager.getDatabaseStats();
				sqliteStatus.size = stats.size;
			} catch {
				// Ignore errors getting stats
			}
		}

		const neo4jStatus: { enabled: boolean; connected: boolean; uri?: string } = {
			enabled: this.config.neo4j.enabled,
			connected: this.neo4jManager?.isAvailable() || false,
		};

		if (this.neo4jManager) {
			const info = this.neo4jManager.getConnectionInfo();
			neo4jStatus.uri = info.uri;
		}

		return {
			sqlite: sqliteStatus,
			neo4j: neo4jStatus,
			paths: this.paths,
		};
	}

	/**
	 * Helper to get Neo4j node label from type
	 */
	private getNodeLabel(type: string): string {
		switch (type.toLowerCase()) {
			case 'document':
				return 'Document';
			case 'character':
				return 'Character';
			case 'theme':
				return 'Theme';
			case 'plot':
			case 'plotthread':
				return 'PlotThread';
			default:
				return 'Entity';
		}
	}

	/**
	 * Close database connections
	 */
	async close(): Promise<void> {
		if (this.sqliteManager) {
			this.sqliteManager.close();
			this.sqliteManager = null;
		}

		if (this.neo4jManager) {
			await this.neo4jManager.close();
			this.neo4jManager = null;
		}
	}

	/**
	 * Backup databases
	 */
	async backup(backupDir: string): Promise<void> {
		await ensureDir(backupDir);

		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

		// Backup SQLite
		if (this.sqliteManager) {
			const sqliteBackupPath = path.join(backupDir, `scrivener-${timestamp}.db`);
			this.sqliteManager.backup(sqliteBackupPath);
		}

		// Backup Neo4j config
		if (this.neo4jManager) {
			const configBackupPath = path.join(backupDir, `neo4j-config-${timestamp}.json`);
			await safeWriteFile(configBackupPath, JSON.stringify(this.config.neo4j, null, 2));
		}
	}

	/**
	 * Get graph analytics service
	 */
	getGraphAnalytics(): GraphAnalytics | null {
		return this.graphAnalytics;
	}

	/**
	 * Get search service
	 */
	getSearchService(): SearchService | null {
		return this.searchService;
	}

	/**
	 * Get migration manager
	 */
	getMigrationManager(): MigrationManager | null {
		return this.migrationManager;
	}

	/**
	 * Run relationship auto-discovery
	 */
	async discoverRelationships(): Promise<unknown> {
		if (!this.graphAnalytics) {
			throw new AppError('Graph analytics not available', ErrorCode.DATABASE_ERROR);
		}
		return this.graphAnalytics.discoverRelationships();
	}

	/**
	 * Analyze story structure
	 */
	async analyzeStoryStructure(): Promise<{
		characterNetwork: unknown;
		plotComplexity: unknown;
		storyFlow: unknown;
		narrative: unknown;
	}> {
		if (!this.graphAnalytics) {
			throw new AppError('Graph analytics not available', ErrorCode.DATABASE_ERROR);
		}

		const [characterNetwork, plotComplexity, storyFlow, narrative] = await Promise.all([
			this.graphAnalytics.analyzeCharacterNetwork(),
			this.graphAnalytics.analyzePlotComplexity(),
			this.graphAnalytics.analyzeStoryFlow(),
			this.graphAnalytics.analyzeNarrativeStructure(),
		]);

		return {
			characterNetwork,
			plotComplexity,
			storyFlow,
			narrative,
		};
	}

	/**
	 * Perform full-text search
	 */
	async search(query: string, options?: Record<string, unknown>): Promise<unknown> {
		if (!this.searchService) {
			throw new AppError('Search service not available', ErrorCode.DATABASE_ERROR);
		}
		return this.searchService.search(query, options);
	}

	/**
	 * Get writing analytics
	 */
	getWritingAnalytics(): WritingAnalytics | null {
		return this.writingAnalytics;
	}

	/**
	 * Get story intelligence
	 */
	getStoryIntelligence(): StoryIntelligence | null {
		return this.storyIntelligence;
	}

	/**
	 * Get comprehensive writing insights
	 */
	async getWritingInsights(): Promise<{
		patterns: any;
		productivity: any;
		recommendations: any;
		completion: any;
	}> {
		if (!this.writingAnalytics) {
			throw new AppError('Writing analytics not available', ErrorCode.DATABASE_ERROR);
		}

		const [patterns, productivity, recommendations, completion] = await Promise.all([
			this.writingAnalytics.analyzeWritingPatterns(),
			this.writingAnalytics.getProductivityTrends(),
			this.writingAnalytics.getWritingRecommendations(),
			this.writingAnalytics.predictProjectCompletion(80000), // Default novel length
		]);

		return { patterns, productivity, recommendations, completion };
	}

	/**
	 * Get story analysis and recommendations
	 */
	async getStoryAnalysis(): Promise<{
		plotHoles: any;
		characterArcs: any;
		pacing: any;
		recommendations: any;
		timeline: any;
	}> {
		if (!this.storyIntelligence) {
			throw new AppError('Story intelligence not available', ErrorCode.DATABASE_ERROR);
		}

		const [plotHoles, characterArcs, pacing, recommendations, timeline] = await Promise.all([
			this.storyIntelligence.detectPlotHoles(),
			this.storyIntelligence.analyzeCharacterArcs(),
			this.storyIntelligence.analyzePacing(),
			this.storyIntelligence.generateRecommendations(),
			this.storyIntelligence.buildTimeline(),
		]);

		return { plotHoles, characterArcs, pacing, recommendations, timeline };
	}

	/**
	 * Track writing session
	 */
	async trackWritingSession(wordsWritten: number, duration: number): Promise<void> {
		if (!this.sqliteManager) return;

		this.sqliteManager.execute(
			`
			INSERT INTO writing_sessions (date, words_written, duration_minutes)
			VALUES (datetime('now'), ?, ?)
		`,
			[wordsWritten, duration]
		);
	}

	/**
	 * Create document version/snapshot
	 */
	async createDocumentVersion(
		documentId: string,
		content: string,
		summary?: string
	): Promise<void> {
		if (!this.sqliteManager) return;

		const wordCount = content.split(/\s+/).length;
		const charCount = content.length;

		this.sqliteManager.execute(
			`
			INSERT INTO document_revisions
			(id, document_id, content, word_count, character_count, change_summary)
			VALUES (?, ?, ?, ?, ?, ?)
		`,
			[
				`rev-${documentId}-${Date.now()}`,
				documentId,
				content,
				wordCount,
				charCount,
				summary || 'Auto-saved version',
			]
		);
	}

	/**
	 * Clean up old transaction logs
	 */
	private cleanupTransactionLogs(): void {
		const maxAge = 24 * 60 * 60 * 1000; // 24 hours
		const now = Date.now();

		// Clean up old transaction logs from the Map
		const toDelete: string[] = [];
		this.transactionLog.forEach((log, id) => {
			const age = now - log.timestamp.getTime();
			if (age >= maxAge && log.status !== 'in_progress' && log.status !== 'prepared') {
				toDelete.push(id);
			}
		});

		toDelete.forEach((id) => this.transactionLog.delete(id));
	}
}
