import { projectHandlers } from './project-handlers.js';
import { documentHandlers } from './document-handlers.js';
import { searchHandlers } from './search-handlers.js';
import { compilationHandlers } from './compilation-handlers.js';
import { analysisHandlers, memoryHandlers, semanticSearchHandler } from './analysis-handlers.js';
import { narrativeLensHandlers } from './narrative-lens-handlers.js';
import { bluepencilHandlers } from './bluepencil-handlers.js';
import { asyncHandlerDefinitions } from './async-handler-definitions.js';
import { nativeHHMTools } from './memory-handlers.js';
import { relationshipHandlers } from './relationship-handlers.js';
import { documentGraphHandlers } from './document-graph-handlers.js';
import { integrityHandlers } from './integrity-handlers.js';
import { goalsHandlers } from './goals-handlers.js';
import { personalizationHandlers } from './personalization-handlers.js';
import { reviewChangesHandler } from './review-handlers.js';
import { dashboardHandler } from './dashboard-handlers.js';
import { exportManuscriptHandler } from './export-preset-handlers.js';
import { storyHandlers, continuityHandlers } from './story-handlers.js';
import { localSearchHandlers } from './local-search-handlers.js';
import { workflowHandlers } from './workflow-handlers.js';
import { contentCredentialsHandlers } from './content-credentials-handlers.js';
import { readResultHandler } from './result-handlers.js';
import type { HandlerContext, HandlerResult, ToolDefinition } from './types.js';
import { HandlerError } from './types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType, JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation';

export interface Skill {
	name: string;
	description: string;
	tools: ToolDefinition[];
}

const skills: Skill[] = [
	{
		name: 'project',
		description: 'Open, browse, save, close, and verify Scrivener projects',
		tools: [...projectHandlers, ...integrityHandlers, dashboardHandler],
	},
	{
		name: 'documents',
		description: 'Read, write, create, delete, move, and rename documents',
		tools: [...documentHandlers, reviewChangesHandler],
	},
	{
		name: 'search',
		description: 'Full-text and semantic search, trash, annotations, mentions',
		tools: [...searchHandlers, semanticSearchHandler, ...localSearchHandlers],
	},
	{
		name: 'analysis',
		description:
			'Analyze writing quality, enhance prose, check consistency, track goals, tune writing preferences',
		tools: [
			...analysisHandlers,
			...narrativeLensHandlers,
			...bluepencilHandlers,
			...goalsHandlers,
			...personalizationHandlers,
			...continuityHandlers,
		],
	},
	{
		name: 'compilation',
		description: 'Compile manuscripts, export, statistics',
		tools: [...compilationHandlers, exportManuscriptHandler],
	},
	{
		name: 'credentials',
		description:
			'Inspect format coverage, sign local assets and validate C2PA Content Credentials',
		tools: contentCredentialsHandlers,
	},
	{
		name: 'memory',
		description: 'Store and recall persistent project facts (characters, world, plot, style)',
		tools: [...memoryHandlers, ...nativeHHMTools, ...storyHandlers],
	},
	{
		name: 'relationships',
		description: 'Entity relationships, character networks, story graph',
		tools: [...relationshipHandlers, ...documentGraphHandlers],
	},
	{
		name: 'advanced',
		description: 'Async job queue and batch operations',
		tools: [...asyncHandlerDefinitions, ...workflowHandlers],
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

const handlerMap = new Map<string, ToolDefinition>();
const activatedSkills = new Set<string>();
const schemaValidator = new AjvJsonSchemaValidator();
const validators = new WeakMap<object, JsonSchemaValidator<Record<string, unknown>>>();
let catalogRevision = 0;

function validatorFor(tool: ToolDefinition): JsonSchemaValidator<Record<string, unknown>> {
	let validator = validators.get(tool.inputSchema);
	if (!validator) {
		try {
			validator = schemaValidator.getValidator<Record<string, unknown>>(
				tool.inputSchema as unknown as JsonSchemaType
			);
		} catch (error) {
			throw new HandlerError(
				`Tool input schema could not be compiled: ${tool.name}`,
				'SCHEMA_ERROR',
				error
			);
		}
		validators.set(tool.inputSchema, validator);
	}
	return validator;
}

function callableTool(tool: ToolDefinition, uiSupported = false) {
	return {
		name: tool.name,
		description: tool.description,
		inputSchema: tool.inputSchema,
		...(tool.title ? { title: tool.title } : {}),
		...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
		...(tool.annotations ? { annotations: tool.annotations } : {}),
		...(uiSupported && tool._meta ? { _meta: tool._meta } : {}),
	};
}

const metaTools: ToolDefinition[] = [];

function buildMetaTools(): void {
	const listSkills: ToolDefinition = {
		name: 'list_skills',
		title: 'List Skills',
		description:
			'List the available skills (tool groups) — project, documents, search, analysis, ' +
			'compilation, credentials, memory, relationships, advanced — with a description, the tool count, whether the skill ' +
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
			'tools appear automatically. Call list_skills first to see the available skill names. ' +
			'Tools activate when requested; already active skills return the same complete schemas.',
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
		handler: async (args, context): Promise<HandlerResult> => {
			const name = args.name as string;
			const skill = skills.find((s) => s.name === name);
			if (!skill) {
				return {
					isError: true,
					content: [
						{
							type: 'text',
							text: `Unknown skill: ${name}. Call list_skills to see available skills.`,
						},
					],
				};
			}
			const visible = visibleTools(skill);
			const activated = activateSkill(name);
			const tools = visible.map((tool) => callableTool(tool, context.uiSupported));
			return {
				structuredContent: { skill: name, activated, tools },
				content: [
					{
						type: 'text',
						text: `${activated ? 'Activated' : 'Already active'} "${name}" (${visible.length} tools). Callable tool schemas:\n${JSON.stringify(tools, null, 2)}`,
					},
				],
			};
		},
	};

	const tools = [listSkills, useSkill, readResultHandler];
	for (const tool of tools) validatorFor(tool);
	metaTools.push(...tools);
	for (const tool of tools) handlerMap.set(tool.name, tool);
}

/**
 * Activate a skill, registering its tools in the handler map.
 * Returns true if new tools were added.
 */
export function activateSkill(name: string): boolean {
	if (activatedSkills.has(name)) return false;
	const skill = skills.find((s) => s.name === name);
	if (!skill) return false;

	const tools = visibleTools(skill);
	for (const tool of tools) validatorFor(tool);
	let changed = false;
	for (const tool of tools) {
		if (handlerMap.get(tool.name) !== tool) changed = true;
		handlerMap.set(tool.name, tool);
	}
	activatedSkills.add(name);
	if (changed) catalogRevision++;
	return changed;
}

/**
 * Activate the skill that owns `toolName` if it is not dispatchable yet.
 * Returns true when a skill was newly activated (the caller should then emit
 * tools/list_changed). Hidden and genuinely-unknown tools are left alone — a
 * stray call must not make an unadvertised tool dispatchable.
 */
export function activateSkillForTool(toolName: string): boolean {
	if (handlerMap.has(toolName)) return false;
	for (const skill of skills) {
		if (visibleTools(skill).some((t) => t.name === toolName)) {
			return activateSkill(skill.name);
		}
	}
	return false;
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

export function isSkillActive(name: string): boolean {
	return activatedSkills.has(name);
}

export function initializeSkillRegistry(): void {
	if (handlerMap.size) catalogRevision++;
	handlerMap.clear();
	activatedSkills.clear();
	if (!metaTools.length) buildMetaTools();
	else for (const tool of metaTools) handlerMap.set(tool.name, tool);
	activateSkill('project');
	if (process.env.SCRIVENER_MCP_EAGER_TOOLS === '1') {
		for (const s of skills) activateSkill(s.name);
	}
}

export function getRegisteredTools(uiSupported = false) {
	const seen = new Set<string>();
	return [...metaTools, ...skills.flatMap(visibleTools)]
		.filter((tool) => {
			if (!handlerMap.has(tool.name) || seen.has(tool.name)) return false;
			seen.add(tool.name);
			return true;
		})
		.map((tool) => callableTool(handlerMap.get(tool.name)!, uiSupported));
}

export function getToolCatalogRevision(): number {
	return catalogRevision;
}

/**
 * Execute a tool handler by name.
 */
export async function executeRegisteredHandler(
	toolName: string,
	args: Record<string, unknown>,
	context: HandlerContext
): Promise<HandlerResult> {
	validateRegisteredArgs(toolName, args);
	const handler = handlerMap.get(toolName)!;

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

export function validateRegisteredArgs(toolName: string, args: Record<string, unknown>): void {
	activateSkillForTool(toolName);
	const handler = handlerMap.get(toolName);
	if (!handler) {
		throw new HandlerError(`Unknown tool: ${toolName}`, 'UNKNOWN_TOOL');
	}

	const result = validatorFor(handler)(args);
	if (!result.valid)
		throw new HandlerError(
			`Invalid arguments for ${toolName}: ${result.errorMessage.slice(0, 1000)}`,
			'INVALID_ARGUMENT'
		);
}
