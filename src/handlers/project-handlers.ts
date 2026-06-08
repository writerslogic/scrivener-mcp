/**
 * Project management handlers - utilizes common utilities for validation and error handling
 */

import * as path from 'path';
import { MemoryManager } from '../memory-manager.js';
import { ScrivenerProject } from '../scrivener-project.js';
import { validateInput, createError, ErrorCode } from '../utils/common.js';
import { resolveScrivenerProjectPath } from '../utils/scrivener-utils.js';
import { DatabaseService } from './database/database-service.js';
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
			path: {
				type: 'string',
				description: 'Path to .scriv folder',
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

		const metadata = await project.getProjectMetadata();
		return {
			content: [
				{
					type: 'text',
					text:
						`Project opened: ${metadata.title || path.basename(projectPath)}\n\n` +
						JSON.stringify(metadata, null, 2),
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
			maxDepth: {
				type: 'number',
				description: 'Max traversal depth',
			},
			folderId: {
				type: 'string',
				description: 'Folder UUID',
			},
			includeTrash: {
				type: 'boolean',
				description: 'Include trash',
			},
			summaryOnly: {
				type: 'boolean',
				description: 'Summary with counts only',
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
						text: JSON.stringify(summary, null, 2),
					},
				],
			};
		}

		const structure = await project.getProjectStructureLimited({
			maxDepth: getOptionalNumberArg(args, 'maxDepth'),
			folderId: getOptionalStringArg(args, 'folderId'),
			includeTrash: getOptionalBooleanArg(args, 'includeTrash') || false,
		});

		return {
			content: [
				{
					type: 'text',
					text: JSON.stringify(structure, null, 2),
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

export const projectHandlers = [
	openProjectHandler,
	getStructureHandler,
	refreshProjectHandler,
	closeProjectHandler,
];
