import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PersistentStore } from '../../../src/services/editorial/persistent-store.js';
import { ProjectSource } from '../../../src/services/editorial/project-source.js';
import {
	manuscriptDocuments,
	registerProject,
} from '../../../src/services/editorial/project-registry.js';
import { RTFHandler } from '../../../src/services/parsers/rtf-handler.js';
import { SeriesBible } from '../../../src/services/editorial/series-bible.js';
import { ContinuityService } from '../../../src/services/editorial/continuity-service.js';
import { sourcePassage } from '../../../src/services/editorial/provenance.js';
import type { ScrivenerDocument } from '../../../src/types/index.js';

const FIRST = '10000000-0000-4000-8000-000000000001';
const SECOND = '10000000-0000-4000-8000-000000000002';
const RESEARCH = '10000000-0000-4000-8000-000000000003';
const EXCLUDED = '10000000-0000-4000-8000-000000000004';
let root: string;
const stores = new Set<PersistentStore>();
function openStore(file: string): PersistentStore {
	const store = new PersistentStore(file);
	stores.add(store);
	return store;
}
function closeStore(store: PersistentStore): void {
	store.close();
	stores.delete(store);
}
function document(
	id: string,
	text: string,
	options: Partial<ScrivenerDocument> = {}
): ScrivenerDocument {
	return { id, title: text, type: 'Text', path: `Manuscript/${text}`, ...options };
}
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'scrivener-project-source-'));
});
afterEach(async () => {
	for (const store of stores) store.close();
	stores.clear();
	await rm(root, { recursive: true, force: true });
});

it('retains a stable canonical project identity across independently opened database handles and restart', async () => {
	const file = join(root, '.scrivener-mcp', 'editorial.sqlite');
	const firstStore = openStore(file);
	const first = new ProjectSource(
		join(root, '.'),
		firstStore,
		async () => [],
		async () => ''
	);
	const secondStore = openStore(file);
	const second = new ProjectSource(
		root,
		secondStore,
		async () => [],
		async () => ''
	);
	expect(second.projectId).toBe(first.projectId);
	expect(first.projectPath).toBe(realpathSync(resolve(root)));
	const identity = first.projectId;
	closeStore(firstStore);
	closeStore(secondStore);
	const restarted = new ProjectSource(
		root,
		openStore(file),
		async () => [],
		async () => ''
	);
	expect(restarted.projectId).toBe(identity);
	expect(restarted.projectId).toMatch(/^[0-9a-f-]{36}$/i);
});

it('binds source revisions to exact raw RTF and refreshes text without stale content caching', async () => {
	const parser = new RTFHandler();
	const originals = new Map([
		[FIRST, parser.convertToRTF('Café — 星 🌙')],
		[SECOND, parser.convertToRTF('Second scene')],
	]);
	const selected = [
		document(FIRST, 'The harbor', {
			metadata: { storyTime: 'morning', label: 'old' },
			customMetadata: { storyTime: '2040-05-01' },
			sectionTypeId: 'scene',
		}),
		document(SECOND, 'Return'),
	];
	const source = new ProjectSource(
		root,
		openStore(join(root, 'state.sqlite')),
		async () => selected,
		async (id) => originals.get(id)!
	);
	const first = await source.read(FIRST);
	expect(first.text).toBe('Café — 星 🌙');
	expect(first.revision).toBe(
		createHash('sha256').update(originals.get(FIRST)!, 'utf8').digest('hex')
	);
	expect(first.metadata).toMatchObject({
		storyTime: '2040-05-01',
		label: 'old',
		sectionTypeId: 'scene',
	});
	originals.set(FIRST, originals.get(FIRST)!.replace('\\rtf1', '\\rtf1\\viewkind4'));
	const formattingOnly = await source.read(FIRST);
	expect(formattingOnly.text).toBe(first.text);
	expect(formattingOnly.revision).not.toBe(first.revision);
	originals.set(FIRST, parser.convertToRTF('Café — a changed scene 🌙'));
	const changed = await source.read(FIRST);
	expect(changed.text).toBe('Café — a changed scene 🌙');
	expect(changed.revision).not.toBe(formattingOnly.revision);
	const list = await source.list();
	expect(list.map((item) => [item.documentId, item.order])).toEqual([
		[FIRST, 0],
		[SECOND, 1],
	]);
	expect(list[0].revision).toBe(changed.revision);
});

it('keeps research and excluded draft text out of manuscript analysis while allowing explicit active-project provenance reads', async () => {
	const chapter = document('10000000-0000-4000-8000-000000000010', 'Chapter One', {
		type: 'Folder',
		children: [
			document(FIRST, 'Scene One'),
			document(EXCLUDED, 'Rough draft', { includeInCompile: false }),
		],
	});
	const draft = document('10000000-0000-4000-8000-000000000011', 'Manuscript', {
		type: 'Folder',
		children: [chapter],
	});
	(draft as { type: string }).type = 'DraftFolder';
	const research = document(RESEARCH, 'Research notes');
	const tree = [draft, research];
	const active = [draft, chapter, ...chapter.children!, research];
	const source = new ProjectSource(
		root,
		openStore(join(root, 'scope.sqlite')),
		async () => manuscriptDocuments(tree),
		async (id) =>
			new RTFHandler().convertToRTF(
				id === RESEARCH ? 'Confirmed world-rule reference' : 'Manuscript prose'
			),
		async () => active
	);
	expect((await source.list()).map((item) => item.documentId)).toEqual([FIRST]);
	const reference = await source.read(RESEARCH);
	expect(reference.text).toBe('Confirmed world-rule reference');
	expect(reference.documentId).toBe(RESEARCH);
	expect(reference.order).toBe(Number.MAX_SAFE_INTEGER);
	expect((await source.read(EXCLUDED)).documentId).toBe(EXCLUDED);
	await expect(source.read('10000000-0000-4000-8000-000000000099')).rejects.toThrow(
		/selected project scope/
	);
});

it.each([9999, 10000, 10001])(
	'enforces the manuscript document budget at %i documents',
	async (count) => {
		const documents = Array.from({ length: count }, (_, index) =>
			document(`10000000-0000-4000-8000-${String(index).padStart(12, '0')}`, `Scene ${index}`)
		);
		let materialized = 0;
		const source = new ProjectSource(
			root,
			openStore(join(root, 'budget.sqlite')),
			async () => documents,
			async () => {
				materialized++;
				return '';
			}
		);
		if (count <= 10000) {
			const result = await source.list();
			expect(result).toHaveLength(count);
			expect(result[result.length - 1].order).toBe(count - 1);
			expect(result.every((item) => item.text === '')).toBe(true);
		} else {
			await expect(source.list()).rejects.toThrow(/10000 documents/);
			await expect(source.read(documents[0].id)).rejects.toThrow(/10000 documents/);
			expect(materialized).toBe(0);
		}
	}
);

it('rejects repeated binder document identities even when UUID letter casing differs', async () => {
	const upper = 'ABCDEF12-ABCD-4ABC-8ABC-ABCDEF123456';
	let materialized = 0;
	const source = new ProjectSource(
		root,
		openStore(join(root, 'duplicates.sqlite')),
		async () => [document(upper, 'Original'), document(upper.toLowerCase(), 'Duplicate')],
		async () => { materialized++; return ''; }
	);
	await expect(source.list()).rejects.toThrow(/duplicate document identities/);
	await expect(source.read(upper)).rejects.toThrow(/duplicate document identities/);
	expect(materialized).toBe(0);
});

it('refuses to register a copied identity while the original project exists and preserves the original registration', async () => {
	const originalPath = join(root, 'Original.scriv');
	const copiedPath = join(root, 'Copy.scriv');
	await mkdir(originalPath);
	await mkdir(copiedPath);
	const registry = openStore(join(root, 'registry.sqlite'));
	const originalStore = openStore(join(originalPath, 'state.sqlite'));
	const original = new ProjectSource(
		originalPath,
		originalStore,
		async () => [],
		async () => ''
	);
	registerProject(registry, original);
	const copiedStore = openStore(join(copiedPath, 'state.sqlite'));
	copiedStore.put('identity', 'project', original.projectId);
	const copied = new ProjectSource(
		copiedPath,
		copiedStore,
		async () => [],
		async () => ''
	);
	expect(() => registerProject(registry, copied)).toThrow(
		/copied project shares an editorial identity/
	);
	expect(registry.get('registered-projects', original.projectId)).toMatchObject({
		projectPath: original.projectPath,
	});
	closeStore(originalStore);
	await rm(originalPath, { recursive: true });
	registerProject(registry, copied);
	expect(registry.get('registered-projects', original.projectId)).toMatchObject({
		projectPath: copied.projectPath,
	});
});

it('rechecks removed binder documents as unavailable provenance and stale continuity evidence without aborting', async () => {
	const store = openStore(join(root, 'removed-source.sqlite'));
	const parser = new RTFHandler();
	const saved = new Map([
		[FIRST, parser.convertToRTF('Mara has blue eyes.')],
		[SECOND, parser.convertToRTF('Mara has green eyes.')],
	]);
	let documents = [document(FIRST, 'Earlier scene'), document(SECOND, 'Later scene')];
	const source = new ProjectSource(
		root,
		store,
		async () => documents,
		async (id) => saved.get(id)!
	);
	const bible = new SeriesBible(source, store);
	const continuity = new ContinuityService(source, store, bible);
	const quoted = await source.read(FIRST);
	const scope = { kind: 'project' as const, id: source.projectId };
	await bible.curate({
		scope,
		kind: 'character',
		subject: 'Mara',
		predicate: 'eye-color',
		value: 'blue',
		confidence: 'confirmed',
		sources: [sourcePassage(quoted, 0, quoted.text.length)],
	});
	const finding = (await continuity.analyze()).issues[0];
	expect(finding).toBeDefined();
	documents = documents.filter((entry) => entry.id !== FIRST);
	const checkedBible = await bible.recheck(scope);
	expect(checkedBible.unavailable).toBe(1);
	expect(checkedBible.facts[0]).toMatchObject({
		stale: true,
		sourceStates: [{ state: 'unavailable' }],
	});
	const checkedFinding = await continuity.recheck(finding.id);
	expect(checkedFinding[0].stale).toBe(true);
});
