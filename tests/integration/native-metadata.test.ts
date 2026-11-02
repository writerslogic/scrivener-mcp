import nativeFs, { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseStringPromise } from 'xml2js';
import { ScrivenerProject } from '../../src/scrivener-project.js';
import { createCompatibilityProject, COMPATIBILITY_IDS } from '../fixtures/compatibility.js';

describe('native custom metadata persistence', () => {
	let root: string;
	let fixture: Awaited<ReturnType<typeof createCompatibilityProject>>;
	let project: ScrivenerProject;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'scrivener-native-metadata-'));
		fixture = await createCompatibilityProject(root, 'mac');
		project = new ScrivenerProject(fixture.projectPath);
		await project.loadProject();
	});
	afterEach(async () => {
		jest.restoreAllMocks();
		await project?.close();
		await rm(root, { recursive: true, force: true });
	});

	it('migrates legacy field identities and creates definitions in empty project settings', async () => {
		await project.close();
		await writeFile(
			fixture.scrivxPath,
			fixture.xml
				.replace(/FieldID>/g, 'ID>')
				.replace(
					/<CustomMetaDataSettings>.*?<\/CustomMetaDataSettings>/s,
					'<CustomMetaDataSettings/>'
				)
		);
		project = new ScrivenerProject(fixture.projectPath);
		await project.loadProject();
		await project.updateDocumentMetadata(
			COMPATIBILITY_IDS.scene,
			{ customMetadata: { storyTime: '2041-01-01' } },
			{ force: true }
		);
		const xml = (
			await parseStringPromise(await readFile(fixture.scrivxPath, 'utf8'), {
				explicitArray: false,
			})
		).ScrivenerProject;
		const scene = xml.Binder.BinderItem[0].Children.BinderItem.Children.BinderItem;
		expect(
			scene.MetaData.CustomMetaData.MetaDataItem.map(
				(item: { FieldID: string; Value: string }) => [item.FieldID, item.Value]
			)
		).toEqual([
			['storyTime', '2041-01-01'],
			['pov', 'Mira'],
		]);
		expect(
			xml.CustomMetaDataSettings.MetaDataField.map(
				(field: { $: { ID: string } }) => field.$.ID
			)
		).toEqual(['storyTime', 'pov']);
	});

	it('keeps new definitions and live metadata unpublished when the binder commit fails', async () => {
		const before = await readFile(fixture.scrivxPath, 'utf8');
		const original = (await project.getDocumentInfo(COMPATIBILITY_IDS.scene)).document
			?.customMetadata;
		const rename = nativeFs.rename.bind(nativeFs);
		let injected = false;
		jest.spyOn(nativeFs, 'rename').mockImplementation(async (source, target) => {
			if (!injected && target.toString() === fixture.scrivxPath) {
				injected = true;
				throw Object.assign(new Error('Injected metadata commit failure'), { code: 'EIO' });
			}
			return rename(source, target);
		});
		await expect(
			project.updateDocumentMetadata(
				COMPATIBILITY_IDS.scene,
				{ customMetadata: { reviewer: 'Uncommitted' } },
				{ force: true }
			)
		).rejects.toThrow(/metadata commit failure/);
		expect(injected).toBe(true);
		expect(await readFile(fixture.scrivxPath, 'utf8')).toBe(before);
		expect(
			(await project.getDocumentInfo(COMPATIBILITY_IDS.scene)).document?.customMetadata
		).toEqual(original);
		await project.updateDocumentMetadata(
			COMPATIBILITY_IDS.scene,
			{ customMetadata: { reviewer: 'Committed on retry' } },
			{ force: true }
		);
		expect(
			(await project.getDocumentInfo(COMPATIBILITY_IDS.scene)).document?.customMetadata
				?.reviewer
		).toBe('Committed on retry');
	});

	it.each(['updateMetadata', 'updateDocumentMetadata'] as const)(
		'%s owns the admitted custom fields across asynchronous write checks',
		async (method) => {
			const metadata = { customMetadata: { reviewer: 'Admitted value' } };
			const pending = project[method](COMPATIBILITY_IDS.scene, metadata, { force: true });
			metadata.customMetadata.reviewer = 'Caller changed the input';
			await pending;
			expect(
				(await project.getDocumentInfo(COMPATIBILITY_IDS.scene)).document?.customMetadata
					?.reviewer
			).toBe('Admitted value');
			const saved = await readFile(fixture.scrivxPath, 'utf8');
			expect(saved).toContain('<Value>Admitted value</Value>');
			expect(saved).not.toContain('Caller changed the input');
		}
	);

	it.each([99, 100, 101])('bounds custom field identity length at %i', async (length) => {
		const update = project.updateDocumentMetadata(
			COMPATIBILITY_IDS.scene,
			{ customMetadata: { ['k'.repeat(length)]: 'Value' } },
			{ force: true }
		);
		if (length > 100) await expect(update).rejects.toThrow(/1 to 100/);
		else {
			await update;
			expect(
				(await project.getDocumentInfo(COMPATIBILITY_IDS.scene)).document?.customMetadata?.[
					'k'.repeat(length)
				]
			).toBe('Value');
		}
	});

	it.each([9999, 10000, 10001])('bounds custom field value length at %i', async (length) => {
		const update = project.updateDocumentMetadata(
			COMPATIBILITY_IDS.scene,
			{ customMetadata: { note: 'v'.repeat(length) } },
			{ force: true }
		);
		if (length > 10000) await expect(update).rejects.toThrow(/at most 10000/);
		else {
			await update;
			expect(
				(await project.getDocumentInfo(COMPATIBILITY_IDS.scene)).document?.customMetadata
					?.note
			).toHaveLength(length);
		}
	});

	it.each([49, 50, 51])('bounds custom fields per update at %i', async (count) => {
		const customMetadata = Object.fromEntries(
			Array.from({ length: count }, (_, i) => [`field${i}`, 'Value'])
		);
		const update = project.updateDocumentMetadata(
			COMPATIBILITY_IDS.scene,
			{ customMetadata },
			{ force: true }
		);
		if (count > 50) await expect(update).rejects.toThrow(/max 50/);
		else {
			await update;
			expect(
				(await project.getDocumentInfo(COMPATIBILITY_IDS.scene)).document?.customMetadata
			).toMatchObject(customMetadata);
		}
	});

	it('reads native fields and atomically persists replacements, empty values and new definitions', async () => {
		const id = COMPATIBILITY_IDS.scene;
		expect((await project.getDocumentInfo(id)).document?.customMetadata).toEqual({
			storyTime: '2040-06-01',
			pov: 'Mira',
		});
		const customMetadata = { storyTime: '2040-06-03', pov: '', reviewer: 'Café 東京 🌙' };
		await project.updateDocumentMetadata(id, { customMetadata }, { force: true });
		expect((await project.getDocumentInfo(id)).document?.customMetadata).toEqual(
			customMetadata
		);
		const xml = (
			await parseStringPromise(await readFile(fixture.scrivxPath, 'utf8'), {
				explicitArray: false,
			})
		).ScrivenerProject;
		const scene = xml.Binder.BinderItem[0].Children.BinderItem.Children.BinderItem;
		expect(scene.MetaData.CustomMetaData.MetaDataItem).toEqual(
			Object.entries(customMetadata).map(([FieldID, Value]) => ({ FieldID, Value }))
		);
		const definitions = xml.CustomMetaDataSettings.MetaDataField;
		expect(definitions.map((field: { $: { ID: string } }) => field.$.ID)).toEqual([
			'storyTime',
			'pov',
			'reviewer',
		]);
		expect(definitions[1].Title).toBe('Point of view');
		expect(xml.SectionTypes.TypeDefinitions.Type).toHaveLength(2);
		await project.close();
		project = new ScrivenerProject(fixture.projectPath);
		await project.loadProject();
		expect((await project.getDocumentInfo(id)).document?.customMetadata).toEqual(
			customMetadata
		);
		await project.updateDocumentMetadata(
			id,
			{ customMetadata: { reviewer: 'Updated' } },
			{ force: true }
		);
		expect((await project.getDocumentInfo(id)).document?.customMetadata).toEqual({
			...customMetadata,
			reviewer: 'Updated',
		});
	});

	it('rejects invalid custom fields before changing the binder or native field definitions', async () => {
		const before = await readFile(fixture.scrivxPath, 'utf8');
		for (const value of [{ '': 'empty identity' }, { key: 42 }, ['not a field map']]) {
			await expect(
				project.updateDocumentMetadata(
					COMPATIBILITY_IDS.scene,
					{ customMetadata: value as unknown as Record<string, string> },
					{ force: true }
				)
			).rejects.toThrow();
			expect(await readFile(fixture.scrivxPath, 'utf8')).toBe(before);
		}
	});
});
