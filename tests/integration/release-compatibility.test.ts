import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseStringPromise } from 'xml2js';
import { ProjectLoader } from '../../src/services/project-loader.js';
import { DocumentManager } from '../../src/services/document-manager.js';
import { RTFHandler } from '../../src/services/parsers/rtf-handler.js';
import { spliceRtfText } from '../../src/services/parsers/rtf-splice.js';
import { findSnapshot, listDocumentSnapshots } from '../../src/services/snapshots.js';
import { findScrivxPath, resolveScrivenerProjectPath } from '../../src/utils/scrivener-utils.js';
import {
	COMPATIBILITY_IDS,
	COMPATIBILITY_LAYOUTS,
	createCompatibilityProject,
} from '../fixtures/compatibility.js';

describe.each(COMPATIBILITY_LAYOUTS)('release compatibility: %s synthetic layout', (layout) => {
	let root: string;
	let fixture: Awaited<ReturnType<typeof createCompatibilityProject>>;
	let loader: ProjectLoader;
	let documents: DocumentManager;
	let second: DocumentManager | undefined;
	const parse = (xml: string) => parseStringPromise(xml, { explicitArray: false });

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'scrivener-compatibility-'));
		fixture = await createCompatibilityProject(root, layout);
		loader = new ProjectLoader(fixture.projectPath);
		documents = new DocumentManager(fixture.projectPath);
		documents.setProjectStructure(await loader.loadProject());
	});

	afterEach(async () => {
		await second?.close();
		second = undefined;
		await documents.close();
		await rm(root, { recursive: true, force: true });
	});

	it('resolves native package and alternate Windows project filenames and preserves metadata/unknown XML over reloads', async () => {
		expect(await findScrivxPath(fixture.projectPath)).toBe(fixture.scrivxPath);
		expect(await resolveScrivenerProjectPath(fixture.scrivxPath)).toEqual({
			projectPath: fixture.projectPath,
			scrivxPath: fixture.scrivxPath,
		});
		const original = await parse(fixture.xml);
		await loader.saveProject();
		expect(await parse(await readFile(fixture.scrivxPath, 'utf8'))).toEqual(original);
		documents.setProjectStructure(await loader.reloadProject());
		const all = await documents.getAllDocuments();
		expect(all.find((doc) => doc.id === COMPATIBILITY_IDS.scene)?.title).toBe(
			'Café Żółć — arrival 🕯️'
		);
		expect(all.find((doc) => doc.id === COMPATIBILITY_IDS.scene)?.synopsis).toContain(
			'café 🌙'
		);
		await documents.renameDocument(COMPATIBILITY_IDS.scene, 'Renamed — 東京 🚀');
		await loader.saveProject();
		original.ScrivenerProject.Binder.BinderItem[0].Children.BinderItem.Children.BinderItem.Title =
			'Renamed — 東京 🚀';
		expect(await parse(await readFile(fixture.scrivxPath, 'utf8'))).toEqual(original);
		await loader.reloadProject();
		await loader.saveProject();
		expect(await parse(await readFile(fixture.scrivxPath, 'utf8'))).toEqual(original);
	});

	it('round-trips Unicode and formatting while preserving untouched annotations, footnotes, images and native snapshot bytes', async () => {
		const before = await documents.readDocumentFormatted(COMPATIBILITY_IDS.scene);
		expect(before.plainText).toContain('Café 東京 🌙 — Żółć.');
		expect(
			before.formattedText.some(
				(part) => part.text.includes('Bold lantern') && part.style?.bold
			)
		).toBe(true);
		expect(
			before.formattedText.some(
				(part) => part.text.includes('italic water') && part.style?.italic
			)
		).toBe(true);
		const intended = before.plainText.replace('quiet arrival', 'silent arrival');
		const splice = spliceRtfText(fixture.raw, before.plainText, intended);
		expect(splice).not.toBeNull();
		const revision = await documents.readDocumentRevision(COMPATIBILITY_IDS.scene);
		const applied = await documents.writeRawContent(COMPATIBILITY_IDS.scene, splice!.rtf, {
			expectedRevision: revision,
			operationId: `compatibility-${layout}`,
		});
		expect(applied.state).toBe('committed');
		const afterRaw = await readFile(fixture.scenePath, 'utf8');
		expect(afterRaw).toBe(splice!.rtf);
		for (const group of fixture.preservedGroups) expect(afterRaw).toContain(group);
		expect(await readFile(fixture.imagePath)).toEqual(fixture.image);
		expect(await documents.readDocument(COMPATIBILITY_IDS.scene)).toBe(intended);
		const after = await documents.readDocumentFormatted(COMPATIBILITY_IDS.scene);
		expect(
			after.formattedText.some(
				(part) => part.text.includes('Bold lantern') && part.style?.bold
			)
		).toBe(true);
		expect(
			after.formattedText.some(
				(part) => part.text.includes('italic water') && part.style?.italic
			)
		).toBe(true);
		const snapshots = await listDocumentSnapshots(fixture.projectPath, COMPATIBILITY_IDS.scene);
		expect(snapshots).toHaveLength(1);
		const snapshot = await findSnapshot(
			fixture.projectPath,
			COMPATIBILITY_IDS.scene,
			snapshots[0].snapshotId
		);
		expect(snapshot).toBeDefined();
		expect(await readFile(snapshot!.rtfPath, 'utf8')).toBe(fixture.raw);
		const checksum = await readFile(
			join(fixture.projectPath, 'Files', 'Data', 'docs.checksum'),
			'utf8'
		);
		expect(checksum).toContain(
			`${COMPATIBILITY_IDS.scene}/content.rtf=${createHash('sha1').update(afterRaw).digest('hex')}`
		);
	});

	it('refreshes cached saved edits and rejects a stale second server without changing the winning revision', async () => {
		second = new DocumentManager(fixture.projectPath);
		const sourceRevision = await documents.readDocumentRevision(COMPATIBILITY_IDS.scene);
		await second.readDocument(COMPATIBILITY_IDS.scene);
		const freshRaw = new RTFHandler().convertToRTF('External saved text — café 東京 🌙.');
		await writeFile(fixture.scenePath, freshRaw);
		expect(await documents.readDocument(COMPATIBILITY_IDS.scene)).toBe(
			'External saved text — café 東京 🌙.'
		);
		expect(await second.readDocument(COMPATIBILITY_IDS.scene)).toBe(
			'External saved text — café 東京 🌙.'
		);
		await expect(
			second.writeRawContent(COMPATIBILITY_IDS.scene, fixture.raw, {
				expectedRevision: sourceRevision,
			})
		).rejects.toThrow(/stale|revision/i);
		const sharedRevision = await documents.readDocumentRevision(COMPATIBILITY_IDS.scene);
		const winningRaw = new RTFHandler().convertToRTF('First server saved revision — 🚀.');
		await documents.writeRawContent(COMPATIBILITY_IDS.scene, winningRaw, {
			expectedRevision: sharedRevision,
			operationId: `winner-${layout}`,
		});
		await expect(
			second.writeRawContent(
				COMPATIBILITY_IDS.scene,
				new RTFHandler().convertToRTF('Stale second server write.'),
				{ expectedRevision: sharedRevision }
			)
		).rejects.toThrow(/stale|revision/i);
		expect(await readFile(fixture.scenePath, 'utf8')).toBe(winningRaw);
		expect(await second.readDocument(COMPATIBILITY_IDS.scene)).toBe(
			'First server saved revision — 🚀.'
		);
	});
});
