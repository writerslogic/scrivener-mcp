/**
 * Local, deterministic prose-craft analysis backed by narrative-lens.
 * No AI model, no network call -- complements analyze_document (AI-based)
 * with the fast, offline checks a deterministic model can make.
 */

import {
	analyzeForeshadowing,
	analyzeSyntaxTension,
	buildTimeline,
	checkGrammar,
	computeReadability,
	extractDialogue,
	measureVoiceDriftFromText,
	trackWorldState,
	wordFrequencies,
} from 'narrative-lens';
import { createError, ErrorCode } from '../core/errors.js';
import {
	requireProject,
	requireMemoryManager,
	getOptionalArrayArg,
	getOptionalNumberArg,
	getStringArg,
} from './types.js';
import type { HandlerResult, ToolDefinition } from './types.js';
import { SHARED_DEFS } from './shared-schemas.js';

// Word tokenizer shared by the manuscript-scale analyzers below: lowercase
// word tokens, matching what analyzeForeshadowing expects per scene.
function tokenize(text: string): string[] {
	return text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
}

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

export const checkContinuityLocalHandler: ToolDefinition = {
	name: 'check_continuity_local',
	title: 'Check Continuity (Local)',
	description:
		'Scan the whole manuscript, in binder order, for local-analyzer continuity signals: a ' +
		'per-document timeline projection (detected time hints) and a world-state trace (character ' +
		'locations, knowledge, and possessions) that flags impossible-knowledge, impossible-location, ' +
		"object-continuity, and temporal-paradox violations. Character names come from this project's " +
		'memory (remember/recall); characters with no profile yet are invisible to the world-state ' +
		'trace. No AI model and no network call -- complements check_consistency, which reasons over ' +
		'project memory rather than manuscript text directly. Requires an open project.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			includeExcluded: {
				type: 'boolean',
				description:
					'Include documents with "Include in Compile" off. Default false, matching the ' +
					'manuscript as it would actually compile.',
			},
		},
	},
	outputSchema: {
		type: 'object',
		properties: {
			timeline: {
				type: 'array',
				description: 'Per-document timeline projection, in binder order.',
			},
			worldState: {
				type: 'object',
				description: 'Snapshots, continuity violations, and character-knowledge trace.',
			},
			documentCount: { type: 'number', description: 'Documents included in the scan.' },
		},
		required: ['timeline', 'worldState', 'documentCount'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const memoryManager = requireMemoryManager(context);
		const includeExcluded = Boolean(args.includeExcluded);

		const docs = await project.getManuscriptDocuments(includeExcluded);
		const characters = memoryManager.getAllCharacters().map((c) => c.name);

		const timeline = buildTimeline(docs.map((d) => [d.id, d.content] as [string, string]));
		const worldState = trackWorldState(
			docs.map((d) => d.content),
			characters
		);

		const summary =
			`Manuscript: ${docs.length} document${docs.length === 1 ? '' : 's'}, ` +
			`${characters.length} known character${characters.length === 1 ? '' : 's'}.\n` +
			`Continuity score: ${worldState.continuityScore.toFixed(2)}, ` +
			`world complexity: ${worldState.worldComplexity.toFixed(2)}.\n` +
			`Violations: ${worldState.violations.length}${
				worldState.violations.length > 0
					? `\n${worldState.violations
							.slice(0, 5)
							.map((v) => `- [${v.violationType}] scene ${v.scene}: ${v.description}`)
							.join('\n')}`
					: ''
			}`;

		return {
			content: [{ type: 'text', text: summary }],
			structuredContent: { timeline, worldState, documentCount: docs.length },
		};
	},
};

export const analyzeForeshadowingLocalHandler: ToolDefinition = {
	name: 'analyze_foreshadowing_local',
	title: 'Analyze Foreshadowing (Local)',
	description:
		'Scan the whole manuscript, in binder order, for setup/payoff pairs: recurring terms ' +
		'introduced early and either paid off later, left outstanding, or never mentioned again. Each ' +
		'item is attributed back to the document it was set up and paid off in. No AI model and no ' +
		'network call. Requires an open project.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			includeExcluded: {
				type: 'boolean',
				description:
					'Include documents with "Include in Compile" off. Default false, matching the ' +
					'manuscript as it would actually compile.',
			},
		},
	},
	outputSchema: {
		type: 'object',
		properties: {
			items: {
				type: 'array',
				description:
					'Setup/payoff items, each with the setup and payoff document id/title attached.',
			},
			documentCount: { type: 'number', description: 'Documents included in the scan.' },
		},
		required: ['items', 'documentCount'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const includeExcluded = Boolean(args.includeExcluded);

		const docs = await project.getManuscriptDocuments(includeExcluded);
		const scenesTokens = docs.map((d) => tokenize(d.content));
		const rawItems = analyzeForeshadowing(scenesTokens, docs.length);

		const items = rawItems.map((item) => ({
			...item,
			setupDocumentId: docs[item.setupScene]?.id ?? null,
			setupDocumentTitle: docs[item.setupScene]?.title ?? null,
			payoffDocumentId:
				item.payoffScene !== null ? (docs[item.payoffScene]?.id ?? null) : null,
			payoffDocumentTitle:
				item.payoffScene !== null ? (docs[item.payoffScene]?.title ?? null) : null,
		}));

		const outstanding = items.filter((i) => i.status === 'unresolved');
		const summary =
			`Manuscript: ${docs.length} document${docs.length === 1 ? '' : 's'}.\n` +
			`Setup/payoff items found: ${items.length}. Outstanding (no payoff): ${outstanding.length}.\n${
				outstanding.length > 0
					? outstanding
							.slice(0, 8)
							.map(
								(i) =>
									`- "${i.setupTerm}" set up in ${i.setupDocumentTitle ?? `scene ${i.setupScene}`}, ` +
									`never paid off (${i.status})`
							)
							.join('\n')
					: ''
			}`;

		return {
			content: [{ type: 'text', text: summary }],
			structuredContent: { items, documentCount: docs.length },
		};
	},
};

export const measureVoiceDriftLocalHandler: ToolDefinition = {
	name: 'measure_voice_drift_local',
	title: 'Measure Voice Drift (Local)',
	description:
		"Measure how a character's dialogue voice drifts across the manuscript. Splits the manuscript " +
		"(in binder order) into an earlier and later half, extracts that character's dialogue lines " +
		'from each half via speaker-tag matching, and compares vocabulary richness, sentence length, ' +
		'formality, and other voice features between the two. No AI model and no network call. ' +
		'Requires an open project and a character name that actually speaks in the manuscript.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			characterName: {
				type: 'string',
				description: 'Character name to match against extracted dialogue speaker tags.',
			},
			splitFraction: {
				type: 'number',
				description:
					'Fraction (0-1) of the manuscript, by document count, marking the boundary between ' +
					'the earlier and later half. Default 0.5.',
			},
			includeExcluded: {
				type: 'boolean',
				description: 'Include documents with "Include in Compile" off. Default false.',
			},
		},
		required: ['characterName'],
	},
	outputSchema: {
		type: 'object',
		properties: {
			drift: {
				type: 'object',
				description: 'Overall and per-feature drift between the halves.',
			},
			baselineLineCount: {
				type: 'number',
				description: 'Dialogue lines in the earlier half.',
			},
			currentLineCount: { type: 'number', description: 'Dialogue lines in the later half.' },
		},
		required: ['baselineLineCount', 'currentLineCount'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const characterName = getStringArg(args, 'characterName');
		const splitFraction = getOptionalNumberArg(args, 'splitFraction') ?? 0.5;
		const includeExcluded = Boolean(args.includeExcluded);

		const docs = await project.getManuscriptDocuments(includeExcluded);
		const splitIndex = Math.floor(docs.length * splitFraction);
		const baselineDocs = docs.slice(0, splitIndex);
		const currentDocs = docs.slice(splitIndex);

		const linesFor = (documents: typeof docs): string[] =>
			documents.flatMap((d) =>
				extractDialogue(d.content, 0, [characterName])
					.filter((line) => line.speaker.toLowerCase() === characterName.toLowerCase())
					.map((line) => line.quote)
			);

		const baselineLines = linesFor(baselineDocs);
		const currentLines = linesFor(currentDocs);

		if (baselineLines.length === 0 || currentLines.length === 0) {
			const summary =
				`Not enough dialogue found for "${characterName}" to measure drift: ` +
				`${baselineLines.length} line(s) in the earlier half, ${currentLines.length} in the ` +
				'later half. Both halves need at least one attributed line.';
			return {
				content: [{ type: 'text', text: summary }],
				structuredContent: {
					baselineLineCount: baselineLines.length,
					currentLineCount: currentLines.length,
				},
			};
		}

		const drift = measureVoiceDriftFromText(characterName, baselineLines, currentLines);

		const summary =
			`"${characterName}": ${baselineLines.length} earlier line(s), ${currentLines.length} ` +
			`later line(s). Overall drift: ${drift.overall.toFixed(2)} ` +
			`(${drift.drifted ? 'drifted' : 'stable'}).\n${
				drift.notes.length > 0 ? drift.notes.join('\n') : ''
			}`;

		return {
			content: [{ type: 'text', text: summary }],
			structuredContent: {
				drift,
				baselineLineCount: baselineLines.length,
				currentLineCount: currentLines.length,
			},
		};
	},
};

export const narrativeLensHandlers = [
	analyzeCraftLocalHandler,
	checkContinuityLocalHandler,
	analyzeForeshadowingLocalHandler,
	measureVoiceDriftLocalHandler,
];
