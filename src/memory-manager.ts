import { existsSync } from 'fs';
import * as fs from 'fs/promises';
import { getLogger } from './core/logger.js';
import type { DatabaseService } from './handlers/database/database-service.js';
import {
	buildPath,
	ensureDir,
	pathExists,
	safeParse,
	safeReadFile,
	safeStringify,
	safeWriteFile,
} from './utils/common.js';
import { buildInsertQuery, buildSelectQuery } from './utils/database.js';

const logger = getLogger('memory-manager');

export interface ProjectMemory {
	version: string;
	lastUpdated: string;
	characters: CharacterProfile[];
	worldBuilding: WorldElement[];
	plotThreads: PlotThread[];
	styleGuide: StyleGuide;
	writingStats: WritingStatistics;
	documentContexts: Map<string, DocumentContext>;
	customContext: Record<string, unknown>;
}

export interface CharacterProfile {
	id: string;
	name: string;
	role: 'protagonist' | 'antagonist' | 'supporting' | 'minor';
	description: string;
	traits: string[];
	arc: string;
	relationships: { characterId: string; relationship: string }[];
	appearances: { documentId: string; context: string }[];
	notes: string;
}

export interface WorldElement {
	id: string;
	name: string;
	type: 'location' | 'object' | 'concept' | 'organization';
	description: string;
	significance: string;
	appearances: { documentId: string; context: string }[];
}

export interface PlotThread {
	id: string;
	name: string;
	description: string;
	status: 'setup' | 'development' | 'climax' | 'resolution';
	documents: string[];
	keyEvents: { documentId: string; event: string }[];
}

export interface StyleGuide {
	tone: string[];
	voice: string;
	pov: 'first' | 'second' | 'third-limited' | 'third-omniscient';
	tense: 'past' | 'present' | 'future';
	vocabularyLevel: 'simple' | 'moderate' | 'advanced' | 'literary';
	sentenceComplexity: 'simple' | 'varied' | 'complex';
	paragraphLength: 'short' | 'medium' | 'long' | 'varied';
	customGuidelines: string[];
}

export interface WritingStatistics {
	totalWords: number;
	averageChapterLength: number;
	sessionsCount: number;
	lastSession: string;
	dailyWordCounts: { date: string; count: number }[];
	completionPercentage: number;
	estimatedCompletionDate?: string;
}

export interface DocumentContext {
	documentId: string;
	lastAnalyzed: string;
	summary: string;
	themes: string[];
	sentiment: 'positive' | 'negative' | 'neutral' | 'mixed';
	pacing: 'slow' | 'moderate' | 'fast';
	keyElements: string[];
	suggestions: string[];
	continuityNotes: string[];
}

export class MemoryManager {
	private memoryPath: string;
	private memory: ProjectMemory;
	private autoSaveInterval?: NodeJS.Timeout;
	private databaseService?: DatabaseService;

	constructor(projectPath: string, databaseService?: DatabaseService) {
		// Store memory in a hidden folder within the Scrivener project
		this.memoryPath = buildPath(projectPath, '.ai-memory');
		this.memory = this.createEmptyMemory();
		this.databaseService = databaseService;
	}

	private createEmptyMemory(): ProjectMemory {
		return {
			version: '1.0.0',
			lastUpdated: new Date().toISOString(),
			characters: [],
			worldBuilding: [],
			plotThreads: [],
			styleGuide: {
				tone: [],
				voice: '',
				pov: 'third-limited',
				tense: 'past',
				vocabularyLevel: 'moderate',
				sentenceComplexity: 'varied',
				paragraphLength: 'varied',
				customGuidelines: [],
			},
			writingStats: {
				totalWords: 0,
				averageChapterLength: 0,
				sessionsCount: 0,
				lastSession: new Date().toISOString(),
				dailyWordCounts: [],
				completionPercentage: 0,
			},
			documentContexts: new Map(),
			customContext: {},
		};
	}

	async initialize(): Promise<void> {
		// Initialize database if provided
		if (this.databaseService && !this.databaseService.isInitialized()) {
			await this.databaseService.initialize();
		}

		// Try to load from database first if available
		if (this.databaseService) {
			await this.loadFromDatabase();
		}

		// Create memory directory if it doesn't exist
		await ensureDir(this.memoryPath);

		// Load existing memory or create new from file as fallback
		const memoryFile = buildPath(this.memoryPath, 'project-memory.json');
		if (await pathExists(memoryFile)) {
			await this.loadMemory();
		} else {
			await this.saveMemory();
		}

		// Set up auto-save every 5 minutes
		this.autoSaveInterval = setInterval(
			() => {
				this.saveMemory().catch((err) => logger.error('Auto-save failed', { error: err }));
			},
			5 * 60 * 1000
		);
	}

	async loadMemory(): Promise<void> {
		try {
			const memoryFile = buildPath(this.memoryPath, 'project-memory.json');
			const data = await safeReadFile(memoryFile);
			const loaded = safeParse(data, {}) as Partial<ProjectMemory> & Record<string, unknown>;

			// Initialize with proper ProjectMemory structure
			const memory: ProjectMemory = {
				version: loaded.version || '1.0.0',
				lastUpdated: loaded.lastUpdated || new Date().toISOString(),
				characters: loaded.characters || [],
				worldBuilding: loaded.worldBuilding || [],
				plotThreads: loaded.plotThreads || [],
				styleGuide: loaded.styleGuide || {
					tone: [],
					voice: '',
					pov: 'third-limited',
					tense: 'past',
					vocabularyLevel: 'moderate',
					sentenceComplexity: 'varied',
					paragraphLength: 'medium',
					customGuidelines: [],
				},
				writingStats: loaded.writingStats || {
					totalWords: 0,
					averageChapterLength: 0,
					sessionsCount: 0,
					lastSession: new Date().toISOString(),
					dailyWordCounts: [],
					completionPercentage: 0,
				},
				documentContexts: new Map(),
				customContext: loaded.customContext || {},
			};

			// Convert documentContexts back to Map
			if (loaded.documentContexts && Array.isArray(loaded.documentContexts)) {
				memory.documentContexts = new Map(loaded.documentContexts);
			}

			this.memory = memory;
		} catch (error) {
			logger.error('Failed to load memory', { error });
			this.memory = this.createEmptyMemory();
		}
	}

	async saveMemory(): Promise<void> {
		try {
			// Save to database if available
			if (this.databaseService) {
				await this.saveToDatabase();
			}

			const memoryFile = buildPath(this.memoryPath, 'project-memory.json');

			// Convert Map to array for JSON serialization
			const toSave = {
				...this.memory,
				documentContexts: Array.from(this.memory.documentContexts.entries()),
				lastUpdated: new Date().toISOString(),
			};

			await safeWriteFile(memoryFile, safeStringify(toSave));

			// Also save a backup
			try {
				const backupFile = buildPath(
					this.memoryPath,
					`backup-${new Date().toISOString().split('T')[0]}.json`
				);
				// Ensure directory still exists before writing backup
				await ensureDir(this.memoryPath);
				await safeWriteFile(backupFile, safeStringify(toSave));
			} catch (backupError) {
				logger.warn('Failed to save backup file', { error: backupError });
				// Don't throw - backup failure shouldn't break the main save
			}

			// Clean up old backups (keep last 7)
			await this.cleanupOldBackups();
		} catch (error) {
			logger.error('Failed to save memory', { error });
			throw error;
		}
	}

	private async cleanupOldBackups(): Promise<void> {
		try {
			if (!existsSync(this.memoryPath)) {
				return; // Directory doesn't exist, nothing to clean up
			}
			const files = await fs.readdir(this.memoryPath);
			const backups = files
				.filter((f) => f.startsWith('backup-'))
				.sort()
				.reverse();

			if (backups.length > 7) {
				for (const backup of backups.slice(7)) {
					await fs.unlink(buildPath(this.memoryPath, backup));
				}
			}
		} catch (error) {
			logger.error('Failed to cleanup backups', { error });
		}
	}

	// Character management
	addCharacter(character: Omit<CharacterProfile, 'id'>): CharacterProfile {
		const newCharacter: CharacterProfile = {
			id: this.generateId(),
			...character,
		};
		this.memory.characters.push(newCharacter);
		return newCharacter;
	}

	updateCharacter(id: string, updates: Partial<CharacterProfile>): void {
		const index = this.memory.characters.findIndex((c) => c.id === id);
		if (index !== -1) {
			this.memory.characters[index] = {
				...this.memory.characters[index],
				...updates,
			};
		}
	}

	getCharacter(id: string): CharacterProfile | undefined {
		return this.memory.characters.find((c) => c.id === id);
	}

	getAllCharacters(): CharacterProfile[] {
		return this.memory.characters;
	}

	// Document context management
	setDocumentContext(
		documentId: string,
		context: Omit<DocumentContext, 'documentId' | 'lastAnalyzed'>
	): void {
		this.memory.documentContexts.set(documentId, {
			documentId,
			lastAnalyzed: new Date().toISOString(),
			...context,
		});
	}

	getDocumentContext(documentId: string): DocumentContext | undefined {
		return this.memory.documentContexts.get(documentId);
	}

	// Style guide management
	updateStyleGuide(updates: Partial<StyleGuide>): void {
		this.memory.styleGuide = {
			...this.memory.styleGuide,
			...updates,
		};
	}

	getStyleGuide(): StyleGuide {
		return this.memory.styleGuide;
	}

	// Plot thread management
	addPlotThread(thread: Omit<PlotThread, 'id'>): PlotThread {
		const newThread: PlotThread = {
			id: this.generateId(),
			...thread,
		};
		this.memory.plotThreads.push(newThread);
		return newThread;
	}

	updatePlotThread(id: string, updates: Partial<PlotThread>): void {
		const index = this.memory.plotThreads.findIndex((t) => t.id === id);
		if (index !== -1) {
			this.memory.plotThreads[index] = {
				...this.memory.plotThreads[index],
				...updates,
			};
		}
	}

	getPlotThreads(): PlotThread[] {
		return this.memory.plotThreads;
	}

	// Writing statistics
	updateWritingStats(updates: Partial<WritingStatistics>): void {
		this.memory.writingStats = {
			...this.memory.writingStats,
			...updates,
		};
	}

	getWritingStats(): WritingStatistics {
		return this.memory.writingStats;
	}

	// Custom context for flexibility
	setCustomContext(key: string, value: unknown): void {
		this.memory.customContext[key] = value;
	}

	getCustomContext(key: string): unknown {
		return this.memory.customContext[key];
	}

	// Get full memory for export or analysis
	getFullMemory(): ProjectMemory {
		return this.memory;
	}

	// Import memory from another source
	async importMemory(memory: ProjectMemory): Promise<void> {
		this.memory = memory;
		await this.saveMemory();
	}

	// Stop auto-save interval
	async stopAutoSave(): Promise<void> {
		if (this.autoSaveInterval) {
			clearInterval(this.autoSaveInterval);
			this.autoSaveInterval = undefined;
		}
		// Save one final time
		await this.saveMemory();
	}

	// Cleanup when done
	cleanup(): void {
		if (this.autoSaveInterval) {
			clearInterval(this.autoSaveInterval);
		}
		this.saveMemory().catch((err) => logger.error('Cleanup save failed', { error: err }));
	}

	private generateId(): string {
		return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
	}

	/**
	 * Load memory data from database
	 */
	private async loadFromDatabase(): Promise<void> {
		if (!this.databaseService || !this.databaseService.getSQLite()) {
			return;
		}

		try {
			const db = this.databaseService.getSQLite()!.getDatabase();

			// Load characters from database
			const { sql: charSql } = buildSelectQuery('characters');
			const characters = db.prepare(charSql).all() as Record<string, unknown>[];
			this.memory.characters = characters.map((c) => ({
				id: String(c.id),
				name: String(c.name),
				role: String(c.role || 'supporting') as
					| 'protagonist'
					| 'antagonist'
					| 'supporting'
					| 'minor',
				description: String(c.description || ''),
				traits: c.traits ? safeParse(String(c.traits), []) : [],
				arc: String(c.arc || ''),
				relationships: c.relationships ? safeParse(String(c.relationships), []) : [],
				appearances: c.appearances ? safeParse(String(c.appearances), []) : [],
				notes: String(c.notes || ''),
			}));

			// Load plot threads
			const { sql: plotSql } = buildSelectQuery('plot_threads');
			const plotThreads = db.prepare(plotSql).all() as Record<string, unknown>[];
			this.memory.plotThreads = plotThreads.map((p) => ({
				id: String(p.id),
				name: String(p.name),
				status: String(p.status || 'development') as
					| 'setup'
					| 'development'
					| 'climax'
					| 'resolution',
				description: String(p.description || ''),
				documents: p.related_documents ? safeParse(String(p.related_documents), []) : [],
				keyEvents: p.developments
					? safeParse(String(p.developments), []).map((d: Record<string, unknown>) => ({
							documentId: String(d.documentId || ''),
							event: String(d.event || d),
						}))
					: [],
			}));

			// Load project metadata for style guide and custom context
			const { sql: metaSql } = buildSelectQuery('project_metadata');
			const metadata = db.prepare(metaSql).all() as Record<string, unknown>[];
			metadata.forEach((m) => {
				const key = String(m.key);
				const value = m.value ? String(m.value) : null;
				if (key === 'style_guide' && value) {
					this.memory.styleGuide = safeParse(value, {} as StyleGuide);
				} else if (key === 'writing_stats' && value) {
					this.memory.writingStats = safeParse(value, {} as WritingStatistics);
				} else if (key.startsWith('custom_')) {
					const customKey = key.replace('custom_', '');
					this.memory.customContext[customKey] = safeParse(value || '{}', {});
				}
			});

			// Load world building elements
			const worldElements = db
				.prepare(
					`
				SELECT * FROM themes
				UNION ALL
				SELECT id, name, 'location' as type, description FROM locations
			`
				)
				.all() as Record<string, unknown>[];

			this.memory.worldBuilding = worldElements.map((w) => ({
				id: String(w.id),
				type: String(w.type || 'location') as
					| 'object'
					| 'location'
					| 'concept'
					| 'organization',
				name: String(w.name),
				description: String(w.description || ''),
				details: w.details ? safeParse(String(w.details), {}) : {},
				significance: String(w.significance || 'minor'),
				appearances: w.appearances ? safeParse(String(w.appearances), []) : [],
			}));
		} catch (error) {
			logger.error('Failed to load from database', { error });
		}
	}

	/**
	 * Save memory data to database
	 */
	private async saveToDatabase(): Promise<void> {
		if (!this.databaseService || !this.databaseService.getSQLite()) {
			return;
		}

		try {
			const db = this.databaseService.getSQLite()!.getDatabase();

			// Save characters
			for (const char of this.memory.characters) {
				const { sql, params } = buildInsertQuery(
					'characters',
					{
						id: char.id,
						name: char.name,
						role: char.role,
						description: char.description,
						traits: safeStringify(char.traits),
						arc: char.arc,
						relationships: safeStringify(char.relationships),
						appearances: safeStringify(char.appearances),
						notes: char.notes || '',
					},
					'REPLACE'
				);
				db.prepare(sql).run(...params);
			}

			// Save plot threads
			for (const plot of this.memory.plotThreads) {
				const { sql, params } = buildInsertQuery(
					'plot_threads',
					{
						id: plot.id,
						name: plot.name,
						status: plot.status,
						description: plot.description,
						developments: safeStringify(plot.keyEvents),
						related_documents: safeStringify(plot.documents),
					},
					'REPLACE'
				);
				db.prepare(sql).run(...params);
			}

			// Save project metadata
			const metadataItems = [
				{ key: 'style_guide', value: safeStringify(this.memory.styleGuide) },
				{ key: 'writing_stats', value: safeStringify(this.memory.writingStats) },
			];

			// Add custom context items
			for (const [key, value] of Object.entries(this.memory.customContext)) {
				metadataItems.push({ key: `custom_${key}`, value: safeStringify(value) });
			}

			// Save all metadata
			for (const item of metadataItems) {
				const { sql, params } = buildInsertQuery(
					'project_metadata',
					{
						key: item.key,
						value: item.value,
						updated_at: new Date().toISOString(),
					},
					'REPLACE'
				);
				db.prepare(sql).run(...params);
			}

			// Sync to Neo4j if available
			if (this.databaseService.getNeo4j()?.isAvailable()) {
				await this.syncToNeo4j();
			}
		} catch (error) {
			logger.error('Failed to save to database', { error });
		}
	}

	/**
	 * Sync memory data to Neo4j for relationship analysis
	 */
	private async syncToNeo4j(): Promise<void> {
		if (!this.databaseService || !this.databaseService.getNeo4j()?.isAvailable()) {
			return;
		}

		const neo4j = this.databaseService.getNeo4j()!;

		// Sync characters and their relationships
		for (const char of this.memory.characters) {
			await neo4j.query(
				`
				MERGE (c:Character {id: $id})
				SET c.name = $name, c.role = $role, c.description = $description
			`,
				{
					id: char.id,
					name: char.name,
					role: char.role,
					description: char.description,
				}
			);

			// Create character relationships
			for (const rel of char.relationships) {
				await neo4j.query(
					`
					MATCH (c1:Character {id: $id1})
					MATCH (c2:Character {id: $id2})
					MERGE (c1)-[r:RELATES_TO]->(c2)
					SET r.relationship = $relationship
				`,
					{
						id1: char.id,
						id2: rel.characterId,
						relationship: rel.relationship,
					}
				);
			}
		}

		// Sync plot threads
		for (const plot of this.memory.plotThreads) {
			await neo4j.query(
				`
				MERGE (p:PlotThread {id: $id})
				SET p.name = $name, p.status = $status, p.description = $description
			`,
				{
					id: plot.id,
					name: plot.name,
					status: plot.status,
					description: plot.description,
				}
			);

			// Connect plot threads to documents
			for (const docId of plot.documents) {
				await neo4j.query(
					`
					MATCH (p:PlotThread {id: $plotId})
					MATCH (d:Document {id: $docId})
					MERGE (p)-[:OCCURS_IN]->(d)
				`,
					{
						plotId: plot.id,
						docId,
					}
				);
			}
		}
	}
}
