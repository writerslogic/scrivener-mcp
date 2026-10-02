/**
 * Verifies the bluepencil-backed line-editing handlers against a fake project:
 * each tool returns every section its outputSchema promises, findings carry
 * document locations, caps and option pass-through work, a missing document is
 * rejected, and the manuscript report weights totals by words and only calls
 * out outliers when there are enough documents to have a distribution.
 */

import {
	analyzeDialogueTagsLocalHandler,
	analyzeRhythmLocalHandler,
	checkStyleLocalHandler,
	findRepetitionLocalHandler,
	manuscriptStyleReportLocalHandler,
} from '../../../src/handlers/bluepencil-handlers.js';
import type { HandlerContext } from '../../../src/handlers/types.js';

const scene =
	'"We leave at dawn," Mara said softly. She really felt that the bridge was gone.\n' +
	'"And if the bridge is gone?" Tomas exclaimed.\n' +
	'"Then we swim." Mara shouldered the pack. The river was loud below them. ' +
	'It had rained for three days and the water was brown and fast. The water was very cold.\n' +
	'The decision was made by the council at the end of the day. ' +
	'The river was crossed. The river was wide. The river was deep.';

const quiet =
	'Light came slowly over the ridge. Nobody spoke. The horses stood with their heads down ' +
	'and the fog moved between them like something alive. Tomas counted the riders twice.';

const docs = [
	{ id: 'd1', title: 'One', content: scene },
	{ id: 'd2', title: 'Two', content: quiet },
	{ id: 'd3', title: 'Three', content: `${quiet} ${quiet}` },
	{ id: 'd4', title: 'Four', content: `${quiet} Nobody spoke again until noon.` },
	{ id: 'empty', title: 'Empty', content: '' },
];

const context = {
	project: {
		getDocument: async (id: string) => docs.find((d) => d.id === id) ?? null,
		getManuscriptDocuments: async () => docs,
	},
} as unknown as HandlerContext;

const required = (handler: { outputSchema?: { required?: string[] } }): string[] =>
	[...(handler.outputSchema?.required ?? [])].sort();

describe('check_style_local', () => {
	it('returns every promised section with located findings and rates', async () => {
		const res = await checkStyleLocalHandler.handler({ documentId: 'd1' }, context);
		const out = res.structuredContent as {
			words: number;
			counts: Record<string, number>;
			perThousand: Record<string, number>;
			findings: Array<{ rule: string; location: { line: number; column: number } }>;
			totalFindings: number;
		};
		expect(Object.keys(out).sort()).toEqual(required(checkStyleLocalHandler));
		expect(out.counts.adverbs).toBeGreaterThanOrEqual(1);
		expect(out.counts.passive).toBeGreaterThanOrEqual(1);
		expect(out.counts.hedges).toBeGreaterThanOrEqual(1);
		expect(out.perThousand.adverbs).toBeCloseTo((out.counts.adverbs * 1000) / out.words);
		expect(out.findings.length).toBe(out.totalFindings);
		for (const f of out.findings) {
			expect(f.location.line).toBeGreaterThanOrEqual(1);
			expect(f.location.column).toBeGreaterThanOrEqual(1);
		}
		expect(res.content[0]).toMatchObject({ type: 'text' });
	});

	it('caps findings but reports the uncapped total, and flags custom tics', async () => {
		const res = await checkStyleLocalHandler.handler(
			{ documentId: 'd1', maxFindings: 2, tics: ['river'] },
			context
		);
		const out = res.structuredContent as {
			counts: { tics: number };
			findings: unknown[];
			totalFindings: number;
		};
		expect(out.findings).toHaveLength(2);
		expect(out.totalFindings).toBeGreaterThan(2);
		expect(out.counts.tics).toBeGreaterThanOrEqual(4);
	});

	it('rejects a document id that does not exist', async () => {
		await expect(
			checkStyleLocalHandler.handler({ documentId: 'missing' }, context)
		).rejects.toThrow(/not found/i);
	});

	it('is safe on an empty document', async () => {
		const res = await checkStyleLocalHandler.handler({ documentId: 'empty' }, context);
		const out = res.structuredContent as { words: number; findings: unknown[] };
		expect(out.words).toBe(0);
		expect(out.findings).toEqual([]);
	});
});

describe('find_repetition_local', () => {
	it('finds echoes and repeated phrases with both locations', async () => {
		const res = await findRepetitionLocalHandler.handler(
			{ documentId: 'd1', window: 30, minLength: 5, minPhraseWords: 3, maxPhraseWords: 3 },
			context
		);
		const out = res.structuredContent as {
			echoes: Array<{ word: string; first: { offset: number }; second: { offset: number } }>;
			repeats: Array<{ phrase: string; count: number; locations: unknown[] }>;
		};
		expect(Object.keys(out).sort()).toEqual(required(findRepetitionLocalHandler));
		expect(out.echoes.length).toBeGreaterThan(0);
		for (const e of out.echoes) {
			expect(e.second.offset).toBeGreaterThan(e.first.offset);
		}
		const river = out.repeats.find((r) => r.phrase === 'the river was');
		expect(river).toBeDefined();
		expect(river?.locations).toHaveLength(river?.count ?? -1);
	});
});

describe('analyze_rhythm_local', () => {
	it('summarises sentence lengths and merges rhythm and opener findings in order', async () => {
		const res = await analyzeRhythmLocalHandler.handler(
			{ documentId: 'd1', long: 10, starterRun: 3 },
			context
		);
		const out = res.structuredContent as {
			summary: { count: number; min: number; max: number };
			variation: number;
			lengths: number[];
			findings: Array<{ rule: string; location: { offset: number } }>;
			starters: { sentence: Array<{ word: string }>; paragraph: unknown[] };
		};
		expect(Object.keys(out).sort()).toEqual(required(analyzeRhythmLocalHandler));
		expect(out.lengths).toHaveLength(out.summary.count);
		expect(out.summary.max).toBeGreaterThanOrEqual(out.summary.min);
		expect(out.findings.some((f) => f.rule === 'long-sentence')).toBe(true);
		expect(out.findings.some((f) => f.rule === 'repeated-starter')).toBe(true);
		const offsets = out.findings.map((f) => f.location.offset);
		expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
		expect(out.starters.sentence.some((w) => w.word === 'the')).toBe(true);
	});
});

describe('analyze_dialogue_tags_local', () => {
	it('classifies tags and keeps the tag counts consistent with the attributions', async () => {
		const res = await analyzeDialogueTagsLocalHandler.handler({ documentId: 'd1' }, context);
		const out = res.structuredContent as {
			ratio: { ratio: number; dialogueWords: number };
			plainTags: number;
			showyTags: number;
			adverbTags: number;
			untagged: number;
			attributions: Array<{ kind: string | null; adverb: boolean }>;
			totalAttributions: number;
		};
		expect(Object.keys(out).sort()).toEqual(required(analyzeDialogueTagsLocalHandler));
		expect(out.ratio.ratio).toBeGreaterThan(0);
		expect(out.ratio.ratio).toBeLessThan(1);
		expect(out.plainTags).toBeGreaterThanOrEqual(1);
		expect(out.showyTags).toBeGreaterThanOrEqual(1);
		expect(out.adverbTags).toBeGreaterThanOrEqual(1);
		expect(out.plainTags + out.showyTags + out.untagged).toBe(out.totalAttributions);
		expect(out.attributions).toHaveLength(out.totalAttributions);
	});

	it('caps attributions while reporting the total', async () => {
		const res = await analyzeDialogueTagsLocalHandler.handler(
			{ documentId: 'd1', maxAttributions: 1 },
			context
		);
		const out = res.structuredContent as { attributions: unknown[]; totalAttributions: number };
		expect(out.attributions).toHaveLength(1);
		expect(out.totalAttributions).toBeGreaterThan(1);
	});
});

describe('manuscript_style_report_local', () => {
	it('tabulates every document, weights totals by words, and finds the outlier', async () => {
		const res = await manuscriptStyleReportLocalHandler.handler({}, context);
		const out = res.structuredContent as {
			documents: Array<{ documentId: string; words: number; adverbsPer1k: number }>;
			totals: Record<string, number>;
			outliers: Array<{ documentId: string; metric: string }>;
			documentCount: number;
		};
		expect(Object.keys(out).sort()).toEqual(required(manuscriptStyleReportLocalHandler));
		expect(out.documentCount).toBe(docs.length);
		expect(out.documents.map((d) => d.documentId)).toEqual(docs.map((d) => d.id));
		const words = out.documents.reduce((n, d) => n + d.words, 0);
		expect(out.totals.words).toBe(words);
		const weighted =
			out.documents.reduce((n, d) => n + d.adverbsPer1k * d.words, 0) / words;
		expect(out.totals.adverbsPer1k).toBeCloseTo(weighted);
		// d1 is dialogue-heavy and passive-heavy; the three quiet documents are the baseline.
		expect(out.outliers.some((o) => o.documentId === 'd1')).toBe(true);
		expect(out.outliers.every((o) => o.documentId !== 'empty')).toBe(true);
	});

	it('reports no outliers when fewer than four documents have text', async () => {
		const small = {
			project: {
				getManuscriptDocuments: async () => docs.slice(0, 3),
			},
		} as unknown as HandlerContext;
		const res = await manuscriptStyleReportLocalHandler.handler({}, small);
		const out = res.structuredContent as { outliers: unknown[]; documentCount: number };
		expect(out.documentCount).toBe(3);
		expect(out.outliers).toEqual([]);
	});

	it('handles an empty manuscript', async () => {
		const none = {
			project: { getManuscriptDocuments: async () => [] },
		} as unknown as HandlerContext;
		const res = await manuscriptStyleReportLocalHandler.handler({}, none);
		const out = res.structuredContent as { totals: { words: number }; documentCount: number };
		expect(out.documentCount).toBe(0);
		expect(out.totals.words).toBe(0);
		expect(res.content[0]).toMatchObject({ type: 'text' });
	});
});
