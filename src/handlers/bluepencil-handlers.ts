/**
 * Local, deterministic line-editing checks backed by bluepencil: the editor's
 * pass that narrative-lens does not cover -- adverbs, filter words, hedges,
 * clichés, passive voice, echoes and repeated phrases, sentence rhythm, and
 * dialogue tags -- every finding with a line and column in the document.
 * No AI model, no network call.
 */

import {
	analyzeDialogue,
	analyzeRhythm,
	checkStyle,
	findEchoes,
	findRepeats,
	report,
	sentenceStarters,
} from 'bluepencil-node';
import { createError, ErrorCode } from '../core/errors.js';
import {
	requireProject,
	getOptionalArrayArg,
	getOptionalBooleanArg,
	getOptionalNumberArg,
	getStringArg,
} from './types.js';
import type { HandlerResult, ToolDefinition } from './types.js';
import { SHARED_DEFS } from './shared-schemas.js';

// Scrivener document text arrives as plain prose (RTF already stripped), so a
// leading `#` or a line in capitals is content, not markup.
const FORMAT = 'plain';

const READ_ONLY = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

async function documentText(
	context: Parameters<ToolDefinition['handler']>[1],
	args: Record<string, unknown>
): Promise<{ id: string; title: string; text: string }> {
	const project = requireProject(context);
	const documentId = getStringArg(args, 'documentId');
	const document = await project.getDocument(documentId);
	if (!document) {
		throw createError(ErrorCode.NOT_FOUND, {}, 'Document not found');
	}
	return { id: documentId, title: document.title ?? '', text: document.content || '' };
}

export const checkStyleLocalHandler: ToolDefinition = {
	name: 'check_style_local',
	title: 'Check Style (Local)',
	description:
		'Line-edit one document with deterministic rules: -ly adverbs, filter words (felt, saw, ' +
		'noticed), hedges and intensifiers (just, really, very), stock clichés, passive voice, ' +
		'nominalizations, and any personal tics you name. Returns every finding with its line, ' +
		'column, and excerpt, plus counts and rates per 1,000 words so documents of different ' +
		'lengths compare. No AI model and no network call -- use enhance_content when you want the ' +
		'prose rewritten rather than flagged. Requires an open project and a valid document id.',
	annotations: READ_ONLY,
	inputSchema: {
		type: 'object',
		properties: {
			documentId: SHARED_DEFS.docId,
			tics: {
				type: 'array',
				items: { type: 'string' },
				description:
					'Words or phrases you overuse (e.g. "suddenly", "a beat"). Flagged with rule "tic".',
			},
			maxFindings: {
				type: 'number',
				description: 'Cap on findings returned, in document order. Default 200.',
			},
		},
		required: ['documentId'],
	},
	outputSchema: {
		type: 'object',
		properties: {
			words: { type: 'number', description: 'Words in the document.' },
			counts: {
				type: 'object',
				description:
					'Findings per rule: adverbs, filterWords, hedges, cliches, tics, passive, nominalizations.',
			},
			perThousand: { type: 'object', description: 'Each count per 1,000 words.' },
			findings: {
				type: 'array',
				description:
					'Findings in document order: rule, message, location {line, column, offset, length, excerpt}, inDialogue.',
			},
			totalFindings: {
				type: 'number',
				description: 'Findings before maxFindings was applied.',
			},
		},
		required: ['words', 'counts', 'perThousand', 'findings', 'totalFindings'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const { text } = await documentText(context, args);
		const tics = getOptionalArrayArg<string>(args, 'tics');
		const maxFindings = Math.max(
			0,
			Math.floor(getOptionalNumberArg(args, 'maxFindings') ?? 200)
		);

		const result = checkStyle(text, { format: FORMAT, tics });
		const findings = result.findings.slice(0, maxFindings);
		const c = result.counts;
		const r = result.perThousand;

		const summary =
			`${result.words} words, ${plural(result.findings.length, 'finding')}.\n` +
			`Adverbs ${c.adverbs} (${r.adverbs.toFixed(1)}/1k), filter words ${c.filterWords} ` +
			`(${r.filterWords.toFixed(1)}/1k), hedges ${c.hedges} (${r.hedges.toFixed(1)}/1k), ` +
			`passive ${c.passive} (${r.passive.toFixed(1)}/1k), clichés ${c.cliches}, ` +
			`nominalizations ${c.nominalizations}, tics ${c.tics}.${
				findings.length > 0
					? `\nFirst: ${findings
							.slice(0, 5)
							.map((f) => `L${f.location.line} ${f.rule} "${f.message}"`)
							.join('; ')}`
					: ''
			}`;

		return {
			content: [{ type: 'text', text: summary }],
			structuredContent: {
				words: result.words,
				counts: c,
				perThousand: r,
				findings,
				totalFindings: result.findings.length,
			},
		};
	},
};

export const findRepetitionLocalHandler: ToolDefinition = {
	name: 'find_repetition_local',
	title: 'Find Repetition (Local)',
	description:
		'Find echoes (the same word reappearing within a window of words) and repeated multi-word ' +
		'phrases in one document, each with line, column, and excerpt for both occurrences. ' +
		'Stopwords and, by default, capitalized names are ignored. No AI model and no network ' +
		'call. Requires an open project and a valid document id.',
	annotations: READ_ONLY,
	inputSchema: {
		type: 'object',
		properties: {
			documentId: SHARED_DEFS.docId,
			window: {
				type: 'number',
				description: 'Max words between two uses for them to count as an echo. Default 50.',
			},
			minLength: {
				type: 'number',
				description: 'Shortest word (in characters) to consider for echoes. Default 4.',
			},
			includeNames: {
				type: 'boolean',
				description: 'Count capitalized names as echoes too. Default false.',
			},
			minPhraseWords: {
				type: 'number',
				description: 'Shortest repeated phrase, in words. Default 3.',
			},
			maxPhraseWords: {
				type: 'number',
				description: 'Longest repeated phrase, in words. Default 6.',
			},
			minPhraseCount: {
				type: 'number',
				description: 'Fewest occurrences for a phrase to be reported. Default 2.',
			},
		},
		required: ['documentId'],
	},
	outputSchema: {
		type: 'object',
		properties: {
			echoes: {
				type: 'array',
				description: 'Echoes: word, distance (words apart), first and second locations.',
			},
			repeats: {
				type: 'array',
				description:
					'Repeated phrases, most frequent first: phrase, words, count, locations.',
			},
		},
		required: ['echoes', 'repeats'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const { text } = await documentText(context, args);
		const echoes = findEchoes(text, {
			format: FORMAT,
			window: getOptionalNumberArg(args, 'window'),
			minLength: getOptionalNumberArg(args, 'minLength'),
			includeNames: getOptionalBooleanArg(args, 'includeNames'),
		});
		const repeats = findRepeats(text, {
			format: FORMAT,
			minWords: getOptionalNumberArg(args, 'minPhraseWords'),
			maxWords: getOptionalNumberArg(args, 'maxPhraseWords'),
			minCount: getOptionalNumberArg(args, 'minPhraseCount'),
		});

		const echoLine =
			echoes.length > 0
				? `\nEchoes: ${echoes
						.slice(0, 5)
						.map(
							(e) =>
								`"${e.word}" L${e.first.line}→L${e.second.line} (${e.distance} words)`
						)
						.join('; ')}`
				: '';
		const phraseLine =
			repeats.length > 0
				? `\nPhrases: ${repeats
						.slice(0, 5)
						.map((r) => `"${r.phrase}" ×${r.count}`)
						.join('; ')}`
				: '';
		const summary = `${plural(echoes.length, 'echo')}, ${plural(repeats.length, 'repeated phrase')}.${echoLine}${phraseLine}`;

		return {
			content: [{ type: 'text', text: summary }],
			structuredContent: { echoes, repeats },
		};
	},
};

export const analyzeRhythmLocalHandler: ToolDefinition = {
	name: 'analyze_rhythm_local',
	title: 'Analyze Rhythm (Local)',
	description:
		'Measure sentence-length flow in one document: the distribution of sentence lengths, a ' +
		'variation score (stdev over mean; low reads as monotonous), runs of same-length sentences, ' +
		'overlong sentences, and sentences or paragraphs that keep opening with the same word. Each ' +
		'finding carries a line and column. No AI model and no network call. Requires an open ' +
		'project and a valid document id.',
	annotations: READ_ONLY,
	inputSchema: {
		type: 'object',
		properties: {
			documentId: SHARED_DEFS.docId,
			run: {
				type: 'number',
				description:
					'Consecutive similar-length sentences that count as monotonous. Default 4.',
			},
			tolerance: {
				type: 'number',
				description: 'Word-count difference still considered the same length. Default 3.',
			},
			long: {
				type: 'number',
				description: 'Sentence length in words flagged as overlong. Default 40.',
			},
			starterRun: {
				type: 'number',
				description: 'Consecutive sentences opening with the same word to flag. Default 3.',
			},
		},
		required: ['documentId'],
	},
	outputSchema: {
		type: 'object',
		properties: {
			summary: {
				type: 'object',
				description: 'Sentence-length distribution: count, mean, median, stdev, min, max.',
			},
			variation: { type: 'number', description: 'Stdev over mean of sentence length.' },
			lengths: { type: 'array', description: 'Word count of every sentence, in order.' },
			findings: {
				type: 'array',
				description:
					'monotony, long-sentence, and repeated-starter findings with locations.',
			},
			starters: {
				type: 'object',
				description: 'Most common sentence and paragraph openers with counts.',
			},
		},
		required: ['summary', 'variation', 'lengths', 'findings', 'starters'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const { text } = await documentText(context, args);
		const rhythm = analyzeRhythm(text, {
			format: FORMAT,
			run: getOptionalNumberArg(args, 'run'),
			tolerance: getOptionalNumberArg(args, 'tolerance'),
			long: getOptionalNumberArg(args, 'long'),
		});
		const starters = sentenceStarters(text, {
			format: FORMAT,
			run: getOptionalNumberArg(args, 'starterRun'),
		});
		const findings = [...rhythm.findings, ...starters.findings].sort(
			(a, b) => a.location.offset - b.location.offset
		);
		const s = rhythm.summary;
		const monotony = rhythm.findings.filter((f) => f.rule === 'monotony').length;
		const long = rhythm.findings.filter((f) => f.rule === 'long-sentence').length;

		const summary =
			`${plural(s.count, 'sentence')}: mean ${s.mean.toFixed(1)} words, median ${s.median}, ` +
			`range ${s.min}–${s.max}, variation ${rhythm.variation.toFixed(2)}.\n` +
			`${plural(monotony, 'monotonous run')}, ${plural(long, 'overlong sentence')}, ` +
			`${plural(starters.findings.length, 'repeated-opener run')}.${
				starters.sentence.length > 0
					? `\nTop openers: ${starters.sentence
							.slice(0, 5)
							.map((w) => `${w.word} (${w.count})`)
							.join(', ')}`
					: ''
			}`;

		return {
			content: [{ type: 'text', text: summary }],
			structuredContent: {
				summary: s,
				variation: rhythm.variation,
				lengths: rhythm.lengths,
				findings,
				starters: { sentence: starters.sentence, paragraph: starters.paragraph },
			},
		};
	},
};

export const analyzeDialogueTagsLocalHandler: ToolDefinition = {
	name: 'analyze_dialogue_tags_local',
	title: 'Analyze Dialogue Tags (Local)',
	description:
		'Audit dialogue in one document: the dialogue-to-narration ratio and every quoted line with ' +
		'its attribution classified as plain (said, asked), showy (exclaimed, snapped), adverb-' +
		'modified (said softly), or untagged, with the speaker when one can be read from the tag. ' +
		'No AI model and no network call -- complements analyze_craft_local, which extracts dialogue ' +
		'for speaker inference rather than tag quality. Requires an open project and a valid ' +
		'document id.',
	annotations: READ_ONLY,
	inputSchema: {
		type: 'object',
		properties: {
			documentId: SHARED_DEFS.docId,
			maxAttributions: {
				type: 'number',
				description: 'Cap on attributions returned, in document order. Default 200.',
			},
		},
		required: ['documentId'],
	},
	outputSchema: {
		type: 'object',
		properties: {
			ratio: {
				type: 'object',
				description:
					'dialogueWords, narrationWords, and ratio (share of words in dialogue).',
			},
			plainTags: {
				type: 'number',
				description: 'Lines tagged with said/asked and inflections.',
			},
			showyTags: { type: 'number', description: 'Lines tagged with a said-bookism.' },
			adverbTags: { type: 'number', description: 'Lines whose tag carries an adverb.' },
			untagged: { type: 'number', description: 'Quoted lines with no attribution verb.' },
			attributions: {
				type: 'array',
				description:
					'Each quoted line: dialogue location, tag location, kind (plain|showy|null), adverb, speaker.',
			},
			totalAttributions: {
				type: 'number',
				description: 'Attributions before maxAttributions was applied.',
			},
		},
		required: [
			'ratio',
			'plainTags',
			'showyTags',
			'adverbTags',
			'untagged',
			'attributions',
			'totalAttributions',
		],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const { text } = await documentText(context, args);
		const max = Math.max(0, Math.floor(getOptionalNumberArg(args, 'maxAttributions') ?? 200));
		const d = analyzeDialogue(text, { format: FORMAT });
		const attributions = d.attributions.slice(0, max);

		const summary =
			`Dialogue ${(d.ratio.ratio * 100).toFixed(0)}% of ${
				d.ratio.dialogueWords + d.ratio.narrationWords
			} words; ${plural(d.attributions.length, 'quoted line')}.\n` +
			`Tags: ${d.plainTags} plain, ${d.showyTags} showy, ${d.adverbTags} adverb-modified, ` +
			`${d.untagged} untagged.${
				d.showyTags + d.adverbTags > 0
					? `\nWorth a look: ${d.attributions
							.filter((a) => a.kind === 'showy' || a.adverb)
							.slice(0, 5)
							.map((a) => `L${a.dialogue.line} "${a.tag?.excerpt ?? ''}"`)
							.join('; ')}`
					: ''
			}`;

		return {
			content: [{ type: 'text', text: summary }],
			structuredContent: {
				ratio: d.ratio,
				plainTags: d.plainTags,
				showyTags: d.showyTags,
				adverbTags: d.adverbTags,
				untagged: d.untagged,
				attributions,
				totalAttributions: d.attributions.length,
			},
		};
	},
};

interface DocumentRow {
	documentId: string;
	title: string;
	words: number;
	fleschKincaidGrade: number;
	dialogueRatio: number;
	mattr: number;
	sentenceMean: number;
	adverbsPer1k: number;
	filterWordsPer1k: number;
	hedgesPer1k: number;
	passivePer1k: number;
	echoesPer1k: number;
	cliches: number;
	monotonousRuns: number;
	longSentences: number;
}

export const manuscriptStyleReportLocalHandler: ToolDefinition = {
	name: 'manuscript_style_report_local',
	title: 'Manuscript Style Report (Local)',
	description:
		'Run the bluepencil report over every manuscript document in binder order and tabulate per-' +
		'document style density: words, Flesch-Kincaid grade, dialogue ratio, lexical diversity ' +
		'(MATTR), mean sentence length, and adverbs, filter words, hedges, passive voice, and echoes ' +
		'per 1,000 words, plus clichés, monotonous runs, and overlong sentences. Outliers are ' +
		'listed so you can see which chapters drift from the rest. No AI model and no network ' +
		'call. Requires an open project.',
	annotations: READ_ONLY,
	inputSchema: {
		type: 'object',
		properties: {
			includeExcluded: {
				type: 'boolean',
				description:
					'Include documents with "Include in Compile" off. Default false, matching the ' +
					'manuscript as it would actually compile.',
			},
			tics: {
				type: 'array',
				items: { type: 'string' },
				description: 'Words or phrases you overuse, counted as tics in each document.',
			},
		},
	},
	outputSchema: {
		type: 'object',
		properties: {
			documents: {
				type: 'array',
				description: 'One row per document, in binder order, with the metrics above.',
			},
			totals: {
				type: 'object',
				description: 'Manuscript-wide words and word-weighted means of each rate.',
			},
			outliers: {
				type: 'array',
				description:
					'Documents more than 1.5 standard deviations from the manuscript mean on a rate (needs at least four documents with text): documentId, title, metric, value, mean.',
			},
			documentCount: { type: 'number', description: 'Documents included.' },
		},
		required: ['documents', 'totals', 'outliers', 'documentCount'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const includeExcluded = getOptionalBooleanArg(args, 'includeExcluded') ?? false;
		const tics = getOptionalArrayArg<string>(args, 'tics');

		const docs = await project.getManuscriptDocuments(includeExcluded);
		const rows: DocumentRow[] = docs.map((d) => {
			const r = report(d.content || '', { format: FORMAT, tics, top: 0 });
			return {
				documentId: d.id,
				title: d.title,
				words: r.counts.words,
				fleschKincaidGrade: r.readability.fleschKincaidGrade,
				dialogueRatio: r.dialogue.ratio,
				mattr: r.diversity.mattr,
				sentenceMean: r.sentenceLengths.mean,
				adverbsPer1k: r.stylePerThousand.adverbs,
				filterWordsPer1k: r.stylePerThousand.filterWords,
				hedgesPer1k: r.stylePerThousand.hedges,
				passivePer1k: r.stylePerThousand.passive,
				echoesPer1k: r.echoesPerThousand,
				cliches: r.style.cliches,
				monotonousRuns: r.monotonousRuns,
				longSentences: r.longSentences,
			};
		});

		const totalWords = rows.reduce((n, r) => n + r.words, 0);
		const weighted = (pick: (r: DocumentRow) => number): number =>
			totalWords === 0 ? 0 : rows.reduce((n, r) => n + pick(r) * r.words, 0) / totalWords;
		const rateKeys = [
			'fleschKincaidGrade',
			'dialogueRatio',
			'mattr',
			'sentenceMean',
			'adverbsPer1k',
			'filterWordsPer1k',
			'hedgesPer1k',
			'passivePer1k',
			'echoesPer1k',
		] as const;
		const totals: Record<string, number> = { words: totalWords };
		for (const key of rateKeys) {
			totals[key] = weighted((r) => r[key]);
		}

		const outliers: Array<{
			documentId: string;
			title: string;
			metric: string;
			value: number;
			mean: number;
		}> = [];
		const populated = rows.filter((r) => r.words > 0);
		// Population standard deviation and at least four documents: with fewer,
		// no single document can sit 1.5 deviations from the mean (the largest
		// possible z-score is sqrt(n - 1)), so the list would always be empty and
		// read as a clean bill of health.
		if (populated.length >= 4) {
			for (const key of rateKeys) {
				const values = populated.map((r) => r[key]);
				const mean = values.reduce((a, b) => a + b, 0) / values.length;
				const stdev = Math.sqrt(
					values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length
				);
				if (stdev === 0) continue;
				for (const r of populated) {
					if (Math.abs(r[key] - mean) > 1.5 * stdev) {
						outliers.push({
							documentId: r.documentId,
							title: r.title,
							metric: key,
							value: r[key],
							mean,
						});
					}
				}
			}
		}

		const summary =
			`${plural(rows.length, 'document')}, ${totalWords} words.\n` +
			`Manuscript means: FK grade ${totals.fleschKincaidGrade.toFixed(1)}, dialogue ` +
			`${(totals.dialogueRatio * 100).toFixed(0)}%, MATTR ${totals.mattr.toFixed(2)}, ` +
			`sentence ${totals.sentenceMean.toFixed(1)} words; per 1k: adverbs ` +
			`${totals.adverbsPer1k.toFixed(1)}, filter ${totals.filterWordsPer1k.toFixed(1)}, ` +
			`hedges ${totals.hedgesPer1k.toFixed(1)}, passive ${totals.passivePer1k.toFixed(1)}, ` +
			`echoes ${totals.echoesPer1k.toFixed(1)}.\n` +
			`${plural(outliers.length, 'outlier')}${
				outliers.length > 0
					? `: ${outliers
							.slice(0, 6)
							.map(
								(o) =>
									`${o.title || o.documentId} ${o.metric} ${o.value.toFixed(1)}`
							)
							.join('; ')}`
					: '.'
			}`;

		return {
			content: [{ type: 'text', text: summary }],
			structuredContent: { documents: rows, totals, outliers, documentCount: rows.length },
		};
	},
};

export const bluepencilHandlers = [
	checkStyleLocalHandler,
	findRepetitionLocalHandler,
	analyzeRhythmLocalHandler,
	analyzeDialogueTagsLocalHandler,
	manuscriptStyleReportLocalHandler,
];
