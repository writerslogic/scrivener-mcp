/**
 * Reads Scrivener 3 document snapshots from a `.scriv` package. Snapshots live
 * under `Snapshots/<DOC-UUID>.snapshots/`, each containing an `index.xml`
 * (per-snapshot `<Title>`/`<Date>` metadata) and one RTF file per snapshot whose
 * name encodes the snapshot timestamp (`YYYY-MM-DD-HH-MM-SS-ZZZZ.rtf`). Scrivener
 * publishes no schema for these files. Missing snapshots are ordinary absence;
 * unsafe paths and I/O failures are reported explicitly.
 */

import * as fs from 'node:fs/promises';
import * as path from 'path';
import { parseStringPromise } from 'xml2js';
import { isValidUUID, createError, ErrorCode } from '../utils/common.js';
import { getLogger } from '../core/logger.js';
import { safeWriteFile } from '../utils/common.js';
import type { MutationCoordinator } from './editorial/mutation-coordinator.js';

const logger = getLogger('snapshots');
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 10000;

async function withSnapshotReader<T>(
	projectPath: string,
	operation: (reader: MutationCoordinator) => Promise<T>
): Promise<T> {
	const { MutationCoordinator } = await import('./editorial/mutation-coordinator.js');
	const reader = new MutationCoordinator(projectPath);
	try {
		return await operation(reader);
	} finally {
		await reader.close();
	}
}

async function snapshotDirectoryNames(reader: MutationCoordinator, dir: string): Promise<string[]> {
	reader.assertProjectPath(dir);
	try {
		const before = await fs.lstat(dir, { bigint: true });
		if (!before.isDirectory() || before.isSymbolicLink())
			throw new Error('Snapshot container must be a regular directory without symlinks');
		const names: string[] = [];
		const directory = await fs.opendir(dir);
		for await (const entry of directory) {
			if (names.length >= MAX_DIRECTORY_ENTRIES)
				throw new Error('Snapshot directory exceeds 10000 entries');
			names.push(entry.name);
		}
		reader.assertProjectPath(dir);
		const after = await fs.lstat(dir, { bigint: true });
		if (
			!after.isDirectory() || after.isSymbolicLink() ||
			before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs
		)
			throw new Error('Snapshot directory changed while listing; retry');
		return names;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
}

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
	return path.resolve(projectPath, 'Snapshots', `${documentId}.snapshots`);
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
			errorType: error instanceof Error ? error.name : 'UnknownError',
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
async function listSnapshotRtfStems(reader: MutationCoordinator, dir: string): Promise<string[]> {
	const names = await snapshotDirectoryNames(reader, dir);
	const snapshots = names
		.filter((n) => n.toLowerCase().endsWith('.rtf'))
		.sort();
	const identities = new Set<string>();
	for (const name of snapshots) {
		const identity = name.slice(0, -'.rtf'.length);
		if (identities.has(identity)) throw new Error('Snapshot filenames have duplicate identities');
		identities.add(identity);
		const file = path.join(dir, name);
		reader.assertProjectPath(file);
		const entry = await fs.lstat(file);
		if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_SNAPSHOT_BYTES)
			throw new Error('Snapshot must be a regular file within the 64 MiB limit');
	}
	return snapshots.map((name) => name.slice(0, -'.rtf'.length));
}

async function readDocumentSnapshots(
	reader: MutationCoordinator,
	dir: string,
	documentId: string
): Promise<SnapshotEntry[]> {
	const stems = await listSnapshotRtfStems(reader, dir);
	const saved = await reader.readProjectArtifact(path.join(dir, 'index.xml'));
	const index = saved.exists ? await parseSnapshotIndex(saved.raw) : [];
	return stems.map((snapshotId, i) => ({
		documentId,
		snapshotId,
		title: index[i]?.title ?? '',
		date: index[i]?.date || snapshotId,
	}));
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

	return withSnapshotReader(projectPath, (reader) => readDocumentSnapshots(reader, dir, documentId));
}

/**
 * List every document that has snapshots and its snapshot entries. Scans the
 * top-level `Snapshots/` directory; returns `[]` when the project has none.
 */
export async function listAllSnapshots(projectPath: string): Promise<SnapshotEntry[]> {
	return withSnapshotReader(projectPath, async (reader) => {
		const names = await snapshotDirectoryNames(reader, path.resolve(projectPath, 'Snapshots'));
		const results: SnapshotEntry[] = [];
		for (const name of names) {
			if (!name.endsWith('.snapshots')) continue;
			const documentId = name.slice(0, -'.snapshots'.length);
			const dir = snapshotDir(projectPath, documentId);
			if (dir) results.push(...(await readDocumentSnapshots(reader, dir, documentId)));
		}
		return results;
	});
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
	return withSnapshotReader(projectPath, async (reader) => {
		const names = await snapshotDirectoryNames(reader, dir);
		const name = names.find((name) =>
			name.toLowerCase().endsWith('.rtf') && name.slice(0, -'.rtf'.length) === entry.snapshotId
		);
		if (!name) return undefined;
		const rtfPath = path.join(dir, name);
		reader.assertProjectPath(rtfPath);
		return { entry, rtfPath };
	});
}

/** Zero-pad a number to two digits. */
function pad2(n: number): string {
	return n.toString().padStart(2, '0');
}

/**
 * Format a Date into Scrivener's two snapshot timestamp encodings, derived from
 * real snapshots (`2025-10-27 02:20:40 -0700` in index.xml; `2025-10-27-02-20-40-0700`
 * as the RTF filename stem, where the timezone sign doubles as the separator).
 */
function formatSnapshotStamp(date: Date): { stem: string; indexDate: string } {
	const y = date.getFullYear();
	const mo = pad2(date.getMonth() + 1);
	const d = pad2(date.getDate());
	const h = pad2(date.getHours());
	const mi = pad2(date.getMinutes());
	const s = pad2(date.getSeconds());
	// getTimezoneOffset is minutes behind UTC (positive for e.g. PDT), so the
	// displayed sign is inverted: +420 -> "-0700".
	const offset = date.getTimezoneOffset();
	const sign = offset > 0 ? '-' : '+';
	const abs = Math.abs(offset);
	const tz = `${pad2(Math.floor(abs / 60))}${pad2(abs % 60)}`;
	return {
		indexDate: `${y}-${mo}-${d} ${h}:${mi}:${s} ${sign}${tz}`,
		stem: `${y}-${mo}-${d}-${h}-${mi}-${s}${sign}${tz}`,
	};
}

/** Escape the five XML predefined entities for safe inclusion in element text. */
function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

/** Serialize snapshot metadata into Scrivener's index.xml layout (4-space indent). */
function buildSnapshotIndex(entries: Array<{ title: string; date: string }>): string {
	const body = entries
		.map(
			(e) =>
				`    <Snapshot>\n` +
				`        <Title>${escapeXml(e.title)}</Title>\n` +
				`        <Date>${escapeXml(e.date)}</Date>\n` +
				`    </Snapshot>`
		)
		.join('\n');
	return `<?xml version="1.0" encoding="UTF-8"?>\n<Snapshots Version="1.0">\n${body}\n</Snapshots>\n`;
}

/**
 * Create a Scrivener-native snapshot of a document's current content, so the
 * writer can restore it from Scrivener's own Snapshots browser. Copies the live
 * `content.rtf` into `Snapshots/<UUID>.snapshots/<stamp>.rtf` and appends a
 * `<Snapshot>` entry (title + date) to that directory's `index.xml`, preserving
 * any existing snapshots. Throws NOT_FOUND when the document has no content.rtf
 * (nothing to snapshot). The provided `date` defaults to now; pass one for tests.
 */
export async function planSnapshot(
	projectPath: string,
	documentId: string,
	title: string,
	date: Date
): Promise<SnapshotEntry> {
	const dir = snapshotDir(projectPath, documentId);
	if (
		!dir ||
		typeof title !== 'string' ||
		title.length > 512 ||
		!(date instanceof Date) ||
		!Number.isFinite(date.getTime())
	)
		throw createError(ErrorCode.INVALID_INPUT, {}, 'Invalid snapshot identity, title, or date');
	const { stem: baseStem, indexDate } = formatSnapshotStamp(date);
	const existing = await withSnapshotReader(projectPath, (reader) => listSnapshotRtfStems(reader, dir));
	let stem = baseStem;
	for (let n = 1; existing.includes(stem); n++) stem = `${baseStem}-${n}`;
	return { documentId, snapshotId: stem, title: title.trim(), date: indexDate };
}

export async function writePlannedSnapshot(
	projectPath: string,
	entry: SnapshotEntry,
	content: string
): Promise<void> {
	const dir = snapshotDir(projectPath, entry.documentId);
	if (
		!dir ||
		!/^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}[+-]\d{4}(?:-\d+)?$/.test(entry.snapshotId) ||
		typeof entry.title !== 'string' ||
		entry.title.length > 512 ||
		typeof entry.date !== 'string' ||
		entry.date.length > 40 ||
		typeof content !== 'string' ||
		Buffer.byteLength(content) > MAX_SNAPSHOT_BYTES
	)
		throw new Error('Invalid planned snapshot');
	const rtfPath = path.join(dir, `${entry.snapshotId}.rtf`);
	const indexPath = path.join(dir, 'index.xml');
	return withSnapshotReader(projectPath, async (reader) => {
		reader.assertProjectPath(indexPath);
		reader.assertProjectPath(rtfPath);
		const priorStems = await listSnapshotRtfStems(reader, dir);
		const otherStems = priorStems.filter((stem) => stem !== entry.snapshotId);
		const completedStems = [...otherStems, entry.snapshotId].sort();
		let prior: Array<{ title: string; date: string }> | undefined;
		const savedIndex = await reader.readProjectArtifact(indexPath);
		if (savedIndex.exists) {
			const parsed = (await parseStringPromise(savedIndex.raw, PARSE_OPTS)) as {
				Snapshots?: { Snapshot?: unknown } | string;
			};
			if (parsed.Snapshots === undefined) throw new Error('Invalid snapshot index root');
			const root = typeof parsed.Snapshots === 'object' ? parsed.Snapshots : undefined;
			prior = asArray(root?.Snapshot).map((raw) => {
				const record =
					raw && typeof raw === 'object' ? (raw as { Title?: unknown; Date?: unknown }) : {};
				return { title: textOf(record.Title), date: textOf(record.Date) };
			});
		}
		const metadata = new Map<string, { title: string; date: string }>();
		if (prior === undefined) {
			for (const stem of otherStems) {
				const stamp = stem.match(
					/^(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})-(\d{2})([+-]\d{4})(?:-\d+)?$/
				);
				if (!stamp)
					throw new Error(
						'An unindexed snapshot has an unsupported timestamp; inspect its metadata before retrying'
					);
				metadata.set(stem, {
					title: '',
					date: `${stamp[1]} ${stamp[2]}:${stamp[3]}:${stamp[4]} ${stamp[5]}`,
				});
			}
		} else if (prior.length === completedStems.length) {
			for (let index = 0; index < completedStems.length; index++)
				metadata.set(completedStems[index], prior[index]);
			const planned = metadata.get(entry.snapshotId);
			if (planned?.title !== entry.title || planned.date !== entry.date)
				throw new Error('Planned snapshot ID conflicts with existing snapshot metadata');
		} else if (prior.length === otherStems.length) {
			for (let index = 0; index < otherStems.length; index++)
				metadata.set(otherStems[index], prior[index]);
		} else
			throw new Error(
				'Snapshot index and saved files do not agree; inspect the existing snapshots before retrying'
			);
		metadata.set(entry.snapshotId, { title: entry.title, date: entry.date });
		reader.assertProjectPath(dir);
		await fs.mkdir(dir, { recursive: true });
		const existing = await reader.readProjectArtifact(rtfPath);
		if (existing.exists) {
			if (existing.raw !== content)
				throw new Error('Planned snapshot ID already contains different saved content');
		} else {
			reader.assertProjectPath(rtfPath);
			await safeWriteFile(rtfPath, content);
		}
		const ordered = [...metadata.entries()]
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([, value]) => value);
		reader.assertProjectPath(indexPath);
		await safeWriteFile(indexPath, buildSnapshotIndex(ordered));
	});
}

export async function createSnapshot(
	projectPath: string,
	documentId: string,
	title: string,
	date: Date
): Promise<SnapshotEntry> {
	const { MutationCoordinator } = await import('./editorial/mutation-coordinator.js');
	const coordinator = new MutationCoordinator(projectPath);
	try {
		const entry = await coordinator.snapshot(documentId, title, date);
		logger.info('Created snapshot', { documentId, snapshotId: entry.snapshotId });
		return entry;
	} finally {
		await coordinator.close();
	}
}
