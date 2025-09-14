import type { LogContext } from '../../core/logger.js';
import { getLogger } from '../../core/logger.js';
import type { ProjectStatistics } from '../../types/index.js';
import { AppError, ErrorCode } from '../../utils/common.js';
import { AsyncUtils } from '../../utils/shared-patterns.js';
import { AdvancedLangChainFeatures } from '../ai/langchain-advanced-features.js';
import { EnhancedLangChainService } from '../ai/langchain-service-enhanced.js';
import type { CompilationOptions } from '../compilation-service.js';
import { CompilationService } from '../compilation-service.js';
import type { RTFContent } from '../parsers/rtf-handler.js';

export interface LangChainCompilationOptions extends CompilationOptions {
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
	generateDynamicElements?: boolean;
	optimizeForTarget?: boolean;
	enhanceContent?: boolean;
	autoGenerateMetadata?: boolean;
	targetOptimization?: string;
	intelligentFormatting?: boolean;
	generateMarketingMaterials?: boolean;
}

export interface CompiledDocument {
	content: string | object;
	metadata: {
		format: string;
		wordCount: number;
		generatedElements: GeneratedElements;
		optimizations: string[];
		targetAudience: string;
		compiledAt: string;
		processingTime?: number;
	};
	dynamicElements: GeneratedElements;
	quality: {
		score: number;
		suggestions: string[];
		issues: string[];
	};
	optimization?: string;
}

export interface GeneratedElements {
	synopsis?: string;
	hooks?: string[];
	blurb?: string;
	queryLetter?: string;
	tagline?: string;
	characterList?: string;
	settings?: string[];
	themes?: string[];
	marketingCopy?: string;
	pitchParagraph?: string;
	comparisons?: string[];
	processingTime?: number;
	content?: string;
}

export interface ContentOptimization {
	originalLength: number;
	optimizedLength: number;
	changes: {
		type: string;
		description: string;
		impact: string;
	}[];
	qualityImprovement: number;
}

interface TargetOptimization {
	maxLength: number;
	style: string;
	focusElements: string[];
	tone: string;
	structure: string;
}

interface QualityAssessment {
	score: number;
	suggestions: string[];
	issues: string[];
	timestamp: number;
}

export class LangChainCompilationService extends CompilationService {
	private langchain: EnhancedLangChainService;
	private advanced: AdvancedLangChainFeatures;
	private logger: ReturnType<typeof getLogger>;
	private targetOptimizations: Map<string, TargetOptimization>;
	private compilationCache: Map<string, CompiledDocument>;
	private elementCache: Map<string, GeneratedElements>;
	private qualityCache: Map<string, QualityAssessment>;
	private activeCompilations: Set<string>;

	constructor() {
		super();
		this.langchain = new EnhancedLangChainService();
		this.advanced = new AdvancedLangChainFeatures();
		this.logger = getLogger('LangChainCompilationService');
		this.targetOptimizations = this.initializeTargetOptimizations();
		this.compilationCache = new Map();
		this.elementCache = new Map();
		this.qualityCache = new Map();
		this.activeCompilations = new Set();
	}

	async initialize(): Promise<void> {
		// Initialize services if needed
		this.logger.info('LangChain Compilation Service initialized');
	}

	async generateMarketingMaterials(
		documents: Array<{ id: string; content: RTFContent | string; title: string }>,
		options?: LangChainCompilationOptions
	): Promise<GeneratedElements> {
		// Generate marketing materials using advanced features when available
		const content = documents.map((d) => d.content || '').join('\n\n');

		// For now, use basic dynamic elements generation
		return await this.generateDynamicElements(content, options || {});
	}

	private initializeTargetOptimizations(): Map<string, TargetOptimization> {
		return new Map([
			[
				'agent-query',
				{
					maxLength: 250,
					style: 'professional',
					focusElements: ['hook', 'stakes', 'conflict'],
					tone: 'compelling',
					structure: 'query-standard',
				},
			],
			[
				'submission',
				{
					maxLength: 5000,
					style: 'polished',
					focusElements: ['opening', 'pacing', 'voice'],
					tone: 'confident',
					structure: 'manuscript-standard',
				},
			],
			[
				'beta-readers',
				{
					maxLength: Infinity,
					style: 'readable',
					focusElements: ['clarity', 'engagement', 'feedback-points'],
					tone: 'accessible',
					structure: 'reader-friendly',
				},
			],
			[
				'publication',
				{
					maxLength: Infinity,
					style: 'publication-ready',
					focusElements: ['polish', 'consistency', 'professional'],
					tone: 'authoritative',
					structure: 'industry-standard',
				},
			],
			[
				'pitch-packet',
				{
					maxLength: 2000,
					style: 'marketing',
					focusElements: ['hook', 'market-appeal', 'uniqueness'],
					tone: 'engaging',
					structure: 'pitch-format',
				},
			],
			[
				'synopsis',
				{
					maxLength: 1000,
					style: 'synopsis',
					focusElements: ['plot-summary', 'character-arcs', 'resolution'],
					tone: 'informative',
					structure: 'synopsis-format',
				},
			],
		]);
	}

	async compileWithAI(
		documents: Array<{ id: string; content: RTFContent | string; title: string }>,
		options: LangChainCompilationOptions = {},
		projectStats?: ProjectStatistics
	): Promise<CompiledDocument> {
		try {
			this.logger.info(`Starting AI compilation for target: ${options.target || 'default'}`);

			// Use advanced features for project analysis if statistics available
			if (projectStats && this.advanced) {
				this.logger.debug('Project statistics available for enhanced compilation', {
					documentCount: projectStats.totalDocuments,
					wordCount: projectStats.totalWords,
				});
			}

			const baseCompiled = await super.compileDocuments(documents, options);
			const compiledContent =
				typeof baseCompiled === 'string' ? baseCompiled : JSON.stringify(baseCompiled);

			let optimizedContent = compiledContent;
			const optimizations: string[] = [];
			let dynamicElements: GeneratedElements = {};

			if (options.optimizeForTarget && options.target) {
				const optimization = await this.optimizeForTarget(
					compiledContent,
					options.target,
					options
				);
				optimizedContent = optimization.content;
				optimizations.push(...optimization.optimizations);
			}

			if (options.enhanceContent) {
				const enhanced = await this.enhanceContentWithAI(optimizedContent, options);
				optimizedContent = enhanced.content;
				optimizations.push(...enhanced.optimizations);
			}

			if (options.generateDynamicElements || options.autoGenerateMetadata) {
				// Use advanced features for more sophisticated element generation
				// For now, use basic dynamic elements generation
				dynamicElements = await this.generateDynamicElements(optimizedContent, options);
			}

			const quality = await this.assessQuality(optimizedContent, options.target);

			const result: CompiledDocument = {
				content:
					options.outputFormat === 'json'
						? JSON.parse(optimizedContent)
						: optimizedContent,
				metadata: {
					format: options.outputFormat || 'text',
					wordCount: optimizedContent.split(/\s+/).length,
					generatedElements: dynamicElements,
					optimizations,
					targetAudience: options.audience || 'general',
					compiledAt: new Date().toISOString(),
				},
				dynamicElements,
				quality,
			};

			this.logger.info(`AI compilation completed with quality score: ${quality.score}`);
			return result;
		} catch (error) {
			const appError = new AppError(
				'AI compilation failed, falling back to standard compilation',
				ErrorCode.PROCESSING_ERROR,
				{ originalError: (error as Error).message }
			);
			this.logger.error(appError.message, appError.details as LogContext);

			const fallback = await super.compileDocuments(documents, options);
			return {
				content: fallback,
				metadata: {
					format: options.outputFormat || 'text',
					wordCount: (typeof fallback === 'string'
						? fallback
						: JSON.stringify(fallback)
					).split(/\s+/).length,
					generatedElements: {},
					optimizations: ['fallback-to-standard'],
					targetAudience: options.audience || 'general',
					compiledAt: new Date().toISOString(),
				},
				dynamicElements: {},
				quality: {
					score: 0.5,
					suggestions: ['AI compilation failed, manual review recommended'],
					issues: ['Could not perform AI optimization'],
				},
			};
		}
	}

	private async optimizeForTarget(
		content: string,
		target: string,
		options: LangChainCompilationOptions
	): Promise<{ content: string; optimizations: string[] }> {
		const targetConfig = this.targetOptimizations.get(target);
		if (!targetConfig) {
			return { content, optimizations: [] };
		}

		const optimizations: string[] = [];
		let optimizedContent = content;

		try {
			if (target === 'agent-query') {
				const queryOptimization = await this.optimizeForQueryLetter(content, options);
				optimizedContent = queryOptimization.content;
				optimizations.push(...queryOptimization.optimizations);
			} else if (target === 'submission') {
				const submissionOpt = await this.optimizeForSubmission(content, options);
				optimizedContent = submissionOpt.content;
				optimizations.push(...submissionOpt.optimizations);
			} else if (target === 'pitch-packet') {
				const pitchOpt = await this.optimizeForPitch(content, options);
				optimizedContent = pitchOpt.content;
				optimizations.push(...pitchOpt.optimizations);
			} else if (target === 'synopsis') {
				const synopsisOpt = await this.optimizeForSynopsis(content, options);
				optimizedContent = synopsisOpt.content;
				optimizations.push(...synopsisOpt.optimizations);
			}

			if (
				targetConfig.maxLength !== Infinity &&
				optimizedContent.split(/\s+/).length > targetConfig.maxLength
			) {
				const condensed = await this.condenseToLength(
					optimizedContent,
					targetConfig.maxLength
				);
				optimizedContent = condensed.content;
				optimizations.push(`Condensed to ${targetConfig.maxLength} words`);
			}
		} catch (error) {
			const appError = new AppError(
				`Target optimization failed for ${target}`,
				ErrorCode.PROCESSING_ERROR,
				{ target, originalError: (error as Error).message }
			);
			this.logger.warn(appError.message, appError.details as LogContext);
			optimizations.push(`Target optimization failed, using original content`);
		}

		return { content: optimizedContent, optimizations };
	}

	private async optimizeForQueryLetter(
		content: string,
		options: LangChainCompilationOptions
	): Promise<{ content: string; optimizations: string[] }> {
		const prompt = `Transform this content into a compelling query letter for literary agents:

${content}

Requirements:
- Maximum 250 words
- Professional, engaging tone
- Clear hook in first paragraph
- Concise plot summary with stakes
- Genre: ${options.genre || 'fiction'}
- Target audience: ${options.audience || 'agents'}

Focus on:
1. Opening hook that grabs attention
2. Main conflict and stakes
3. Protagonist's journey
4. What makes this story unique

Return only the query letter text.`;

		const result = await this.langchain.generateWithTemplate('query_optimization', content, {
			maxLength: 250,
			style: 'professional',
			genre: options.genre,
			customPrompt: prompt,
		});

		return {
			content: result.content,
			optimizations: [
				'Formatted as query letter',
				'Optimized hook and stakes',
				'Professional agent-focused tone',
			],
		};
	}

	private async optimizeForSubmission(
		content: string,
		options: LangChainCompilationOptions
	): Promise<{ content: string; optimizations: string[] }> {
		const prompt = `Prepare this manuscript content for submission:

${content.slice(0, 2000)}...

Requirements:
- Publication-ready formatting
- Strong opening that hooks readers
- Consistent voice and pacing
- Genre: ${options.genre || 'fiction'}
- Professional presentation

Focus on:
1. Compelling opening paragraph
2. Consistent narrative voice
3. Proper pacing and flow
4. Professional manuscript standards

Enhance the opening and fix any obvious issues.`;

		const result = await this.langchain.generateWithTemplate(
			'submission_optimization',
			content,
			{
				style: 'polished',
				genre: options.genre,
				customPrompt: prompt,
			}
		);

		return {
			content: result.content,
			optimizations: [
				'Polished for submission',
				'Enhanced opening hook',
				'Improved pacing and flow',
			],
		};
	}

	private async optimizeForPitch(
		content: string,
		options: LangChainCompilationOptions
	): Promise<{ content: string; optimizations: string[] }> {
		const prompt = `Create a compelling pitch packet from this content:

${content}

Requirements:
- Maximum 2000 words total
- Marketing-focused language
- Clear commercial appeal
- Genre: ${options.genre || 'fiction'}
- Target market analysis

Include:
1. One-line pitch/logline
2. Short synopsis (250 words)
3. Market positioning
4. Unique selling points

Return as structured pitch packet.`;

		const result = await this.langchain.generateWithTemplate('pitch_optimization', content, {
			maxLength: 2000,
			style: 'marketing',
			genre: options.genre,
			customPrompt: prompt,
		});

		return {
			content: result.content,
			optimizations: [
				'Formatted as pitch packet',
				'Added market positioning',
				'Marketing-focused language',
			],
		};
	}

	private async optimizeForSynopsis(
		content: string,
		options: LangChainCompilationOptions
	): Promise<{ content: string; optimizations: string[] }> {
		const prompt = `Create a professional synopsis from this content:

${content}

Requirements:
- Maximum 1000 words
- Third person, present tense
- Complete plot summary including ending
- Character arcs and development
- Genre: ${options.genre || 'fiction'}

Structure:
1. Opening situation and protagonist
2. Major plot points and conflicts
3. Character development
4. Climax and resolution

Include all major plot points and the ending.`;

		const result = await this.langchain.generateWithTemplate('synopsis_generation', content, {
			maxLength: 1000,
			style: 'synopsis',
			genre: options.genre,
			customPrompt: prompt,
		});

		return {
			content: result.content,
			optimizations: [
				'Professional synopsis format',
				'Complete plot summary',
				'Industry-standard structure',
			],
		};
	}

	private async condenseToLength(
		content: string,
		maxWords: number
	): Promise<{ content: string; optimizations: string[] }> {
		const currentWords = content.split(/\s+/).length;
		if (currentWords <= maxWords) {
			return { content, optimizations: [] };
		}

		const prompt = `Condense this content to exactly ${maxWords} words while preserving all essential information:

${content}

Requirements:
- Exactly ${maxWords} words maximum
- Preserve core meaning and key details
- Maintain professional tone
- Remove only non-essential elements

Focus on keeping the most important information and removing redundancy.`;

		const result = await this.langchain.generateWithTemplate('content_condensation', content, {
			maxLength: maxWords,
			preserveEssentials: true,
			customPrompt: prompt,
		});

		return {
			content: result.content,
			optimizations: [`Condensed from ${currentWords} to ${maxWords} words`],
		};
	}

	private async enhanceContentWithAI(
		content: string,
		options: LangChainCompilationOptions
	): Promise<{ content: string; optimizations: string[] }> {
		const prompt = `Enhance this content for publication quality:

${content}

Focus on:
1. Improving clarity and flow
2. Strengthening prose and word choice
3. Enhancing readability
4. Maintaining the author's voice
5. Genre: ${options.genre || 'fiction'}

Make minimal but impactful improvements while preserving the original meaning and style.`;

		try {
			const result = await this.langchain.generateWithTemplate(
				'content_enhancement',
				content,
				{
					preserveStyle: true,
					genre: options.genre,
					customPrompt: prompt,
				}
			);

			return {
				content: result.content,
				optimizations: [
					'Enhanced prose quality',
					'Improved clarity and flow',
					'Strengthened word choice',
				],
			};
		} catch (error) {
			const appError = new AppError(
				'Content enhancement failed',
				ErrorCode.PROCESSING_ERROR,
				{ originalError: (error as Error).message }
			);
			this.logger.warn(appError.message, appError.details as LogContext);
			return {
				content,
				optimizations: ['Content enhancement unavailable'],
			};
		}
	}

	private async generateDynamicElements(
		content: string,
		options: LangChainCompilationOptions
	): Promise<GeneratedElements> {
		const elements: GeneratedElements = {};

		try {
			const analysisPromises = [
				this.generateSynopsis(content, options),
				this.generateHooks(content, options),
				this.generateBlurb(content, options),
				this.generateMetadata(content, options),
			];

			const [synopsis, hooks, blurb, metadata] = await Promise.all(analysisPromises);

			elements.synopsis = typeof synopsis === 'string' ? synopsis : JSON.stringify(synopsis);
			elements.hooks = Array.isArray(hooks)
				? hooks
				: typeof hooks === 'string'
					? [hooks]
					: [JSON.stringify(hooks)];
			elements.blurb = typeof blurb === 'string' ? blurb : JSON.stringify(blurb);
			elements.tagline =
				typeof metadata === 'object' && !Array.isArray(metadata) && metadata?.tagline
					? metadata.tagline
					: typeof metadata === 'string'
						? metadata
						: JSON.stringify(metadata);
			elements.themes =
				typeof metadata === 'object' &&
				!Array.isArray(metadata) &&
				Array.isArray(metadata?.themes)
					? metadata.themes
					: [];
			elements.settings =
				typeof metadata === 'object' &&
				!Array.isArray(metadata) &&
				Array.isArray(metadata?.settings)
					? metadata.settings
					: [];

			if (options.target === 'agent-query' || options.target === 'pitch-packet') {
				elements.queryLetter = await this.generateQueryLetter(content, options);
				elements.pitchParagraph = await this.generatePitchParagraph(content, options);
				elements.comparisons = await this.generateComparisons(content, options);
			}
		} catch (error) {
			const appError = new AppError(
				'Dynamic element generation partially failed',
				ErrorCode.PROCESSING_ERROR,
				{ originalError: (error as Error).message }
			);
			this.logger.warn(appError.message, appError.details as LogContext);
		}

		return elements;
	}

	private async generateSynopsis(
		content: string,
		options: LangChainCompilationOptions
	): Promise<string> {
		const prompt = `Generate a compelling 250-word synopsis for this ${options.genre || 'fiction'} work:

${content.slice(0, 2000)}...

Create a synopsis that:
1. Captures the main plot and character arc
2. Includes key conflicts and stakes
3. Shows the story's unique elements
4. Appeals to ${options.audience || 'readers'}

Focus on the core story elements that make this compelling.`;

		const result = await this.langchain.generateWithTemplate('synopsis_generation', content, {
			maxLength: 250,
			genre: options.genre,
			audience: options.audience,
			customPrompt: prompt,
		});

		return result.content;
	}

	private async generateHooks(
		content: string,
		options: LangChainCompilationOptions
	): Promise<string[]> {
		const prompt = `Generate 5 compelling hooks/taglines for this ${options.genre || 'fiction'} work:

${content.slice(0, 1500)}...

Create hooks that:
1. Capture the essence of the story
2. Appeal to ${options.audience || 'readers'}
3. Are memorable and marketable
4. Vary in style and approach
5. Range from 10-25 words each

Return as numbered list.`;

		const result = await this.langchain.generateWithTemplate('hook_generation', content, {
			genre: options.genre,
			audience: options.audience,
			customPrompt: prompt,
		});

		return result.content
			.split('\n')
			.filter((line) => line.trim().length > 0)
			.map((line) => line.replace(/^\d+\.\s*/, '').trim())
			.slice(0, 5);
	}

	private async generateBlurb(
		content: string,
		options: LangChainCompilationOptions
	): Promise<string> {
		const prompt = `Generate a back-cover blurb for this ${options.genre || 'fiction'} work:

${content.slice(0, 2000)}...

Create a blurb that:
1. Hooks readers immediately
2. Sets up the main conflict without spoilers
3. Appeals to ${options.audience || 'readers'}
4. Is 150-200 words
5. Ends with intrigue or a question

Make it compelling and marketable.`;

		const result = await this.langchain.generateWithTemplate('blurb_generation', content, {
			maxLength: 200,
			genre: options.genre,
			audience: options.audience,
			customPrompt: prompt,
		});

		return result.content;
	}

	private async generateMetadata(
		content: string,
		options: LangChainCompilationOptions
	): Promise<{
		tagline: string;
		themes: string[];
		settings: string[];
	}> {
		const prompt = `Extract key metadata from this ${options.genre || 'fiction'} work:

${content.slice(0, 1500)}...

Provide:
1. One compelling tagline (10-15 words)
2. 3-5 major themes
3. 3-5 key settings/locations

Format as JSON with fields: tagline, themes (array), settings (array)`;

		const result = await this.langchain.generateWithTemplate('metadata_extraction', content, {
			genre: options.genre,
			format: 'json',
			customPrompt: prompt,
		});

		try {
			const parsed = JSON.parse(result.content);
			return {
				tagline: parsed.tagline || 'A compelling story',
				themes: Array.isArray(parsed.themes) ? parsed.themes : [],
				settings: Array.isArray(parsed.settings) ? parsed.settings : [],
			};
		} catch {
			return {
				tagline: 'A compelling story',
				themes: [],
				settings: [],
			};
		}
	}

	private async generateQueryLetter(
		content: string,
		options: LangChainCompilationOptions
	): Promise<string> {
		const prompt = `Write a complete query letter for this ${options.genre || 'fiction'} work:

${content.slice(0, 2000)}...

Include:
1. Hook paragraph
2. Plot summary with stakes
3. Bio paragraph (placeholder)
4. Word count and genre
5. Professional closing

Maximum 250 words, agent-ready format.`;

		const result = await this.langchain.generateWithTemplate(
			'query_letter_generation',
			content,
			{
				maxLength: 250,
				style: 'professional',
				genre: options.genre,
				customPrompt: prompt,
			}
		);

		return result.content;
	}

	private async generatePitchParagraph(
		content: string,
		options: LangChainCompilationOptions
	): Promise<string> {
		const prompt = `Write a one-paragraph elevator pitch for this ${options.genre || 'fiction'} work:

${content.slice(0, 1500)}...

Create a 50-75 word pitch that:
1. Hooks immediately
2. Shows unique elements
3. Conveys commercial appeal
4. Could be delivered in 30 seconds

Make it memorable and marketable.`;

		const result = await this.langchain.generateWithTemplate('pitch_generation', content, {
			maxLength: 75,
			style: 'marketing',
			genre: options.genre,
			customPrompt: prompt,
		});

		return result.content;
	}

	private async generateComparisons(
		content: string,
		options: LangChainCompilationOptions
	): Promise<string[]> {
		const prompt = `Suggest 5 comparable works for this ${options.genre || 'fiction'} work:

${content.slice(0, 1500)}...

Provide comparisons that:
1. Are recent (within 5 years preferred)
2. Share similar themes, tone, or style
3. Are well-known enough for agents to recognize
4. Are appropriate for the target market
5. Show commercial viability

Format as "Title by Author" with brief reason.`;

		const result = await this.langchain.generateWithTemplate('comparison_generation', content, {
			genre: options.genre,
			audience: options.audience,
			customPrompt: prompt,
		});

		return result.content
			.split('\n')
			.filter((line) => line.trim().length > 0)
			.slice(0, 5);
	}

	private async assessQuality(
		content: string,
		target?: string
	): Promise<{
		score: number;
		suggestions: string[];
		issues: string[];
	}> {
		try {
			const prompt = `Assess the quality of this ${target || 'general'} content:

${content.slice(0, 1500)}...

Evaluate:
1. Clarity and readability
2. Engagement and hook strength
3. Professional presentation
4. Target audience appropriateness
5. Overall effectiveness

Provide:
- Quality score (0.0-1.0)
- 3 specific improvement suggestions
- Any major issues found

Format as JSON: {score: number, suggestions: [strings], issues: [strings]}`;

			const result = await this.langchain.generateWithTemplate(
				'quality_assessment',
				content,
				{
					target,
					format: 'json',
					customPrompt: prompt,
				}
			);

			const assessment = JSON.parse(result.content);
			return {
				score: Math.max(0, Math.min(1, assessment.score || 0.7)),
				suggestions: Array.isArray(assessment.suggestions)
					? assessment.suggestions.slice(0, 3)
					: [],
				issues: Array.isArray(assessment.issues) ? assessment.issues : [],
			};
		} catch (error) {
			const appError = new AppError('Quality assessment failed', ErrorCode.PROCESSING_ERROR, {
				originalError: (error as Error).message,
			});
			this.logger.warn(appError.message, appError.details as LogContext);
			return {
				score: 0.7,
				suggestions: ['Manual quality review recommended'],
				issues: ['Automated assessment unavailable'],
			};
		}
	}

	async batchCompile(
		batches: Array<{
			documents: Array<{ id: string; content: RTFContent | string; title: string }>;
			options: LangChainCompilationOptions;
			projectStats?: ProjectStatistics;
		}>
	): Promise<CompiledDocument[]> {
		this.logger.info(`Starting batch compilation for ${batches.length} batches`);

		const results: CompiledDocument[] = [];
		const concurrency = 2;

		for (let i = 0; i < batches.length; i += concurrency) {
			const batch = batches.slice(i, i + concurrency);

			const batchPromises = batch.map(async ({ documents, options, projectStats }) => {
				try {
					return await this.compileWithAI(documents, options, projectStats);
				} catch (error) {
					const appError = new AppError(
						'Batch compilation failed',
						ErrorCode.PROCESSING_ERROR,
						{ originalError: (error as Error).message }
					);
					this.logger.error(appError.message, appError.details as LogContext);
					const fallback = await super.compileDocuments(documents, options);
					return {
						content: fallback,
						metadata: {
							format: options.outputFormat || 'text',
							wordCount: 0,
							generatedElements: {},
							optimizations: ['batch-compilation-failed'],
							targetAudience: options.audience || 'general',
							compiledAt: new Date().toISOString(),
						},
						dynamicElements: {},
						quality: {
							score: 0,
							suggestions: [],
							issues: ['Batch compilation failed'],
						},
					};
				}
			});

			const batchResults = await Promise.all(batchPromises);
			results.push(...batchResults);

			if (i + concurrency < batches.length) {
				await AsyncUtils.sleep(100);
			}
		}

		this.logger.info(`Completed batch compilation with ${results.length} results`);
		return results;
	}

	/**
	 * Clear all caches
	 */
	clearCaches(): void {
		this.compilationCache.clear();
		this.elementCache.clear();
		this.qualityCache.clear();
		this.activeCompilations.clear();
		this.logger.debug('LangChain compilation caches cleared');
	}

	/**
	 * Get cache statistics for monitoring
	 */
	getCacheStats(): {
		compilation: { size: number; hitRate?: number };
		elements: { size: number; hitRate?: number };
		quality: { size: number; hitRate?: number };
		activeCompilations: number;
	} {
		return {
			compilation: { size: this.compilationCache.size },
			elements: { size: this.elementCache.size },
			quality: { size: this.qualityCache.size },
			activeCompilations: this.activeCompilations.size,
		};
	}
}
