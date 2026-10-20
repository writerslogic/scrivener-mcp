import type { HolographicMemorySystem } from './services/memory/hhm/holographic-memory-system.js';

export interface ScrivenerProjectOptions {
	autoSave?: boolean;
	autoBackup?: boolean;
	cacheSize?: number;
	syncInterval?: number;
	scrivxPath?: string;
	hhmSystem?: HolographicMemorySystem;
}

/** A document and its snapshots, as returned by `listSnapshots`. */
export interface DocumentSnapshots {
	documentId: string;
	documentTitle?: string;
	snapshots: Array<{ snapshotId: string; title: string; date: string }>;
}

/** A single snapshot's metadata and text, as returned by `readSnapshot`. */
export interface SnapshotContent {
	documentId: string;
	snapshotId: string;
	title: string;
	date: string;
	text: string;
	wordCount: number;
}

/** A "where am I?" orientation of the manuscript, from `getManuscriptBriefing`. */
/** Outcome of a fidelity-preserving document write. */
export interface WriteFidelityReport {
	documentId: string;
	/** 'preserved': spliced, untouched RTF kept byte-for-byte. 'regenerated': rebuilt
	 *  from plain text (lossy). 'created': first write, nothing to preserve. */
	mode: 'preserved' | 'regenerated' | 'created';
	/** Id of a snapshot taken before the write when fidelity was at risk. */
	snapshotId?: string;
	/** Human-readable constructs the edit could not preserve (empty on a clean edit). */
	atRisk: string[];
}

export interface ManuscriptBriefing {
	title?: string;
	author?: string;
	words: {
		total: number;
		draftTarget?: number;
		percentToTarget?: number;
		deadline?: string;
	};
	documents: { total: number; folders: number; textDocuments: number };
	averageDocumentLength: number;
	byStatus: Record<string, number>;
	byLabel: Record<string, number>;
	longest: { id: string; title: string; wordCount: number } | null;
	shortest: { id: string; title: string; wordCount: number } | null;
}

/** A paragraph-level comparison between a snapshot and current/another snapshot. */
export interface SnapshotComparison {
	documentId: string;
	from: { snapshotId: string; title: string; date: string; wordCount: number };
	to: { snapshotId: string; wordCount: number };
	wordDelta: number;
	wordsAdded: number;
	wordsRemoved: number;
	addedParagraphs: string[];
	removedParagraphs: string[];
	unchangedParagraphs: number;
}
