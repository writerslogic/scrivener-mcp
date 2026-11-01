import { constants, existsSync } from 'fs';
import * as fs from 'fs/promises';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { getLogger } from './core/logger.js';
import { generateScrivenerUUID } from './utils/scrivener-utils.js';
import type { DatabaseService } from './handlers/database/database-service.js';
import { AppError, ErrorCode, buildPath, ensureDir, safeWriteFile } from './utils/common.js';
import {
	readMemoryDatabase,
	mirrorMemoryDatabase,
} from './services/memory/project-memory-database.js';
import { analysisDigest } from './services/editorial/analysis-envelope.js';
import {
	MAX_PROJECT_MEMORY_BYTES,
	memoryInput,
	type MemoryRecord,
	type MemoryType,
} from './services/memory/project-memory-contract.js';
import { cloneHMSMetadata } from './services/memory/hhm/document-index.js';
import { PersistentStore } from './services/editorial/persistent-store.js';
import {
	documentRevision,
	operationOwnerState,
} from './services/editorial/mutation-coordinator.js';

const logger = getLogger('memory-manager');
const activeOwners = new Set<string>();
const BACKUP_NAME = /^backup-\d{4}-\d{2}-\d{2}\.json$/;

export interface ProjectMemory {
	version: string;
	lastUpdated: string;
	characters: CharacterProfile[];
	worldBuilding: WorldElement[];
	plotThreads: PlotThread[];
	styleGuide: Partial<StyleGuide>;
	writingStats: Partial<WritingStatistics>;
	documentContexts: Map<string, DocumentContext>;
	customContext: Record<string, unknown>;
}

export interface CharacterProfile {
	id: string;
	name: string;
	role?: string;
	description?: string;
	traits?: string[];
	arc?: string;
	relationships?: { characterId: string; relationship: string }[];
	appearances?: { documentId: string; context: string }[];
	notes?: string;
}

export interface WorldElement {
	id: string;
	name: string;
	type?: 'location' | 'object' | 'concept' | 'organization' | 'theme';
	description?: string;
	significance?: string;
	appearances?: { documentId: string; context: string }[];
}

export interface PlotThread {
	id: string;
	name: string;
	description?: string;
	status?: string;
	documents?: string[];
	keyEvents?: { documentId: string; event: string }[];
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
	genre?: string;
	audience?: string;
	styleNotes?: string[];
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
	private saveTail: Promise<void> = Promise.resolve();
	private initialized = false;
	private closing = false;
	private pendingWrites = 0;
	private persistedRevision?: string;
	private fileRevision: string | null = null;
	private owner?: { store: PersistentStore; token: string };
	private opening?: Promise<void>;
	private closePromise?: Promise<void>;

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
			styleGuide: {},
			writingStats: {},
			documentContexts: new Map(),
			customContext: {},
		};
	}

	async initialize(): Promise<void> {
		if (this.closing) throw new Error('Project memory is closed');
		if (this.initialized) return;
		if (!this.opening)
			this.opening = this.openMemory().catch((error) => {
				this.opening = undefined;
				try {
					this.releaseOwnership();
				} catch (cleanupError) {
					throw new AggregateError(
						[error, cleanupError],
						'Project memory initialization and ownership cleanup failed',
						{ cause: cleanupError }
					);
				}
				throw error;
			});
		return this.opening;
	}

	private async openMemory(): Promise<void> {
		if (this.databaseService && !this.databaseService.isInitialized()) {
			await this.databaseService.initialize();
		}

		await ensureDir(this.memoryPath);
		await this.checkMemoryDirectory();
		this.memoryPath = await fs.realpath(this.memoryPath);
		this.acquireOwnership();

		// Load existing memory or create new from file as fallback
		try {
			await this.loadMemory();
		} catch (error) {
			if (!(error instanceof AppError) || error.code !== ErrorCode.NOT_FOUND) throw error;
			if ((await fs.readdir(this.memoryPath)).some((file) => BACKUP_NAME.test(file)))
				throw new Error(
					'Project memory primary is missing but backups exist; restore a verified backup before opening',
					{ cause: error }
				);
			if (this.databaseService) await this.loadFromDatabase();
			await this.saveMemory();
		}
		this.initialized = true;

		this.autoSaveInterval = setInterval(
			() => {
				this.saveMemory().catch((err) => logger.error('Auto-save failed', { error: err }));
			},
			5 * 60 * 1000
		);
	}

	private async loadMemory(): Promise<void> {
		try {
			const memoryFile = buildPath(this.memoryPath, 'project-memory.json');
			const data = await this.readMemoryFile(memoryFile);
			this.memory = this.decodeMemory(data);
			this.persistedRevision = this.memoryRevision();
			this.fileRevision = documentRevision(data);
		} catch (error) {
			if (!(error instanceof AppError) || error.code !== ErrorCode.NOT_FOUND) {
				logger.error('Failed to load memory', { error });
			}
			throw error;
		}
	}

	private decodeMemory(data: string): ProjectMemory {
		if (Buffer.byteLength(data) > MAX_PROJECT_MEMORY_BYTES)
			throw new Error('Project memory exceeds 16 MiB');
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			throw new Error('Invalid project memory file');
		}
		if (
			!parsed ||
			typeof parsed !== 'object' ||
			Array.isArray(parsed) ||
			parsed instanceof Map ||
			parsed instanceof Set
		) {
			throw new Error('Invalid project memory file');
		}
		const loaded = parsed as Partial<ProjectMemory>;
		for (const field of ['version', 'lastUpdated'] as const) {
			if (loaded[field] !== undefined && typeof loaded[field] !== 'string') {
				throw new Error(`Invalid project memory field: ${field}`);
			}
		}
		for (const field of ['characters', 'worldBuilding', 'plotThreads'] as const) {
			if (loaded[field] !== undefined && !Array.isArray(loaded[field])) {
				throw new Error(`Invalid project memory field: ${field}`);
			}
			const ids = new Set<string>();
			for (const record of loaded[field] ?? []) {
				if (
					!record ||
					typeof record !== 'object' ||
					Array.isArray(record) ||
					typeof record.id !== 'string' ||
					!record.id ||
					typeof record.name !== 'string' ||
					!record.name.trim() ||
					ids.has(record.id)
				)
					throw new Error(`Invalid project memory record: ${field}`);
				ids.add(record.id);
				const entry = record as unknown as Record<string, unknown>;
				for (const name of [
					'role',
					'type',
					'status',
					'description',
					'arc',
					'notes',
					'significance',
				])
					if (entry[name] !== undefined && typeof entry[name] !== 'string')
						throw new Error(`Invalid project memory field: ${field}.${name}`);
				for (const name of [
					'traits',
					'relationships',
					'appearances',
					'documents',
					'keyEvents',
				])
					if (entry[name] !== undefined && !Array.isArray(entry[name]))
						throw new Error(`Invalid project memory field: ${field}.${name}`);
			}
		}
		for (const field of ['styleGuide', 'writingStats', 'customContext'] as const) {
			const value = loaded[field];
			if (
				value !== undefined &&
				(!value ||
					typeof value !== 'object' ||
					Array.isArray(value) ||
					value instanceof Map ||
					value instanceof Set)
			) {
				throw new Error(`Invalid project memory field: ${field}`);
			}
		}
		let contexts: unknown = loaded.documentContexts;
		if (
			contexts &&
			typeof contexts === 'object' &&
			!Array.isArray(contexts) &&
			(contexts as Record<string, unknown>).__type === 'Map'
		)
			contexts = (contexts as Record<string, unknown>).value;
		if (contexts !== undefined && !Array.isArray(contexts) && !(contexts instanceof Map)) {
			throw new Error('Invalid project memory field: documentContexts');
		}
		const contextEntries = contexts instanceof Map ? Array.from(contexts) : contexts;
		if (
			Array.isArray(contextEntries) &&
			contextEntries.some(
				(entry) =>
					!Array.isArray(entry) ||
					entry.length !== 2 ||
					typeof entry[0] !== 'string' ||
					!entry[1] ||
					typeof entry[1] !== 'object' ||
					Array.isArray(entry[1])
			)
		) {
			throw new Error('Invalid project memory field: documentContexts');
		}

		const memory: ProjectMemory = {
			...loaded,
			version: loaded.version || '1.0.0',
			lastUpdated: loaded.lastUpdated || new Date().toISOString(),
			characters: loaded.characters || [],
			worldBuilding: loaded.worldBuilding || [],
			plotThreads: loaded.plotThreads || [],
			styleGuide: loaded.styleGuide || {},
			writingStats: loaded.writingStats || {},
			documentContexts: new Map(),
			customContext: loaded.customContext || {},
		};

		if (Array.isArray(contextEntries)) {
			memory.documentContexts = new Map(contextEntries);
		}

		return this.snapshotMemory(memory);
	}

	saveMemory(): Promise<void> {
		return this.withPersistence(() => this.persistMemory(this.memory));
	}

	private acquireOwnership(): void {
		const store = new PersistentStore(buildPath(this.memoryPath, 'ownership.sqlite'));
		const token = randomUUID();
		try {
			store.transaction(() => {
				const previous = store.get<Parameters<typeof operationOwnerState>[0]>(
					'memory',
					'owner'
				);
				if (previous && operationOwnerState(previous, activeOwners) !== 'dead')
					throw new Error(
						'Project memory is already owned by another server, or its ownership is ambiguous'
					);
				store.put('memory', 'owner', { token, ownerPid: process.pid, host: hostname() });
			});
			activeOwners.add(token);
			this.owner = { store, token };
		} catch (error) {
			store.close();
			throw error;
		}
	}

	private releaseOwnership(): void {
		if (!this.owner) return;
		const { store, token } = this.owner;
		try {
			store.transaction(() => {
				if (store.get<{ token: string }>('memory', 'owner')?.token !== token)
					throw new Error('Project memory ownership changed');
				store.delete('memory', 'owner');
			});
		} finally {
			activeOwners.delete(token);
			store.close();
			this.owner = undefined;
		}
	}

	private withPersistence<T>(operation: () => Promise<T>): Promise<T> {
		const pending = this.saveTail.then(operation);
		this.saveTail = pending.then(
			() => undefined,
			() => undefined
		);
		return pending;
	}

	async remember(
		value: unknown
	): Promise<{ memoryType: MemoryType; id: string | null; revision: string; persisted: true }> {
		if (!this.initialized || this.closing)
			throw new Error('Project memory is not open for updates');
		if (this.pendingWrites >= 32) throw new Error('Project memory update queue is full');
		const { memoryType, data } = memoryInput(value);
		this.pendingWrites++;
		try {
			return await this.withPersistence(async () => {
				const next = this.snapshotMemory(this.memory);
				let id: string | null = null;
				if (memoryType === 'styleGuide') next.styleGuide = { ...next.styleGuide, ...data };
				else if (memoryType === 'all')
					next.customContext = { ...next.customContext, ...data };
				else {
					const records: MemoryRecord[] = next[memoryType];
					id =
						typeof data.id === 'string'
							? data.id
							: analysisDigest({ owner: this.memoryPath, memoryType, data });
					const index = records.findIndex((record) => record.id === id);
					if (data.id !== undefined) {
						if (index === -1)
							throw new Error(
								'No matching memory entry; recall current IDs before updating'
							);
						records[index] = { ...records[index], ...data } as MemoryRecord;
					} else if (index === -1) records.push({ ...data, id } as MemoryRecord);
				}
				if (this.memoryRevision(next) !== this.persistedRevision)
					await this.persistMemory(next, (snapshot) => {
						this.memory = snapshot;
					});
				else await this.checkSavedRevision();
				return {
					memoryType,
					id,
					revision: this.memoryRevision(this.memory),
					persisted: true,
				};
			});
		} finally {
			this.pendingWrites--;
		}
	}

	private snapshotMemory(memory: ProjectMemory): ProjectMemory {
		try {
			const snapshot = cloneHMSMetadata(
				{ ...memory, documentContexts: Array.from(memory.documentContexts) },
				{ maxBytes: MAX_PROJECT_MEMORY_BYTES, maxNodes: 1048576 }
			);
			return {
				...snapshot,
				documentContexts: new Map(snapshot.documentContexts as [string, DocumentContext][]),
			} as unknown as ProjectMemory;
		} catch (cause) {
			throw new Error(
				'Project memory could not be serialized within its 16 MiB JSON budget',
				{ cause }
			);
		}
	}

	private async checkMemoryDirectory(): Promise<void> {
		const info = await fs.lstat(this.memoryPath);
		if (!info.isDirectory() || info.isSymbolicLink())
			throw new Error('Project memory requires a regular directory, not a symbolic link');
	}

	private async readMemoryFile(file: string): Promise<string> {
		await this.checkMemoryDirectory();
		try {
			const handle = await fs.open(
				file,
				constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
			);
			try {
				const before = await handle.stat();
				const entry = await fs.lstat(file);
				if (!entry.isFile() || entry.isSymbolicLink())
					throw new Error('Project memory requires a regular JSON file without symlinks');
				if (entry.dev !== before.dev || entry.ino !== before.ino)
					throw new Error('Project memory changed while opening; retry');
				if (
					!before.isFile() ||
					!Number.isSafeInteger(before.size) ||
					before.size < 0 ||
					before.size > MAX_PROJECT_MEMORY_BYTES
				)
					throw new Error('Project memory requires a regular JSON file up to 16 MiB');
				const bytes = Buffer.alloc(before.size + 1);
				let length = 0;
				while (length < bytes.length) {
					const { bytesRead } = await handle.read(
						bytes,
						length,
						bytes.length - length,
						length
					);
					if (!bytesRead) break;
					length += bytesRead;
				}
				const after = await handle.stat();
				const current = await fs.lstat(file);
				await this.checkMemoryDirectory();
				if (
					length !== before.size ||
					after.size !== before.size ||
					after.mtimeMs !== before.mtimeMs ||
					!current.isFile() ||
					current.isSymbolicLink() ||
					current.dev !== before.dev ||
					current.ino !== before.ino ||
					entry.dev !== before.dev ||
					entry.ino !== before.ino
				)
					throw new Error('Project memory changed during the read; retry');
				return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
					bytes.subarray(0, length)
				);
			} finally {
				await handle.close();
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ELOOP')
				throw new Error('Project memory requires a regular JSON file without symlinks');
			if ((error as NodeJS.ErrnoException).code === 'ENOENT')
				throw new AppError('Project memory file was not found', ErrorCode.NOT_FOUND);
			throw error;
		}
	}

	private async checkSavedRevision(): Promise<void> {
		if (
			!this.owner ||
			this.owner.store.get<{ token: string }>('memory', 'owner')?.token !== this.owner.token
		)
			throw new Error('Project memory is not owned by this server');
		const saved = await this.readMemoryFile(
			buildPath(this.memoryPath, 'project-memory.json')
		).catch((error) => {
			if (error instanceof AppError && error.code === ErrorCode.NOT_FOUND) return null;
			throw error;
		});
		if ((saved === null ? null : documentRevision(saved)) !== this.fileRevision)
			throw new Error(
				'Project memory changed outside this server; close and reopen the project before updating'
			);
	}

	memoryRevision(memory: ProjectMemory = this.memory): string {
		return analysisDigest({ ...memory, documentContexts: Array.from(memory.documentContexts) });
	}

	getMemorySnapshot(): ProjectMemory {
		return this.snapshotMemory(this.memory);
	}

	private async persistMemory(
		memory: ProjectMemory,
		committed?: (snapshot: ProjectMemory) => void
	): Promise<void> {
		try {
			const snapshot = this.snapshotMemory(memory);
			snapshot.lastUpdated = new Date().toISOString();
			const memoryFile = buildPath(this.memoryPath, 'project-memory.json');

			const toSave = {
				...snapshot,
				documentContexts: Array.from(snapshot.documentContexts.entries()),
			};
			const serialized = JSON.stringify(toSave);
			if (Buffer.byteLength(serialized) > MAX_PROJECT_MEMORY_BYTES)
				throw new Error('Project memory exceeds 16 MiB');

			await this.checkSavedRevision();
			try {
				await safeWriteFile(memoryFile, serialized);
			} catch (error) {
				const saved = await this.readMemoryFile(memoryFile).catch(() => undefined);
				if (saved !== serialized) throw error;
				logger.warn('Project memory was committed despite a write-cleanup failure');
			}
			if (committed) committed(snapshot);
			else if (memory === this.memory) this.memory.lastUpdated = snapshot.lastUpdated;
			this.persistedRevision = this.memoryRevision(snapshot);
			this.fileRevision = documentRevision(serialized);
			if (this.databaseService) await this.saveToDatabase(snapshot, serialized);

			// Also save a backup
			try {
				const backupFile = buildPath(
					this.memoryPath,
					`backup-${toSave.lastUpdated.split('T')[0]}.json`
				);
				// Ensure directory still exists before writing backup
				await ensureDir(this.memoryPath);
				await safeWriteFile(backupFile, serialized);
			} catch (backupError) {
				logger.warn('Failed to save backup file', { error: backupError });
				// Don't throw - backup failure shouldn't break the main save
			}

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
				.filter((file) => BACKUP_NAME.test(file))
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

	getWorldElements(): WorldElement[] {
		return this.memory.worldBuilding;
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

	getStyleGuide(): Partial<StyleGuide> {
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

	getWritingStats(): Partial<WritingStatistics> {
		return this.memory.writingStats;
	}

	// Custom context for flexibility
	setCustomContext(key: string, value: unknown): void {
		this.memory.customContext = { ...this.memory.customContext, [key]: value };
	}

	getCustomContext(key: string): unknown {
		return Object.prototype.hasOwnProperty.call(this.memory.customContext, key)
			? this.memory.customContext[key]
			: undefined;
	}

	getFullMemory(): ProjectMemory {
		return this.memory;
	}

	// Import memory from another source
	async importMemory(memory: ProjectMemory): Promise<void> {
		if (!this.initialized || this.closing)
			throw new Error('Project memory is not open for updates');
		if (this.pendingWrites >= 32) throw new Error('Project memory update queue is full');
		const snapshot = this.snapshotMemory(memory);
		this.pendingWrites++;
		try {
			await this.withPersistence(() =>
				this.persistMemory(snapshot, (saved) => {
					this.memory = saved;
				})
			);
		} finally {
			this.pendingWrites--;
		}
	}

	stopAutoSave(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		this.closePromise = (async () => {
			await this.opening?.catch(() => undefined);
			if (this.autoSaveInterval) {
				clearInterval(this.autoSaveInterval);
				this.autoSaveInterval = undefined;
			}
			try {
				await this.withPersistence(async () => {
					if (this.initialized && this.memoryRevision() !== this.persistedRevision)
						await this.persistMemory(this.memory);
				});
				this.releaseOwnership();
				this.initialized = false;
			} catch (error) {
				this.closing = false;
				this.closePromise = undefined;
				throw error;
			}
		})();
		return this.closePromise;
	}

	cleanup(): void {
		this.stopAutoSave().catch((err) => logger.error('Cleanup save failed', { error: err }));
	}

	private generateId(): string {
		return generateScrivenerUUID();
	}

	private async loadFromDatabase(): Promise<void> {
		if (!this.databaseService) return;
		const data = readMemoryDatabase(this.databaseService.getSQLite().getDatabase());
		this.memory = this.decodeMemory(JSON.stringify(data));
	}

	private async saveToDatabase(memory: ProjectMemory, serialized: string): Promise<void> {
		if (!this.databaseService) return;
		try {
			mirrorMemoryDatabase(
				this.databaseService.getSQLite().getDatabase(),
				memory,
				serialized
			);
			if (this.databaseService.getNeo4j()?.isAvailable()) await this.syncToNeo4j(memory);
		} catch (error) {
			logger.error('Primary memory is saved, but its secondary database mirror failed', {
				error,
			});
		}
	}

	/**
	 * Sync memory data to Neo4j for relationship analysis
	 */
	private async syncToNeo4j(memory: ProjectMemory): Promise<void> {
		if (!this.databaseService || !this.databaseService.getNeo4j()?.isAvailable()) {
			return;
		}

		const neo4j = this.databaseService.getNeo4j()!;

		// Sync characters and their relationships
		for (const char of memory.characters) {
			await neo4j.query(
				`
				MERGE (c:Character {id: $id})
				SET c.name = $name, c.role = $role, c.description = $description
			`,
				{
					id: char.id,
					name: char.name,
					role: char.role ?? null,
					description: char.description ?? null,
				}
			);

			for (const rel of char.relationships ?? []) {
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
		for (const plot of memory.plotThreads) {
			await neo4j.query(
				`
				MERGE (p:PlotThread {id: $id})
				SET p.name = $name, p.status = $status, p.description = $description
			`,
				{
					id: plot.id,
					name: plot.name,
					status: plot.status ?? null,
					description: plot.description ?? null,
				}
			);

			// Connect plot threads to documents
			for (const docId of plot.documents ?? []) {
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
