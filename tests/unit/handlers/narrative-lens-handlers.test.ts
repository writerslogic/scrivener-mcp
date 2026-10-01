/**
 * Verifies the local (narrative-lens backed) analysis handlers against a fake
 * project: the craft analyzer returns every section it promises and rejects a
 * missing document, and voice drift clamps splitFraction and reports the
 * insufficient-dialogue case instead of calling the drift model.
 */

import {
	analyzeCraftLocalHandler,
	analyzeOpeningLocalHandler,
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
