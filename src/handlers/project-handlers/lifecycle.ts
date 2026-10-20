import * as path from 'path';
import { MemoryManager } from '../../memory-manager.js';
import { ScrivenerProject } from '../../scrivener-project.js';
import { validateInput, createError, ErrorCode } from '../../utils/common.js';
import { compact } from '../../core/response-formatter.js';
import { resolveScrivenerProjectPath } from '../../utils/scrivener-utils.js';
import { DatabaseService } from '../database/database-service.js';
import { PersonalizationService } from '../../services/personalization/personalization-service.js';
import type { HandlerResult, ToolDefinition } from '../types.js';
import { requireProject, getStringArg } from '../types.js';

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
