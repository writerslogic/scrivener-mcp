/**
 * AISemanticExtractor tests. Empty/no-key behavior is deterministic; key-gated
 * live tests verify extraction QUALITY (finds known entities and a relationship),
 * not parity with the old LangChain extractor.
 */

import {
	AISemanticExtractor,
	type ExtractedEntity,
} from '../../../../src/services/ai/ai-semantic-extractor.js';
import { AIClient } from '../../../../src/services/ai/ai-client.js';

/**
 * Stub the AIClient so the parsing/coercion path runs deterministically without
 * a key or network — this is the bug-prone code, and it is otherwise only covered
 * by the key-gated live tests (skipped in CI).
 */
function stub(reply: string | (() => string)) {
	let calls = 0;
	let lastPrompt = '';
	const ai = {
		provider: 'anthropic',
		chat: async (prompt: string) => {
			calls += 1;
			lastPrompt = prompt;
			return typeof reply === 'function' ? reply() : reply;
		},
	} as unknown as AIClient;
	return { ex: new AISemanticExtractor(ai), calls: () => calls, lastPrompt: () => lastPrompt };
}

const entity = (name: string): ExtractedEntity => ({
	name,
	type: 'character',
	context: '',
	mentions: 1,
});

describe('AISemanticExtractor', () => {
	it('returns empty for empty text without calling the model', async () => {
		const ex = new AISemanticExtractor(new AIClient({ anthropicApiKey: '', openaiApiKey: '' }));
		expect(await ex.extractEntities('   ')).toEqual([]);
	});

	it('returns no relationships for fewer than two entities', async () => {
		const ex = new AISemanticExtractor(new AIClient({ anthropicApiKey: '', openaiApiKey: '' }));
		expect(await ex.analyzeRelationships([])).toEqual([]);
	});

	const liveAnthropic = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;
	liveAnthropic('live Claude extraction quality', () => {
		const passage =
			'Captain Mara Vance led her crew aboard the starship Aurora toward the planet Keldar. ' +
			'Her first officer, Joren, distrusted the mission from the start.';

		it('extracts the named characters and a place', async () => {
			const ex = new AISemanticExtractor();
			const entities = await ex.extractEntities(passage);
			const names = entities.map((e) => e.name.toLowerCase()).join(' | ');
			expect(names).toContain('mara');
			expect(names).toContain('joren');
			// Every entity has a valid type and a positive mention count.
			for (const e of entities) {
				expect(['character', 'location', 'organization', 'event', 'object']).toContain(
					e.type
				);
				expect(e.mentions).toBeGreaterThan(0);
			}
		}, 30000);

		it('finds a relationship between two extracted entities', async () => {
			const ex = new AISemanticExtractor();
			const entities = await ex.extractEntities(passage);
			const rels = await ex.analyzeRelationships(entities);
			expect(Array.isArray(rels)).toBe(true);
			if (rels.length > 0) {
				expect(rels[0].strength).toBeGreaterThanOrEqual(0);
				expect(rels[0].strength).toBeLessThanOrEqual(1);
				expect(rels[0].entity1.length).toBeGreaterThan(0);
			}
		}, 30000);
	});
});

describe('AISemanticExtractor — deterministic parsing (stubbed client)', () => {
	describe('extractEntities', () => {
		it('parses a fenced JSON array and normalizes fields', async () => {
			const { ex } = stub(
				'```json\n[{"name":"  Mara ","type":"CHARACTER","context":"captain","mentions":3}]\n```'
			);
			const [e] = await ex.extractEntities('text');
			expect(e).toEqual({ name: 'Mara', type: 'character', context: 'captain', mentions: 3 });
		});

		it('coerces an unknown type to object and drops nameless entries', async () => {
			const { ex } = stub(
				'[{"name":"X","type":"alien"},{"type":"character"},{"name":"   "}]'
			);
			const out = await ex.extractEntities('text');
			expect(out).toEqual([{ name: 'X', type: 'object', context: '', mentions: 1 }]);
		});

		it('floors and defaults the mention count', async () => {
			const { ex } = stub(
				'[{"name":"A","mentions":2.9},{"name":"B","mentions":-4},{"name":"C","mentions":"x"}]'
			);
			expect((await ex.extractEntities('text')).map((e) => e.mentions)).toEqual([2, 1, 1]);
		});

		it('returns [] for a non-array reply', async () => {
			const { ex } = stub('{"not":"an array"}');
			expect(await ex.extractEntities('text')).toEqual([]);
		});

		it('throws when the reply contains no JSON (current contract)', async () => {
			const { ex } = stub('I could not find anything to extract.');
			await expect(ex.extractEntities('text')).rejects.toThrow();
		});
	});

	describe('analyzeRelationships', () => {
		it('does not call the model for fewer than two entities', async () => {
			const { ex, calls } = stub(() => {
				throw new Error('chat must not be called');
			});
			expect(await ex.analyzeRelationships([entity('A')])).toEqual([]);
			expect(calls()).toBe(0);
		});

		it('parses and clamps relationship strength, coercing bad types', async () => {
			const { ex } = stub(
				'[{"entity1":"A","entity2":"B","relationship":"knows","strength":1.7,"type":"weird"},' +
					'{"entity1":"A","entity2":"B","relationship":"sees","strength":-2,"type":"location"},' +
					'{"entity1":"A","entity2":"B","relationship":"x","strength":"nan"}]'
			);
			const out = await ex.analyzeRelationships([entity('A'), entity('B')]);
			expect(out.map((r) => r.strength)).toEqual([1, 0, 0.5]);
			expect(out[0].type).toBe('character');
			expect(out[1].type).toBe('location');
		});

		it('drops relationships missing a side or the relationship text', async () => {
			const { ex } = stub(
				'[{"entity1":"A","entity2":"B"},{"entity1":"A","relationship":"r"},{"entity2":"B","relationship":"r"}]'
			);
			expect(await ex.analyzeRelationships([entity('A'), entity('B')])).toEqual([]);
		});
	});

	describe('generateWithTemplate', () => {
		it('returns the model content and prefers customPrompt', async () => {
			const { ex, lastPrompt } = stub('OUTPUT');
			const r = await ex.generateWithTemplate('task', 'fallback', { customPrompt: 'CUSTOM' });
			expect(r).toEqual({ content: 'OUTPUT' });
			expect(lastPrompt()).toBe('CUSTOM');
		});

		it('falls back to the plain prompt when no customPrompt is given', async () => {
			const { ex, lastPrompt } = stub('OUTPUT');
			await ex.generateWithTemplate('task', 'fallback');
			expect(lastPrompt()).toBe('fallback');
		});
	});
});
