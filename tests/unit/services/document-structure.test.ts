/**
 * Regression tests for DocumentManager.getProjectStructure.
 *
 * A prior bug only descended into binderItems[0].Children, assuming the first
 * top-level binder item was the container holding everything. Real Scrivener
 * binders lead with a template/front-matter doc (a leaf) and spread content
 * across several top-level folders, so the whole tree collapsed to []. These
 * lock the corrected traversal: every top-level item is walked, folders recurse,
 * and a top-level trash folder is surfaced only when includeTrash is set.
 */

import { DocumentManager } from '../../../src/services/document-manager.js';
import type { ProjectStructure } from '../../../src/types/internal.js';

// Leads with a leaf template doc (the exact shape that used to collapse the tree),
// then the Manuscript (DraftFolder) with a chapter, a standalone folder, Research,
// and a Trash folder with a deleted item.
const structure: ProjectStructure = {
	ScrivenerProject: {
		Binder: {
			BinderItem: [
				{ UUID: 'leaf-1', Title: 'Novel Format', Type: 'Text' },
				{
					UUID: 'draft-1',
					Title: 'Manuscript',
					Type: 'DraftFolder',
					Children: {
						BinderItem: [{ UUID: 'ch-1', Title: 'Chapter 1', Type: 'Text' }],
					},
				},
				{ UUID: 'folder-1', Title: 'Characters', Type: 'Folder' },
				{ UUID: 'res-1', Title: 'Research', Type: 'ResearchFolder' },
				{
					UUID: 'trash-1',
					Title: 'Trash',
					Type: 'TrashFolder',
					Children: {
						BinderItem: [{ UUID: 'del-1', Title: 'Deleted Scene', Type: 'Text' }],
					},
				},
			],
		},
	},
};

describe('DocumentManager.getProjectStructure', () => {
	let dm: DocumentManager;

	beforeEach(() => {
		dm = new DocumentManager('/tmp/nonexistent-structure-test');
		dm.setProjectStructure(structure);
	});

	afterEach(async () => {
		await dm.close();
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
