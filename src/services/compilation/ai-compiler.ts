/**
 * AI-assisted compilation backed by the direct-SDK AIClient (Claude default)
 * via AISemanticExtractor.generateWithTemplate. Replaces the LangChain-based
 * LangChainCompilationService: standard/intelligent manuscript compilation with
 * optional target optimization, prose enhancement, and quality assessment, plus
 * direct generation of submission/marketing artifacts.
 */

import type { LogContext } from '../../core/logger.js';
import { getLogger } from '../../core/logger.js';
import type { ProjectStatistics } from '../../types/index.js';
import { AppError, ErrorCode } from '../../utils/common.js';
import { AISemanticExtractor } from '../ai/ai-semantic-extractor.js';
import { parseModelJson } from '../../utils/json-parse.js';
import type { CompilationOptions } from '../compilation-service.js';
import { CompilationService } from '../compilation-service.js';
import type { RTFContent } from '../parsers/rtf-handler.js';

export interface AICompilationOptions extends CompilationOptions {
	target?:
		| 'agent-query'
		| 'submission'
		| 'beta-readers'
		| 'publication'
		| 'pitch-packet'
		| 'synopsis';
	audience?: 'agents' | 'editors' | 'readers' | 'publishers' | 'writing-group';
	genre?: string;
	materialType?: string;
	length?: number;
	targetAudience?: string;
	includeGenreAnalysis?: boolean;
	optimizeForTarget?: boolean;
	enhanceContent?: boolean;
	targetOptimization?: string;
	intelligentFormatting?: boolean;
	generateMarketingMaterials?: boolean;
}

export interface CompiledDocument {
	content: string | object;
	metadata: {
		format: string;
		wordCount: number;
		optimizations: string[];
		targetAudience: string;
		compiledAt: string;
		processingTime?: number;
	};
	quality: {
		score: number;
		suggestions: string[];
		issues: string[];
	};
}

interface TargetOptimization {
	maxLength: number;
	style: string;
}

export class AICompilationService extends CompilationService {
	private ai: AISemanticExtractor;
	private logger: ReturnType<typeof getLogger>;
	private targetOptimizations: Map<string, TargetOptimization>;

	constructor(ai: AISemanticExtractor = new AISemanticExtractor()) {
		super();
		this.ai = ai;
		this.logger = getLogger('AICompilationService');
		this.targetOptimizations = new Map([
			['agent-query', { maxLength: 250, style: 'professional' }],
			['submission', { maxLength: 5000, style: 'polished' }],
			['beta-readers', { maxLength: Infinity, style: 'readable' }],
			['publication', { maxLength: Infinity, style: 'publication-ready' }],
			['pitch-packet', { maxLength: 2000, style: 'marketing' }],
			['synopsis', { maxLength: 1000, style: 'synopsis' }],
		]);
	}

	async initialize(): Promise<void> {
		this.logger.info('AI Compilation Service initialized');
	}

	async compileWithAI(
		documents: Array<{ id: string; content: RTFContent | string; title: string }>,
		options: AICompilationOptions = {},
		projectStats?: ProjectStatistics
	): Promise<CompiledDocument> {
		const start = Date.now();
		try {
			this.logger.info(`Starting AI compilation for target: ${options.target || 'default'}`);
			if (projectStats) {
				this.logger.debug('Project statistics available for compilation', {
					documentCount: projectStats.totalDocuments,
					wordCount: projectStats.totalWords,
				});
			}

			const baseCompiled = await super.compileDocuments(documents, options);
			let content =
				typeof baseCompiled === 'string' ? baseCompiled : JSON.stringify(baseCompiled);
			const optimizations: string[] = [];

			if (options.optimizeForTarget && options.target) {
				const optimized = await this.optimizeForTarget(content, options.target, options);
				content = optimized.content;
				optimizations.push(...optimized.optimizations);
			}

			if (options.enhanceContent) {
				const enhanced = await this.enhanceContent(content, options);
				content = enhanced.content;
				optimizations.push(...enhanced.optimizations);
			}

			const quality = await this.assessQuality(content, options.target);

			// In JSON mode, keep the raw text if it does not parse rather than
			// silently collapsing the compiled output to an empty object.
			let resultContent: string | object = content;
			if (options.outputFormat === 'json') {
				const parsed = parseModelJson(content, this.logger);
				resultContent = parsed && typeof parsed === 'object' ? parsed : content;
			}

			return {
				content: resultContent,
				metadata: {
					format: options.outputFormat || 'text',
					wordCount: content.split(/\s+/).filter(Boolean).length,
					optimizations,
					targetAudience: options.audience || 'general',
					compiledAt: new Date().toISOString(),
					processingTime: Date.now() - start,
				},
				quality,
			};
		} catch (error) {
			const appError = new AppError(
				'AI compilation failed, falling back to standard compilation',
				ErrorCode.PROCESSING_ERROR,
				{ originalError: (error as Error).message }
			);
			this.logger.error(appError.message, appError.details as LogContext);

			const fallback = await super.compileDocuments(documents, options);
			const fallbackText = typeof fallback === 'string' ? fallback : JSON.stringify(fallback);
			return {
				content: fallback,
				metadata: {
					format: options.outputFormat || 'text',
					wordCount: fallbackText.split(/\s+/).filter(Boolean).length,
					optimizations: ['fallback-to-standard'],
					targetAudience: options.audience || 'general',
					compiledAt: new Date().toISOString(),
					processingTime: Date.now() - start,
				},
				quality: {
					score: 0.5,
					suggestions: ['AI compilation failed, manual review recommended'],
					issues: ['Could not perform AI optimization'],
				},
			};
		}
	}

	/**
	 * Generate a submission/marketing artifact (synopsis, query letter, pitch
	 * packet, elevator pitch, or book blurb) from the manuscript content.
	 */
	async generateMarketingMaterials(
		documents: Array<{ id: string; content: RTFContent | string; title: string }>,
		options: AICompilationOptions = {}
	): Promise<{ content: string; processingTime: number }> {
		const start = Date.now();
		const materialType = options.materialType || 'synopsis';
		const length = options.length || 1000;
		const source = documents
			.map((d) => (typeof d.content === 'string' ? d.content : d.content?.plainText || ''))
			.join('\n\n')
			.slice(0, 12000);

		const labels: Record<string, string> = {
			synopsis: 'a professional synopsis (third person, present tense, including the ending)',
			query_letter: 'a complete agent query letter with a hook, plot summary, and stakes',
			pitch_packet: 'a pitch packet with a logline, short synopsis, and market positioning',
			elevator_pitch: 'a one-paragraph elevator pitch',
			book_blurb: 'a back-cover book blurb that hooks readers without spoilers',
		};
		const description = labels[materialType] || labels.synopsis;

		const prompt =
			`Write ${description} for this ${options.genre || 'fiction'} manuscript.\n` +
			`Target length: approximately ${length} words.${
				options.targetAudience ? ` Target audience: ${options.targetAudience}.` : ''
			}\n\nManuscript:\n${source}\n\nReturn only the ${materialType.replace(/_/g, ' ')} text.`;

		const result = await this.ai.generateWithTemplate(materialType, prompt, {
			customPrompt: prompt,
			genre: options.genre,
		});
		return { content: result.content, processingTime: Date.now() - start };
	}

	private async optimizeForTarget(
		content: string,
		target: string,
		options: AICompilationOptions
	): Promise<{ content: string; optimizations: string[] }> {
		const config = this.targetOptimizations.get(target);
		if (!config) return { content, optimizations: [] };

		const intents: Record<string, { instruction: string; optimizations: string[] }> = {
			'agent-query': {
				instruction:
					'Transform this content into a compelling query letter for literary agents: a strong ' +
					'opening hook, the main conflict and stakes, and what makes the story unique. Max 250 words.',
				optimizations: ['Formatted as query letter', 'Optimized hook and stakes'],
			},
			submission: {
				instruction:
					'Prepare this manuscript content for submission: publication-ready, a strong opening ' +
					'hook, consistent voice and pacing.',
				optimizations: ['Polished for submission', 'Enhanced opening hook'],
			},
			'pitch-packet': {
				instruction:
					'Create a pitch packet from this content: a one-line logline, a short synopsis, market ' +
					'positioning, and unique selling points. Max 2000 words.',
				optimizations: ['Formatted as pitch packet', 'Added market positioning'],
			},
			synopsis: {
				instruction:
					'Create a professional synopsis from this content: third person, present tense, a ' +
					'complete plot summary including the ending and character arcs. Max 1000 words.',
				optimizations: ['Professional synopsis format', 'Complete plot summary'],
			},
		};

		const intent = intents[target];
		if (!intent) return { content, optimizations: [] };

		const optimizations: string[] = [];
		let optimized = content;
		try {
			const prompt = `${intent.instruction}\n\nGenre: ${options.genre || 'fiction'}\n\nContent:\n${content}\n\nReturn only the resulting text.`;
			const result = await this.ai.generateWithTemplate(`optimize_${target}`, prompt, {
				customPrompt: prompt,
				style: config.style,
				genre: options.genre,
			});
			optimized = result.content;
			optimizations.push(...intent.optimizations);

			if (
				config.maxLength !== Infinity &&
				optimized.split(/\s+/).filter(Boolean).length > config.maxLength
			) {
				optimized = await this.condenseToLength(optimized, config.maxLength);
				optimizations.push(`Condensed to ${config.maxLength} words`);
			}
		} catch (error) {
			this.logger.warn(`Target optimization failed for ${target}`, {
				error: (error as Error).message,
			});
			optimizations.push('Target optimization failed, using original content');
		}
		return { content: optimized, optimizations };
	}

	private async condenseToLength(content: string, maxWords: number): Promise<string> {
		const prompt =
			`Condense this content to at most ${maxWords} words while preserving the essential ` +
			`information and a professional tone:\n\n${content}`;
		const result = await this.ai.generateWithTemplate('condense', prompt, {
			customPrompt: prompt,
		});
		return result.content;
	}

	private async enhanceContent(
		content: string,
		options: AICompilationOptions
	): Promise<{ content: string; optimizations: string[] }> {
		const prompt =
			`Enhance this ${options.genre || 'fiction'} content for publication quality: improve clarity ` +
			'and flow, strengthen word choice, and preserve the author’s voice. Make minimal but ' +
			`impactful edits.\n\nContent:\n${content}\n\nReturn only the enhanced text.`;
		try {
			const result = await this.ai.generateWithTemplate('enhance', prompt, {
				customPrompt: prompt,
				genre: options.genre,
			});
			return {
				content: result.content,
				optimizations: ['Enhanced prose quality', 'Improved clarity and flow'],
			};
		} catch (error) {
			this.logger.warn('Content enhancement failed', { error: (error as Error).message });
			return { content, optimizations: ['Content enhancement unavailable'] };
		}
	}

	private async assessQuality(
		content: string,
		target?: string
	): Promise<{ score: number; suggestions: string[]; issues: string[] }> {
		try {
			const prompt =
				`Assess the quality of this ${target || 'general'} content for clarity, engagement, and ` +
				'professional presentation. Return JSON: {"score": 0.0-1.0, "suggestions": [up to 3 ' +
				`strings], "issues": [strings]}.\n\nContent:\n${content.slice(0, 4000)}`;
			const result = await this.ai.generateWithTemplate('quality_assessment', prompt, {
				customPrompt: prompt,
				format: 'json',
			});
			const parsedAssessment = parseModelJson(result.content, this.logger);
			const assessment = (
				parsedAssessment && typeof parsedAssessment === 'object' ? parsedAssessment : {}
			) as {
				score?: number;
				suggestions?: unknown;
				issues?: unknown;
			};
			return {
				score: Math.max(0, Math.min(1, assessment.score ?? 0.7)),
				suggestions: Array.isArray(assessment.suggestions)
					? (
							assessment.suggestions.filter((s) => typeof s === 'string') as string[]
						).slice(0, 3)
					: [],
				issues: Array.isArray(assessment.issues)
					? (assessment.issues.filter((s) => typeof s === 'string') as string[])
					: [],
			};
		} catch (error) {
			this.logger.warn('Quality assessment failed', { error: (error as Error).message });
			return {
				score: 0.7,
				suggestions: ['Manual quality review recommended'],
				issues: ['Automated assessment unavailable'],
			};
		}
	}
}
