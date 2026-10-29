import { createError, ErrorCode } from '../../core/errors.js';
import { compact, formatError } from '../../core/response-formatter.js';
import type { HandlerResult, ToolDefinition } from '../types.js';
import { getOptionalNumberArg, getStringArg, requireProject } from '../types.js';
import { SHARED_DEFS } from '../shared-schemas.js';

export const multiAgentAnalysisHandler: ToolDefinition = {
	name: 'multi_agent_analysis',
	description: 'Multi-agent analysis',
	inputSchema: {
		type: 'object',
		properties: {
			documentId: SHARED_DEFS.docId,
			agents: {
				type: 'array',
				items: {
					type: 'string',
					enum: ['editor', 'critic', 'researcher', 'stylist', 'plotter', 'all'],
				},
			},
			collaborationMode: { type: 'string', enum: ['collaborative', 'workshop', 'review'] },
		},
		required: ['documentId'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const documentId = getStringArg(args, 'documentId');
		const agents = (args.agents as string[]) || ['all'];
		const collaborationMode = (args.collaborationMode as string) || 'collaborative';

		const document = await project.getDocument(documentId);
		if (!document) {
			throw createError(ErrorCode.NOT_FOUND, 'Document not found');
		}

		try {
			const { AICollaboration } = await import('../../services/agents/ai-collaboration.js');

			const collaboration = new AICollaboration();
			const result = await collaboration.collaborateOnDocument(document, {
				enabledAgents: agents.includes('all')
					? ['Writer', 'Editor', 'Researcher', 'Critic', 'Coordinator']
					: agents,
				enableCritique: collaborationMode === 'workshop',
				enableSynthesis: true,
			});

			return {
				content: [
					{
						type: 'text',
						text: compact({
							...result,
							collaborationMode,
							agents,
							enhanced: true,
						}),
					},
				],
			};
		} catch (error) {
			return {
				content: [
					{
						type: 'text',
						text: `Multi-agent analysis failed: ${formatError(error)}`,
					},
				],
			};
		}
	},
};

export const semanticSearchHandler: ToolDefinition = {
	name: 'semantic_search',
	title: 'Semantic Search',
	description:
		'Find passages with local story-concept vectors and source context without an API key, and ' +
		'return the most relevant documents with similarity scores and related entities. Use this ' +
		'for conceptual "find passages about X" queries; use search for keyword/full-text matching ' +
		'and find_mentions to locate every occurrence of a specific name or term. Indexing and similarity ' +
		'scoring are local; conceptual coverage is bounded to the documented English story vocabulary. ' +
		'Requires an open project with semantic indexing available.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			query: SHARED_DEFS.query,
			maxResults: SHARED_DEFS.maxResults,
			threshold: {
				...SHARED_DEFS.threshold,
				description:
					'Minimum similarity score (0-1) a result must meet to be returned. Default 0.3; ' +
					'raise for stricter matches, lower for broader recall.',
			},
		},
		required: ['query'],
	},
	outputSchema: {
		type: 'object',
		properties: {
			results: {
				type: 'array',
				description: 'Documents most relevant to the query, ordered by similarity.',
				items: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'Document id.' },
						title: { type: 'string', description: 'Document title.' },
						snippet: {
							type: 'string',
							description: 'Leading excerpt of the matched document.',
						},
						score: {
							type: ['number', 'null'],
							description: 'Similarity score, or null when unavailable.',
						},
					},
				},
			},
			searchType: {
				type: 'string',
				description: "Search mode used; always 'semantic' for this tool.",
			},
		},
		required: ['results'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const query = getStringArg(args, 'query');
		const maxResults = getOptionalNumberArg(args, 'maxResults') ?? 10;
		const threshold = getOptionalNumberArg(args, 'threshold') ?? 0.3;
		if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
			throw new Error('threshold must be from zero through one');
		const matches = await project
			.getEditorialServices()
			.search.search(query, { limit: maxResults, mode: 'semantic' });
		const results = matches.results
			.filter((match) => match.score >= threshold)
			.map((match) => ({ ...match, id: match.documentId, snippet: match.context }));
		const result = { ...matches, results, searchType: 'semantic' };
		return {
			content: [{ type: 'text', text: JSON.stringify(result) }],
			structuredContent: result,
		};
	},
};
