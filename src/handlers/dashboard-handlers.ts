import { z } from 'zod';
import { PacingAnalyzer } from '../analysis/analyzers/pacing-analyzer.js';
import { findSubtree } from '../utils/binder-tree.js';
import type { ToolDefinition } from './types.js';
import { requireProject } from './types.js';

export const DASHBOARD_URI = 'ui://scrivener/manuscript-dashboard';
export const APP_MIME_TYPE = 'text/html;profile=mcp-app';
const MAX_MENTIONS = 100;
const input = z
	.object({
		documentId: z.string().uuid().optional(),
		offset: z.number().int().min(0).default(0),
		limit: z.number().int().min(1).max(200).default(50),
	})
	.strict();

export function supportsApps(capabilities: unknown): boolean {
	const caps = capabilities as
		{ extensions?: Record<string, { mimeTypes?: unknown }> } | undefined;
	const types = caps?.extensions?.['io.modelcontextprotocol/ui']?.mimeTypes;
	return Array.isArray(types) && types.includes(APP_MIME_TYPE);
}

export const dashboardHandler: ToolDefinition = {
	name: 'manuscript_dashboard',
	title: 'Interactive Manuscript Dashboard',
	description:
		'Browse the binder, scene summaries, character appearances, measured pacing and unresolved continuity evidence; select a scene to read its saved manuscript context. MCP Apps clients receive an accessible interactive view, and all clients retain the same structured data and text. Review controls use review_changes.',
	_meta: {
		ui: { resourceUri: DASHBOARD_URI, visibility: ['model', 'app'] },
		'ui/resourceUri': DASHBOARD_URI,
	},
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			documentId: {
				type: 'string',
				description: 'Optional scene UUID whose saved source context to reveal.',
			},
			offset: {
				type: 'integer',
				description: 'First manuscript scene index for pagination; default zero.',
			},
			limit: {
				type: 'integer',
				description:
					'Number of manuscript scenes to return, from 1 through 200; default 50.',
			},
		},
	},
	outputSchema: {
		type: 'object',
		properties: {
			projectTitle: {
				type: 'string',
				description: 'Human-readable title of the selected project.',
			},
			projectId: {
				type: 'string',
				description: 'Stable project identity shared with evidence and search.',
			},
			uiSupported: {
				type: 'boolean',
				description: 'Whether the connected client negotiated MCP Apps HTML support.',
			},
			binder: {
				type: 'array',
				items: { type: 'object' },
				description:
					'Active binder hierarchy, including folder and document UUIDs and titles.',
			},
			scenes: {
				type: 'array',
				description:
					'Manuscript scenes in binder order, with source revision, synopsis, word count, pacing measurements and character appearances.',
				items: {
					type: 'object',
					properties: {
						documentId: { type: 'string', description: 'Stable binder document UUID.' },
						title: { type: 'string', description: 'Scene title.' },
						revision: {
							type: 'string',
							description: 'SHA-256 of the saved RTF source.',
						},
						path: { type: 'string', description: 'Binder location.' },
						words: { type: 'integer', description: 'Whitespace-separated word count.' },
						pacing: {
							type: 'object',
							description:
								'Existing local pacing analysis; a heuristic, not a claim of narrative intent.',
						},
						appearances: {
							type: 'array',
							items: {
								type: 'object',
								properties: {
									name: {
										type: 'string',
										description: 'Character name or alias matched as text.',
									},
									mentions: {
										type: 'array',
										maxItems: MAX_MENTIONS,
										description: 'First 100 located name mentions in saved manuscript order.',
										items: {
											type: 'object',
											properties: {
												start: {
													type: 'integer',
													description: 'Inclusive UTF-16 source offset.',
												},
												end: {
													type: 'integer',
													description: 'Exclusive UTF-16 source offset.',
												},
												quote: {
													type: 'string',
													description:
														'Matched name with up to 80 surrounding UTF-16 characters on either side.',
												},
											},
											required: ['start', 'end', 'quote'],
										},
									},
									truncated: {
										type: 'boolean',
										description:
											'True when additional name mentions exist beyond the first 100 returned passages; the returned length is not a complete occurrence count.',
									},
								},
								required: ['name', 'mentions', 'truncated'],
							},
							description:
								'Name and alias text mentions with source offsets; mentions do not establish factual presence.',
						},
					},
				},
			},
			findings: {
				type: 'array',
				items: { type: 'object' },
				description:
					'Unresolved continuity findings with supporting revision-bound source passages.',
			},
			proposals: {
				type: 'array',
				items: { type: 'object' },
				description: 'Persistent review proposals, edit states and application identities.',
			},
			applications: {
				type: 'array',
				items: { type: 'object' },
				description:
					'Durable application history for revision-guarded undo after restarting the server.',
			},
			context: {
				type: ['object', 'null'],
				description:
					'Selected saved scene, up to 20000 UTF-16 characters, with exact document identity and revision; null until selected.',
			},
			pagination: {
				type: 'object',
				description: 'Offset, returned count and total manuscript scenes.',
			},
		},
		required: [
			'projectId',
			'uiSupported',
			'binder',
			'scenes',
			'findings',
			'proposals',
			'context',
			'pagination',
		],
	},
	handler: async (args, context) => {
		const request = input.parse(args);
		const project = requireProject(context);
		const { source, bible, continuity, review } = project.getEditorialServices();
		const documents = await source.list();
		const binder = await project.getProjectStructure();
		const projectMetadata = await project.getProjectMetadata();
		const facts = await bible.listFacts(
			{ kind: 'project', id: source.projectId },
			{ sourceDocuments: documents }
		);
		const names = new Set(
			facts
				.filter((fact) => fact.kind === 'character' || fact.kind === 'alias')
				.flatMap((fact) =>
					fact.kind === 'alias' ? [fact.subject, fact.value] : [fact.subject]
				)
		);
		for (const character of context.memoryManager?.getAllCharacters() ?? [])
			names.add(character.name);
		const pacing = new PacingAnalyzer();
		const scenes = [];
		for (const document of documents.slice(request.offset, request.offset + request.limit)) {
			const info = findSubtree(binder, document.documentId);
			const appearances = [];
			for (const name of names) {
				if (!name.trim()) continue;
				const pattern = new RegExp(
					`(?<![\\p{L}\\p{N}_])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`,
					'giu'
				);
				const mentions: Array<{ start: number; end: number; quote: string }> = [];
				let truncated = false;
				for (const match of document.text.matchAll(pattern)) {
					if (mentions.length === MAX_MENTIONS) {
						truncated = true;
						break;
					}
					const start = match.index;
					const end = start + match[0].length;
					mentions.push({
						start,
						end,
						quote: document.text.slice(Math.max(0, start - 80), end + 80),
					});
				}
				if (mentions.length) appearances.push({ name, mentions, truncated });
			}
			scenes.push({
				documentId: document.documentId,
				title: document.title,
				path: document.path,
				revision: document.revision,
				synopsis: info?.synopsis ?? '',
				label: info?.label,
				status: info?.status,
				words: document.text.match(/\S+/g)?.length ?? 0,
				pacing: await pacing.analyzePacing(document.text),
				appearances,
			});
		}
		let selected = request.documentId
			? documents.find((document) => document.documentId === request.documentId)
			: undefined;
		if (request.documentId && !selected) {
			const info = await project.getDocumentInfo(request.documentId);
			if (!info.document || info.document.type !== 'Text' || info.location !== 'active')
				throw new Error('Selected context is not an active text document');
			const version = await project.readDocumentVersion(request.documentId);
			selected = {
				projectId: source.projectId,
				documentId: info.document.id,
				title: info.document.title,
				path: info.document.path,
				revision: version.revision,
				text: version.text,
				order: -1,
				metadata: info.document.customMetadata ?? {},
			};
		}
		const result = {
			projectTitle: projectMetadata.title || project.title,
			projectId: source.projectId,
			uiSupported: context.uiSupported === true,
			binder,
			scenes,
			findings: continuity.list(),
			proposals: review
				.list()
				.map(({ before, ...proposal }) => ({ ...proposal, beforeLength: before.length })),
			applications: review.listApplications(),
			context: selected
				? {
						...selected,
						text: selected.text.slice(0, 20000),
						truncated: selected.text.length > 20000,
					}
				: null,
			pagination: { offset: request.offset, count: scenes.length, total: documents.length },
		};
		return {
			content: [{ type: 'text', text: JSON.stringify(result) }],
			structuredContent: result,
		};
	},
};
