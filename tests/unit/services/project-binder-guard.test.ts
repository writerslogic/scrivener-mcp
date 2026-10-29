import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { ScrivenerProject } from '../../../src/scrivener-project.js';
import { ProjectLoader } from '../../../src/services/project-loader.js';
import { DocumentManager } from '../../../src/services/document-manager.js';
import { updateDocumentHandler } from '../../../src/handlers/document-handlers.js';
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
const SOURCE = `<?xml version="1.0" encoding="UTF-8"?><ScrivenerProject Identifier="guard-fixture"><Binder><BinderItem UUID="${DRAFT}" Type="DraftFolder"><Title>Draft</Title><Children><BinderItem UUID="${DOCUMENT}" Type="Text"><Title>Original</Title></BinderItem></Children></BinderItem><BinderItem UUID="${TARGET}" Type="Folder"><Title>Target</Title></BinderItem><SearchResults><Children><BinderItem UUID="${TRASHED}" Type="Text"><Title>Trashed</Title></BinderItem></Children></SearchResults></Binder></ScrivenerProject>`;

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
		contentEnhancer: {} as HandlerContext['contentEnhancer'],
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
	expect(
		await fs.readFile(path.join(root, 'Files', 'Data', DOCUMENT, 'synopsis.txt'), 'utf8')
	).toBe('Accepted synopsis');
	const external = (await fs.readFile(file, 'utf8')).replace('Accepted title', 'External title');
	await fs.writeFile(file, external);
	await expect(
		project.renameDocument(DOCUMENT, 'Stale forced title', { force: true })
	).rejects.toThrow(/stale.*revision/i);
	expect(await fs.readFile(file, 'utf8')).toBe(external);
});
