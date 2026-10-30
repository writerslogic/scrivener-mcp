import * as fs from 'node:fs/promises';
import { promises as nativeFs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ProjectLoader } from '../../../src/services/project-loader.js';
import { ProjectWriter } from '../../../src/services/project-writer.js';
import { DocumentManager } from '../../../src/services/document-manager.js';
import { RTFHandler } from '../../../src/services/parsers/rtf-handler.js';
import { isProjectOpenInScrivener } from '../../../src/utils/scrivener-app.js';
import { findBinderItemById } from '../../../src/services/document-manager-helpers.js';
import {
	MutationCoordinator,
	documentRevision,
	type MutationRecord,
} from '../../../src/services/editorial/mutation-coordinator.js';
import { PersistentStore } from '../../../src/services/editorial/persistent-store.js';

jest.mock('../../../src/utils/scrivener-app.js', () => ({
	isProjectOpenInScrivener: jest.fn(),
}));

const DRAFT = '11111111-1111-4111-8111-111111111111';
const DOCUMENT = '22222222-2222-4222-8222-222222222222';
const SOURCE = `<?xml version="1.0" encoding="UTF-8"?><ScrivenerProject Identifier="creation-fixture"><Binder><BinderItem UUID="${DRAFT}" Type="DraftFolder"><Title>Draft</Title></BinderItem></Binder></ScrivenerProject>`;
let root: string;
let file: string;
let loader: ProjectLoader;
let documents: DocumentManager;
let writer: ProjectWriter;

beforeEach(async () => {
	jest.mocked(isProjectOpenInScrivener).mockReset().mockResolvedValue('closed');
	root = await fs.mkdtemp(path.join(tmpdir(), 'scrivener-compound-create-'));
	file = path.join(root, `${path.basename(root)}.scrivx`);
	await fs.writeFile(file, SOURCE);
	loader = new ProjectLoader(root);
	documents = new DocumentManager(root);
	documents.setProjectStructure(await loader.loadProject());
	writer = new ProjectWriter(
		root,
		documents,
		undefined,
		() => loader.saveProject(),
		() => undefined,
		async () => ({ document: null, path: [], metadata: {}, location: 'unknown' }),
		async () => {
			throw new Error('New documents do not require snapshots');
		},
		(structure, created) => loader.saveProjectWithDocuments(structure, created)
	);
});

afterEach(async () => {
	jest.restoreAllMocks();
	await documents.close();
	await loader.close();
	await fs.rm(root, { recursive: true, force: true });
});

test.each(['open', 'unknown'] as const)(
	'creation blocks %s native state before any write',
	async (state) => {
		jest.mocked(isProjectOpenInScrivener).mockResolvedValue(state);
		const original = JSON.stringify(documents.getProjectStructureData());
		await expect(writer.createDocument('Blocked', 'Private scene.', DRAFT)).rejects.toThrow(
			state === 'open' ? /open in Scrivener/ : /ambiguous/
		);
		expect(JSON.stringify(documents.getProjectStructureData())).toBe(original);
		expect(await fs.readdir(root)).toEqual([path.basename(file)]);
		expect(await fs.readFile(file, 'utf8')).toBe(SOURCE);
	}
);

test('text and folder creation publish native binder items together with exact saved content', async () => {
	const folder = await writer.createDocument('Part', '', DRAFT, 'Folder');
	const id = await writer.createDocument('Café 🌙', 'Tokyo 東京 — a promise.', folder);
	const saved = await fs.readFile(file, 'utf8');
	expect(saved).toContain(`UUID="${id}"`);
	expect(saved).toContain(`UUID="${folder}"`);
	expect(saved).not.toContain('<UUID>');
	expect(await documents.readDocument(id)).toBe('Tokyo 東京 — a promise.');
	expect(documents.getProjectStructureData()).toBe(loader.getProjectStructure());
	expect(
		findBinderItemById(documents.getProjectStructureData()!.ScrivenerProject!.Binder!, id)
			?.Title
	).toBe('Café 🌙');
	await expect(fs.lstat(path.join(root, 'Files', 'Data', folder))).rejects.toMatchObject({
		code: 'ENOENT',
	});
	expect(await loader.isProjectModified()).toBe(false);
});

test('a stale binder rejects creation without a phantom item or untracked document content', async () => {
	const original = JSON.stringify(documents.getProjectStructureData());
	const external = SOURCE.replace('<Title>Draft</Title>', '<Title>External Draft</Title>');
	await fs.writeFile(file, external);
	await expect(
		writer.createDocument('Rejected', 'Do not orphan this scene.', DRAFT)
	).rejects.toThrow(/stale.*revision/i);
	expect(await fs.readFile(file, 'utf8')).toBe(external);
	expect(JSON.stringify(documents.getProjectStructureData())).toBe(original);
	await expect(fs.lstat(path.join(root, 'Files'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('creation retains its admitted binder revision across a paused backup and intervening save', async () => {
	await loader.close();
	loader = new ProjectLoader(root, { autoBackup: true });
	const structure = await loader.loadProject();
	documents.setProjectStructure(structure);
	let entered!: () => void;
	let release!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const backup = loader.createBackup.bind(loader);
	jest.spyOn(loader, 'createBackup').mockImplementationOnce(async () => {
		entered();
		await gate;
		return backup();
	});
	const creation = writer.createDocument('Paused creation', 'Do not orphan.', DRAFT);
	const outcome = creation.then(
		() => undefined,
		(error: unknown) => error
	);
	await started;
	try {
		findBinderItemById(structure.ScrivenerProject!.Binder!, DRAFT)!.Title = 'Intervening title';
		await loader.saveProject(structure);
	} finally {
		release();
	}
	const failure = await outcome;
	expect(failure).toBeInstanceOf(Error);
	expect((failure as Error).message).toMatch(/stale.*revision/i);
	expect(await fs.readFile(file, 'utf8')).toContain('Intervening title');
	expect(await fs.readFile(file, 'utf8')).not.toContain('Paused creation');
	expect(JSON.stringify(documents.getProjectStructureData())).not.toContain('Paused creation');
	await expect(fs.lstat(path.join(root, 'Files'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('unrepresentable new text fails before the compound operation acquires persistent state', async () => {
	const original = JSON.stringify(documents.getProjectStructureData());
	await expect(writer.createDocument('Whitespace', ' leading space', DRAFT)).rejects.toThrow(
		/round-trip exactly/
	);
	expect(await fs.readdir(root)).toEqual([path.basename(file)]);
	expect(JSON.stringify(documents.getProjectStructureData())).toBe(original);
	expect(await fs.readFile(file, 'utf8')).toBe(SOURCE);
});

test('compound plans validate identities, payload types and allocation counts before persistent writes', async () => {
	const coordinator = documents.getMutationCoordinator();
	const id = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
	for (const plan of [
		null,
		[{ documentId: '../escape', raw: 'text' }],
		[{ documentId: DOCUMENT, raw: 17 }],
		[
			{ documentId: id, raw: 'one' },
			{ documentId: id.toLowerCase(), raw: 'two' },
		],
		Array.from({ length: 101 }, () => ({ documentId: DOCUMENT, raw: 'text' })),
	]) {
		await expect(
			coordinator.commitProjectCreation(file, SOURCE, {
				expectedRevision: documentRevision(SOURCE),
				documents: plan as unknown as Array<{ documentId: string; raw: string }>,
			})
		).rejects.toThrow(/creation|identity/i);
	}
	expect(await fs.readdir(root)).toEqual([path.basename(file)]);
	expect(await fs.readFile(file, 'utf8')).toBe(SOURCE);
});

test.each([false, true])(
	'binder write failure compensates only unchanged created content (external edit=%s)',
	async (changed) => {
		const original = JSON.stringify(documents.getProjectStructureData());
		const externalRaw = new RTFHandler().convertToRTF('External saved content.');
		const rename = nativeFs.rename.bind(nativeFs);
		jest.spyOn(nativeFs, 'rename').mockImplementation(async (source, target) => {
			if (target.toString() === file) {
				if (changed) {
					const data = path.join(root, 'Files', 'Data');
					const [id] = await fs.readdir(data);
					await fs.writeFile(path.join(data, id, 'content.rtf'), externalRaw);
				}
				throw Object.assign(new Error('Synthetic binder write failure'), {
					code: 'ENOSPC',
				});
			}
			await rename(source, target);
		});
		await expect(
			writer.createDocument('Rejected scene', 'Staged original.', DRAFT)
		).rejects.toThrow(/binder write failure|No space left/i);
		expect(await fs.readFile(file, 'utf8')).toBe(SOURCE);
		expect(JSON.stringify(documents.getProjectStructureData())).toBe(original);
		const summary = documents.getMutationCoordinator().listCreations({ limit: 1 }).items[0];
		expect(summary.creationOutcome).toBe(changed ? 'conflicted' : 'rolled-back');
		const body = path.join(
			root,
			'Files',
			'Data',
			summary.creationSummary[0].documentId,
			'content.rtf'
		);
		if (changed) expect(await fs.readFile(body, 'utf8')).toBe(externalRaw);
		else await expect(fs.lstat(body)).rejects.toMatchObject({ code: 'ENOENT' });
	}
);

test('replaying a committed operation returns its receipt without rewriting a later saved edit', async () => {
	const coordinator = documents.getMutationCoordinator();
	const raw = new RTFHandler().convertToRTF('Created text.');
	const after = SOURCE.replace(
		'</Binder>',
		`<BinderItem UUID="${DOCUMENT}" Type="Text"><Title>Created</Title></BinderItem></Binder>`
	);
	const options = {
		operationId: randomUUID(),
		expectedRevision: documentRevision(SOURCE),
		documents: [{ documentId: DOCUMENT, raw }],
	};
	const receipt = await coordinator.commitProjectCreation(file, after, options);
	const body = path.join(root, 'Files', 'Data', DOCUMENT, 'content.rtf');
	const external = new RTFHandler().convertToRTF('A later saved edit.');
	await fs.writeFile(body, external);
	expect(await coordinator.commitProjectCreation(file, after, options)).toEqual(receipt);
	expect(await fs.readFile(body, 'utf8')).toBe(external);
	expect(await fs.readFile(file, 'utf8')).toBe(after);
	await expect(
		coordinator.commitProjectCreation(file, after, {
			...options,
			documents: [{ documentId: DOCUMENT, raw: external }],
		})
	).rejects.toThrow(/different content/);
	expect(coordinator.listCreations().items).toHaveLength(1);
});

test('creation history pages only projected summaries, excluding ordinary binder saves', async () => {
	await loader.saveProject();
	for (const title of ['One', 'Two', 'Three'])
		await writer.createDocument(title, '', DRAFT, 'Folder');
	const coordinator = documents.getMutationCoordinator();
	const first = coordinator.listCreations({ limit: 1 });
	expect(first.items).toHaveLength(1);
	expect(first.nextCursor).not.toBeNull();
	const rest = coordinator.listCreations({ after: first.nextCursor!, limit: 2 });
	expect(rest.items).toHaveLength(2);
	expect(rest.nextCursor).toBeNull();
	const summaries = [...first.items, ...rest.items];
	expect(new Set(summaries.map((summary) => summary.id)).size).toBe(3);
	for (const summary of summaries) {
		expect(summary.creationOutcome).toBe('published');
		expect(summary.creationSummary).toEqual([]);
		expect(summary).not.toHaveProperty('beforeRaw');
		expect(summary).not.toHaveProperty('afterRaw');
	}
});

test.each([
	['before', 'staged', 'rolled-back'],
	['before', 'changed', 'conflicted'],
	['before', 'missing', 'rolled-back'],
	['after', 'staged', 'published'],
	['after', 'changed', 'conflicted'],
	['after', 'missing', 'conflicted'],
	['foreign', 'staged', 'conflicted'],
	['foreign', 'changed', 'conflicted'],
	['foreign', 'missing', 'conflicted'],
] as const)(
	'restart reconciles binder=%s/body=%s as %s without replacing external bytes',
	async (binder, body, outcome) => {
		const raw = new RTFHandler().convertToRTF('Staged scene. Café 🌙');
		const afterRaw = SOURCE.replace(
			'</Binder>',
			`<BinderItem UUID="${DOCUMENT}" Type="Text"><Title>New</Title></BinderItem></Binder>`
		);
		const record: MutationRecord = {
			id: randomUUID(),
			documentId: path.basename(file),
			targetKind: 'binder',
			projectFile: path.basename(file),
			beforeRaw: SOURCE,
			afterRaw,
			beforeRevision: documentRevision(SOURCE),
			afterRevision: documentRevision(afterRaw),
			beforeExists: true,
			state: 'prepared',
			createdAt: new Date().toISOString(),
			creationDocuments: [{ documentId: DOCUMENT, raw }],
			creationSummary: [{ documentId: DOCUMENT, revision: documentRevision(raw) }],
			creationOutcome: 'prepared',
		};
		const store = new PersistentStore(path.join(root, '.scrivener-mcp', 'editorial.sqlite'));
		try {
			store.put('mutations', record.id, record);
			store.put('mutation-pending', record.id, { id: record.id });
		} finally {
			store.close();
		}
		const bodyPath = path.join(root, 'Files', 'Data', DOCUMENT, 'content.rtf');
		const externalBody = new RTFHandler().convertToRTF('A saved external edit.');
		if (body !== 'missing') {
			await fs.mkdir(path.dirname(bodyPath), { recursive: true });
			await fs.writeFile(bodyPath, body === 'staged' ? raw : externalBody);
		}
		const savedBinder =
			binder === 'before'
				? SOURCE
				: binder === 'after'
					? afterRaw
					: SOURCE.replace('<Title>Draft</Title>', '<Title>External Draft</Title>');
		await fs.writeFile(file, savedBinder);
		const coordinator = new MutationCoordinator(root);
		try {
			const recovered = await coordinator.recover();
			expect(recovered.find((item) => item.id === record.id)).toMatchObject({
				creationOutcome: outcome,
				state: outcome === 'published' ? 'committed' : 'conflicted',
			});
			expect(await fs.readFile(file, 'utf8')).toBe(savedBinder);
			if (body === 'missing' || outcome === 'rolled-back')
				await expect(fs.lstat(bodyPath)).rejects.toMatchObject({ code: 'ENOENT' });
			else
				expect(await fs.readFile(bodyPath, 'utf8')).toBe(
					body === 'staged' ? raw : externalBody
				);
			const page = coordinator.listCreations({ limit: 1 });
			expect(page.items).toHaveLength(1);
			expect(page.items[0]).toMatchObject({ id: record.id, creationOutcome: outcome });
			expect(page.items[0]).not.toHaveProperty('beforeRaw');
			expect(page.items[0]).not.toHaveProperty('creationDocuments');
			if (outcome !== 'published')
				await expect(
					coordinator.commitProjectCreation(file, afterRaw, {
						expectedRevision: record.beforeRevision,
						documents: record.creationDocuments!,
						operationId: record.id,
					})
				).rejects.toThrow(/conflict|rolled.back/i);
			expect(await fs.readFile(file, 'utf8')).toBe(savedBinder);
		} finally {
			await coordinator.close();
		}
	}
);
