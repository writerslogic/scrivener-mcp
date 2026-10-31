import { createHash } from 'node:crypto';
import { getLogger } from '../../core/logger.js';
import type { ProjectStatistics } from '../../types/index.js';
import { getAccurateWordCount } from '../../utils/text-metrics.js';
import { AIClient } from '../ai/ai-client.js';
import { parseModelJson } from '../../utils/json-parse.js';
import { untrustedBlock } from '../../utils/prompt-input.js';
import type { CompilationOptions } from '../compilation-service.js';
import { CompilationService } from '../compilation-service.js';
import type { RTFContent } from '../parsers/rtf-handler.js';

export interface AICompilationOptions extends CompilationOptions {
	target?:
		'agent-query' | 'submission' | 'beta-readers' | 'publication' | 'pitch-packet' | 'synopsis';
	audience?: 'agents' | 'editors' | 'readers' | 'publishers' | 'writing-group';
	genre?: string;
	materialType?: string;
	length?: number;
	targetAudience?: string;
	optimizeForTarget?: boolean;
	enhanceContent?: boolean;
	/** Author-preference directive appended to prose-generation prompts. */
	preferenceDirective?: string;
}

export interface CompiledDocument {
	content: string | object;
	metadata: {
		format: string;
		wordCount: number;
		optimizations: string[];
		warnings: string[];
		targetAudience: string;
		compiledAt: string;
		processingTime?: number;
	};
	quality: CompilationQuality;
}

export interface CompilationQuality {
	score: number | null;
	suggestions: string[] | null;
	issues: string[] | null;
	availability: 'available' | 'partial' | 'unavailable';
	unavailableFields: Array<'score' | 'suggestions' | 'issues'>;
	partialFields: Array<'suggestions' | 'issues'>;
	reason?: 'provider_failed' | 'invalid_response' | 'no_text';
	coverage: {
		start: 0;
		end: number;
		sourceCharacters: number;
		sourceRevision: string;
		truncated: boolean;
	};
}

export const MAX_COMPILATION_AI_SOURCE = 12000;
export const MAX_QUALITY_CONTEXT = 4000;

interface CompilationTransform {
	content: string;
	optimizations: string[];
	warnings: string[];
}

function requireGeneratedText(content: unknown): string {
	if (typeof content !== 'string' || !content.trim())
		throw new Error('Provider returned no generated text');
	return content;
}

export class AICompilationService extends CompilationService {
	private ai: AIClient;
	private logger: ReturnType<typeof getLogger>;
	private targetWordLimits: Map<string, number>;

	constructor(ai: AIClient = new AIClient()) {
		super();
		this.ai = ai;
		this.logger = getLogger('AICompilationService');
		this.targetWordLimits = new Map([
			['agent-query', 250],
			['submission', 5000],
			['pitch-packet', 2000],
			['synopsis', 1000],
		]);
	}

	async initialize(): Promise<void> {
		this.logger.info('AI Compilation Service initialized');
	}

	private generate(
		prompt: string,
		options: { json?: boolean; maxTokens?: number; preferenceDirective?: string } = {}
	): Promise<string> {
		const system = options.json
			? 'Respond with STRICT JSON only -- no prose, no markdown code fences.'
			: 'You are a precise writing analyst.';
		const directive = options.json ? '' : options.preferenceDirective?.trim();
		return this.ai.chat(prompt, {
			system: directive ? `${system}\n\n${directive}` : system,
			temperature: 0.2,
			maxTokens: options.maxTokens ?? 2000,
		});
	}

	async compileWithAI(
		documents: Array<{ id: string; content: RTFContent | string; title: string }>,
		options: AICompilationOptions = {},
		projectStats?: ProjectStatistics
	): Promise<CompiledDocument> {
		const start = Date.now();
		if (projectStats)
			this.logger.debug('Project statistics available for compilation', {
				documentCount: projectStats.totalDocuments,
				wordCount: projectStats.totalWords,
			});
		const baseCompiled = await super.compileDocuments(documents, options);
		const originalText =
			!options.outputFormat || options.outputFormat === 'text'
				? (baseCompiled as string)
				: ((await super.compileDocuments(documents, {
						...options,
						outputFormat: 'text',
					})) as string);
		let content = originalText;
		const optimizations: string[] = [];
		const warnings: string[] = [];
		if (options.optimizeForTarget && options.target) {
			const optimized = await this.optimizeForTarget(content, options.target, options);
			content = optimized.content;
			optimizations.push(...optimized.optimizations);
			warnings.push(...optimized.warnings);
		}
		if (options.enhanceContent) {
			const enhanced = await this.enhanceContent(content, options);
			content = enhanced.content;
			optimizations.push(...enhanced.optimizations);
			warnings.push(...enhanced.warnings);
		}
		const resultContent =
			content === originalText
				? baseCompiled
				: await super.compileDocuments(
						[
							{
								id: 'generated',
								title: documents.length === 1 ? documents[0].title : '',
								content,
							},
						],
						{ outputFormat: options.outputFormat }
					);
		const quality = await this.assessQuality(content, options.target);
		return {
			content: resultContent,
			metadata: {
				format: options.outputFormat || 'text',
				wordCount: getAccurateWordCount(content),
				optimizations,
				warnings,
				targetAudience: options.audience || 'general',
				compiledAt: new Date().toISOString(),
				processingTime: Date.now() - start,
			},
			quality,
		};
	}

	/**
	 * Generate a submission/marketing artifact (synopsis, query letter, pitch
	 * packet, elevator pitch, or book blurb) from the manuscript content.
	 */
	async generateMarketingMaterials(
		documents: Array<{ id: string; content: RTFContent | string; title: string }>,
		options: AICompilationOptions = {}
	): Promise<{ content: string; processingTime: number; sourceCharacters: number }> {
		const start = Date.now();
		const materialType = options.materialType ?? 'synopsis';
		const length = options.length ?? 1000;
		if (!Number.isInteger(length) || length < 1 || length > 2000)
			throw new Error('Marketing length must be an integer from 1 to 2000 words');
		if (
			options.targetAudience !== undefined &&
			(typeof options.targetAudience !== 'string' || options.targetAudience.length > 2000)
		)
			throw new Error('Target audience must contain at most 2000 characters');
		let source = '';
		for (const document of documents) {
			const text =
				typeof document.content === 'string'
					? document.content
					: document.content?.plainText;
			if (typeof text !== 'string') throw new Error('Marketing source requires text content');
			const separator = source ? '\n\n' : '';
			if (source.length + separator.length + text.length > MAX_COMPILATION_AI_SOURCE)
				throw new Error(
					'Marketing generation requires a complete source within 12000 UTF-16 characters; select a smaller document scope'
				);
			source += separator + text;
		}
		if (!source.trim()) throw new Error('Marketing generation requires nonempty source text');

		const labels: Record<string, string> = {
			synopsis: 'a professional synopsis (third person, present tense, including the ending)',
			query_letter: 'a complete agent query letter with a hook, plot summary, and stakes',
			pitch_packet: 'a pitch packet with a logline, short synopsis, and market positioning',
			elevator_pitch: 'a one-paragraph elevator pitch',
			book_blurb: 'a back-cover book blurb that hooks readers without spoilers',
		};
		if (!Object.prototype.hasOwnProperty.call(labels, materialType))
			throw new Error('Unsupported marketing material type');
		const description = labels[materialType];

		const prompt =
			`Write ${description} for this ${options.genre || 'fiction'} manuscript.\n` +
			`Target length: approximately ${length} words.${
				options.targetAudience ? ` Target audience: ${options.targetAudience}.` : ''
			}\n\nManuscript:\n${untrustedBlock(source)}\n\nReturn only the ${materialType.replace(/_/g, ' ')} text.`;

		const content = await this.generate(prompt, {
			maxTokens: Math.min(8192, length * 3 + 512),
			preferenceDirective: options.preferenceDirective,
		});
		return {
			content: requireGeneratedText(content),
			processingTime: Date.now() - start,
			sourceCharacters: source.length,
		};
	}

	private async optimizeForTarget(
		content: string,
		target: string,
		options: AICompilationOptions
	): Promise<CompilationTransform> {
		const maxWords = this.targetWordLimits.get(target);
		if (maxWords === undefined)
			return {
				content,
				optimizations: [],
				warnings: ['Target optimization unavailable: unsupported target'],
			};
		if (!content.trim() || content.length > MAX_COMPILATION_AI_SOURCE)
			return {
				content,
				optimizations: [],
				warnings: [
					'Target optimization unavailable: complete source must contain 1–12000 UTF-16 characters',
				],
			};

		const intents: Record<string, { instruction: string; optimizations: string[] }> = {
			'agent-query': {
				instruction:
					'Transform this content into a compelling query letter for literary agents: a strong ' +
					'opening hook, the main conflict and stakes, and what makes the story unique. Max 250 words.',
				optimizations: ['Generated query letter'],
			},
			submission: {
				instruction:
					'Prepare this manuscript content for submission: publication-ready, a strong opening ' +
					'hook, consistent voice and pacing.',
				optimizations: ['Provider submission revision'],
			},
			'pitch-packet': {
				instruction:
					'Create a pitch packet from this content: a one-line logline, a short synopsis, market ' +
					'positioning, and unique selling points. Max 2000 words.',
				optimizations: ['Generated pitch packet'],
			},
			synopsis: {
				instruction:
					'Create a professional synopsis from this content: third person, present tense, a ' +
					'complete plot summary including the ending and character arcs. Max 1000 words.',
				optimizations: ['Generated synopsis'],
			},
		};

		const intent = intents[target];
		if (!intent)
			return {
				content,
				optimizations: [],
				warnings: ['Target optimization unavailable: unsupported target'],
			};

		const optimizations: string[] = [];
		try {
			const prompt = `${intent.instruction}\n\nGenre: ${options.genre || 'fiction'}\n\nContent:\n${untrustedBlock(content)}\n\nReturn only the resulting text.`;
			const result = await this.generate(prompt, {
				maxTokens: 8192,
				preferenceDirective: options.preferenceDirective,
			});
			let optimized = requireGeneratedText(result);
			optimizations.push(...intent.optimizations);

			if (getAccurateWordCount(optimized) > maxWords) {
				optimized = await this.condenseToLength(optimized, maxWords);
				optimizations.push(`Condensed to at most ${maxWords} words`);
			}
			return { content: optimized, optimizations, warnings: [] };
		} catch {
			this.logger.warn('Target optimization unavailable');
			return {
				content,
				optimizations: [],
				warnings: ['Target optimization unavailable; original content preserved'],
			};
		}
	}

	private async condenseToLength(content: string, maxWords: number): Promise<string> {
		if (content.length > MAX_COMPILATION_AI_SOURCE)
			throw new Error('Condensation source exceeds 12000 characters');
		const prompt =
			`Condense this content to at most ${maxWords} words while preserving the essential ` +
			`information and a professional tone:\n\n${untrustedBlock(content)}`;
		const result = await this.generate(prompt, {
			maxTokens: Math.min(8192, maxWords * 3 + 512),
		});
		const condensed = requireGeneratedText(result);
		if (getAccurateWordCount(condensed) > maxWords)
			throw new Error('Condensation did not satisfy the requested word limit');
		return condensed;
	}

	private async enhanceContent(
		content: string,
		options: AICompilationOptions
	): Promise<CompilationTransform> {
		if (!content.trim() || content.length > MAX_COMPILATION_AI_SOURCE)
			return {
				content,
				optimizations: [],
				warnings: [
					'Content enhancement unavailable: complete source must contain 1–12000 UTF-16 characters',
				],
			};
		const prompt =
			`Enhance this ${options.genre || 'fiction'} content for publication quality: improve clarity ` +
			'and flow, strengthen word choice, and preserve the author’s voice. Make minimal but ' +
			`impactful edits.\n\nContent:\n${untrustedBlock(content)}\n\nReturn only the enhanced text.`;
		try {
			const result = await this.generate(prompt, {
				maxTokens: 8192,
				preferenceDirective: options.preferenceDirective,
			});
			const enhanced = requireGeneratedText(result);
			const maxWords =
				options.optimizeForTarget && options.target
					? this.targetWordLimits.get(options.target)
					: undefined;
			if (maxWords !== undefined && getAccurateWordCount(enhanced) > maxWords)
				throw new Error('Enhancement exceeded the target word limit');
			return {
				content: enhanced,
				optimizations: ['Provider prose revision'],
				warnings: [],
			};
		} catch {
			this.logger.warn('Content enhancement unavailable');
			return {
				content,
				optimizations: [],
				warnings: ['Content enhancement unavailable; original content preserved'],
			};
		}
	}

	private async assessQuality(content: string, target?: string): Promise<CompilationQuality> {
		let end = Math.min(content.length, MAX_QUALITY_CONTEXT);
		if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1])) end--;
		const quality: CompilationQuality = {
			score: null,
			suggestions: null,
			issues: null,
			availability: 'unavailable',
			unavailableFields: ['score', 'suggestions', 'issues'],
			partialFields: [],
			coverage: {
				start: 0,
				end,
				sourceCharacters: content.length,
				sourceRevision: createHash('sha256').update(content).digest('hex'),
				truncated: end < content.length,
			},
		};
		if (!content.trim()) return { ...quality, reason: 'no_text' };
		let parsed: unknown;
		try {
			const prompt =
				`Assess the quality of this ${target || 'general'} content for clarity, engagement, and ` +
				'professional presentation. Return JSON: {"score": 0.0-1.0, "suggestions": [up to 3 ' +
				`strings], "issues": [strings]}.\n\nContent:\n${untrustedBlock(content.slice(0, end))}`;
			const result = await this.generate(prompt, { json: true });
			parsed = typeof result === 'string' ? parseModelJson(result, this.logger) : null;
		} catch {
			this.logger.warn('Quality assessment unavailable');
			return { ...quality, reason: 'provider_failed' };
		}
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
			return { ...quality, reason: 'invalid_response' };
		const assessment = parsed as Record<string, unknown>;
		if (
			typeof assessment.score === 'number' &&
			Number.isFinite(assessment.score) &&
			assessment.score >= 0 &&
			assessment.score <= 1
		)
			quality.score = assessment.score;
		for (const field of ['suggestions', 'issues'] as const) {
			const values = assessment[field];
			if (!Array.isArray(values)) continue;
			const valid = values.filter(
				(item): item is string => typeof item === 'string' && Boolean(item.trim())
			);
			if (valid.length || !values.length) {
				quality[field] = valid;
				if (valid.length !== values.length) quality.partialFields.push(field);
			}
		}
		quality.unavailableFields = quality.unavailableFields.filter(
			(field) => quality[field] === null
		);
		quality.availability =
			quality.unavailableFields.length === 3
				? 'unavailable'
				: quality.unavailableFields.length || quality.partialFields.length
					? 'partial'
					: 'available';
		return quality;
	}
}
