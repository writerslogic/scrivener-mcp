/**
 * AIWritingService tests. The chat-backed parsing paths (style analysis,
 * context-free generation) are covered
 * deterministically with a stubbed AIClient -- that is the bug-prone code. The
 * HMS-backed vector-store path is exercised by the app and the explicitly opted-in live
 * tests, not mocked here.
 */

import { describeLiveAnthropic as liveAnthropic } from '../../../helpers/live-provider.js';
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
		const off = new AIWritingService(
			new AIClient({ anthropicApiKey: '', openaiApiKey: '', openrouterApiKey: '' })
		);
		expect(off.isAvailable).toBe(false);
		const { svc } = stub('{}');
		expect(svc.isAvailable).toBe(true);
	});

	describe('analyzeWritingStyle', () => {
		it('parses a JSON object reply', async () => {
			const { svc } = stub('```json\n{"voice":"first-person","tone":"wry"}\n```');
			const out = await svc.analyzeWritingStyle(['some prose']);
			expect(out.analysis).toMatchObject({
				voice: 'first-person',
				tone: 'wry',
				sentenceStructure: null,
			});
			expect(out.availability.status).toBe('partial');
		});

		it('reports unavailable analysis when the provider reply is not a JSON object', async () => {
			const { svc } = stub('I cannot analyze this.');
			await expect(svc.analyzeWritingStyle(['x'])).rejects.toThrow(/unavailable/);
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

	it('serializes build, clearing and rebuilding without retaining stale passages', async () => {
		const { svc } = stub('{}');
		const first = {
			id: 'scene',
			title: 'Scene',
			type: 'Text' as const,
			path: '',
			content: 'harbor lighthouse',
		};
		try {
			await Promise.all([
				svc.buildVectorStore([first]),
				svc.clearMemory(),
				svc.buildVectorStore([{ ...first, content: 'orchard violet' }]),
			]);
			expect(await svc.semanticSearch('harbor')).toEqual([]);
			expect((await svc.semanticSearch('orchard'))[0].metadata.id).toBe('scene');
		} finally {
			await svc.close();
		}
	});
});

liveAnthropic('AIWritingService — live Claude', () => {
	it('analyzes writing style into a structured object', async () => {
		const svc = new AIWritingService();
		const out = await svc.analyzeWritingStyle([
			'The rain fell. It always fell here, gray and relentless, soaking the cobblestones.',
		]);
		expect(out).toBeInstanceOf(Object);
		expect(Object.keys(out).length).toBeGreaterThan(0);
	}, 30000);
});
