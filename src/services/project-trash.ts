import { getLogger } from '../core/logger.js';
import { DOCUMENT_TYPES } from '../core/constants.js';
import type { CompilationService } from './compilation-service.js';
import type { DocumentManager } from './document-manager.js';
import type { ScrivenerDocument } from '../types/index.js';

const logger = getLogger('scrivener-project');

/** Trash listing, search and recovery. */
export class ProjectTrash {
	constructor(
		private readonly documentManager: DocumentManager,
		private readonly compilationService: CompilationService,
		private readonly saveProject: () => Promise<void>,
		private readonly readDocument: (documentId: string) => Promise<string>,
		private readonly getProjectStructure: (
			includeTrash?: boolean
		) => Promise<ScrivenerDocument[]>
	) {}

	async getTrashDocuments(): Promise<ScrivenerDocument[]> {
		const allDocs = await this.getProjectStructure(true);
		const trashDocs: ScrivenerDocument[] = [];

		// Find trash folder
		for (const doc of allDocs) {
			if (doc.path && doc.path.startsWith('Trash/')) {
				trashDocs.push(doc);
			}
		}

		return trashDocs;
	}

	async searchTrash(
		query: string,
		options?: { caseSensitive?: boolean; regex?: boolean }
	): Promise<Array<{ documentId: string; title: string; matches: string[] }>> {
		const trashDocs = await this.getTrashDocuments();
		const docsWithContent = [];

		for (const doc of trashDocs) {
			if (doc.type === DOCUMENT_TYPES.TEXT) {
				try {
					const content = await this.readDocument(doc.id);
					docsWithContent.push({
						id: doc.id,
						title: `[TRASH] ${doc.title}`,
						content,
						metadata: {},
					});
				} catch (err) {
					logger.debug('Skipped trash document during scan', { id: doc.id, error: err });
				}
			}
		}

		return this.compilationService.searchInDocuments(docsWithContent, query, options);
	}

	async recoverFromTrash(documentId: string, targetParentId?: string): Promise<void> {
		await this.documentManager.recoverFromTrash(documentId, targetParentId);
		await this.saveProject();
	}
}
