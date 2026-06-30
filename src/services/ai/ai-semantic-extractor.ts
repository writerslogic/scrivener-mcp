/**
 * Entity/relationship extraction and template generation backed by the
 * direct-SDK AIClient (Claude default). Replaces the AdvancedLangChainFeatures
 * and EnhancedLangChainService methods the semantic layer depends on.
 */

import { AIClient } from './ai-client.js';
import { getLogger } from '../../core/logger.js';
import { parseModelJson } from '../../utils/json-parse.js';
import { clip, untrustedBlock } from '../../utils/prompt-input.js';

const logger = getLogger('ai-semantic-extractor');

export type EntityType = 'character' | 'location' | 'organization' | 'event' | 'object';

export interface ExtractedEntity {
	name: string;
	type: EntityType;
	context: string;
	mentions: number;
}

export interface ExtractedRelationship {
	entity1: string;
	entity2: string;
	relationship: string;
	strength: number;
	type: 'character' | 'location' | 'object' | 'event';
}

const ENTITY_TYPES: EntityType[] = ['character', 'location', 'organization', 'event', 'object'];

function clamp01(value: unknown): number {
	const n = typeof value === 'number' ? value : Number(value);
	if (Number.isNaN(n)) return 0.5;
	return Math.min(1, Math.max(0, n));
}

export class AISemanticExtractor {
	private readonly ai: AIClient;

	constructor(ai: AIClient = new AIClient()) {
		this.ai = ai;
	}

	async extractEntities(text: string): Promise<ExtractedEntity[]> {
		const passage = text.trim();
		if (!passage) return [];

		const bounded = clip(passage, 12000, logger, 'extractEntities passage');
		const prompt =
			'Extract the named entities from the passage. For each, give name, type (one of ' +
			'character, location, organization, event, object), a short context phrase, and an ' +
			'integer mention count. Return a JSON array: ' +
			'[{"name":"...","type":"character","context":"...","mentions":1}]\n\n' +
			`Passage:\n${untrustedBlock(bounded)}`;

		const raw = await this.ai.chat(prompt, {
			system: 'You are an information-extraction engine. Respond with STRICT JSON only.',
			temperature: 0.1,
			maxTokens: 1500,
		});
		const parsed = parseModelJson(raw, logger);
		if (!Array.isArray(parsed)) return [];

		const entities = parsed
			.map((item): ExtractedEntity | null => {
				if (!item || typeof item !== 'object') return null;
				const obj = item as Record<string, unknown>;
				const name = typeof obj.name === 'string' ? obj.name.trim() : '';
				if (!name) return null;
				const rawType = typeof obj.type === 'string' ? obj.type.toLowerCase() : '';
				const type = (ENTITY_TYPES as string[]).includes(rawType)
					? (rawType as EntityType)
					: 'object';
				const mentions =
					typeof obj.mentions === 'number' && obj.mentions > 0
						? Math.floor(obj.mentions)
						: 1;
				const context = typeof obj.context === 'string' ? obj.context : '';
				return { name, type, context, mentions };
			})
			.filter((e): e is ExtractedEntity => e !== null);

		logger.debug('Entity extraction complete', {
			provider: this.ai.provider ?? 'none',
			count: entities.length,
		});
		return entities;
	}

	async analyzeRelationships(
		entities: ExtractedEntity[],
		sourceText?: string
	): Promise<ExtractedRelationship[]> {
		if (entities.length < 2) return [];
		// Prefer the actual source passage; fall back to the first entity's context
		// phrase only when no passage is supplied. Inferring links from names alone
		// loses the very text that establishes them.
		const context = (sourceText?.trim() || entities[0]?.context || '').slice(0, 4000);
		const names = entities.map((e) => e.name).join(', ');

		const prompt =
			`Given these entities: ${names}\n\nand this context:\n${context}\n\n` +
			'Identify the relationships between pairs of entities. Return a JSON array: ' +
			'[{"entity1":"...","entity2":"...","relationship":"describes the link","strength":0.8,' +
			'"type":"character"}] where strength is 0-1 and type is one of character, location, ' +
			'object, event.';

		const raw = await this.ai.chat(prompt, {
			system: 'You are an information-extraction engine. Respond with STRICT JSON only.',
			temperature: 0.1,
			maxTokens: 1500,
		});
		const parsed = parseModelJson(raw, logger);
		if (!Array.isArray(parsed)) return [];

		return parsed
			.map((item): ExtractedRelationship | null => {
				if (!item || typeof item !== 'object') return null;
				const obj = item as Record<string, unknown>;
				const entity1 = typeof obj.entity1 === 'string' ? obj.entity1 : '';
				const entity2 = typeof obj.entity2 === 'string' ? obj.entity2 : '';
				const relationship = typeof obj.relationship === 'string' ? obj.relationship : '';
				if (!entity1 || !entity2 || !relationship) return null;
				const rawType = typeof obj.type === 'string' ? obj.type.toLowerCase() : 'character';
				const type = (['character', 'location', 'object', 'event'] as string[]).includes(
					rawType
				)
					? (rawType as ExtractedRelationship['type'])
					: 'character';
				return { entity1, entity2, relationship, strength: clamp01(obj.strength), type };
			})
			.filter((r): r is ExtractedRelationship => r !== null);
	}

	/**
	 * Lean replacement for generateWithTemplate: run the caller's prompt
	 * (customPrompt when provided) through the model and return its text.
	 */
	async generateWithTemplate(
		_taskType: string,
		prompt: string,
		// Only customPrompt and format are read; the index signature lets callers
		// pass extra task hints (style, genre, maxLength, ...) without a type error.
		options: { customPrompt?: string; format?: string; [key: string]: unknown } = {}
	): Promise<{ content: string }> {
		const effectivePrompt = options.customPrompt ?? prompt;
		const system =
			options.format === 'json'
				? 'Respond with STRICT JSON only -- no prose, no markdown code fences.'
				: 'You are a precise writing analyst.';
		const content = await this.ai.chat(effectivePrompt, {
			system,
			temperature: 0.2,
			maxTokens: 2000,
		});
		return { content };
	}
}
