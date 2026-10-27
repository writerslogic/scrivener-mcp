import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import * as path from 'node:path';
import { DocumentManager } from '../../../src/services/document-manager.js';
import { ProjectWriter } from '../../../src/services/project-writer.js';
import { RTFHandler } from '../../../src/services/parsers/rtf-handler.js';
import { createSnapshot, listDocumentSnapshots } from '../../../src/services/snapshots.js';
import { ReviewService } from '../../../src/services/editorial/review-service.js';
import { PersistentStore } from '../../../src/services/editorial/persistent-store.js';
import {
	MutationCoordinator,
	documentRevision,
	type MutationRecord,
} from '../../../src/services/editorial/mutation-coordinator.js';

jest.mock('../../../src/utils/scrivener-app.js', () => ({
	isProjectOpenInScrivener: jest.fn(async () => 'unknown'),
}));

const DOCUMENT = '6C1142A0-64E4-4B4D-8754-73BD6E36EC5B';
const RICH =
	'{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Times;}}{\\stylesheet{\\s1 Heading;}}\\pard\\s1 The quick brown fox.\\par Second {\\b bold} paragraph{\\Scrv_fn\\id1 a footnote\\Scrv_fn_end} here.}';

let root: string;
let documents: DocumentManager;
let writer: ProjectWriter;
let store: PersistentStore;
let reviews: ReviewService;
const handler = new RTFHandler();
const file = (): string => path.join(root, 'Files', 'Data', DOCUMENT, 'content.rtf');
const database = (): string => path.join(root, '.scrivener-mcp', 'editorial.sqlite');

function openServices(): void {
	documents = new DocumentManager(root);
	writer = new ProjectWriter(
		root,
		documents,
		undefined,
		async () => {},
		() => {},
		async () => ({ document: null, path: [], metadata: {}, location: 'unknown' }),
		(id, title) => createSnapshot(root, id, title ?? 'Snapshot', new Date())
	);
	store = new PersistentStore(database());
	reviews = new ReviewService(root, documents, writer, store);
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(tmpdir(), 'scrivener-review-'));
	await fs.mkdir(path.dirname(file()), { recursive: true });
	await fs.writeFile(file(), RICH);
	await fs.writeFile(path.join(root, 'Files', 'Data', 'docs.checksum'), '');
	openServices();
});

afterEach(async () => {
	await documents.close();
	store.close();
	await fs.rm(root, { recursive: true, force: true });
});

test('preview leaves manuscript untouched; selective applications survive restart and undo restores exact RTF', async () => {
	const before = await documents.readDocument(DOCUMENT);
	const first = before.indexOf('quick');
	const second = before.indexOf('here');
	const proposal = await reviews.propose({
		documentId: DOCUMENT,
		expectedRevision: documentRevision(RICH),
		edits: [
			{ start: first, end: first + 5, text: 'slow' },
			{ start: second, end: second + 4, text: 'there' },
		],
	});
	const preview = await reviews.preview(proposal.id, [proposal.edits[0].id]);
	expect(preview.before).toBe(before);
	expect(preview.after).toBe(before.replace('quick', 'slow'));
	expect(await fs.readFile(file(), 'utf8')).toBe(RICH);
	expect(await listDocumentSnapshots(root, DOCUMENT)).toHaveLength(0);
	const applied = await reviews.apply(proposal.id, {
		editIds: [proposal.edits[0].id],
		force: true,
	});
	expect(await documents.readDocument(DOCUMENT)).toBe(before.replace('quick', 'slow'));
	expect(await fs.readFile(file(), 'utf8')).toContain('{\\b bold}');
	expect(applied.fidelity?.snapshotId).toBeTruthy();
	await documents.close();
	store.close();
	openServices();
	expect(reviews.listApplications()[0].id).toBe(applied.id);
	expect((await reviews.preview(proposal.id)).after).toBe(
		before.replace('quick', 'slow').replace('here', 'there')
	);
	reviews.reject(proposal.id, [proposal.edits[1].id]);
	await reviews.undo(applied.id, { force: true });
	expect(await fs.readFile(file(), 'utf8')).toBe(RICH);
	expect(reviews.get(proposal.id).edits.map((edit) => edit.status)).toEqual([
		'pending',
		'rejected',
	]);
	expect((await reviews.undo(applied.id, { force: true })).undoes).toBe(applied.id);
});

test('saved external changes refresh cached reads and reject stale previews, writes, and undo even with force', async () => {
	const before = await documents.readDocument(DOCUMENT);
	const proposal = await reviews.propose({
		documentId: DOCUMENT,
		edits: [{ start: 0, end: 3, text: 'One' }],
	});
	await fs.writeFile(file(), handler.convertToRTF('External revision'));
	expect(await documents.readDocument(DOCUMENT)).toBe('External revision');
	await expect(reviews.preview(proposal.id)).rejects.toThrow(/stale/i);
	await expect(
		writer.writeDocumentPreserving(DOCUMENT, 'Replacement', {
			expectedRevision: proposal.currentRevision,
			force: true,
			allowFormattingLoss: true,
		})
	).rejects.toThrow(/stale/i);
	await fs.writeFile(file(), RICH);
	const applied = await reviews.apply(proposal.id, { force: true });
	await fs.writeFile(file(), handler.convertToRTF(`${before} Changed externally.`));
	await expect(reviews.undo(applied.id, { force: true })).rejects.toThrow(/revision/i);
	expect(await documents.readDocument(DOCUMENT)).toContain('Changed externally.');
});

test('format risk must be acknowledged before application and native detection uncertainty requires explicit force', async () => {
	const before = await documents.readDocument(DOCUMENT);
	const proposal = await reviews.propose({
		documentId: DOCUMENT,
		edits: [{ start: 0, end: before.length, text: 'Replacement prose.' }],
	});
	expect((await reviews.preview(proposal.id)).fidelity.atRisk.length).toBeGreaterThan(0);
	await expect(reviews.apply(proposal.id, { force: true })).rejects.toThrow(/formatting loss/i);
	expect(await fs.readFile(file(), 'utf8')).toBe(RICH);
	await expect(reviews.apply(proposal.id, { allowFormattingLoss: true })).rejects.toThrow(
		/ambiguous|unavailable/i
	);
	await reviews.apply(proposal.id, { allowFormattingLoss: true, force: true });
	expect(await documents.readDocument(DOCUMENT)).toBe('Replacement prose.');
});

test('proposal and application retry keys never replay a completed mutation', async () => {
	const input = {
		documentId: DOCUMENT,
		idempotencyKey: 'workflow/chapter-review',
		edits: [{ start: 0, end: 3, text: 'One' }],
	};
	const proposal = await reviews.propose(input);
	expect((await reviews.propose(input)).id).toBe(proposal.id);
	await expect(
		reviews.propose({ ...input, edits: [{ start: 0, end: 3, text: 'Two' }] })
	).rejects.toThrow(/already used/i);
	const operationId = randomUUID();
	await reviews.apply(proposal.id, { force: true, operationId });
	const snapshots = (await listDocumentSnapshots(root, DOCUMENT)).length;
	await fs.writeFile(file(), handler.convertToRTF('Subsequent external edit'));
	expect((await reviews.apply(proposal.id, { force: true, operationId })).id).toBe(operationId);
	expect(await documents.readDocument(DOCUMENT)).toBe('Subsequent external edit');
	expect(await listDocumentSnapshots(root, DOCUMENT)).toHaveLength(snapshots);
});

test.each([-1, 0, 1])('edit endpoint at length %+d is validated at the boundary', async (delta) => {
	const before = await documents.readDocument(DOCUMENT);
	const result = reviews.propose({
		documentId: DOCUMENT,
		edits: [{ start: before.length + delta, end: before.length + delta, text: '!' }],
	});
	if (delta > 0) await expect(result).rejects.toThrow(/range/i);
	else expect((await result).edits[0].start).toBe(before.length + delta);
});

test('overlapping edits and Unicode surrogate splits are rejected', async () => {
	await fs.writeFile(file(), handler.convertToRTF('A 😀 fox'));
	await expect(
		reviews.propose({ documentId: DOCUMENT, edits: [{ start: 3, end: 4, text: 'x' }] })
	).rejects.toThrow(/Unicode/i);
	await expect(
		reviews.propose({
			documentId: DOCUMENT,
			edits: [
				{ start: 0, end: 3, text: 'x' },
				{ start: 2, end: 4, text: 'y' },
			],
		})
	).rejects.toThrow(/overlap/i);
});

test('a commit interrupted after the RTF rename is reconciled after restart', async () => {
	const proposal = await reviews.propose({
		documentId: DOCUMENT,
		edits: [{ start: 0, end: 3, text: 'One' }],
	});
	const checksum = path.join(root, 'Files', 'Data', 'docs.checksum');
	await fs.unlink(checksum);
	await fs.mkdir(checksum);
	await expect(reviews.apply(proposal.id, { force: true })).rejects.toThrow();
	expect(await documents.readDocument(DOCUMENT)).toMatch(/^One /);
	await fs.rmdir(checksum);
	await fs.writeFile(checksum, '');
	await documents.close();
	store.close();
	openServices();
	const recovered = await reviews.recover();
	expect(recovered).toHaveLength(1);
	expect(recovered[0].state).toBe('committed');
	expect(reviews.get(proposal.id).edits[0].status).toBe('accepted');
	expect(await fs.readFile(checksum, 'utf8')).toMatch(
		new RegExp(`^${DOCUMENT}/content\\.rtf=[a-f0-9]{40}`)
	);
});

test('independent coordinators cannot both overwrite the same saved revision', async () => {
	const other = new MutationCoordinator(root);
	try {
		const results = await Promise.allSettled([
			documents
				.getMutationCoordinator()
				.commit(DOCUMENT, handler.convertToRTF('First writer'), {
					expectedRevision: documentRevision(RICH),
				}),
			other.commit(DOCUMENT, handler.convertToRTF('Second writer'), {
				expectedRevision: documentRevision(RICH),
			}),
		]);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
		expect(['First writer', 'Second writer']).toContain(await documents.readDocument(DOCUMENT));
	} finally {
		other.close();
	}
});

test('live process ownership blocks recovery, then a dead process reservation recovers without writing the manuscript', async () => {
	const id = randomUUID();
	const record: MutationRecord = {
		id,
		documentId: DOCUMENT,
		beforeRaw: RICH,
		afterRaw: handler.convertToRTF('Prepared only'),
		beforeRevision: documentRevision(RICH),
		afterRevision: documentRevision(handler.convertToRTF('Prepared only')),
		beforeExists: true,
		state: 'prepared',
		createdAt: new Date().toISOString(),
	};
	store.put('mutations', id, record);
	const script = `const Database = require('better-sqlite3'); const db = new Database(process.env.REVIEW_DB); db.prepare('INSERT INTO editorial_state(namespace,id,value) VALUES(?,?,?)').run('mutation-claims','project',JSON.stringify({operationId:process.env.REVIEW_OPERATION,ownerPid:process.pid,host:require('os').hostname(),token:'child-claim'})); process.send('ready'); process.on('message',()=>{db.close();process.exit(0)});`;
	const child = spawn(process.execPath, ['-e', script], {
		cwd: process.cwd(),
		env: { ...process.env, REVIEW_DB: database(), REVIEW_OPERATION: id },
		stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
	});
	try {
		await Promise.race([
			once(child, 'message'),
			once(child, 'exit').then(() => {
				throw new Error('Claim owner exited before initialization');
			}),
		]);
		await expect(documents.getMutationCoordinator().recover()).rejects.toThrow(/active/i);
		const exited = once(child, 'exit');
		child.send('exit');
		await exited;
		expect((await documents.getMutationCoordinator().recover())[0].state).toBe('prepared');
		expect(await fs.readFile(file(), 'utf8')).toBe(RICH);
		store.put('mutation-claims', 'project', {
			operationId: id,
			ownerPid: process.pid,
			host: `${hostname()}-different-host`,
			token: 'ambiguous',
		});
		await expect(documents.getMutationCoordinator().recover()).rejects.toThrow(/ambiguous/i);
		store.delete('mutation-claims', 'project');
	} finally {
		if (child.exitCode === null) child.kill();
	}
});

test('a document directory symlink cannot redirect manuscript reads or mutations outside the project', async () => {
	const outside = await fs.mkdtemp(path.join(tmpdir(), 'scrivener-outside-'));
	try {
		await fs.writeFile(path.join(outside, 'content.rtf'), RICH);
		await fs.rm(path.dirname(file()), { recursive: true });
		await fs.symlink(outside, path.dirname(file()), 'junction');
		await expect(documents.readDocument(DOCUMENT)).rejects.toThrow(/symlink/i);
		await expect(
			documents.getMutationCoordinator().commit(DOCUMENT, handler.convertToRTF('Unsafe'))
		).rejects.toThrow(/symlink/i);
		expect(await fs.readFile(path.join(outside, 'content.rtf'), 'utf8')).toBe(RICH);
	} finally {
		await fs.rm(outside, { recursive: true, force: true });
	}
});

test('batch receipts persist and retries do not duplicate applications or snapshots', async () => {
	const otherDocument = '0DFDB9EC-082B-49F7-B950-06C2621478D7';
	const otherFile = path.join(root, 'Files', 'Data', otherDocument, 'content.rtf');
	await fs.mkdir(path.dirname(otherFile), { recursive: true });
	await fs.writeFile(otherFile, handler.convertToRTF('The second scene.'));
	const one = await reviews.propose({
		documentId: DOCUMENT,
		edits: [{ start: 0, end: 3, text: 'One' }],
	});
	const two = await reviews.propose({
		documentId: otherDocument,
		edits: [{ start: 4, end: 10, text: 'final' }],
	});
	const operationId = randomUUID();
	const batch = await reviews.applyBatch([one.id, two.id], { force: true, operationId });
	expect(batch.state).toBe('completed');
	expect(batch.completed).toHaveLength(2);
	const count = (await listDocumentSnapshots(root, DOCUMENT)).length;
	await documents.close();
	store.close();
	openServices();
	expect(
		(await reviews.applyBatch([one.id, two.id], { force: true, operationId })).completed
	).toEqual(batch.completed);
	expect(reviews.listApplications()).toHaveLength(2);
	expect(reviews.listBatches()[0].state).toBe('completed');
	expect(await listDocumentSnapshots(root, DOCUMENT)).toHaveLength(count);
	expect(await documents.readDocument(otherDocument)).toBe('The final scene.');
});
