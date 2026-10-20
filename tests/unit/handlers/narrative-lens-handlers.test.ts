/**
 * Verifies the local (narrative-lens backed) analysis handlers against a fake
 * project: the craft analyzer returns every section it promises and rejects a
 * missing document, and voice drift clamps splitFraction and reports the
 * insufficient-dialogue case instead of calling the drift model.
 */

import {
	analyzeCraftLocalHandler,
	analyzeForeshadowingLocalHandler,
	analyzeOpeningLocalHandler,
	checkContinuityLocalHandler,
	measureVoiceDriftLocalHandler,
} from '../../../src/handlers/narrative-lens-handlers.js';
import type { HandlerContext } from '../../../src/handlers/types.js';

const scene =
	'"We leave at dawn," Mara said. She did not look at him.\n' +
	'"And if the bridge is gone?" Tomas asked.\n' +
	'"Then we swim." Mara shouldered the pack. The river was loud below them.\n' +
	'It had rained for three days and the water was brown and fast.';

const laterScene =
	'"I told you the bridge would hold," Mara said, laughing.\n' +
	'"You told me we would swim," Tomas said.\n' +
	'"Same thing." She was already walking.';

const docs = [
	{ id: 'd1', title: 'One', content: scene },
	{ id: 'd2', title: 'Two', content: laterScene },
];

const context = {
	project: {
		getDocument: async (id: string) => docs.find((d) => d.id === id) ?? null,
		getManuscriptDocuments: async () => docs,
	},
} as unknown as HandlerContext;

describe('analyze_craft_local', () => {
	it('returns every promised section for a real document', async () => {
		const res = await analyzeCraftLocalHandler.handler({ documentId: 'd1' }, context);
		const out = res.structuredContent as Record<string, unknown>;
		expect(Object.keys(out).sort()).toEqual(
			['dialogue', 'grammar', 'readability', 'syntaxTension', 'topWords'].sort()
		);
		expect((out.readability as { wordCount: number }).wordCount).toBeGreaterThan(0);
		expect(res.content[0]).toMatchObject({ type: 'text' });
	});

	it('rejects a document id that does not exist', async () => {
		await expect(
			analyzeCraftLocalHandler.handler({ documentId: 'missing' }, context)
		).rejects.toThrow(/not found/i);
	});
});

describe('measure_voice_drift_local', () => {
	it('reports insufficient dialogue when splitFraction leaves one half empty', async () => {
		// 5.0 clamps to 1, so every document lands in the baseline half.
		const res = await measureVoiceDriftLocalHandler.handler(
			{ characterName: 'Mara', splitFraction: 5 },
			context
		);
		expect(res.structuredContent).toMatchObject({ currentLineCount: 0 });
		expect(res.structuredContent).not.toHaveProperty('drift');
	});

	it('measures drift when both halves have attributed lines', async () => {
		const res = await measureVoiceDriftLocalHandler.handler(
			{ characterName: 'Mara', splitFraction: 0.5 },
			context
		);
		const out = res.structuredContent as { baselineLineCount: number; currentLineCount: number };
		expect(out.baselineLineCount).toBeGreaterThan(0);
		expect(out.currentLineCount).toBeGreaterThan(0);
		expect(res.structuredContent).toHaveProperty('drift.overall');
	});
});

describe('analyze_opening_local', () => {
	it('falls back to the first manuscript document when no id is given', async () => {
		const res = await analyzeOpeningLocalHandler.handler({ genre: 'thriller' }, context);
		expect(res.structuredContent).toMatchObject({ documentId: 'd1' });
	});
});

const ordered = [
	{
		id: 'ch1',
		title: 'The Door',
		content:
			'A rusted key hung beside the door. Mara stared at the rusted key and said nothing ' +
			'about the rusted key. On Monday morning she was in Paris.',
	},
	{
		id: 'ch2',
		title: 'The Market',
		content:
			'They walked to the market and bought bread. The weather was mild and the road was long.',
	},
	{
		id: 'ch3',
		title: 'The Cellar',
		content:
			'Mara found the lock in the cellar. The rusted key turned, and the rusted key opened ' +
			'the cellar door. Three days later she was in Rome.',
	},
];

const orderedContext = {
	project: {
		getManuscriptDocuments: async () => ordered,
	},
	memoryManager: { getAllCharacters: () => [{ name: 'Mara' }] },
} as unknown as HandlerContext;

describe('check_continuity_local', () => {
	it('projects a timeline entry per document in binder order and a world-state trace', async () => {
		const res = await checkContinuityLocalHandler.handler({}, orderedContext);
		const out = res.structuredContent as {
			timeline: { documentId: string; order: number }[];
			worldState: { continuityScore: number; violations: unknown[]; snapshots: unknown[] };
			documentCount: number;
		};
		expect(out.documentCount).toBe(3);
		expect(out.timeline.map((t) => t.documentId)).toEqual(['ch1', 'ch2', 'ch3']);
		expect(out.timeline.map((t) => t.order)).toEqual([...out.timeline.map((t) => t.order)].sort());
		expect(out.worldState.snapshots).toHaveLength(3);
		expect(Array.isArray(out.worldState.violations)).toBe(true);
		expect(res.content[0]).toMatchObject({ type: 'text' });
	});

	it('requires memory so character names can be resolved', async () => {
		const noMemory = { project: orderedContext.project } as unknown as HandlerContext;
		await expect(checkContinuityLocalHandler.handler({}, noMemory)).rejects.toThrow();
	});
});

describe('analyze_foreshadowing_local', () => {
	it('maps setup and payoff scene indices to document ids and titles', async () => {
		const res = await analyzeForeshadowingLocalHandler.handler({}, orderedContext);
		const out = res.structuredContent as {
			items: {
				setupTerm: string;
				setupScene: number;
				payoffScene: number | null;
				setupDocumentId: string | null;
				setupDocumentTitle: string | null;
				payoffDocumentId: string | null;
				payoffDocumentTitle: string | null;
			}[];
			documentCount: number;
		};
		expect(out.documentCount).toBe(3);
		const key = out.items.find((i) => i.setupTerm === 'rusted' || i.setupTerm === 'key');
		expect(key).toBeDefined();
		expect(key!.setupScene).toBe(0);
		expect(key!.setupDocumentId).toBe('ch1');
		expect(key!.setupDocumentTitle).toBe('The Door');
		expect(key!.payoffScene).toBe(2);
		expect(key!.payoffDocumentId).toBe('ch3');
		expect(key!.payoffDocumentTitle).toBe('The Cellar');
	});
});
