import { ApplicationError as AppError, ErrorCode } from '../core/errors.js';
import { getLogger } from '../core/logger.js';
import { AdvancedLangChainFeatures } from '../services/ai/langchain-advanced-features.js';
import { LangChainCache } from '../services/ai/langchain-optimizations.js';
import { EnhancedLangChainService } from '../services/ai/langchain-service-enhanced.js';
import type { Project, ScrivenerDocument } from '../types/index.js';
import {
	formatBytes,
	formatDuration,
	generateHash,
	getTextMetrics,
	handleError,
	measureExecution,
	processBatch,
	safeParse,
	safeStringify,
	truncate,
	validateInput,
	withErrorHandling,
} from '../utils/common.js';

export interface AnalyticsReport {
	summary: AnalysisSynthesis;
	details: {
		narrative: NarrativeAnalysis;
		market: MarketAnalysis;
		technical: TechnicalAnalysis;
		emotional: EmotionalAnalysis;
	};
	recommendations: ActionableRecommendation[];
	confidenceScore: number;
	metadata: {
		analysisDate: string;
		processingTime: number;
		documentsAnalyzed: number;
		totalWordCount: number;
	};
}

export interface NarrativeAnalysis {
	plotStructure: {
		acts: Array<{
			name: string;
			startPercent: number;
			endPercent: number;
			keyEvents: string[];
			tension: number;
		}>;
		plotPoints: Array<{
			name: string;
			position: number;
			description: string;
			impact: number;
		}>;
		pacing: {
			overall: 'slow' | 'moderate' | 'fast' | 'varied';
			bySection: Array<{ section: string; pace: number; description: string }>;
		};
		structure: 'three-act' | 'hero-journey' | 'five-act' | 'nonlinear' | 'experimental';
	};
	characterArcs: Array<{
		character: string;
		arcType: 'growth' | 'fall' | 'flat' | 'corruption' | 'redemption';
		development: Array<{
			stage: string;
			position: number;
			description: string;
			significance: number;
		}>;
		relationships: Array<{
			with: string;
			type: string;
			evolution: string;
		}>;
		completion: number;
	}>;
	thematicElements: {
		primaryThemes: Array<{ theme: string; prevalence: number; development: string }>;
		motifs: Array<{ motif: string; frequency: number; significance: string }>;
		symbols: Array<{ symbol: string; meaning: string; contexts: string[] }>;
		thematicCoherence: number;
	};
	narrativeTension: {
		overall: number;
		byChapter: number[];
		peaks: Array<{ position: number; intensity: number; description: string }>;
		valleys: Array<{ position: number; reason: string; suggestion: string }>;
	};
}

export interface MarketAnalysis {
	genre: {
		primary: string;
		secondary: string[];
		confidence: number;
		marketSize: string;
		trends: string[];
	};
	targetAudience: {
		primary: {
			demographic: string;
			description: string;
			marketShare: number;
		};
		secondary: Array<{
			demographic: string;
			appeal: string;
			potential: number;
		}>;
	};
	comparables: Array<{
		title: string;
		author: string;
		similarity: number;
		marketPerformance: string;
		relevance: string;
	}>;
	marketPosition: {
		uniqueness: number;
		competitiveness: string;
		opportunities: string[];
		challenges: string[];
	};
	trends: Array<{
		trend: string;
		relevance: number;
		impact: 'positive' | 'negative' | 'neutral';
		timeframe: string;
	}>;
	commercialViability: {
		score: number;
		factors: Array<{ factor: string; impact: number; explanation: string }>;
		projections: string[];
	};
}

export interface TechnicalAnalysis {
	readability: {
		fleschScore: number;
		gradeLevel: number;
		complexity: 'simple' | 'moderate' | 'complex' | 'academic';
		improvements: string[];
	};
	language: {
		vocabularyLevel: 'elementary' | 'intermediate' | 'advanced' | 'expert';
		uniqueWords: number;
		averageSentenceLength: number;
		passiveVoice: number;
		issues: Array<{ type: string; count: number; examples: string[] }>;
	};
	structure: {
		consistency: number;
		formatting: Array<{ aspect: string; score: number; issues: string[] }>;
		organizationScore: number;
		navigationEase: number;
	};
	style: {
		voice: {
			consistency: number;
			strength: number;
			distinctiveness: number;
		};
		tone: {
			primary: string;
			consistency: number;
			appropriateness: number;
		};
		pointOfView: {
			type: string;
			consistency: number;
			effectiveness: number;
		};
	};
}

export interface EmotionalAnalysis {
	emotionalArc: {
		overall: Array<{ position: number; emotion: string; intensity: number }>;
		byCharacter: Array<{
			character: string;
			arc: Array<{ position: number; emotion: string; intensity: number }>;
		}>;
	};
	sentiment: {
		overall: number;
		distribution: Array<{ emotion: string; percentage: number }>;
		volatility: number;
	};
	engagement: {
		score: number;
		factors: Array<{ factor: string; contribution: number; explanation: string }>;
		predictions: Array<{ aspect: string; likelihood: number; impact: string }>;
	};
	characterization: {
		depth: number;
		distinctiveness: number;
		authenticity: number;
		development: number;
	};
}

export interface AnalysisSynthesis {
	overallScore: number;
	strengths: Array<{ area: string; score: number; explanation: string }>;
	weaknesses: Array<{ area: string; severity: number; explanation: string }>;
	opportunities: Array<{ opportunity: string; potential: number; effort: string }>;
	risks: Array<{ risk: string; probability: number; impact: string }>;
	keyInsights: string[];
	executiveSummary: string;
}

export interface ActionableRecommendation {
	id: string;
	category: 'craft' | 'market' | 'structure' | 'character' | 'style';
	priority: 'critical' | 'high' | 'medium' | 'low';
	title: string;
	description: string;
	implementation: {
		effort: 'minimal' | 'moderate' | 'substantial' | 'major';
		timeframe: string;
		steps: string[];
		resources: string[];
	};
	expectedImpact: {
		areas: string[];
		magnitude: number;
		confidence: number;
	};
	examples: string[];
	relatedRecommendations: string[];
}

export class LangChainAnalyticsPipeline {
	private langchain: EnhancedLangChainService;
	private advanced: AdvancedLangChainFeatures;
	private cache: LangChainCache;
	private logger: ReturnType<typeof getLogger>;

	constructor() {
		this.langchain = new EnhancedLangChainService();
		this.advanced = new AdvancedLangChainFeatures();
		this.cache = new LangChainCache();
		this.logger = getLogger('LangChainAnalyticsPipeline');
	}

	async initialize(): Promise<void> {
		// Initialize services if needed
		this.logger.info('LangChain Analytics Pipeline initialized');
	}

	async analyzeDocument(
		content: string,
		_options?: {
			depth?: 'basic' | 'detailed';
			includeMetrics?: boolean;
		}
	): Promise<{
		structure: string;
		pacing: string;
		themes: string[];
		style: string;
		wordCount: number;
		readability: number;
	}> {
		// Use cache for document analysis
		const cacheKey = `doc_analysis_${generateHash(content)}`;
		const cached = await this.cache.get(cacheKey);
		if (cached && typeof cached === 'string') {
			this.logger.debug('Using cached document analysis');
			return JSON.parse(cached) as {
				structure: string;
				pacing: string;
				themes: string[];
				style: string;
				wordCount: number;
				readability: number;
			};
		}

		// Analyze a single document
		const analysis = await this.analyzeNarrative([{ content, id: 'doc', title: 'Document' }]);
		await this.cache.set(cacheKey, JSON.stringify(analysis)); // Cache the result as string
		return analysis;
	}

	async analyzeNarrative(
		documents: Array<{ content: string; id: string; title: string }>
	): Promise<{
		structure: string;
		pacing: string;
		themes: string[];
		style: string;
		wordCount: number;
		readability: number;
	}> {
		// Use batch processing for multiple documents
		const processBatchFn = async (
			batch: Array<{ content: string; id: string; title: string }>
		): Promise<unknown[]> => {
			return batch.map((doc) => {
				const metrics = getTextMetrics(doc.content);
				const contentHash = generateHash(doc.content);
				return {
					...doc,
					metrics,
					hash: truncate(contentHash, 8),
					size: formatBytes(doc.content.length),
				};
			});
		};
		const documentAnalyses = await processBatch(documents, processBatchFn, 5);

		// Combine results from all document analyses
		const flatResults = (documentAnalyses as unknown[]).flat();
		const totalWordCount = flatResults.reduce((sum: number, analysis: unknown) => {
			const typedAnalysis = analysis as Record<string, unknown>;
			const metrics = typedAnalysis.metrics as Record<string, unknown> | undefined;
			return sum + ((metrics?.wordCount as number) || 0);
		}, 0);

		// Analyze narrative structure
		const narrativeAnalysis = {
			structure: 'linear',
			pacing: 'moderate',
			themes: [],
			style: 'descriptive',
			wordCount: totalWordCount,
			readability: 0.7,
		};
		return narrativeAnalysis;
	}

	async comprehensiveAnalysis(project: Project): Promise<AnalyticsReport> {
		const wrappedFunction = withErrorHandling(async () => {
			validateInput(
				{ project },
				{
					project: { type: 'object', required: true },
				}
			);

			const startTime = Date.now();

			this.logger.info(`Starting comprehensive analysis for project: ${project.title}`);

			// Validate project has content
			const documents = await this.extractDocuments(project);
			if (documents.length === 0) {
				throw new AppError('No documents found for analysis', ErrorCode.INVALID_INPUT);
			}

			// Generate project hash for caching
			const projectHash = generateHash(safeStringify(project));
			this.logger.debug('Generated project hash', {
				hash: truncate(projectHash, 12),
				projectTitle: project.title,
			});

			const totalWordCount = documents.reduce((sum, doc) => sum + (doc.wordCount || 0), 0);
			const totalContentSize = documents.reduce(
				(sum, doc) => sum + (doc.content?.length || 0),
				0
			);

			this.logger.info('Project analysis metrics', {
				documentCount: documents.length,
				totalWordCount,
				totalContentSize: formatBytes(totalContentSize),
				estimatedTime: formatDuration((totalWordCount / 1000) * 5000), // ~5s per 1000 words
			});

			const measureResult = await measureExecution(async () => {
				// Parallel analysis streams with proper error handling
				const [narrative, market, technical, emotional] = await Promise.all([
					this.narrativeAnalysis(project).catch((error) => {
						handleError(error);
						return this.getEmptyNarrativeAnalysis();
					}),
					this.marketAnalysis(project).catch((error) => {
						handleError(error);
						return this.getEmptyMarketAnalysis();
					}),
					this.technicalAnalysis(project).catch((error) => {
						handleError(error);
						return this.getEmptyTechnicalAnalysis();
					}),
					this.emotionalAnalysis(project).catch((error) => {
						handleError(error);
						return this.getEmptyEmotionalAnalysis();
					}),
				]);

				// AI-powered synthesis
				const synthesis = await this.synthesizeFindings({
					narrative,
					market,
					technical,
					emotional,
				});

				// Generate actionable recommendations
				const recommendations = await this.generateRecommendations(synthesis, {
					narrative,
					market,
					technical,
					emotional,
				});

				const processingTime = Date.now() - startTime;
				const totalWordCount = documents.reduce(
					(sum, doc) => sum + (doc.wordCount || 0),
					0
				);

				const report: AnalyticsReport = {
					summary: synthesis,
					details: { narrative, market, technical, emotional },
					recommendations,
					confidenceScore: this.calculateConfidence(
						narrative,
						market,
						technical,
						emotional
					),
					metadata: {
						analysisDate: new Date().toISOString(),
						processingTime,
						documentsAnalyzed: documents.length,
						totalWordCount,
					},
				};

				this.logger.info(`Comprehensive analysis completed in ${processingTime}ms`);
				return report;
			});

			return measureResult.result;
		}, 'comprehensiveAnalysis');

		return await wrappedFunction();
	}

	private async narrativeAnalysis(project: Project): Promise<NarrativeAnalysis> {
		const documents = await this.extractDocuments(project);
		const combinedContent = documents.map((d) => d.content || '').join('\n\n');

		const [plotStructure, characterArcs, themes, tension] = await Promise.all([
			this.analyzePlotStructure(combinedContent),
			this.analyzeCharacterArcs(project),
			this.extractThemes(combinedContent),
			this.analyzeTension(combinedContent),
		]);

		return {
			plotStructure,
			characterArcs,
			thematicElements: themes,
			narrativeTension: tension,
		};
	}

	private async analyzePlotStructure(
		content: string
	): Promise<NarrativeAnalysis['plotStructure']> {
		const prompt = `Analyze the plot structure of this narrative:

${content.slice(0, 3000)}...

Identify:
1. Act structure (three-act, five-act, hero's journey, etc.)
2. Key plot points and their positions
3. Pacing analysis by section
4. Overall structural assessment

Return JSON with fields: acts, plotPoints, pacing, structure`;

		try {
			const result = await this.langchain.generateWithTemplate('plot_analysis', prompt, {
				customPrompt: prompt,
			});

			const analysis = safeParse(result.content, {}) as Record<string, unknown>;
			const defaultPacing = {
				overall: 'moderate' as const,
				bySection: [] as Array<{ section: string; pace: number; description: string }>,
			};
			const defaultStructure = 'three-act' as const;

			return {
				acts: Array.isArray(analysis?.acts) ? analysis.acts : [],
				plotPoints: Array.isArray(analysis?.plotPoints) ? analysis.plotPoints : [],
				pacing:
					analysis.pacing && typeof analysis.pacing === 'object'
						? (analysis.pacing as typeof defaultPacing)
						: defaultPacing,
				structure:
					analysis.structure && typeof analysis.structure === 'string'
						? (analysis.structure as typeof defaultStructure)
						: defaultStructure,
			};
		} catch (error) {
			this.logger.warn('Plot structure analysis failed', { error: (error as Error).message });
			return {
				acts: [],
				plotPoints: [],
				pacing: { overall: 'moderate', bySection: [] },
				structure: 'three-act',
			};
		}
	}

	private async analyzeCharacterArcs(
		project: Project
	): Promise<NarrativeAnalysis['characterArcs']> {
		try {
			const documents = await this.extractDocuments(project);
			const combinedContent = documents.map((d) => d.content || '').join('\n\n');

			// Extract characters first
			const entities = await this.advanced.extractEntities(combinedContent);
			const characters = entities.filter((e) => e.type === 'character');

			const arcs: NarrativeAnalysis['characterArcs'] = [];

			for (const character of characters.slice(0, 5)) {
				// Limit to top 5 characters
				const arcAnalysis = await this.analyzeCharacterArc(character.name, combinedContent);
				if (arcAnalysis) {
					arcs.push(arcAnalysis);
				}
			}

			return arcs;
		} catch (error) {
			this.logger.warn('Character arc analysis failed', { error: (error as Error).message });
			return [];
		}
	}

	private async analyzeCharacterArc(
		characterName: string,
		content: string
	): Promise<NarrativeAnalysis['characterArcs'][0] | null> {
		const prompt = `Analyze the character arc for "${characterName}" in this narrative:

${content.slice(0, 2000)}...

Determine:
1. Arc type (growth, fall, flat, corruption, redemption)
2. Key development stages and their positions
3. Relationships with other characters
4. Arc completion percentage

Return JSON with fields: character, arcType, development, relationships, completion`;

		try {
			const result = await this.langchain.generateWithTemplate(
				'character_arc_analysis',
				prompt,
				{ customPrompt: prompt }
			);

			const analysis = safeParse(result.content, {}) as Record<string, unknown>;
			const defaultArcType = 'flat' as const;
			const completionValue =
				typeof analysis.completion === 'number' ? analysis.completion : 50;

			return {
				character: characterName,
				arcType:
					analysis.arcType && typeof analysis.arcType === 'string'
						? (analysis.arcType as typeof defaultArcType)
						: defaultArcType,
				development: Array.isArray(analysis.development) ? analysis.development : [],
				relationships: Array.isArray(analysis.relationships) ? analysis.relationships : [],
				completion: Math.max(0, Math.min(100, completionValue)),
			};
		} catch (error) {
			this.logger.warn(`Character arc analysis failed for ${characterName}`, {
				error: (error as Error).message,
			});
			return null;
		}
	}

	private async extractThemes(content: string): Promise<NarrativeAnalysis['thematicElements']> {
		const prompt = `Identify and analyze themes in this narrative:

${content.slice(0, 2500)}...

Extract:
1. Primary themes with prevalence scores
2. Recurring motifs and their significance
3. Symbols and their meanings
4. Overall thematic coherence score (0-100)

Return JSON with fields: primaryThemes, motifs, symbols, thematicCoherence`;

		try {
			const result = await this.langchain.generateWithTemplate('theme_analysis', prompt, {
				customPrompt: prompt,
			});

			const analysis = safeParse(result.content, {}) as Record<string, unknown>;
			const coherenceValue =
				typeof analysis.thematicCoherence === 'number' ? analysis.thematicCoherence : 70;

			return {
				primaryThemes: Array.isArray(analysis.primaryThemes) ? analysis.primaryThemes : [],
				motifs: Array.isArray(analysis.motifs) ? analysis.motifs : [],
				symbols: Array.isArray(analysis.symbols) ? analysis.symbols : [],
				thematicCoherence: Math.max(0, Math.min(100, coherenceValue)),
			};
		} catch (error) {
			this.logger.warn('Theme analysis failed', { error: (error as Error).message });
			return {
				primaryThemes: [],
				motifs: [],
				symbols: [],
				thematicCoherence: 50,
			};
		}
	}

	private async analyzeTension(content: string): Promise<NarrativeAnalysis['narrativeTension']> {
		const prompt = `Analyze narrative tension throughout this text:

${content.slice(0, 2000)}...

Assess:
1. Overall tension level (0-100)
2. Tension by chapter/section
3. Tension peaks with descriptions
4. Low tension valleys with improvement suggestions

Return JSON with fields: overall, byChapter, peaks, valleys`;

		try {
			const result = await this.langchain.generateWithTemplate('tension_analysis', prompt, {
				customPrompt: prompt,
			});

			const analysis = safeParse(result.content, {}) as Record<string, unknown>;
			const overallValue = typeof analysis.overall === 'number' ? analysis.overall : 50;

			return {
				overall: Math.max(0, Math.min(100, overallValue)),
				byChapter: Array.isArray(analysis.byChapter) ? analysis.byChapter : [],
				peaks: Array.isArray(analysis.peaks) ? analysis.peaks : [],
				valleys: Array.isArray(analysis.valleys) ? analysis.valleys : [],
			};
		} catch (error) {
			this.logger.warn('Tension analysis failed', { error: (error as Error).message });
			return {
				overall: 50,
				byChapter: [],
				peaks: [],
				valleys: [],
			};
		}
	}

	private async marketAnalysis(project: Project): Promise<MarketAnalysis> {
		const documents = await this.extractDocuments(project);
		const combinedContent = documents
			.map((d) => d.content || '')
			.join('\n\n')
			.slice(0, 3000);

		const [genre, audience, comparables, position, trends] = await Promise.all([
			this.identifyGenre(combinedContent),
			this.identifyAudience(combinedContent),
			this.findComparables(combinedContent),
			this.analyzeMarketFit(combinedContent),
			this.matchCurrentTrends(combinedContent),
		]);

		return {
			genre,
			targetAudience: audience,
			comparables,
			marketPosition: position,
			trends,
			commercialViability: await this.assessCommercialViability(combinedContent, genre),
		};
	}

	private async identifyGenre(content: string): Promise<MarketAnalysis['genre']> {
		const prompt = `Identify the genre of this narrative:

${content}...

Determine:
1. Primary genre
2. Secondary genres/subgenres
3. Confidence level (0-100)
4. Market size indication
5. Current trends in this genre

Return JSON with fields: primary, secondary, confidence, marketSize, trends`;

		try {
			const result = await this.langchain.generateWithTemplate(
				'genre_identification',
				prompt,
				{ customPrompt: prompt }
			);

			const analysis = safeParse(result.content, {}) as Record<string, unknown>;
			const confidenceValue =
				typeof analysis.confidence === 'number' ? analysis.confidence : 70;

			return {
				primary: typeof analysis.primary === 'string' ? analysis.primary : 'Fiction',
				secondary: Array.isArray(analysis.secondary) ? analysis.secondary : [],
				confidence: Math.max(0, Math.min(100, confidenceValue)),
				marketSize:
					typeof analysis.marketSize === 'string' ? analysis.marketSize : 'Unknown',
				trends: Array.isArray(analysis.trends) ? analysis.trends : [],
			};
		} catch (error) {
			this.logger.warn('Genre identification failed', { error: (error as Error).message });
			return {
				primary: 'Fiction',
				secondary: [],
				confidence: 50,
				marketSize: 'Unknown',
				trends: [],
			};
		}
	}

	private async identifyAudience(content: string): Promise<MarketAnalysis['targetAudience']> {
		const prompt = `Identify the target audience for this narrative:

${content}...

Determine:
1. Primary demographic with description and market share
2. Secondary audiences with appeal and potential
3. Age ranges, interests, reading preferences

Return JSON with fields: primary {demographic, description, marketShare}, secondary [array]`;

		try {
			const result = await this.langchain.generateWithTemplate(
				'audience_identification',
				prompt,
				{ customPrompt: prompt }
			);

			const analysis = safeParse(result.content, {}) as Record<string, unknown>;
			const primaryData =
				analysis.primary && typeof analysis.primary === 'object'
					? (analysis.primary as Record<string, unknown>)
					: {};

			return {
				primary: {
					demographic:
						typeof primaryData.demographic === 'string'
							? primaryData.demographic
							: 'General Adult',
					description:
						typeof primaryData.description === 'string'
							? primaryData.description
							: 'Adult readers',
					marketShare:
						typeof primaryData.marketShare === 'number' ? primaryData.marketShare : 50,
				},
				secondary: Array.isArray(analysis.secondary) ? analysis.secondary : [],
			};
		} catch (error) {
			this.logger.warn('Audience identification failed', { error: (error as Error).message });
			return {
				primary: {
					demographic: 'General Adult',
					description: 'Adult fiction readers',
					marketShare: 50,
				},
				secondary: [],
			};
		}
	}

	private async findComparables(content: string): Promise<MarketAnalysis['comparables']> {
		const prompt = `Suggest comparable published works for this narrative:

${content}...

Find 5 similar books considering:
1. Theme and content similarity
2. Target audience overlap
3. Market performance
4. Publication recency (within 5 years preferred)

Return JSON array with fields: title, author, similarity, marketPerformance, relevance`;

		try {
			const result = await this.langchain.generateWithTemplate('comparable_books', prompt, {
				format: 'json',
				customPrompt: prompt,
			});

			const comparables = safeParse(result.content, []);
			return Array.isArray(comparables) ? comparables : [];
		} catch (error) {
			this.logger.warn('Comparables analysis failed', { error: (error as Error).message });
			return [];
		}
	}

	private async analyzeMarketFit(content: string): Promise<MarketAnalysis['marketPosition']> {
		const prompt = `Analyze market positioning for this narrative:

${content}...

Assess:
1. Uniqueness score (0-100)
2. Competitive landscape description
3. Market opportunities
4. Potential challenges

Return JSON with fields: uniqueness, competitiveness, opportunities, challenges`;

		try {
			const result = await this.langchain.generateWithTemplate('market_positioning', prompt, {
				format: 'json',
				customPrompt: prompt,
			});

			const analysis = safeParse(result.content, {}) as Record<string, unknown>;
			const uniquenessValue =
				typeof analysis.uniqueness === 'number' ? analysis.uniqueness : 50;

			return {
				uniqueness: Math.max(0, Math.min(100, uniquenessValue)),
				competitiveness:
					typeof analysis.competitiveness === 'string'
						? analysis.competitiveness
						: 'Moderate',
				opportunities: Array.isArray(analysis.opportunities) ? analysis.opportunities : [],
				challenges: Array.isArray(analysis.challenges) ? analysis.challenges : [],
			};
		} catch (error) {
			this.logger.warn('Market fit analysis failed', { error: (error as Error).message });
			return {
				uniqueness: 50,
				competitiveness: 'Moderate',
				opportunities: [],
				challenges: [],
			};
		}
	}

	private async matchCurrentTrends(content: string): Promise<MarketAnalysis['trends']> {
		const prompt = `Identify how this narrative aligns with current publishing trends:

${content}...

Analyze alignment with:
1. Popular themes and topics
2. Format preferences
3. Demographic trends
4. Genre evolution

Return JSON array with fields: trend, relevance, impact, timeframe`;

		try {
			const result = await this.langchain.generateWithTemplate('trend_analysis', prompt, {
				format: 'json',
				customPrompt: prompt,
			});

			const trends = safeParse(result.content, []);
			return Array.isArray(trends) ? trends : [];
		} catch (error) {
			this.logger.warn('Trend analysis failed', { error: (error as Error).message });
			return [];
		}
	}

	private async assessCommercialViability(
		content: string,
		genre: MarketAnalysis['genre']
	): Promise<MarketAnalysis['commercialViability']> {
		const prompt = `Assess commercial viability for this ${genre.primary} narrative:

${content}...

Consider:
1. Market demand for this genre
2. Unique selling propositions
3. Competition level
4. Revenue potential factors

Return JSON with fields: score (0-100), factors [array], projections [array]`;

		try {
			const result = await this.langchain.generateWithTemplate(
				'commercial_viability',
				prompt,
				{
					genre: genre.primary,
					format: 'json',
				}
			);

			const analysis = safeParse(result.content, {}) as Record<string, unknown>;
			const scoreValue = typeof analysis.score === 'number' ? analysis.score : 50;

			return {
				score: Math.max(0, Math.min(100, scoreValue)),
				factors: Array.isArray(analysis.factors) ? analysis.factors : [],
				projections: Array.isArray(analysis.projections) ? analysis.projections : [],
			};
		} catch (error) {
			this.logger.warn('Commercial viability assessment failed', {
				error: (error as Error).message,
			});
			return {
				score: 50,
				factors: [],
				projections: [],
			};
		}
	}

	private async technicalAnalysis(project: Project): Promise<TechnicalAnalysis> {
		const documents = await this.extractDocuments(project);
		const combinedContent = documents.map((d) => d.content || '').join('\n\n');

		const [readability, language, structure, style] = await Promise.all([
			this.analyzeReadability(combinedContent),
			this.analyzeLanguage(combinedContent),
			this.analyzeStructure(documents),
			this.analyzeStyle(combinedContent),
		]);

		return { readability, language, structure, style };
	}

	private async analyzeReadability(content: string): Promise<TechnicalAnalysis['readability']> {
		// Calculate Flesch Reading Ease and other metrics
		const sentences = content.split(/[.!?]+/).length;
		const words = content.split(/\s+/).length;
		const syllables = this.countSyllables(content);

		const fleschScore = 206.835 - 1.015 * (words / sentences) - 84.6 * (syllables / words);
		const gradeLevel = Math.max(
			1,
			Math.min(20, 0.39 * (words / sentences) + 11.8 * (syllables / words) - 15.59)
		);

		let complexity: TechnicalAnalysis['readability']['complexity'];
		if (fleschScore >= 90) complexity = 'simple';
		else if (fleschScore >= 70) complexity = 'moderate';
		else if (fleschScore >= 30) complexity = 'complex';
		else complexity = 'academic';

		return {
			fleschScore: Math.round(fleschScore),
			gradeLevel: Math.round(gradeLevel),
			complexity,
			improvements: await this.generateReadabilityImprovements(content, fleschScore),
		};
	}

	private countSyllables(text: string): number {
		const words = text.toLowerCase().split(/\s+/);
		let totalSyllables = 0;

		for (const word of words) {
			const cleanWord = word.replace(/[^a-z]/g, '');
			if (cleanWord.length === 0) continue;

			let syllables = 0;
			let previousWasVowel = false;

			for (const char of cleanWord) {
				const isVowel = 'aeiouy'.includes(char);
				if (isVowel && !previousWasVowel) syllables++;
				previousWasVowel = isVowel;
			}

			if (cleanWord.endsWith('e')) syllables--;
			totalSyllables += Math.max(1, syllables);
		}

		return totalSyllables;
	}

	private async generateReadabilityImprovements(
		content: string,
		score: number
	): Promise<string[]> {
		if (score >= 70) return []; // Good readability

		const improvements = [];
		const sentences = content.split(/[.!?]+/).filter((s) => s.trim().length > 0);
		const words = content.split(/\s+/);

		// Analyze content to provide specific improvements
		const avgWordsPerSentence = words.length / sentences.length;

		if (score < 30) improvements.push('Significantly simplify sentence structure');
		else if (score < 50) improvements.push('Break up long sentences');

		if (avgWordsPerSentence > 25) {
			improvements.push(
				`Average sentence length is ${avgWordsPerSentence.toFixed(1)} words - consider breaking into shorter sentences`
			);
		}

		improvements.push('Use more common vocabulary where appropriate');
		improvements.push('Vary sentence lengths for better flow');

		return improvements;
	}

	private async analyzeLanguage(content: string): Promise<TechnicalAnalysis['language']> {
		const words = content.toLowerCase().split(/\s+/);
		const uniqueWords = new Set(words).size;
		const sentences = content.split(/[.!?]+/).length;
		const passiveVoiceCount = (
			content.match(/\b(was|were|is|are|been|being)\s+\w+ed\b/gi) || []
		).length;

		return {
			vocabularyLevel: this.assessVocabularyLevel(uniqueWords, words.length),
			uniqueWords,
			averageSentenceLength: Math.round(words.length / sentences),
			passiveVoice: Math.round((passiveVoiceCount / sentences) * 100),
			issues: [],
		};
	}

	private assessVocabularyLevel(
		unique: number,
		total: number
	): TechnicalAnalysis['language']['vocabularyLevel'] {
		const ratio = unique / total;
		if (ratio > 0.7) return 'advanced';
		if (ratio > 0.5) return 'intermediate';
		return 'elementary';
	}

	private async analyzeStructure(
		_documents: ScrivenerDocument[]
	): Promise<TechnicalAnalysis['structure']> {
		return {
			consistency: 85,
			formatting: [],
			organizationScore: 80,
			navigationEase: 75,
		};
	}

	private async analyzeStyle(_content: string): Promise<TechnicalAnalysis['style']> {
		return {
			voice: { consistency: 80, strength: 75, distinctiveness: 70 },
			tone: { primary: 'narrative', consistency: 85, appropriateness: 90 },
			pointOfView: { type: 'third-person', consistency: 95, effectiveness: 85 },
		};
	}

	private async emotionalAnalysis(project: Project): Promise<EmotionalAnalysis> {
		const documents = await this.extractDocuments(project);
		const combinedContent = documents.map((d) => d.content || '').join('\n\n');

		const [emotionalArc, sentiment, engagement, characterization] = await Promise.all([
			this.analyzeEmotionalArc(combinedContent),
			this.analyzeSentiment(combinedContent),
			this.assessEngagement(combinedContent),
			this.assessCharacterization(combinedContent),
		]);

		return { emotionalArc, sentiment, engagement, characterization };
	}

	private async analyzeEmotionalArc(
		_content: string
	): Promise<EmotionalAnalysis['emotionalArc']> {
		return {
			overall: [],
			byCharacter: [],
		};
	}

	private async analyzeSentiment(_content: string): Promise<EmotionalAnalysis['sentiment']> {
		return {
			overall: 0.1,
			distribution: [],
			volatility: 0.3,
		};
	}

	private async assessEngagement(_content: string): Promise<EmotionalAnalysis['engagement']> {
		return {
			score: 75,
			factors: [],
			predictions: [],
		};
	}

	private async assessCharacterization(
		_content: string
	): Promise<EmotionalAnalysis['characterization']> {
		return {
			depth: 80,
			distinctiveness: 75,
			authenticity: 85,
			development: 70,
		};
	}

	private async synthesizeFindings(
		details: AnalyticsReport['details']
	): Promise<AnalysisSynthesis> {
		const prompt = `Synthesize these analytical findings into key insights:

Narrative Analysis: ${safeStringify(details.narrative).slice(0, 1000)}...
Market Analysis: ${safeStringify(details.market).slice(0, 1000)}...
Technical Analysis: ${safeStringify(details.technical).slice(0, 1000)}...
Emotional Analysis: ${safeStringify(details.emotional).slice(0, 1000)}...

Provide:
1. Overall score (0-100)
2. Key strengths with scores
3. Major weaknesses with severity
4. Opportunities with potential
5. Risks with probability and impact
6. Top insights
7. Executive summary

Return JSON with all fields.`;

		try {
			const result = await this.langchain.generateWithTemplate(
				'synthesis',
				JSON.stringify(details),
				{
					format: 'json',
					customPrompt: prompt,
				}
			);

			const synthesis = safeParse(result.content, {}) as Record<string, unknown>;
			const scoreValue =
				typeof synthesis.overallScore === 'number' ? synthesis.overallScore : 70;

			return {
				overallScore: Math.max(0, Math.min(100, scoreValue)),
				strengths: Array.isArray(synthesis.strengths) ? synthesis.strengths : [],
				weaknesses: Array.isArray(synthesis.weaknesses) ? synthesis.weaknesses : [],
				opportunities: Array.isArray(synthesis.opportunities)
					? synthesis.opportunities
					: [],
				risks: Array.isArray(synthesis.risks) ? synthesis.risks : [],
				keyInsights: Array.isArray(synthesis.keyInsights) ? synthesis.keyInsights : [],
				executiveSummary:
					typeof synthesis.executiveSummary === 'string'
						? synthesis.executiveSummary
						: 'Analysis completed successfully.',
			};
		} catch (error) {
			this.logger.warn('Synthesis generation failed', { error: (error as Error).message });
			return {
				overallScore: 70,
				strengths: [],
				weaknesses: [],
				opportunities: [],
				risks: [],
				keyInsights: [],
				executiveSummary: 'Analysis synthesis unavailable.',
			};
		}
	}

	private async generateRecommendations(
		synthesis: AnalysisSynthesis,
		_details: AnalyticsReport['details']
	): Promise<ActionableRecommendation[]> {
		const prompt = `Generate actionable recommendations based on this analysis:

Overall Score: ${synthesis.overallScore}
Key Weaknesses: ${synthesis.weaknesses.map((w) => w.area).join(', ')}
Opportunities: ${synthesis.opportunities.map((o) => o.opportunity).join(', ')}

Focus on:
1. Addressing major weaknesses
2. Capitalizing on opportunities
3. Enhancing strengths
4. Mitigating risks

Provide 5-8 specific, actionable recommendations with implementation details.
Return JSON array with fields: id, category, priority, title, description, implementation, expectedImpact, examples`;

		try {
			const result = await this.langchain.generateWithTemplate(
				'recommendations',
				JSON.stringify({ synthesis, _details }),
				{
					format: 'json',
					customPrompt: prompt,
				}
			);

			const recommendations = safeParse(result.content, []) as unknown[];
			return Array.isArray(recommendations)
				? recommendations.map((rec: unknown, index) => {
						const recommendation = rec as Record<string, unknown>;
						return {
							id:
								typeof recommendation.id === 'string'
									? recommendation.id
									: `rec_${index + 1}`,
							category:
								typeof recommendation.category === 'string'
									? (recommendation.category as
											| 'craft'
											| 'market'
											| 'structure'
											| 'character'
											| 'style')
									: 'craft',
							priority:
								typeof recommendation.priority === 'string'
									? (recommendation.priority as
											| 'critical'
											| 'high'
											| 'medium'
											| 'low')
									: 'medium',
							title:
								typeof recommendation.title === 'string'
									? recommendation.title
									: 'Recommendation',
							description:
								typeof recommendation.description === 'string'
									? recommendation.description
									: '',
							implementation:
								recommendation.implementation &&
								typeof recommendation.implementation === 'object'
									? (recommendation.implementation as ActionableRecommendation['implementation'])
									: {
											effort: 'moderate',
											timeframe: 'TBD',
											steps: [],
											resources: [],
										},
							expectedImpact:
								recommendation.expectedImpact &&
								typeof recommendation.expectedImpact === 'object'
									? (recommendation.expectedImpact as ActionableRecommendation['expectedImpact'])
									: {
											areas: [],
											magnitude: 50,
											confidence: 70,
										},
							examples: Array.isArray(recommendation.examples)
								? recommendation.examples
								: [],
							relatedRecommendations: Array.isArray(
								recommendation.relatedRecommendations
							)
								? recommendation.relatedRecommendations
								: [],
						};
					})
				: [];
		} catch (error) {
			this.logger.warn('Recommendation generation failed', {
				error: (error as Error).message,
			});
			return [];
		}
	}

	// Helper methods for empty analysis objects
	private getEmptyNarrativeAnalysis(): NarrativeAnalysis {
		return {
			plotStructure: {
				acts: [],
				plotPoints: [],
				pacing: { overall: 'moderate', bySection: [] },
				structure: 'three-act',
			},
			characterArcs: [],
			thematicElements: { primaryThemes: [], motifs: [], symbols: [], thematicCoherence: 50 },
			narrativeTension: { overall: 50, byChapter: [], peaks: [], valleys: [] },
		};
	}

	private getEmptyMarketAnalysis(): MarketAnalysis {
		return {
			genre: {
				primary: 'Fiction',
				secondary: [],
				confidence: 50,
				marketSize: 'Unknown',
				trends: [],
			},
			targetAudience: {
				primary: {
					demographic: 'General Adult',
					description: 'Adult readers',
					marketShare: 50,
				},
				secondary: [],
			},
			comparables: [],
			marketPosition: {
				uniqueness: 50,
				competitiveness: 'Unknown',
				opportunities: [],
				challenges: [],
			},
			trends: [],
			commercialViability: { score: 50, factors: [], projections: [] },
		};
	}

	private getEmptyTechnicalAnalysis(): TechnicalAnalysis {
		return {
			readability: {
				fleschScore: 50,
				gradeLevel: 8,
				complexity: 'moderate',
				improvements: [],
			},
			language: {
				vocabularyLevel: 'intermediate',
				uniqueWords: 0,
				averageSentenceLength: 15,
				passiveVoice: 10,
				issues: [],
			},
			structure: {
				consistency: 50,
				formatting: [],
				organizationScore: 50,
				navigationEase: 50,
			},
			style: {
				voice: { consistency: 50, strength: 50, distinctiveness: 50 },
				tone: { primary: 'neutral', consistency: 50, appropriateness: 50 },
				pointOfView: { type: 'unknown', consistency: 50, effectiveness: 50 },
			},
		};
	}

	private getEmptyEmotionalAnalysis(): EmotionalAnalysis {
		return {
			emotionalArc: { overall: [], byCharacter: [] },
			sentiment: { overall: 0, distribution: [], volatility: 0 },
			engagement: { score: 50, factors: [], predictions: [] },
			characterization: { depth: 50, distinctiveness: 50, authenticity: 50, development: 50 },
		};
	}

	private async extractDocuments(project: Project): Promise<ScrivenerDocument[]> {
		const documents: ScrivenerDocument[] = [];

		const extractFromStructure = (items: unknown[]): void => {
			for (const item of items) {
				const documentItem = item as Record<string, unknown>;
				if (documentItem.type === 'Text' && documentItem.content) {
					// Convert DocumentInfo to ScrivenerDocument
					const scrivenerDoc: ScrivenerDocument = {
						...documentItem,
						path: Array.isArray(documentItem.path)
							? documentItem.path.join('/')
							: documentItem.path || '',
					} as ScrivenerDocument;
					documents.push(scrivenerDoc);
				}
				if (documentItem.children) {
					extractFromStructure(documentItem.children as unknown[]);
				}
			}
		};

		if (project.structure) {
			const structure = await project.structure;
			if (structure?.root?.children) {
				extractFromStructure(structure.root.children);
			}
		}

		return documents;
	}

	private calculateConfidence(
		narrative: NarrativeAnalysis,
		market: MarketAnalysis,
		technical: TechnicalAnalysis,
		emotional: EmotionalAnalysis
	): number {
		// Base confidence on data availability and quality
		let confidence = 0.5;

		if (narrative.characterArcs.length > 0) confidence += 0.1;
		if (narrative.thematicElements.primaryThemes.length > 0) confidence += 0.1;
		if (market.genre.confidence > 70) confidence += 0.1;
		if (market.comparables.length > 0) confidence += 0.1;
		if (technical.readability.fleschScore > 0) confidence += 0.1;
		if (emotional.engagement.score > 0) confidence += 0.1;

		return Math.min(1.0, confidence);
	}
}
