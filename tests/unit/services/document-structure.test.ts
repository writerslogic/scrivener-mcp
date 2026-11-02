import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DocumentManager } from '../../../src/services/document-manager.js';
import type { ProjectStructure } from '../../../src/types/internal.js';

// Leads with a leaf template doc (the exact shape that used to collapse the tree),
// then the Manuscript (DraftFolder) with a chapter, a standalone folder, Research,
// and a Trash folder with a deleted item.
const structure: ProjectStructure = {
	ScrivenerProject: {
		Binder: {
			BinderItem: [
				{
					UUID: '00000001-1111-4111-8111-111111111111',
					Title: 'Novel Format',
					Type: 'Text',
				},
				{
					UUID: '00000002-1111-4111-8111-111111111111',
					Title: 'Manuscript',
					Type: 'DraftFolder',
					Children: {
						BinderItem: [
							{
								UUID: '00000003-1111-4111-8111-111111111111',
								Title: 'Chapter 1',
								Type: 'Text',
							},
						],
					},
				},
				{
					UUID: '00000004-1111-4111-8111-111111111111',
					Title: 'Characters',
					Type: 'Folder',
				},
				{
					UUID: '00000005-1111-4111-8111-111111111111',
					Title: 'Research',
					Type: 'ResearchFolder',
				},
				{
					UUID: '00000006-1111-4111-8111-111111111111',
					Title: 'Trash',
					Type: 'TrashFolder',
					Children: {
						BinderItem: [
							{
								UUID: '00000007-1111-4111-8111-111111111111',
								Title: 'Deleted Scene',
								Type: 'Text',
							},
						],
					},
				},
			],
		},
	},
};

describe('DocumentManager.getProjectStructure', () => {
	let dm: DocumentManager;
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), 'scrivener-structure-'));
		dm = new DocumentManager(directory);
		dm.setProjectStructure(structure);
	});

	afterEach(async () => {
		await dm.close();
		await rm(directory, { recursive: true, force: true });
	});

	it('walks every top-level binder item, not just the first', async () => {
		const titles = (await dm.getProjectStructure()).map((d) => d.title);
		expect(titles).toEqual(
			expect.arrayContaining(['Novel Format', 'Manuscript', 'Characters', 'Research'])
		);
	});

	it('includes a leading leaf item that used to collapse the whole tree to empty', async () => {
		const docs = await dm.getProjectStructure();
		expect(docs.length).toBeGreaterThan(0);
		expect(docs.map((d) => d.title)).toContain('Novel Format');
	});

	it('recurses into folder children', async () => {
		const manuscript = (await dm.getProjectStructure()).find((d) => d.title === 'Manuscript');
		expect(manuscript?.children?.map((c) => c.title)).toContain('Chapter 1');
	});

	it('excludes a top-level trash folder unless includeTrash is set', async () => {
		const withoutTrash = (await dm.getProjectStructure(false)).map((d) => d.title);
		expect(withoutTrash).not.toContain('Trash');

		const withTrash = (await dm.getProjectStructure(true)).map((d) => d.title);
		expect(withTrash).toContain('Trash');
	});
});

describe('DocumentManager.recoverFromTrash', () => {
	let dm: DocumentManager;
	let directory: string;

	// Fresh binder per test (recoverFromTrash mutates it). Leads with a leaf doc,
	// then a DraftFolder and a plain folder; trash lives in SearchResults.
	const makeStructure = (): ProjectStructure => ({
		ScrivenerProject: {
			Binder: {
				BinderItem: [
					{
						UUID: '00000001-1111-4111-8111-111111111111',
						Title: 'Novel Format',
						Type: 'Text',
					},
					{
						UUID: '00000002-1111-4111-8111-111111111111',
						Title: 'Manuscript',
						Type: 'DraftFolder',
						Children: {
							BinderItem: [
								{
									UUID: '00000003-1111-4111-8111-111111111111',
									Title: 'Chapter 1',
									Type: 'Text',
								},
							],
						},
					},
					{
						UUID: '00000004-1111-4111-8111-111111111111',
						Title: 'Characters',
						Type: 'Folder',
					},
				],
				SearchResults: {
					Children: {
						BinderItem: [
							{
								UUID: '00000007-1111-4111-8111-111111111111',
								Title: 'Deleted Scene',
								Type: 'Text',
							},
						],
					},
				},
			},
		},
	});

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), 'scrivener-recover-'));
		dm = new DocumentManager(directory);
		dm.setProjectStructure(makeStructure());
	});

	afterEach(async () => {
		await dm.close();
		await rm(directory, { recursive: true, force: true });
	});

	it('restores a trashed item into the draft folder when the binder leads with a leaf', async () => {
		// Used to throw "Root container not found" because it assumed binderItems[0]
		// was the container to restore into.
		await expect(
			dm.recoverFromTrash('00000007-1111-4111-8111-111111111111')
		).resolves.toBeUndefined();
		const draft = (await dm.getProjectStructure()).find((d) => d.title === 'Manuscript');
		expect(draft?.children?.map((c) => c.title)).toContain('Deleted Scene');
	});

	it('removes the recovered item from the trash', async () => {
		await dm.recoverFromTrash('00000007-1111-4111-8111-111111111111');
		const trashTitles = (await dm.getProjectStructure(true))
			.filter((d) => typeof d.path === 'string' && d.path.startsWith('Trash'))
			.map((d) => d.title);
		expect(trashTitles).not.toContain('Deleted Scene');
	});

	it('restores into an explicit target folder when one is given', async () => {
		await dm.recoverFromTrash(
			'00000007-1111-4111-8111-111111111111',
			'00000004-1111-4111-8111-111111111111'
		);
		const characters = (await dm.getProjectStructure()).find((d) => d.title === 'Characters');
		expect(characters?.children?.map((c) => c.title)).toContain('Deleted Scene');
	});

	it('throws a clear error for a document that is not in the trash', async () => {
		await expect(dm.recoverFromTrash('00000008-1111-4111-8111-111111111111')).rejects.toThrow(
			/not found in trash/
		);
	});
});
