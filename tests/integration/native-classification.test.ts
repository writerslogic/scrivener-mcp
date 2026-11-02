import nativeFs, { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseStringPromise } from 'xml2js';
import { ScrivenerProject } from '../../src/scrivener-project.js';
import { createCompatibilityProject, COMPATIBILITY_IDS } from '../fixtures/compatibility.js';

const id = COMPATIBILITY_IDS.scene;

describe('native document labels and statuses', () => {
	let root: string;
	let fixture: Awaited<ReturnType<typeof createCompatibilityProject>>;
	let project: ScrivenerProject;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'scrivener-classification-'));
		fixture = await createCompatibilityProject(root, 'mac');
		project = new ScrivenerProject(fixture.projectPath);
		await project.loadProject();
	});
	afterEach(async () => {
		jest.restoreAllMocks();
		await project?.close();
		await rm(root, { recursive: true, force: true });
	});
	async function saved() {
		const tree = (
			await parseStringPromise(await readFile(fixture.scrivxPath, 'utf8'), {
				explicitArray: false,
			})
		).ScrivenerProject;
		return {
			tree,
			metadata: tree.Binder.BinderItem[0].Children.BinderItem.Children.BinderItem.MetaData,
		};
	}
	async function reopen() {
		await project.close();
		project = new ScrivenerProject(fixture.projectPath);
		await project.loadProject();
	}
	it('resolves native IDs to names and reuses their definitions when updated', async () => {
		expect((await project.getDocumentInfo(id)).document).toMatchObject({
			label: 'Blue',
			status: 'Draft',
		});
		const before = await saved();
		await project.updateDocumentMetadata(
			id,
			{ label: 'Blue', status: 'Draft' },
			{ force: true }
		);
		const after = await saved();
		expect(after.metadata).toMatchObject({ LabelID: '7', StatusID: '4' });
		expect(after.metadata.Label).toBeUndefined();
		expect(after.metadata.Status).toBeUndefined();
		expect(after.tree.LabelSettings).toEqual(before.tree.LabelSettings);
		expect(after.tree.StatusSettings).toEqual(before.tree.StatusSettings);
	});
	it('persists new names and native definitions together, without duplicate entries on retry', async () => {
		const update = { label: 'Mira — 東京', status: 'Reviewed café' };
		await project.updateDocumentMetadata(id, update, { force: true });
		await project.updateDocumentMetadata(id, update, { force: true });
		const { tree, metadata } = await saved();
		const labels = tree.LabelSettings.Labels.Label;
		const statuses = tree.StatusSettings.StatusItems.Status;
		expect(labels.filter((v: { _: string }) => v._ === update.label)).toHaveLength(1);
		expect(statuses.filter((v: { _: string }) => v._ === update.status)).toHaveLength(1);
		expect(labels.find((v: { $: { ID: string } }) => v.$.ID === metadata.LabelID)._).toBe(
			update.label
		);
		expect(statuses.find((v: { $: { ID: string } }) => v.$.ID === metadata.StatusID)._).toBe(
			update.status
		);
		expect(labels.find((v: { $: { ID: string } }) => v.$.ID === '7').$.Color).toBe(
			'0.2 0.3 0.4'
		);
		expect((await project.getDocumentInfo(id)).document).toMatchObject(update);
		await reopen();
		expect((await project.getDocumentInfo(id)).document).toMatchObject(update);
	});
	it('clears assignments with native no-value IDs and never revives stale legacy fields', async () => {
		await project.updateDocumentMetadata(id, { label: '', status: '' }, { force: true });
		const { metadata } = await saved();
		expect(metadata).toMatchObject({ LabelID: '-1', StatusID: '-1' });
		expect((await project.getDocumentInfo(id)).document?.label).toBeUndefined();
		expect((await project.getDocumentInfo(id)).document?.status).toBeUndefined();
		await reopen();
		expect((await project.getDocumentInfo(id)).document?.label).toBeUndefined();
		expect((await project.getDocumentInfo(id)).document?.status).toBeUndefined();
	});
	it('reads legacy names and migrates an edited assignment to the native schema', async () => {
		await project.close();
		await writeFile(
			fixture.scrivxPath,
			fixture.xml
				.replace('<LabelID>7</LabelID>', '<Label>Legacy</Label>')
				.replace('<StatusID>4</StatusID>', '<Status>Old Draft</Status>')
		);
		await reopen();
		expect((await project.getDocumentInfo(id)).document).toMatchObject({
			label: 'Legacy',
			status: 'Old Draft',
		});
		await project.updateDocumentMetadata(
			id,
			{ label: 'Blue', status: 'Draft' },
			{ force: true }
		);
		const { metadata } = await saved();
		expect(metadata).toMatchObject({ LabelID: '7', StatusID: '4' });
		expect(metadata.Label).toBeUndefined();
		expect(metadata.Status).toBeUndefined();
	});
	it('preserves binder bytes, assignments and definitions on failed publication and succeeds on retry', async () => {
		const before = await readFile(fixture.scrivxPath, 'utf8');
		const rename = nativeFs.rename.bind(nativeFs);
		let injected = false;
		jest.spyOn(nativeFs, 'rename').mockImplementation(async (source, target) => {
			if (!injected && target.toString() === fixture.scrivxPath) {
				injected = true;
				throw Object.assign(new Error('Injected classification commit failure'), {
					code: 'EIO',
				});
			}
			return rename(source, target);
		});
		await expect(
			project.updateDocumentMetadata(
				id,
				{ label: 'Pending', status: 'Awaiting' },
				{ force: true }
			)
		).rejects.toThrow(/classification commit failure/);
		expect(injected).toBe(true);
		expect(await readFile(fixture.scrivxPath, 'utf8')).toBe(before);
		expect((await project.getDocumentInfo(id)).document).toMatchObject({
			label: 'Blue',
			status: 'Draft',
		});
		await project.updateDocumentMetadata(
			id,
			{ label: 'Pending', status: 'Awaiting' },
			{ force: true }
		);
		await reopen();
		expect((await project.getDocumentInfo(id)).document).toMatchObject({
			label: 'Pending',
			status: 'Awaiting',
		});
	});
	it('treats native no-value IDs as authoritative over legacy values and resolves named clearing', async () => {
		await project.close();
		await writeFile(
			fixture.scrivxPath,
			fixture.xml
				.replace('<LabelID>7</LabelID>', '<LabelID>-1</LabelID><Label>Stale</Label>')
				.replace('<StatusID>4</StatusID>', '<StatusID>-1</StatusID><Status>Stale</Status>')
				.replace('<Labels>', '<Labels><Label ID="-1">No Label</Label>')
				.replace('<StatusItems>', '<StatusItems><Status ID="-1">No Status</Status>')
		);
		await reopen();
		expect((await project.getDocumentInfo(id)).document?.label).toBeUndefined();
		expect((await project.getDocumentInfo(id)).document?.status).toBeUndefined();
		await project.updateDocumentMetadata(
			id,
			{ label: 'No Label', status: 'No Status' },
			{ force: true }
		);
		expect((await project.getDocumentInfo(id)).document?.label).toBeUndefined();
		expect((await project.getDocumentInfo(id)).document?.status).toBeUndefined();
		const { metadata } = await saved();
		expect(metadata.Label).toBeUndefined();
		expect(metadata.Status).toBeUndefined();
	});
	it.each([
		['<Label ID="8">Blue</Label>', /ambiguous/],
		['<Label ID="7">Duplicate</Label>', /duplicate ID/],
		['<Label ID="invalid">Broken</Label>', /Invalid classification/],
	] as const)(
		'rejects ambiguous or malformed definitions before publication: %s',
		async (extra, error) => {
			await project.close();
			await writeFile(
				fixture.scrivxPath,
				fixture.xml.replace('</Labels>', extra + '</Labels>')
			);
			await reopen();
			const before = await readFile(fixture.scrivxPath, 'utf8');
			await expect(
				project.updateDocumentMetadata(id, { label: 'Blue' }, { force: true })
			).rejects.toThrow(error);
			expect(await readFile(fixture.scrivxPath, 'utf8')).toBe(before);
		}
	);
	it('creates native definitions when settings are empty and exposes them before reopening', async () => {
		await project.close();
		await writeFile(
			fixture.scrivxPath,
			fixture.xml
				.replace(/<LabelSettings>.*?<\/LabelSettings>/s, '<LabelSettings/>')
				.replace(/<StatusSettings>.*?<\/StatusSettings>/s, '<StatusSettings/>')
		);
		await reopen();
		await project.updateDocumentMetadata(
			id,
			{ label: 'POV', status: 'Draft' },
			{ force: true }
		);
		const compile = await project.getCompileMetadata();
		expect(compile.labels).toEqual([expect.objectContaining({ id: '0', title: 'POV' })]);
		expect(compile.statuses).toEqual([{ id: '0', title: 'Draft' }]);
		await reopen();
		expect((await project.getDocumentInfo(id)).document).toMatchObject({
			label: 'POV',
			status: 'Draft',
		});
	});
	it.each([9999, 10000, 10001])(
		'bounds classification names at %i characters before publishing',
		async (length) => {
			const before = await readFile(fixture.scrivxPath, 'utf8');
			const pending = project.updateDocumentMetadata(
				id,
				{ label: 'x'.repeat(length), status: 's'.repeat(length) },
				{ force: true }
			);
			if (length > 10000) {
				await expect(pending).rejects.toThrow(/10000/);
				expect(await readFile(fixture.scrivxPath, 'utf8')).toBe(before);
			} else {
				await pending;
				await reopen();
				expect((await project.getDocumentInfo(id)).document?.label).toHaveLength(length);
				expect((await project.getDocumentInfo(id)).document?.status).toHaveLength(length);
			}
		}
	);
	it.each([42, null, {}, ['Blue']])(
		'rejects non-string classification names without changing the project',
		async (value) => {
			const before = await readFile(fixture.scrivxPath, 'utf8');
			await expect(
				project.updateMetadata(id, { label: value, status: 'Pending' }, { force: true })
			).rejects.toThrow(/string/);
			expect(await readFile(fixture.scrivxPath, 'utf8')).toBe(before);
		}
	);
});
