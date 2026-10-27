import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { DocumentManager } from '../../../src/services/document-manager.js';
import { RTFHandler } from '../../../src/services/parsers/rtf-handler.js';

const ROOT = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const FOLDER = '33333333-3333-4333-8333-333333333333';
const NESTED = '44444444-4444-4444-8444-444444444444';
const TRASH = '55555555-5555-4555-8555-555555555555';
const MISSING = '66666666-6666-4666-8666-666666666666';
const EMPTY = '77777777-7777-4777-8777-777777777777';
type Item = { UUID: string; Type: string; Title: string; Children?: { BinderItem: Item[] } };

function fixture() {
	const folder: Item = { UUID: FOLDER, Type: 'Folder', Title: 'Part', Children: { BinderItem: [{ UUID: NESTED, Type: 'Text', Title: 'Nested Scene' }] } };
	const draft: Item = { UUID: ROOT, Type: 'DraftFolder', Title: 'Draft', Children: { BinderItem: [{ UUID: DOC, Type: 'Text', Title: 'Chapter 1' }, folder] } };
	return { ScrivenerProject: { Binder: { BinderItem: [draft], SearchResults: [{ Children: { BinderItem: [{ UUID: TRASH, Type: 'Text', Title: 'Deleted Chapter' }] } }] } } };
}

describe('DocumentManager', () => {
	let projectPath: string;
	let manager: DocumentManager;
	let structure: ReturnType<typeof fixture>;
	const rtf = new RTFHandler();
	const roots = (): Item[] => structure.ScrivenerProject.Binder.BinderItem;
	const draftChildren = (): Item[] => roots()[0].Children!.BinderItem;
	const folderChildren = (): Item[] => draftChildren().find((item) => item.UUID === FOLDER)!.Children!.BinderItem;
	const trash = (): Item[] => structure.ScrivenerProject.Binder.SearchResults[0].Children.BinderItem;
	const file = (id = DOC): string => path.join(projectPath, 'Files', 'Data', id, 'content.rtf');

	beforeEach(async () => {
		projectPath = await fs.mkdtemp(path.join(tmpdir(), 'scrivener-documents-'));
		await fs.mkdir(path.dirname(file()), { recursive: true });
		await fs.writeFile(file(), rtf.convertToRTF('Test content with café and 東京.'));
		manager = new DocumentManager(projectPath);
		structure = fixture();
		manager.setProjectStructure(structure);
	});

	afterEach(async () => {
		await manager.close();
		await fs.rm(projectPath, { recursive: true, force: true });
	});

	test('recovers to the Draft folder and removes the same item from trash', async () => {
		await manager.recoverFromTrash(TRASH);
		expect(draftChildren().map((item) => item.UUID)).toContain(TRASH);
		expect(trash()).toHaveLength(0);
	});

	test('recovers to a selected folder, creating its child container when absent', async () => {
		draftChildren().push({ UUID: EMPTY, Type: 'Folder', Title: 'Empty Folder' });
		await manager.recoverFromTrash(TRASH, EMPTY);
		expect(draftChildren().find((item) => item.UUID === EMPTY)?.Children?.BinderItem.map((item) => item.UUID)).toEqual([TRASH]);
		expect(trash()).toHaveLength(0);
	});

	test('recovers at binder top level when there is no Draft folder', async () => {
		roots()[0].Type = 'Folder';
		await manager.recoverFromTrash(TRASH);
		expect(roots().map((item) => item.UUID)).toEqual([ROOT, TRASH]);
		expect(draftChildren().map((item) => item.UUID)).not.toContain(TRASH);
	});

	test.each([DOC, MISSING])('invalid recovery parent %s preserves the original trash item', async (parent) => {
		await expect(manager.recoverFromTrash(TRASH, parent)).rejects.toThrow(/folder.*not found/i);
		expect(trash().map((item) => item.UUID)).toEqual([TRASH]);
	});

	test('missing documents, empty or absent trash, and unloaded structures report expected absence', async () => {
		await expect(manager.recoverFromTrash(MISSING)).rejects.toThrow(/not found in trash/i);
		structure.ScrivenerProject.Binder.SearchResults[0].Children.BinderItem = [];
		await expect(manager.recoverFromTrash(TRASH)).rejects.toThrow(/trash is empty/i);
		structure.ScrivenerProject.Binder.SearchResults = [];
		await expect(manager.recoverFromTrash(TRASH)).rejects.toThrow(/trash is empty/i);
		manager.setProjectStructure({});
		await expect(manager.recoverFromTrash(TRASH)).rejects.toThrow(/project not loaded/i);
	});

	test('reads raw RTF at Files/Data/UUID and treats only missing content as empty', async () => {
		const raw = await fs.readFile(file(), 'utf8');
		expect(await manager.readDocumentRaw(DOC)).toBe(raw);
		expect(await manager.readDocumentRaw(MISSING)).toBe('');
		await fs.mkdir(file(MISSING), { recursive: true });
		await expect(manager.readDocumentRaw(MISSING)).rejects.toThrow(/regular file/i);
	});

	test('reads Unicode plain text and refreshes a previously cached document after an external save', async () => {
		expect(await manager.readDocument(DOC)).toBe('Test content with café and 東京.');
		expect(await manager.readDocument(DOC)).toBe('Test content with café and 東京.');
		await fs.writeFile(file(), rtf.convertToRTF('A saved external change.'));
		expect(await manager.readDocument(DOC)).toBe('A saved external change.');
	});

	test.each(['../escape', 'not-a-uuid', ''])('rejects unsafe document identity %s before reading', async (id) => {
		await expect(manager.readDocument(id)).rejects.toThrow();
	});

	test('delete moves the actual item into trash and creates a missing trash container', async () => {
		structure.ScrivenerProject.Binder.SearchResults = [];
		await manager.deleteDocument(DOC);
		expect(draftChildren().map((item) => item.UUID)).toEqual([FOLDER]);
		expect(trash().map((item) => item.UUID)).toEqual([DOC]);
		await expect(manager.deleteDocument(MISSING)).rejects.toThrow(/not found/i);
	});

	test('moves a document beneath a selected folder and then to binder top level', async () => {
		await manager.moveDocument(DOC, FOLDER);
		expect(folderChildren().map((item) => item.UUID)).toEqual([NESTED, DOC]);
		await manager.moveDocument(DOC, null);
		expect(folderChildren().map((item) => item.UUID)).toEqual([NESTED]);
		expect(roots().map((item) => item.UUID)).toEqual([ROOT, DOC]);
	});

	test.each([DOC, NESTED, MISSING])('invalid move to %s leaves the original document attached', async (parent) => {
		await expect(manager.moveDocument(DOC, parent)).rejects.toThrow();
		expect(draftChildren().map((item) => item.UUID)).toContain(DOC);
	});
});
