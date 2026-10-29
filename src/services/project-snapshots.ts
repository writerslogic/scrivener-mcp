import { createError, ErrorCode } from '../core/errors.js';
import {
	listAllSnapshots,
	listDocumentSnapshots,
	findSnapshot,
	createSnapshot,
	type SnapshotEntry,
} from './snapshots.js';
import { RTFHandler } from './parsers/rtf-handler.js';
import { getAccurateWordCount } from '../utils/text-metrics.js';
import { diffParagraphs, diffWordCounts } from '../utils/text-diff.js';
import type { ScrivenerDocument } from '../types/index.js';
import type { DocumentSnapshots, SnapshotContent, SnapshotComparison } from '../project-types.js';
import { MutationCoordinator } from './editorial/mutation-coordinator.js';

/** Snapshot listing, reading, creation and comparison for a project. */
export class ProjectSnapshots {
	constructor(
		private readonly projectPath: string,
		private readonly getAllDocuments: (includeTrash?: boolean) => Promise<ScrivenerDocument[]>,
		private readonly readDocument: (documentId: string) => Promise<string>
	) {}

	/**
	 * List document snapshots stored in the project's `Snapshots/` directory,
	 * for one document (`documentId`) or the whole project. Read-only metadata:
	 * each entry carries the owning document's id and title, the snapshot id
	 * (used by `readSnapshot`), its recorded title, and its date. Returns an
	 * empty array when the project or document has no snapshots.
	 */
	async listSnapshots(documentId?: string): Promise<DocumentSnapshots[]> {
		const entries = documentId
			? await listDocumentSnapshots(this.projectPath, documentId)
			: await listAllSnapshots(this.projectPath);
		if (entries.length === 0) return [];

		const titles = new Map<string, string>();
		for (const doc of await this.getAllDocuments(true)) {
			titles.set(doc.id, doc.title);
		}

		const grouped = new Map<string, DocumentSnapshots>();
		for (const entry of entries) {
			let group = grouped.get(entry.documentId);
			if (!group) {
				group = {
					documentId: entry.documentId,
					documentTitle: titles.get(entry.documentId),
					snapshots: [],
				};
				grouped.set(entry.documentId, group);
			}
			group.snapshots.push({
				snapshotId: entry.snapshotId,
				title: entry.title,
				date: entry.date,
			});
		}
		return Array.from(grouped.values());
	}

	/**
	 * Create a Scrivener-native snapshot of a document's current content, restorable
	 * from Scrivener's own Snapshots browser. Use this before a lossy edit to give
	 * the writer a native rollback point. Requires the document to have content.
	 */
	async takeSnapshot(documentId: string, title = 'Snapshot'): Promise<SnapshotEntry> {
		return createSnapshot(this.projectPath, documentId, title, new Date());
	}

	/**
	 * Read the text of a single snapshot. `snapshotId` must name an actual
	 * snapshot of `documentId` (as returned by `listSnapshots`); unknown ids
	 * throw NOT_FOUND rather than reading outside the snapshot set. Returns the
	 * snapshot's title, date, plain text, and word count.
	 */
	async readSnapshot(documentId: string, snapshotId: string): Promise<SnapshotContent> {
		const found = await findSnapshot(this.projectPath, documentId, snapshotId);
		if (!found) {
			throw createError(
				ErrorCode.NOT_FOUND,
				{ documentId, snapshotId },
				`No snapshot "${snapshotId}" for document ${documentId}`
			);
		}

		const reader = new MutationCoordinator(this.projectPath);
		let raw: string;
		try {
			const saved = await reader.readProjectArtifact(found.rtfPath);
			if (!saved.exists)
				throw createError(ErrorCode.NOT_FOUND, {}, 'Snapshot was removed before it could be read');
			raw = saved.raw;
		} finally {
			await reader.close();
		}
		const { plainText } = await new RTFHandler().parseRTF(raw);
		const text = plainText ?? '';
		return {
			documentId,
			snapshotId,
			title: found.entry.title,
			date: found.entry.date,
			text,
			wordCount: getAccurateWordCount(text),
		};
	}

	/**
	 * Compare a snapshot against the document's current text, or against another
	 * snapshot when `againstSnapshotId` is given. Returns a paragraph-level diff
	 * (added/removed paragraphs) and the net word-count change — the "what did I
	 * change since this version?" question snapshots exist to answer.
	 */
	async compareSnapshot(
		documentId: string,
		snapshotId: string,
		againstSnapshotId?: string
	): Promise<SnapshotComparison> {
		const from = await this.readSnapshot(documentId, snapshotId);

		let toLabel: string;
		let toText: string;
		let toWordCount: number;
		if (againstSnapshotId) {
			const to = await this.readSnapshot(documentId, againstSnapshotId);
			toLabel = againstSnapshotId;
			toText = to.text;
			toWordCount = to.wordCount;
		} else {
			toLabel = 'current';
			toText = await this.readDocument(documentId);
			toWordCount = getAccurateWordCount(toText);
		}

		const diff = diffParagraphs(from.text, toText);
		const words = diffWordCounts(from.text, toText);
		return {
			documentId,
			from: { snapshotId, title: from.title, date: from.date, wordCount: from.wordCount },
			to: { snapshotId: toLabel, wordCount: toWordCount },
			wordDelta: toWordCount - from.wordCount,
			wordsAdded: words.added,
			wordsRemoved: words.removed,
			addedParagraphs: diff.added,
			removedParagraphs: diff.removed,
			unchangedParagraphs: diff.unchanged,
		};
	}
}
