/**
 * Content enhancer backed by the direct-SDK AIClient (Claude default).
 * Replaces the LangChain content enhancer; conforms to the shared
 * EnhancementResult contract so handlers are agnostic to the backend.
 */

import { AIClient } from '../ai/ai-client.js';
import { getLogger } from '../../core/logger.js';
import type { EnhancementRequest, EnhancementResult } from './content-enhancer.js';
import { clip, untrustedBlock } from '../../utils/prompt-input.js';

const logger = getLogger('ai-content-enhancer');

/** Per-type editing instruction. Covers both the handler's enum and EnhancementType. */
const INSTRUCTIONS: Record<string, string> = {
	grammar: 'Fix grammar, spelling, and punctuation only. Make no stylistic changes.',
	style: 'Refine prose style and voice while preserving meaning, characters, and dialogue.',
	clarity: 'Improve clarity and simplify convoluted phrasing without losing meaning.',
	expand: 'Expand the passage with richer, consistent detail while keeping its voice.',
	summarize: 'Condense the passage to its essentials while preserving meaning and tone.',
	creative: 'Creatively rework the passage, strengthening imagery and impact, preserving intent.',
	rewrite: 'Rewrite the passage to read more strongly while preserving its meaning.',
	condense: 'Condense the passage while preserving meaning and tone.',
	'improve-flow': 'Improve flow and transitions between sentences and paragraphs.',
	'enhance-descriptions': 'Enrich descriptions with vivid, specific detail.',
	'strengthen-dialogue': 'Make the dialogue sharper and more character-revealing.',
	'fix-pacing': 'Adjust pacing for better rhythm and tension.',
	'add-sensory-details': 'Add sensory detail where it deepens immersion.',
	'show-dont-tell':
		'Convert telling into showing through action, sensation, and concrete detail.',
	'eliminate-filter-words': 'Remove filter words and weak qualifiers; tighten the prose.',
	'vary-sentences': 'Vary sentence length and structure to improve rhythm.',
	'strengthen-verbs': 'Replace weak or generic verbs with stronger, specific ones.',
	'fix-continuity': 'Fix continuity issues while preserving the story.',
	'match-style': 'Match the requested target voice or style guide.',
};

const DEFAULT_INSTRUCTION =
	'Improve the passage while preserving its meaning, voice, characters, and dialogue.';

const SYSTEM_PROMPT =
	'You are a careful line editor for a fiction writer. Apply only the requested kind of ' +
	'improvement. Preserve meaning, characters, and dialogue unless explicitly asked to change ' +
	'them. Return ONLY the revised passage, with no preamble, commentary, or code fences.';

function wordCount(text: string): number {
	const trimmed = text.trim();
	return trimmed ? trimmed.split(/\s+/).length : 0;
}

export class AIContentEnhancer {
	private readonly ai: AIClient;

	constructor(ai: AIClient = new AIClient()) {
		this.ai = ai;
	}

	async enhance(request: EnhancementRequest): Promise<EnhancementResult> {
		const start = performance.now();
		const original = request.content ?? '';
		const instruction = INSTRUCTIONS[request.type] ?? DEFAULT_INSTRUCTION;
		const contextLine = request.context ?? request.options?.context;
		const contextBlock = contextLine ? `Context: ${contextLine}\n\n` : '';
		const prompt = `${instruction}\n\n${contextBlock}Passage:\n${untrustedBlock(clip(original, 12000, logger, 'enhance_content'))}`;

		const directive = request.preferenceDirective?.trim();
		const system = directive ? `${SYSTEM_PROMPT}\n\n${directive}` : SYSTEM_PROMPT;

		const result = await this.ai.chat(prompt, {
			system,
			temperature: 0.4,
			maxTokens: 4096,
		});
		const enhanced = result.trim();
		const changed = enhanced.length > 0 && enhanced !== original.trim();

		logger.debug('AI enhancement complete', {
			type: request.type,
			provider: this.ai.provider ?? 'none',
			changed,
		});

		return {
			original,
			enhanced: changed ? enhanced : original,
			changes: [],
			metrics: {
				originalWordCount: wordCount(original),
				enhancedWordCount: wordCount(enhanced),
				readabilityChange: 0,
				changesApplied: changed ? 1 : 0,
				processingTime: performance.now() - start,
			},
			suggestions: [],
		};
	}
}
