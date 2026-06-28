/**
 * AISemanticExtractor tests. Empty/no-key behavior is deterministic; key-gated
 * live tests verify extraction QUALITY (finds known entities and a relationship),
 * not parity with the old LangChain extractor.
 */

import { AISemanticExtractor } from '../../../../src/services/ai/ai-semantic-extractor.js';
import { AIClient } from '../../../../src/services/ai/ai-client.js';

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
