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
import {
	documentRevision,
	type CommitOptions,
	type MutationRecord,
} from './editorial/mutation-coordinator.js';

const logger = getLogger('scrivener-project');
const MAX_TEXT_LENGTH = 10_000_000;

export interface WriteOptions extends CommitOptions {
	force?: boolean;
	allowFormattingLoss?: boolean;
}

export interface PreparedDocument {
	documentId: string;
	beforeRevision: string;
	beforeText: string;
	afterText: string;
	raw: string;
	fidelity: WriteFidelityReport;
}

export class ProjectWriter {
	constructor(
		private readonly projectPath: string,
		private readonly documentManager: DocumentManager,
		private readonly hhmSystem: HolographicMemorySystem | undefined,
		private readonly saveProject: () => Promise<void>,
		private readonly markDocumentChanged: (documentId: string) => void,
		private readonly getDocumentInfo: ScrivenerProject['getDocumentInfo'],
		_takeSnapshot: ScrivenerProject['takeSnapshot']
	) {}

	async ensureWritable(force = false): Promise<void> {
		if (force) return;
		const state = await isProjectOpenInScrivener(this.projectPath);
		if (state !== 'closed') {
			throw createError(
				ErrorCode.INVALID_STATE,
				{},
				state === 'open'
					? 'This project is open in Scrivener. Close it before applying edits, or explicitly pass force: true to acknowledge the native application overwrite risk.'
					: 'Scrivener open-project detection is unavailable or ambiguous. Verify the project is closed and explicitly pass force: true to acknowledge this uncertainty. Unsaved native buffers cannot be inspected.'
			);
		}
	}

	async readRevision(documentId: string): Promise<string> {
		return this.documentManager.readDocumentRevision(documentId);
	}

	async prepareDocument(
		documentId: string,
		newText: string,
		expectedRevision?: string
	): Promise<PreparedDocument> {
		if (typeof newText !== 'string' || newText.length > MAX_TEXT_LENGTH)
			throw new Error('Document text exceeds the supported length');
		const observedRevision =
			expectedRevision ?? this.documentManager.getObservedRevision(documentId);
		const oldRaw = (await this.documentManager.getMutationCoordinator().readRaw(documentId))
			.raw;
		const beforeRevision = documentRevision(oldRaw);
		if (observedRevision !== undefined && observedRevision !== beforeRevision)
			throw new Error('Stale document revision; refresh and review the saved changes');
		const handler = new RTFHandler();
		const beforeText = oldRaw ? (await handler.parseRTF(oldRaw)).plainText : '';
		const afterText = newText;
		if (!oldRaw) {
			const raw = handler.convertToRTF(newText);
			if ((await handler.parseRTF(raw)).plainText !== afterText)
				throw new Error(
					'Proposed text cannot round-trip exactly through the RTF parser; check surrounding whitespace'
				);
			return {
				documentId,
				beforeRevision,
				beforeText,
				afterText,
				raw,
				fidelity: { documentId, mode: 'created', atRisk: [] },
			};
		}
		const splice = spliceRtfText(oldRaw, beforeText, afterText);
		if (splice && (await handler.parseRTF(splice.rtf)).plainText === afterText) {
			return {
				documentId,
				beforeRevision,
				beforeText,
				afterText,
				raw: splice.rtf,
				fidelity: {
					documentId,
					mode: 'preserved',
					atRisk: describeReplacedConstructs(splice.replacedRaw),
				},
			};
		}
		const raw = handler.convertToRTF(newText);
		if ((await handler.parseRTF(raw)).plainText !== afterText)
			throw new Error(
				'Proposed text cannot round-trip exactly through the RTF parser; check surrounding whitespace'
			);
		return {
			documentId,
			beforeRevision,
			beforeText,
			afterText,
			raw,
			fidelity: {
				documentId,
				mode: 'regenerated',
				atRisk: [
					'formatting, styles, images, footnotes, and annotations will not be preserved',
				],
			},
		};
	}

	async commitPrepared(
		prepared: PreparedDocument,
		options: WriteOptions = {}
	): Promise<{ mutation: MutationRecord; fidelity: WriteFidelityReport }> {
		if (prepared.fidelity.atRisk.length && options.allowFormattingLoss !== true)
			throw new Error(
				`Formatting loss requires acknowledgment before application: ${prepared.fidelity.atRisk.join(', ')}`
			);
		if (
			options.expectedRevision !== undefined &&
			options.expectedRevision !== prepared.beforeRevision
		)
			throw new Error('Prepared document does not match the expected revision');
		await this.ensureWritable(options.force);
		const mutation = await this.documentManager.writeRawContent(
			prepared.documentId,
			prepared.raw,
			{ ...options, expectedRevision: prepared.beforeRevision }
		);
		this.documentManager.clearCache(prepared.documentId);
		this.markDocumentChanged(prepared.documentId);
		if (this.hhmSystem) {
			try {
				const info = await this.getDocumentInfo(prepared.documentId);
				if (info.document)
					await this.hhmSystem.memorizeDocument({
						...info.document,
						content: prepared.afterText,
					});
			} catch {
				logger.warn('Document committed but optional manuscript memory refresh failed');
			}
		}
		return { mutation, fidelity: { ...prepared.fidelity, snapshotId: mutation.snapshotId } };
	}

	async writeDocument(
		documentId: string,
		content: string | RTFContent,
		options: WriteOptions = {}
	): Promise<void> {
		if (typeof content === 'string') {
			await this.writeDocumentPreserving(documentId, content, options);
			return;
		}
		const prepared = await this.prepareDocument(
			documentId,
			content.plainText,
			options.expectedRevision
		);
		prepared.raw = new RTFHandler().convertToRTF(content);
		prepared.fidelity = {
			documentId,
			mode: 'regenerated',
			atRisk: prepared.beforeText
				? ['original RTF constructs will be replaced by the supplied formatted content']
				: [],
		};
		await this.commitPrepared(prepared, options);
	}

	async writeDocumentPreserving(
		documentId: string,
		newText: string,
		options: WriteOptions = {}
	): Promise<WriteFidelityReport> {
		const prepared = await this.prepareDocument(documentId, newText, options.expectedRevision);
		return (await this.commitPrepared(prepared, options)).fidelity;
	}

	async restoreRaw(
		documentId: string,
		raw: string,
		options: WriteOptions
	): Promise<MutationRecord> {
		const handler = new RTFHandler();
		const currentRaw = (await this.documentManager.getMutationCoordinator().readRaw(documentId))
			.raw;
		const prepared: PreparedDocument = {
			documentId,
			beforeRevision: documentRevision(currentRaw),
			beforeText: (await handler.parseRTF(currentRaw)).plainText,
			afterText: (await handler.parseRTF(raw)).plainText,
			raw,
			fidelity: { documentId, mode: 'preserved', atRisk: [] },
		};
		return (await this.commitPrepared(prepared, options)).mutation;
	}

	async createDocument(
		title: string,
		content = '',
		parentId?: string,
		type: 'Text' | 'Folder' = DOCUMENT_TYPES.TEXT,
		options: Pick<WriteOptions, 'force'> = {}
	): Promise<string> {
		await this.ensureWritable(options.force);
		const context: DocumentOperationContext = {
			projectStructure: this.documentManager.getProjectStructureData(),
			projectPath: this.projectPath,
			writeDocument: (id, text) => this.documentManager.writeDocument(id, text, true),
			saveProject: () => this.saveProject(),
		};
		const result = await createDocumentUtil({ title, content, parentId, type }, context);
		if (this.hhmSystem && result.id) {
			try {
				const info = await this.getDocumentInfo(result.id);
				if (info.document)
					await this.hhmSystem.memorizeDocument({ ...info.document, content });
			} catch {
				logger.warn('Document created but optional manuscript memory refresh failed');
			}
		}
		return result.id;
	}
}
