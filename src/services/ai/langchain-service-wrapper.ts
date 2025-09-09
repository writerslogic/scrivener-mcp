/**
 * LangChain Service Wrapper
 * Provides backward compatibility while using enhanced features internally
 */

import { EnhancedLangChainService } from './langchain-service-enhanced.js';
import { AdvancedLangChainFeatures } from './langchain-advanced-features.js';
import type { ScrivenerDocument } from '../../types/index.js';
import type { Document as LangchainDocument } from 'langchain/document';
import { getLogger } from '../../core/logger.js';
import { createError, ErrorCode } from '../../core/errors.js';

interface ChunkingOptions {
	chunkSize?: number;
	chunkOverlap?: number;
	separators?: string[];
}

interface RAGOptions {
	topK?: number;
	temperature?: number;
	maxTokens?: number;
}

/**
 * Drop-in replacement for the original LangChainService
 * Uses enhanced features internally while maintaining the same API
 */
export class LangChainService {
	private enhancedService: EnhancedLangChainService;
	private advancedFeatures: AdvancedLangChainFeatures | null = null;
	private logger: ReturnType<typeof getLogger>;
	private useAdvancedFeatures: boolean;

	constructor(apiKey?: string, options: { useAdvanced?: boolean } = {}) {
		this.logger = getLogger('langchain-service-wrapper');
		this.useAdvancedFeatures = options.useAdvanced ?? true;

		// Initialize enhanced service with OpenAI
		this.enhancedService = new EnhancedLangChainService([
			{
				provider: 'openai',
				modelName: 'gpt-4-turbo-preview',
				apiKey: apiKey || process.env.OPENAI_API_KEY,
				temperature: 0.7,
				streaming: true,
			},
		]);

		// Initialize advanced features if enabled
		if (this.useAdvancedFeatures) {
			try {
				this.advancedFeatures = new AdvancedLangChainFeatures(apiKey);
				this.logger.info('Advanced LangChain features enabled');
			} catch (error) {
				this.logger.warn('Failed to initialize advanced features, using basic mode', { error: (error as Error).message });
				this.useAdvancedFeatures = false;
			}
		}
	}

	/**
	 * Process and chunk a document for vector storage
	 * Maintains backward compatibility while using enhanced chunking
	 */
	async processDocument(
		document: ScrivenerDocument,
		options: ChunkingOptions = {}
	): Promise<LangchainDocument[]> {
		return this.enhancedService.processDocument(document, {
			...options,
			strategy: 'hybrid', // Use best strategy by default
		});
	}

	/**
	 * Build or update vector store with documents
	 * Uses enhanced vector store with better indexing
	 */
	async buildVectorStore(documents: ScrivenerDocument[]): Promise<void> {
		await this.enhancedService.buildVectorStore(documents, {
			strategy: 'hybrid',
		});
		this.logger.info(`Vector store built with ${documents.length} documents`);
	}

	/**
	 * Perform semantic search across documents
	 * Enhanced with reranking for better results
	 */
	async semanticSearch(query: string, topK: number = 5): Promise<LangchainDocument[]> {
		return this.enhancedService.semanticSearch(query, {
			topK,
			rerank: true, // Enable reranking for better results
		});
	}

	/**
	 * Generate writing suggestions using RAG
	 * Uses specialized templates when available
	 */
	async generateWithContext(prompt: string, options: RAGOptions = {}): Promise<string> {
		// Detect the type of request and use appropriate template
		type TemplateType = 'character_development' | 'plot_structure' | 'dialogue_enhancement' | 'worldbuilding' | 'pacing_rhythm' | 'theme_symbolism';
		const templateMap: Record<string, TemplateType> = {
			character: 'character_development',
			plot: 'plot_structure',
			dialogue: 'dialogue_enhancement',
			world: 'worldbuilding',
			pacing: 'pacing_rhythm',
			theme: 'theme_symbolism',
		};

		// Find matching template based on prompt keywords
		let template: TemplateType | null = null;
		for (const [keyword, templateName] of Object.entries(templateMap)) {
			if (prompt.toLowerCase().includes(keyword)) {
				template = templateName;
				break;
			}
		}

		if (template) {
			return this.enhancedService.generateWithTemplate(
				template,
				prompt,
				options
			);
		}

		// Fallback to general generation with context
		const relevantDocs = await this.enhancedService.semanticSearch(prompt, {
			topK: options.topK || 5,
			rerank: true,
		});

		const context = relevantDocs.map(doc => doc.pageContent).join('\n\n---\n\n');
		
		// Use streaming for better UX if callback provided
		let result = '';
		await this.enhancedService.generateWithStreaming(
			prompt,
			context,
			{
				onToken: (token) => {
					result += token;
				},
				onError: (error) => {
					this.logger.error('Generation error', { error: error.message });
				},
			}
		);

		return result;
	}

	/**
	 * Analyze writing style from samples
	 * Enhanced with structured output
	 */
	async analyzeWritingStyle(samples: string[]): Promise<Record<string, unknown>> {
		if (this.advancedFeatures) {
			try {
				// Create mock documents for analysis
				const mockDocs: ScrivenerDocument[] = samples.map((sample, i) => ({
					id: `sample-${i}`,
					title: `Sample ${i + 1}`,
					type: 'Text',
					path: '',
					content: sample,
				}));

				// Use advanced structured analysis
				const styleAnalysis = await this.advancedFeatures.analyzeWritingStyleStructured(mockDocs);
				
				return {
					voice: styleAnalysis.voice,
					prose: styleAnalysis.prose,
					dialogue: styleAnalysis.dialogue,
					techniques: styleAnalysis.techniques,
					strengths: styleAnalysis.strengths,
					weaknesses: styleAnalysis.weaknesses,
					comparisons: styleAnalysis.comparisons,
					recommendations: [...styleAnalysis.strengths, ...styleAnalysis.weaknesses].map(
						item => `Consider: ${item}`
					),
				};
			} catch (error) {
				this.logger.warn('Advanced style analysis failed, falling back to basic', { error: (error as Error).message });
			}
		}

		// Fallback to enhanced service
		return this.enhancedService.analyzeWritingStyle(samples);
	}

	/**
	 * Generate chapter summaries
	 * Maintains original API
	 */
	async summarizeChapter(content: string, maxLength: number = 200): Promise<string> {
		// Use the enhanced service's template system
		const prompt = `Summarize this chapter content in approximately ${maxLength} words, focusing on key plot points and character developments:\n\n${content}`;
		
		return this.enhancedService.generateWithTemplate('plot_structure', prompt, {
			maxTokens: Math.ceil(maxLength * 1.5), // Approximate tokens
		});
	}

	/**
	 * Check plot consistency across documents
	 * Enhanced with graph-based analysis
	 */
	async checkPlotConsistency(documents: ScrivenerDocument[]): Promise<
		Array<{
			issue: string;
			severity: 'low' | 'medium' | 'high';
			locations: string[];
			suggestion: string;
		}>
	> {
		if (this.advancedFeatures) {
			try {
				// Use advanced plot structure analysis
				const plotAnalysis = await this.advancedFeatures.analyzePlotStructure(documents);
				
				const issues: Array<{
					issue: string;
					severity: 'low' | 'medium' | 'high';
					locations: string[];
					suggestion: string;
				}> = [];

				// Check pacing issues
				if (plotAnalysis.pacing.overall === 'too slow' || plotAnalysis.pacing.overall === 'too fast') {
					issues.push({
						issue: `Overall pacing is ${plotAnalysis.pacing.overall}`,
						severity: plotAnalysis.pacing.overall.includes('too') ? 'high' : 'medium',
						locations: ['Throughout manuscript'],
						suggestion: plotAnalysis.pacing.recommendations[0] || 'Adjust pacing',
					});
				}

				// Check for unresolved subplots
				for (const subplot of plotAnalysis.subplots) {
					if (!subplot.resolution) {
						issues.push({
							issue: `Unresolved subplot: ${subplot.title}`,
							severity: 'medium',
							locations: ['Various chapters'],
							suggestion: `Resolve or connect "${subplot.title}" to main plot`,
						});
					}
				}

				// Check tension progression
				const tensionDrop = plotAnalysis.acts.findIndex((act, i) => 
					i > 0 && act.tension < plotAnalysis.acts[i - 1].tension - 2
				);
				if (tensionDrop > 0) {
					issues.push({
						issue: `Significant tension drop in Act ${plotAnalysis.acts[tensionDrop].number}`,
						severity: 'medium',
						locations: [`Act ${plotAnalysis.acts[tensionDrop].number}`],
						suggestion: 'Consider adding conflict or raising stakes',
					});
				}

				return issues;
			} catch (error) {
				this.logger.warn('Advanced plot analysis failed, falling back to basic', { error: (error as Error).message });
			}
		}

		// Fallback to enhanced service
		const result = await this.enhancedService.checkPlotConsistencyAdvanced(documents);
		return result.issues.map(issue => ({
			issue: issue.issue,
			severity: issue.severity,
			locations: issue.locations,
			suggestion: issue.suggestion,
		}));
	}

	/**
	 * Clear vector store and contexts
	 */
	clearMemory(): void {
		this.enhancedService.clearMemory();
		this.logger.debug('Memory cleared');
	}

	/**
	 * Get service statistics
	 * Extended with additional metrics
	 */
	getStatistics(): Record<string, unknown> {
		const stats = this.enhancedService.getStatistics();
		return {
			...stats,
			advancedFeaturesEnabled: this.useAdvancedFeatures,
			serviceVersion: '2.0.0',
			capabilities: {
				streaming: true,
				reranking: true,
				structuredOutput: this.useAdvancedFeatures,
				multiModel: true,
				conversationMemory: true,
			},
		};
	}

	/**
	 * Additional methods for enhanced functionality
	 * These are new additions not in the original API
	 */

	/**
	 * Generate alternative versions of text
	 */
	async generateAlternatives(
		passage: string,
		styles: Array<'literary' | 'commercial' | 'minimalist' | 'ornate' | 'noir' | 'comedic'>
	): Promise<Record<string, string>> {
		if (!this.advancedFeatures) {
			throw createError(
				ErrorCode.NOT_IMPLEMENTED,
				null,
				'Advanced features not available'
			);
		}
		return this.advancedFeatures.generateAlternatives(passage, styles);
	}

	/**
	 * Simulate beta reader feedback
	 */
	async simulateBetaReader(
		document: ScrivenerDocument,
		profile?: {
			genre_preference: string;
			reading_level: 'casual' | 'avid' | 'professional';
			focus: 'plot' | 'character' | 'prose' | 'general';
		}
	): Promise<Record<string, unknown>> {
		if (!this.advancedFeatures) {
			throw createError(
				ErrorCode.NOT_IMPLEMENTED,
				null,
				'Advanced features not available'
			);
		}

		const defaultProfile = {
			genre_preference: 'general fiction',
			reading_level: 'avid' as const,
			focus: 'general' as const,
		};

		return this.advancedFeatures.simulateBetaReader(
			document,
			profile || defaultProfile
		);
	}

	/**
	 * Generate comprehensive manuscript report
	 */
	async generateManuscriptReport(documents: ScrivenerDocument[]): Promise<Record<string, unknown>> {
		const baseReport = await this.enhancedService.generateManuscriptReport(documents);
		
		if (this.advancedFeatures) {
			try {
				// Enhance with story bible
				const storyBible = await this.advancedFeatures.generateStoryBible(documents);
				
				return {
					...baseReport,
					storyBible,
					advancedAnalysis: {
						characterDepth: Object.keys(storyBible.characters).length,
						worldComplexity: Object.keys(storyBible.worldbuilding).length,
						thematicRichness: storyBible.themes.length,
						symbolismCount: storyBible.symbols.length,
					},
				};
			} catch (error) {
				this.logger.warn('Failed to generate story bible', { error: (error as Error).message });
			}
		}

		return baseReport;
	}

	/**
	 * Create a writing coach for specific areas
	 */
	async createWritingCoach(
		focusArea: 'dialogue' | 'description' | 'pacing' | 'character'
	): Promise<{ invoke: (text: string) => Promise<string> }> {
		if (!this.advancedFeatures) {
			// Fallback to template-based coaching
			return {
				invoke: async (text: string) => {
					const templateMap = {
						dialogue: 'dialogue_enhancement',
						description: 'worldbuilding',
						pacing: 'pacing_rhythm',
						character: 'character_development',
					};

					return this.enhancedService.generateWithTemplate(
						templateMap[focusArea] as Parameters<typeof this.enhancedService.generateWithTemplate>[0],
						`Provide coaching feedback for: ${text}`
					);
				},
			};
		}

		const coach = await this.advancedFeatures.createWritingCoachChain(focusArea);
		return {
			invoke: coach.invoke,
		};
	}

	/**
	 * Find similar scenes using semantic search
	 */
	async findSimilarScenes(
		sceneDescription: string,
		documents: ScrivenerDocument[],
		options?: {
			minSimilarity?: number;
			maxResults?: number;
			includeContext?: boolean;
		}
	): Promise<Array<{ document: ScrivenerDocument; similarity: number; excerpt: string }>> {
		if (!this.advancedFeatures) {
			// Fallback to basic semantic search
			const results = await this.enhancedService.semanticSearch(sceneDescription, {
				topK: options?.maxResults || 5,
				rerank: true,
			});

			return results.map((doc, index) => ({
				document: documents.find(d => d.id === doc.metadata?.documentId) || documents[0],
				similarity: 1 - index * 0.1, // Approximate similarity score
				excerpt: doc.pageContent.substring(0, 200) + '...',
			}));
		}

		const results = await this.advancedFeatures.findSimilarScenes(
			sceneDescription,
			documents,
			options
		);

		return results.map(r => ({
			document: r.document,
			similarity: r.similarity,
			excerpt: r.excerpt,
		}));
	}
}

// Re-export enhanced services for direct use
export { EnhancedLangChainService } from './langchain-service-enhanced.js';
export { AdvancedLangChainFeatures } from './langchain-advanced-features.js';