import { DOCUMENT_TYPES } from '../core/constants.js';
import { getLogger } from '../core/logger.js';
import { createError, ErrorCode } from '../core/errors.js';
import type { WriteFidelityReport } from '../project-types.js';
import type { DocumentManager } from './document-manager.js';
import { RTFHandler } from './parsers/rtf-handler.js';
import { spliceRtfText, describeReplacedConstructs } from './parsers/rtf-splice.js';
import { isProjectOpenInScrivener } from '../utils/scrivener-app.js';
import {
	createDocument as createDocumentUtil,
	type DocumentOperationContext,
} from '../utils/document-operations.js';
import type { RTFContent } from './parsers/rtf-handler.js';
import type { HolographicMemorySystem } from './memory/hhm/holographic-memory-system.js';
import type { ScrivenerProject } from '../scrivener-project.js';

const logger = getLogger('scrivener-project');

/** Document writes and creation, including the fidelity-preserving splice path. */
export class ProjectWriter {
	private openStateCache?: { state: 'open' | 'closed' | 'unknown'; expiresAt: number };

	constructor(
		private readonly projectPath: string,
		private readonly documentManager: DocumentManager,
		private readonly hhmSystem: HolographicMemorySystem | undefined,
		private readonly saveProject: () => Promise<void>,
		private readonly markDocumentChanged: (documentId: string) => void,
		private readonly getDocumentInfo: ScrivenerProject['getDocumentInfo'],
		private readonly takeSnapshot: ScrivenerProject['takeSnapshot']
	) {}

	/**
	 * Guard against writing while the project is open in Scrivener. Scrivener
	 * holds the manuscript in memory and rewrites it on save, so an external edit
	 * to a live project can be silently clobbered. Throws when the project is
	 * detected open and `force` is false; allows the write when detection is
	 * unavailable or ambiguous (never a false positive). The probe result is
	 * cached briefly so a batch of writes spawns at most one detection call.
	 */
	async ensureWritable(force = false): Promise<void> {
		if (force) return;
		const now = Date.now();
		if (!this.openStateCache || this.openStateCache.expiresAt <= now) {
			const state = await isProjectOpenInScrivener(this.projectPath);
			this.openStateCache = { state, expiresAt: now + 5000 };
		}
		if (this.openStateCache.state === 'open') {
			throw createError(
				ErrorCode.INVALID_STATE,
				{ projectPath: this.projectPath },
				'This project is currently open in Scrivener. Editing it now risks your changes ' +
					'being overwritten when Scrivener next saves. Close the project in Scrivener, ' +
					'or pass force: true to write anyway.'
			);
		}
	}

	async writeDocument(documentId: string, content: string | RTFContent): Promise<void> {
		// Immediate: a single explicit document write must be durable and visible
		// to a subsequent read. The batched/queued path only reaches disk on a 5s
		// timer, a full queue, or close(), which breaks read-your-own-write.
		await this.documentManager.writeDocument(documentId, content, true);
		this.markDocumentChanged(documentId);

		// Update HHM if available
		if (this.hhmSystem) {
			try {
				const doc = await this.getDocumentInfo(documentId);
				if (doc.document) {
					// Ensure we have plain text content
					let plainText = '';
					if (typeof content === 'string') {
						plainText = content;
					} else {
						plainText = content.plainText;
					}

					// Update document object with new content
					const updatedDoc = { ...doc.document, content: plainText };
					await this.hhmSystem.memorizeDocument(updatedDoc);
				}
			} catch (error) {
				logger.warn('Failed to update HHM memory for document', { documentId, error });
			}
		}
	}

	/**
	 * Replace a document's text while preserving all Scrivener RTF the edit did not
	 * touch (stylesheet, style refs, images, footnotes, `\Scrv_` groups). Splices the
	 * changed span into the original raw RTF and commits ONLY if re-parsing the result
	 * yields exactly the intended text; otherwise it snapshots and falls back to a full
	 * regenerate. When the changed span dropped non-round-trippable content it also
	 * snapshots first, so the writer always has a native rollback point. Returns a
	 * report of what happened.
	 */
	async writeDocumentPreserving(
		documentId: string,
		newText: string
	): Promise<WriteFidelityReport> {
		const oldRaw = await this.documentManager.readDocumentRaw(documentId);

		// New/empty document: nothing to preserve or lose — write plainly.
		if (!oldRaw) {
			await this.writeDocument(documentId, newText);
			return { documentId, mode: 'created', atRisk: [] };
		}

		const rtf = new RTFHandler();
		const canonical = (await rtf.parseRTF(oldRaw)).plainText.trim();
		const intended = newText.trim();
		const splice = spliceRtfText(oldRaw, canonical, intended);

		// Commit the splice only if the result provably reads back as the intended
		// text — this gate makes a scanner imperfection a fallback, never a corruption.
		if (splice) {
			const roundTrip = (await rtf.parseRTF(splice.rtf)).plainText.trim();
			if (roundTrip === intended) {
				const atRisk = describeReplacedConstructs(splice.replacedRaw);
				let snapshotId: string | undefined;
				if (atRisk.length > 0) {
					snapshotId = (await this.takeSnapshot(documentId, 'Before AI edit')).snapshotId;
				}
				await this.documentManager.writeRawContent(documentId, splice.rtf);
				this.markDocumentChanged(documentId);
				return { documentId, mode: 'preserved', snapshotId, atRisk };
			}
		}

		// Fallback: cannot safely splice. Snapshot first (native rollback), then
		// regenerate from plain text — which drops formatting/annotations/images.
		const snapshotId = (await this.takeSnapshot(documentId, 'Before AI edit')).snapshotId;
		await this.writeDocument(documentId, newText);
		return {
			documentId,
			mode: 'regenerated',
			snapshotId,
			atRisk: ['formatting, styles, images, footnotes, and annotations were not preserved'],
		};
	}

	async createDocument(
		title: string,
		content = '',
		parentId?: string,
		type: 'Text' | 'Folder' = DOCUMENT_TYPES.TEXT
	): Promise<string> {
		// Use unified document creation utility with transaction support
		const context: DocumentOperationContext = {
			projectStructure: this.documentManager.getProjectStructureData(),
			projectPath: this.projectPath,
			writeDocument: (id, content) => this.documentManager.writeDocument(id, content),
			saveProject: () => this.saveProject(),
		};

		const result = await createDocumentUtil({ title, content, parentId, type }, context);

		// Add to HHM if available
		if (this.hhmSystem && result.id) {
			try {
				const doc = await this.getDocumentInfo(result.id);
				if (doc.document) {
					const docWithContent = { ...doc.document, content };
					await this.hhmSystem.memorizeDocument(docWithContent);
				}
			} catch (error) {
				logger.warn('Failed to add new document to HHM', { documentId: result.id, error });
			}
		}

		return result.id;
	}
}
