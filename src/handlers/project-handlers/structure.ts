import { compact } from '../../core/response-formatter.js';
import { SHARED_DEFS } from '../shared-schemas.js';
import type { DocumentInfo } from '../../types/index.js';
import type { HandlerResult, ToolDefinition } from '../types.js';
import {
	requireProject,
	getOptionalNumberArg,
	getOptionalStringArg,
	getOptionalBooleanArg,
} from '../types.js';

export const getStructureHandler: ToolDefinition = {
	name: 'get_structure',
	title: 'Get Project Structure',
	description:
		'Return the binder hierarchy of the open project: its folders and documents in tree order, ' +
		'each with id, title, type, depth, and word count. Use this to understand the manuscript ' +
		'layout and to obtain the document ids that read_document, write_document, and the analysis ' +
		'tools require. By default returns a compact flat array of [id, title, type, depth, wordCount, ' +
		'hasChildren] tuples to save tokens; set summaryOnly for just project-level counts. Requires an ' +
		'open project (call open_project first).',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			maxDepth: {
				type: 'number',
				description:
					'Maximum depth to descend into the binder tree, starting at 0 for top-level items. ' +
					'Omit to return the full hierarchy.',
			},
			folderId: SHARED_DEFS.folderId,
			includeTrash: SHARED_DEFS.includeTrash,
			summaryOnly: {
				type: 'boolean',
				description:
					'When true, skip the tree and return only project-level counts (documents, words) ' +
					'plus title and author. Default false.',
			},
			flat: {
				type: 'boolean',
				description:
					'When true (default), return a compact flat array of [id, title, type, depth, ' +
					'wordCount, hasChildren] tuples. When false, return the nested tree object.',
			},
		},
	},
	outputSchema: {
		type: 'object',
		properties: {
			documents: {
				type: 'array',
				description:
					'Flat list of binder items in tree order (present unless summaryOnly).',
				items: {
					type: 'object',
					properties: {
						id: {
							type: 'string',
							description: 'Document/folder UUID for read_document etc.',
						},
						title: {
							type: 'string',
							description: 'Item title as shown in the binder.',
						},
						type: {
							type: 'string',
							description: 'Item type, e.g. "Text" or "Folder".',
						},
						depth: {
							type: 'number',
							description: 'Nesting depth, 0 for top-level items.',
						},
						wordCount: {
							type: 'number',
							description: 'Word count of the item (0 for folders).',
						},
						hasChildren: {
							type: 'boolean',
							description: 'Whether the item contains nested items.',
						},
					},
				},
			},
			summary: {
				type: 'object',
				description:
					'Project-level counts plus title and author (present when summaryOnly).',
			},
			structure: {
				type: 'object',
				description: 'Nested binder tree (present when flat is false).',
			},
		},
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);

		if (args.summaryOnly) {
			const stats = await project.getStatistics();
			const metadata = await project.getProjectMetadata();
			const summary = {
				...stats,
				title: metadata.title,
				author: metadata.author,
			};
			return {
				content: [
					{
						type: 'text',
						text: compact(summary),
					},
				],
				structuredContent: { summary },
			};
		}

		const structure = await project.getProjectStructureLimited({
			maxDepth: getOptionalNumberArg(args, 'maxDepth'),
			folderId: getOptionalStringArg(args, 'folderId'),
			includeTrash: getOptionalBooleanArg(args, 'includeTrash') || false,
		});

		// Default to flat format for token efficiency
		const flat = getOptionalBooleanArg(args, 'flat') ?? true;

		if (flat) {
			// Flatten into compact tuples: [id, title, type, depth, wordCount, hasChildren]
			type FlatRow = [string, string, string, number, number, boolean];
			const rows: FlatRow[] = [];

			const flatten = (node: DocumentInfo, depth: number): void => {
				const hasChildren = !!(node.children && node.children.length > 0);
				rows.push([
					node.id,
					node.title,
					node.type,
					depth,
					node.wordCount ?? 0,
					hasChildren,
				]);
				if (node.children) {
					for (const child of node.children) {
						flatten(child, depth + 1);
					}
				}
			};

			// Flatten every top-level binder item (root is a synthetic wrapper over them).
			for (const node of structure.root?.children ?? []) {
				flatten(node, 0);
			}

			const documents = rows.map(([id, title, type, depth, wordCount, hasChildren]) => ({
				id,
				title,
				type,
				depth,
				wordCount,
				hasChildren,
			}));
			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify(rows),
					},
				],
				structuredContent: { documents },
			};
		}

		return {
			content: [
				{
					type: 'text',
					text: compact(structure),
				},
			],
			structuredContent: { structure: structure as unknown as Record<string, unknown> },
		};
	},
};
