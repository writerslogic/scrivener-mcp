/**
 * AIDocumentAnalyzer tests. Empty-input and no-key behavior are deterministic;
 * an explicitly opted-in live test exercises a real Claude analysis round-trip.
 */

import { describeLiveAnthropic as liveAnthropic } from '../../helpers/live-provider.js';
import { AIDocumentAnalyzer } from '../../../src/analysis/ai-document-analyzer.js';
import { AIClient } from '../../../src/services/ai/ai-client.js';

describe('AIDocumentAnalyzer', () => {
	it('reports empty source as unavailable without calling the model', async () => {
		const analyzer = new AIDocumentAnalyzer(
			new AIClient({ anthropicApiKey: '', openaiApiKey: '', openrouterApiKey: '' })
		);
		await expect(analyzer.analyzeDocument('   ')).rejects.toThrow('complete, nonblank source');
	});

	it('propagates a clear error when no provider is configured and content is present', async () => {
		const analyzer = new AIDocumentAnalyzer(
			new AIClient({ anthropicApiKey: '', openaiApiKey: '', openrouterApiKey: '' })
		);
		await expect(analyzer.analyzeDocument('The cat sat.')).rejects.toThrow(
			/No AI provider configured/
		);
	});

	liveAnthropic('live Claude analysis', () => {
		it('returns a conforming analysis with string fields and an issues array', async () => {
			const analyzer = new AIDocumentAnalyzer();
			const result = await analyzer.analyzeDocument(
				'The man walked into the room. It was very dark. He was scared. Suddenly, ' +
					'something moved in the corner and he felt his heart race with fear.'
			);
			expect(typeof result.readability).toBe('string');
			expect(result.readability.length).toBeGreaterThan(0);
			expect(typeof result.pacing).toBe('string');
			expect(Array.isArray(result.issues)).toBe(true);
		}, 30000);
	});
});

describe('bounded complete provider document analysis', () => {
	let chat: jest.Mock;
	let analyzer: AIDocumentAnalyzer;
	const valid = {
		readability: 'Clear sentences.',
		pacing: 'Steady.',
		issues: [{ description: 'Repeated opener.', severity: 'low' }],
	};
	beforeEach(() => {
		chat = jest.fn().mockResolvedValue(JSON.stringify(valid));
		analyzer = new AIDocumentAnalyzer({ chat, provider: 'openai' } as unknown as AIClient);
	});

	it('preserves exact source and literal code fences within model JSON strings', async () => {
		const content = '  Mara waited.\n';
		const response = {
			...valid,
			issues: [{ description: 'The text says ```json literally.' }],
		};
		chat.mockResolvedValue('```json\n' + JSON.stringify(response) + '\n```');
		expect(await analyzer.analyzeDocument(content, ['style', 'characters'])).toEqual(response);
		expect(chat.mock.calls[0][0]).toContain(content);
		expect(chat.mock.calls[0][0]).toContain('requested areas: characters, style');
	});

	it.each([11999, 12000, 12001])(
		'admits complete source or rejects %i UTF-16 characters without clipping',
		async (length) => {
			const content = 'x'.repeat(length - 3) + '🌙.';
			if (length <= 12000) {
				await expect(analyzer.analyzeDocument(content)).resolves.toEqual(valid);
				expect(chat.mock.calls[0][0]).toContain(content);
			} else {
				await expect(analyzer.analyzeDocument(content)).rejects.toThrow('1–12000');
				expect(chat).not.toHaveBeenCalled();
			}
		}
	);

	it.each([63999, 64000, 64001])(
		'bounds raw provider response at %i UTF-16 characters',
		async (length) => {
			chat.mockResolvedValue(JSON.stringify(valid).padStart(length));
			if (length <= 64000)
				await expect(analyzer.analyzeDocument('A passage.')).resolves.toEqual(valid);
			else
				await expect(analyzer.analyzeDocument('A passage.')).rejects.toThrow(
					'incomplete or invalid'
				);
		}
	);

	it.each([511, 512, 513])(
		'bounds provider assessments at %i UTF-16 characters',
		async (length) => {
			chat.mockResolvedValue(JSON.stringify({ ...valid, readability: 'x'.repeat(length) }));
			if (length <= 512)
				expect((await analyzer.analyzeDocument('A passage.')).readability).toHaveLength(
					length
				);
			else
				await expect(analyzer.analyzeDocument('A passage.')).rejects.toThrow(
					'incomplete or invalid'
				);
		}
	);

	it.each([2047, 2048, 2049])(
		'bounds individual issue text at %i UTF-16 characters',
		async (length) => {
			chat.mockResolvedValue(
				JSON.stringify({ ...valid, issues: [{ description: 'x'.repeat(length) }] })
			);
			if (length <= 2048)
				expect(
					(await analyzer.analyzeDocument('A passage.')).issues[0].description
				).toHaveLength(length);
			else
				await expect(analyzer.analyzeDocument('A passage.')).rejects.toThrow(
					'incomplete or invalid'
				);
		}
	);

	it.each([63, 64, 65])('bounds provider issues at %i entries', async (count) => {
		chat.mockResolvedValue(
			JSON.stringify({
				...valid,
				issues: Array.from({ length: count }, () => ({ description: 'An issue.' })),
			})
		);
		if (count <= 64)
			expect((await analyzer.analyzeDocument('A passage.')).issues).toHaveLength(count);
		else
			await expect(analyzer.analyzeDocument('A passage.')).rejects.toThrow(
				'incomplete or invalid'
			);
	});

	it.each([
		null,
		[],
		{},
		{ ...valid, readability: 3 },
		{ ...valid, pacing: '   ' },
		{ ...valid, issues: null },
		{ ...valid, issues: ['A malformed issue.'] },
		{ ...valid, issues: [{ severity: 'high' }] },
		{ ...valid, issues: [{ description: 'Issue', severity: 'urgent' }] },
		{ ...valid, issues: [{ description: '  ' }] },
		{ ...valid, arbitrary: true },
	])(
		'rejects malformed provider findings %j without filling or dropping fields',
		async (response) => {
			chat.mockResolvedValue(JSON.stringify(response));
			await expect(analyzer.analyzeDocument('A passage.')).rejects.toThrow(
				'incomplete or invalid'
			);
		}
	);
});
