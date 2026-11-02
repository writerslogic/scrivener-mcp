import type { ToolDefinition, ToolSchema } from './types.js';
import { getStringArg, requireProject } from './types.js';
import type { PassageSearchOptions } from '../services/editorial/passage-search.js';

export const passageSearchOutputSchema: ToolSchema = {
	type: 'object',
	properties: {
		query: { type: 'string', description: 'The original query searched locally.' },
		mode: {
			type: 'string',
			description: 'Hybrid, keyword, or semantic retrieval mode.',
		},
		method: {
			type: 'string',
			description: 'The local feature encoding and ranking algorithm used.',
		},
		limitations: {
			type: 'string',
			description:
				'Coverage and privacy limitations of the configured local retrieval models.',
		},
		index: {
			type: 'object',
			description: 'Incremental indexing work performed for this search.',
			properties: {
				changedDocuments: {
					type: 'integer',
					description: 'Documents whose passage chunks were added or rebuilt.',
				},
				removedDocuments: {
					type: 'integer',
					description: 'Documents removed from the scoped index.',
				},
				passages: {
					type: 'integer',
					description: 'Current number of indexed passages in the project.',
				},
				documents: {
					type: 'integer',
					description: 'Current number of nonempty indexed source documents.',
				},
			},
			required: ['changedDocuments', 'removedDocuments', 'passages'],
		},
		results: {
			type: 'array',
			description: 'Matching passages from saved manuscript revisions, ordered by relevance.',
			items: {
				type: 'object',
				properties: {
					projectId: {
						type: 'string',
						description: 'The project identity containing the source passage.',
					},
					documentId: {
						type: 'string',
						description: 'Stable Scrivener binder UUID of the source document.',
					},
					revision: {
						type: 'string',
						description: 'SHA-256 revision of the saved source RTF.',
					},
					title: { type: 'string', description: 'Source document title.' },
					path: { type: 'string', description: 'Source document binder location.' },
					start: {
						type: 'integer',
						description:
							'Inclusive UTF-16 offset of the passage in parsed source text.',
					},
					end: {
						type: 'integer',
						description:
							'Exclusive UTF-16 offset of the passage in parsed source text.',
					},
					line: {
						type: 'integer',
						description: 'One-based starting line in the parsed source text.',
					},
					quote: { type: 'string', description: 'Exact matching source passage.' },
					context: {
						type: 'string',
						description: 'Passage plus the requested surrounding manuscript context.',
					},
					contextStart: {
						type: 'integer',
						description: 'Inclusive UTF-16 offset of the returned context.',
					},
					contextEnd: {
						type: 'integer',
						description: 'Exclusive UTF-16 offset of the returned context.',
					},
					score: {
						type: 'number',
						description:
							'Relevance score in the selected mode, or a local cross-encoder logit when configured.',
					},
					keywordScore: {
						type: 'number',
						description: 'Normalized BM25 score for exact query tokens.',
					},
					semanticScore: {
						type: 'number',
						description:
							'Cosine similarity from the configured local model or story-concept vectors.',
					},
					hmsScore: {
						type: 'number',
						description:
							'Warm document relevance score from BM25 and supplied local vectors.',
					},
					matchedConcepts: {
						type: 'array',
						description:
							'Shared story-concept dimensions supporting conceptual relevance.',
						items: { type: 'string' },
					},
				},
				required: [
					'projectId',
					'documentId',
					'revision',
					'title',
					'path',
					'start',
					'end',
					'line',
					'quote',
					'context',
					'contextStart',
					'contextEnd',
					'score',
					'keywordScore',
					'semanticScore',
					'hmsScore',
					'matchedConcepts',
				],
			},
		},
	},
	required: ['query', 'mode', 'method', 'limitations', 'index', 'results'],
};

export const localSearchHandlers: ToolDefinition[] = [
	{
		name: 'search_passages',
		title: 'Search Local Manuscript Passages',
		description:
			'Search saved manuscript passages without a provider key. Warm combines BM25 with configured local model embeddings, or default bounded English story-concept vectors, and optional local reranking. Return exact quotations, context, binder locations and saved revisions. Each response discloses the active method and its limits.',
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			type: 'object',
			properties: {
				query: {
					type: 'string',
					minLength: 1,
					maxLength: 2048,
					description: 'A phrase, story concept, or keywords to retrieve locally.',
				},
				mode: {
					type: 'string',
					enum: ['hybrid', 'keyword', 'semantic'],
					description:
						'Hybrid (default), exact token ranking, or local vector similarity.',
				},
				limit: {
					type: 'integer',
					minimum: 1,
					maximum: 50,
					description: 'Maximum number of passage matches; default 10.',
				},
				contextChars: {
					type: 'integer',
					minimum: 0,
					maximum: 2000,
					description:
						'Maximum UTF-16 code units of surrounding context on each side; default 240.',
				},
				documentIds: {
					type: 'array',
					maxItems: 10000,
					items: { type: 'string', minLength: 1, maxLength: 128 },
					description:
						'Optional explicit document UUID scope within the open manuscript.',
				},
			},
			required: ['query'],
		},
		outputSchema: passageSearchOutputSchema,
		handler: async (args, context) => {
			const services = await requireProject(context).getEditorialServices();
			const result = await services.search.search(getStringArg(args, 'query'), {
				mode: args.mode,
				limit: args.limit,
				contextChars: args.contextChars,
				documentIds: args.documentIds,
			} as PassageSearchOptions);
			const text = result.results.length
				? result.results
						.map(
							(hit) =>
								`${hit.title} (${hit.path}, line ${hit.line}, ${hit.documentId}, revision ${hit.revision})\n${hit.context}\nRelevance ${hit.score.toFixed(3)}; concepts: ${hit.matchedConcepts.join(', ') || 'none'}`
						)
						.join('\n\n')
				: 'No matching passages. Try different keywords or broaden the document scope.';
			return {
				content: [{ type: 'text', text: `${text}\n\n${result.limitations}` }],
				structuredContent: { ...result },
			};
		},
	},
];
