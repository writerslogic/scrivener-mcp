import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { parseStringPromise } from 'xml2js';
import { ProjectLoader } from '../../../src/services/project-loader.js';
import { DocumentManager } from '../../../src/services/document-manager.js';
import { RTFHandler } from '../../../src/services/parsers/rtf-handler.js';
import {
	createDocument,
	createDocuments,
	deleteDocument,
	moveDocument,
	type DocumentOperationContext,
} from '../../../src/utils/document-operations.js';
import { findBinderItemById } from '../../../src/services/document-manager-helpers.js';

const draftId = '11111111-1111-4111-8111-111111111111';
const textId = '22222222-2222-4222-8222-222222222222';
const source = `<?xml version="1.0" encoding="UTF-8"?>
<ScrivenerProject Identifier="project-id" Version="2.0" Creator="SCRWIN-3" Custom="keep">
  <Binder>
    <BinderItem UUID="${draftId}" Type="DraftFolder" Modified="old">
      <Title>원고</Title>
      <Children><BinderItem UUID="${textId}" Type="Text" Created="created" Modified="old" VendorFlag="yes">
        <Title>기존 문서</Title>
        <MetaData><SectionType ChildDefault="default">section</SectionType></MetaData>
        <TextSettings><Selection Start="2" End="4"/></TextSettings>
      </BinderItem></Children>
    </BinderItem>
    <BinderItem UUID="33333333-3333-4333-8333-333333333333" Type="ResearchFolder"><Title>자료</Title></BinderItem>
  </Binder>
  <Vendor Mode="attribute"><Mode>child</Mode><Entry Key="a">one</Entry><Entry Key="b">two</Entry></Vendor>
</ScrivenerProject>`;

describe('ProjectLoader XML round trips', () => {
	let tempRoot: string;
	let projectPath: string;
	let scrivxPath: string;
	let loader: ProjectLoader;
	let manager: DocumentManager;

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scrivener-roundtrip-'));
		projectPath = path.join(tempRoot, 'Probe.scriv');
		scrivxPath = path.join(projectPath, 'Probe.scrivx');
		await fs.mkdir(projectPath);
		await fs.writeFile(scrivxPath, source);
		loader = new ProjectLoader(projectPath);
		manager = new DocumentManager(projectPath);
	});

	afterEach(async () => {
		await manager.close();
		await loader.close();
		// Only remove the directory allocated by this test.
		expect(path.dirname(tempRoot)).toBe(path.resolve(os.tmpdir()));
		expect(path.basename(tempRoot)).toMatch(/^scrivener-roundtrip-/);
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	const parse = (xml: string) => parseStringPromise(xml, { explicitArray: false });

	it('preserves root, binder, and unknown attributes through two unchanged saves', async () => {
		await loader.loadProject();
		await loader.saveProject();
		expect(await parse(await fs.readFile(scrivxPath, 'utf8'))).toEqual(await parse(source));
		await loader.reloadProject();
		await loader.saveProject();
		expect(await parse(await fs.readFile(scrivxPath, 'utf8'))).toEqual(await parse(source));
	});

	it('keeps document lookup and rename working without changing unrelated metadata', async () => {
		const structure = await loader.loadProject();
		manager.setProjectStructure(structure);
		await manager.renameDocument(textId, '수정한 제목');
		await loader.saveProject(structure);
		const expected = await parse(source);
		expected.ScrivenerProject.Binder.BinderItem[0].Children.BinderItem.Title = '수정한 제목';
		expect(await parse(await fs.readFile(scrivxPath, 'utf8'))).toEqual(expected);
	});

	it('serializes a newly created document with native BinderItem attributes', async () => {
		const structure = await loader.loadProject();
		const result = await createDocument(
			{ title: '새 문서' },
			{
				projectStructure: structure,
				projectPath,
				saveProject: () => loader.saveProject(structure),
			}
		);
		const saved = await parse(await fs.readFile(scrivxPath, 'utf8'));
		const items = saved.ScrivenerProject.Binder.BinderItem;
		const added = items.find((item: { $?: { UUID?: string } }) => item.$?.UUID === result.id);
		expect(added).toBeDefined();
		expect(added.$).toEqual(
			expect.objectContaining({
				UUID: result.id,
				Type: 'Text',
				Created: expect.any(String),
				Modified: expect.any(String),
			})
		);
		expect(added.UUID).toBeUndefined();
		expect(added.Title).toBe('새 문서');
	});

	it('preserves attribute updates through JSON export and import', async () => {
		const structure = await loader.loadProject();
		const items = structure.ScrivenerProject!.Binder!.BinderItem;
		const draft = Array.isArray(items) ? items[0] : items!;
		(draft as unknown as { Modified: string }).Modified = 'new-time';
		const exported = await loader.exportAsJson();
		await loader.importFromJson(exported);
		const saved = await parse(await fs.readFile(scrivxPath, 'utf8'));
		expect(saved.ScrivenerProject.Binder.BinderItem[0].$.Modified).toBe('new-time');
		expect(saved.ScrivenerProject.Vendor).toEqual(
			(await parse(source)).ScrivenerProject.Vendor
		);
	});

	it('creates nested documents in native folders without changing their existing children', async () => {
		const structure = await loader.loadProject();
		manager.setProjectStructure(structure);
		const rtf = new RTFHandler();
		const context: DocumentOperationContext = {
			projectStructure: structure,
			projectPath,
			commitCreation: (candidate, documents) =>
				loader.saveProjectWithDocuments(
					candidate,
					documents.map(({ documentId, content }) => ({
						documentId,
						raw: rtf.convertToRTF(content),
					}))
				),
		};
		const folder = await createDocument(
			{ title: 'Part', parentId: draftId, type: 'Folder' },
			context
		);
		const document = await createDocument(
			{ title: 'Scene', parentId: folder.id, content: 'New scene content.' },
			context
		);
		const sibling = await createDocument({ title: 'Sibling', parentId: draftId }, context);

		expect(document.path).toEqual(['원고', 'Part', 'Scene']);
		expect(await manager.readDocument(document.id)).toBe('New scene content.');
		const saved = await parse(await fs.readFile(scrivxPath, 'utf8'));
		const children = saved.ScrivenerProject.Binder.BinderItem[0].Children.BinderItem;
		expect(children.map((item: { $: { UUID: string } }) => item.$.UUID)).toEqual([
			textId,
			folder.id,
			sibling.id,
		]);
		expect(children[0]).toEqual(
			(await parse(source)).ScrivenerProject.Binder.BinderItem[0].Children.BinderItem
		);
		expect(children[1].Children.BinderItem.$.UUID).toBe(document.id);
		expect(children[1].Children.BinderItem.Children).toBeUndefined();
	});

	it.each(['removed', 'replaced'] as const)(
		'rejects creation when its parent is %s by an intervening saved binder change',
		async (change) => {
			const structure = await loader.loadProject();
			manager.setProjectStructure(structure);
			const original = JSON.stringify(structure);
			const competing = new ProjectLoader(projectPath);
			const rtf = new RTFHandler();
			let savedExternal = '';
			const stagedIds: string[] = [];
			const context: DocumentOperationContext = {
				projectStructure: structure,
				projectPath,
				commitCreation: async (candidate, documents) => {
					const external = await competing.loadProject();
					const binder = external.ScrivenerProject!.Binder!;
					const items = Array.isArray(binder.BinderItem)
						? binder.BinderItem
						: [binder.BinderItem!];
					binder.BinderItem =
						change === 'removed'
							? items.filter((item) => item.UUID !== draftId)
							: items.map((item) =>
									item.UUID === draftId
										? {
												UUID: draftId,
												Type: 'DraftFolder',
												Title: 'Renamed',
												Children: item.Children,
											}
										: item
								);
					await competing.saveProject(external);
					savedExternal = await fs.readFile(scrivxPath, 'utf8');
					stagedIds.push(...documents.map((document) => document.documentId));
					await loader.saveProjectWithDocuments(
						candidate,
						documents.map(({ documentId, content }) => ({
							documentId,
							raw: rtf.convertToRTF(content),
						}))
					);
				},
			};
			try {
				await expect(
					createDocument(
						{ title: 'Concurrent scene', parentId: draftId, content: 'Scene content.' },
						context
					)
				).rejects.toThrow(/stale.*revision/i);
				expect(savedExternal).not.toBe('');
				expect(await fs.readFile(scrivxPath, 'utf8')).toBe(savedExternal);
				expect(savedExternal).not.toContain('Concurrent scene');
				const saved = await parse(savedExternal);
				const items = Array.isArray(saved.ScrivenerProject.Binder.BinderItem)
					? saved.ScrivenerProject.Binder.BinderItem
					: [saved.ScrivenerProject.Binder.BinderItem];
				const parent = items.find(
					(item: { $: { UUID: string } }) => item.$.UUID === draftId
				);
				if (change === 'removed') expect(parent).toBeUndefined();
				else expect(parent.Title).toBe('Renamed');
				expect(JSON.stringify(loader.getProjectStructure())).toBe(original);
				expect(JSON.stringify(manager.getProjectStructureData())).toBe(original);
				expect(stagedIds).toHaveLength(1);
				for (const id of stagedIds)
					await expect(
						fs.lstat(path.join(projectPath, 'Files', 'Data', id, 'content.rtf'))
					).rejects.toMatchObject({ code: 'ENOENT' });
			} finally {
				await competing.close();
			}
		}
	);

	it('preserves a singleton binder root when adding a top-level document', async () => {
		const structure = await loader.loadProject();
		const binder = structure.ScrivenerProject!.Binder!;
		binder.BinderItem = Array.isArray(binder.BinderItem)
			? binder.BinderItem[0]
			: binder.BinderItem;
		const result = await createDocument(
			{ title: 'New root' },
			{
				projectStructure: structure,
				projectPath,
				saveProject: () => loader.saveProject(structure),
			}
		);
		const saved = await parse(await fs.readFile(scrivxPath, 'utf8'));
		expect(
			saved.ScrivenerProject.Binder.BinderItem.map(
				(item: { $: { UUID: string } }) => item.$.UUID
			)
		).toEqual([draftId, result.id]);
	});

	it('validates every creation destination before writing document files or saving', async () => {
		const structure = await loader.loadProject();
		const before = JSON.stringify(structure);
		const writes: string[] = [];
		let saves = 0;
		const context = {
			projectStructure: structure,
			projectPath,
			writeDocument: async (id: string) => {
				writes.push(id);
			},
			saveProject: async () => {
				saves++;
			},
		};
		await expect(
			createDocument({ title: 'Missing', parentId: 'missing' }, context)
		).rejects.toThrow();
		await expect(
			createDocument({ title: 'Leaf', parentId: textId }, context)
		).rejects.toThrow();
		await expect(
			createDocuments(
				[
					{ title: 'Valid first', parentId: draftId },
					{ title: 'Invalid second', parentId: textId },
				],
				context
			)
		).rejects.toThrow();
		await expect(createDocument({ title: 'x'.repeat(256) }, context)).rejects.toThrow();
		expect(writes).toEqual([]);
		expect(saves).toBe(0);
		expect(JSON.stringify(structure)).toBe(before);
		expect(await fs.readFile(scrivxPath, 'utf8')).toBe(source);
	});

	it.each([254, 255])('accepts a document title with %i characters', async (length) => {
		const structure = await loader.loadProject();
		const title = 'x'.repeat(length);
		const result = await createDocument(
			{ title },
			{ projectStructure: structure, projectPath }
		);
		expect(findBinderItemById(structure.ScrivenerProject!.Binder!, result.id)?.Title).toBe(
			title
		);
	});

	it('enforces the document content limit before writing', async () => {
		const structure = await loader.loadProject();
		const writtenLengths: number[] = [];
		const context = {
			projectStructure: structure,
			projectPath,
			commitCreation: async (
				_structure: unknown,
				documents: readonly { content: string }[]
			) => {
				for (const document of documents) writtenLengths.push(document.content.length);
			},
		};
		for (const length of [9_999_999, 10_000_000]) {
			await createDocument({ title: 'Scene', content: 'x'.repeat(length) }, context);
		}
		await expect(
			createDocument({ title: 'Too long', content: 'x'.repeat(10_000_001) }, context)
		).rejects.toThrow();
		expect(writtenLengths).toEqual([9_999_999, 10_000_000]);
	});

	it.each(['save-only', 'compound'] as const)(
		'failed %s creation preserves the original live binder and saved bytes',
		async (mode) => {
			const structure = await loader.loadProject();
			const before = JSON.stringify(structure);
			const failing = async () => {
				throw new Error('Simulated persistence failure');
			};
			await expect(
				createDocument(
					{ title: 'Uncommitted scene', parentId: draftId },
					{
						projectStructure: structure,
						projectPath,
						...(mode === 'compound'
							? { commitCreation: failing }
							: { saveProject: failing }),
					}
				)
			).rejects.toThrow('Simulated persistence failure');
			expect(JSON.stringify(structure)).toBe(before);
			expect(await fs.readFile(scrivxPath, 'utf8')).toBe(source);
		}
	);

	it('keeps a staged compound item invisible until its persistence succeeds', async () => {
		const structure = await loader.loadProject();
		const before = JSON.stringify(structure);
		let release!: () => void;
		let entered!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const creating = createDocument(
			{ title: 'Staged scene', content: 'Saved text.', parentId: draftId },
			{
				projectStructure: structure,
				projectPath,
				commitCreation: async (candidate, documents) => {
					expect(JSON.stringify(candidate)).toContain('Staged scene');
					expect(documents).toEqual([
						{ documentId: expect.any(String), content: 'Saved text.' },
					]);
					entered();
					await pending;
				},
			}
		);
		await started;
		try {
			expect(JSON.stringify(structure)).toBe(before);
		} finally {
			release();
		}
		const result = await creating;
		expect(findBinderItemById(structure.ScrivenerProject!.Binder!, result.id)?.Title).toBe(
			'Staged scene'
		);
	});

	it.each([0, 1, 2, 99, 100, 101])(
		'bounds creation batches at %i items before persistence',
		async (count) => {
			const structure = await loader.loadProject();
			let commits = 0;
			const creating = createDocuments(
				Array.from({ length: count }, (_, index) => ({ title: `Scene ${index}` })),
				{
					projectStructure: structure,
					projectPath,
					commitCreation: async () => {
						commits++;
					},
				}
			);
			if (count < 1 || count > 100) {
				await expect(creating).rejects.toThrow(/1 and 100/);
				expect(commits).toBe(0);
			} else {
				expect(await creating).toHaveLength(count);
				expect(commits).toBe(1);
			}
		}
	);

	it('rejects unsafe split content callbacks before writing or publishing an item', async () => {
		const structure = await loader.loadProject();
		const before = JSON.stringify(structure);
		const written: string[] = [];
		await expect(
			createDocument(
				{ title: 'Unsafe split', content: 'Text.' },
				{
					projectStructure: structure,
					projectPath,
					writeDocument: async (id) => {
						written.push(id);
					},
					saveProject: () => loader.saveProject(structure),
				}
			)
		).rejects.toThrow(/atomic commitCreation/);
		expect(written).toEqual([]);
		expect(JSON.stringify(structure)).toBe(before);
		expect(await fs.readFile(scrivxPath, 'utf8')).toBe(source);
	});

	it('creates a batch with the native binder shape and saves it once', async () => {
		const structure = await loader.loadProject();
		let saves = 0;
		const results = await createDocuments(
			[
				{ title: 'First', parentId: draftId },
				{ title: 'Second', parentId: draftId, metadata: { status: 'Draft' } },
			],
			{
				projectStructure: structure,
				projectPath,
				saveProject: async () => {
					saves++;
					await loader.saveProject(structure);
				},
			}
		);
		const saved = await parse(await fs.readFile(scrivxPath, 'utf8'));
		const children = saved.ScrivenerProject.Binder.BinderItem[0].Children.BinderItem;
		expect(children.map((item: { $: { UUID: string } }) => item.$.UUID)).toEqual([
			textId,
			...results.map((result) => result.id),
		]);
		expect(children[2].MetaData.StatusID).toBe('Draft');
		expect(saves).toBe(1);
	});

	it('keeps default batch placement when its first item creates a folder', async () => {
		const structure = await loader.loadProject();
		structure.ScrivenerProject!.Binder = {};
		const results = await createDocuments(
			[{ title: 'Part', type: 'Folder' }, { title: 'Scene' }],
			{
				projectStructure: structure,
				projectPath,
				saveProject: () => loader.saveProject(structure),
			}
		);
		const saved = await parse(await fs.readFile(scrivxPath, 'utf8'));
		expect(saved.ScrivenerProject.Binder.BinderItem.$.UUID).toBe(results[0].id);
		expect(saved.ScrivenerProject.Binder.BinderItem.Children.BinderItem.$.UUID).toBe(
			results[1].id
		);
		expect(results[1].path).toEqual(['Part', 'Scene']);
	});

	it('moves native children and rejects cycles without detaching a folder', async () => {
		const structure = await loader.loadProject();
		const context = {
			projectStructure: structure,
			projectPath,
			saveProject: () => loader.saveProject(structure),
		};
		const folder = await createDocument(
			{ title: 'Part', type: 'Folder', parentId: draftId },
			context
		);
		await moveDocument(textId, folder.id, context);
		const saved = await parse(await fs.readFile(scrivxPath, 'utf8'));
		const part = saved.ScrivenerProject.Binder.BinderItem[0].Children.BinderItem;
		expect(part.$.UUID).toBe(folder.id);
		expect(part.Children.BinderItem.$.UUID).toBe(textId);
		const before = JSON.stringify(structure);
		await expect(moveDocument(draftId, folder.id, context)).rejects.toThrow('descendant');
		await expect(moveDocument(folder.id, folder.id, context)).rejects.toThrow('itself');
		expect(JSON.stringify(structure)).toBe(before);
	});

	it('uses the native trash folder and performs one save per deletion', async () => {
		const structure = await loader.loadProject();
		const binder = structure.ScrivenerProject!.Binder!;
		const trashId = '44444444-4444-4444-8444-444444444444';
		(binder.BinderItem as Array<unknown>).push({
			UUID: trashId,
			Type: 'TrashFolder',
			Title: '휴지통',
		});
		let saves = 0;
		const context = {
			projectStructure: structure,
			projectPath,
			saveProject: async () => {
				saves++;
				await loader.saveProject(structure);
			},
		};
		await deleteDocument(textId, context);
		let saved = await parse(await fs.readFile(scrivxPath, 'utf8'));
		expect(saved.ScrivenerProject.Binder.BinderItem).toHaveLength(3);
		expect(saved.ScrivenerProject.Binder.BinderItem[2].Children.BinderItem.$.UUID).toBe(textId);
		expect(saves).toBe(1);
		await deleteDocument(textId, context, false);
		expect(findBinderItemById(binder, textId)).toBeUndefined();
		expect(saves).toBe(2);
		saved = await parse(await fs.readFile(scrivxPath, 'utf8'));
		expect(saved.ScrivenerProject.Binder.BinderItem).toHaveLength(3);
	});
});
