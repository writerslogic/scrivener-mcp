import type { DOCUMENT_TYPES } from '../core/constants.js';
import { createError, ErrorCode } from '../core/errors.js';
import type { ScrivenerDocument } from '../types/index.js';
import type {
	BinderContainer,
	BinderItem,
	MetaDataItem,
	ProjectStructure,
} from '../types/internal.js';
import { handleError, safeReadFile } from '../utils/common.js';
import { getNotesPath, getSynopsisPath } from '../utils/scrivener-utils.js';
import { FileUtils } from '../utils/shared-patterns.js';
import { findBinderItemById } from './document-manager-helpers.js';
import type { RTFHandler } from './parsers/rtf-handler.js';

/** Builds document lists and trees from the binder structure. */
export class DocumentTree {
	constructor(
		private readonly projectPath: string,
		private readonly rtfHandler: RTFHandler,
		private readonly getStructure: () => ProjectStructure | undefined
	) {}

	private get projectStructure(): ProjectStructure | undefined {
		return this.getStructure();
	}

	async getAllDocuments(includeTrash = false): Promise<ScrivenerDocument[]> {
		try {
			await this.getProjectStructure(includeTrash);
			const flatList: ScrivenerDocument[] = [];

			if (this.projectStructure?.ScrivenerProject?.Binder) {
				const binder = this.projectStructure.ScrivenerProject.Binder as BinderContainer;

				// Recurse into every top-level item so nested documents (the normal
				// case: Draft/Part/Chapter) are included, not just the top-level
				// folders. Skip the trash folder unless includeTrash; give trashed
				// items a "Trash/" path prefix.
				const topItems = Array.isArray(binder.BinderItem)
					? binder.BinderItem
					: binder.BinderItem
						? [binder.BinderItem]
						: [];

				for (const item of topItems) {
					const isTrash = item.Type === 'TrashFolder';
					if (isTrash && !includeTrash) continue;
					await this.collectDocuments(item, isTrash ? 'Trash/' : '', flatList);
				}

				// Alternate trash representation: a SearchResults container.
				if (includeTrash && binder.SearchResults) {
					const searchResults = Array.isArray(binder.SearchResults)
						? binder.SearchResults
						: [binder.SearchResults];

					for (const searchResult of searchResults) {
						const children = searchResult.Children?.BinderItem;
						if (!children) continue;
						const items = Array.isArray(children) ? children : [children];
						for (const child of items) {
							await this.collectDocuments(child, 'Trash/', flatList);
						}
					}
				}
			}

			return flatList;
		} catch (error) {
			throw handleError(error, 'getAllDocuments');
		}
	}

	/**
	 * Flat list of every document beneath the folder with the given id
	 * (descendants only, not the folder itself), each with its path threaded.
	 * Returns an empty list when the id is unknown or names a leaf document.
	 */
	async getDocumentsUnderFolder(folderId: string): Promise<ScrivenerDocument[]> {
		try {
			await this.getProjectStructure();
			const out: ScrivenerDocument[] = [];

			const binder = this.projectStructure?.ScrivenerProject?.Binder as
				BinderContainer | undefined;
			if (!binder) return out;

			const folder = findBinderItemById(binder, folderId);
			const children = folder?.Children?.BinderItem;
			if (!children) return out;

			const basePath = `${folder?.Title ?? ''}/`;
			const items = Array.isArray(children) ? children : [children];
			for (const child of items) {
				await this.collectDocuments(child, basePath, out);
			}
			return out;
		} catch (error) {
			throw handleError(error, 'getDocumentsUnderFolder');
		}
	}

	async getProjectStructure(includeTrash = false): Promise<ScrivenerDocument[]> {
		if (!this.projectStructure?.ScrivenerProject?.Binder) {
			throw createError(ErrorCode.INVALID_STATE, undefined, 'Project not loaded');
		}

		const binder = this.projectStructure.ScrivenerProject.Binder as BinderContainer;
		const documents: ScrivenerDocument[] = [];

		const binderItems = Array.isArray(binder.BinderItem)
			? binder.BinderItem
			: binder.BinderItem
				? [binder.BinderItem]
				: [];

		// Walk every top-level binder item (each becomes a document, folders recurse
		// into their children), not just the first one — real binders lead with
		// template/front-matter docs and spread content across several top-level
		// folders (Draft/Manuscript, Research, ...). A top-level trash folder is only
		// surfaced when includeTrash, with a "Trash/" path prefix.
		for (const item of binderItems) {
			const isTrash = item.Type === 'TrashFolder';
			if (isTrash && !includeTrash) continue;
			const prefix = isTrash ? 'Trash/' : '';
			const doc = await this.binderItemToDocument(item, prefix);
			documents.push(doc);
			if (item.Children?.BinderItem) {
				doc.children = [];
				await this.buildDocumentTree(
					item.Children,
					doc.children,
					prefix || `${item.Title}/`,
					this.childDefaultOf(item) ?? doc.sectionTypeId
				);
			}
		}

		if (includeTrash) {
			const searchResults = Array.isArray(binder.SearchResults)
				? binder.SearchResults
				: binder.SearchResults
					? [binder.SearchResults]
					: [];

			if (searchResults[0]?.Children?.BinderItem) {
				await this.buildDocumentTree(searchResults[0].Children, documents, 'Trash/');
			}
		}

		return documents;
	}

	/**
	 * Recursively append an item and all its descendants to a flat list,
	 * threading the folder path so each document's path reflects its ancestry.
	 */
	private async collectDocuments(
		item: BinderItem,
		parentPath: string,
		out: ScrivenerDocument[],
		inheritedSectionType?: string
	): Promise<void> {
		const doc = await this.binderItemToDocument(item, parentPath, inheritedSectionType);
		out.push(doc);

		const children = item.Children?.BinderItem;
		if (!children) return;
		const childPath = `${parentPath}${item.Title}/`;
		const childDefault = this.childDefaultOf(item) ?? doc.sectionTypeId;
		const items = Array.isArray(children) ? children : [children];
		for (const child of items) {
			await this.collectDocuments(child, childPath, out, childDefault);
		}
	}

	private async buildDocumentTree(
		container: BinderContainer,
		documents: ScrivenerDocument[],
		parentPath: string,
		inheritedSectionType?: string
	): Promise<void> {
		if (!container.BinderItem) return;

		const items = Array.isArray(container.BinderItem)
			? container.BinderItem
			: [container.BinderItem];
		for (const item of items) {
			const doc = await this.binderItemToDocument(item, parentPath, inheritedSectionType);
			documents.push(doc);

			if (item.Children?.BinderItem) {
				const childPath = `${parentPath}${item.Title}/`;
				doc.children = [];
				await this.buildDocumentTree(
					item.Children,
					doc.children,
					childPath,
					this.childDefaultOf(item) ?? doc.sectionTypeId
				);
			}
		}
	}

	/** A folder's own ChildDefault, if it sets one for its descendants. */
	private childDefaultOf(item: BinderItem): string | undefined {
		if (!item.MetaData) return undefined;
		const metadata = Array.isArray(item.MetaData) ? item.MetaData[0] : item.MetaData;
		const sectionType = (metadata as { SectionType?: unknown }).SectionType;
		return sectionType && typeof sectionType === 'object'
			? (sectionType as { ChildDefault?: string }).ChildDefault
			: undefined;
	}

	/**
	 * Scrivener 3 stores a document's synopsis/notes as files under
	 * Files/Data/<UUID>/ (synopsis.txt, notes.rtf) -- the .scrivx MetaData
	 * Synopsis/Notes fields read by binderItemToDocument below are effectively
	 * always empty in real projects. Disk content wins when present; the
	 * MetaData fields remain a fallback for the (untested-as-existing) case
	 * where some other client populates them instead.
	 */
	private async readSynopsisAndNotesFromDisk(
		documentId: string
	): Promise<{ synopsis?: string; notes?: string }> {
		const [synopsis, notes] = await Promise.all([
			(async () => {
				const filePath = getSynopsisPath(this.projectPath, documentId);
				if (!(await FileUtils.exists(filePath))) return undefined;
				const text = await safeReadFile(filePath, 'utf-8');
				return text || undefined;
			})(),
			(async () => {
				const filePath = getNotesPath(this.projectPath, documentId);
				if (!(await FileUtils.exists(filePath))) return undefined;
				const rtf = await this.rtfHandler.readRTF(filePath);
				return rtf.plainText || undefined;
			})(),
		]);

		return { synopsis, notes };
	}

	private async binderItemToDocument(
		item: BinderItem,
		parentPath: string,
		inheritedSectionType?: string
	): Promise<ScrivenerDocument> {
		const doc: ScrivenerDocument = {
			id: item.UUID || '',
			title: item.Title || 'Untitled',
			type: item.Type as
				| typeof DOCUMENT_TYPES.TEXT
				| typeof DOCUMENT_TYPES.FOLDER
				| typeof DOCUMENT_TYPES.OTHER,
			path: `${parentPath}${item.Title}`,
		};

		if (item.MetaData) {
			const metadata = Array.isArray(item.MetaData)
				? item.MetaData[0]
				: (item.MetaData as MetaDataItem);

			// A plain string is the item's own override; an object means only
			// ChildDefault was set (a folder's default for its children, not for
			// itself), so this item still falls back to the inherited value.
			const ownSectionType =
				typeof metadata.SectionType === 'string' ? metadata.SectionType : undefined;
			const resolvedSectionType = ownSectionType ?? inheritedSectionType;
			if (resolvedSectionType) {
				doc.sectionTypeId = resolvedSectionType;
			}

			if (metadata.Synopsis) {
				doc.synopsis = metadata.Synopsis;
			}

			if (metadata.Notes) {
				doc.notes = metadata.Notes;
			}

			if (metadata.Label) {
				doc.label = metadata.Label;
			}

			if (metadata.Status) {
				doc.status = metadata.Status;
			}

			// Absent IncludeInCompile means "include" in Scrivener; only an explicit
			// "No" excludes. Populate the field so compile and stats can honor it.
			if (metadata.IncludeInCompile !== undefined) {
				doc.includeInCompile = metadata.IncludeInCompile !== 'No';
			}

			if (metadata.Keywords) {
				doc.keywords =
					typeof metadata.Keywords === 'string' ? [metadata.Keywords] : metadata.Keywords;
			}

			if (metadata.CustomMetaData?.MetaDataItem) {
				doc.customMetadata = {};
				const items = Array.isArray(metadata.CustomMetaData.MetaDataItem)
					? metadata.CustomMetaData.MetaDataItem
					: [metadata.CustomMetaData.MetaDataItem];

				for (const customItem of items) {
					const itemId = customItem.ID;
					const itemValue = customItem.Value;
					if (itemId && itemValue && typeof itemValue === 'string') {
						doc.customMetadata[itemId] = itemValue;
					}
				}
			}
		}

		if (doc.id) {
			const fromDisk = await this.readSynopsisAndNotesFromDisk(doc.id);
			if (fromDisk.synopsis !== undefined) doc.synopsis = fromDisk.synopsis;
			if (fromDisk.notes !== undefined) doc.notes = fromDisk.notes;
		}

		return doc;
	}
}
