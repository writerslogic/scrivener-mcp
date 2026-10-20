import { getLogger } from '../core/logger.js';
import type { CompilationService } from './compilation-service.js';
import { documentIndexer } from './document-indexer.js';
import type { DocumentManager } from './document-manager.js';
import type { DocumentInfo, ProjectStructure, ScrivenerDocument } from '../types/index.js';

const logger = getLogger('scrivener-project');

/** Per-document lookups: info with ancestry, limited structure views, annotations. */
export class ProjectDocumentInfo {
	constructor(
		private readonly documentManager: DocumentManager,
		private readonly compilationService: CompilationService,
		private readonly getProjectStructure: (
			includeTrash?: boolean
		) => Promise<ScrivenerDocument[]>,
		private readonly isIndexInitialized: () => boolean
	) {}

	private get indexInitialized(): boolean {
		return this.isIndexInitialized();
	}

	// Additional methods
	async getDocumentInfo(documentId: string): Promise<{
		document: ScrivenerDocument | null;
		path: Array<{ id: string; title: string; type: string }>;
		metadata: Record<string, string>;
		location: 'active' | 'trash' | 'unknown';
	}> {
		// Use document indexer for O(1) lookup if available
		if (this.indexInitialized) {
			const docInfo = documentIndexer.getDocumentInfo(documentId);
			if (docInfo) {
				const metadata: Record<string, string> = {};
				if (docInfo.document.synopsis) metadata.synopsis = docInfo.document.synopsis;
				if (docInfo.document.notes) metadata.notes = docInfo.document.notes;
				if (docInfo.document.keywords && docInfo.document.keywords.length > 0) {
					metadata.keywords = docInfo.document.keywords.join(', ');
				}
				if (docInfo.document.status) metadata.status = docInfo.document.status;
				if (docInfo.document.label) metadata.label = docInfo.document.label;

				return {
					document: docInfo.document,
					path: docInfo.path,
					metadata,
					location: docInfo.location,
				};
			}
		}

		// Fallback to tree search if index not available or document not found
		const structure = await this.getProjectStructure(true);
		let foundDoc: ScrivenerDocument | null = null;
		let path: Array<{ id: string; title: string; type: string }> = [];
		let location: 'active' | 'trash' | 'unknown' = 'unknown';

		const searchInDocs = (
			docs: ScrivenerDocument[],
			currentPath: Array<{ id: string; title: string; type: string }>
		): boolean => {
			for (const doc of docs) {
				const newPath = [...currentPath, { id: doc.id, title: doc.title, type: doc.type }];

				if (doc.id === documentId) {
					foundDoc = doc;
					path = newPath;
					return true;
				}

				if (doc.children && searchInDocs(doc.children, newPath)) {
					return true;
				}
			}
			return false;
		};

		if (searchInDocs(structure, [])) {
			location = 'active';
		}

		const metadata: Record<string, string> = {};
		if (foundDoc) {
			const doc = foundDoc as ScrivenerDocument;
			if (doc.synopsis) metadata.synopsis = doc.synopsis;
			if (doc.notes) metadata.notes = doc.notes;
			if (doc.label) metadata.label = doc.label;
			if (doc.status) metadata.status = doc.status;
			if (doc.keywords && doc.keywords.length > 0) {
				metadata.keywords = doc.keywords.join(', ');
			}
			if (doc.includeInCompile !== undefined) {
				metadata.includeInCompile = doc.includeInCompile ? 'true' : 'false';
			}

			if (doc.customMetadata) {
				Object.assign(metadata, doc.customMetadata);
			}
		}

		return { document: foundDoc, path, metadata, location };
	}

	async getProjectStructureLimited(options?: {
		maxDepth?: number;
		folderId?: string;
		includeTrash?: boolean;
		summaryOnly?: boolean;
	}): Promise<ProjectStructure> {
		const structure = await this.getProjectStructure(options?.includeTrash);

		// Convert ScrivenerDocument[] to ProjectStructure format. Root is a synthetic
		// wrapper over every top-level item, not just structure[0] — otherwise the
		// binder collapses to its first entry.
		const root = {
			id: 'root',
			title: 'Project Root',
			type: 'Folder' as const,
			path: '',
			children: structure,
		};

		const convertToDocumentInfo = (doc: ScrivenerDocument): DocumentInfo => ({
			...doc,
			path: typeof doc.path === 'string' ? doc.path.split('/') : doc.path,
			children: doc.children ? doc.children.map(convertToDocumentInfo) : undefined,
		});

		const draft = structure.find((doc) => doc.title === 'Manuscript' || doc.title === 'Draft');
		const research = structure.find((doc) => doc.title === 'Research');
		const trash = options?.includeTrash
			? structure.find((doc) => doc.title === 'Trash')
			: undefined;

		return {
			root: convertToDocumentInfo(root),
			draft: draft ? convertToDocumentInfo(draft) : undefined,
			research: research ? convertToDocumentInfo(research) : undefined,
			trash: trash ? convertToDocumentInfo(trash) : undefined,
			templates: [],
		};
	}

	async getDocumentAnnotations(documentId: string): Promise<Map<string, string>> {
		try {
			// Get the raw RTF content for the document
			const rtfContent = await this.documentManager.readDocumentRaw(documentId);

			// Extract annotations using the RTF handler
			return this.compilationService.extractAnnotations(rtfContent);
		} catch (error) {
			logger.warn(`Failed to extract annotations for document ${documentId}`, { error });
			return new Map<string, string>();
		}
	}
}
