import { createError, ErrorCode } from '../core/errors.js';
import {
	assertProjectArtifactPath,
	assertValidProjectDocumentId,
	getNotesPath,
	getSynopsisPath,
} from '../utils/scrivener-utils.js';
import { documentIndexer } from './document-indexer.js';
import type { MetadataManager } from './metadata-manager.js';
import type { ProjectLoader } from './project-loader.js';
import type { BinderContainer, ProjectStructure } from '../types/internal.js';
import { RTFHandler } from './parsers/rtf-handler.js';
import type { ScrivenerDocument } from '../types/index.js';
import { findBinderItemById } from './document-manager-helpers.js';
import { exposeXmlAttributes } from '../utils/scrivener-xml.js';
import type { MetadataFileUpdate } from './editorial/mutation-coordinator.js';

/** Document metadata edits: binder metadata, synopsis/notes files and the index snapshot. */
export class ProjectMetadataEditor {
	constructor(
		private readonly projectPath: string,
		private readonly projectLoader: ProjectLoader,
		private readonly metadataManager: MetadataManager,
		private readonly saveProject: (
			structure: ProjectStructure,
			files: readonly MetadataFileUpdate[]
		) => Promise<void>,
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

		this.validateSynopsisAndNotesPaths(documentId, metadata);
		const nextStructure = structuredClone(structure);
		exposeXmlAttributes(nextStructure);
		const item = this.findBinderItem(
			nextStructure as unknown as Record<string, unknown>,
			documentId
		);
		if (!item) {
			throw createError(ErrorCode.NOT_FOUND, `Document ${documentId} not found`);
		}

		this.metadataManager.updateDocumentMetadata(item, metadata);
		const files: MetadataFileUpdate[] = [];
		if (typeof metadata.synopsis === 'string')
			files.push({ documentId, kind: 'synopsis', raw: metadata.synopsis });
		if (typeof metadata.notes === 'string')
			files.push({
				documentId,
				kind: 'notes',
				raw: new RTFHandler().convertToRTF(metadata.notes),
			});
		await this.saveProject(nextStructure, files);
		this.patchDocumentIndex(documentId, metadata);
	}

	private validateSynopsisAndNotesPaths(
		documentId: string,
		metadata: Record<string, unknown>
	): void {
		assertValidProjectDocumentId(documentId);
		if (typeof metadata.synopsis === 'string') {
			assertProjectArtifactPath(
				this.projectPath,
				getSynopsisPath(this.projectPath, documentId)
			);
		}
		if (typeof metadata.notes === 'string') {
			assertProjectArtifactPath(this.projectPath, getNotesPath(this.projectPath, documentId));
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

		const found = findBinderItemById(scrivenerProject.Binder as BinderContainer, documentId);
		return found as Record<string, unknown> | null;
	}
}
