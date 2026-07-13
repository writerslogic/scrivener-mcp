import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { DocumentManager } from '../../../src/services/document-manager.js';

/**
 * Regression for #66: getAllDocuments must recurse into folders (real
 * manuscripts nest text documents under Draft/Part/Chapter), and rootFolderId
 * compilation must resolve a folder's descendants by id rather than by a
 * title-path string comparison.
 */
describe('DocumentManager folder recursion', () => {
	let manager: DocumentManager;

	// Synthetic binder: Manuscript folder with a top-level chapter and a nested
	// Part folder containing another chapter, plus a trashed document.
	const structure = {
		ScrivenerProject: {
			Binder: {
				BinderItem: [
					{
						UUID: 'draft',
						Type: 'DraftFolder',
						Title: 'Manuscript',
						Children: {
							BinderItem: [
								{ UUID: 'ch1', Type: 'Text', Title: 'Chapter 1' },
								{
									UUID: 'part1',
									Type: 'Folder',
									Title: 'Part I',
									Children: {
										BinderItem: [
											{ UUID: 'ch2', Type: 'Text', Title: 'Chapter 2' },
										],
									},
								},
							],
						},
					},
					{
						UUID: 'trash',
						Type: 'TrashFolder',
						Title: 'Trash',
						Children: {
							BinderItem: [{ UUID: 'del1', Type: 'Text', Title: 'Deleted' }],
						},
					},
				],
			},
		},
	};

	beforeEach(() => {
		manager = new DocumentManager('/tmp/does-not-matter.scriv');
		// getAllDocuments only requires projectStructure to be populated; injecting
		// it directly avoids loading a real project (and its database) in a unit test.
		(manager as unknown as { projectStructure: unknown }).projectStructure = structure;
	});

	afterEach(async () => {
		await manager.close();
	});

	it('returns nested documents, not just top-level folders', async () => {
		const docs = await manager.getAllDocuments();
		const byId = new Map(docs.map((d) => [d.id, d]));

		expect(byId.has('ch1')).toBe(true);
		expect(byId.has('ch2')).toBe(true);
		expect(byId.get('ch1')?.path).toBe('Manuscript/Chapter 1');
		expect(byId.get('ch2')?.path).toBe('Manuscript/Part I/Chapter 2');
	});

	it('excludes trashed documents unless includeTrash is set', async () => {
		const withoutTrash = await manager.getAllDocuments();
		expect(withoutTrash.some((d) => d.id === 'del1')).toBe(false);

		const withTrash = await manager.getAllDocuments(true);
		const deleted = withTrash.find((d) => d.id === 'del1');
		expect(deleted).toBeDefined();
		expect(deleted?.path.startsWith('Trash/')).toBe(true);
	});

	it('resolves a folder’s descendants by id', async () => {
		const under = await manager.getDocumentsUnderFolder('draft');
		const ids = under.map((d) => d.id).sort();

		// Descendants only (ch1, Part I, ch2) — not the Manuscript folder itself.
		expect(ids).toEqual(['ch1', 'ch2', 'part1']);
		expect(under.find((d) => d.id === 'ch2')?.path).toBe('Manuscript/Part I/Chapter 2');
	});

	it('returns an empty list for an unknown folder id', async () => {
		expect(await manager.getDocumentsUnderFolder('nope')).toEqual([]);
	});
});
