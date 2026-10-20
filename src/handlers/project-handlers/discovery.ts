import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectOpenScrivenerProjects, resolveProjectNames } from '../../utils/scrivener-app.js';
import type { HandlerResult, ToolDefinition } from '../types.js';
import { getOptionalStringArg } from '../types.js';

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
