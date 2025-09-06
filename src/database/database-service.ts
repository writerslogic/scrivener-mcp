import * as fs from 'fs';
import * as path from 'path';
import {
	AppError,
	ErrorCode,
	safeReadFile,
	safeWriteFile,
	ensureDir,
	pathExists,
} from '../utils/common.js';
import { SQLiteManager } from './sqlite-manager.js';
import { Neo4jManager } from './neo4j-manager.js';
import type { DatabaseConfig, ProjectDatabasePaths } from './config.js';
import { generateDatabasePaths, DEFAULT_DATABASE_CONFIG } from './config.js';

export class DatabaseService {
	private sqliteManager: SQLiteManager | null = null;
	private neo4jManager: Neo4jManager | null = null;
	private config: DatabaseConfig;
	private paths: ProjectDatabasePaths;

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
		// Ensure database directory exists
		await ensureDir(this.paths.databaseDir);

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
		}
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
	 * Sync document data between SQLite and Neo4j
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
		// Always update SQLite
		if (this.sqliteManager) {
			const stmt = this.sqliteManager.getDatabase().prepare(`
				INSERT OR REPLACE INTO documents 
				(id, title, type, synopsis, notes, word_count, character_count, modified_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
			`);

			stmt.run([
				documentData.id,
				documentData.title,
				documentData.type,
				documentData.synopsis || null,
				documentData.notes || null,
				documentData.wordCount || 0,
				documentData.characterCount || 0,
			]);
		}

		// Update Neo4j if available
		if (this.neo4jManager) {
			await this.neo4jManager.upsertDocument(documentData);
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
			const stmt = this.sqliteManager.getDatabase().prepare(`
				INSERT OR REPLACE INTO characters 
				(id, name, role, description, traits, notes, modified_at)
				VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
			`);

			stmt.run([
				characterData.id,
				characterData.name,
				characterData.role || null,
				characterData.description || null,
				JSON.stringify(characterData.traits || []),
				characterData.notes || null,
			]);
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
		properties: any = {}
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
			analysisData: any;
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
		`) as { total_words: number; total_sessions: number };

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
			totalWords: totalResult.total_words || 0,
			totalSessions: totalResult.total_sessions || 0,
			averageWordsPerSession: totalResult.total_sessions
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
		if (!fs.existsSync(backupDir)) {
			fs.mkdirSync(backupDir, { recursive: true });
		}

		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

		// Backup SQLite
		if (this.sqliteManager) {
			const sqliteBackupPath = path.join(backupDir, `scrivener-${timestamp}.db`);
			this.sqliteManager.backup(sqliteBackupPath);
		}

		// Backup Neo4j config
		if (this.neo4jManager) {
			const configBackupPath = path.join(backupDir, `neo4j-config-${timestamp}.json`);
			fs.writeFileSync(configBackupPath, JSON.stringify(this.config.neo4j, null, 2), 'utf-8');
		}
	}
}
