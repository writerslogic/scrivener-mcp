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
import { detectOpenScrivenerProjects, resolveProjectNames } from '../utils/scrivener-app.js';
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
	outputSchema: {
		type: 'object',
		properties: {
			projects: {
				type: 'array',
				description: 'Absolute paths of the .scriv projects found.',
				items: { type: 'string' },
			},
			count: { type: 'number', description: 'Number of projects found.' },
		},
		required: ['projects', 'count'],
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
				structuredContent: { projects: [], count: 0 },
			};
		}
		return {
			content: [
				{
					type: 'text',
					text: `Found ${found.length} project(s):\n${found.map((p) => `• ${p}`).join('\n')}\n\nUse open_project with one of these paths.`,
				},
			],
			structuredContent: { projects: found, count: found.length },
		};
	},
};

export const detectOpenProjectHandler: ToolDefinition = {
	name: 'detect_open_project',
	title: 'Detect Open Scrivener Project',
	description:
		'Detect which Scrivener project the user currently has open in the desktop Scrivener app, so ' +
		'you can act on it without asking for a path. Use this when the user says "my project", "the ' +
		'project I have open", or gives a command with no project specified. Reads the open window ' +
		'names from the running app and resolves them to .scriv paths on disk; it does not open ' +
		'anything. If exactly one project is open, pass its path to open_project. macOS only right ' +
		'now (returns supported=false elsewhere; fall back to discover_projects). The first use may ' +
		'prompt macOS to allow the client app to control Scrivener.',
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
					'Optional extra directory to resolve project names against, in addition to the ' +
					'default locations. Absolute or ~-relative path.',
			},
		},
	},
	outputSchema: {
		type: 'object',
		properties: {
			supported: {
				type: 'boolean',
				description: 'False on platforms where detection is not implemented (non-macOS).',
			},
			running: {
				type: 'boolean',
				description: 'Whether the Scrivener app appears to be running.',
			},
			openProjects: {
				type: 'array',
				description: 'Open projects resolved to a .scriv path.',
				items: {
					type: 'object',
					properties: {
						name: {
							type: 'string',
							description: 'Project name as shown in the Scrivener window title.',
						},
						path: {
							type: 'string',
							description: 'Absolute path to the matching .scriv folder.',
						},
					},
					required: ['name', 'path'],
				},
			},
			unresolved: {
				type: 'array',
				description:
					'Open project names that could not be matched to a .scriv folder on disk.',
				items: { type: 'string' },
			},
			count: { type: 'number', description: 'Number of resolved open projects.' },
		},
		required: ['supported', 'running', 'openProjects', 'unresolved', 'count'],
	},
	handler: async (args): Promise<HandlerResult> => {
		const empty = {
			openProjects: [] as { name: string; path: string }[],
			unresolved: [] as string[],
		};
		const reply = (text: string, extra: Record<string, unknown>): HandlerResult => ({
			content: [{ type: 'text', text }],
			structuredContent: { openProjects: [], unresolved: [], count: 0, ...extra },
		});

		const detection = await detectOpenScrivenerProjects();

		if (!detection.supported) {
			return reply(
				'Detecting the open project is only supported on macOS right now. Use discover_projects to list projects, or open_project with the full path.',
				{ supported: false, running: false, ...empty }
			);
		}
		if (detection.timedOut) {
			return reply(
				'Timed out talking to Scrivener. If macOS just asked to allow controlling Scrivener, approve it and try again; otherwise open_project with a path.',
				{ supported: true, running: false, ...empty }
			);
		}
		if (detection.permissionDenied) {
			return reply(
				"macOS blocked reading Scrivener's windows. Grant your MCP client (e.g. Claude) permission in System Settings > Privacy & Security > Automation, enable control of Scrivener, then try again. Meanwhile use discover_projects or open_project with a path.",
				{ supported: true, running: false, ...empty }
			);
		}
		if (!detection.running) {
			return reply(
				'Scrivener does not appear to be running. Open your project in Scrivener and try again, or use discover_projects.',
				{ supported: true, running: false, ...empty }
			);
		}
		if (detection.names.length === 0) {
			return reply(
				'Scrivener is running but no open project window was found. Open a project in Scrivener, or use discover_projects.',
				{ supported: true, running: true, ...empty }
			);
		}

		const home = os.homedir();
		const searchDirs = [
			path.join(home, 'Documents'),
			path.join(home, 'Desktop'),
			path.join(home, 'Library', 'Mobile Documents'),
		];
		const extra = getOptionalStringArg(args, 'searchPath');
		if (extra) searchDirs.push(extra);

		const projectPaths: string[] = [];
		for (const dir of searchDirs) {
			projectPaths.push(...(await findScrivProjects(dir, 3)));
		}

		const { resolved, unresolved } = resolveProjectNames(detection.names, projectPaths);
		const structured = {
			supported: true,
			running: true,
			openProjects: resolved,
			unresolved,
			count: resolved.length,
		};

		let text: string;
		if (resolved.length === 1 && unresolved.length === 0) {
			text = `You have "${resolved[0].name}" open in Scrivener:\n${resolved[0].path}\n\nCall open_project with this path to work on it.`;
		} else if (resolved.length > 1) {
			const list = resolved.map((p) => `• ${p.name} — ${p.path}`).join('\n');
			text = `You have ${resolved.length} projects open in Scrivener:\n${list}\n\nAsk the user which one, then call open_project with its path.`;
		} else {
			const list = detection.names.map((n) => `• ${n}`).join('\n');
			text = `Scrivener has these projects open, but none could be matched to a .scriv folder in the usual locations:\n${list}\n\nAsk the user for the full path and call open_project, or pass searchPath to widen the search.`;
		}
		if (resolved.length >= 1 && unresolved.length > 0) {
			text += `\n\n(Also open but unresolved: ${unresolved.join(', ')}.)`;
		}

		return { content: [{ type: 'text', text }], structuredContent: structured };
	},
};

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

export const listSnapshotsHandler: ToolDefinition = {
	name: 'list_snapshots',
	title: 'List Document Snapshots',
	description:
		"List the snapshots Scrivener has saved of a project's documents (from the .scriv " +
		"package's Snapshots/ directory). Pass documentId to list one document's snapshots, or " +
		'omit it to list snapshots for every document that has any. Each entry gives the owning ' +
		'document id and title, a snapshotId (pass it to read_snapshot to get the text), the ' +
		"snapshot's title, and its date. Read-only. Returns an empty list when nothing has been " +
		'snapshotted. Requires an open project (call open_project first).',
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
				description:
					'UUID of a single document to list snapshots for. Omit to list all documents.',
			},
		},
	},
	outputSchema: {
		type: 'object',
		properties: {
			documents: {
				type: 'array',
				description: 'One entry per document that has snapshots.',
				items: {
					type: 'object',
					properties: {
						documentId: { type: 'string', description: 'Document UUID.' },
						documentTitle: {
							type: 'string',
							description: 'Document title, if the document is still in the binder.',
						},
						snapshots: {
							type: 'array',
							items: {
								type: 'object',
								properties: {
									snapshotId: {
										type: 'string',
										description: 'Id to pass to read_snapshot.',
									},
									title: {
										type: 'string',
										description: 'Snapshot title ("" if none).',
									},
									date: { type: 'string', description: 'Snapshot date.' },
								},
							},
						},
					},
				},
			},
		},
		required: ['documents'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const documentId = getOptionalStringArg(args, 'documentId');
		const documents = await project.listSnapshots(documentId);
		return {
			content: [{ type: 'text', text: compact({ documents }) }],
			structuredContent: { documents },
		};
	},
};

export const readSnapshotHandler: ToolDefinition = {
	name: 'read_snapshot',
	title: 'Read Document Snapshot',
	description:
		'Return the text of a single document snapshot. Pass the documentId and the snapshotId from ' +
		"list_snapshots. The snapshot's RTF is converted to plain text. Read-only; does not alter the " +
		'document or restore the snapshot. Requires an open project (call open_project first).',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			documentId: { type: 'string', description: 'UUID of the document.' },
			snapshotId: {
				type: 'string',
				description: 'Snapshot id from list_snapshots.',
			},
		},
		required: ['documentId', 'snapshotId'],
	},
	outputSchema: {
		type: 'object',
		properties: {
			documentId: { type: 'string' },
			snapshotId: { type: 'string' },
			title: { type: 'string', description: 'Snapshot title ("" if none).' },
			date: { type: 'string', description: 'Snapshot date.' },
			text: { type: 'string', description: 'Snapshot content as plain text.' },
			wordCount: { type: 'number', description: 'Word count of the snapshot text.' },
		},
		required: ['documentId', 'snapshotId', 'text', 'wordCount'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const documentId = getStringArg(args, 'documentId');
		const snapshotId = getStringArg(args, 'snapshotId');
		const snapshot = await project.readSnapshot(documentId, snapshotId);
		return {
			content: [{ type: 'text', text: compact(snapshot) }],
			structuredContent: snapshot as unknown as Record<string, unknown>,
		};
	},
};

export const compareSnapshotHandler: ToolDefinition = {
	name: 'compare_snapshot',
	title: 'Compare Snapshot',
	description:
		'Compare a document snapshot against the current document text, or against another snapshot ' +
		'(pass againstSnapshotId). Returns the paragraphs added and removed and the net word-count ' +
		'change — use this to see what changed since a snapshot was taken. Read-only. Requires an open ' +
		'project (call open_project first). Get snapshot ids from list_snapshots.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			documentId: { type: 'string', description: 'UUID of the document.' },
			snapshotId: {
				type: 'string',
				description: 'The baseline snapshot id (from list_snapshots).',
			},
			againstSnapshotId: {
				type: 'string',
				description:
					'Optional second snapshot id to compare against. Omit to compare against the ' +
					'current document text.',
			},
		},
		required: ['documentId', 'snapshotId'],
	},
	outputSchema: {
		type: 'object',
		properties: {
			documentId: { type: 'string' },
			from: {
				type: 'object',
				description: 'The baseline snapshot.',
				properties: {
					snapshotId: { type: 'string' },
					title: { type: 'string' },
					date: { type: 'string' },
					wordCount: { type: 'number' },
				},
			},
			to: {
				type: 'object',
				description: 'What it was compared against ("current" or a snapshot id).',
				properties: {
					snapshotId: { type: 'string' },
					wordCount: { type: 'number' },
				},
			},
			wordDelta: {
				type: 'number',
				description: 'to.wordCount minus from.wordCount (negative means text was cut).',
			},
			wordsAdded: {
				type: 'number',
				description:
					'Words present in the compared-to text but not the snapshot (word-level).',
			},
			wordsRemoved: {
				type: 'number',
				description:
					'Words present in the snapshot but not the compared-to text (word-level).',
			},
			addedParagraphs: {
				type: 'array',
				items: { type: 'string' },
				description: 'Paragraphs present in the compared-to text but not the snapshot.',
			},
			removedParagraphs: {
				type: 'array',
				items: { type: 'string' },
				description: 'Paragraphs present in the snapshot but not the compared-to text.',
			},
			unchangedParagraphs: {
				type: 'number',
				description: 'Count of paragraphs common to both.',
			},
		},
		required: ['documentId', 'from', 'to', 'wordDelta', 'addedParagraphs', 'removedParagraphs'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const documentId = getStringArg(args, 'documentId');
		const snapshotId = getStringArg(args, 'snapshotId');
		const againstSnapshotId = getOptionalStringArg(args, 'againstSnapshotId');
		const comparison = await project.compareSnapshot(documentId, snapshotId, againstSnapshotId);
		return {
			content: [{ type: 'text', text: compact(comparison) }],
			structuredContent: comparison as unknown as Record<string, unknown>,
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
			title: { type: 'string' },
			author: { type: 'string' },
			words: {
				type: 'object',
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
				properties: {
					total: { type: 'number' },
					folders: { type: 'number' },
					textDocuments: { type: 'number' },
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
					id: { type: 'string' },
					title: { type: 'string' },
					wordCount: { type: 'number' },
				},
			},
			shortest: {
				type: 'object',
				description: 'Shortest text document by word count, or null.',
				properties: {
					id: { type: 'string' },
					title: { type: 'string' },
					wordCount: { type: 'number' },
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

export const projectHandlers = [
	openProjectHandler,
	getStructureHandler,
	refreshProjectHandler,
	closeProjectHandler,
	discoverProjectsHandler,
	detectOpenProjectHandler,
	getCompileSettingsHandler,
	getManuscriptBriefingHandler,
	listSnapshotsHandler,
	readSnapshotHandler,
	compareSnapshotHandler,
];
