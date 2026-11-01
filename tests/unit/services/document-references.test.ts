import {
	findEntityMentions,
	buildReferenceIndex,
	referencesForDocument,
	documentsReferencing,
	orphanedEntities,
	suggestConnections,
	type RegistryEntity,
	type DocumentText,
} from '../../../src/services/document-references.js';

const ENTITIES: RegistryEntity[] = [
	{ id: 'c1', name: 'Elena', type: 'character', aliases: ['Ellie'] },
	{ id: 'c2', name: 'Marcus', type: 'character' },
	{ id: 'c3', name: 'Al', type: 'character' },
	{ id: 'l1', name: 'Thornfield Manor', type: 'location' },
	{ id: 'c4', name: 'Ghost', type: 'character' },
];

const DOCS: DocumentText[] = [
	{
		id: 'd1',
		title: 'Chapter 1',
		content: 'Elena walked to Thornfield Manor. Marcus followed Elena. Also, Ellie waved.',
	},
	{ id: 'd2', title: 'Chapter 2', content: 'Marcus stood alone at Thornfield Manor.' },
	{ id: 'd3', title: 'Chapter 3', content: 'A quiet chapter with nobody named here.' },
];

describe('findEntityMentions', () => {
	it.each([99, 100, 101])(
		'retains all %i source offsets instead of silently capping a mention list',
		(count) => {
			const content = 'Mara '.repeat(count);
			const [mention] = findEntityMentions({ id: 'scene', title: 'Scene', content }, [
				{ id: 'mara', name: 'Mara', type: 'character' },
			]);
			expect(mention.count).toBe(count);
			expect(mention.positions).toEqual(
				Array.from({ length: count }, (_, index) => index * 5)
			);
		}
	);
	it.each([999999, 1000000, 1000001])(
		'enforces the total evidence position budget at %i matches',
		(count) => {
			const analyze = () =>
				buildReferenceIndex(
					[{ id: 'scene', title: 'Scene', content: 'A '.repeat(count) }],
					[{ id: 'a', name: 'A', type: 'character' }]
				);
			if (count > 1000000) expect(analyze).toThrow('1000000 source positions');
			else expect(analyze()[0].mentions[0].positions).toHaveLength(count);
		}
	);
	it('rejects oversized mention evidence before returning an incomplete index', () => {
		const entities: RegistryEntity[] = Array.from({ length: 256 }, (_, index) => ({
			id: `entity-${index}`,
			name: `Name${index} ${'x'.repeat(1990)}`,
			type: 'character',
			aliases: ['A'],
		}));
		const docs = Array.from({ length: 40 }, (_, index) => ({
			id: `scene-${index}`,
			title: 'Scene',
			content: 'A',
		}));
		expect(() => buildReferenceIndex(docs, entities)).toThrow('16 MiB of mention evidence');
	});
	it('matches accented and non-Latin names at Unicode boundaries with exact UTF-16 offsets', () => {
		const content =
			'🌙 Élodie met 李雷. PréÉlodie and 李雷子 are different names. ÉLODIE waved.';
		const mentions = findEntityMentions({ id: 'unicode', title: 'Names', content }, [
			{ id: 'elodie', name: 'Élodie', type: 'character' },
			{ id: 'li', name: '李雷', type: 'character' },
		]);
		expect(mentions).toMatchObject([
			{
				entityId: 'elodie',
				count: 2,
				positions: [content.indexOf('Élodie'), content.indexOf('ÉLODIE')],
			},
			{ entityId: 'li', count: 1, positions: [content.indexOf('李雷')] },
		]);
	});
	it('counts whole-word, case-insensitive matches and records positions', () => {
		const mentions = findEntityMentions(DOCS[0], ENTITIES);
		const elena = mentions.find((m) => m.entityId === 'c1');
		// "Elena" x2 + alias "Ellie" x1 = 3.
		expect(elena!.count).toBe(3);
		expect(elena!.positions.length).toBe(3);
		expect(elena!.positions[0]).toBe(0);
	});

	it('does not match a short name inside a longer word', () => {
		// "Al" must not match inside "Also" or "alone".
		const mentions = findEntityMentions(DOCS[0], ENTITIES);
		expect(mentions.find((m) => m.entityId === 'c3')).toBeUndefined();
	});

	it('matches multi-word location names', () => {
		const mentions = findEntityMentions(DOCS[0], ENTITIES);
		expect(mentions.find((m) => m.entityId === 'l1')!.count).toBe(1);
	});

	it('returns nothing for empty content or no entities', () => {
		expect(findEntityMentions({ id: 'x', title: 't', content: '' }, ENTITIES)).toEqual([]);
		expect(findEntityMentions(DOCS[0], [])).toEqual([]);
	});
});

describe('buildReferenceIndex + referencesForDocument', () => {
	const index = buildReferenceIndex(DOCS, ENTITIES);

	it('indexes only documents that mention something', () => {
		expect(index.map((e) => e.documentId).sort()).toEqual(['d1', 'd2']);
	});

	it('returns a document’s mentions, and empty for an unknown/quiet doc', () => {
		expect(
			referencesForDocument(index, 'd2')
				.map((m) => m.entityId)
				.sort()
		).toEqual(['c2', 'l1']);
		expect(referencesForDocument(index, 'd3')).toEqual([]);
		expect(referencesForDocument(index, 'nope')).toEqual([]);
	});
});

describe('documentsReferencing', () => {
	const index = buildReferenceIndex(DOCS, ENTITIES);

	it('finds documents by entity name (case-insensitive), ranked by count', () => {
		const docs = documentsReferencing(index, 'thornfield manor', ENTITIES);
		expect(docs.map((d) => d.documentId)).toEqual(['d1', 'd2']);
	});

	it('finds documents by entity id', () => {
		const docs = documentsReferencing(index, 'c1', ENTITIES);
		expect(docs).toEqual([{ documentId: 'd1', title: 'Chapter 1', count: 3 }]);
	});

	it('returns empty for an unknown entity', () => {
		expect(documentsReferencing(index, 'Nobody', ENTITIES)).toEqual([]);
	});
});

describe('orphanedEntities', () => {
	it('lists registry entities that no document mentions', () => {
		const index = buildReferenceIndex(DOCS, ENTITIES);
		const orphans = orphanedEntities(index, ENTITIES)
			.map((e) => e.id)
			.sort();
		// "Al" (never a whole word) and "Ghost" (absent) are orphans.
		expect(orphans).toEqual(['c3', 'c4']);
	});
});

describe('suggestConnections', () => {
	it('counts distinct registry identities even when their display names coincide', () => {
		const entities: RegistryEntity[] = [
			{ id: 'character', name: 'Jordan', type: 'character' },
			{ id: 'location', name: 'Jordan', type: 'location' },
			{ id: 'candidate', name: 'Mara', type: 'character' },
		];
		const index = buildReferenceIndex(
			[
				{ id: 'own', title: 'Own', content: 'Jordan.' },
				{ id: 'other', title: 'Other', content: 'Jordan and Mara.' },
			],
			entities
		);
		expect(suggestConnections(index, 'own')).toEqual([
			{
				entityId: 'candidate',
				entityName: 'Mara',
				type: 'character',
				coOccurrences: 2,
				relatedTo: ['Jordan', 'Jordan'],
			},
		]);
	});

	it('suggests entities that co-occur elsewhere with a document’s cast', () => {
		// Build a graph where Elena and Marcus co-occur, and Marcus co-occurs with
		// Thornfield Manor — so a doc with only Elena should be nudged toward both.
		const docs: DocumentText[] = [
			{ id: 'a', title: 'A', content: 'Elena and Marcus met at Thornfield Manor.' },
			{ id: 'b', title: 'B', content: 'Marcus returned to Thornfield Manor.' },
			{ id: 'c', title: 'C', content: 'Elena was alone.' },
		];
		const index = buildReferenceIndex(docs, ENTITIES);
		const suggestions = suggestConnections(index, 'c');
		const ids = suggestions.map((s) => s.entityId);
		expect(ids).toContain('c2'); // Marcus co-occurs with Elena in doc A
		expect(ids).toContain('l1'); // Thornfield Manor co-occurs with Elena in doc A
		// Elena herself (already present) is never suggested.
		expect(ids).not.toContain('c1');
	});

	it('returns empty when the document has no known entities', () => {
		const index = buildReferenceIndex(DOCS, ENTITIES);
		expect(suggestConnections(index, 'd3')).toEqual([]);
	});
});
