import { createHash } from 'node:crypto';
import { AIClient } from '../ai/ai-client.js';
import { untrustedBlock } from '../../utils/prompt-input.js';
import { computeReadability } from 'narrative-lens';

export const ENHANCEMENT_INSTRUCTIONS = {
	grammar: 'Fix grammar, spelling, and punctuation only. Make no stylistic changes.',
	style: 'Refine prose style and voice while preserving meaning, characters, and dialogue.',
	clarity: 'Improve clarity and simplify convoluted phrasing without losing meaning.',
	expand: 'Expand the passage with richer, consistent detail while keeping its voice.',
	summarize: 'Condense the passage to its essentials while preserving meaning and tone.',
	creative: 'Creatively rework the passage, strengthening imagery and impact, preserving intent.',
} as const;

export const ENHANCEMENT_OPTION_VALUES = {
	tone: ['maintain', 'lighter', 'darker', 'more-serious', 'more-humorous'],
	length: ['maintain', 'shorter', 'longer'],
	complexity: ['simplify', 'maintain', 'elevate'],
	perspective: ['maintain', 'first', 'second', 'third-limited', 'third-omniscient'],
	tense: ['maintain', 'past', 'present', 'future'],
	aggressiveness: ['light', 'moderate', 'heavy'],
} as const;
export const MAX_ENHANCEMENT_SOURCE = 12000;
export const MAX_ENHANCEMENT_RESULT = 64000;
export const UNAVAILABLE_ENHANCEMENT_FIELDS = [
	'changes',
	'suggestions',
	'metrics.changesApplied',
	'qualityValidation',
] as const;

export function enhancementOptions(value: unknown): Record<string, string | number | boolean> {
	if (value === undefined) return {};
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Enhancement options must be an object');
	const result: Record<string, string | number | boolean> = {};
	for (const [key, option] of Object.entries(value)) {
		const choices = Object.prototype.hasOwnProperty.call(ENHANCEMENT_OPTION_VALUES, key)
			? ENHANCEMENT_OPTION_VALUES[key as keyof typeof ENHANCEMENT_OPTION_VALUES]
			: undefined;
		const valid =
			(choices &&
				typeof option === 'string' &&
				(choices as readonly string[]).includes(option)) ||
			(key === 'length' &&
				typeof option === 'number' &&
				Number.isInteger(option) &&
				option >= 1 &&
				option <= 4000) ||
			(['preserveDialogue', 'preserveNames'].includes(key) && typeof option === 'boolean') ||
			(key === 'context' &&
				typeof option === 'string' &&
				option.length <= 2000 &&
				!option.includes('\0'));
		if (!valid) throw new Error(`Invalid enhancement option: ${key}`);
		result[key] = option as string | number | boolean;
	}
	return result;
}

export interface AIEnhancementRequest {
	content: string;
	type: keyof typeof ENHANCEMENT_INSTRUCTIONS;
	options?: Record<string, string | number | boolean>;
	preferenceDirective?: string;
}

export class EnhancementUnavailableError extends Error {
	constructor() {
		super('AI enhancement unavailable; no complete rewrite was returned');
	}
}

const SYSTEM_PROMPT =
	'You are a careful line editor for a fiction writer. Apply only the requested kind of ' +
	'improvement. Preserve meaning, characters, and dialogue unless explicitly asked to change ' +
	'them. Return ONLY the revised passage, with no preamble, commentary, or code fences.';

function measuredMetrics(text: string) {
	try {
		const result = computeReadability(text);
		return {
			wordCount:
				Number.isSafeInteger(result.wordCount) && result.wordCount >= 0
					? result.wordCount
					: null,
			readability:
				result.wordCount > 0 &&
				result.sentenceCount > 0 &&
				Number.isFinite(result.fleschEase)
					? result.fleschEase
					: null,
		};
	} catch {
		return { wordCount: null, readability: null };
	}
}

export class AIContentEnhancer {
	private readonly ai: AIClient;

	constructor(ai: AIClient = new AIClient()) {
		this.ai = ai;
	}

	async enhance(request: AIEnhancementRequest) {
		const original = request.content;
		if (
			typeof original !== 'string' ||
			!original.trim() ||
			original.length > MAX_ENHANCEMENT_SOURCE
		)
			throw new Error(
				'Enhancement requires 1–12000 UTF-16 characters of nonblank saved text; split longer documents before rewriting'
			);
		if (!Object.prototype.hasOwnProperty.call(ENHANCEMENT_INSTRUCTIONS, request.type))
			throw new Error('Unsupported enhancement type');
		const options = enhancementOptions(request.options);
		if (
			request.preferenceDirective !== undefined &&
			(typeof request.preferenceDirective !== 'string' ||
				request.preferenceDirective.length > 16000)
		)
			throw new Error('Enhancement preferences must contain at most 16000 UTF-16 characters');
		const { context, ...preferences } = options;
		const prompt = `${ENHANCEMENT_INSTRUCTIONS[request.type]}\n\nEditing preferences (length numbers are target words): ${JSON.stringify(preferences)}\n\n${context ? `Background context:\n${untrustedBlock(context as string)}\n\n` : ''}Passage:\n${untrustedBlock(original)}`;
		const directive = request.preferenceDirective?.trim();
		const system = directive ? `${SYSTEM_PROMPT}\n\n${directive}` : SYSTEM_PROMPT;

		let enhanced: string;
		try {
			enhanced = await this.ai.chat(prompt, { system, temperature: 0.4, maxTokens: 8192 });
		} catch {
			throw new EnhancementUnavailableError();
		}
		if (
			typeof enhanced !== 'string' ||
			!enhanced.trim() ||
			enhanced.length > MAX_ENHANCEMENT_RESULT
		)
			throw new EnhancementUnavailableError();
		const before = measuredMetrics(original);
		const after = measuredMetrics(enhanced);
		const metrics = {
			originalWordCount: before.wordCount,
			enhancedWordCount: after.wordCount,
			readabilityChange:
				before.readability !== null && after.readability !== null
					? after.readability - before.readability
					: null,
			changesApplied: null,
		};
		const unavailableFields: string[] = [...UNAVAILABLE_ENHANCEMENT_FIELDS];
		for (const [key, value] of Object.entries(metrics))
			if (value === null && key !== 'changesApplied')
				unavailableFields.push(`metrics.${key}`);

		return {
			original,
			enhanced,
			changed: enhanced !== original,
			changes: null,
			metrics,
			suggestions: null,
			qualityValidation: null,
			availability: { status: 'partial' as const, unavailableFields },
			coverage: {
				start: 0,
				end: original.length,
				sourceCharacters: original.length,
				sourceRevision: createHash('sha256').update(original).digest('hex'),
				truncated: false,
			},
		};
	}
}
