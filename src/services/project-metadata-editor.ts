import { createError, ErrorCode } from '../core/errors.js';
import { safeWriteFile } from '../utils/common.js';
import { findBinderItem, getNotesPath, getSynopsisPath } from '../utils/scrivener-utils.js';
import { documentIndexer } from './document-indexer.js';
import type { MetadataManager } from './metadata-manager.js';
import type { ProjectLoader } from './project-loader.js';
import { RTFHandler } from './parsers/rtf-handler.js';
import type { ScrivenerDocument } from '../types/index.js';

/** Document metadata edits: binder metadata, synopsis/notes files and the index snapshot. */
export class ProjectMetadataEditor {
	constructor(
		private readonly projectPath: string,
		private readonly projectLoader: ProjectLoader,
		private readonly metadataManager: MetadataManager,
		private readonly saveProject: () => Promise<void>,
		private readonly isIndexInitialized: () => boolean
	) {}

	private get indexInitialized(): boolean {
		return this.isIndexInitialized();
	}

	// Metadata operations
	async updateMetadata(documentId: string, metadata: Record<string, unknown>): Promise<void> {
		const structure = this.projectLoader.getProjectStructure();
		if (!structure) {
			throw createError(ErrorCode.INVALID_STATE, 'Project not loaded');
		}

		const item = this.findBinderItem(
			structure as unknown as Record<string, unknown>,
			documentId
		);
		if (!item) {
			throw createError(ErrorCode.NOT_FOUND, `Document ${documentId} not found`);
		}

		this.metadataManager.updateDocumentMetadata(item, metadata);
		await this.writeSynopsisAndNotesToDisk(documentId, metadata);
		this.patchDocumentIndex(documentId, metadata);
		await this.saveProject();
	}

	/**
	 * Scrivener 3 reads a document's synopsis/notes from files under
	 * Files/Data/<UUID>/ (synopsis.txt, notes.rtf), not from the .scrivx
	 * MetaData block that updateDocumentMetadata above writes -- so a synopsis
	 * set here must also land on disk to be visible in Scrivener's own UI (and
	 * to round-trip back out of get_document_info, which reads from disk too).
	 */
	private async writeSynopsisAndNotesToDisk(
		documentId: string,
		metadata: Record<string, unknown>
	): Promise<void> {
		if (typeof metadata.synopsis === 'string') {
			await safeWriteFile(getSynopsisPath(this.projectPath, documentId), metadata.synopsis);
		}

		if (typeof metadata.notes === 'string') {
			await new RTFHandler().writeRTF(
				getNotesPath(this.projectPath, documentId),
				metadata.notes
			);
		}
	}

	/**
	 * Keep the document indexer's O(1) getDocumentInfo snapshot in sync with an
	 * in-session metadata update. buildIndex() snapshots each ScrivenerDocument
	 * once at load time; without this, get_document_info keeps serving
	 * pre-update values for the rest of the session even though the binder XML
	 * and disk files are current.
	 */
	private patchDocumentIndex(documentId: string, metadata: Record<string, unknown>): void {
		if (!this.indexInitialized) return;

		const patch: Partial<ScrivenerDocument> = {};
		if (typeof metadata.title === 'string') patch.title = metadata.title;
		if (typeof metadata.synopsis === 'string') patch.synopsis = metadata.synopsis || undefined;
		if (typeof metadata.notes === 'string') patch.notes = metadata.notes || undefined;
		if (typeof metadata.label === 'string') patch.label = metadata.label;
		if (typeof metadata.status === 'string') patch.status = metadata.status;
		if (Array.isArray(metadata.keywords)) patch.keywords = metadata.keywords as string[];
		if (typeof metadata.includeInCompile === 'boolean') {
			patch.includeInCompile = metadata.includeInCompile;
		}

		if (Object.keys(patch).length > 0) {
			documentIndexer.patchDocumentMetadata(documentId, patch);
		}
	}

	async updateDocumentMetadata(
		documentId: string,
		metadata: {
			synopsis?: string;
			notes?: string;
			label?: string;
			status?: string;
			customMetadata?: Record<string, string>;
		}
	): Promise<void> {
		await this.updateMetadata(documentId, metadata);
	}

	async updateSynopsisAndNotes(
		documentId: string,
		synopsis?: string,
		notes?: string
	): Promise<void> {
		await this.updateMetadata(documentId, { synopsis, notes });
	}

	async batchUpdateSynopsisAndNotes(
		updates: Array<{
			documentId: string;
			synopsis?: string;
			notes?: string;
		}>
	): Promise<Array<{ documentId: string; success: boolean; error?: string }>> {
		const results = [];
		for (const update of updates) {
			try {
				await this.updateSynopsisAndNotes(update.documentId, update.synopsis, update.notes);
				results.push({ documentId: update.documentId, success: true });
			} catch (error) {
				results.push({
					documentId: update.documentId,
					success: false,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return results;
	}

	private findBinderItem(
		structure: Record<string, unknown>,
		documentId: string
	): Record<string, unknown> | null {
		const scrivenerProject = structure.ScrivenerProject as Record<string, unknown> | undefined;
		if (!scrivenerProject?.Binder) return null;

		const binder = scrivenerProject.Binder;
		const found = findBinderItem(binder, documentId);
		return found as Record<string, unknown> | null;
	}
}
