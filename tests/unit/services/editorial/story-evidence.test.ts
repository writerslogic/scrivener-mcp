import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PersistentStore } from '../../../../src/services/editorial/persistent-store.js';
import { SeriesBible, type StoryScope } from '../../../../src/services/editorial/series-bible.js';
import {
	ContinuityService,
	extractContinuityCandidates,
} from '../../../../src/services/editorial/continuity-service.js';
import { sourcePassage, verifyPassage } from '../../../../src/services/editorial/provenance.js';
import type { ManuscriptSource, SourceDocument } from '../../../../src/services/editorial/types.js';

class FixtureSource implements ManuscriptSource {
	readonly projectPath: string;
	private documents = new Map<string, SourceDocument>();
	constructor(
		readonly projectId: string,
		readonly root: string
	) {
		this.projectPath = join(root, `${projectId}.scriv`);
	}
	set(
		documentId: string,
		text: string,
		order = 0,
		metadata: Record<string, string> = {}
	): SourceDocument {
		const document: SourceDocument = {
			projectId: this.projectId,
			documentId,
			title: `Scene ${documentId}`,
			path: `Manuscript/${documentId}`,
			text,
			order,
			metadata,
			revision: createHash('sha256').update(text).digest('hex'),
		};
		this.documents.set(documentId, document);
		return document;
	}
	async list(): Promise<SourceDocument[]> {
		return [...this.documents.values()];
	}
	async read(documentId: string): Promise<SourceDocument> {
		const document = this.documents.get(documentId);
		if (!document)
			throw Object.assign(new Error('Document was not found'), { code: 'NOT_FOUND' });
		return document;
	}
}

let root: string;
let stores: PersistentStore[];
function store(name: string): PersistentStore {
	const result = new PersistentStore(join(root, `${name}.sqlite`));
	stores.push(result);
	return result;
}
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'scrivener-story-evidence-'));
	stores = [];
});
afterEach(async () => {
	for (const current of stores) current.close();
	await rm(root, { recursive: true, force: true });
});

it('verifies Unicode source offsets, line locations and exact quotation/revision binding', () => {
	const source = new FixtureSource('project-a', root);
	const document = source.set('unicode', '🌙\nÉowyn has green eyes.');
	const passage = sourcePassage(document, 3, document.text.length);
	expect(passage.line).toBe(2);
	expect(passage.quote).toBe('Éowyn has green eyes.');
	expect(verifyPassage(document, passage)).toEqual(passage);
	expect(() => verifyPassage(document, { ...passage, quote: 'forged evidence' })).toThrow(
		/quotation/
	);
	expect(() => verifyPassage({ ...document, revision: 'changed' }, passage)).toThrow(/revision/);
	expect(() => sourcePassage(document, -1, 3)).toThrow(/range/);
	expect(() => sourcePassage(document, 3, 3)).toThrow(/range/);
	expect(() => sourcePassage(document, 3, document.text.length + 1)).toThrow(/range/);
});

it.each([9999, 10000, 10001])('bounds quoted evidence at %i UTF-16 units', (length) => {
	const document = new FixtureSource('project-a', root).set('long', 'a'.repeat(length));
	if (length <= 10000) expect(sourcePassage(document, 0, length).quote).toHaveLength(length);
	else expect(() => sourcePassage(document, 0, length)).toThrow(/10000/);
});

it('isolates project scopes and requires explicit series membership before combining verified provenance', async () => {
	const a = new FixtureSource('project-a', root);
	const b = new FixtureSource('project-b', root);
	const unrelated = new FixtureSource('unrelated', root);
	const docA = a.set('a', 'Mara has green eyes.');
	const docB = b.set('b', 'Mara has green eyes.');
	const shared = store('series');
	const resolver = async (id: string) =>
		id === a.projectId ? a : id === b.projectId ? b : undefined;
	const bibleA = new SeriesBible(a, store('a'), shared, resolver);
	const bibleB = new SeriesBible(b, store('b'), shared, resolver);
	const other = new SeriesBible(unrelated, store('unrelated'), shared, resolver);
	const series = bibleA.createSeries('The Moon Books');
	const scope: StoryScope = { kind: 'series', id: series.id };
	await expect(bibleB.listFacts(scope)).rejects.toThrow(/explicitly selected/);
	await expect(other.listFacts({ kind: 'project', id: a.projectId })).rejects.toThrow(
		/currently open/
	);
	await expect(
		bibleA.curate({
			scope,
			kind: 'character',
			subject: 'Mara',
			predicate: 'eye-color',
			value: 'green',
			confidence: 'confirmed',
			sources: [sourcePassage(docB, 0, docB.text.length)],
		})
	).rejects.toThrow(/outside/);
	bibleB.joinSeries(series.id);
	const fact = await bibleA.curate({
		scope,
		kind: 'character',
		subject: 'Mara',
		predicate: 'eye-color',
		value: 'green',
		confidence: 'confirmed',
		sources: [
			sourcePassage(docA, 0, docA.text.length),
			sourcePassage(docB, 0, docB.text.length),
		],
	});
	expect((await bibleB.listFacts(scope))[0].id).toBe(fact.id);
	expect((await bibleB.recheck(scope)).current).toBe(1);
	b.set('b', 'Mara has blue eyes.');
	expect((await bibleA.recheck(scope)).stale).toBe(1);
	bibleB.leaveSeries(series.id);
	expect((await bibleA.recheck(scope)).unavailable).toBe(1);
	await expect(bibleB.listFacts(scope)).rejects.toThrow(/explicitly selected/);
	await expect(other.listFacts(scope)).rejects.toThrow(/explicitly selected/);
});

it('persists idempotent curated corrections without silently overwriting competing corrections', async () => {
	const source = new FixtureSource('project-a', root);
	const document = source.set('a', 'Mara has green eyes.');
	const database = store('facts');
	let bible = new SeriesBible(source, database);
	const scope: StoryScope = { kind: 'project', id: source.projectId };
	await expect(
		bible.curate({
			scope,
			kind: 'character',
			subject: 'Mara',
			predicate: 'eye-color',
			value: 'green',
			confidence: 'confirmed',
			sources: [],
		})
	).rejects.toThrow(/verified source/);
	const input = {
		scope,
		kind: 'character' as const,
		subject: 'Mara',
		predicate: 'eye-color',
		value: 'green',
		confidence: 'inferred' as const,
		sources: [sourcePassage(document, 0, document.text.length)],
	};
	const original = await bible.curate(input);
	expect((await bible.curate(input)).id).toBe(original.id);
	const corrected = await bible.correct(scope, original.id, { confidence: 'confirmed' });
	expect(corrected.supersedes).toBe(original.id);
	expect((await bible.correct(scope, original.id, { confidence: 'confirmed' })).id).toBe(
		corrected.id
	);
	await expect(bible.correct(scope, original.id, { value: 'blue' })).rejects.toThrow(
		/already been corrected/
	);
	bible = new SeriesBible(source, store('facts'));
	expect((await bible.listFacts(scope)).map((fact) => fact.id)).toEqual([corrected.id]);
	expect(await bible.listFacts(scope, { includeSuperseded: true })).toHaveLength(2);
	await expect(bible.curate({ ...input, id: original.id, value: 'blue' })).rejects.toThrow(
		/different content/
	);
});

it('uses binder order, quotes and revision-bound persistent decisions for inferred mismatches', async () => {
	const source = new FixtureSource('project-a', root);
	const first = source.set('z-first', 'Mara has blue eyes.', 0);
	const second = source.set('a-second', 'Mara has green eyes.', 1);
	const database = store('continuity');
	let service = new ContinuityService(source, database, new SeriesBible(source, database));
	const report = await service.analyze();
	expect(report.issues).toHaveLength(1);
	const finding = report.issues[0];
	expect(finding.confidence).toBe('inferred');
	expect(finding.evidence.map((passage) => passage.documentId)).toEqual([
		first.documentId,
		second.documentId,
	]);
	expect(finding.evidence[0].revision).toBe(first.revision);
	service.transition(finding.id, 'dismiss', 'The narrator misremembers.');
	service = new ContinuityService(source, store('continuity'), new SeriesBible(source, database));
	expect((await service.analyze()).issues).toHaveLength(0);
	expect(service.list({ includeResolved: true })[0].status).toBe('dismissed');
	source.set(second.documentId, 'Mara has brown eyes.', 1);
	expect((await service.recheck(finding.id))[0].stale).toBe(true);
	expect(() => service.transition(finding.id, 'confirm')).toThrow(/Recheck stale/);
	expect((await service.analyze()).issues).toHaveLength(1);
});

it('only labels opposing confirmed immutable facts as confirmed canon conflicts', async () => {
	const source = new FixtureSource('project-a', root);
	const first = source.set('first', 'Mara was born in 1984.', 0);
	const second = source.set('second', 'Mara was born in 1985.', 1);
	const database = store('canon');
	const bible = new SeriesBible(source, database);
	for (const [document, value] of [
		[first, '1984'],
		[second, '1985'],
	] as const)
		await bible.curate({
			scope: { kind: 'project', id: source.projectId },
			kind: 'chronology',
			subject: 'Mara',
			predicate: 'birth-year',
			value,
			confidence: 'confirmed',
			sources: [sourcePassage(document, 0, document.text.length)],
		});
	const report = await new ContinuityService(source, database, bible).analyze();
	expect(report.issues).toHaveLength(1);
	expect(report.issues[0].confidence).toBe('confirmed');
	expect(report.counts.errors).toBe(1);
});

it('does not assert contradictions from time keywords, flashbacks, quoted claims or intentional changes', async () => {
	const source = new FixtureSource('project-a', root);
	source.set(
		'first',
		'Mara has blue eyes. Yesterday, today, tomorrow and next week all mattered.',
		0
	);
	source.set('flashback', 'Mara had green eyes.', 1, { flashback: 'true' });
	source.set('quote', '“Mara has brown eyes,” he claimed.', 2);
	source.set('intentional', 'Mara has violet eyes.', 3, { intentionalContradiction: 'true' });
	const database = store('context');
	const service = new ContinuityService(source, database, new SeriesBible(source, database));
	expect((await service.analyze()).issues).toEqual([]);
	expect(extractContinuityCandidates(await source.read('flashback'))[0].confidence).toBe(
		'uncertain'
	);
});

it('compares a confirmed alias to its canonical character without crossing project scopes', async () => {
	const source = new FixtureSource('project-a', root);
	const first = source.set('first', 'Mara has blue eyes. Her alias is Raven.', 0);
	const second = source.set('second', 'Raven has green eyes.', 1);
	const database = store('alias');
	const bible = new SeriesBible(source, database);
	await bible.curate({
		scope: { kind: 'project', id: source.projectId },
		kind: 'alias',
		subject: 'Mara',
		predicate: 'alias',
		value: 'Raven',
		confidence: 'confirmed',
		sources: [sourcePassage(first, 20, first.text.length)],
	});
	const report = await new ContinuityService(source, database, bible).analyze();
	expect(report.issues).toHaveLength(1);
	expect(report.issues[0].evidence.map((passage) => passage.documentId)).toEqual([
		first.documentId,
		second.documentId,
	]);
});

it('rechecks actual findings after an edit and closes obsolete concerns without overwriting author dismissals', async () => {
	const source = new FixtureSource('project-a', root);
	source.set('first', 'Mara has blue eyes.', 0);
	source.set('second', 'Mara has green eyes.', 1);
	const database = store('recheck');
	const service = new ContinuityService(source, database, new SeriesBible(source, database));
	const original = (await service.analyze()).issues[0];
	source.set('second', 'Mara has blue eyes.', 1);
	const checked = await service.recheck(original.id);
	expect(checked[0].status).toBe('resolved');
	expect(checked[0].resolution).toBe('no-longer-detected');
	expect(checked[0].stale).toBe(true);
	expect(service.list()).toEqual([]);
	source.set('second', 'Mara has green eyes.', 1);
	expect((await service.analyze()).issues[0].id).toBe(original.id);
	expect(service.list()[0].status).toBe('open');
});

it('honors a curated intentional variation in the corresponding narrative evidence', async () => {
	const source = new FixtureSource('project-a', root);
	source.set('first', 'Mara has blue eyes.', 0);
	const variant = source.set('second', 'Mara has green eyes.', 1);
	const database = store('intentional');
	const bible = new SeriesBible(source, database);
	await bible.curate({
		scope: { kind: 'project', id: source.projectId },
		kind: 'character',
		subject: 'Mara',
		predicate: 'eye-color',
		value: 'green',
		confidence: 'confirmed',
		intentional: true,
		sources: [sourcePassage(variant, 0, variant.text.length)],
	});
	expect((await new ContinuityService(source, database, bible).analyze()).issues).toEqual([]);
});

it('imports legacy memory without fabricated quotations or silently declaring it canon', async () => {
	const source = new FixtureSource('project-a', root);
	const bible = new SeriesBible(source, store('legacy'));
	const memory = {
		getAllCharacters: () => [{ id: 'mara', name: 'Mara', description: 'Navigator' }],
		getCustomContext: () => ({
			locations: [{ name: 'Moon Harbor', description: 'A tidal port' }],
		}),
		getPlotThreads: () => [
			{ id: 'voyage', name: 'The voyage', description: 'Find the ship', status: 'setup' },
		],
	};
	const imported = await bible.importMemory(memory as never);
	expect(imported.map((fact) => fact.kind).sort()).toEqual([
		'character',
		'chronology',
		'location',
	]);
	expect(
		imported.every((fact) => fact.confidence === 'inferred' && fact.sources.length === 0)
	).toBe(true);
	expect(await bible.importMemory(memory as never)).toEqual([]);
});
