import * as fs from 'node:fs/promises';
import { promises as nativeFs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { ScrivenerProject } from '../../../src/scrivener-project.js';
import { ProjectLoader } from '../../../src/services/project-loader.js';
import { DocumentManager } from '../../../src/services/document-manager.js';
import {
	moveDocumentHandler,
	updateDocumentHandler,
} from '../../../src/handlers/document-handlers.js';
import { createSnapshotHandler } from '../../../src/handlers/project-handlers/snapshots.js';
import type { HandlerContext } from '../../../src/handlers/types.js';
import { isProjectOpenInScrivener } from '../../../src/utils/scrivener-app.js';

jest.mock('../../../src/handlers/database/database-service.js');
jest.mock('../../../src/handlers/async-handlers.js', () => ({
	initializeAsyncServices: jest.fn().mockResolvedValue(undefined),
	shutdownAsyncServices: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../src/handlers/memory-handlers.js', () => ({
	getHHMSystem: jest.fn(() => {
		throw new Error('Optional manuscript memory is disabled in this fixture');
	}),
}));
jest.mock('../../../src/utils/scrivener-app.js', () => ({
	isProjectOpenInScrivener: jest.fn(),
}));

const DRAFT = '11111111-1111-4111-8111-111111111111';
const DOCUMENT = '22222222-2222-4222-8222-222222222222';
const TARGET = '33333333-3333-4333-8333-333333333333';
const TRASHED = '44444444-4444-4444-8444-444444444444';
const TRASH_FOLDER = '55555555-5555-4555-8555-555555555555';
const SOURCE = `<?xml version="1.0" encoding="UTF-8"?><ScrivenerProject Identifier="guard-fixture"><Binder><BinderItem UUID="${DRAFT}" Type="DraftFolder"><Title>Draft</Title><Children><BinderItem UUID="${DOCUMENT}" Type="Text"><Title>Original</Title></BinderItem></Children></BinderItem><BinderItem UUID="${TARGET}" Type="Folder"><Title>Target</Title></BinderItem><BinderItem UUID="${TRASH_FOLDER}" Type="TrashFolder"><Title>Corbeille</Title><Children><BinderItem UUID="${TRASHED}" Type="Text"><Title>Trashed</Title></BinderItem></Children></BinderItem></Binder></ScrivenerProject>`;

type Options = { force?: boolean };
const mutations: Array<{
	name: string;
	run: (project: ScrivenerProject, options?: Options) => Promise<unknown>;
}> = [
	{ name: 'create text', run: (p, o) => p.createDocument('New', 'Text', DRAFT, 'Text', o) },
	{ name: 'create folder', run: (p, o) => p.createDocument('New', '', DRAFT, 'Folder', o) },
	{ name: 'delete', run: (p, o) => p.deleteDocument(DOCUMENT, o) },
	{ name: 'rename', run: (p, o) => p.renameDocument(DOCUMENT, 'Changed', o) },
	{ name: 'move', run: (p, o) => p.moveDocument(DOCUMENT, TARGET, undefined, o) },
	{ name: 'recover', run: (p, o) => p.recoverFromTrash(TRASHED, TARGET, o) },
	{ name: 'metadata', run: (p, o) => p.updateMetadata(DOCUMENT, { title: 'Changed' }, o) },
	{
		name: 'document metadata',
		run: (p, o) => p.updateDocumentMetadata(DOCUMENT, { synopsis: 'Changed' }, o),
	},
	{
		name: 'synopsis and notes',
		run: (p, o) => p.updateSynopsisAndNotes(DOCUMENT, 'New', 'Notes', o),
	},
	{
		name: 'batch metadata',
		run: (p, o) =>
			p.batchUpdateSynopsisAndNotes([{ documentId: DOCUMENT, synopsis: 'New' }], o),
	},
	{ name: 'save', run: (p, o) => p.saveProject(o) },
	{ name: 'snapshot', run: (p, o) => p.takeSnapshot(DOCUMENT, 'Guarded snapshot', o) },
];

let directory: string;
let root: string;
let file: string;
let project: ScrivenerProject;
let loader: ProjectLoader;

async function savedFiles(current = root): Promise<Map<string, Buffer>> {
	const result = new Map<string, Buffer>();
	for (const entry of await fs.readdir(current, { withFileTypes: true })) {
		const location = path.join(current, entry.name);
		if (entry.isDirectory()) {
			for (const [name, data] of await savedFiles(location)) result.set(name, data);
		} else {
			result.set(path.relative(root, location), await fs.readFile(location));
		}
	}
	return result;
}

function context(): HandlerContext {
	return {
		project,
		memoryManager: null,
		contentAnalyzer: {} as HandlerContext['contentAnalyzer'],
	};
}

beforeEach(async () => {
	jest.mocked(isProjectOpenInScrivener).mockReset().mockResolvedValue('closed');
	directory = await fs.mkdtemp(path.join(tmpdir(), 'scrivener-binder-guard-'));
	root = path.join(directory, 'Fixture.scriv');
	file = path.join(root, 'Fixture.scrivx');
	await fs.mkdir(root);
	await fs.writeFile(file, SOURCE);
	project = new ScrivenerProject(root);
	const resources = project as unknown as {
		projectLoader: ProjectLoader;
		documentManager: DocumentManager;
	};
	loader = resources.projectLoader;
	resources.documentManager.setProjectStructure(await loader.loadProject());
});

afterEach(async () => {
	try {
		await project?.close();
	} finally {
		jest.restoreAllMocks();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test('move_document persists the requested sibling position and rejects fractional positions without writes', async () => {
	const earlier = await project.createDocument('Earlier', '', TARGET, 'Text');
	await moveDocumentHandler.handler(
		{ documentId: DOCUMENT, targetFolderId: TARGET, position: 0 },
		context()
	);
	const saved = await fs.readFile(file, 'utf8');
	expect(saved.indexOf(`UUID="${DOCUMENT}"`)).toBeLessThan(saved.indexOf(`UUID="${earlier}"`));
	await expect(
		moveDocumentHandler.handler(
			{ documentId: DOCUMENT, targetFolderId: TARGET, position: 0.5 },
			context()
		)
	).rejects.toThrow();
	expect(await fs.readFile(file, 'utf8')).toBe(saved);
});

test.each(['open', 'unknown'] as const)(
	'all public binder mutations reject %s native state before changing files or structure',
	async (state) => {
		jest.mocked(isProjectOpenInScrivener).mockResolvedValue(state);
		const structure = structuredClone(loader.getProjectStructure());
		const files = await savedFiles();
		for (const mutation of mutations) {
			await expect(mutation.run(project)).rejects.toThrow(
				state === 'open' ? /open in Scrivener/i : /unavailable or ambiguous/i
			);
		}
		expect(loader.getProjectStructure()).toEqual(structure);
		expect(await savedFiles()).toEqual(files);
	}
);

test.each([
	{ state: 'closed' as const, force: false },
	{ state: 'open' as const, force: true },
	{ state: 'unknown' as const, force: true },
])(
	'binder mutations persist for native state $state with force=$force',
	async ({ state, force }) => {
		jest.mocked(isProjectOpenInScrivener).mockResolvedValue(state);
		const options = { force };
		const folder = await project.createDocument('New part', '', DRAFT, 'Folder', options);
		const document = await project.createDocument(
			'New scene',
			'Saved scene.',
			folder,
			'Text',
			options
		);
		await project.renameDocument(document, 'Renamed scene', options);
		await project.moveDocument(document, TARGET, undefined, options);
		await project.updateDocumentMetadata(document, { synopsis: 'Scene synopsis.' }, options);
		await project.updateSynopsisAndNotes(document, undefined, 'Scene notes.', options);
		await project.batchUpdateSynopsisAndNotes(
			[{ documentId: document, synopsis: 'Final synopsis.' }],
			options
		);
		await project.deleteDocument(document, options);
		await project.recoverFromTrash(document, TARGET, options);
		await project.saveProject(options);
		expect(await fs.readFile(file, 'utf8')).toContain('Renamed scene');
		expect(
			await fs.readFile(path.join(root, 'Files', 'Data', document, 'synopsis.txt'), 'utf8')
		).toBe('Final synopsis.');
		expect(await project.readDocument(document)).toBe('Saved scene.');
	}
);

test.each([
	{ state: 'open' as const, synopsis: undefined },
	{ state: 'open' as const, synopsis: 'Synopsis' },
	{ state: 'unknown' as const, synopsis: undefined },
	{ state: 'unknown' as const, synopsis: 'Synopsis' },
])(
	'update_document blocks title and synopsis=$synopsis before writes when $state',
	async ({ state, synopsis }) => {
		jest.mocked(isProjectOpenInScrivener).mockResolvedValue(state);
		const before = await savedFiles();
		await expect(
			updateDocumentHandler.handler(
				{ documentId: DOCUMENT, title: 'Rejected title', synopsis },
				context()
			)
		).rejects.toThrow(state === 'open' ? /open in Scrivener/i : /unavailable or ambiguous/i);
		expect(await savedFiles()).toEqual(before);
		expect(JSON.stringify(loader.getProjectStructure())).not.toContain('Rejected title');
	}
);

test.each(['open', 'unknown'] as const)(
	'snapshot handler requires explicit force for %s native state and preserves source bytes',
	async (state) => {
		const contentDirectory = path.join(root, 'Files', 'Data', DOCUMENT);
		await fs.mkdir(contentDirectory, { recursive: true });
		const contentPath = path.join(contentDirectory, 'content.rtf');
		const raw = '{\\rtf1\\ansi Disposable snapshot source.}';
		await fs.writeFile(contentPath, raw);
		jest.mocked(isProjectOpenInScrivener).mockResolvedValue(state);
		const before = await savedFiles();
		await expect(
			createSnapshotHandler.handler({ documentId: DOCUMENT }, context())
		).rejects.toThrow(state === 'open' ? /open in Scrivener/i : /unavailable or ambiguous/i);
		expect(await savedFiles()).toEqual(before);
		const response = await createSnapshotHandler.handler(
			{ documentId: DOCUMENT, title: 'Acknowledged fixture snapshot', force: true },
			context()
		);
		const snapshotId = response.structuredContent?.snapshotId;
		expect(typeof snapshotId).toBe('string');
		expect(await project.readSnapshot(DOCUMENT, snapshotId as string)).toMatchObject({
			title: 'Acknowledged fixture snapshot',
			text: 'Disposable snapshot source.',
		});
		expect(await fs.readFile(contentPath, 'utf8')).toBe(raw);
	}
);

test('read-only project option rejects authoritative mutations even when force is set', async () => {
	await project.close();
	project = new ScrivenerProject(root, { readOnly: true });
	const resources = project as unknown as {
		projectLoader: ProjectLoader;
		documentManager: DocumentManager;
	};
	loader = resources.projectLoader;
	resources.documentManager.setProjectStructure(await loader.loadProject());
	const structure = structuredClone(loader.getProjectStructure());
	const files = await savedFiles();
	for (const mutation of mutations) {
		await expect(mutation.run(project, { force: true })).rejects.toThrow(/read-only/i);
	}
	await expect(project.takeSnapshot(DOCUMENT)).rejects.toThrow(/read-only/i);
	await expect(
		createSnapshotHandler.handler({ documentId: DOCUMENT, force: true }, context())
	).rejects.toThrow(/read-only/i);
	await expect(loader.saveProject()).rejects.toThrow(/read-only/i);
	await expect(resources.documentManager.renameDocument(DOCUMENT, 'Forbidden')).rejects.toThrow(
		/read-only/i
	);
	await expect(resources.documentManager.writeDocument(DOCUMENT, 'Forbidden')).rejects.toThrow(
		/read-only/i
	);
	await expect(
		resources.documentManager.getMutationCoordinator().commit(DOCUMENT, 'Forbidden')
	).rejects.toThrow(/read-only/i);
	expect(loader.getProjectStructure()).toEqual(structure);
	expect(await savedFiles()).toEqual(files);
	expect(jest.mocked(isProjectOpenInScrivener)).not.toHaveBeenCalled();
});

test('compile metadata rejects symlinked settings and accepts absent optional settings', async () => {
	expect((await project.getCompileMetadata()).hasCompileSettings).toBe(false);
	const outside = path.join(directory, 'outside-settings');
	await fs.mkdir(outside);
	await fs.writeFile(
		path.join(outside, 'compile.xml'),
		'<CompileSettings><Private>outside marker</Private></CompileSettings>'
	);
	await fs.symlink(
		outside,
		path.join(root, 'Settings'),
		process.platform === 'win32' ? 'junction' : 'dir'
	);
	await expect(project.getCompileMetadata()).rejects.toThrow(/symlink/i);
});

test('public trash routes use native TrashFolder without creating SearchResults', async () => {
	const trash = await project.getTrashDocuments();
	expect(trash.some((item) => item.id === TRASHED && item.path.startsWith('Trash/'))).toBe(true);
	await project.deleteDocument(DOCUMENT, { force: true });
	let saved = await fs.readFile(file, 'utf8');
	expect(saved).toContain('Type="TrashFolder"');
	expect(saved).not.toContain('<SearchResults>');
	expect(saved.match(new RegExp(DOCUMENT, 'g')) ?? []).toHaveLength(1);
	await project.recoverFromTrash(DOCUMENT, TARGET, { force: true });
	saved = await fs.readFile(file, 'utf8');
	expect(saved).toContain(`UUID="${TARGET}"`);
	expect(saved).toContain(`UUID="${DOCUMENT}"`);
	expect(saved).not.toContain('<SearchResults>');
	expect(saved.match(new RegExp(DOCUMENT, 'g')) ?? []).toHaveLength(1);
});

test('parsed binder IDs must be valid before sidecar reads', async () => {
	const invalidSource = SOURCE.replace(DOCUMENT, 'not-a-valid-id');
	await fs.writeFile(file, invalidSource);
	(
		project as unknown as { documentManager: DocumentManager }
	).documentManager.setProjectStructure(await loader.loadProject());
	await expect(project.getAllDocuments()).rejects.toThrow(/Invalid document ID/i);
});

test('sidecar synopsis and notes symlinks cannot redirect reads or metadata writes outside the project', async () => {
	const outside = await fs.mkdtemp(path.join(tmpdir(), 'scrivener-sidecar-outside-'));
	try {
		await fs.writeFile(path.join(outside, 'synopsis.txt'), 'outside synopsis');
		await fs.writeFile(path.join(outside, 'notes.rtf'), '{\\rtf1 outside notes}');
		const directoryPath = path.join(root, 'Files', 'Data', DOCUMENT);
		await fs.mkdir(path.dirname(directoryPath), { recursive: true });
		await fs.symlink(outside, directoryPath, 'junction');
		await expect(project.getAllDocuments()).rejects.toThrow(/symlink/i);
		await expect(
			project.updateDocumentMetadata(
				DOCUMENT,
				{ synopsis: 'inside', notes: 'inside' },
				{ force: true }
			)
		).rejects.toThrow(/symlink/i);
		expect(await fs.readFile(path.join(outside, 'synopsis.txt'), 'utf8')).toBe(
			'outside synopsis'
		);
		expect(await fs.readFile(path.join(outside, 'notes.rtf'), 'utf8')).toBe(
			'{\\rtf1 outside notes}'
		);
		expect(JSON.stringify(loader.getProjectStructure())).not.toContain('inside');
	} finally {
		await fs.rm(outside, { recursive: true, force: true });
	}
});

test('nonregular sidecar files are rejected before content is exposed', async () => {
	const directoryPath = path.join(root, 'Files', 'Data', DOCUMENT);
	await fs.mkdir(directoryPath, { recursive: true });
	await fs.mkdir(path.join(directoryPath, 'synopsis.txt'));
	await expect(project.getAllDocuments()).rejects.toThrow(/regular file/i);
});

test('update_document forwards explicit force while stale binder revisions remain protected', async () => {
	jest.mocked(isProjectOpenInScrivener).mockResolvedValue('unknown');
	await updateDocumentHandler.handler(
		{
			documentId: DOCUMENT,
			title: 'Accepted title',
			synopsis: 'Accepted synopsis',
			force: true,
		},
		context()
	);
	expect(await fs.readFile(file, 'utf8')).toContain('Accepted title');
	expect((await project.getAllDocuments()).find((item) => item.id === DOCUMENT)?.title).toBe(
		'Accepted title'
	);
	expect(
		await fs.readFile(path.join(root, 'Files', 'Data', DOCUMENT, 'synopsis.txt'), 'utf8')
	).toBe('Accepted synopsis');
	const external = (await fs.readFile(file, 'utf8')).replace('Accepted title', 'External title');
	await fs.writeFile(file, external);
	await expect(
		updateDocumentHandler.handler(
			{
				documentId: DOCUMENT,
				title: 'Stale forced title',
				synopsis: 'Stale forced synopsis',
				force: true,
			},
			context()
		)
	).rejects.toThrow(/stale.*revision/i);
	expect(await fs.readFile(file, 'utf8')).toBe(external);
	expect(
		await fs.readFile(path.join(root, 'Files', 'Data', DOCUMENT, 'synopsis.txt'), 'utf8')
	).toBe('Accepted synopsis');
	expect(JSON.stringify(loader.getProjectStructure())).not.toContain('Stale forced title');
});

test.each(['synopsis.txt', 'notes.rtf', 'Fixture.scrivx'])(
	'metadata publication failure at %s preserves original binder, sidecars and live state',
	async (failedFile) => {
		await project.updateMetadata(DOCUMENT, {
			synopsis: 'Original synopsis',
			notes: 'Original notes',
		});
		const sidecarDir = path.join(root, 'Files', 'Data', DOCUMENT);
		const before = await Promise.all(
			[file, path.join(sidecarDir, 'synopsis.txt'), path.join(sidecarDir, 'notes.rtf')].map(
				(p) => fs.readFile(p, 'utf8')
			)
		);
		const structure = structuredClone(loader.getProjectStructure());
		const rename = nativeFs.rename.bind(nativeFs);
		let injected = false;
		jest.spyOn(nativeFs, 'rename').mockImplementation(async (source, target) => {
			if (!injected && path.basename(target.toString()) === failedFile) {
				injected = true;
				throw Object.assign(new Error('Injected metadata publication failure'), {
					code: 'EIO',
				});
			}
			await rename(source, target);
		});
		await expect(
			updateDocumentHandler.handler(
				{
					documentId: DOCUMENT,
					title: 'Uncommitted',
					synopsis: 'New synopsis',
					notes: 'New notes',
					force: true,
				},
				context()
			)
		).rejects.toThrow(/metadata publication failure/);
		expect(injected).toBe(true);
		expect(
			await Promise.all(
				[
					file,
					path.join(sidecarDir, 'synopsis.txt'),
					path.join(sidecarDir, 'notes.rtf'),
				].map((p) => fs.readFile(p, 'utf8'))
			)
		).toEqual(before);
		expect(loader.getProjectStructure()).toEqual(structure);
		expect((await project.getAllDocuments()).find((item) => item.id === DOCUMENT)?.title).toBe(
			'Original'
		);
	}
);

test('structural previews write nothing and stale application preserves live and saved binder state', async () => {
	const before = await savedFiles();
	const preview = await project.moveDocument(DOCUMENT, TARGET, 0, { dryRun: true });
	expect(preview.dryRun).toBe(true);
	expect(await savedFiles()).toEqual(before);
	await project.renameDocument(TARGET, 'Intervening change');
	const current = await fs.readFile(file, 'utf8');
	const structure = structuredClone(loader.getProjectStructure());
	await expect(
		project.moveDocument(DOCUMENT, TARGET, 0, {
			expectedRevision: preview.expectedRevision,
			force: true,
		})
	).rejects.toThrow(/stale.*revision/i);
	expect(await fs.readFile(file, 'utf8')).toBe(current);
	expect(loader.getProjectStructure()).toEqual(structure);
	const fresh = await project.moveDocument(DOCUMENT, TARGET, 0, { dryRun: true });
	await project.moveDocument(DOCUMENT, TARGET, 0, { expectedRevision: fresh.expectedRevision });
	const reopened = new ProjectLoader(root);
	try {
		await reopened.loadProject();
		const xml = await fs.readFile(file, 'utf8');
		expect(xml.match(new RegExp(DOCUMENT, 'g')) ?? []).toHaveLength(1);
		expect((await project.getDocumentsUnderFolder(TARGET)).map((doc) => doc.id)).toContain(
			DOCUMENT
		);
	} finally {
		await reopened.close();
	}
});

test('failed structural publication leaves the in-memory binder unchanged', async () => {
	const before = await fs.readFile(file, 'utf8');
	const structure = structuredClone(loader.getProjectStructure());
	const rename = nativeFs.rename.bind(nativeFs);
	jest.spyOn(nativeFs, 'rename').mockImplementation(async (source, target) => {
		if (target.toString() === file) throw new Error('Injected binder failure');
		await rename(source, target);
	});
	await expect(project.deleteDocument(DOCUMENT)).rejects.toThrow(/Injected binder failure/);
	expect(await fs.readFile(file, 'utf8')).toBe(before);
	expect(loader.getProjectStructure()).toEqual(structure);
});

test('nested native trash is listed and restored without confusing an active folder named Trash', async () => {
	const folder = await project.createDocument('Nested', '', DRAFT, 'Folder');
	const nested = await project.createDocument('Nested text', 'Unique trash marker.', folder);
	const activeFolder = await project.createDocument('Trash', '', undefined, 'Folder');
	const active = await project.createDocument('Active text', 'Still active.', activeFolder);
	await project.deleteDocument(folder);
	expect((await project.getTrashDocuments()).map((doc) => doc.id)).toContain(nested);
	expect((await project.getTrashDocuments()).map((doc) => doc.id)).not.toContain(active);
	expect(
		(await project.searchTrash('Unique trash marker')).map((match) => match.documentId)
	).toContain(nested);
	await expect(project.recoverFromTrash(nested, TRASH_FOLDER)).rejects.toThrow(/trash subtree/i);
	await project.recoverFromTrash(nested, TARGET);
	expect((await project.getTrashDocuments()).map((doc) => doc.id)).not.toContain(nested);
	expect((await fs.readFile(file, 'utf8')).match(new RegExp(nested, 'g'))).toHaveLength(1);
});

test.each([DRAFT, TRASH_FOLDER])('native root %s cannot be moved or deleted', async (id) => {
	const before = await savedFiles();
	await expect(project.deleteDocument(id)).rejects.toThrow(/native root/);
	await expect(project.moveDocument(id, TARGET)).rejects.toThrow(/native root/);
	expect(await savedFiles()).toEqual(before);
});

test('an early close failure retains dependent stores while independent resources close and retry completes', async () => {
	const originalDataDir = process.env.SCRIVENER_DATA_DIR;
	process.env.SCRIVENER_DATA_DIR = path.join(directory, 'series');
	try {
		const editorial = project.getEditorialServices();
		editorial.store.put('close-test', 'kept', { value: 'durable' });
		jest.spyOn(editorial.workflows, 'close').mockRejectedValueOnce(
			new Error('Injected workflow close failure')
		);
		const resources = project as unknown as { documentManager: DocumentManager };
		await expect(project.close()).rejects.toThrow(/workflow close failure/);
		expect(() => resources.documentManager.getMutationCoordinator()).toThrow(/closing/);
		expect(editorial.store.get('close-test', 'kept')).toEqual({ value: 'durable' });
		await project.close();
		await project.close();
		expect(() => editorial.store.get('close-test', 'kept')).toThrow();
	} finally {
		if (originalDataDir === undefined) delete process.env.SCRIVENER_DATA_DIR;
		else process.env.SCRIVENER_DATA_DIR = originalDataDir;
	}
});
