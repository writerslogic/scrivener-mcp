/**
 * Skill-based progressive tool registration.
 *
 * Tools are grouped into skills. Only meta-tools (list_skills, use_skill)
 * and open_project are registered at startup. Skills are hydrated on demand
 * via use_skill, which registers the skill's tools and notifies the client.
 */

import { projectHandlers } from './project-handlers.js';
import { documentHandlers } from './document-handlers.js';
import { searchHandlers } from './search-handlers.js';
import { compilationHandlers } from './compilation-handlers.js';
import { analysisHandlers } from './analysis-handlers.js';
import { asyncHandlerDefinitions } from './async-handler-definitions.js';
import { fractalMemoryTools } from './fractal-memory-handlers.js';
import { nativeHHMTools } from './memory-handlers.js';
import type { HandlerContext, HandlerResult, ToolDefinition } from './types.js';
import { HandlerError } from './types.js';

export interface Skill {
	name: string;
	description: string;
	tools: ToolDefinition[];
}

const skills: Skill[] = [
	{
		name: 'project',
		description: 'Open, browse, save, and close Scrivener projects',
		tools: projectHandlers,
	},
	{
		name: 'documents',
		description: 'Read, write, create, delete, move, and rename documents',
		tools: documentHandlers,
	},
	{
		name: 'search',
		description: 'Full-text search, trash, annotations, mentions',
		tools: searchHandlers,
	},
	{
		name: 'analysis',
		description: 'Analyze writing quality, enhance prose, check consistency',
		tools: analysisHandlers,
	},
	{
		name: 'compilation',
		description: 'Compile manuscripts, export, statistics',
		tools: compilationHandlers,
	},
	{
		name: 'memory',
		description: 'Semantic search, analogies, and creative recombination via HMS',
		tools: nativeHHMTools,
	},
	{
		name: 'advanced',
		description: 'Fractal memory, async job queue, batch operations',
		tools: [...asyncHandlerDefinitions, ...fractalMemoryTools],
	},
];

// Handler map for dispatch
const handlerMap = new Map<string, ToolDefinition>();
const activatedSkills = new Set<string>();

// Meta-tools are always registered
const metaTools: ToolDefinition[] = [];

function buildMetaTools(): void {
	const listSkills: ToolDefinition = {
		name: 'list_skills',
		description: 'List available tool groups and their contents',
		inputSchema: {
			type: 'object',
			properties: {},
			required: [],
		},
		handler: async (): Promise<HandlerResult> => {
			const index = skills.map((s) => ({
				name: s.name,
				description: s.description,
				tools: s.tools.length,
				activated: activatedSkills.has(s.name),
				tool_names: s.tools.map((t) => t.name),
			}));
			return {
				content: [{ type: 'text', text: JSON.stringify(index, null, 2) }],
			};
		},
	};

	const useSkill: ToolDefinition = {
		name: 'use_skill',
		description: 'Activate a skill to register its tools',
		inputSchema: {
			type: 'object',
			properties: {
				name: {
					type: 'string',
					description: 'Skill name from list_skills',
				},
			},
			required: ['name'],
		},
		handler: async (args): Promise<HandlerResult> => {
			const name = args.name as string;
			const skill = skills.find((s) => s.name === name);
			if (!skill) {
				return {
					content: [
						{
							type: 'text',
							text: `Unknown skill: ${name}. Call list_skills to see available skills.`,
						},
					],
				};
			}
			if (activatedSkills.has(name)) {
				return {
					content: [
						{
							type: 'text',
							text: `Skill "${name}" already active. Tools: ${skill.tools.map((t) => t.name).join(', ')}`,
						},
					],
				};
			}
			activateSkill(name);
			return {
				content: [
					{
						type: 'text',
						text: `Activated "${name}". ${skill.tools.length} tools now available: ${skill.tools.map((t) => t.name).join(', ')}`,
					},
				],
			};
		},
	};

	metaTools.push(listSkills, useSkill);
	handlerMap.set('list_skills', listSkills);
	handlerMap.set('use_skill', useSkill);
}

/**
 * Activate a skill, registering its tools in the handler map.
 * Returns true if new tools were added.
 */
export function activateSkill(name: string): boolean {
	if (activatedSkills.has(name)) return false;
	const skill = skills.find((s) => s.name === name);
	if (!skill) return false;

	for (const tool of skill.tools) {
		handlerMap.set(tool.name, tool);
	}
	activatedSkills.add(name);
	return true;
}

/**
 * Activate multiple skills at once.
 */
export function activateSkills(...names: string[]): boolean {
	let changed = false;
	for (const name of names) {
		if (activateSkill(name)) changed = true;
	}
	return changed;
}

/**
 * Check if a skill is activated.
 */
export function isSkillActive(name: string): boolean {
	return activatedSkills.has(name);
}

/**
 * Initialize the registry. Call once at startup.
 */
export function initializeSkillRegistry(): void {
	buildMetaTools();
	// Always activate project skill (need open_project at minimum)
	activateSkill('project');
}

/**
 * Get all currently registered tool definitions.
 */
export function getRegisteredTools() {
	return Array.from(handlerMap.values()).map((h) => ({
		name: h.name,
		description: h.description,
		inputSchema: h.inputSchema,
	}));
}

/**
 * Execute a tool handler by name.
 */
export async function executeRegisteredHandler(
	toolName: string,
	args: Record<string, unknown>,
	context: HandlerContext
): Promise<HandlerResult> {
	const handler = handlerMap.get(toolName);

	if (!handler) {
		throw new HandlerError(
			`Unknown tool: ${toolName}. Call list_skills and use_skill to activate tool groups.`,
			'UNKNOWN_TOOL'
		);
	}

	try {
		return await handler.handler(args, context);
	} catch (error) {
		if (error instanceof HandlerError) {
			throw error;
		}
		throw new HandlerError(
			`Handler failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
			'HANDLER_ERROR',
			error
		);
	}
}

/**
 * Validate handler arguments.
 */
export function validateRegisteredArgs(toolName: string, args: Record<string, unknown>): void {
	const handler = handlerMap.get(toolName);
	if (!handler) {
		throw new HandlerError(`Unknown tool: ${toolName}`, 'UNKNOWN_TOOL');
	}

	const required = handler.inputSchema.required || [];
	for (const prop of required) {
		if (!(prop in args) || args[prop] === undefined) {
			throw new HandlerError(`Missing required argument: ${prop}`, 'MISSING_ARGUMENT');
		}
	}
}
