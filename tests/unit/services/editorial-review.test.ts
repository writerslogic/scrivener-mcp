import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { constants, renameSync, symlinkSync } from 'node:fs';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import * as path from 'node:path';
import { DocumentManager } from '../../../src/services/document-manager.js';
import { ProjectWriter } from '../../../src/services/project-writer.js';
import { RTFHandler } from '../../../src/services/parsers/rtf-handler.js';
import { createSnapshot, listDocumentSnapshots } from '../../../src/services/snapshots.js';
import {
	ReviewService,
	type ChangeProposal,
} from '../../../src/services/editorial/review-service.js';
import { PersistentStore } from '../../../src/services/editorial/persistent-store.js';
import {
	MutationCoordinator,
	documentRevision,
	type MutationRecord,
} from '../../../src/services/editorial/mutation-coordinator.js';

jest.mock('../../../src/utils/scrivener-app.js', () => ({
	isProjectOpenInScrivener: jest.fn(async () => 'unknown'),
}));

jest.mock('node:fs/promises', () => {
	const actual = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
	return { ...actual, __esModule: true, default: actual };
});

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

async function restartServices(): Promise<void> {
	await documents.close();
	store.close();
	openServices();
}

function proposeOpening(): Promise<ChangeProposal> {
	return reviews.propose({ documentId: DOCUMENT, edits: [{ start: 0, end: 3, text: 'One' }] });
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
	await restartServices();
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
	const proposal = await proposeOpening();
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

test.each([-1, 0, 1])('combined replacement length at the allocation limit %+d', async (delta) => {
	const before = await documents.readDocument(DOCUMENT);
	const limit = 10_000_000;
	const result = reviews.propose({
		documentId: DOCUMENT,
		edits: [
			{ start: 0, end: 1, text: 'a'.repeat(limit / 2) },
			{ start: 1, end: 2, text: 'b'.repeat(limit / 2 - before.length + 2 + delta) },
		],
	});
	if (delta > 0) {
		await expect(result).rejects.toThrow(/supported length/i);
		expect(reviews.list()).toHaveLength(0);
	} else expect((await result).edits).toHaveLength(2);
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
				{ start: 0, end: 2, text: 'x' },
				{ start: 1, end: 4, text: 'y' },
			],
		})
	).rejects.toThrow(/overlap/i);
});

test('a commit interrupted after the RTF rename is reconciled after restart', async () => {
	const proposal = await proposeOpening();
	const checksum = path.join(root, 'Files', 'Data', 'docs.checksum');
	await fs.unlink(checksum);
	await fs.mkdir(checksum);
	await expect(reviews.apply(proposal.id, { force: true })).rejects.toThrow();
	expect(await documents.readDocument(DOCUMENT)).toMatch(/^One /);
	await fs.rmdir(checksum);
	await fs.writeFile(checksum, '');
	await restartServices();
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
		await expect(
			createSnapshot(root, DOCUMENT, 'Concurrent snapshot', new Date())
		).rejects.toThrow(/active/i);
		const binder = path.join(root, 'Project.scrivx');
		const xml = '<ScrivenerProject><Binder/></ScrivenerProject>';
		await fs.writeFile(binder, xml);
		await expect(
			documents
				.getMutationCoordinator()
				.commitProjectFile(binder, xml, { expectedRevision: documentRevision(xml) })
		).rejects.toThrow(/active/i);
		const exited = once(child, 'exit');
		child.send('exit');
		await exited;
		expect((await documents.getMutationCoordinator().recover())[0].state).toBe('prepared');
		expect(await fs.readFile(file(), 'utf8')).toBe(RICH);
		for (const host of [hostname(), `${hostname()}-different-host`]) {
			store.put('mutation-claims', 'project', {
				operationId: id,
				ownerPid: process.pid,
				host,
				token: 'ambiguous',
			});
			await expect(documents.getMutationCoordinator().recover()).rejects.toThrow(
				/ambiguous/i
			);
		}
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
	const one = await proposeOpening();
	const two = await reviews.propose({
		documentId: otherDocument,
		edits: [{ start: 4, end: 10, text: 'final' }],
	});
	const operationId = randomUUID();
	const batch = await reviews.applyBatch([one.id, two.id], { force: true, operationId });
	expect(batch.state).toBe('completed');
	expect(batch.completed).toHaveLength(2);
	const count = (await listDocumentSnapshots(root, DOCUMENT)).length;
	await restartServices();
	expect(
		(await reviews.applyBatch([one.id, two.id], { force: true, operationId })).completed
	).toEqual(batch.completed);
	expect(reviews.listApplications()).toHaveLength(2);
	expect(reviews.listBatches()[0].state).toBe('completed');
	expect(await listDocumentSnapshots(root, DOCUMENT)).toHaveLength(count);
	expect(await documents.readDocument(otherDocument)).toBe('The final scene.');
});

test('implicit legacy writes reject an externally changed last-observed revision until a fresh document read', async () => {
	const observed = await documents.readDocumentVersion(DOCUMENT);
	expect(observed.text).toBe((await handler.parseRTF(RICH)).plainText);
	expect(observed.revision).toBe(documentRevision(RICH));
	const external = handler.convertToRTF('Saved by another editor.');
	await fs.writeFile(file(), external);
	await expect(
		writer.writeDocumentPreserving(DOCUMENT, 'Stale caller replacement.', {
			force: true,
			allowFormattingLoss: true,
		})
	).rejects.toThrow(/stale/i);
	await expect(
		writer.writeDocumentPreserving(DOCUMENT, 'Repeated stale replacement.', {
			force: true,
			allowFormattingLoss: true,
		})
	).rejects.toThrow(/stale/i);
	await expect(
		documents.writeDocument(DOCUMENT, 'Low-level stale replacement.', true)
	).rejects.toThrow(/stale/i);
	expect(await fs.readFile(file(), 'utf8')).toBe(external);
	const refreshed = await documents.readDocumentVersion(DOCUMENT);
	expect(refreshed.revision).toBe(documentRevision(external));
	await writer.writeDocumentPreserving(DOCUMENT, 'Reviewed against the saved change.', {
		force: true,
	});
	expect(await documents.readDocument(DOCUMENT)).toBe('Reviewed against the saved change.');
});

test.each(['snapshot', 'checksum'])(
	'%s symlinks are rejected before any manuscript overwrite',
	async (kind) => {
		const outside = await fs.mkdtemp(path.join(tmpdir(), 'scrivener-path-guard-'));
		try {
			const target =
				kind === 'snapshot'
					? path.join(root, 'Snapshots')
					: path.join(root, 'Files', 'Data', 'docs.checksum');
			if (kind === 'checksum') await fs.unlink(target);
			await fs.symlink(outside, target, 'junction');
			const proposal = await reviews.propose({
				documentId: DOCUMENT,
				edits: [{ start: 0, end: 3, text: 'One' }],
			});
			await expect(reviews.apply(proposal.id, { force: true })).rejects.toThrow(/symlink/i);
			expect(await fs.readFile(file(), 'utf8')).toBe(RICH);
			expect(await fs.readdir(outside)).toEqual([]);
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	}
);

test.each([-1, 0, 2_147_483_648])(
	'malformed owner PID %d fails before probing process ownership or changing files',
	async (ownerPid) => {
		store.put('mutation-claims', 'project', {
			operationId: randomUUID(),
			ownerPid,
			host: hostname(),
			token: randomUUID(),
		});
		await expect(documents.getMutationCoordinator().recover()).rejects.toThrow(
			/malformed.*ownership/i
		);
		expect(await fs.readFile(file(), 'utf8')).toBe(RICH);
		store.delete('mutation-claims', 'project');
	}
);

test('journal reconciliation marks third-party saved content conflicted without restoring before or after bytes', async () => {
	const id = randomUUID();
	const afterRaw = handler.convertToRTF('Interrupted planned edit.');
	store.put<MutationRecord>('mutations', id, {
		id,
		documentId: DOCUMENT,
		beforeRaw: RICH,
		afterRaw,
		beforeRevision: documentRevision(RICH),
		afterRevision: documentRevision(afterRaw),
		beforeExists: true,
		state: 'prepared',
		createdAt: new Date().toISOString(),
	});
	const thirdParty = handler.convertToRTF('Third-party saved revision.');
	await fs.writeFile(file(), thirdParty);
	expect((await documents.getMutationCoordinator().recover())[0].state).toBe('conflicted');
	await expect(
		documents.getMutationCoordinator().commit(DOCUMENT, afterRaw, {
			operationId: id,
			expectedRevision: documentRevision(RICH),
		})
	).rejects.toThrow(/conflict/i);
	expect(await fs.readFile(file(), 'utf8')).toBe(thirdParty);
	expect(await fs.readFile(path.join(root, 'Files', 'Data', 'docs.checksum'), 'utf8')).toBe('');
});

test('the complete first-session sample previews and applies an exact Unicode/formatting-preserving opening edit', async () => {
	const sample =
		'{\\rtf1\\ansi\\ansicpg1252\\uc1\\deff0{\\fonttbl{\\f0 Times New Roman;}}{\\stylesheet{\\s0 Normal;}{\\s1\\b Scene;}}\\f0\\fs24 Mara\'s eyes were green.\\par She waited at the harbor caf\\u233? while the rain fell. The lantern was a {\\i promise}, not a warning.\\par Her hands trembled. Every creak behind the locked door made her flinch.\\par "Come inside," Ivo said. "You are safe here."\\par Mara took a step toward the light.{\\*\\Scrv_meta\\typefixture\\id1}Owned sample metadata{\\Scrv_meta_end}}';
	await fs.writeFile(file(), sample);
	const version = await documents.readDocumentVersion(DOCUMENT);
	const proposal = await reviews.propose({
		documentId: DOCUMENT,
		expectedRevision: version.revision,
		edits: [{ start: 0, end: 0, text: 'A new opening. ' }],
	});
	const preview = await reviews.preview(proposal.id);
	expect(preview.after).toBe(`A new opening. ${version.text}`);
	expect(preview.fidelity.mode).toBe('preserved');
	expect(preview.fidelity.atRisk).toEqual([]);
	expect(await fs.readFile(file(), 'utf8')).toBe(sample);
	await reviews.apply(proposal.id, { force: true });
	expect(await documents.readDocument(DOCUMENT)).toBe(preview.after);
	const raw = await fs.readFile(file(), 'utf8');
	expect(raw).toContain('{\\stylesheet{\\s0 Normal;}{\\s1\\b Scene;}}');
	expect(raw).toContain('{\\i promise}');
	expect(raw).toContain('{\\*\\Scrv_meta\\typefixture\\id1}');
});

test('project scope validation rejects removed targets without persisting or applying changes', async () => {
	const before = await fs.readFile(file(), 'utf8');
	const proposal = await reviews.propose({
		documentId: DOCUMENT,
		edits: [{ start: 0, end: 0, text: 'New ' }],
	});
	const scoped = new ReviewService(root, documents, writer, store, async () => {
		throw new Error('Target is outside the active binder');
	});
	await expect(
		scoped.propose({ documentId: DOCUMENT, edits: [{ start: 0, end: 0, text: 'Other ' }] })
	).rejects.toThrow('outside the active binder');
	await expect(scoped.preview(proposal.id)).rejects.toThrow('outside the active binder');
	await expect(scoped.apply(proposal.id, { force: true })).rejects.toThrow(
		'outside the active binder'
	);
	expect(reviews.list()).toHaveLength(1);
	expect(reviews.listApplications()).toEqual([]);
	expect(await fs.readFile(file(), 'utf8')).toBe(before);
});

test.each(['missing', 'empty'])('proposal source distinguishes %s saved content', async (state) => {
	if (state === 'missing') await fs.unlink(file());
	else await fs.writeFile(file(), '');
	const input = { documentId: DOCUMENT, edits: [{ start: 0, end: 0, text: 'An opening.' }] };
	if (state === 'missing') {
		await expect(reviews.propose(input)).rejects.toThrow(/without saved content/i);
		expect(reviews.list()).toEqual([]);
	} else {
		const proposal = await reviews.propose(input);
		const preview = await reviews.preview(proposal.id);
		expect(preview.before).toBe('');
		expect(preview.after).toBe('An opening.');
		expect(await fs.readFile(file(), 'utf8')).toBe('');
		await reviews.apply(proposal.id, { force: true });
		expect(await documents.readDocument(DOCUMENT)).toBe('An opening.');
	}
});

test('retrying an undo reconciles an interrupted rename before checking the original applied revision', async () => {
	const proposal = await proposeOpening();
	const application = await reviews.apply(proposal.id, { force: true });
	const checksum = path.join(root, 'Files', 'Data', 'docs.checksum');
	await fs.unlink(checksum);
	await fs.mkdir(checksum);
	await expect(reviews.undo(application.id, { force: true })).rejects.toThrow();
	expect(await fs.readFile(file(), 'utf8')).toBe(RICH);
	const snapshots = (await listDocumentSnapshots(root, DOCUMENT)).length;
	await fs.rmdir(checksum);
	await fs.writeFile(checksum, '');
	await restartServices();
	const undone = await reviews.undo(application.id, { force: true });
	expect(undone.undoes).toBe(application.id);
	expect(reviews.listApplications()[0].state).toBe('undone');
	expect(reviews.get(proposal.id).edits[0].status).toBe('pending');
	expect(await fs.readFile(file(), 'utf8')).toBe(RICH);
	expect(await listDocumentSnapshots(root, DOCUMENT)).toHaveLength(snapshots);
});


const posixReadTest = process.platform === 'win32' || !constants.O_NOFOLLOW || !constants.O_NONBLOCK ? test.skip : test;

posixReadTest('a symlink swapped in after project-path validation is rejected by the descriptor open', async () => {
	const outside = await fs.mkdtemp(path.join(tmpdir(), 'scrivener-open-race-'));
	const external = path.join(outside, 'external.rtf');
	await fs.writeFile(external, handler.convertToRTF('External manuscript content.'));
	class SwappingCoordinator extends MutationCoordinator {
		override assertProjectPath(target: string): void {
			super.assertProjectPath(target);
			if (target === file()) {
				renameSync(target, `${target}.original`);
				symlinkSync(external, target);
			}
		}
	}
	const coordinator = new SwappingCoordinator(root);
	try {
		await expect(coordinator.readRaw(DOCUMENT)).rejects.toThrow(/ELOOP|symlink|symbolic link/i);
		expect(await fs.readFile(`${file()}.original`, 'utf8')).toBe(RICH);
		expect(await fs.readFile(external, 'utf8')).toBe(handler.convertToRTF('External manuscript content.'));
	} finally {
		coordinator.close();
		await fs.rm(outside, { recursive: true, force: true });
	}
});

posixReadTest('a FIFO without a writer is rejected without blocking the saved-file read', async () => {
	await fs.unlink(file());
	await promisify(execFile)('mkfifo', [file()], { timeout: 5000 });
	const script = `const { MutationCoordinator } = await import(process.env.SAVED_READ_MODULE); const coordinator = new MutationCoordinator(process.env.SAVED_READ_PROJECT); let result; try { await coordinator.readRaw(process.env.SAVED_READ_DOCUMENT); result = { unexpectedSuccess: true }; } catch (error) { result = { error: error.message }; } finally { coordinator.close(); } process.send(result, () => process.exit(0));`;
	const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
		cwd: process.cwd(),
		env: {
			...process.env,
			SAVED_READ_MODULE: pathToFileURL(path.join(process.cwd(), 'src', 'services', 'editorial', 'mutation-coordinator.ts')).href,
			SAVED_READ_PROJECT: root,
			SAVED_READ_DOCUMENT: DOCUMENT,
		},
		stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
	});
	try {
		const result = await new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('Saved-file read blocked on a FIFO')), 8000);
			child.once('message', (message) => { clearTimeout(timer); resolve(message); });
			child.once('error', (error) => { clearTimeout(timer); reject(error); });
			child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Saved-file reader exited before reporting: ${code}`)); });
		});
		expect(result).toEqual({ error: expect.stringMatching(/regular file/i) });
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, 'exit');
			child.kill();
			await exited;
		}
	}
});

test.each(['directory', 'oversized', 'invalid-utf8'])('saved-file descriptors reject %s content and release the opened handle', async (kind) => {
	await fs.unlink(file());
	if (kind === 'directory') await fs.mkdir(file());
	else if (kind === 'oversized') {
		const handle = await fs.open(file(), 'w');
		try { await handle.truncate(64 * 1024 * 1024 + 1); }
		finally { await handle.close(); }
	} else await fs.writeFile(file(), Buffer.from([0xff]));
	await expect(documents.getMutationCoordinator().readRaw(DOCUMENT)).rejects.toThrow();
	await fs.rm(file(), { recursive: true });
	await fs.writeFile(file(), RICH);
	expect(await documents.getMutationCoordinator().readRaw(DOCUMENT)).toEqual({ raw: RICH, exists: true, revision: documentRevision(RICH) });
});

test('native checksum updates preserve key spelling and unrelated entries while collapsing case-varied duplicates', async () => {
	const checksum = path.join(root, 'Files', 'Data', 'docs.checksum');
	const nativeKey = `${DOCUMENT.toLowerCase()}/content.rtf=`;
	const unrelated = `11111111-1111-4111-8111-111111111111/content.rtf=${'a'.repeat(40)}`;
	const notes = `${DOCUMENT}/notes.rtf=${'b'.repeat(40)}`;
	await fs.writeFile(checksum, `${nativeKey}${'0'.repeat(40)}\r\n${unrelated}\r\n${DOCUMENT}/content.rtf=${'1'.repeat(40)}\r\n${notes}\r\n${DOCUMENT}/CONTENT.RTF=${'2'.repeat(40)}\r\n`);
	const raw = handler.convertToRTF('Updated saved manuscript.');
	await documents.getMutationCoordinator().commit(DOCUMENT, raw, { expectedRevision: documentRevision(RICH) });
	const hash = createHash('sha1').update(raw).digest('hex');
	expect(hash).toMatch(/^[a-f0-9]{40}$/);
	expect(await fs.readFile(checksum, 'utf8')).toBe(`${nativeKey}${hash}\r\n${unrelated}\r\n${notes}\r\n`);
});

test.each(['same-file', 'different-device', 'different-file', 'different-path', 'verification-open-failure'])(
	'Windows descriptor verification handles zero path-stat device IDs: %s',
	async (scenario) => {
		const realFs = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
		const replacement = path.join(root, 'different-file.rtf');
		await realFs.writeFile(replacement, RICH);
		const opened: Array<{ handle: FileHandle; stat: () => Promise<unknown> }> = [];
		let restoreIdentity: (() => void) | undefined;
		const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
		Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
		const pathStat = jest.spyOn(fs, 'lstat').mockImplementation(async (target) => {
			const entry = await realFs.lstat(scenario === 'different-path' ? replacement : target, { bigint: true });
			entry.dev = 0n;
			return entry;
		});
		const open = jest.spyOn(fs, 'open').mockImplementation(async (target, flags, mode) => {
			if (opened.length === 1 && scenario === 'verification-open-failure') throw new Error('verification open failed');
			const handle = await realFs.open(opened.length === 1 && scenario === 'different-file' ? replacement : target, flags, mode);
			opened.push({ handle, stat: handle.stat.bind(handle) });
			if (opened.length === 2 && scenario === 'different-device') {
				const identity = await handle.stat({ bigint: true });
				identity.dev += 1n;
				const identitySpy = jest.spyOn(handle, 'stat').mockResolvedValue(identity);
				restoreIdentity = () => identitySpy.mockRestore();
			}
			return handle;
		});
		try {
			const result = documents.getMutationCoordinator().readRaw(DOCUMENT);
			if (scenario === 'same-file') await expect(result).resolves.toEqual({ raw: RICH, exists: true, revision: documentRevision(RICH) });
			else await expect(result).rejects.toThrow(/changed while opening|verification open failed/i);
			for (const descriptor of opened) await expect(descriptor.stat()).rejects.toThrow(/closed|EBADF|not open/i);
		} finally {
			restoreIdentity?.();
			open.mockRestore();
			pathStat.mockRestore();
			Object.defineProperty(process, 'platform', platform);
			for (const descriptor of opened) if (descriptor.handle.fd !== -1) await descriptor.handle.close();
		}
	}
);
