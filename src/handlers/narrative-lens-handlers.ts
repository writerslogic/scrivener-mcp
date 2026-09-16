/**
 * Local, deterministic prose-craft analysis backed by narrative-lens.
 * No AI model, no network call -- complements analyze_document (AI-based)
 * with the fast, offline checks a deterministic model can make.
 */

import {
	analyzeSyntaxTension,
	checkGrammar,
	computeReadability,
	extractDialogue,
	wordFrequencies,
} from 'narrative-lens';
import { createError, ErrorCode } from '../core/errors.js';
import {
	requireProject,
	getOptionalArrayArg,
	getOptionalNumberArg,
	getStringArg,
} from './types.js';
import type { HandlerResult, ToolDefinition } from './types.js';
import { SHARED_DEFS } from './shared-schemas.js';

export const analyzeCraftLocalHandler: ToolDefinition = {
	name: 'analyze_craft_local',
	title: 'Analyze Craft (Local)',
	description:
		'Run local, deterministic prose-craft analysis on a document: readability grade levels, ' +
		'grammar findings (repetition, agreement, etc.), sentence-level syntax tension (a pacing/' +
		'suspense proxy), extracted dialogue lines, and top word frequencies. No AI model and no ' +
		'network call -- use this for fast, repeatable checks, and analyze_document when you want a ' +
		'qualitative critique instead. Requires an open project and a valid document id.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			documentId: SHARED_DEFS.docId,
			knownCharacters: {
				type: 'array',
				items: { type: 'string' },
				description:
					'Character names to match against dialogue speaker tags. Omit to let dialogue ' +
					'extraction infer speakers heuristically.',
			},
			wordFrequencyLimit: {
				type: 'number',
				description: 'Max number of top word frequencies to return. Default 20.',
			},
		},
		required: ['documentId'],
	},
	outputSchema: {
		type: 'object',
		properties: {
			readability: {
				type: 'object',
				description:
					'Readability metrics and grade levels (Flesch-Kincaid, SMOG, ARI, etc.).',
			},
			grammar: {
				type: 'array',
				description: 'Grammar findings with character offsets and suggested replacements.',
			},
			syntaxTension: {
				type: 'object',
				description: 'Sentence-length variation, bursts, and suspense-keyword density.',
			},
			dialogue: {
				type: 'array',
				description: 'Extracted dialogue lines with inferred speaker and confidence.',
			},
			topWords: {
				type: 'array',
				description: 'Most frequent words in the document.',
			},
		},
		required: ['readability', 'grammar', 'syntaxTension', 'dialogue', 'topWords'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const documentId = getStringArg(args, 'documentId');
		const knownCharacters = getOptionalArrayArg<string>(args, 'knownCharacters') ?? [];
		const wordFrequencyLimit = getOptionalNumberArg(args, 'wordFrequencyLimit') ?? 20;

		const document = await project.getDocument(documentId);
		if (!document) {
			throw createError(ErrorCode.NOT_FOUND, {}, 'Document not found');
		}

		const text = document.content || '';

		const readability = computeReadability(text);
		const grammar = checkGrammar(text);
		const syntaxTension = analyzeSyntaxTension(text);
		const dialogue = extractDialogue(text, 0, knownCharacters);
		const topWords = wordFrequencies(text, wordFrequencyLimit);

		const summary =
			`Readability: FKGL ${readability.fkgl.toFixed(1)} (${readability.gradeLevels.fkgl}), ` +
			`${readability.wordCount} words, ${readability.sentenceCount} sentences.\n` +
			`Grammar: ${grammar.length} finding${grammar.length === 1 ? '' : 's'}.\n` +
			`Syntax tension: ${syntaxTension.score.toFixed(2)} ` +
			`(${syntaxTension.burstCount} bursts across ${syntaxTension.sentenceCount} sentences).\n` +
			`Dialogue: ${dialogue.length} line${dialogue.length === 1 ? '' : 's'} extracted.\n` +
			`Top words: ${topWords
				.slice(0, 5)
				.map((w) => `${w.word} (${w.count})`)
				.join(', ')}`;

		return {
			content: [{ type: 'text', text: summary }],
			structuredContent: { readability, grammar, syntaxTension, dialogue, topWords },
		};
	},
};

export const narrativeLensHandlers = [analyzeCraftLocalHandler];
