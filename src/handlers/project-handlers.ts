/**
 * Project management handlers - utilizes common utilities for validation and error handling
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MemoryManager } from '../memory-manager.js';
import { ScrivenerProject } from '../scrivener-project.js';
import { validateInput, createError, ErrorCode } from '../utils/common.js';
import { compact } from '../core/response-formatter.js';
import { resolveScrivenerProjectPath } from '../utils/scrivener-utils.js';
import { DatabaseService } from './database/database-service.js';
import { PersonalizationService } from '../services/personalization/personalization-service.js';
import { SHARED_DEFS } from './shared-schemas.js';
import type { DocumentInfo } from '../types/index.js';
import type { HandlerResult, ToolDefinition } from './types.js';
import {
	requireProject,
	getOptionalNumberArg,
	getOptionalStringArg,
	getOptionalBooleanArg,
	getStringArg,
} from './types.js';

export const openProjectHandler: ToolDefinition = {
	name: 'open_project',
	title: 'Open Scrivener Project',
	description:
		'Open a Scrivener project and make it the active project for this session. Every document, ' +
		'structure, search, and analysis tool operates on the project opened here, so call this first. ' +
		'Accepts the path to a .scriv folder or the .scrivx file inside it and resolves the project ' +
		'automatically. Returns the project title, author, and metadata. Opening a project closes any ' +
		'project already open. If you do not know the path, call discover_projects first.',
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	inputSchema: {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description:
					'Path to the Scrivener project: either the .scriv folder (e.g. ' +
					'"~/Documents/My Novel.scriv") or the .scrivx file inside it. Absolute or ~-relative.',
			},
		},
		required: ['path'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		// Validate input arguments
		validateInput(args, {
			path: {
				type: 'string',
				required: true,
				minLength: 1,
			},
		});

		const rawPath = getStringArg(args, 'path');
		const { projectPath, scrivxPath } = await resolveScrivenerProjectPath(rawPath);

		// Close existing project
		if (context.project) {
			await context.project.close();
		}

		// Initialize new project
		const project = new ScrivenerProject(projectPath, {
			hhmSystem: context.hhmSystem,
			scrivxPath,
		});
		try {
			await project.loadProject();
		} catch (error) {
			const expectedScrivxPath = path.join(
				projectPath,
				`${path.basename(projectPath, path.extname(projectPath))}.scrivx`
			);
			throw createError(
				ErrorCode.PROJECT_NOT_FOUND,
				{ path: projectPath, expectedScrivxPath, cause: error },
				`Could not open Scrivener project at "${projectPath}". Expected to find "${expectedScrivxPath}". Pass the .scriv project folder or its .scrivx file.`
			);
		}

		// Initialize database service
		const dbService = new DatabaseService(projectPath);
		await dbService.initialize();

		// Initialize memory manager
		const memoryManager = new MemoryManager(projectPath, dbService);
		await memoryManager.initialize();

		// Update context
		context.project = project;
		context.memoryManager = memoryManager;
		context.databaseService = project.getDatabaseService();
		context.personalization = new PersonalizationService(context.databaseService);

		const metadata = await project.getProjectMetadata();
		return {
			content: [
				{
					type: 'text',
					text: `Project opened: ${metadata.title || path.basename(projectPath)}\n\n${compact(
						metadata
					)}`,
				},
			],
		};
	},
};

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

			// Flatten each top-level section
			if (structure.draft) flatten(structure.draft, 0);
			if (structure.research) flatten(structure.research, 0);
			if (structure.trash) flatten(structure.trash, 0);

			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify(rows),
					},
				],
			};
		}

		return {
			content: [
				{
					type: 'text',
					text: compact(structure),
				},
			],
		};
	},
};

export const refreshProjectHandler: ToolDefinition = {
	name: 'refresh_project',
	title: 'Reload Project From Disk',
	description:
		'Reload the open project from disk, discarding the in-memory cache. Use this when the project ' +
		'has been changed by the Scrivener app or another process while open here, so that subsequent ' +
		'reads reflect the latest saved state. Requires an open project. Takes no parameters.',
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	inputSchema: {
		type: 'object',
		properties: {},
	},
	handler: async (_args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		await project.refreshProject();

		return {
			content: [
				{
					type: 'text',
					text: 'Project refreshed successfully',
				},
			],
		};
	},
};

export const closeProjectHandler: ToolDefinition = {
	name: 'close_project',
	title: 'Close Project',
	description:
		'Close the currently open project, flush any pending memory/auto-save state, and clear the ' +
		'active session. After this, document and analysis tools have no project to act on until ' +
		'open_project is called again. Use this to switch projects cleanly or release file handles ' +
		'at the end of a session. Requires an open project. Takes no parameters.',
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {},
	},
	handler: async (_args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		await project.close();

		if (context.memoryManager) {
			await context.memoryManager.stopAutoSave();
		}

		context.project = null;
		context.memoryManager = null;
		context.databaseService = undefined;
		context.personalization = new PersonalizationService(null);

		return {
			content: [
				{
					type: 'text',
					text: 'Project closed successfully',
				},
			],
		};
	},
};

async function findScrivProjects(dir: string, depth: number): Promise<string[]> {
	if (depth === 0) return [];
	let results: string[] = [];
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const full = path.join(dir, entry.name);
		if (entry.name.endsWith('.scriv')) {
			results.push(full);
		} else if (!entry.name.startsWith('.')) {
			results = results.concat(await findScrivProjects(full, depth - 1));
		}
	}
	return results;
}

export const discoverProjectsHandler: ToolDefinition = {
	name: 'discover_projects',
	title: 'Discover Scrivener Projects',
	description:
		'Scan common locations (Documents, Desktop, and iCloud Mobile Documents) for Scrivener ' +
		'projects and return the paths of every .scriv folder found, searching up to three levels ' +
		'deep. Use this when the user refers to their project by name rather than path ("open my ' +
		'novel"): present the results and pass the chosen path to open_project. Does not open ' +
		'anything itself. Returns a list of project paths, or a message if none are found.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	inputSchema: {
		type: 'object',
		properties: {
			searchPath: {
				type: 'string',
				description:
					'Optional extra directory to search in addition to the default locations, e.g. an ' +
					'external drive or a custom projects folder. Absolute or ~-relative path.',
			},
		},
	},
	handler: async (args): Promise<HandlerResult> => {
		const home = os.homedir();
		const searchDirs = [
			path.join(home, 'Documents'),
			path.join(home, 'Desktop'),
			path.join(home, 'Library', 'Mobile Documents'),
		];
		const extra = args.searchPath as string | undefined;
		if (extra) searchDirs.push(extra);

		const found: string[] = [];
		for (const dir of searchDirs) {
			const projects = await findScrivProjects(dir, 3);
			found.push(...projects);
		}

		if (found.length === 0) {
			return {
				content: [
					{
						type: 'text',
						text: 'No Scrivener projects found in common locations. Use open_project with the full path to your .scriv folder.',
					},
				],
			};
		}
		return {
			content: [
				{
					type: 'text',
					text: `Found ${found.length} project(s):\n${found.map((p) => `• ${p}`).join('\n')}\n\nUse open_project with one of these paths.`,
				},
			],
		};
	},
};

export const projectHandlers = [
	openProjectHandler,
	getStructureHandler,
	refreshProjectHandler,
	closeProjectHandler,
	discoverProjectsHandler,
];
