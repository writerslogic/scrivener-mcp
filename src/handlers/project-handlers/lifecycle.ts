import * as path from 'path';
import { MemoryManager } from '../../memory-manager.js';
import { ScrivenerProject } from '../../scrivener-project.js';
import { validateInput, createError, ErrorCode } from '../../utils/common.js';
import { compact } from '../../core/response-formatter.js';
import { resolveScrivenerProjectPath } from '../../utils/scrivener-utils.js';
import { PersonalizationService } from '../../services/personalization/personalization-service.js';
import type { HandlerContext, HandlerResult, ToolDefinition } from '../types.js';
import { requireProject, getStringArg } from '../types.js';

const lifecycleOperations = new WeakMap<HandlerContext, Promise<void>>();

function withProjectLifecycle<T>(context: HandlerContext, operation: () => Promise<T>): Promise<T> {
	const pending = (lifecycleOperations.get(context) ?? Promise.resolve()).then(operation);
	const settled = pending.then(
		() => undefined,
		() => undefined
	);
	lifecycleOperations.set(context, settled);
	void settled.then(() => {
		if (lifecycleOperations.get(context) === settled) lifecycleOperations.delete(context);
	});
	return pending;
}

function clearProjectContext(context: HandlerContext): void {
	context.project = null;
	context.memoryManager = null;
	context.databaseService = undefined;
	context.personalization = new PersonalizationService(null);
}

async function retireProject(context: HandlerContext): Promise<void> {
	if (context.memoryManager) {
		try {
			await context.memoryManager.stopAutoSave();
		} catch (error) {
			throw new Error(
				'Could not save project memory; the current project remains available so closing can be retried',
				{ cause: error }
			);
		}
	}
	try {
		await context.project?.close();
	} finally {
		clearProjectContext(context);
	}
}

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
		return withProjectLifecycle(context, async () => {
			validateInput(args, {
				path: {
					type: 'string',
					required: true,
					minLength: 1,
				},
			});

			const rawPath = getStringArg(args, 'path');
			const { projectPath, scrivxPath } = await resolveScrivenerProjectPath(rawPath);

			await retireProject(context);

			// Initialize new project
			const project = new ScrivenerProject(projectPath, {
				hhmSystem: context.hhmSystem,
				scrivxPath,
			});
			let memoryManager: MemoryManager | undefined;
			let memoryInitialized = false;
			let phase: 'load' | 'memory' | 'metadata' = 'load';
			try {
				await project.loadProject();
				phase = 'memory';
				const database = project.getDatabaseService();
				memoryManager = new MemoryManager(projectPath, database);
				await memoryManager.initialize();
				memoryInitialized = true;
				phase = 'metadata';
				const metadata = await project.getProjectMetadata();
				const result: HandlerResult = {
					content: [
						{
							type: 'text',
							text: `Project opened: ${metadata.title || path.basename(projectPath)}\n\n${compact(metadata)}`,
						},
					],
				};
				const personalization = new PersonalizationService(database);
				context.project = project;
				context.memoryManager = memoryManager;
				context.databaseService = database;
				context.personalization = personalization;
				return result;
			} catch (error) {
				const cleanupFailures: Array<{ resource: 'memory' | 'project'; cause: unknown }> =
					[];
				if (memoryInitialized && memoryManager) {
					try {
						await memoryManager.stopAutoSave();
					} catch (cause) {
						cleanupFailures.push({ resource: 'memory', cause });
					}
				}
				try {
					await project.close();
				} catch (cause) {
					cleanupFailures.push({ resource: 'project', cause });
				}
				const expectedScrivxPath = path.join(
					projectPath,
					`${path.basename(projectPath, path.extname(projectPath))}.scrivx`
				);
				const failure = createError(
					phase === 'load' ? ErrorCode.PROJECT_NOT_FOUND : ErrorCode.INITIALIZATION_ERROR,
					{ path: projectPath, expectedScrivxPath, phase, cause: error, cleanupFailures },
					(phase === 'load'
						? `Could not open Scrivener project at "${projectPath}". Expected to find "${expectedScrivxPath}". Pass the .scriv project folder or its .scrivx file.`
						: `Could not initialize project ${phase} at "${projectPath}". The project was not opened.`) +
						(cleanupFailures.length
							? ' Resource cleanup also failed; error details retain the original cause.'
							: '')
				);
				failure.cause = error;
				throw failure;
			}
		});
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
		return withProjectLifecycle(context, async () => {
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
		});
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
		return withProjectLifecycle(context, async () => {
			requireProject(context);
			await retireProject(context);

			return {
				content: [
					{
						type: 'text',
						text: 'Project closed successfully',
					},
				],
			};
		});
	},
};
