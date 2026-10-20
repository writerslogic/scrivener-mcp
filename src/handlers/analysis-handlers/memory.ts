import { createError, ErrorCode } from '../../core/errors.js';
import type {
	CharacterProfile,
	PlotThread,
	ProjectMemory,
	StyleGuide,
} from '../../memory-manager.js';
import { validateInput } from '../../utils/common.js';
import { compact } from '../../core/response-formatter.js';
import type { HandlerResult, ToolDefinition } from '../types.js';
import { getObjectArg, getStringArg, requireMemoryManager } from '../types.js';
import { memorySchema } from '../validation-schemas.js';

export const updateMemoryHandler: ToolDefinition = {
	name: 'remember',
	title: 'Remember Project Facts',
	description:
		"Store or update a fact in the project's persistent memory so later tools and sessions stay " +
		'consistent: a character profile, world-building detail, plot thread, or style-guide entry. ' +
		'Pass an id inside data to update an existing entry, or omit it to add a new one. Use recall ' +
		'to read memory back. Requires an open project.',
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			memoryType: {
				type: 'string',
				enum: ['characters', 'worldBuilding', 'plotThreads', 'styleGuide', 'all'],
				description:
					'Which memory store to write to: "characters", "worldBuilding", "plotThreads", ' +
					'"styleGuide", or "all" for arbitrary custom context.',
			},
			data: {
				type: 'object',
				description:
					'The entry to store. Include an "id" field to update an existing entry; omit it to ' +
					'create a new one.',
			},
		},
		required: ['memoryType', 'data'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const memoryManager = requireMemoryManager(context);
		validateInput(args, memorySchema);

		// Update memory based on type
		const memoryType = getStringArg(args, 'memoryType');
		const data = getObjectArg(args, 'data') as Record<string, unknown>;

		switch (memoryType) {
			case 'characters':
				if (data.id) {
					await memoryManager.updateCharacter(data.id as string, data);
				} else {
					await memoryManager.addCharacter(data as Omit<CharacterProfile, 'id'>);
				}
				break;
			case 'plotThreads':
				if (data.id) {
					await memoryManager.updatePlotThread(data.id as string, data);
				} else {
					await memoryManager.addPlotThread(data as Omit<PlotThread, 'id'>);
				}
				break;
			case 'styleGuide':
				await memoryManager.updateStyleGuide(data as Partial<StyleGuide>);
				break;
			case 'worldBuilding':
			case 'all':
				for (const [key, value] of Object.entries(data)) {
					await memoryManager.setCustomContext(key, value);
				}
				break;
			default:
				throw createError(ErrorCode.INVALID_INPUT, `Unknown memory type: ${memoryType}`);
		}

		return {
			content: [
				{
					type: 'text',
					text: `${memoryType} memory updated`,
				},
			],
		};
	},
};

export const getMemoryHandler: ToolDefinition = {
	name: 'recall',
	title: 'Recall Project Facts',
	description:
		"Read back the project's persistent memory: stored characters, world-building, plot threads, " +
		'and style guide. Returns the requested store, or the full memory when memoryType is omitted ' +
		'or "all". Use remember to write new facts. Requires an open project.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			memoryType: {
				type: 'string',
				enum: ['characters', 'worldBuilding', 'plotThreads', 'styleGuide', 'all'],
				description:
					'Which memory store to read. Omit or use "all" to return the full project memory.',
			},
		},
	},
	outputSchema: {
		type: 'object',
		properties: {
			memory: {
				description:
					'The requested memory store. For "all" (or omitted) this is the full project ' +
					'memory object (characters, worldBuilding, plotThreads, styleGuide, and more); ' +
					'for a specific memoryType it is that store: an array for characters and ' +
					'plotThreads, an object for styleGuide and worldBuilding.',
			},
		},
		required: ['memory'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const memoryManager = requireMemoryManager(context);

		let memory: ProjectMemory | CharacterProfile[] | PlotThread[] | StyleGuide | unknown;
		if (!args.memoryType || args.memoryType === 'all') {
			memory = memoryManager.getFullMemory();
		} else {
			switch (args.memoryType) {
				case 'characters':
					memory = await memoryManager.getAllCharacters();
					break;
				case 'plotThreads':
					memory = await memoryManager.getPlotThreads();
					break;
				case 'styleGuide':
					memory = await memoryManager.getStyleGuide();
					break;
				case 'worldBuilding':
					memory = await memoryManager.getCustomContext('worldBuilding');
					break;
				default:
					memory = null;
			}
		}

		return {
			content: [
				{
					type: 'text',
					text: compact(memory),
				},
			],
			structuredContent: { memory },
		};
	},
};
