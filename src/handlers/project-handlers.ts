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
	description: 'Open a Scrivener project',
	inputSchema: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Path to .scriv' },
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
	description: 'Get project hierarchy',
	inputSchema: {
		type: 'object',
		properties: {
			maxDepth: { type: 'number', description: 'Max depth' },
			folderId: SHARED_DEFS.folderId,
			includeTrash: SHARED_DEFS.includeTrash,
			summaryOnly: { type: 'boolean', description: 'Counts only' },
			flat: { type: 'boolean', description: 'Compact array format (default true)' },
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
	description: 'Reload project from disk',
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
	description: 'Close the current project',
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
	description: 'Scan common locations for Scrivener projects and return their paths',
	inputSchema: {
		type: 'object',
		properties: {
			searchPath: {
				type: 'string',
				description: 'Additional directory to search (optional)',
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
