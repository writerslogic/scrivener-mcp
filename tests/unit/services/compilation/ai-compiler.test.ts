import { describeLiveAnthropic as liveAnthropic } from '../../../helpers/live-provider.js';
import { AICompilationService } from '../../../../src/services/compilation/ai-compiler.js';
import type { AIClient, ChatOptions } from '../../../../src/services/ai/ai-client.js';
import { createHash } from 'node:crypto';

function fixture(reply: (prompt: string, options?: ChatOptions) => string | Promise<string>) {
	const chat = jest.fn(async (prompt: string, options?: ChatOptions) => reply(prompt, options));
	return {
		service: new AICompilationService({ chat } as unknown as AIClient),
		chat,
	};
}

const qualityReply = '{"score":0.9,"suggestions":[],"issues":[]}';

function fakeClient(): AIClient {
	return {
		chat: async (prompt: string) => {
			if (prompt.startsWith('Assess the quality'))
				return '{"score":0.9,"suggestions":["tighten the opening"],"issues":[]}';
			if (prompt.startsWith('Enhance')) return 'ENHANCED TEXT';
			if (prompt.startsWith('Transform')) return 'OPTIMIZED TEXT';
			return 'GENERATED TEXT';
		},
	} as unknown as AIClient;
}

const docs = [
	{ id: 'd1', content: 'Chapter one content.', title: 'Chapter 1' },
	{ id: 'd2', content: 'Chapter two content.', title: 'Chapter 2' },
];

describe('AICompilationService', () => {
	let service: AICompilationService;
	beforeEach(() => {
		service = new AICompilationService(fakeClient());
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
		expect(result.metadata.optimizations).toContain('Generated query letter');
	});

	it('applies content enhancement', async () => {
		const result = await service.compileWithAI(docs, {
			outputFormat: 'text',
			enhanceContent: true,
		});
		expect(result.content).toBe('ENHANCED TEXT');
		expect(result.metadata.optimizations).toContain('Provider prose revision');
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

describe('AI compilation integrity', () => {
	it.each([249, 250, 251])(
		'enforces the 250-word query limit for %i acronym words',
		async (count) => {
			const generated = 'U.S.A. '.repeat(count).trim();
			const { service } = fixture((prompt) =>
				prompt.startsWith('Assess') ? qualityReply : generated
			);
			const result = await service.compileWithAI(docs, {
				target: 'agent-query',
				optimizeForTarget: true,
			});
			if (count <= 250) {
				expect(result.content).toBe(generated);
				expect(result.metadata.wordCount).toBe(count);
			} else {
				expect(result.content).toContain('Chapter one content.');
				expect(result.metadata.optimizations).toEqual([]);
				expect(result.metadata.warnings).toContain(
					'Target optimization unavailable; original content preserved'
				);
			}
		}
	);
	it('applies author preferences to prose without steering the quality assessment', async () => {
		const { service, chat } = fixture((prompt) =>
			prompt.startsWith('Assess') ? qualityReply : 'Revised prose.'
		);
		await service.compileWithAI(docs, {
			enhanceContent: true,
			preferenceDirective: 'Use a formal, polished tone.',
		});
		expect(chat.mock.calls[0][1]?.system).toContain('formal, polished tone');
		expect(chat.mock.calls[1][1]?.system).toContain('STRICT JSON');
		expect(chat.mock.calls[1][1]?.system).not.toContain('formal, polished tone');
	});

	it.each([0, 1, 1999, 2000, 2001, 1.5])(
		'bounds marketing requests at %i words before generation',
		async (length) => {
			const { service, chat } = fixture(() => 'Generated synopsis.');
			const pending = service.generateMarketingMaterials(docs, { length });
			if (Number.isInteger(length) && length >= 1 && length <= 2000) {
				await expect(pending).resolves.toMatchObject({ content: 'Generated synopsis.' });
				const budget = chat.mock.calls[0][1]?.maxTokens;
				expect(budget).toBeGreaterThan(length);
				expect(budget).toBeLessThanOrEqual(8192);
			} else {
				await expect(pending).rejects.toThrow(/length/);
				expect(chat).not.toHaveBeenCalled();
			}
		}
	);
	it('preserves the successful target result when later enhancement violates its word limit', async () => {
		const { service } = fixture((prompt) =>
			prompt.startsWith('Assess the quality')
				? qualityReply
				: prompt.startsWith('Enhance')
					? 'word '.repeat(251)
					: 'A short query.'
		);
		const result = await service.compileWithAI(docs, {
			target: 'agent-query',
			optimizeForTarget: true,
			enhanceContent: true,
		});
		expect(result.content).toBe('A short query.');
		expect(result.metadata.optimizations).toEqual(['Generated query letter']);
		expect(result.metadata.warnings).toHaveLength(1);
	});
	it.each([-1, 0, 1, 2, '0.7', null])(
		'preserves valid scores and makes invalid score %j unavailable',
		async (score) => {
			const { service } = fixture(() =>
				JSON.stringify({ score, suggestions: [], issues: [] })
			);
			const result = await service.compileWithAI(docs);
			const valid = score === 0 || score === 1;
			expect(result.quality.score).toBe(valid ? score : null);
			expect(result.quality.availability).toBe(valid ? 'available' : 'partial');
		}
	);

	it.each(['{}', '[]', 'No assessment.'])(
		'reports unavailable quality for %s without inventing scores',
		async (response) => {
			const { service } = fixture(() => response);
			const { quality } = await service.compileWithAI(docs);
			expect(quality).toMatchObject({
				score: null,
				suggestions: null,
				issues: null,
				availability: 'unavailable',
			});
		}
	);

	it('preserves every valid finding and makes malformed fields explicit', async () => {
		const suggestions = ['One', 'Two', 'Three', 'Four'];
		const { service } = fixture(() =>
			JSON.stringify({
				score: '0.9',
				suggestions: [...suggestions, null],
				issues: ['Actual finding', 12],
			})
		);
		const result = await service.compileWithAI(docs);
		expect(result.quality).toMatchObject({
			score: null,
			suggestions,
			issues: ['Actual finding'],
			availability: 'partial',
			unavailableFields: ['score'],
			partialFields: ['suggestions', 'issues'],
		});
	});

	it('keeps formatted original output when provider revisions and assessment fail', async () => {
		const { service } = fixture(async () => {
			throw new Error('Private provider error');
		});
		const original = [
			{
				id: 'styled',
				title: 'Scene',
				content: {
					plainText: 'Styled ending.',
					formattedText: [{ text: 'Styled ending.', style: { bold: true } }],
				},
			},
		];
		const result = await service.compileWithAI(original, {
			outputFormat: 'html',
			enhanceContent: true,
		});
		expect(result.content).toContain('<strong>Styled ending.</strong>');
		expect(result.metadata.optimizations).toEqual([]);
		expect(result.metadata.warnings).toHaveLength(1);
		expect(result.quality).toMatchObject({
			score: null,
			availability: 'unavailable',
			reason: 'provider_failed',
		});
		expect(JSON.stringify(result)).not.toContain('Private provider error');
	});

	it.each([11999, 12000, 12001])(
		'never replaces full content with a partial rewrite at %i characters',
		async (length) => {
			const text = 'x'.repeat(length - 4) + 'TAIL';
			const { service, chat } = fixture((prompt) => {
				if (prompt.startsWith('Assess the quality')) return qualityReply;
				expect(prompt).toContain(text);
				return 'Complete revision.';
			});
			const result = await service.compileWithAI(
				[{ id: 'scene', title: '', content: text }],
				{ enhanceContent: true }
			);
			if (length <= 12000) {
				expect(result.content).toBe('Complete revision.');
				expect(result.metadata.warnings).toEqual([]);
			} else {
				expect(result.content).toBe(text);
				expect(result.metadata.optimizations).toEqual([]);
				expect(result.metadata.warnings[0]).toContain('12000');
			}
			expect(chat.mock.calls.map(([prompt]) => prompt)).toEqual(
				length <= 12000
					? [expect.stringMatching(/^Enhance/), expect.stringMatching(/^Assess/)]
					: [expect.stringMatching(/^Assess/)]
			);
		}
	);

	it('does not optimize a prefix of an oversized manuscript', async () => {
		const text = 'x'.repeat(12000) + 'END';
		const { service, chat } = fixture(() => qualityReply);
		const result = await service.compileWithAI([{ id: 'scene', title: '', content: text }], {
			optimizeForTarget: true,
			target: 'synopsis',
		});
		expect(result.content).toBe(text);
		expect(result.metadata.warnings[0]).toContain('12000');
		expect(chat).toHaveBeenCalledTimes(1);
		expect(chat.mock.calls[0][0]).toMatch(/^Assess/);
	});

	it('rolls back the whole optimization when condensation does not satisfy its limit', async () => {
		const { service, chat } = fixture((prompt) =>
			prompt.startsWith('Assess the quality') ? qualityReply : 'word '.repeat(251)
		);
		const result = await service.compileWithAI(docs, {
			target: 'agent-query',
			optimizeForTarget: true,
		});
		expect(result.content).toContain('Chapter one content.');
		expect(result.metadata.optimizations).toEqual([]);
		expect(result.metadata.warnings).toHaveLength(1);
		expect(chat.mock.calls.map(([prompt]) => prompt)).toEqual([
			expect.stringMatching(/^Transform/),
			expect.stringMatching(/^Condense/),
			expect.stringMatching(/^Assess/),
		]);
	});

	it('renders generated plain text through the requested HTML format', async () => {
		const { service } = fixture((prompt) =>
			prompt.startsWith('Assess the quality')
				? qualityReply
				: 'One <script>alert(1)</script> & two.'
		);
		const result = await service.compileWithAI(docs, {
			outputFormat: 'html',
			enhanceContent: true,
		});
		expect(result.content).toContain('<!DOCTYPE html>');
		expect(result.content).toContain('&lt;script&gt;');
		expect(result.content).not.toContain('<script>');
		expect(result.content).not.toContain('<h1></h1>');
	});

	it.each([3999, 4000, 4001])(
		'reports exact assessment coverage at %i characters',
		async (length) => {
			const text = 'x'.repeat(length);
			const { service, chat } = fixture(() => qualityReply);
			const { quality } = await service.compileWithAI([
				{ id: 'scene', title: '', content: text },
			]);
			expect(quality.coverage).toEqual({
				start: 0,
				end: Math.min(length, 4000),
				sourceCharacters: length,
				sourceRevision: createHash('sha256').update(text).digest('hex'),
				truncated: length > 4000,
			});
			expect(chat.mock.calls[0][0]).toContain('BEGIN UNTRUSTED INPUT');
			if (length > 4000) expect(chat.mock.calls[0][0]).not.toContain(text);
		}
	);

	it.each([11999, 12000, 12001])(
		'requires complete marketing source within %i characters',
		async (length) => {
			const text = 'x'.repeat(length);
			const { service, chat } = fixture(() => 'A complete source-based synopsis.');
			const pending = service.generateMarketingMaterials([
				{ id: 'scene', title: '', content: text },
			]);
			if (length <= 12000) {
				await expect(pending).resolves.toMatchObject({ content: expect.any(String) });
				expect(chat.mock.calls[0][0]).toContain(text);
			} else {
				await expect(pending).rejects.toThrow('complete source within 12000');
				expect(chat).not.toHaveBeenCalled();
			}
		}
	);
});

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
