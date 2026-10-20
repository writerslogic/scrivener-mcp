import * as path from 'path';
import { AppError, ErrorCode } from '../../utils/common.js';
import { getLogger } from '../../core/logger.js';
import {
	buildPath,
	ensureDir,
	pathExists,
	safeParse,
	safeReadFile,
	safeStringify,
	safeWriteFile,
} from '../../utils/common.js';
import { RelationshipEngine } from '../../services/relationship-engine.js';
import type { HolographicMemorySystem } from '../../services/memory/hhm/holographic-memory-system.js';
import { Neo4jAutoInstaller } from './auto-installer.js';
import type { DatabaseConfig, ProjectDatabasePaths } from './config.js';
import { DEFAULT_DATABASE_CONFIG, generateDatabasePaths } from './config.js';
import { DatabaseSetup } from './database-setup.js';
import { GraphAnalytics } from './graph-analytics.js';
import { MigrationManager } from './migrations.js';
import { Neo4jManager } from './neo4j-manager.js';

import { SearchService } from './search-service.js';
import { SQLiteManager } from './sqlite-manager.js';
import type {
	CharacterArcIssue,
	PacingIssue,
	PlotHole,
	StoryRecommendation,
	TimelineEvent,
} from './story-intelligence.js';
import { StoryIntelligence } from './story-intelligence.js';
import type { ProductivityTrend, WritingPattern } from './writing-analytics.js';
import { WritingAnalytics } from './writing-analytics.js';
import type {
	FeedbackInput,
	FeedbackRecord,
	WritingPreferences,
} from '../../services/personalization/types.js';
import type { WritingGoalInput, WritingGoalRecord } from './user-data.js';
import {
	getFeedbackRecords,
	getWritingGoals,
	getWritingPreferences,
	recordFeedback,
	saveWritingPreferences,
	setWritingGoal,
} from './user-data.js';
import type {
	ContentAnalysisEntry,
	WritingSessionInput,
	WritingStatistics,
} from './session-analytics.js';
import {
	createDocumentVersion,
	getContentAnalysisHistory,
	getWritingStatistics,
	recordWritingSession,
	storeContentAnalysis,
	trackWritingSession,
} from './session-analytics.js';
import { TransactionCoordinator } from './transaction-coordinator.js';
import { DatabaseSync } from './database-sync.js';

const logger = getLogger('database');

export type { WritingGoalRecord } from './user-data.js';

export class DatabaseService {
	private sync: DatabaseSync;
	private sqliteManager: SQLiteManager | null = null;
	private neo4jManager: Neo4jManager | null = null;
	private config: DatabaseConfig;
	private paths: ProjectDatabasePaths;
	private transactions = new TransactionCoordinator(() => this.sqliteManager);
	private initialized: boolean = false;
	private graphAnalytics: GraphAnalytics | null = null;
	private migrationManager: MigrationManager | null = null;
	private searchService: SearchService | null = null;
	private writingAnalytics: WritingAnalytics | null = null;
	private storyIntelligence: StoryIntelligence | null = null;
	private relationshipEngine: RelationshipEngine | null = null;

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

		this.sync = new DatabaseSync(
			() => this.sqliteManager,
			() => this.neo4jManager,
			() => this.relationshipEngine,
			this.transactions
		);
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

		await safeWriteFile(
			this.paths.configFile,
			safeStringify(configData) || JSON.stringify(configData, null, 2)
		);
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
			const configData = safeParse(await safeReadFile(paths.configFile), null);
			if (!configData || typeof configData !== 'object') {
				return null;
			}

			// Convert relative path back to absolute
			const config = configData as DatabaseConfig;
			if (config.sqlite?.path && !path.isAbsolute(config.sqlite.path)) {
				config.sqlite.path = buildPath(paths.databaseDir, config.sqlite.path);
			}

			return config;
		} catch (error) {
			logger.error('Failed to load database config', { error: (error as Error).message });
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
		return this.transactions.begin();
	}

	/**
	 * Prepare phase of two-phase commit
	 */
	async prepareTransaction(transactionId: string): Promise<boolean> {
		return this.transactions.prepare(transactionId);
	}

	/**
	 * Commit phase of two-phase commit
	 */
	async commitTransaction(transactionId: string): Promise<void> {
		return this.transactions.commit(transactionId);
	}

	/**
	 * Rollback a transaction
	 */
	async rollbackTransaction(transactionId: string): Promise<void> {
		return this.transactions.rollback(transactionId);
	}

	/**
	 * Sync document data with two-phase commit
	 */
	async syncDocumentData(documentData: {
		id: string;
		title: string;
		type: string;
		path: string;
		synopsis?: string;
		notes?: string;
		wordCount?: number;
		characterCount?: number;
	}): Promise<void> {
		return this.sync.syncDocumentData(documentData);
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
		return this.sync.syncCharacterData(characterData);
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
		return this.sync.createRelationship(
			fromId,
			fromType,
			toId,
			toType,
			relationshipType,
			properties
		);
	}

	/**
	 * Store content analysis
	 */
	async storeContentAnalysis(
		documentId: string,
		analysisType: string,
		analysisData: unknown
	): Promise<void> {
		storeContentAnalysis(this.sqliteManager, documentId, analysisType, analysisData);
	}

	/**
	 * Get content analysis history
	 */
	async getContentAnalysisHistory(
		documentId: string,
		analysisType?: string
	): Promise<ContentAnalysisEntry[]> {
		return getContentAnalysisHistory(this.sqliteManager, documentId, analysisType);
	}

	/**
	 * Record writing session
	 */
	async recordWritingSession(sessionData: WritingSessionInput): Promise<void> {
		recordWritingSession(this.sqliteManager, sessionData);
	}

	/**
	 * Get writing statistics
	 */
	async getWritingStatistics(days = 30): Promise<WritingStatistics> {
		return getWritingStatistics(this.sqliteManager, days);
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
			const sqliteBackupPath = buildPath(backupDir, `scrivener-${timestamp}.db`);
			this.sqliteManager.backup(sqliteBackupPath);
		}

		// Backup Neo4j config
		if (this.neo4jManager) {
			const configBackupPath = buildPath(backupDir, `neo4j-config-${timestamp}.json`);
			await safeWriteFile(
				configBackupPath,
				safeStringify(this.config.neo4j) || JSON.stringify(this.config.neo4j, null, 2)
			);
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
	 * Set the HMS instance and create the RelationshipEngine
	 */
	setHMS(hms: HolographicMemorySystem): void {
		this.relationshipEngine = new RelationshipEngine(hms, this.neo4jManager);
	}

	/**
	 * Get relationship engine
	 */
	getRelationshipEngine(): RelationshipEngine | null {
		return this.relationshipEngine;
	}

	/**
	 * Get comprehensive writing insights
	 */
	async getWritingInsights(): Promise<{
		patterns: WritingPattern;
		productivity: ProductivityTrend[];
		recommendations: {
			immediate: string[];
			shortTerm: string[];
			longTerm: string[];
			exercises: Array<{ title: string; description: string; benefit: string }>;
		};
		completion: {
			currentWords: number;
			targetWords: number;
			percentComplete: number;
			estimatedCompletionDate: string;
			recommendedDailyWords: number;
			onTrack: boolean;
		};
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
		plotHoles: PlotHole[];
		characterArcs: CharacterArcIssue[];
		pacing: PacingIssue[];
		recommendations: StoryRecommendation[];
		timeline: TimelineEvent[];
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
		trackWritingSession(this.sqliteManager, wordsWritten, duration);
	}

	/**
	 * Create document version/snapshot
	 */
	async createDocumentVersion(
		documentId: string,
		content: string,
		summary?: string
	): Promise<void> {
		createDocumentVersion(this.sqliteManager, documentId, content, summary);
	}

	/**
	 * Create or update the active writing goal of the given type.
	 *
	 * At most one goal per type is kept active: if an active goal of `input.type`
	 * already exists it is updated in place, otherwise a new goal is inserted.
	 * The returned record reflects the stored row (camelCase fields).
	 */
	async setWritingGoal(input: WritingGoalInput): Promise<WritingGoalRecord> {
		return setWritingGoal(this.sqliteManager, input);
	}

	/**
	 * List writing goals, most recent first. Pass `status` to filter
	 * (e.g. 'active'); omit it to return goals of every status.
	 */
	async getWritingGoals(status?: string): Promise<WritingGoalRecord[]> {
		return getWritingGoals(this.sqliteManager, status);
	}

	/**
	 * Read the single per-project writing-preferences profile. Returns the
	 * defaults when none has been saved yet.
	 */
	async getWritingPreferences(): Promise<WritingPreferences> {
		return getWritingPreferences(this.sqliteManager);
	}

	/**
	 * Upsert the single writing-preferences profile. Callers pass a fully
	 * resolved profile (merge partial updates before calling).
	 */
	async saveWritingPreferences(prefs: WritingPreferences): Promise<WritingPreferences> {
		return saveWritingPreferences(this.sqliteManager, prefs);
	}

	/** Record one feedback event for an AI operation. */
	async recordFeedback(input: FeedbackInput): Promise<FeedbackRecord> {
		return recordFeedback(this.sqliteManager, input);
	}

	/** Return recorded feedback, most recent first. */
	async getFeedbackRecords(limit = 500): Promise<FeedbackRecord[]> {
		return getFeedbackRecords(this.sqliteManager, limit);
	}
}
