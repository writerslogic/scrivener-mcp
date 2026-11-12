import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScrivenerProject } from '../../../src/scrivener-project.js';
import { ProjectLoader } from '../../../src/services/project-loader.js';
import { DocumentManager } from '../../../src/services/document-manager.js';
import { RTFHandler } from '../../../src/services/parsers/rtf-handler.js';
import { HolographicMemorySystem, initializeHHM } from '../../../src/handlers/memory-handlers.js';
import {
	createDocumentHandler,
	readDocumentHandler,
	writeDocumentHandler,
} from '../../../src/handlers/document-handlers.js';
import { ProjectWriter } from '../../../src/services/project-writer.js';
import { isProjectOpenInScrivener } from '../../../src/utils/scrivener-app.js';
import type { HandlerContext } from '../../../src/handlers/types.js';

jest.mock('../../../src/handlers/database/database-service.js');
jest.mock('../../../src/handlers/async-handlers.js', () => ({
	initializeAsyncServices: jest.fn().mockResolvedValue(undefined),
	shutdownAsyncServices: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../src/utils/scrivener-app.js', () => ({ isProjectOpenInScrivener: jest.fn() }));

const DRAFT = '11111111-1111-4111-8111-111111111111';
const DOCUMENT = '22222222-2222-4222-8222-222222222222';
const SOURCE = `<?xml version="1.0" encoding="UTF-8"?><ScrivenerProject Identifier="isolation-fixture"><Binder><BinderItem UUID="${DRAFT}" Type="DraftFolder"><Title>Draft</Title><Children><BinderItem UUID="${DOCUMENT}" Type="Text"><Title>Scene</Title></BinderItem></Children></BinderItem></Binder></ScrivenerProject>`;
let directory: string;
let globalMemory: HolographicMemorySystem;
const projects: ScrivenerProject[] = [];

async function fixture(name: string, text: string) {
	const root = join(directory, `${name}.scriv`);
	await fs.mkdir(join(root, 'Files', 'Data', DOCUMENT), { recursive: true });
	await fs.writeFile(join(root, `${name}.scrivx`), SOURCE);
	await fs.writeFile(
		join(root, 'Files', 'Data', DOCUMENT, 'content.rtf'),
		new RTFHandler().convertToRTF(text)
	);
	const project = new ScrivenerProject(root, { hhmSystem: globalMemory });
	projects.push(project);
	const resources = project as unknown as {
		projectLoader: ProjectLoader;
		documentManager: DocumentManager;
	};
	resources.documentManager.setProjectStructure(await resources.projectLoader.loadProject());
	return { project, root, ...resources };
}

function context(project: ScrivenerProject): HandlerContext {
	return {
		project,
		memoryManager: null,
		contentAnalyzer: {} as HandlerContext['contentAnalyzer'],
		hhmSystem: globalMemory,
	};
}

beforeEach(async () => {
	jest.mocked(isProjectOpenInScrivener).mockReset().mockResolvedValue('closed');
	directory = await fs.mkdtemp(join(tmpdir(), 'scrivener-retention-'));
	globalMemory = await initializeHHM({
		engine: 'fallback',
		dimensions: 128,
		storagePath: join(directory, 'legacy-store'),
	});
});
afterEach(async () => {
	for (const project of projects.splice(0)) await project.close();
	await globalMemory.destroy();
	jest.restoreAllMocks();
	await fs.rm(directory, { recursive: true, force: true });
});

test('plain, paged and formatted reads from projects sharing a UUID never ingest a global manuscript', async () => {
	const first = await fixture('First', 'Orchid gardens surround the violet house.');
	const second = await fixture('Second', 'Copper engines cross the iron bridge.');
	for (const item of [first, second]) {
		const full = await readDocumentHandler.handler(
			{ documentId: DOCUMENT },
			context(item.project)
		);
		expect(full.structuredContent?.text).toBe(await item.project.readDocument(DOCUMENT));
		const page = await readDocumentHandler.handler(
			{ documentId: DOCUMENT, offset: 1, limit: 2 },
			context(item.project)
		);
		expect(page.structuredContent?.text).toEqual(expect.any(String));
		await readDocumentHandler.handler(
			{ documentId: DOCUMENT, format: 'formatted' },
			context(item.project)
		);
		expect(globalMemory.getStats().totalMemories).toBe(0);
	}
	expect(await globalMemory.queryText('Orchid copper', 10)).toEqual([]);
	expect(await first.project.readDocument(DOCUMENT)).toBe(
		'Orchid gardens surround the violet house.'
	);
	expect(await second.project.readDocument(DOCUMENT)).toBe(
		'Copper engines cross the iron bridge.'
	);
});

test('writes and creation preserve project isolation without changing explicit legacy memories', async () => {
	await globalMemory.memorizeText('Explicit legacy memory retained.', 'explicit-memory');
	const first = await fixture('First', 'Original orchid scene.');
	const second = await fixture('Second', 'Original copper scene.');
	await writeDocumentHandler.handler(
		{ documentId: DOCUMENT, content: 'Edited orchid scene.' },
		context(first.project)
	);
	await writeDocumentHandler.handler(
		{ documentId: DOCUMENT, content: 'Edited copper scene.' },
		context(second.project)
	);
	const created = await createDocumentHandler.handler(
		{ title: 'New scene', content: 'New private scene.', parentId: DRAFT },
		context(first.project)
	);
	const id = created.structuredContent?.documentId as string;
	expect(await first.project.readDocument(id)).toBe('New private scene.');
	expect(await first.project.readDocument(DOCUMENT)).toBe('Edited orchid scene.');
	expect(await second.project.readDocument(DOCUMENT)).toBe('Edited copper scene.');
	expect(globalMemory.getStats().totalMemories).toBe(1);
	expect(
		(await globalMemory.queryText('Explicit legacy memory retained.', 10)).map((hit) => hit.id)
	).toEqual(['explicit-memory']);
});

test('direct ProjectWriter compatibility arguments cannot re-enable automatic global ingestion', async () => {
	const item = await fixture('Direct', 'Initial scene.');
	const writer = new ProjectWriter(
		item.root,
		item.documentManager,
		globalMemory,
		() => undefined,
		(id) => item.project.getDocumentInfo(id),
		false,
		(structure, created) => item.projectLoader.saveProjectWithDocuments(structure, created)
	);
	await writer.writeDocument('22222222-2222-4222-8222-222222222222', 'Changed scene.');
	const id = await writer.createDocument('Added', 'Added manuscript scene.', DRAFT);
	expect(await item.documentManager.readDocument(id)).toBe('Added manuscript scene.');
	expect(await item.documentManager.readDocument(DOCUMENT)).toBe('Changed scene.');
	expect(globalMemory.getStats().totalMemories).toBe(0);
});
