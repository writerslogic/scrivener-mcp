import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { hostname, tmpdir } from 'node:os';
import JSZip from 'jszip';
import {
	ProjectExporter,
	type WorkflowExportRequest,
} from '../../../src/services/project-exporter.js';
import { CompilationService } from '../../../src/services/compilation-service.js';
import { RTFHandler } from '../../../src/services/parsers/rtf-handler.js';
import {
	MutationCoordinator,
	documentRevision,
} from '../../../src/services/editorial/mutation-coordinator.js';
import { PersistentStore } from '../../../src/services/editorial/persistent-store.js';
import type { ScrivenerDocument } from '../../../src/types/index.js';

const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const rtf = (text: string) => `{\\rtf1\\ansi ${text}}`;
let directory: string;
let root: string;
let store: PersistentStore;
let coordinator: MutationCoordinator;
let raw: Map<string, string>;
let reads: string[];
let request: WorkflowExportRequest;

function exporter(
	readRaw = async (documentId: string): Promise<string> => {
		reads.push(documentId);
		const value = raw.get(documentId);
		if (value === undefined) throw new Error('Fixture source is unavailable');
		return value;
	},
	owner = coordinator
): ProjectExporter {
	const structure: ScrivenerDocument[] = [
		{
			id: '33333333-3333-4333-8333-333333333333',
			title: 'Manuscript',
			type: 'Folder',
			path: 'Manuscript',
			children: [FIRST, SECOND].map((id, index): ScrivenerDocument => ({
				id,
				title: `Scene ${index + 1}`,
				type: 'Text',
				path: `Manuscript/Scene ${index + 1}`,
			})),
		},
	];
	return new ProjectExporter(
		new CompilationService(),
		async () => structure,
		async () => ({ title: 'Disposable beta-reader fixture' }),
		async (id) => (await new RTFHandler().parseRTF(await readRaw(id))).plainText,
		root,
		readRaw,
		undefined,
		owner
	);
}

async function restart(): Promise<void> {
	await coordinator.close();
	store.close();
	store = new PersistentStore(path.join(root, '.scrivener-mcp', 'editorial.sqlite'));
	coordinator = new MutationCoordinator(root, store);
}

function prepared(): { id: string; state: string; artifact: { base64: string; sha256: string } } {
	const entries = store
		.list<{
			id: string;
			targetKind?: string;
			state: string;
			artifact: { base64: string; sha256: string };
		}>('mutations')
		.filter((entry) => entry.targetKind === 'export');
	expect(entries).toHaveLength(1);
	return entries[0];
}

beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(tmpdir(), 'scrivener-export-publication-'));
	root = path.join(directory, 'Fixture.scriv');
	await fs.mkdir(root);
	store = new PersistentStore(path.join(root, '.scrivener-mcp', 'editorial.sqlite'));
	coordinator = new MutationCoordinator(root, store);
	raw = new Map([
		[FIRST, rtf('Original first scene.')],
		[SECOND, rtf('Original second scene.')],
	]);
	reads = [];
	request = {
		workflowId: '44444444-4444-4444-8444-444444444444',
		documentIds: [FIRST, SECOND],
		expectedRevisions: [...raw].map(([documentId, source]) => ({
			documentId,
			revision: documentRevision(source),
		})),
		outputPath: path.join(root, '.scrivener-mcp', 'exports', 'beta-reader-fixture.docx'),
	};
});

afterEach(async () => {
	jest.restoreAllMocks();
	try {
		await coordinator?.close();
	} finally {
		store?.close();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test('prepared bytes survive an interruption before publication without regenerating or rereading changed sources', async () => {
	const owner = coordinator as unknown as { writeExportArtifact(record: unknown): Promise<void> };
	jest.spyOn(owner, 'writeExportArtifact').mockRejectedValueOnce(
		new Error('Interrupted before artifact write')
	);
	await expect(exporter().exportWorkflowPreset(request)).rejects.toThrow('Interrupted');
	const pending = prepared();
	expect(pending.state).toBe('prepared');
	await expect(fs.readFile(request.outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
	await restart();
	const result = await exporter(async () => {
		throw new Error('A prepared retry must not reread source');
	}).exportWorkflowPreset(request);
	expect(await fs.readFile(request.outputPath)).toEqual(
		Buffer.from(pending.artifact.base64, 'base64')
	);
	expect(result.receipt).toMatchObject({ sha256: pending.artifact.sha256 });
	expect(prepared().state).toBe('committed');
});

test('an artifact written before its receipt checkpoint is recovered after reopening', async () => {
	const put = store.put.bind(store);
	let interrupted = false;
	jest.spyOn(store, 'put').mockImplementation((namespace, id, value) => {
		const entry = value as { targetKind?: string; state?: string };
		if (
			!interrupted &&
			namespace === 'mutations' &&
			entry.targetKind === 'export' &&
			entry.state === 'committed'
		) {
			interrupted = true;
			throw new Error('Interrupted before receipt checkpoint');
		}
		put(namespace, id, value);
	});
	await expect(exporter().exportWorkflowPreset(request)).rejects.toThrow('receipt checkpoint');
	const bytes = await fs.readFile(request.outputPath);
	expect(prepared().state).toBe('prepared');
	await restart();
	const result = await exporter(async () => {
		throw new Error('A published retry must not regenerate');
	}).exportWorkflowPreset(request);
	expect(await fs.readFile(request.outputPath)).toEqual(bytes);
	expect(result.receipt).toMatchObject({ sha256: documentRevision(bytes) });
	expect(prepared().state).toBe('committed');
});

test('a completed publication is reused after workflow checkpoint loss, while edited artifacts are never replaced', async () => {
	const original = await exporter().exportWorkflowPreset(request);
	const bytes = await fs.readFile(request.outputPath);
	await restart();
	const resumed = exporter(async () => {
		throw new Error('A receipt retry must not read manuscript data');
	});
	expect(await resumed.exportWorkflowPreset(request)).toEqual(original);
	expect(await fs.readFile(request.outputPath)).toEqual(bytes);
	const changed = Buffer.from('The beta reader edited this artifact.');
	await fs.writeFile(request.outputPath, changed);
	await expect(resumed.exportWorkflowPreset(request)).rejects.toThrow(/changed or disappeared/i);
	expect(await fs.readFile(request.outputPath)).toEqual(changed);
});

test('a preexisting artifact is rejected before source reads and remains unchanged', async () => {
	await fs.mkdir(path.dirname(request.outputPath));
	const original = Buffer.from('Keep this existing document.');
	await fs.writeFile(request.outputPath, original);
	await expect(exporter().exportWorkflowPreset(request)).rejects.toThrow(/already exists/i);
	expect(reads).toEqual([]);
	expect(await fs.readFile(request.outputPath)).toEqual(original);
});

test('changed options or scoped revisions cannot reuse a different request receipt', async () => {
	const service = exporter();
	await service.exportWorkflowPreset(request);
	const bytes = await fs.readFile(request.outputPath);
	reads = [];
	await expect(service.exportWorkflowPreset({ ...request, allowWarnings: true })).rejects.toThrow(
		/already exists/i
	);
	await expect(
		service.exportWorkflowPreset({
			...request,
			expectedRevisions: request.expectedRevisions.map((entry) => ({
				...entry,
				revision: 'f'.repeat(64),
			})),
		})
	).rejects.toThrow(/already exists/i);
	expect(await fs.readFile(request.outputPath)).toEqual(bytes);
	expect(reads).toEqual([]);
});

test('corrupted prepared-byte evidence fails explicitly instead of returning a receipt or regenerating', async () => {
	const service = exporter();
	await service.exportWorkflowPreset(request);
	const receipt = prepared();
	store.put('mutations', receipt.id, {
		...receipt,
		artifact: { ...receipt.artifact, sha256: 'f'.repeat(64) },
	});
	reads = [];
	await expect(service.exportWorkflowPreset(request)).rejects.toThrow(/integrity check/i);
	expect(reads).toEqual([]);
});

test('stale expected revisions reject publication without an artifact or a false receipt', async () => {
	raw.set(FIRST, rtf('A changed first scene.'));
	await expect(exporter().exportWorkflowPreset(request)).rejects.toThrow(
		/source revision changed/i
	);
	await expect(fs.stat(request.outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
	expect(store.list('mutations')).toEqual([]);
});

test('content and preflight use the same captured raw revision when the saved source changes during preparation', async () => {
	const result = await exporter(async (documentId) => {
		reads.push(documentId);
		const captured = raw.get(documentId)!;
		if (documentId === FIRST) raw.set(FIRST, rtf('A later scene. {\\pict omitted media}'));
		return captured;
	}).exportWorkflowPreset(request);
	expect(reads).toEqual([FIRST, SECOND]);
	const zip = await JSZip.loadAsync(await fs.readFile(request.outputPath));
	const document = await zip.file('word/document.xml')!.async('string');
	expect(document).toContain('Original first scene.');
	expect(document).not.toContain('A later scene.');
	expect(result.findings).toEqual([]);
	expect(result.metadata).toMatchObject({ sourceRevisions: request.expectedRevisions });
});

test.each(['outside', 'manuscript', 'nested', 'device'] as const)(
	'%s destinations are refused without source reads or publication',
	async (kind) => {
		const targets = {
			outside: path.join(directory, 'outside.docx'),
			manuscript: path.join(root, 'Files', 'Data', 'content.docx'),
			nested: path.join(root, '.scrivener-mcp', 'exports', 'nested', 'artifact.docx'),
			device: path.join(root, '.scrivener-mcp', 'exports', 'CON.docx'),
		};
		await expect(
			exporter().exportWorkflowPreset({ ...request, outputPath: targets[kind] })
		).rejects.toThrow(/inside .scrivener-mcp\/exports|safe filename/i);
		expect(reads).toEqual([]);
	}
);

test('a symlink or Windows junction in the reserved export directory cannot redirect publication', async () => {
	const outside = path.join(directory, 'outside');
	await fs.mkdir(outside);
	await fs.symlink(outside, path.dirname(request.outputPath), 'junction');
	await expect(exporter().exportWorkflowPreset(request)).rejects.toThrow(/symlink/i);
	expect(await fs.readdir(outside)).toEqual([]);
	expect(reads).toEqual([]);
});

test('ambiguous operation ownership is surfaced instead of stealing a publication claim', async () => {
	store.put('mutation-claims', 'project', {
		operationId: 'export-interrupted',
		ownerPid: process.pid,
		host: hostname(),
		token: 'unknown-owner',
	});
	await expect(exporter().exportWorkflowPreset(request)).rejects.toThrow(
		/ownership is ambiguous/i
	);
	expect(reads).toEqual([]);
});

test('another server can inspect ownership while source preparation awaits without taking the active claim', async () => {
	let entered!: () => void;
	let release!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const writing = exporter(async (id) => {
		entered();
		await gate;
		return raw.get(id)!;
	}).exportWorkflowPreset(request);
	await started;
	const other = new MutationCoordinator(root, store);
	try {
		await expect(exporter(undefined, other).exportWorkflowPreset(request)).rejects.toThrow(
			/operation is active/i
		);
	} finally {
		release();
		await writing;
		await other.close();
	}
});
