/**
 * AICompilationService tests. A fake AISemanticExtractor returns deterministic
 * content keyed by task type, so the compile/optimize/enhance/quality wiring is
 * verified without a key or network. The base text compilation runs for real.
 */

import { AICompilationService } from '../../../../src/services/compilation/ai-compiler.js';
import { AISemanticExtractor } from '../../../../src/services/ai/ai-semantic-extractor.js';

function fakeExtractor(): AISemanticExtractor {
	return {
		generateWithTemplate: async (taskType: string) => {
			if (taskType === 'quality_assessment') {
				return {
					content: '{"score":0.9,"suggestions":["tighten the opening"],"issues":[]}',
				};
			}
			if (taskType === 'enhance') return { content: 'ENHANCED TEXT' };
			if (taskType.startsWith('optimize_')) return { content: 'OPTIMIZED TEXT' };
			return { content: 'GENERATED TEXT' };
		},
	} as unknown as AISemanticExtractor;
}

const docs = [
	{ id: 'd1', content: 'Chapter one content.', title: 'Chapter 1' },
	{ id: 'd2', content: 'Chapter two content.', title: 'Chapter 2' },
];

describe('AICompilationService', () => {
	let service: AICompilationService;
	beforeEach(() => {
		service = new AICompilationService(fakeExtractor());
	});

	it('compiles base content and assesses quality when no AI options are set', async () => {
		const result = await service.compileWithAI(docs, { outputFormat: 'text' });
		expect(typeof result.content).toBe('string');
		expect(result.content).toContain('Chapter one content.');
		expect(result.quality.score).toBe(0.9);
		expect(result.metadata.optimizations).toEqual([]);
		expect(result.metadata.processingTime).toBeGreaterThanOrEqual(0);
	});

	it('applies target optimization', async () => {
		const result = await service.compileWithAI(docs, {
			outputFormat: 'text',
			target: 'agent-query',
			optimizeForTarget: true,
		});
		expect(result.content).toBe('OPTIMIZED TEXT');
		expect(result.metadata.optimizations).toContain('Formatted as query letter');
	});

	it('applies content enhancement', async () => {
		const result = await service.compileWithAI(docs, {
			outputFormat: 'text',
			enhanceContent: true,
		});
		expect(result.content).toBe('ENHANCED TEXT');
		expect(result.metadata.optimizations).toContain('Enhanced prose quality');
	});

	it('generates the requested marketing artifact as text', async () => {
		const result = await service.generateMarketingMaterials(docs, {
			materialType: 'query_letter',
			length: 500,
			targetAudience: 'agents',
		});
		expect(result.content).toBe('GENERATED TEXT');
		expect(result.processingTime).toBeGreaterThanOrEqual(0);
	});
});

const liveAnthropic = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;
liveAnthropic('AICompilationService — live Claude', () => {
	it('generates a synopsis from manuscript content', async () => {
		const service = new AICompilationService();
		const result = await service.generateMarketingMaterials(
			[
				{
					id: 'd1',
					title: 'Opening',
					content:
						'Mara, a disgraced pilot, steals a ship to reach the colony before the blockade ' +
						'closes. Her brother is aboard, and the fleet that exiled her now hunts them both.',
				},
			],
			{ materialType: 'synopsis', length: 150 }
		);
		expect(typeof result.content).toBe('string');
		expect(result.content.length).toBeGreaterThan(50);
	}, 45000);
});
