import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	ChangeImpactService,
	evaluateChangeImpact,
	type ImpactRequest,
	type StoryDependency,
} from '../../../src/services/editorial/change-impact.js';
import { sourcePassage } from '../../../src/services/editorial/provenance.js';
import { PersistentStore } from '../../../src/services/editorial/persistent-store.js';
import { SeriesBible } from '../../../src/services/editorial/series-bible.js';
import { ContinuityService } from '../../../src/services/editorial/continuity-service.js';
import type { ReviewService } from '../../../src/services/editorial/review-service.js';
import type {
	ManuscriptSource,
	SourceDocument,
	StoryFact,
} from '../../../src/services/editorial/types.js';
const projectId = '11111111-1111-4111-8111-111111111111';
const document = (text: string, order: number): SourceDocument => ({
	projectId,
	documentId: `00000000-0000-4000-8000-${String(order + 1).padStart(12, '0')}`,
	text,
	order,
	revision: createHash('sha256').update(text).digest('hex'),
	title: `Scene ${order}`,
	path: `Draft/${order}`,
	metadata: {},
});
let docs: SourceDocument[];
let request: ImpactRequest;
let dependency: StoryDependency;
let fact: StoryFact;
beforeEach(() => {
	docs = [
		document('Mara found the key.', 0),
		document('Mara unlocked the tower.', 1),
		document('Marathon runners left.', 2),
	];
	request = {
		documentId: docs[0].documentId,
		expectedRevision: docs[0].revision,
		kind: 'remove',
	};
	dependency = {
		id: 'd'.repeat(64),
		kind: 'causal',
		explanation: 'The key must be found before the tower opens',
		prerequisite: sourcePassage(docs[0], 0, docs[0].text.length),
		dependent: sourcePassage(docs[1], 0, docs[1].text.length),
	};
	fact = {
		id: 'f'.repeat(64),
		kind: 'character',
		subject: 'Mara',
		predicate: 'possession',
		value: 'key',
		confidence: 'confirmed',
		scope: { kind: 'project', id: projectId },
		sources: [dependency.prerequisite],
		updatedAt: '2026-11-10T00:00:00Z',
	};
});
test('removal reports cited facts, explicit dependencies and bounded literal references without mutating sources', () => {
	const before = JSON.stringify(docs);
	const report = evaluateChangeImpact(docs, [fact], [], [dependency], request);
	expect(report.impacts.map((item) => item.kind)).toEqual([
		'story-fact',
		'dependency',
		'mention',
	]);
	expect(report.impacts[2]).toMatchObject({
		certainty: 'candidate',
		evidence: [{ documentId: docs[1].documentId, quote: 'Mara' }],
	});
	expect(report.impacts.every((item) => !item.stale)).toBe(true);
	expect(JSON.stringify(docs)).toBe(before);
	expect(report.coverage).toContain('not proof');
});
test('move detects prerequisite inversion and restoration, not an inferred timeline contradiction', () => {
	const report = evaluateChangeImpact(docs, [], [], [dependency], {
		...request,
		kind: 'move',
		beforeDocumentId: null,
	});
	expect(report.impacts).toHaveLength(1);
	expect(report.impacts[0].description).toContain('Reverses');
	const reordered = [{ ...docs[0], order: 1 }, { ...docs[1], order: 0 }, docs[2]];
	const restored = evaluateChangeImpact(reordered, [], [], [dependency], {
		...request,
		kind: 'move',
		beforeDocumentId: docs[1].documentId,
	});
	expect(restored.impacts[0].description).toContain('Restores');
	expect(
		evaluateChangeImpact(docs, [], [], [dependency], {
			...request,
			kind: 'move',
			beforeDocumentId: docs[1].documentId,
		}).total
	).toBe(0);
});
test('unchanged replacement has no impact; stale evidence is disclosed even for moves', () => {
	expect(
		evaluateChangeImpact(docs, [fact], [], [dependency], {
			...request,
			kind: 'replace',
			replacementText: docs[0].text,
		}).total
	).toBe(0);
	dependency.dependent.revision = 'b'.repeat(64);
	const report = evaluateChangeImpact(docs, [], [], [dependency], {
		...request,
		kind: 'move',
		beforeDocumentId: null,
	});
	expect(report.impacts[0]).toMatchObject({ kind: 'dependency', stale: true });
});
test.each([1, 2, 3])('impact limit %d reports exact omitted count', (limit) => {
	const report = evaluateChangeImpact(docs, [fact], [], [dependency], { ...request, limit });
	expect(report.total).toBe(3);
	expect(report.impacts).toHaveLength(limit);
	expect(report.truncated).toBe(limit < 3);
});
test.each([0, 501])('invalid limit %d fails', (limit) =>
	expect(() => evaluateChangeImpact(docs, [], [], [], { ...request, limit })).toThrow()
);
test('rejects stale source, invalid destinations and ambiguous replacement requests', () => {
	for (const change of [
		{ expectedRevision: 'b'.repeat(64) },
		{ kind: 'move', beforeDocumentId: docs[0].documentId },
		{ kind: 'move' },
		{ kind: 'replace' },
		{ kind: 'replace', replacementText: '', proposalId: docs[0].documentId },
	]) {
		expect(() =>
			evaluateChangeImpact(docs, [], [], [], { ...request, ...change } as ImpactRequest)
		).toThrow();
	}
});
test('literal Unicode terms escape regex metacharacters and enforce name boundaries', () => {
	docs[1] = document('Élodie (a+b) arrived; Élodienne did not.', 1);
	const report = evaluateChangeImpact(docs, [], [], [], {
		...request,
		terms: ['Élodie', '(a+b)', 'ÉlodienneX'],
	});
	expect(report.impacts.map((item) => item.evidence[0].quote)).toEqual(['Élodie', '(a+b)']);
});
test('persisted dependencies verify evidence, paginate, survive reopening and reject changed analysis snapshots', async () => {
	const root = await mkdtemp(join(tmpdir(), 'impact-'));
	let store = new PersistentStore(join(root, 'editorial.sqlite'));
	const source: ManuscriptSource = {
		projectId,
		projectPath: root,
		list: async () => docs.map((doc) => ({ ...doc })),
		read: async (id) => docs.find((doc) => doc.documentId === id)!,
	};
	const services = () => {
		const bible = new SeriesBible(source, store);
		return new ChangeImpactService(
			source,
			store,
			bible,
			new ContinuityService(source, store, bible),
			{} as ReviewService
		);
	};
	try {
		let service = services();
		const { id: _id, ...input } = dependency;
		const recorded = await service.link(input);
		expect(await service.link(input)).toEqual(recorded);
		await expect(service.link({ ...input, explanation: 'different' })).rejects.toThrow(
			'already exists'
		);
		await expect(
			service.link({ ...input, prerequisite: { ...input.prerequisite, quote: 'forged' } })
		).rejects.toThrow();
		store.close();
		store = new PersistentStore(join(root, 'editorial.sqlite'));
		service = services();
		expect(service.dependencyPage().items).toEqual([recorded]);
		expect((await service.analyze(request)).impacts[0].kind).toBe('dependency');
		let reads = 0;
		source.list = async () =>
			docs.map((doc) => ({ ...doc, revision: ++reads > 3 ? 'c'.repeat(64) : doc.revision }));
		await expect(service.analyze(request)).rejects.toThrow('changed during');
		service.unlink(recorded.id);
		service.unlink(recorded.id);
		expect(service.dependencyPage().items).toEqual([]);
	} finally {
		store.close();
		await rm(root, { recursive: true, force: true });
	}
});

test.each([499, 500, 501])('validates the result-count ceiling at %d', (limit) => {
	const many = Array.from({ length: 502 }, (_, index) => document('Mara waited.', index));
	const input = { ...request, expectedRevision: many[0].revision, terms: ['Mara'], limit };
	if (limit > 500) expect(() => evaluateChangeImpact(many, [], [], [], input)).toThrow();
	else {
		const report = evaluateChangeImpact(many, [], [], [], input);
		expect(report.total).toBe(501);
		expect(report.impacts).toHaveLength(limit);
		expect(report.truncated).toBe(true);
	}
});

test.each([999, 1000, 1001])('validates manuscript scene budget at %d', (length) => {
	const many = Array.from({ length }, (_, index) => document('Scene.', index));
	const input = { ...request, expectedRevision: many[0].revision };
	if (length > 1000)
		expect(() => evaluateChangeImpact(many, [], [], [], input)).toThrow('budget');
	else expect(evaluateChangeImpact(many, [], [], [], input).analyzedDocuments).toBe(length);
});

test('caps quoted evidence independently of result count and discloses truncation', () => {
	const evidence = { ...dependency.prerequisite, quote: 'x'.repeat(10000) };
	const facts = Array.from({ length: 101 }, (_, index) => ({
		...fact,
		id: String(index),
		sources: [evidence],
	}));
	const report = evaluateChangeImpact(docs, facts, [], [], { ...request, limit: 500 });
	expect(report.impacts.filter((item) => item.kind === 'story-fact')).toHaveLength(100);
	expect(report.total).toBe(102);
	expect(report.truncated).toBe(true);
	expect(report.impacts.every((item) => item.stale)).toBe(true);
});

test('proposal impact resolves guarded selected-edit previews and refuses another scene or revision', async () => {
	const root = await mkdtemp(join(tmpdir(), 'impact-proposal-'));
	const store = new PersistentStore(join(root, 'editorial.sqlite'));
	const source: ManuscriptSource = {
		projectId,
		projectPath: root,
		list: async () => docs,
		read: async (id) => docs.find((doc) => doc.documentId === id)!,
	};
	const bible = new SeriesBible(source, store);
	const preview = jest.fn(async () => ({
		documentId: docs[0].documentId,
		revision: docs[0].revision,
		after: 'A revised scene.',
	}));
	const service = new ChangeImpactService(
		source,
		store,
		bible,
		new ContinuityService(source, store, bible),
		{ preview } as unknown as ReviewService
	);
	const input = {
		...request,
		kind: 'replace' as const,
		proposalId: docs[2].documentId,
		editIds: [docs[1].documentId],
	};
	try {
		expect((await service.analyze(input)).kind).toBe('replace');
		expect(preview).toHaveBeenCalledWith(input.proposalId, input.editIds);
		preview.mockResolvedValueOnce({
			documentId: docs[1].documentId,
			revision: docs[0].revision,
			after: 'wrong',
		});
		await expect(service.analyze(input)).rejects.toThrow('does not match');
		preview.mockResolvedValueOnce({
			documentId: docs[0].documentId,
			revision: 'c'.repeat(64),
			after: 'wrong',
		});
		await expect(service.analyze(input)).rejects.toThrow('does not match');
	} finally {
		store.close();
		await rm(root, { recursive: true, force: true });
	}
});
