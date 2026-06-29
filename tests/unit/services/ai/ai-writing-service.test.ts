/**
 * AIWritingService tests. The chat-backed parsing paths (style analysis,
 * consistency-issue coercion, context-free generation) are covered
 * deterministically with a stubbed AIClient -- that is the bug-prone code. The
 * HMS-backed vector-store path is exercised by the app and the key-gated live
 * tests, not mocked here.
 */

import { AIWritingService } from '../../../../src/services/ai/ai-writing-service.js';
import { AIClient } from '../../../../src/services/ai/ai-client.js';

function stub(reply: string | (() => string)) {
	let lastPrompt = '';
	const ai = {
		provider: 'anthropic',
		isAvailable: true,
		chat: async (prompt: string) => {
			lastPrompt = prompt;
			return typeof reply === 'function' ? reply() : reply;
		},
	} as unknown as AIClient;
	return { svc: new AIWritingService(ai), lastPrompt: () => lastPrompt };
}

describe('AIWritingService — deterministic (stubbed client)', () => {
	it('reports availability from the underlying client', () => {
		const off = new AIWritingService(new AIClient({ anthropicApiKey: '', openaiApiKey: '' }));
		expect(off.isAvailable).toBe(false);
		const { svc } = stub('{}');
		expect(svc.isAvailable).toBe(true);
	});

	describe('analyzeWritingStyle', () => {
		it('parses a JSON object reply', async () => {
			const { svc } = stub('```json\n{"voice":"first-person","tone":"wry"}\n```');
			const out = await svc.analyzeWritingStyle(['some prose']);
			expect(out).toEqual({ voice: 'first-person', tone: 'wry' });
		});

		it('falls back to a minimal object when the reply is not JSON', async () => {
			const { svc } = stub('I cannot analyze this.');
			const out = await svc.analyzeWritingStyle(['x']);
			expect(out).toMatchObject({ tone: 'neutral', complexity: 'medium' });
		});
	});

	describe('checkPlotConsistency', () => {
		const docs = [{ id: 'd1', title: 'Ch1', type: 'Text' as const, path: '', content: 'text' }];

		it('parses issues, coercing bad severity and dropping invalid entries', async () => {
			const { svc } = stub(
				'[{"issue":"Age conflict","severity":"critical","locations":["Ch 1"],"suggestion":"fix"},' +
					'{"issue":"Name typo","severity":"low"},' +
					'{"severity":"high","suggestion":"no issue text"}]'
			);
			const out = await svc.checkPlotConsistency(docs);
			expect(out).toHaveLength(2);
			expect(out[0]).toEqual({
				issue: 'Age conflict',
				severity: 'medium', // "critical" is not a valid level -> default
				locations: ['Ch 1'],
				suggestion: 'fix',
			});
			expect(out[1]).toMatchObject({ issue: 'Name typo', severity: 'low', locations: [] });
		});

		it('returns [] for a non-array reply', async () => {
			const { svc } = stub('No inconsistencies found.');
			expect(await svc.checkPlotConsistency(docs)).toEqual([]);
		});
	});

	describe('generateWithContext', () => {
		it('returns the model text and skips context when topK is 0', async () => {
			const { svc, lastPrompt } = stub('SUGGESTION');
			const out = await svc.generateWithContext('Improve this line', { topK: 0 });
			expect(out).toBe('SUGGESTION');
			// No vector store was built, so the prompt is the bare request.
			expect(lastPrompt()).toBe('Improve this line');
		});

		it('degrades to context-free chat when no vector store exists', async () => {
			const { svc } = stub('OK');
			expect(await svc.generateWithContext('write something')).toBe('OK');
		});
	});

	it('clearMemory does not throw before any build', () => {
		const { svc } = stub('{}');
		expect(() => svc.clearMemory()).not.toThrow();
	});
});

const liveAnthropic = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;
liveAnthropic('AIWritingService — live Claude', () => {
	it('analyzes writing style into a structured object', async () => {
		const svc = new AIWritingService();
		const out = await svc.analyzeWritingStyle([
			'The rain fell. It always fell here, gray and relentless, soaking the cobblestones.',
		]);
		expect(out).toBeInstanceOf(Object);
		expect(Object.keys(out).length).toBeGreaterThan(0);
	}, 30000);

	it('returns a well-formed consistency-issue array', async () => {
		const svc = new AIWritingService();
		const issues = await svc.checkPlotConsistency([
			{
				id: 'a',
				title: 'One',
				type: 'Text',
				path: '',
				content: 'Sara was 30 and had brown eyes.',
			},
			{
				id: 'b',
				title: 'Two',
				type: 'Text',
				path: '',
				content: 'Sara, 25, gazed with her blue eyes.',
			},
		]);
		expect(Array.isArray(issues)).toBe(true);
		for (const i of issues) {
			expect(['low', 'medium', 'high']).toContain(i.severity);
			expect(typeof i.issue).toBe('string');
		}
	}, 30000);
});
