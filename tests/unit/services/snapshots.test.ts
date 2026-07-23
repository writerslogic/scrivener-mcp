/**
 * Locks the snapshot reader for issue #14 against the sample project fixture:
 * parses Snapshots/<uuid>.snapshots/index.xml, correlates it with the RTF files,
 * and verifies the defensive accessors degrade to empty/undefined (rather than
 * throwing or escaping the snapshot set) on missing dirs, garbage input, invalid
 * ids, and path-traversal attempts.
 */

import * as path from 'path';
import {
	parseSnapshotIndex,
	listDocumentSnapshots,
	listAllSnapshots,
	findSnapshot,
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
