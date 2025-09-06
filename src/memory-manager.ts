import { existsSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { safeReadFile, safeWriteFile, ensureDir, pathExists } from './utils/common.js';

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
	// private projectPath: string;
	private memoryPath: string;
	private memory: ProjectMemory;
	private autoSaveInterval?: NodeJS.Timeout;

	constructor(projectPath: string) {
		// this.projectPath = projectPath;
		// Store memory in a hidden folder within the Scrivener project
		this.memoryPath = path.join(projectPath, '.ai-memory');
		this.memory = this.createEmptyMemory();
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
		// Create memory directory if it doesn't exist
		await ensureDir(this.memoryPath);

		// Load existing memory or create new
		const memoryFile = path.join(this.memoryPath, 'project-memory.json');
		if (await pathExists(memoryFile)) {
			await this.loadMemory();
		} else {
			await this.saveMemory();
		}

		// Set up auto-save every 5 minutes
		this.autoSaveInterval = setInterval(
			() => {
				this.saveMemory().catch(console.error);
			},
			5 * 60 * 1000
		);
	}

	async loadMemory(): Promise<void> {
		try {
			const memoryFile = path.join(this.memoryPath, 'project-memory.json');
			const data = await safeReadFile(memoryFile);
			const loaded = JSON.parse(data);

			// Convert documentContexts back to Map
			if (loaded.documentContexts && Array.isArray(loaded.documentContexts)) {
				loaded.documentContexts = new Map(loaded.documentContexts);
			} else {
				loaded.documentContexts = new Map();
			}

			this.memory = loaded;
		} catch (error) {
			console.error('Failed to load memory:', error);
			this.memory = this.createEmptyMemory();
		}
	}

	async saveMemory(): Promise<void> {
		try {
			const memoryFile = path.join(this.memoryPath, 'project-memory.json');

			// Convert Map to array for JSON serialization
			const toSave = {
				...this.memory,
				documentContexts: Array.from(this.memory.documentContexts.entries()),
				lastUpdated: new Date().toISOString(),
			};

			await safeWriteFile(memoryFile, JSON.stringify(toSave, null, 2));

			// Also save a backup
			try {
				const backupFile = path.join(
					this.memoryPath,
					`backup-${new Date().toISOString().split('T')[0]}.json`
				);
				// Ensure directory still exists before writing backup
				await ensureDir(this.memoryPath);
				await safeWriteFile(backupFile, JSON.stringify(toSave, null, 2));
			} catch (backupError) {
				console.warn('Failed to save backup file:', backupError);
				// Don't throw - backup failure shouldn't break the main save
			}

			// Clean up old backups (keep last 7)
			await this.cleanupOldBackups();
		} catch (error) {
			console.error('Failed to save memory:', error);
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
					await fs.unlink(path.join(this.memoryPath, backup));
				}
			}
		} catch (error) {
			console.error('Failed to cleanup backups:', error);
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

	// Cleanup when done
	cleanup(): void {
		if (this.autoSaveInterval) {
			clearInterval(this.autoSaveInterval);
		}
		this.saveMemory().catch(console.error);
	}

	private generateId(): string {
		return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
	}
}
