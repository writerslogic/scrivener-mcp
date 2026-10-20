import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { DocumentManager } from '../../../src/services/document-manager.js';

const DOC = '11111111-1111-4111-8111-111111111111';
const FOLDER = '0BFBFA71-2222-4222-8222-222222222222';
const OTHER_DOC = '33333333-3333-4333-8333-333333333333';
const TRASHED = '44444444-4444-4444-8444-444444444444';
const MISSING = '55555555-5555-4555-8555-555555555555';

type Item = { UUID: string; Type: string; Title: string; Children?: { BinderItem: Item[] } };

function makeStructure() {
	return {
		ScrivenerProject: {
			Binder: {
				BinderItem: [
					{ UUID: DOC, Type: 'Text', Title: 'Scene' } as Item,
					{ UUID: FOLDER, Type: 'Folder', Title: 'Part', Children: { BinderItem: [] } } as Item,
					{ UUID: OTHER_DOC, Type: 'Text', Title: 'Other' } as Item,
				],
				SearchResults: [
					{
						Children: {
							BinderItem: [{ UUID: TRASHED, Type: 'Text', Title: 'Gone' }],
						},
					},
				],
			},
		},
	};
}

describe('DocumentManager binder moves', () => {
	let manager: DocumentManager;
	let structure: ReturnType<typeof makeStructure>;

	const root = () => structure.ScrivenerProject.Binder.BinderItem;
	const trash = () => structure.ScrivenerProject.Binder.SearchResults[0].Children.BinderItem;
	const folderChildren = () => root().find((i) => i.UUID === FOLDER)!.Children!.BinderItem;

	beforeEach(() => {
		manager = new DocumentManager('/tmp/does-not-matter.scriv');
		structure = makeStructure();
		(manager as unknown as { projectStructure: unknown }).projectStructure = structure;
	});

	afterEach(async () => {
		await manager.close();
	});

	it('moves a document under the folder identified by a UUID that parseInt would read as 0', async () => {
		await manager.moveDocument(DOC, FOLDER);

		expect(folderChildren().map((i) => i.UUID)).toEqual([DOC]);
		expect(root().map((i) => i.UUID)).toEqual([FOLDER, OTHER_DOC]);
	});

	it('leaves the document in place when the target parent is unknown or not a folder', async () => {
		await expect(manager.moveDocument(DOC, MISSING)).rejects.toThrow();
		await expect(manager.moveDocument(DOC, OTHER_DOC)).rejects.toThrow();

		expect(root().map((i) => i.UUID)).toEqual([DOC, FOLDER, OTHER_DOC]);
	});

	it('rejects moving a folder into its own descendant without detaching it', async () => {
		const inner = '66666666-6666-4666-8666-666666666666';
		folderChildren().push({ UUID: inner, Type: 'Folder', Title: 'Inner' });

		await expect(manager.moveDocument(FOLDER, inner)).rejects.toThrow();
		expect(root().map((i) => i.UUID)).toContain(FOLDER);
	});

	it('keeps a trashed document in the trash when the recovery target is invalid', async () => {
		await expect(manager.recoverFromTrash(TRASHED, MISSING)).rejects.toThrow();
		await expect(manager.recoverFromTrash(TRASHED, OTHER_DOC)).rejects.toThrow();

		expect(trash().map((i) => i.UUID)).toEqual([TRASHED]);
	});

	it('recovers a trashed document into a valid target folder', async () => {
		await manager.recoverFromTrash(TRASHED, FOLDER);

		expect(trash()).toHaveLength(0);
		expect(folderChildren().map((i) => i.UUID)).toEqual([TRASHED]);
	});
});
