import { getLogger } from '../core/logger.js';
import { DOCUMENT_TYPES } from '../core/constants.js';
import type { CompilationService } from './compilation-service.js';
import type { ScrivenerDocument } from '../types/index.js';

const logger = getLogger('scrivener-project');

/** Trash listing, search and recovery. */
export class ProjectTrash {
	constructor(
		private readonly compilationService: CompilationService,
		private readonly readDocument: (documentId: string) => Promise<string>,
		private readonly getProjectStructure: (
			includeTrash?: boolean
		) => Promise<ScrivenerDocument[]>
	) {}

	async getTrashDocuments(): Promise<ScrivenerDocument[]> {
		const allDocs = await this.getProjectStructure(true);
		const trashDocs: ScrivenerDocument[] = [];
		const visit = (doc: ScrivenerDocument): void => {
			if (doc.type !== DOCUMENT_TYPES.FOLDER) {
				trashDocs.push(doc);
			}
			for (const child of doc.children ?? []) visit(child);
		};
		const nativeTrash = allDocs.find((doc) => (doc.type as string) === 'TrashFolder');
		if (nativeTrash) for (const doc of nativeTrash.children ?? []) visit(doc);
		else {
			const active = new Set<string>();
			const collect = (doc: ScrivenerDocument): void => {
				active.add(doc.id);
				for (const child of doc.children ?? []) collect(child);
			};
			for (const doc of await this.getProjectStructure(false)) collect(doc);
			for (const doc of allDocs) if (!active.has(doc.id)) visit(doc);
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
					if (!['ENOENT', 'NOT_FOUND'].includes((err as { code?: string }).code ?? ''))
						throw err;
					logger.debug('Skipped trash document during scan', { id: doc.id, error: err });
				}
			}
		}

		return this.compilationService.searchInDocuments(docsWithContent, query, options);
	}
}
