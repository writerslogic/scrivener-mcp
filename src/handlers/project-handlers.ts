/**
 * Project management handlers - utilizes common utilities for validation and error handling
 */

import * as path from 'path';
import { MemoryManager } from '../memory-manager.js';
import { ScrivenerProject } from '../scrivener-project.js';
import {
	validateInput,
	pathExists,
	sanitizePath,
	createError,
	ErrorCode,
} from '../utils/common.js';
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
	description: 'Open a Scrivener project file',
	inputSchema: {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: 'Path to the .scriv project folder',
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
		const projectPath = sanitizePath(rawPath);

		// Verify the path exists
		if (!(await pathExists(projectPath))) {
			throw createError(
				ErrorCode.FILE_NOT_FOUND,
				{ path: projectPath },
				`Project path does not exist: ${projectPath}`
			);
		}

		// Close existing project
		if (context.project) {
			await context.project.close();
		}

		// Initialize new project
		const project = new ScrivenerProject(projectPath);
		await project.loadProject();

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
					text: `Project opened: ${metadata.title || path.basename(projectPath)}`,
					data: { metadata },
				},
			],
		};
	},
};

export const getStructureHandler: ToolDefinition = {
	name: 'get_structure',
	description: 'Get the hierarchical structure of the project',
	inputSchema: {
		type: 'object',
		properties: {
			maxDepth: {
				type: 'number',
				description: 'Maximum depth to traverse (default: unlimited)',
			},
			folderId: {
				type: 'string',
				description: 'Get structure for specific folder only',
			},
			includeTrash: {
				type: 'boolean',
				description: 'Include trash folder (default: false)',
			},
			summaryOnly: {
				type: 'boolean',
				description: 'Return summary with counts instead of full structure',
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
						text: 'Project summary retrieved',
						data: summary,
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
					text: 'Project structure retrieved',
					data: structure,
				},
			],
		};
	},
};

export const refreshProjectHandler: ToolDefinition = {
	name: 'refresh_project',
	description: 'Refresh the project data from disk',
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
