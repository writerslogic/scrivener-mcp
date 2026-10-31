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
	minLength: 1,
	maxLength: 128,
	pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]*$',
};
const text = { type: 'string', maxLength: 16000 };
const name = {
	type: 'string',
	minLength: 1,
	maxLength: 2000,
	pattern: '^[^\\u0000]*[^\\s\\u0000][^\\u0000]*$',
};
const strings = { type: 'array', maxItems: 256, items: { type: 'string', maxLength: 2000 } };
const appearances = {
	type: 'array',
	maxItems: 1000,
	items: {
		type: 'object',
		additionalProperties: false,
		properties: { documentId: identifier, context: text },
		required: ['documentId', 'context'],
	},
};
const character = {
	id: identifier,
	name,
	role: { enum: ['protagonist', 'antagonist', 'supporting', 'minor'] },
	description: text,
	traits: strings,
	arc: text,
	notes: text,
	relationships: {
		type: 'array',
		maxItems: 256,
		items: {
			type: 'object',
			additionalProperties: false,
			properties: { characterId: identifier, relationship: name },
			required: ['characterId', 'relationship'],
		},
	},
	appearances,
};
const world = {
	id: identifier,
	name,
	type: { enum: ['location', 'object', 'concept', 'organization', 'theme'] },
	description: text,
	significance: text,
	appearances,
};
const plot = {
	id: identifier,
	name,
	description: text,
	status: { enum: ['setup', 'development', 'climax', 'resolution'] },
	documents: { type: 'array', maxItems: 1000, uniqueItems: true, items: identifier },
	keyEvents: {
		type: 'array',
		maxItems: 1000,
		items: {
			type: 'object',
			additionalProperties: false,
			properties: { documentId: identifier, event: text },
			required: ['documentId', 'event'],
		},
	},
};
const style = {
	tone: strings,
	voice: text,
	pov: { enum: ['first', 'second', 'third-limited', 'third-omniscient'] },
	tense: { enum: ['past', 'present', 'future'] },
	vocabularyLevel: { enum: ['simple', 'moderate', 'advanced', 'literary'] },
	sentenceComplexity: { enum: ['simple', 'varied', 'complex'] },
	paragraphLength: { enum: ['short', 'medium', 'long', 'varied'] },
	customGuidelines: strings,
	genre: name,
	audience: name,
	styleNotes: strings,
};
const recordSchema = (properties: Record<string, JSONValue>) => ({
	type: 'object',
	additionalProperties: false,
	properties,
	anyOf: [{ required: ['id'] }, { required: ['name'] }],
});
const dataSchemas = {
	characters: recordSchema(character),
	worldBuilding: recordSchema(world),
	plotThreads: recordSchema(plot),
	styleGuide: {
		type: 'object',
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
	properties: {},
	oneOf: MEMORY_TYPES.map((memoryType) => ({
		type: 'object',
		additionalProperties: false,
		properties: { memoryType: { const: memoryType }, data: dataSchemas[memoryType] },
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
