import { checkConsistencyHandler } from '../../../../src/handlers/analysis-handlers/consistency.js';
import { continuityFindingsHandler } from '../../../../src/handlers/story-handlers.js';
import type { HandlerContext } from '../../../../src/handlers/types.js';
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
import {
	passageState,
	sourcePassage,
	verifyPassage,
} from '../../../../src/services/editorial/provenance.js';
import type { ManuscriptSource, SourceDocument } from '../../../../src/services/editorial/types.js';

class FixtureSource implements ManuscriptSource {
	readonly projectPath: string;
	reads = 0;
	lists = 0;
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
		this.lists++;
		return [...this.documents.values()];
	}
	async read(documentId: string): Promise<SourceDocument> {
		this.reads++;
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
	expect(() => sourcePassage(document, 1, 3)).toThrow(/Unicode/);
	expect(() => sourcePassage(document, 0, 1)).toThrow(/Unicode/);
	expect(passageState({ ...document, projectId: 'other-project' }, passage)).toBe('stale');
	expect(passageState({ ...document, documentId: 'other-document' }, passage)).toBe('stale');
	expect(
		passageState(document, { ...passage, start: 1, end: 2, quote: document.text.slice(1, 2) })
	).toBe('stale');
	for (const length of [9999, 10000, 10001]) {
		const long = source.set('long', 'a'.repeat(length));
		if (length <= 10000) expect(sourcePassage(long, 0, length).quote).toHaveLength(length);
		else expect(() => sourcePassage(long, 0, length)).toThrow(/10000/);
	}
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
	for (const patch of [{ value: 'blue' }, { confidence: 'inferred' as const }]) {
		await expect(bible.correct(scope, original.id, patch)).rejects.toThrow(
			/already been corrected/
		);
	}
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
	const replacement = service.list()[0];
	expect(replacement.id).not.toBe(finding.id);
	source.set(second.documentId, 'Mara has blue eyes.', 1);
	const checked = await service.recheck(replacement.id);
	expect(checked[0]).toMatchObject({
		status: 'resolved',
		resolution: 'no-longer-detected',
		stale: true,
	});
	expect(service.list()).toEqual([]);
	source.set(second.documentId, 'Mara has brown eyes.', 1);
	expect((await service.analyze()).issues[0].id).toBe(replacement.id);
	expect(service.list()[0].status).toBe('open');
	expect(
		service.list({ includeResolved: true }).find((issue) => issue.id === finding.id)?.status
	).toBe('dismissed');
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

it('rechecks historical foreign evidence after correction and safely marks departed series context stale', async () => {
	const a = new FixtureSource('project-a', root);
	const b = new FixtureSource('project-b', root);
	const docA = a.set('a', 'Mara has blue eyes.');
	const docB = b.set('b', 'Mara has green eyes.');
	const shared = store('shared-history');
	const database = store('project-history');
	const resolver = async (id: string) => (id === b.projectId ? b : a);
	const bibleA = new SeriesBible(a, database, shared, resolver);
	const bibleB = new SeriesBible(b, store('foreign-history'), shared, resolver);
	const series = bibleA.createSeries('History');
	bibleB.joinSeries(series.id);
	const scope: StoryScope = { kind: 'series', id: series.id };
	const fact = {
		scope,
		kind: 'character' as const,
		subject: 'Mara',
		predicate: 'eye-color',
		confidence: 'confirmed' as const,
		storyTime: 'present',
	};
	await bibleA.curate({
		...fact,
		value: 'blue',
		sources: [sourcePassage(docA, 0, docA.text.length)],
	});
	const foreign = await bibleB.curate({
		...fact,
		value: 'green',
		sources: [sourcePassage(docB, 0, docB.text.length)],
	});
	const service = new ContinuityService(a, database, bibleA);
	a.reads = 0;
	const finding = (await service.analyze({ seriesId: series.id })).issues[0];
	expect(finding).toBeDefined();
	expect(a.reads).toBe(0);
	await bibleB.correct(scope, foreign.id, { value: 'blue', confidence: 'inferred', sources: [] });
	a.lists = 0;
	b.reads = 0;
	const checked = await service.recheck(finding.id);
	expect(checked[0]).toMatchObject({ status: 'resolved', stale: false });
	expect(a.lists).toBe(2);
	expect(b.reads).toBe(2);
	bibleA.leaveSeries(series.id);
	expect((await service.recheck(finding.id))[0].stale).toBe(true);
});

it('applies the continuity analysis budget to an explicit chapter scope in a larger manuscript', async () => {
	const source = new FixtureSource('project-a', root);
	for (let order = 0; order < 5001; order++) source.set(`scene-${order}`, '', order);
	const database = store('chapter-budget');
	const service = new ContinuityService(source, database, new SeriesBible(source, database));
	const report = await service.analyze({ documentIds: ['scene-5000'] });
	expect(report.analyzedDocuments).toBe(1);
	expect(report.issues).toEqual([]);
	await expect(service.analyze()).rejects.toThrow(/analyze a chapter/);
});

it('imports legacy memory without fabricated quotations or silently declaring it canon', async () => {
	const source = new FixtureSource('project-a', root);
	const bible = new SeriesBible(source, store('legacy'));
	const memory = {
		getMemorySnapshot: () => ({
			characters: [{ id: 'mara', name: 'Mara', description: 'Navigator' }],
			worldBuilding: [],
			customContext: {
				worldBuilding: {
					locations: [{ name: 'Moon Harbor', description: 'A tidal port' }],
				},
			},
			plotThreads: [
				{ id: 'voyage', name: 'The voyage', description: 'Find the ship', status: 'setup' },
			],
		}),
		memoryRevision: () => 'unchanged',
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

it('round-trips private story state and correction history into the same project with exact identities', async () => {
	const source = new FixtureSource('project-a', root);
	const document = source.set('scene', 'Mara has blue eyes.');
	const original = new SeriesBible(source, store('original-state'));
	const scope = { kind: 'project' as const, id: source.projectId };
	const first = await original.curate({
		scope,
		kind: 'character',
		subject: 'Mara',
		predicate: 'eye-color',
		value: 'blue',
		confidence: 'confirmed',
		sources: [sourcePassage(document, 0, document.text.length)],
	});
	const corrected = await original.correct(scope, first.id, { intentional: true });
	const snapshot = JSON.parse(JSON.stringify(original.exportState(scope)));
	const restored = new SeriesBible(source, store('restored-state'));
	const imported = await restored.importState(
		scope,
		snapshot,
		restored.exportState(scope).revision
	);
	expect(imported).toEqual(snapshot);
	expect(await restored.importState(scope, snapshot, imported.revision)).toEqual(imported);
	expect((await restored.listFacts(scope)).map((fact) => fact.id)).toEqual([corrected.id]);
	await expect(restored.correct(scope, first.id, { value: 'green' })).rejects.toThrow(
		/already been corrected/
	);
});

it('rejects stale, foreign, conflicting and cyclic story snapshots without partial inserts', async () => {
	const source = new FixtureSource('project-a', root);
	const document = source.set('scene', 'Mara has blue eyes.');
	const bible = new SeriesBible(source, store('conflicts'));
	const scope = { kind: 'project' as const, id: source.projectId };
	await bible.curate({
		id: 'original',
		scope,
		kind: 'character',
		subject: 'Mara',
		predicate: 'eye-color',
		value: 'blue',
		sources: [sourcePassage(document, 0, document.text.length)],
	});
	const original = bible.exportState(scope);
	const fresh = { ...original.facts[0], id: 'new-fact', predicate: 'observed' };
	for (const facts of [
		[fresh, { ...original.facts[0], value: 'green' }],
		[
			{ ...fresh, id: 'a', supersedes: 'b' },
			{ ...fresh, id: 'b', supersedes: 'a' },
		],
		[{ ...fresh, scope: { kind: 'project', id: 'foreign' } }],
		[{ ...fresh, sources: [{ ...fresh.sources[0], revision: '0'.repeat(64) }] }],
	]) {
		await expect(
			bible.importState(scope, { ...original, facts }, original.revision)
		).rejects.toThrow();
		expect(bible.exportState(scope)).toEqual(original);
	}
	await expect(bible.importState(scope, original, '0'.repeat(64))).rejects.toThrow(/changed/);
});

it.each([999, 1000, 1001])('bounds story-state fact imports at %i records', async (count) => {
	const source = new FixtureSource('project-a', root);
	const bible = new SeriesBible(source, store('bounded'));
	const scope = { kind: 'project' as const, id: source.projectId };
	const empty = bible.exportState(scope);
	const facts = Array.from({ length: count }, (_, index) => ({
		id: `fact-${index}`,
		scope,
		kind: 'character',
		subject: 'Mara',
		predicate: `trait-${index}`,
		value: 'unknown',
		confidence: 'uncertain',
		sources: [],
		updatedAt: '2026-11-01T00:00:00.000Z',
	}));
	const pending = bible.importState(scope, { ...empty, facts }, empty.revision);
	if (count > 1000) {
		await expect(pending).rejects.toThrow(/oversized/);
		expect(bible.exportState(scope)).toEqual(empty);
	} else expect((await pending).facts).toHaveLength(count);
});

it('keeps quotation state across long speech without contaminating later narration', () => {
	const source = new FixtureSource('certainty', root);
	const text = `“${'An extended speech. '.repeat(20)}Mara has blue eyes.”\n\nMara has green eyes.`;
	const candidates = extractContinuityCandidates(source.set('speech', text));
	expect(candidates.map((item) => [item.value, item.confidence])).toEqual([
		['blue', 'uncertain'],
		['green', 'inferred'],
	]);
	for (const candidate of candidates)
		expect(candidate.sources[0].quote).toBe(
			text.slice(candidate.sources[0].start, candidate.sources[0].end)
		);
});

it.each([
	'If Mara has blue eyes, the witness was right.',
	"'O'Neil insisted Mara has blue eyes.'",
	'Mara has blue eyes?',
	'"The witness continued.\n\n"Mara has blue eyes."',
	'Imagine that Mara has blue eyes.',

	'It is not true that Mara has blue eyes.',
	`A rumor circulated. ${'The crowd waited. '.repeat(20)}Mara has blue eyes.`,
	'‘O’Neil insisted Mara has blue eyes.’',
	'“The witness continued.\n\n“Mara has blue eyes.”',
])('preserves uncertainty in %s', (text) => {
	const source = new FixtureSource('uncertainty', root);
	const candidates = extractContinuityCandidates(source.set('scene', text));
	expect(candidates).toHaveLength(1);
	expect(candidates[0].confidence).toBe('uncertain');
});

it('extracts alternative attribute syntax and adjacent coreference with exact Unicode evidence', () => {
	const source = new FixtureSource('attributes', root);
	const text =
		'🌙 The eyes of Élodie Rose were amber. The hair of Élodie Rose was silver. Mara approached. Her eyes were green.';
	const document = source.set('scene', text);
	const candidates = extractContinuityCandidates(document);
	expect(candidates.map((item) => [item.subject, item.predicate, item.value])).toEqual([
		['Mara', 'eye-color', 'green'],
		['Élodie Rose', 'eye-color', 'amber'],
		['Élodie Rose', 'hair-color', 'silver'],
	]);
	for (const candidate of candidates)
		expect(verifyPassage(document, candidate.sources[0])).toEqual(candidate.sources[0]);
});

it.each([
	['Mara stepped forward. Her eyes were green.', 'Mara', 'eye-color', 'green'],
	['Élodie Rose arrived. Her irises are amber.', 'Élodie Rose', 'eye-color', 'amber'],
	['O’Neil paused. His hair was gray.', 'O’Neil', 'hair-color', 'grey'],
	['James waited. He was born in 1801.', 'James', 'birth-year', '1801'],
	['Mara nodded. She was born in 1800.', 'Mara', 'birth-year', '1800'],
])(
	'resolves adjacent single-subject reference with both sentences as evidence: %s',
	(text, subject, predicate, value) => {
		const source = new FixtureSource('coreference', root);
		const document = source.set('scene', text);
		const candidates = extractContinuityCandidates(document);
		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({ subject, predicate, value, confidence: 'inferred' });
		expect(candidates[0].sources[0].quote).toBe(text.slice(0, -1));
		expect(verifyPassage(document, candidates[0].sources[0])).toEqual(candidates[0].sources[0]);
	}
);

it.each([
	'Mara stood beside Elena. Her eyes were green.',
	'Mara and Elena arrived. Her eyes were green.',
	'Mara watched Elena. Her eyes were green.',
	'She arrived. Her eyes were green.',
	'She was born in 1801.',
	'He has green eyes.',
	'The Woman arrived. Her eyes were green.',
	'Somebody arrived. His eyes were green.',
	'Mara arrived. The room fell silent. Her eyes were green.',
	'Mara arrived.\n\nHer eyes were green.',
	'Mara arrived. “Her eyes were green.”',
	'Mara arrived. Their eyes were green.',
	'Elena said Mara arrived. Her eyes were green.',
])('abstains from ambiguous or unsupported coreference: %s', (text) => {
	const source = new FixtureSource('ambiguous', root);
	expect(extractContinuityCandidates(source.set('scene', text))).toEqual([]);
});

it.each([
	'“The witness continued. Mara arrived. Her eyes were green.”',
	'A rumor circulated. Mara arrived. Her eyes were green.',
	'Mara arrived. Her eyes were green?',
	'It was not true. Mara arrived. Her eyes were green.',
])('keeps resolved references uncertain in qualified narration: %s', (text) => {
	const source = new FixtureSource('qualified-reference', root);
	const candidates = extractContinuityCandidates(source.set('scene', text));
	expect(candidates).toHaveLength(1);
	expect(candidates.every((candidate) => candidate.confidence === 'uncertain')).toBe(true);
});

it.each([255, 256, 257])('bounds resolved candidates at %i statements', (count) => {
	const source = new FixtureSource('reference-limit', root);
	const document = source.set('scene', 'Mara arrived. Her eyes were green. '.repeat(count));
	if (count > 256) expect(() => extractContinuityCandidates(document)).toThrow(/256/);
	else expect(extractContinuityCandidates(document)).toHaveLength(count);
});

it('reports a resolved reference conflict with its antecedent evidence and honors intentional changes', async () => {
	const source = new FixtureSource('reference-conflict', root);
	source.set('before', 'Mara has blue eyes.');
	const after = source.set('after', 'Mara stepped forward. Her eyes were green.', 1);
	const storage = store('reference-conflict');
	const service = new ContinuityService(source, storage, new SeriesBible(source, storage));
	const report = await service.analyze();
	expect(report.issues).toHaveLength(1);
	expect(report.issues[0]).toMatchObject({ basis: 'candidate-mismatch', confidence: 'inferred' });
	expect(report.issues[0].evidence.map((item) => item.quote)).toContain(
		'Mara stepped forward. Her eyes were green'
	);
	source.set('after', after.text, 1, { intentionalContradiction: 'true' });
	expect((await service.analyze()).issues).toHaveLength(0);
});

it.each([
	['Nadia greeted Tomas. Nadia has amber eyes.', 'Nadia', 'eye-color', 'amber'],
	['A. B. Singh has green eyes.', 'A. B. Singh', 'eye-color', 'green'],
	['🌙 Blue was the color of Zoë’s eyes.', 'Zoë', 'eye-color', 'blue'],
	['Idris wore his Gray hair loose.', 'Idris', 'hair-color', 'grey'],
	['Zoë paused.\nHer eyes were amber.', 'Zoë', 'eye-color', 'amber'],
	['Idris waited.\r\nHis hair was white.', 'Idris', 'hair-color', 'white'],
])(
	'extracts factual wording without crossing names or losing source offsets: %s',
	(text, subject, predicate, value) => {
		const source = new FixtureSource('fresh-wording', root);
		const document = source.set('scene', text);
		const candidates = extractContinuityCandidates(document);
		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({ subject, predicate, value, confidence: 'inferred' });
		expect(verifyPassage(document, candidates[0].sources[0])).toEqual(candidates[0].sources[0]);
	}
);

it.each([
	'It was never true that Nadia has amber eyes.',
	'The witness doubted that Nadia has amber eyes.',
	'The witness questioned whether Nadia has amber eyes.',
])('does not promote embedded denied or doubted assertions: %s', (text) => {
	const source = new FixtureSource('nonassertion', root);
	const candidates = extractContinuityCandidates(source.set('scene', text));
	expect(candidates).toHaveLength(1);
	expect(candidates[0].confidence).toBe('uncertain');
});

it.each([0, 1, 2])('allows %i line breaks without crossing paragraph boundaries', (count) => {
	const source = new FixtureSource('line-breaks', root);
	const candidates = extractContinuityCandidates(
		source.set('scene', `Nadia paused. ${'\n'.repeat(count)}Her eyes were amber.`)
	);
	expect(candidates).toHaveLength(count <= 1 ? 1 : 0);
});

it.each([
	'Nadia lifted the brass lantern. Her eyes were amber.',
	'Élodie packed the empty suitcase. Her eyes were amber.',
	'Tomas locked the iron door. His eyes were amber.',
])('retains exact subject and complete evidence for a transitive antecedent: %s', (text) => {
	const source = new FixtureSource('object-reference', root);
	const document = source.set('scene', `🌙\n${text}`);
	const candidates = extractContinuityCandidates(document);
	expect(candidates).toHaveLength(1);
	expect(candidates[0]).toMatchObject({
		subject: text.split(' ')[0],
		predicate: 'eye-color',
		value: 'amber',
		confidence: 'inferred',
	});
	expect(candidates[0].sources[0].quote).toBe(text.slice(0, -1));
	expect(verifyPassage(document, candidates[0].sources[0])).toEqual(candidates[0].sources[0]);
});

it.each([
	'Nadia helped the tired nurse. Her eyes were amber.',
	'Nadia carried the old doll. Her eyes were amber.',
	'Nadia polished the bronze statue. Her eyes were amber.',
	'Nadia lifted the brass lantern beside Elena. Her eyes were amber.',
	'Nadia lifted the brass lantern.\n\nHer eyes were amber.',
])('does not force an owner for ambiguous transitive narration: %s', (text) => {
	const source = new FixtureSource('ambiguous-object', root);
	expect(extractContinuityCandidates(source.set('scene', text))).toEqual([]);
});

it.each([255, 256, 257])(
	'bounds object-reference work even for rejected references at %i matches',
	(count) => {
		const source = new FixtureSource('object-budget', root);
		const document = source.set(
			'scene',
			'Nadia helped the tired nurse. Her eyes were amber. '.repeat(count)
		);
		if (count > 256)
			expect(() => extractContinuityCandidates(document)).toThrow(/256 object-reference/);
		else expect(extractContinuityCandidates(document)).toEqual([]);
	}
);

it.each([
	['Nadia lifted the brass lantern. Her hair was silver.', {}, 'inferred'],
	['A rumor spread. Nadia lifted the brass lantern. Her eyes were amber.', {}, 'uncertain'],
	['“A witness spoke. Nadia lifted the brass lantern. Her eyes were amber.”', {}, 'uncertain'],
	['Nadia lifted the brass lantern. Her eyes were amber.', { flashback: 'true' }, 'uncertain'],
] as const)(
	'preserves qualification and metadata in transitive evidence: %s',
	(text, metadata, confidence) => {
		const source = new FixtureSource('qualified-object', root);
		const candidates = extractContinuityCandidates(source.set('scene', text, 0, metadata));
		expect(candidates).toHaveLength(1);
		expect(candidates[0].confidence).toBe(confidence);
	}
);

it('refuses obsolete continuity findings when saved source changes during fact lookup', async () => {
	const source = new FixtureSource('project-a', root);
	source.set('first', 'Mara has blue eyes.', 0);
	source.set('second', 'Mara has green eyes.', 1);
	const database = store('source-race');
	const bible = new SeriesBible(source, database);
	const service = new ContinuityService(source, database, bible);
	const listFacts = bible.listFacts.bind(bible);
	jest.spyOn(bible, 'listFacts').mockImplementationOnce(async (...args) => {
		const facts = await listFacts(...args);
		source.set('second', 'Mara has blue eyes.', 1);
		return facts;
	});
	await expect(service.analyze()).rejects.toThrow(/changed.*continuity|continuity.*changed/i);
	expect(service.list({ includeResolved: true })).toEqual([]);
});

it.each([
	'text',
	'binder-addition',
	'binder-order',
	'metadata',
	'title',
	'project',
	'path',
] as const)(
	'refuses continuity publication after a %s change during fact lookup',
	async (change) => {
		const source = new FixtureSource('project-a', root);
		source.set('first', 'Mara has blue eyes.', 0);
		const second = source.set('second', 'Mara has green eyes.', 1);
		const database = store(`snapshot-${change}`);
		const bible = new SeriesBible(source, database);
		const service = new ContinuityService(source, database, bible);
		const listFacts = bible.listFacts.bind(bible);
		jest.spyOn(bible, 'listFacts').mockImplementationOnce(async (...args) => {
			const facts = await listFacts(...args);
			if (change === 'text') source.set('second', 'Mara has blue eyes.', 1);
			if (change === 'binder-addition') source.set('third', 'An added scene.', 2);
			if (change === 'binder-order') second.order = -1;
			if (change === 'metadata') second.metadata.flashback = 'true';
			if (change === 'title') second.title = 'Flashback';
			if (change === 'project')
				Object.defineProperty(source, 'projectId', { value: 'project-b' });
			if (change === 'path')
				Object.defineProperty(source, 'projectPath', { value: `${root}/other.scriv` });
			return facts;
		});
		await expect(service.analyze()).rejects.toThrow(/changed|currently open/);
		expect(service.list({ includeResolved: true })).toEqual([]);
	}
);

it.each(['facts', 'final-source'] as const)(
	'refuses continuity publication when canon changes at the %s await',
	async (phase) => {
		const source = new FixtureSource('project-a', root);
		source.set('first', 'Mara has blue eyes.', 0);
		const second = source.set('second', 'Mara has green eyes.', 1);
		const database = store(`canon-race-${phase}`);
		const bible = new SeriesBible(source, database);
		const service = new ContinuityService(source, database, bible);
		const changeCanon = () =>
			bible.curate({
				scope: { kind: 'project', id: source.projectId },
				kind: 'character',
				subject: 'Mara',
				predicate: 'eye-color',
				value: 'green',
				confidence: 'confirmed',
				intentional: true,
				sources: [sourcePassage(second, 0, second.text.length)],
			});
		if (phase === 'facts') {
			const listFacts = bible.listFacts.bind(bible);
			jest.spyOn(bible, 'listFacts').mockImplementationOnce(async (...args) => {
				const facts = await listFacts(...args);
				await changeCanon();
				return facts;
			});
		} else {
			const list = source.list.bind(source);
			jest.spyOn(source, 'list')
				.mockImplementationOnce(list)
				.mockImplementationOnce(async () => {
					const documents = await list();
					await changeCanon();
					return documents;
				});
		}
		await expect(service.analyze()).rejects.toThrow(/Canon facts.*changed/);
		expect(service.list({ includeResolved: true })).toEqual([]);
	}
);

it('refuses findings when source changes while final revisions are read', async () => {
	const source = new FixtureSource('project-a', root);
	source.set('first', 'Mara has blue eyes.', 0);
	source.set('second', 'Mara has green eyes.', 1);
	const database = store('final-source-race');
	const service = new ContinuityService(source, database, new SeriesBible(source, database));
	const list = source.list.bind(source);
	jest.spyOn(source, 'list')
		.mockImplementationOnce(list)
		.mockImplementationOnce(async () => {
			source.set('second', 'Mara has blue eyes.', 1);
			return list();
		});
	await expect(service.analyze()).rejects.toThrow(/changed during continuity/);
	expect(service.list({ includeResolved: true })).toEqual([]);
});

it.each(['membership', 'foreign-source'] as const)(
	'refuses series continuity findings after %s changes during canon lookup',
	async (change) => {
		const source = new FixtureSource('project-a', root);
		const foreign = new FixtureSource('project-b', root);
		source.set('first', 'Mara has blue eyes.', 0);
		const foreignDocument = foreign.set('foreign', 'Mara has green eyes.');
		const database = store(`series-race-${change}`);
		const shared = store(`shared-race-${change}`);
		const bible = new SeriesBible(source, database, shared, async () => foreign);
		const otherBible = new SeriesBible(foreign, store(`other-${change}`), shared);
		const series = bible.createSeries('Race');
		otherBible.joinSeries(series.id);
		await otherBible.curate({
			scope: { kind: 'series', id: series.id },
			kind: 'character',
			subject: 'Mara',
			predicate: 'eye-color',
			value: 'green',
			confidence: 'confirmed',
			sources: [sourcePassage(foreignDocument, 0, foreignDocument.text.length)],
		});
		const service = new ContinuityService(source, database, bible);
		const listFacts = bible.listFacts.bind(bible);
		jest.spyOn(bible, 'listFacts').mockImplementation(async (...args) => {
			const facts = await listFacts(...args);
			if (args[0].kind === 'series') {
				if (change === 'membership') otherBible.leaveSeries(series.id);
				else foreign.set('foreign', 'Mara has blue eyes.');
			}
			return facts;
		});
		await expect(service.analyze({ seriesId: series.id })).rejects.toThrow(/changed/);
		expect(service.list({ includeResolved: true })).toEqual([]);
	}
);

it('does not partially refresh findings when a later recheck await changes the manuscript', async () => {
	const source = new FixtureSource('project-a', root);
	source.set('first', 'Mara has blue eyes.', 0);
	source.set('second', 'Mara has green eyes.', 1);
	const database = store('recheck-race');
	const bible = new SeriesBible(source, database);
	const service = new ContinuityService(source, database, bible);
	const series = bible.createSeries('Recheck');
	await service.analyze();
	await service.analyze({ seriesId: series.id });
	const before = service.list({ includeResolved: true });
	const checkPassages = bible.checkPassages.bind(bible);
	jest.spyOn(bible, 'checkPassages').mockImplementationOnce(async (...args) => {
		const states = await checkPassages(...args);
		source.set('second', 'Mara has blue eyes.', 1);
		return states;
	});
	await expect(service.recheck()).rejects.toThrow(/changed during continuity/);
	expect(service.list({ includeResolved: true })).toEqual(before);
});

it.each(['fact-lookup', 'final-source'] as const)(
	'publishes no findings when cancellation arrives during %s',
	async (phase) => {
		const source = new FixtureSource('project-a', root);
		source.set('first', 'Mara has blue eyes.', 0);
		source.set('second', 'Mara has green eyes.', 1);
		const database = store(`cancel-${phase}`);
		const bible = new SeriesBible(source, database);
		const service = new ContinuityService(source, database, bible);
		const controller = new AbortController();
		if (phase === 'fact-lookup') {
			const listFacts = bible.listFacts.bind(bible);
			jest.spyOn(bible, 'listFacts').mockImplementationOnce(async (...args) => {
				const facts = await listFacts(...args);
				controller.abort(new Error('Cancelled continuity'));
				return facts;
			});
		} else {
			const list = source.list.bind(source);
			jest.spyOn(source, 'list')
				.mockImplementationOnce(list)
				.mockImplementationOnce(async () => {
					const documents = await list();
					controller.abort(new Error('Cancelled continuity'));
					return documents;
				});
		}
		await expect(service.analyze({ signal: controller.signal })).rejects.toThrow(
			'Cancelled continuity'
		);
		expect(service.list({ includeResolved: true })).toEqual([]);
	}
);

it('rejects an explicitly unavailable plot-thread check before reading or changing findings', async () => {
	const source = new FixtureSource('project-a', root);
	const database = store('plot-availability');
	const service = new ContinuityService(source, database, new SeriesBible(source, database));
	await expect(service.analyze({ checkTypes: ['plotThreads'] })).rejects.toThrow(/unavailable/);
	expect(source.lists).toBe(0);
	expect(service.list({ includeResolved: true })).toEqual([]);
	expect((await service.analyze()).coverage).toContain('Plot-thread analysis is unavailable');
});

it.each(['analyze', 'recheck', 'confirm'] as const)(
	'preserves findings when the public %s handler is cancelled during source review',
	async (action) => {
		const source = new FixtureSource('project-a', root);
		source.set('first', 'Mara has blue eyes.', 0);
		source.set('second', 'Mara has green eyes.', 1);
		const database = store(`handler-cancel-${action}`);
		const bible = new SeriesBible(source, database);
		const continuity = new ContinuityService(source, database, bible);
		const finding = (await continuity.analyze()).issues[0];
		const before = continuity.list({ includeResolved: true });
		const controller = new AbortController();
		const listFacts = bible.listFacts.bind(bible);
		jest.spyOn(bible, 'listFacts').mockImplementationOnce(async (...args) => {
			const facts = await listFacts(...args);
			controller.abort(new Error('Cancelled public continuity'));
			return facts;
		});
		const context = {
			project: { getEditorialServices: () => ({ continuity }) },
		} as unknown as HandlerContext;
		const pending =
			action === 'analyze'
				? checkConsistencyHandler.handler({}, context, { signal: controller.signal })
				: continuityFindingsHandler.handler({ action, findingId: finding.id }, context, {
						signal: controller.signal,
					});
		await expect(pending).rejects.toThrow('Cancelled public continuity');
		expect(continuity.list({ includeResolved: true })).toEqual(before);
	}
);
