/**
 * Reads Scrivener 3 document snapshots from a `.scriv` package. Snapshots live
 * under `Snapshots/<DOC-UUID>.snapshots/`, each containing an `index.xml`
 * (per-snapshot `<Title>`/`<Date>` metadata) and one RTF file per snapshot whose
 * name encodes the snapshot timestamp (`YYYY-MM-DD-HH-MM-SS-ZZZZ.rtf`). Scrivener
 * publishes no schema for these files, so every accessor is defensive: missing
 * directories, absent/renamed elements, and index/RTF count mismatches all
 * degrade to a best-effort result rather than throwing. Read-only.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { parseStringPromise } from 'xml2js';
import { isValidUUID } from '../utils/common.js';
import { getLogger } from '../core/logger.js';

const logger = getLogger('snapshots');

/** One snapshot of a single document. */
export interface SnapshotEntry {
	/** UUID of the document this snapshot belongs to. */
	documentId: string;
	/**
	 * Stable id for fetching the snapshot's text: the RTF filename stem, which
	 * encodes the snapshot timestamp (e.g. `2025-10-27-02-20-40-0700`).
	 */
	snapshotId: string;
	/** User-assigned or Scrivener-generated title, `''` when none is recorded. */
	title: string;
	/**
	 * Snapshot date as stored in `index.xml` (`YYYY-MM-DD HH:MM:SS ±ZZZZ`). Falls
	 * back to the RTF filename stem when the index is absent or shorter than the
	 * set of RTF files.
	 */
	date: string;
}

/** xml2js options matched to the rest of the codebase (see compile-settings). */
const PARSE_OPTS = { explicitArray: false, mergeAttrs: true } as const;

/** Directory holding one document's snapshots, or undefined for an invalid id. */
function snapshotDir(projectPath: string, documentId: string): string | undefined {
	if (!isValidUUID(documentId)) return undefined;
	return path.join(projectPath, 'Snapshots', `${documentId}.snapshots`);
}

/** Coerce xml2js's single-or-array-or-missing shape into a plain array. */
function asArray<T>(value: T | T[] | undefined | null): T[] {
	if (value === undefined || value === null) return [];
	return Array.isArray(value) ? value : [value];
}

function textOf(node: unknown): string {
	if (typeof node === 'string') return node.trim();
	if (node && typeof node === 'object') {
		const underscore = (node as { _?: unknown })._;
		if (typeof underscore === 'string') return underscore.trim();
	}
	return '';
}

/**
 * Parse a snapshot `index.xml` into ordered `{ title, date }` metadata. Returns
 * an empty array for anything that isn't a `<Snapshots>` document with entries.
 */
export async function parseSnapshotIndex(
	xml: string
): Promise<Array<{ title: string; date: string }>> {
	let parsed: unknown;
	try {
		parsed = await parseStringPromise(xml, PARSE_OPTS);
	} catch (error) {
		logger.warn('snapshot index.xml unparseable; ignoring', {
			error: error instanceof Error ? error.message : String(error),
		});
		return [];
	}

	const root = (parsed as { Snapshots?: { Snapshot?: unknown } })?.Snapshots;
	return asArray(root?.Snapshot).map((raw) => {
		const rec = (raw && typeof raw === 'object' ? raw : {}) as {
			Title?: unknown;
			Date?: unknown;
		};
		return { title: textOf(rec.Title), date: textOf(rec.Date) };
	});
}

/** List the RTF snapshot files in a directory, sorted chronologically by name. */
async function listSnapshotRtfStems(dir: string): Promise<string[]> {
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return []; // no snapshots directory for this document
	}
	return names
		.filter((n) => n.toLowerCase().endsWith('.rtf'))
		.map((n) => n.slice(0, -'.rtf'.length))
		.sort(); // filenames are ISO-ordered, so lexical sort is chronological
}

/**
 * List one document's snapshots (metadata only). The RTF files are the ground
 * truth for what snapshots exist; `index.xml` supplies title/date, zipped in
 * chronological order. Returns `[]` when the document has no snapshots.
 */
export async function listDocumentSnapshots(
	projectPath: string,
	documentId: string
): Promise<SnapshotEntry[]> {
	const dir = snapshotDir(projectPath, documentId);
	if (!dir) return [];

	const stems = await listSnapshotRtfStems(dir);
	if (stems.length === 0) return [];

	let index: Array<{ title: string; date: string }> = [];
	try {
		const xml = await fs.readFile(path.join(dir, 'index.xml'), 'utf-8');
		index = await parseSnapshotIndex(xml);
	} catch {
		// index.xml missing/unreadable: expose the RTF files with derived dates.
	}

	return stems.map((snapshotId, i) => {
		const meta = index[i];
		return {
			documentId,
			snapshotId,
			title: meta?.title ?? '',
			date: meta?.date || snapshotId,
		};
	});
}

/**
 * List every document that has snapshots and its snapshot entries. Scans the
 * top-level `Snapshots/` directory; returns `[]` when the project has none.
 */
export async function listAllSnapshots(projectPath: string): Promise<SnapshotEntry[]> {
	let names: string[];
	try {
		names = await fs.readdir(path.join(projectPath, 'Snapshots'));
	} catch {
		return [];
	}

	const results: SnapshotEntry[] = [];
	for (const name of names) {
		if (!name.endsWith('.snapshots')) continue;
		const documentId = name.slice(0, -'.snapshots'.length);
		results.push(...(await listDocumentSnapshots(projectPath, documentId)));
	}
	return results;
}

/**
 * Locate a single snapshot by id, returning its metadata and the absolute path
 * to its RTF file. Validates that `snapshotId` names an actual snapshot of
 * `documentId`: unknown ids (including any path-traversal attempt) resolve to
 * `undefined` rather than constructing a path outside the enumerated snapshot
 * set. The `rtfPath` is always built from an id that came from `readdir`, never
 * from caller input.
 */
export async function findSnapshot(
	projectPath: string,
	documentId: string,
	snapshotId: string
): Promise<{ entry: SnapshotEntry; rtfPath: string } | undefined> {
	const dir = snapshotDir(projectPath, documentId);
	if (!dir) return undefined;
	const entry = (await listDocumentSnapshots(projectPath, documentId)).find(
		(s) => s.snapshotId === snapshotId
	);
	if (!entry) return undefined;
	return { entry, rtfPath: path.join(dir, `${entry.snapshotId}.rtf`) };
}
