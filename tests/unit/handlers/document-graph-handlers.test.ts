/**
 * Verifies the consolidated get_entity_references handler: it dispatches to the
 * document->entities direction (documentId) or entity->documents direction
 * (entity), and rejects ambiguous or empty input (must be exactly one of the two).
 */

import { getEntityReferencesHandler } from '../../../src/handlers/document-graph-handlers.js';
import type { HandlerContext } from '../../../src/handlers/types.js';

const context = {
	project: {
		getAllDocuments: async () => [{ id: 'd1', title: 'Scene', content: '' }],
	},
	// No databaseService: the registry loader degrades to "no known entities".
} as unknown as HandlerContext;

describe('get_entity_references', () => {
	it('returns a mentions shape when queried by documentId', async () => {
		const res = await getEntityReferencesHandler.handler({ documentId: 'd1' }, context);
		expect(res.structuredContent).toEqual({ documentId: 'd1', mentions: [] });
	});

	it('returns a documents shape when queried by entity', async () => {
		const res = await getEntityReferencesHandler.handler({ entity: 'Elena' }, context);
		expect(res.structuredContent).toEqual({ entity: 'Elena', documents: [] });
	});

	it('rejects when both documentId and entity are given', async () => {
		await expect(
			getEntityReferencesHandler.handler({ documentId: 'd1', entity: 'Elena' }, context)
		).rejects.toThrow(/exactly one/i);
	});

	it('rejects when neither is given', async () => {
		await expect(getEntityReferencesHandler.handler({}, context)).rejects.toThrow(
			/exactly one/i
		);
	});
});
