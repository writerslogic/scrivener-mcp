import { getLogger } from '../core/logger.js';
import type { ContextAnalyzer } from '../analysis/index.js';
import { DOCUMENT_TYPES } from '../core/constants.js';
import { createError, ErrorCode } from '../core/errors.js';
import type { DatabaseService } from '../handlers/database/index.js';
import type { ContextSyncService } from '../sync/context-sync.js';
import { type SyncStatus } from '../sync/context-sync.js';
import { getDocumentPath } from '../utils/scrivener-utils.js';
import { documentIndexer } from './document-indexer.js';
import type {
	ScrivenerDocument as AnalyzerDocument,
	ChapterContext,
} from '../analysis/context-analyzer.js';
import type { ScrivenerDocument } from '../types/index.js';
import type { ScrivenerProject } from '../scrivener-project.js';

const logger = getLogger('scrivener-project');

/** Context analysis, context-file sync and the project-to-database sync. */
export class ProjectContextBridge {
	constructor(
		private readonly projectPath: string,
		private readonly databaseService: DatabaseService,
		private readonly getContextSync: () => ContextSyncService | undefined,
		private readonly getContextAnalyzer: () => ContextAnalyzer | undefined,
		private readonly getAllDocuments: (includeTrash?: boolean) => Promise<ScrivenerDocument[]>,
		private readonly readDocument: (documentId: string) => Promise<string>,
		private readonly getDocumentInfo: ScrivenerProject['getDocumentInfo'],
		private readonly isIndexInitialized: () => boolean
	) {}

	private get contextSync(): ContextSyncService | undefined {
		return this.getContextSync();
	}

	private get contextAnalyzer(): ContextAnalyzer | undefined {
		return this.getContextAnalyzer();
	}

	private get indexInitialized(): boolean {
		return this.isIndexInitialized();
	}

	async analyzeChapterEnhanced(documentId: string): Promise<ChapterContext> {
		if (!this.contextAnalyzer) {
			throw createError(ErrorCode.INVALID_STATE, 'Context analyzer not initialized');
		}

		const document = await this.getDocumentInfo(documentId);
		if (!document.document) {
			throw createError(ErrorCode.NOT_FOUND, `Document ${documentId} not found`);
		}

		const content = await this.readDocument(documentId);
		const allDocuments = await this.getAllDocuments();

		const addCharCount = (doc: ScrivenerDocument): AnalyzerDocument => ({
			id: doc.id,
			title: doc.title,
			type: doc.type,
			synopsis: doc.synopsis,
			notes: doc.notes,
			characterCount: doc.content?.length || 0,
			wordCount: doc.wordCount || 0,
			children: doc.children?.map(addCharCount),
		});
		const documentsWithCharCount = allDocuments.map(addCharCount);
		const documentWithCharCount = addCharCount(document.document);
		return (await this.contextAnalyzer.analyzeChapter(
			documentWithCharCount,
			content,
			documentsWithCharCount
		)) as ChapterContext;
	}

	async buildStoryContext(): Promise<unknown> {
		if (!this.contextAnalyzer) {
			throw createError(ErrorCode.INVALID_STATE, 'Context analyzer not initialized');
		}

		const documents = await this.getAllDocuments();
		const contexts = [];

		for (const doc of documents) {
			if (doc.type === DOCUMENT_TYPES.TEXT) {
				const context = await this.contextAnalyzer.getChapterContext(doc.id);
				if (context) {
					contexts.push(context);
				}
			}
		}

		const addCharCount = (doc: ScrivenerDocument): AnalyzerDocument => ({
			id: doc.id,
			title: doc.title,
			type: doc.type,
			synopsis: doc.synopsis,
			notes: doc.notes,
			characterCount: doc.content?.length || 0,
			wordCount: doc.wordCount || 0,
			children: doc.children?.map(addCharCount),
		});
		const documentsWithCharCount = documents.map(addCharCount);
		return await this.contextAnalyzer.buildStoryContext(documentsWithCharCount, contexts);
	}

	getSyncStatus(): SyncStatus | { enabled: false; message: string } {
		if (!this.contextSync) {
			return {
				enabled: false,
				message: 'Context sync not initialized',
			};
		}
		return this.contextSync.getSyncStatus();
	}

	markDocumentChanged(documentId: string): void {
		// Track in document indexer for efficient syncing
		if (this.indexInitialized) {
			documentIndexer.markDocumentChanged(documentId);
		}

		// Also track in context sync if available
		if (this.contextSync) {
			this.contextSync.markDocumentChanged(documentId);
		}
	}

	async exportContextFiles(exportPath: string): Promise<void> {
		if (!this.contextSync) {
			throw createError(ErrorCode.INVALID_STATE, 'Context sync not initialized');
		}
		await this.contextSync.exportContextFiles(exportPath);
	}

	// Private helpers
	async performInitialSync(): Promise<void> {
		const allDocs = await this.getAllDocuments();
		const BATCH_SIZE = 50;

		const syncErrors: Array<{ docId: string; error: string }> = [];
		for (let i = 0; i < allDocs.length; i += BATCH_SIZE) {
			const batch = allDocs.slice(i, i + BATCH_SIZE);
			const results = await Promise.allSettled(
				batch.map((doc) => this.syncDocumentToDatabase(doc))
			);
			for (let j = 0; j < results.length; j++) {
				const result = results[j];
				if (result.status === 'rejected') {
					syncErrors.push({
						docId: batch[j].id,
						error:
							result.reason instanceof Error
								? result.reason.message
								: String(result.reason),
					});
				}
			}
			logger.debug(
				`Synced ${Math.min(i + BATCH_SIZE, allDocs.length)}/${allDocs.length} documents`
			);
		}
		if (syncErrors.length > 0) {
			logger.error(`Database sync completed with ${syncErrors.length} error(s)`, {
				syncErrors,
			});
		}
	}

	private async syncDocumentToDatabase(doc: ScrivenerDocument): Promise<void> {
		try {
			let wordCount = 0;
			let characterCount = 0;

			if (doc.type === DOCUMENT_TYPES.TEXT) {
				try {
					const content = await this.readDocument(doc.id);
					const words = content
						.trim()
						.split(/\s+/)
						.filter((w) => w.length > 0);
					wordCount = words.length;
					characterCount = content.length;
				} catch (err) {
					logger.debug('Document has no readable content', { id: doc.id, error: err });
				}
			}

			await this.databaseService.syncDocumentData({
				id: doc.id,
				title: doc.title,
				type: doc.type,
				path: getDocumentPath(this.projectPath, doc.id),
				synopsis: doc.synopsis,
				notes: doc.notes,
				wordCount,
				characterCount,
			});
		} catch (error) {
			logger.error(`Failed to sync document ${doc.id}:`, {
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}
}
