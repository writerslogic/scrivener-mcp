import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
	let directory: string;

	// Synthetic binder: Manuscript folder with a top-level chapter and a nested
	// Part folder containing another chapter, plus a trashed document.
	const structure = {
		ScrivenerProject: {
			Binder: {
				BinderItem: [
					{
						UUID: '00000001-1111-4111-8111-111111111111',
						Type: 'DraftFolder',
						Title: 'Manuscript',
						Children: {
							BinderItem: [
								{
									UUID: '00000002-1111-4111-8111-111111111111',
									Type: 'Text',
									Title: 'Chapter 1',
								},
								{
									UUID: '00000004-1111-4111-8111-111111111111',
									Type: 'Folder',
									Title: 'Part I',
									Children: {
										BinderItem: [
											{
												UUID: '00000003-1111-4111-8111-111111111111',
												Type: 'Text',
												Title: 'Chapter 2',
											},
										],
									},
								},
							],
						},
					},
					{
						UUID: '00000005-1111-4111-8111-111111111111',
						Type: 'TrashFolder',
						Title: 'Trash',
						Children: {
							BinderItem: [
								{
									UUID: '00000006-1111-4111-8111-111111111111',
									Type: 'Text',
									Title: 'Deleted',
								},
							],
						},
					},
				],
			},
		},
	};

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), 'scrivener-recursion-'));
		manager = new DocumentManager(directory);
		// getAllDocuments only requires projectStructure to be populated; injecting
		// it directly avoids loading a real project (and its database) in a unit test.
		(manager as unknown as { projectStructure: unknown }).projectStructure = structure;
	});

	afterEach(async () => {
		await manager.close();
		await rm(directory, { recursive: true, force: true });
	});

	it('returns nested documents, not just top-level folders', async () => {
		const docs = await manager.getAllDocuments();
		const byId = new Map(docs.map((d) => [d.id, d]));

		expect(byId.has('00000002-1111-4111-8111-111111111111')).toBe(true);
		expect(byId.has('00000003-1111-4111-8111-111111111111')).toBe(true);
		expect(byId.get('00000002-1111-4111-8111-111111111111')?.path).toBe('Manuscript/Chapter 1');
		expect(byId.get('00000003-1111-4111-8111-111111111111')?.path).toBe(
			'Manuscript/Part I/Chapter 2'
		);
	});

	it('excludes trashed documents unless includeTrash is set', async () => {
		const withoutTrash = await manager.getAllDocuments();
		expect(withoutTrash.some((d) => d.id === '00000006-1111-4111-8111-111111111111')).toBe(
			false
		);

		const withTrash = await manager.getAllDocuments(true);
		const deleted = withTrash.find((d) => d.id === '00000006-1111-4111-8111-111111111111');
		expect(deleted).toBeDefined();
		expect(deleted?.path.startsWith('Trash/')).toBe(true);
	});

	it('resolves a folder’s descendants by id', async () => {
		const under = await manager.getDocumentsUnderFolder('00000001-1111-4111-8111-111111111111');
		const ids = under.map((d) => d.id).sort();

		// Descendants only (ch1, Part I, ch2) — not the Manuscript folder itself.
		expect(ids).toEqual([
			'00000002-1111-4111-8111-111111111111',
			'00000003-1111-4111-8111-111111111111',
			'00000004-1111-4111-8111-111111111111',
		]);
		expect(under.find((d) => d.id === '00000003-1111-4111-8111-111111111111')?.path).toBe(
			'Manuscript/Part I/Chapter 2'
		);
	});

	it('returns an empty list for an unknown folder id', async () => {
		expect(
			await manager.getDocumentsUnderFolder('00000007-1111-4111-8111-111111111111')
		).toEqual([]);
	});
});
