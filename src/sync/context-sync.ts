import * as fs from 'fs';
import * as path from 'path';
import { safeWriteFile, ensureDir, pathExists } from '../utils/common.js';
import { createError, ErrorCode } from '../core/errors.js';
import type { DatabaseService } from '../database/database-service.js';
import type {
	ContextAnalyzer,
	ChapterContext,
	StoryContext,
	ScrivenerDocument,
} from '../analysis/context-analyzer.js';

export interface SyncOptions {
	autoSync: boolean;
	syncInterval: number; // milliseconds
	contextFileFormat: 'json' | 'markdown' | 'both';
	includeAnalysis: boolean;
	includeRelationships: boolean;
}

export interface SyncStatus {
	lastSync: Date;
	documentsInSync: number;
	documentsOutOfSync: number;
	pendingChanges: string[];
	errors: string[];
}

export class ContextSyncService {
	private syncTimer?: NodeJS.Timeout;
	private pendingChanges: Set<string> = new Set();
	private syncStatus: SyncStatus;
	private contextDir: string;

	constructor(
		private projectPath: string,
		private databaseService: DatabaseService,
		private contextAnalyzer: ContextAnalyzer,
		private options: SyncOptions = {
			autoSync: true,
			syncInterval: 30000, // 30 seconds
			contextFileFormat: 'both',
			includeAnalysis: true,
			includeRelationships: true,
		}
	) {
		this.contextDir = path.join(projectPath, '.scrivener-context');
		this.syncStatus = {
			lastSync: new Date(),
			documentsInSync: 0,
			documentsOutOfSync: 0,
			pendingChanges: [],
			errors: [],
		};

		this.initializeContextDirectory();

		if (this.options.autoSync) {
			this.startAutoSync();
		}
	}

	/**
	 * Initialize context directory
	 */
	private async initializeContextDirectory(): Promise<void> {
		await ensureDir(this.contextDir);

		// Create subdirectories
		const subdirs = ['chapters', 'characters', 'themes', 'plots', 'analysis'];
		for (const subdir of subdirs) {
			const dirPath = path.join(this.contextDir, subdir);
			await ensureDir(dirPath);
		}
	}

	/**
	 * Start automatic synchronization
	 */
	startAutoSync(): void {
		if (this.syncTimer) {
			clearInterval(this.syncTimer);
		}

		this.syncTimer = setInterval(() => {
			this.performSync().catch((error) => {
				// Auto-sync error handled silently
				this.syncStatus.errors.push(`Auto-sync error: ${error.message}`);
			});
		}, this.options.syncInterval);
	}

	/**
	 * Stop automatic synchronization
	 */
	stopAutoSync(): void {
		if (this.syncTimer) {
			clearInterval(this.syncTimer);
			this.syncTimer = undefined;
		}
	}

	/**
	 * Mark document as changed
	 */
	markDocumentChanged(documentId: string): void {
		this.pendingChanges.add(documentId);
		this.syncStatus.pendingChanges = Array.from(this.pendingChanges);
		this.syncStatus.documentsOutOfSync++;
	}

	/**
	 * Perform full synchronization
	 */
	async performSync(): Promise<void> {
		// Starting context synchronization

		try {
			// Sync pending document changes
			for (const documentId of this.pendingChanges) {
				await this.syncDocument(documentId);
			}

			// Clear pending changes
			this.pendingChanges.clear();
			this.syncStatus.pendingChanges = [];

			// Update sync status
			this.syncStatus.lastSync = new Date();
			this.syncStatus.documentsInSync = await this.countSyncedDocuments();
			this.syncStatus.documentsOutOfSync = 0;

			// Generate story-wide context if needed
			if (this.options.includeAnalysis) {
				await this.generateStoryContext();
			}

			// Context synchronization completed
		} catch (error) {
			// Sync failed - error stored in status
			this.syncStatus.errors.push(`Sync error: ${error}`);
			throw error;
		}
	}

	/**
	 * Sync a single document
	 */
	async syncDocument(documentId: string): Promise<void> {
		try {
			// Get document from database
			const document = await this.getDocumentFromDatabase(documentId);
			if (!document) {
				// Document ${documentId} not found in database
				return;
			}

			// Get or generate chapter context
			let context = await this.contextAnalyzer.getChapterContext(documentId);

			if (!context || this.isContextOutdated(document, context)) {
				// Need to regenerate context
				const content = await this.getDocumentContent(documentId);
				const allDocuments = await this.getAllDocuments();
				context = await this.contextAnalyzer.analyzeChapter(
					document,
					content,
					allDocuments
				);
			}

			// Write context files
			await this.writeChapterContextFiles(context);

			// Update relationships if needed
			if (this.options.includeRelationships) {
				await this.syncDocumentRelationships(documentId, context);
			}
		} catch (error) {
			const appError = createError(
				ErrorCode.SYNC_ERROR,
				`Failed syncing document ${documentId}: ${error}`
			);
			// Failed to sync document - error captured
			this.syncStatus.errors.push(`Document ${documentId}: ${appError.message}`);
		}
	}

	/**
	 * Write chapter context files
	 */
	private async writeChapterContextFiles(context: ChapterContext): Promise<void> {
		const chapterDir = path.join(this.contextDir, 'chapters');
		const baseFileName = `${this.sanitizeFileName(context.title)}-${context.documentId.substring(0, 8)}`;

		// Write JSON format
		if (
			this.options.contextFileFormat === 'json' ||
			this.options.contextFileFormat === 'both'
		) {
			const jsonPath = path.join(chapterDir, `${baseFileName}.json`);
			await safeWriteFile(jsonPath, JSON.stringify(context, null, 2));
		}

		// Write Markdown format
		if (
			this.options.contextFileFormat === 'markdown' ||
			this.options.contextFileFormat === 'both'
		) {
			const mdPath = path.join(chapterDir, `${baseFileName}.md`);
			const markdown = this.contextToMarkdown(context);
			await safeWriteFile(mdPath, markdown);
		}
	}

	/**
	 * Convert context to markdown
	 */
	private contextToMarkdown(context: ChapterContext): string {
		let md = `# ${context.title}\n\n`;

		if (context.synopsis) {
			md += `## Synopsis\n${context.synopsis}\n\n`;
		}

		if (context.notes) {
			md += `## Notes\n${context.notes}\n\n`;
		}

		md += `## Statistics\n`;
		md += `- Word Count: ${context.wordCount}\n`;
		md += `- Pacing: ${context.pacing.description}\n\n`;

		if (context.characters.length > 0) {
			md += `## Characters\n`;
			for (const char of context.characters) {
				md += `- **${char.name}** (${char.role || 'role unknown'}): ${char.appearances} appearances\n`;
				if (char.lastMention) {
					md += `  - Last mention: "${char.lastMention}"\n`;
				}
			}
			md += '\n';
		}

		if (context.themes.length > 0) {
			md += `## Themes\n`;
			for (const theme of context.themes) {
				md += `- **${theme.name}** (Prominence: ${(theme.prominence * 100).toFixed(0)}%)\n`;
				if (theme.examples.length > 0) {
					md += `  - Example: "${theme.examples[0]}"\n`;
				}
			}
			md += '\n';
		}

		if (context.plotThreads.length > 0) {
			md += `## Plot Threads\n`;
			for (const thread of context.plotThreads) {
				md += `- **${thread.name}** (${thread.status})\n`;
				if (thread.developments.length > 0) {
					md += `  - Recent: ${thread.developments[thread.developments.length - 1]}\n`;
				}
			}
			md += '\n';
		}

		md += `## Emotional Arc\n`;
		md += `- Start: ${context.emotionalArc.start}\n`;
		md += `- Peak: ${context.emotionalArc.peak}\n`;
		md += `- End: ${context.emotionalArc.end}\n`;
		md += `- Overall: ${context.emotionalArc.overall}\n\n`;

		if (context.keyEvents.length > 0) {
			md += `## Key Events\n`;
			for (const event of context.keyEvents) {
				md += `- ${event}\n`;
			}
			md += '\n';
		}

		if (context.cliffhangers.length > 0) {
			md += `## Cliffhangers\n`;
			for (const cliff of context.cliffhangers) {
				md += `- ${cliff}\n`;
			}
			md += '\n';
		}

		if (context.previousChapter) {
			md += `## Previous Chapter\n`;
			md += `**${context.previousChapter.title}**: ${context.previousChapter.summary}\n\n`;
		}

		if (context.nextChapter) {
			md += `## Next Chapter\n`;
			md += `**${context.nextChapter.title}**\n\n`;
		}

		return md;
	}

	/**
	 * Sync document relationships
	 */
	private async syncDocumentRelationships(
		documentId: string,
		context: ChapterContext
	): Promise<void> {
		// Sync character appearances
		for (const char of context.characters) {
			await this.databaseService.createRelationship(
				char.id,
				'character',
				documentId,
				'document',
				'APPEARS_IN',
				{ appearances: char.appearances }
			);
		}

		// Sync theme presence
		for (const theme of context.themes) {
			// First ensure theme exists in database
			const themeId = await this.ensureThemeExists(theme.name);

			await this.databaseService.createRelationship(
				themeId,
				'theme',
				documentId,
				'document',
				'PRESENT_IN',
				{ prominence: theme.prominence }
			);
		}

		// Sync chapter flow
		if (context.previousChapter) {
			await this.databaseService.createRelationship(
				documentId,
				'document',
				context.previousChapter.id,
				'document',
				'FOLLOWS',
				{}
			);
		}
	}

	/**
	 * Ensure theme exists in database
	 */
	private async ensureThemeExists(themeName: string): Promise<string> {
		const themeId = `theme-${themeName.toLowerCase().replace(/\s+/g, '-')}`;

		if (this.databaseService.getSQLite()) {
			const stmt = this.databaseService.getSQLite().getDatabase().prepare(`
				INSERT OR IGNORE INTO themes (id, name, description)
				VALUES (?, ?, ?)
			`);

			stmt.run([themeId, themeName, `Theme: ${themeName}`]);
		}

		if (this.databaseService.getNeo4j()?.isAvailable()) {
			await this.databaseService.getNeo4j()!.query(
				`
				MERGE (t:Theme {id: $id})
				SET t.name = $name
			`,
				{ id: themeId, name: themeName }
			);
		}

		return themeId;
	}

	/**
	 * Generate story-wide context
	 */
	private async generateStoryContext(): Promise<void> {
		// Get all chapter contexts
		const chapters = await this.getAllChapterContexts();

		if (chapters.length === 0) {
			// No chapter contexts available for story analysis
			return;
		}

		// Build story context
		const documents = await this.getAllDocuments();
		const storyContext = await this.contextAnalyzer.buildStoryContext(documents, chapters);

		// Write story context files
		const storyPath = path.join(this.contextDir, 'story-context');

		if (
			this.options.contextFileFormat === 'json' ||
			this.options.contextFileFormat === 'both'
		) {
			await safeWriteFile(
				path.join(`${storyPath}.json`),
				JSON.stringify(
					storyContext,
					(key, value) => {
						if (value instanceof Map) {
							return Object.fromEntries(value);
						}
						return value;
					},
					2
				)
			);
		}

		if (
			this.options.contextFileFormat === 'markdown' ||
			this.options.contextFileFormat === 'both'
		) {
			const markdown = this.storyContextToMarkdown(storyContext);
			await safeWriteFile(path.join(`${storyPath}.md`), markdown);
		}
	}

	/**
	 * Convert story context to markdown
	 */
	private storyContextToMarkdown(context: StoryContext): string {
		let md = `# Story Context\n\n`;

		md += `## Overview\n`;
		md += `- Total Word Count: ${context.totalWordCount}\n`;
		md += `- Chapter Count: ${context.chapterCount}\n`;
		md += `- Pacing Trend: ${context.overallPacing.trend}\n\n`;

		md += `## Character Arcs\n`;
		for (const [charId, arc] of context.characterArcs) {
			md += `### ${arc.character} (${charId})\n`;
			md += `- Introduction: ${arc.introduction}\n`;
			md += `- Current Status: ${arc.currentStatus}\n`;
			md += `- Projected Arc: ${arc.projectedArc}\n\n`;
		}

		md += `## Theme Progression\n`;
		for (const [themeName, prog] of context.themeProgression) {
			md += `### ${prog.theme || themeName}\n`;
			md += `- Introduction: ${prog.introduction}\n`;
			md += `- Current Strength: ${(prog.currentStrength * 100).toFixed(0)}%\n`;
			md += `- Development:\n`;
			for (const dev of prog.developments.slice(0, 5)) {
				md += `  - ${dev}\n`;
			}
			md += '\n';
		}

		md += `## Plot Threads\n`;
		for (const [threadId, thread] of context.plotThreads) {
			md += `### ${thread.thread} [${threadId}]\n`;
			md += `- Status: ${thread.status}\n`;
			md += `- Chapters: ${thread.chapters.join(', ')}\n`;
			if (thread.keyEvents.length > 0) {
				md += `- Key Events:\n`;
				for (const event of thread.keyEvents) {
					md += `  - ${event}\n`;
				}
			}
			md += '\n';
		}

		if (context.overallPacing.suggestions.length > 0) {
			md += `## Pacing Suggestions\n`;
			for (const suggestion of context.overallPacing.suggestions) {
				md += `- ${suggestion}\n`;
			}
		}

		return md;
	}

	/**
	 * Check if context is outdated
	 */
	private isContextOutdated(document: ScrivenerDocument, context: ChapterContext): boolean {
		// Check if word count has changed significantly
		if (Math.abs(document.wordCount - context.wordCount) > 50) {
			return true;
		}

		// Check if synopsis or notes have changed
		if (document.synopsis !== context.synopsis || document.notes !== context.notes) {
			return true;
		}

		// Could add more checks here (last modified date, etc.)
		return false;
	}

	/**
	 * Get document from database
	 */
	private async getDocumentFromDatabase(documentId: string): Promise<ScrivenerDocument | null> {
		if (!this.databaseService.getSQLite()) {
			return null;
		}

		const result = this.databaseService
			.getSQLite()
			.queryOne(`SELECT * FROM documents WHERE id = ?`, [documentId]) as any;

		if (!result) {
			return null;
		}

		return {
			id: result.id,
			title: result.title,
			type: result.type,
			synopsis: result.synopsis,
			notes: result.notes,
			wordCount: result.word_count,
			characterCount: result.character_count,
			children: [],
		};
	}

	/**
	 * Get document content
	 */
	private async getDocumentContent(documentId: string): Promise<string> {
		// This would need to be implemented to fetch actual content
		// For now, return empty string for document: ${documentId}
		return `[Content for document ${documentId}]`;
	}

	/**
	 * Get all documents
	 */
	private async getAllDocuments(): Promise<ScrivenerDocument[]> {
		if (!this.databaseService.getSQLite()) {
			return [];
		}

		const results = this.databaseService
			.getSQLite()
			.query(`SELECT * FROM documents ORDER BY title`) as any[];

		return results.map((r) => ({
			id: r.id,
			title: r.title,
			type: r.type,
			synopsis: r.synopsis,
			notes: r.notes,
			wordCount: r.word_count,
			characterCount: r.character_count,
			children: [],
		}));
	}

	/**
	 * Get all chapter contexts
	 */
	private async getAllChapterContexts(): Promise<ChapterContext[]> {
		const contexts: ChapterContext[] = [];
		const documents = await this.getAllDocuments();

		for (const doc of documents) {
			const context = await this.contextAnalyzer.getChapterContext(doc.id);
			if (context) {
				contexts.push(context);
			}
		}

		return contexts;
	}

	/**
	 * Count synced documents
	 */
	private async countSyncedDocuments(): Promise<number> {
		const chapterDir = path.join(this.contextDir, 'chapters');

		if (!(await pathExists(chapterDir))) {
			return 0;
		}

		const files = await fs.promises.readdir(chapterDir);
		// Count unique documents (may have both .json and .md files)
		const uniqueDocs = new Set(files.map((f) => f.replace(/\.(json|md)$/, '')));

		return uniqueDocs.size;
	}

	/**
	 * Sanitize filename
	 */
	private sanitizeFileName(name: string): string {
		return name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
	}

	/**
	 * Get sync status
	 */
	getSyncStatus(): SyncStatus {
		return { ...this.syncStatus };
	}

	/**
	 * Export all context files
	 */
	async exportContextFiles(exportPath: string): Promise<void> {
		// Copy entire context directory
		const copyRecursive = async (src: string, dest: string): Promise<void> => {
			if (!(await pathExists(dest))) {
				await ensureDir(dest);
			}

			const entries = await fs.promises.readdir(src, { withFileTypes: true });

			for (const entry of entries) {
				const srcPath = path.join(src, entry.name);
				const destPath = path.join(dest, entry.name);

				if (entry.isDirectory()) {
					await copyRecursive(srcPath, destPath);
				} else {
					await fs.promises.copyFile(srcPath, destPath);
				}
			}
		};

		await copyRecursive(this.contextDir, exportPath);
		// Context files exported successfully
	}

	/**
	 * Clean up and close
	 */
	close(): void {
		this.stopAutoSync();
	}
}
