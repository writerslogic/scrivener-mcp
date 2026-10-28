import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { ProjectLoader } from '../../../src/services/project-loader.js';
import {
	MutationCoordinator,
	documentRevision,
	type MutationRecord,
} from '../../../src/services/editorial/mutation-coordinator.js';
import { PersistentStore } from '../../../src/services/editorial/persistent-store.js';
import type { ProjectStructure, BinderItem } from '../../../src/types/internal.js';

const SOURCE =
	'<?xml version="1.0" encoding="UTF-8"?><ScrivenerProject Identifier="test-project" Vendor="keep"><Binder><BinderItem UUID="11111111-1111-4111-8111-111111111111" Type="Text"><Title>Original</Title></BinderItem></Binder></ScrivenerProject>';
let root: string;
let file: string;
let loaders: ProjectLoader[];

function loader(): ProjectLoader {
	const instance = new ProjectLoader(root);
	loaders.push(instance);
	return instance;
}

function firstItem(structure: ProjectStructure): BinderItem {
	const items = structure.ScrivenerProject!.Binder!.BinderItem!;
	return Array.isArray(items) ? items[0] : items;
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(tmpdir(), 'scrivener-binder-conflicts-'));
	file = path.join(root, `${path.basename(root)}.scrivx`);
	await fs.writeFile(file, SOURCE);
	loaders = [];
});

afterEach(async () => {
	for (const instance of loaders) instance.close();
	await fs.rm(root, { recursive: true, force: true });
});

test('same-size saved changes are detected by hash even when the external editor preserves mtime', async () => {
	const instance = loader();
	const structure = await instance.loadProject();
	const stat = await fs.stat(file);
	const external = SOURCE.replace('Original', 'External');
	await fs.writeFile(file, external);
	await fs.utimes(file, stat.atime, stat.mtime);
	expect(await instance.isProjectModified()).toBe(true);
	firstItem(structure).Title = 'Stale title';
	await expect(instance.saveProject()).rejects.toThrow(/stale.*revision/i);
	expect(await fs.readFile(file, 'utf8')).toBe(external);
});

test('independent loaders reject a stale binder save and can save again after a fresh load', async () => {
	const first = loader();
	const second = loader();
	const one = await first.loadProject();
	const two = await second.loadProject();
	firstItem(one).Title = 'First server';
	await first.saveProject();
	expect(await first.isProjectModified()).toBe(false);
	expect(await second.isProjectModified()).toBe(true);
	firstItem(two).Title = 'Stale second server';
	await expect(second.saveProject()).rejects.toThrow(/stale.*revision/i);
	const fresh = await second.reloadProject();
	firstItem(fresh).Title = 'Reviewed second server';
	await second.saveProject();
	const saved = await fs.readFile(file, 'utf8');
	expect(saved).toContain('Reviewed second server');
	expect(saved).toContain('Vendor="keep"');
});

test('project backup restoration is revision-guarded and preserves the official backup round trip', async () => {
	const instance = loader();
	const structure = await instance.loadProject();
	const backup = await instance.createBackup();
	firstItem(structure).Title = 'Server title';
	await instance.saveProject();
	const external = SOURCE.replace('Original', 'External');
	await fs.writeFile(file, external);
	await expect(instance.restoreFromBackup(backup)).rejects.toThrow(/stale.*revision/i);
	expect(await fs.readFile(file, 'utf8')).toBe(external);
	await instance.reloadProject();
	await instance.restoreFromBackup(backup);
	expect(await fs.readFile(file, 'utf8')).toBe(SOURCE);
	expect(await instance.isProjectModified()).toBe(false);
	expect((await instance.listBackups()).length).toBeGreaterThanOrEqual(2);
});

test('binder journal recovery recognizes an already renamed file and never overwrites a third-party revision', async () => {
	const coordinator = new MutationCoordinator(root);
	const store = new PersistentStore(path.join(root, '.scrivener-mcp', 'editorial.sqlite'));
	try {
		const afterRaw = SOURCE.replace('Original', 'Reviewed');
		const record: MutationRecord = {
			id: randomUUID(),
			documentId: path.basename(file),
			targetKind: 'binder',
			projectFile: path.basename(file),
			beforeRaw: SOURCE,
			afterRaw,
			beforeRevision: documentRevision(SOURCE),
			afterRevision: documentRevision(afterRaw),
			beforeExists: true,
			state: 'prepared',
			createdAt: new Date().toISOString(),
		};
		store.put('mutations', record.id, record);
		await fs.writeFile(file, afterRaw);
		expect((await coordinator.recover())[0].state).toBe('committed');
		const external = SOURCE.replace('Original', 'External');
		const conflict = { ...record, id: randomUUID() };
		store.put('mutations', conflict.id, conflict);
		store.put('mutation-pending', conflict.id, { id: conflict.id });
		await fs.writeFile(file, external);
		expect((await coordinator.recover())[0].state).toBe('conflicted');
		expect(await fs.readFile(file, 'utf8')).toBe(external);
		await expect(
			coordinator.commitProjectFile(path.join(root, '..', 'outside.scrivx'), afterRaw, {
				expectedRevision: record.beforeRevision,
			})
		).rejects.toThrow(/inside the project/i);
	} finally {
		coordinator.close();
		store.close();
	}
});
