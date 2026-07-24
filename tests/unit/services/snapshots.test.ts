/**
 * Locks the snapshot reader for issue #14 against the sample project fixture:
 * parses Snapshots/<uuid>.snapshots/index.xml, correlates it with the RTF files,
 * and verifies the defensive accessors degrade to empty/undefined (rather than
 * throwing or escaping the snapshot set) on missing dirs, garbage input, invalid
 * ids, and path-traversal attempts.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
	parseSnapshotIndex,
	listDocumentSnapshots,
	listAllSnapshots,
	findSnapshot,
	createSnapshot,
} from '../../../src/services/snapshots.js';

const PROJECT = path.join(process.cwd(), 'tests', 'sample-project.scriv');
const DOC = '684ADA52-4D45-48D2-B03D-5ECB784963EE';
const NO_SNAPSHOTS_DOC = '0BFBFA71-F1E9-401C-8A78-97B10BC12399';

describe('parseSnapshotIndex', () => {
	it('parses ordered title/date metadata', async () => {
		const entries = await parseSnapshotIndex(
			`<?xml version="1.0"?><Snapshots Version="1.0">
				<Snapshot><Title>A</Title><Date>2025-01-01 00:00:00 -0700</Date></Snapshot>
				<Snapshot><Title>B</Title><Date>2025-01-02 00:00:00 -0700</Date></Snapshot>
			</Snapshots>`
		);
		expect(entries).toEqual([
			{ title: 'A', date: '2025-01-01 00:00:00 -0700' },
			{ title: 'B', date: '2025-01-02 00:00:00 -0700' },
		]);
	});

	it('handles a single snapshot (xml2js single-vs-array shape)', async () => {
		const entries = await parseSnapshotIndex(
			`<Snapshots><Snapshot><Title>Only</Title><Date>d</Date></Snapshot></Snapshots>`
		);
		expect(entries).toEqual([{ title: 'Only', date: 'd' }]);
	});

	it('degrades to empty on unparseable or unrelated XML', async () => {
		expect(await parseSnapshotIndex('<not-closed')).toEqual([]);
		expect(await parseSnapshotIndex('<Other/>')).toEqual([]);
		expect(await parseSnapshotIndex('<Snapshots/>')).toEqual([]);
	});
});

describe('listDocumentSnapshots (fixture)', () => {
	it('zips the RTF files with index metadata in chronological order', async () => {
		const snaps = await listDocumentSnapshots(PROJECT, DOC);
		expect(snaps).toEqual([
			{
				documentId: DOC,
				snapshotId: '2025-10-27-02-20-40-0700',
				title: 'First draft',
				date: '2025-10-27 02:20:40 -0700',
			},
			{
				documentId: DOC,
				snapshotId: '2025-10-27-09-15-12-0700',
				title: 'Before rewrite',
				date: '2025-10-27 09:15:12 -0700',
			},
		]);
	});

	it('returns [] for a document with no snapshots', async () => {
		expect(await listDocumentSnapshots(PROJECT, NO_SNAPSHOTS_DOC)).toEqual([]);
	});

	it('returns [] for an invalid document id rather than throwing', async () => {
		expect(await listDocumentSnapshots(PROJECT, '../../etc')).toEqual([]);
	});
});

describe('listAllSnapshots (fixture)', () => {
	it('finds every document that has snapshots', async () => {
		const all = await listAllSnapshots(PROJECT);
		expect(all.filter((s) => s.documentId === DOC)).toHaveLength(2);
	});

	it('returns [] for a project without a Snapshots directory', async () => {
		expect(await listAllSnapshots(path.join(PROJECT, 'Files'))).toEqual([]);
	});
});

describe('findSnapshot (fixture)', () => {
	it('resolves a real snapshot to its metadata and RTF path', async () => {
		const found = await findSnapshot(PROJECT, DOC, '2025-10-27-02-20-40-0700');
		expect(found?.entry.title).toBe('First draft');
		expect(found?.rtfPath).toBe(
			path.join(PROJECT, 'Snapshots', `${DOC}.snapshots`, '2025-10-27-02-20-40-0700.rtf')
		);
	});

	it('returns undefined for an unknown snapshot id', async () => {
		expect(await findSnapshot(PROJECT, DOC, 'nope')).toBeUndefined();
	});

	it('rejects path-traversal ids without touching the filesystem', async () => {
		expect(await findSnapshot(PROJECT, DOC, '../../../../etc/passwd')).toBeUndefined();
		expect(await findSnapshot(PROJECT, DOC, '../index')).toBeUndefined();
	});

	it('returns undefined for an invalid document id', async () => {
		expect(await findSnapshot(PROJECT, 'not-a-uuid', 'x')).toBeUndefined();
	});
});

describe('createSnapshot', () => {
	const DOC_ID = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
	let dir: string;
	let project: string;

	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'snap-create-'));
		project = path.join(dir, 'p.scriv');
		await fsp.mkdir(path.join(project, 'Files', 'Data', DOC_ID), { recursive: true });
		await fsp.writeFile(
			path.join(project, 'Files', 'Data', DOC_ID, 'content.rtf'),
			'{\\rtf1\\ansi original body}'
		);
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('copies content byte-for-byte and records Scrivener-format metadata', async () => {
		const when = new Date(2025, 9, 27, 2, 20, 40); // 2025-10-27 02:20:40 local
		const entry = await createSnapshot(project, DOC_ID, 'Before edit', when);

		expect(entry.title).toBe('Before edit');
		// index.xml date: "YYYY-MM-DD HH:MM:SS ±ZZZZ"; the id repeats it with the
		// timezone sign as the separator.
		expect(entry.date).toMatch(/^2025-10-27 02:20:40 [+-]\d{4}$/);
		expect(entry.snapshotId).toMatch(/^2025-10-27-02-20-40[+-]\d{4}$/);

		const snapRtf = await fsp.readFile(
			path.join(project, 'Snapshots', `${DOC_ID}.snapshots`, `${entry.snapshotId}.rtf`)
		);
		const source = await fsp.readFile(
			path.join(project, 'Files', 'Data', DOC_ID, 'content.rtf')
		);
		expect(snapRtf.equals(source)).toBe(true);

		const listed = await listDocumentSnapshots(project, DOC_ID);
		expect(listed).toEqual([entry]);
	});

	it('appends to an existing index without dropping prior snapshots', async () => {
		await createSnapshot(project, DOC_ID, 'First', new Date(2025, 0, 1, 8, 0, 0));
		await createSnapshot(project, DOC_ID, 'Second', new Date(2025, 0, 2, 9, 30, 0));
		const listed = await listDocumentSnapshots(project, DOC_ID);
		expect(listed.map((s) => s.title)).toEqual(['First', 'Second']);
	});

	it('disambiguates a same-second collision instead of overwriting', async () => {
		const when = new Date(2025, 0, 1, 8, 0, 0);
		const a = await createSnapshot(project, DOC_ID, 'A', when);
		const b = await createSnapshot(project, DOC_ID, 'B', when);
		expect(a.snapshotId).not.toBe(b.snapshotId);
		expect((await listDocumentSnapshots(project, DOC_ID)).length).toBe(2);
	});

	it('XML-escapes titles', async () => {
		const entry = await createSnapshot(project, DOC_ID, 'A & B <x>', new Date(2025, 0, 1));
		const idx = await fsp.readFile(
			path.join(project, 'Snapshots', `${DOC_ID}.snapshots`, 'index.xml'),
			'utf-8'
		);
		expect(idx).toContain('<Title>A &amp; B &lt;x&gt;</Title>');
		// And it round-trips back to the original title through the reader.
		expect(entry.title).toBe('A & B <x>');
		expect((await listDocumentSnapshots(project, DOC_ID))[0].title).toBe('A & B <x>');
	});

	it('throws NOT_FOUND when the document has no content to snapshot', async () => {
		await expect(
			createSnapshot(project, '11111111-1111-4111-8111-111111111111', 'x', new Date())
		).rejects.toThrow();
	});
});
