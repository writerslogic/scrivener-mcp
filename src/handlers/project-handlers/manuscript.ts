import { compact } from '../../core/response-formatter.js';
import type { HandlerResult, ToolDefinition } from '../types.js';
import { requireProject } from '../types.js';

export const getCompileSettingsHandler: ToolDefinition = {
	name: 'get_compile_settings',
	title: 'Get Compile & Taxonomy Settings',
	description:
		"Return the project's compile-format definitions (from Settings/compile.xml) and its " +
		'taxonomy: the named compile formats and their section-layout counts, the current output ' +
		'file type, label and status definitions (with colors), saved collections, and user-defined ' +
		'section types. Use this to discover what compile formats and metadata categories a project ' +
		'defines before compiling or organizing. Read-only; does not run a compile. If a project has ' +
		'never been compiled, hasCompileSettings is false and only the taxonomy is returned. Requires ' +
		'an open project (call open_project first).',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {},
	},
	outputSchema: {
		type: 'object',
		properties: {
			hasCompileSettings: {
				type: 'boolean',
				description: 'False when Settings/compile.xml is absent or unreadable.',
			},
			currentFileType: {
				type: 'string',
				description: 'Default output file type of the last-used compile (e.g. "pdf").',
			},
			options: {
				type: 'object',
				description: 'Global compile options.',
				properties: {
					removeComments: { type: 'boolean', description: 'Strip comments on compile.' },
					removeAnnotations: {
						type: 'boolean',
						description: 'Strip inline annotations on compile.',
					},
				},
			},
			compileFormats: {
				type: 'array',
				description: 'Named compile formats the project defines.',
				items: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'Format identifier.' },
						font: { type: 'string', description: 'Font override, if any.' },
						sectionLayoutCount: {
							type: 'number',
							description: 'Number of section-type to layout assignments.',
						},
						hasFrontMatter: {
							type: 'boolean',
							description: 'Whether the format injects default front/back matter.',
						},
					},
				},
			},
			sectionTypes: {
				type: 'array',
				description: 'User-defined section types (Scene, Chapter, Part Heading, ...).',
				items: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'Section-type UUID.' },
						name: { type: 'string', description: 'Human-readable name.' },
					},
				},
			},
			labels: {
				type: 'array',
				description: 'Label definitions with colors.',
				items: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'Label id.' },
						title: { type: 'string', description: 'Label name.' },
						color: {
							type: 'string',
							description: 'Normalized-RGB color string, if set.',
						},
						hex: { type: 'string', description: 'Color as #RRGGBB, if parseable.' },
					},
				},
			},
			statuses: {
				type: 'array',
				description: 'Status definitions.',
				items: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'Status id.' },
						title: { type: 'string', description: 'Status name.' },
					},
				},
			},
			collections: {
				type: 'array',
				description: 'Saved collections (binder, saved searches, groups).',
				items: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'Collection UUID.' },
						title: { type: 'string', description: 'Collection name.' },
						type: {
							type: 'string',
							description: 'Collection kind (Binder, RecentSearch, ...).',
						},
						color: {
							type: 'string',
							description: 'Normalized-RGB color string, if set.',
						},
						hex: { type: 'string', description: 'Color as #RRGGBB, if parseable.' },
					},
				},
			},
		},
		required: ['hasCompileSettings', 'compileFormats'],
	},
	handler: async (_args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const settings = await project.getCompileMetadata();
		return {
			content: [
				{
					type: 'text',
					text: compact(settings),
				},
			],
			structuredContent: settings as unknown as Record<string, unknown>,
		};
	},
};

export const getManuscriptBriefingHandler: ToolDefinition = {
	name: 'get_manuscript_briefing',
	title: 'Manuscript Briefing',
	description:
		'One "where am I?" snapshot of the whole manuscript: total word count against the project draft ' +
		'target (with percent-to-goal and deadline), document/folder counts, the per-status and ' +
		'per-label breakdown, and the longest and shortest documents. Use this right after open_project ' +
		'to orient before diving in, instead of stitching get_statistics, get_writing_goals, and ' +
		'get_compile_settings together. Read-only. Requires an open project.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {},
	},
	outputSchema: {
		type: 'object',
		properties: {
			title: { type: 'string', description: 'Project title.' },
			author: { type: 'string', description: 'Project author, if set.' },
			words: {
				type: 'object',
				description: 'Word-count progress against the draft target.',
				properties: {
					total: { type: 'number', description: 'Total words across text documents.' },
					draftTarget: {
						type: 'number',
						description: 'Project draft word target, if set in Scrivener.',
					},
					percentToTarget: {
						type: 'number',
						description: 'total / draftTarget as a percentage, if a target is set.',
					},
					deadline: { type: 'string', description: 'Project deadline, if set.' },
				},
			},
			documents: {
				type: 'object',
				description: 'Binder item counts.',
				properties: {
					total: { type: 'number', description: 'All binder items.' },
					folders: { type: 'number', description: 'Folder count.' },
					textDocuments: { type: 'number', description: 'Text document count.' },
				},
			},
			averageDocumentLength: { type: 'number', description: 'Mean words per text document.' },
			byStatus: {
				type: 'object',
				description: 'Count of text documents per status (e.g. To Do, Done).',
			},
			byLabel: { type: 'object', description: 'Count of text documents per label.' },
			longest: {
				type: 'object',
				description: 'Longest text document by word count, or null.',
				properties: {
					id: { type: 'string', description: 'Document UUID.' },
					title: { type: 'string', description: 'Document title.' },
					wordCount: { type: 'number', description: 'Word count.' },
				},
			},
			shortest: {
				type: 'object',
				description: 'Shortest text document by word count, or null.',
				properties: {
					id: { type: 'string', description: 'Document UUID.' },
					title: { type: 'string', description: 'Document title.' },
					wordCount: { type: 'number', description: 'Word count.' },
				},
			},
		},
		required: ['words', 'documents', 'byStatus', 'byLabel'],
	},
	handler: async (_args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const briefing = await project.getManuscriptBriefing();
		return {
			content: [{ type: 'text', text: compact(briefing) }],
			structuredContent: briefing as unknown as Record<string, unknown>,
		};
	},
};
