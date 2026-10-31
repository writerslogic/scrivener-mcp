import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation/types';
import { cloneHMSMetadata } from './hhm/document-index.js';
import type { CharacterProfile, PlotThread, WorldElement } from '../../memory-manager.js';
import type { JSONValue } from '../../types/index.js';

export const MAX_PROJECT_MEMORY_BYTES = 16 * 1024 * 1024;

export const MEMORY_TYPES = [
	'characters',
	'worldBuilding',
	'plotThreads',
	'styleGuide',
	'all',
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];
export type MemoryInput = { memoryType: MemoryType; data: Record<string, unknown> };

const identifier = {
	type: 'string',
	description: 'Project-local record or document identifier.',
	minLength: 1,
	maxLength: 128,
	pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]*$',
};
const text = { type: 'string', maxLength: 16000 };
const name = {
	type: 'string',
	description: 'Author-supplied nonblank name.',
	minLength: 1,
	maxLength: 2000,
	pattern: '^[^\\u0000]*[^\\s\\u0000][^\\u0000]*$',
};
const strings = { type: 'array', maxItems: 256, items: { type: 'string', maxLength: 2000 } };
const appearances = {
	type: 'array',
	description: 'Recorded document appearances with author-supplied context.',
	maxItems: 1000,
	items: {
		type: 'object',
		additionalProperties: false,
		properties: {
			documentId: {
				...identifier,
				description: 'Identifier of the document containing this appearance.',
			},
			context: {
				...text,
				description: 'Author-supplied context for the appearance in this document.',
			},
		},
		required: ['documentId', 'context'],
	},
};
const character = {
	id: {
		...identifier,
		description: 'Existing character ID to update; omit to create a record with a name.',
	},
	name,
	role: {
		enum: ['protagonist', 'antagonist', 'supporting', 'minor'],
		description: 'Character’s role in the story.',
	},
	description: { ...text, description: 'Recorded description of the character.' },
	traits: { ...strings, description: 'Recorded character traits.' },
	arc: { ...text, description: 'Planned or observed character development.' },
	notes: { ...text, description: 'Additional author notes about the character.' },
	relationships: {
		type: 'array',
		description: 'Author-recorded links to other character records.',
		maxItems: 256,
		items: {
			type: 'object',
			additionalProperties: false,
			properties: {
				characterId: {
					...identifier,
					description: 'Identifier of the related character record.',
				},
				relationship: {
					...name,
					description: 'Author-supplied description of the character relationship.',
				},
			},
			required: ['characterId', 'relationship'],
		},
	},
	appearances,
};
const world = {
	id: {
		...identifier,
		description:
			'Existing world-building record ID to update; omit to create a record with a name.',
	},
	name,
	type: {
		enum: ['location', 'object', 'concept', 'organization', 'theme'],
		description: 'Category of the world-building element.',
	},
	description: { ...text, description: 'Recorded description of the world-building element.' },
	significance: {
		...text,
		description: 'Author-recorded importance of this element to the story.',
	},
	appearances,
};
const plot = {
	id: {
		...identifier,
		description: 'Existing plot-thread ID to update; omit to create a record with a name.',
	},
	name,
	description: { ...text, description: 'Recorded description of the plot thread.' },
	status: {
		enum: ['setup', 'development', 'climax', 'resolution'],
		description: 'Current narrative stage of the plot thread.',
	},
	documents: {
		type: 'array',
		maxItems: 1000,
		uniqueItems: true,
		items: identifier,
		description: 'Unique document identifiers associated with this plot thread.',
	},
	keyEvents: {
		type: 'array',
		description: 'Recorded plot events and their associated documents.',
		maxItems: 1000,
		items: {
			type: 'object',
			additionalProperties: false,
			properties: {
				documentId: {
					...identifier,
					description: 'Identifier of the document containing the event.',
				},
				event: { ...text, description: 'Author-supplied description of the plot event.' },
			},
			required: ['documentId', 'event'],
		},
	},
};
const style = {
	tone: { ...strings, description: 'Desired tonal qualities for the project.' },
	voice: { ...text, description: 'Author-supplied description of the desired narrative voice.' },
	pov: {
		enum: ['first', 'second', 'third-limited', 'third-omniscient'],
		description: 'Preferred narrative point of view.',
	},
	tense: { enum: ['past', 'present', 'future'], description: 'Preferred narrative tense.' },
	vocabularyLevel: {
		enum: ['simple', 'moderate', 'advanced', 'literary'],
		description: 'Preferred vocabulary level.',
	},
	sentenceComplexity: {
		enum: ['simple', 'varied', 'complex'],
		description: 'Preferred sentence complexity.',
	},
	paragraphLength: {
		enum: ['short', 'medium', 'long', 'varied'],
		description: 'Preferred paragraph length pattern.',
	},
	customGuidelines: { ...strings, description: 'Additional author-supplied writing guidelines.' },
	genre: { ...name, description: 'Intended genre for the project.' },
	audience: { ...name, description: 'Intended readership for the project.' },
	styleNotes: { ...strings, description: 'Additional notes about the project’s writing style.' },
};
const recordSchema = (properties: Record<string, JSONValue>, description: string) => ({
	type: 'object',
	description,
	additionalProperties: false,
	properties,
	anyOf: [{ required: ['id'] }, { required: ['name'] }],
});
const dataSchemas = {
	characters: recordSchema(
		character,
		'Character fields to create or patch. Supply a name for creation or an existing id for an update.'
	),
	worldBuilding: recordSchema(
		world,
		'World-building fields to create or patch. Supply a name for creation or an existing id for an update.'
	),
	plotThreads: recordSchema(
		plot,
		'Plot-thread fields to create or patch. Supply a name for creation or an existing id for an update.'
	),
	styleGuide: {
		type: 'object',
		description:
			'Nonempty style-guide patch; supplied fields replace values by key and omitted fields remain unchanged.',
		additionalProperties: false,
		properties: style,
		minProperties: 1,
	},
	all: {
		type: 'object',
		additionalProperties: true,
		maxProperties: 256,
		description:
			'Custom JSON context merged by key. The complete request is bounded at 64 KiB, depth 32 and 32768 nodes.',
	},
};

export const MEMORY_INPUT_SCHEMA = {
	type: 'object' as const,
	properties: {
		memoryType: {
			enum: [...MEMORY_TYPES],
			description: 'Category to update; all merges the supplied data into customContext.',
		},
		data: {
			type: 'object',
			description: 'Record fields or context patch matching the selected memoryType variant.',
		},
	},
	oneOf: MEMORY_TYPES.map((memoryType) => ({
		type: 'object',
		additionalProperties: false,
		properties: {
			memoryType: {
				const: memoryType,
				description: 'Category selected for this memory update variant.',
			},
			data: dataSchemas[memoryType],
		},
		required: ['memoryType', 'data'],
	})),
};

const validator = new AjvJsonSchemaValidator();
const validateInput = validator.getValidator(MEMORY_INPUT_SCHEMA as JsonSchemaType);
export function memoryInput(value: unknown): MemoryInput {
	const snapshot = cloneHMSMetadata(value);
	if (!validateInput(snapshot).valid)
		throw new Error(
			'Invalid memory fields; use the remember schema for the selected memoryType'
		);
	return snapshot as MemoryInput;
}

export function memoryType(value: unknown): MemoryType {
	if (value === undefined) return 'all';
	if (!MEMORY_TYPES.includes(value as MemoryType)) throw new Error('Unsupported memoryType');
	return value as MemoryType;
}

export type MemoryRecord = CharacterProfile | WorldElement | PlotThread;
