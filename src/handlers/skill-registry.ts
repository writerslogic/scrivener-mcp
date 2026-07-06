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
import { analysisHandlers, memoryHandlers, semanticSearchHandler } from './analysis-handlers.js';
import { asyncHandlerDefinitions } from './async-handler-definitions.js';
import { nativeHHMTools } from './memory-handlers.js';
import { relationshipHandlers } from './relationship-handlers.js';
import { documentGraphHandlers } from './document-graph-handlers.js';
import { integrityHandlers } from './integrity-handlers.js';
import { goalsHandlers } from './goals-handlers.js';
import { personalizationHandlers } from './personalization-handlers.js';
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
		description: 'Open, browse, save, close, and verify Scrivener projects',
		tools: [...projectHandlers, ...integrityHandlers],
	},
	{
		name: 'documents',
		description: 'Read, write, create, delete, move, and rename documents',
		tools: documentHandlers,
	},
	{
		name: 'search',
		description: 'Full-text and semantic search, trash, annotations, mentions',
		tools: [...searchHandlers, semanticSearchHandler],
	},
	{
		name: 'analysis',
		description:
			'Analyze writing quality, enhance prose, check consistency, track goals, tune writing preferences',
		tools: [...analysisHandlers, ...goalsHandlers, ...personalizationHandlers],
	},
	{
		name: 'compilation',
		description: 'Compile manuscripts, export, statistics',
		tools: compilationHandlers,
	},
	{
		name: 'memory',
		description: 'Store and recall persistent project facts (characters, world, plot, style)',
		tools: [...memoryHandlers, ...nativeHHMTools],
	},
	{
		name: 'relationships',
		description: 'Entity relationships, character networks, story graph',
		tools: [...relationshipHandlers, ...documentGraphHandlers],
	},
	{
		name: 'advanced',
		description: 'Async job queue and batch operations',
		tools: [...asyncHandlerDefinitions],
	},
];

// Tools kept out of the public surface: internal plumbing, experimental
// features, or capabilities now folded into a consolidated tool. Their handlers
// stay available for internal callers; they are simply not advertised or
// dispatchable as MCP tools.
const HIDDEN_TOOLS = new Set<string>([
	'find_analogies',
	'build_vector_store',
	'multi_agent_analysis',
	'hhm_dream',
	'store_chapter_order',
	'sync_to_neo4j',
	'get_queue_stats',
]);

function visibleTools(skill: Skill): ToolDefinition[] {
	return skill.tools.filter((t) => !HIDDEN_TOOLS.has(t.name));
}

// Handler map for dispatch
const handlerMap = new Map<string, ToolDefinition>();
const activatedSkills = new Set<string>();

// Meta-tools are always registered
const metaTools: ToolDefinition[] = [];

function buildMetaTools(): void {
	const listSkills: ToolDefinition = {
		name: 'list_skills',
		title: 'List Skills',
		description:
			'List the available skills (tool groups) — project, documents, search, analysis, ' +
			'compilation, memory, relationships — with a description, the tool count, whether the skill ' +
			'is already active, and its tool names. Use this to discover capabilities, then call ' +
			'use_skill to activate a group whose tools you need. Takes no parameters.',
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			type: 'object',
			properties: {},
			required: [],
		},
		outputSchema: {
			type: 'object',
			properties: {
				skills: {
					type: 'array',
					description: 'The available skills (tool groups).',
					items: {
						type: 'object',
						properties: {
							name: {
								type: 'string',
								description: 'Skill identifier passed to use_skill.',
							},
							description: { type: 'string', description: 'What the skill covers.' },
							tools: {
								type: 'number',
								description: 'Number of visible tools in the skill.',
							},
							activated: {
								type: 'boolean',
								description: 'Whether the skill is already active this session.',
							},
							tool_names: {
								type: 'array',
								description: 'Names of the visible tools in the skill.',
								items: { type: 'string' },
							},
						},
					},
				},
			},
			required: ['skills'],
		},
		handler: async (): Promise<HandlerResult> => {
			const index = skills.map((s) => {
				const visible = visibleTools(s);
				return {
					name: s.name,
					description: s.description,
					tools: visible.length,
					activated: activatedSkills.has(s.name),
					tool_names: visible.map((t) => t.name),
				};
			});
			return {
				content: [{ type: 'text', text: JSON.stringify(index, null, 2) }],
				structuredContent: { skills: index },
			};
		},
	};

	const useSkill: ToolDefinition = {
		name: 'use_skill',
		title: 'Activate Skill',
		description:
			"Activate a skill so its tools become available to call. Returns the activated skill's tool " +
			'names and their schemas; clients that support tools/list_changed will also see the new ' +
			'tools appear automatically. Call list_skills first to see the available skill names. Tools ' +
			'are progressively disclosed, so activate the skill you need before using its tools (most ' +
			'tools are pre-activated by default).',
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: {
			type: 'object',
			properties: {
				name: {
					type: 'string',
					description:
						'The skill to activate, e.g. "documents", "search", or "analysis". Get valid ' +
						'names from list_skills.',
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
			const visible = visibleTools(skill);
			if (activatedSkills.has(name)) {
				return {
					content: [
						{
							type: 'text',
							text: `Skill "${name}" already active. Tools: ${visible.map((t) => t.name).join(', ')}`,
						},
					],
				};
			}
			activateSkill(name);
			const toolSummary = visible
				.map((t) => {
					const required = (t.inputSchema.required as string[] | undefined) ?? [];
					const props = t.inputSchema.properties as
						Record<string, { type?: string; description?: string }> | undefined;
					const params = props
						? Object.entries(props)
								.map(
									([k, v]) =>
										`${k}${required.includes(k) ? '*' : ''} (${v.type ?? 'any'}): ${v.description ?? ''}`
								)
								.join('; ')
						: 'no parameters';
					return `• ${t.name}: ${t.description}\n  params: ${params}`;
				})
				.join('\n');
			return {
				content: [
					{
						type: 'text',
						text: `Activated "${name}" (${visible.length} tools). If your client does not auto-refresh the tool list, call these tools directly using the schemas below:\n\n${toolSummary}`,
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

	for (const tool of visibleTools(skill)) {
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
	// Progressive by default: only the project group + meta-tools register at startup
	// (~300 tokens). The rest activate on demand — documents/search on open_project,
	// others via use_skill — so interactive clients pay only for tools they use.
	// Opt into eager registration (full set at startup, for registries/inspectors and
	// clients that ignore notifications/tools/list_changed) with SCRIVENER_MCP_EAGER_TOOLS=1.
	if (process.env.SCRIVENER_MCP_EAGER_TOOLS === '1') {
		for (const s of skills) activateSkill(s.name);
	}
}

/**
 * Get all currently registered tool definitions.
 */
export function getRegisteredTools() {
	return Array.from(handlerMap.values()).map((h) => {
		const tool: {
			name: string;
			title?: string;
			description: string;
			inputSchema: ToolDefinition['inputSchema'];
			outputSchema?: ToolDefinition['outputSchema'];
			annotations?: ToolDefinition['annotations'];
		} = {
			name: h.name,
			description: h.description,
			inputSchema: h.inputSchema,
		};
		if (h.title) tool.title = h.title;
		if (h.outputSchema) tool.outputSchema = h.outputSchema;
		if (h.annotations) tool.annotations = h.annotations;
		return tool;
	});
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
