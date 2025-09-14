import { ApplicationError as AppError, ErrorCode } from '../core/errors.js';
import { getLogger } from '../core/logger.js';
import type { ImplicitFeedback } from '../services/learning/feedback-collection.js';
import { FeedbackCollectionService } from '../services/learning/feedback-collection.js';
import type {
	FeedbackData,
	LearningInsights,
} from '../services/learning/langchain-continuous-learning.js';
import { LangChainContinuousLearning } from '../services/learning/langchain-continuous-learning.js';
import type {
	LearningRecommendation,
	PersonalizedContent,
	PersonalizationProfile,
} from '../services/learning/personalization-engine.js';
import { PersonalizationEngine } from '../services/learning/personalization-engine.js';

export interface LearningDataExport {
	userInsights: LearningInsights;
	feedbackHistory: FeedbackData[];
	behaviorPatterns: BehaviorData[];
	recommendations: LearningRecommendation[];
	exportTimestamp: string;
	version: string;
}

export interface BehaviorData {
	timeSpent: number;
	userActions: string[];
	scrollBehavior?: { scrollDepth: number; timeSpent: number };
	editingBehavior?: { charactersTyped: number; deletions: number };
	navigationBehavior?: { pagesVisited: string[]; backNavigations: number };
	enhancementType?: string;
	documentsCount?: number;
	targetOptimization?: string;
	materialType?: string;
	success?: boolean;
	context?: string;
	error?: string;
}

export interface OperationContext {
	documentId?: string;
	operation?: string;
	timestamp?: Date;
	userPreferences?: Record<string, unknown>;
	sessionData?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface UserPreferences {
	language?: string;
	writingStyle?: string;
	tone?: string;
	preferredPrompts?: string[];
	customSettings?: Record<string, unknown>;
}

export interface LearningDataExport {
	userId?: string;
	sessions?: Array<{
		sessionId: string;
		feedback: FeedbackData[];
		insights: LearningInsights;
	}>;
	userProfiles?: Record<string, UserPreferences>;
	systemMetrics?: Record<string, unknown>;
	continuousLearning?: unknown;
	personalization?: unknown;
}

export interface ContinuousLearningHandler {
	// Feedback collection
	startFeedbackSession(sessionId: string, userId?: string): Promise<void>;
	collectFeedback(feedback: FeedbackData): Promise<void>;
	collectImplicitFeedback(
		sessionId: string,
		operation: string,
		behaviorData: BehaviorData
	): Promise<ImplicitFeedback>;
	endFeedbackSession(
		sessionId: string,
		options?: { showExitSurvey?: boolean; userId?: string }
	): Promise<void>;

	// Personalization
	personalizeContent(
		userId: string,
		content: string,
		operation: string,
		context?: OperationContext
	): Promise<PersonalizedContent>;
	getPersonalizedRecommendations(userId: string): Promise<LearningRecommendation[]>;
	createUserProfile(userId: string, preferences?: UserPreferences): Promise<void>;

	// Learning system
	evolvePrompt(templateId: string): Promise<{ prompt: string; confidence: number }>;
	getPersonalizedPrompt(
		templateId: string,
		userId?: string,
		context?: OperationContext
	): Promise<string>;
	startABTest(templateId: string, variantPrompt: string): Promise<string>;
	getLearningInsights(): Promise<LearningInsights>;

	// Data management
	exportLearningData(userId?: string): Promise<LearningDataExport>;
	importLearningData(data: LearningDataExport): Promise<void>;
}

export class LangChainContinuousLearningHandler implements ContinuousLearningHandler {
	private continuousLearning: LangChainContinuousLearning;
	private feedbackCollection: FeedbackCollectionService;
	private personalizationEngine: PersonalizationEngine;
	private logger: ReturnType<typeof getLogger>;
	private initialized: boolean = false;

	constructor() {
		this.continuousLearning = new LangChainContinuousLearning();
		this.feedbackCollection = new FeedbackCollectionService();
		this.personalizationEngine = new PersonalizationEngine();
		this.logger = getLogger('ContinuousLearningHandler');
		this.setupEventListeners();
	}

	async initialize(): Promise<void> {
		if (this.initialized) {
			return;
		}

		try {
			await Promise.all([
				this.continuousLearning.initialize(),
				this.personalizationEngine.initialize(),
			]);

			this.initialized = true;
			this.logger.info('Continuous learning handler initialized');
		} catch (error) {
			this.logger.error('Failed to initialize continuous learning handler', {
				error: (error as Error).message,
			});
			throw new AppError(
				'Continuous learning initialization failed',
				ErrorCode.INITIALIZATION_ERROR
			);
		}
	}

	async startFeedbackSession(sessionId: string, userId?: string): Promise<void> {
		if (!this.initialized) {
			await this.initialize();
		}

		try {
			await this.feedbackCollection.initializeSession(sessionId, userId);

			if (userId) {
				// Ensure user has a personalization profile
				const profile = await this.personalizationEngine.exportUserProfile(userId);
				if (!profile) {
					await this.personalizationEngine.createUserProfile(userId);
				}
			}

			this.logger.debug('Feedback session started', { sessionId, userId });
		} catch (error) {
			this.logger.error('Failed to start feedback session', {
				sessionId,
				userId,
				error: (error as Error).message,
			});
			throw new AppError(
				'Feedback session initialization failed',
				ErrorCode.INITIALIZATION_ERROR
			);
		}
	}

	async collectFeedback(feedback: FeedbackData): Promise<void> {
		try {
			// Process feedback through continuous learning system
			await this.continuousLearning.collectFeedback(feedback);

			// Update personalization profile if user ID provided
			if (feedback.userId) {
				await this.personalizationEngine.updateUserProfile(feedback.userId, feedback);
			}

			this.logger.debug('Feedback collected and processed', {
				sessionId: feedback.sessionId,
				operation: feedback.operation,
				rating: feedback.userRating,
			});
		} catch (error) {
			this.logger.error('Failed to collect feedback', {
				error: (error as Error).message,
				feedback: feedback.sessionId,
			});
			throw new AppError('Feedback collection failed', ErrorCode.PROCESSING_ERROR);
		}
	}

	async collectImplicitFeedback(
		sessionId: string,
		operation: string,
		behaviorData: BehaviorData
	): Promise<ImplicitFeedback> {
		try {
			const implicitFeedback = await this.feedbackCollection.collectImplicitFeedback(
				sessionId,
				operation,
				behaviorData
			);

			// Convert implicit feedback to explicit feedback format for learning system
			const explicitFeedback: FeedbackData = {
				sessionId,
				operation,
				input: behaviorData,
				output: implicitFeedback,
				userRating: implicitFeedback.inferredSatisfaction,
				timestamp: new Date(),
				context: {
					type: 'implicit',
					engagementScore: implicitFeedback.engagementScore,
					completionRate: implicitFeedback.usagePatterns.completionRate,
				},
			};

			await this.continuousLearning.collectFeedback(explicitFeedback);

			return implicitFeedback;
		} catch (error) {
			this.logger.error('Failed to collect implicit feedback', {
				sessionId,
				operation,
				error: (error as Error).message,
			});
			throw new AppError('Implicit feedback collection failed', ErrorCode.PROCESSING_ERROR);
		}
	}

	async endFeedbackSession(
		sessionId: string,
		options?: {
			showExitSurvey?: boolean;
			userId?: string;
		}
	): Promise<void> {
		try {
			await this.feedbackCollection.endSession(sessionId, options);

			// Analyze session and generate insights
			const sessionAnalysis = await this.feedbackCollection.analyzeSessionFeedback(sessionId);

			if (options?.userId && sessionAnalysis.recommendations.length > 0) {
				this.logger.info('Session analysis completed', {
					sessionId,
					userId: options.userId,
					recommendations: sessionAnalysis.recommendations.length,
				});
			}
		} catch (error) {
			this.logger.error('Failed to end feedback session', {
				sessionId,
				error: (error as Error).message,
			});
			// Don't throw here as session ending should be resilient
		}
	}

	async personalizeContent(
		userId: string,
		content: string,
		operation: string,
		context?: OperationContext
	): Promise<PersonalizedContent> {
		try {
			const personalizedContent = await this.personalizationEngine.personalizeContent(
				userId,
				content,
				operation,
				context
			);

			this.logger.debug('Content personalized', {
				userId,
				operation,
				personalizationScore: personalizedContent.metadata.personalizationScore,
				adaptations: personalizedContent.adaptations.length,
			});

			return personalizedContent;
		} catch (error) {
			this.logger.error('Content personalization failed', {
				userId,
				operation,
				error: (error as Error).message,
			});
			throw new AppError('Content personalization failed', ErrorCode.PROCESSING_ERROR);
		}
	}

	async getPersonalizedRecommendations(userId: string): Promise<LearningRecommendation[]> {
		try {
			const recommendations =
				await this.personalizationEngine.generatePersonalizedRecommendations(userId);

			this.logger.debug('Generated personalized recommendations', {
				userId,
				count: recommendations.length,
			});

			return recommendations;
		} catch (error) {
			this.logger.error('Failed to get personalized recommendations', {
				userId,
				error: (error as Error).message,
			});
			return [];
		}
	}

	async createUserProfile(userId: string, preferences?: UserPreferences): Promise<void> {
		try {
			const profilePreferences: Partial<PersonalizationProfile> | undefined = preferences
				? {
						writingPreferences: {
							genres: [] as string[],
							tonePreferences:
								preferences.tone &&
								['formal', 'casual', 'creative', 'academic', 'business'].includes(
									preferences.tone
								)
									? [
											preferences.tone as
												| 'formal'
												| 'casual'
												| 'creative'
												| 'academic'
												| 'business',
										]
									: (['casual'] as (
											| 'formal'
											| 'casual'
											| 'creative'
											| 'academic'
											| 'business'
										)[]),
							styleGuides: [] as string[],
							preferredLength: 'detailed' as const,
							complexityLevel: 'intermediate' as const,
						},
					}
				: undefined;

			await this.personalizationEngine.createUserProfile(userId, profilePreferences);

			this.logger.info('User profile created', { userId });
		} catch (error) {
			this.logger.error('Failed to create user profile', {
				userId,
				error: (error as Error).message,
			});
			throw new AppError('User profile creation failed', ErrorCode.PROCESSING_ERROR);
		}
	}

	async evolvePrompt(templateId: string): Promise<{ prompt: string; confidence: number }> {
		try {
			const evolution = await this.continuousLearning.evolvePrompt(templateId);

			this.logger.debug('Prompt evolved', {
				templateId,
				confidence: evolution.confidence,
			});

			return evolution;
		} catch (error) {
			this.logger.error('Prompt evolution failed', {
				templateId,
				error: (error as Error).message,
			});
			throw new AppError('Prompt evolution failed', ErrorCode.PROCESSING_ERROR);
		}
	}

	async getPersonalizedPrompt(
		templateId: string,
		userId?: string,
		context?: OperationContext
	): Promise<string> {
		try {
			let prompt = await this.continuousLearning.getPersonalizedPrompt(
				templateId,
				userId,
				context
			);

			// Apply additional personalization if user ID provided
			if (userId) {
				const adaptiveSuggestions =
					await this.personalizationEngine.getAdaptivePromptSuggestions(
						userId,
						prompt,
						context || {}
					);

				// Use the best suggestion if confidence is high
				if (
					adaptiveSuggestions.confidence > 0.7 &&
					adaptiveSuggestions.suggestedPrompts.length > 0
				) {
					prompt = adaptiveSuggestions.suggestedPrompts[0];

					this.logger.debug('Applied adaptive prompt suggestion', {
						templateId,
						userId,
						confidence: adaptiveSuggestions.confidence,
					});
				}
			}

			return prompt;
		} catch (error) {
			this.logger.error('Failed to get personalized prompt', {
				templateId,
				userId,
				error: (error as Error).message,
			});
			throw new AppError('Personalized prompt retrieval failed', ErrorCode.PROCESSING_ERROR);
		}
	}

	async startABTest(templateId: string, variantPrompt: string): Promise<string> {
		try {
			const testId = await this.continuousLearning.startABTest(templateId, variantPrompt);

			this.logger.info('A/B test started', { templateId, testId });

			return testId;
		} catch (error) {
			this.logger.error('Failed to start A/B test', {
				templateId,
				error: (error as Error).message,
			});
			throw new AppError('A/B test initialization failed', ErrorCode.PROCESSING_ERROR);
		}
	}

	async getLearningInsights(): Promise<LearningInsights> {
		try {
			const insights = await this.continuousLearning.getLearningInsights();

			this.logger.debug('Learning insights generated', {
				globalTrends: insights.globalTrends.popularOperations.length,
				promptOptimizations: insights.promptOptimizations.highPerformingPrompts.length,
				userPatterns: insights.userBehaviorPatterns.commonWorkflows.length,
			});

			return insights;
		} catch (error) {
			this.logger.error('Failed to get learning insights', {
				error: (error as Error).message,
			});
			throw new AppError('Learning insights generation failed', ErrorCode.PROCESSING_ERROR);
		}
	}

	async exportLearningData(userId?: string): Promise<LearningDataExport> {
		try {
			const continuousLearningData = await this.continuousLearning.exportLearningData();

			let personalizationData = null;
			if (userId) {
				personalizationData = await this.personalizationEngine.exportUserProfile(userId);
			}

			const exportData: LearningDataExport = {
				userInsights: continuousLearningData.insights || {
					globalTrends: {
						popularOperations: [],
						emergingPatterns: [],
						commonIssues: [],
					},
					promptOptimizations: {
						highPerformingPrompts: [],
						underperformingPrompts: [],
						suggestedImprovements: [],
					},
					userBehaviorPatterns: {
						peakUsageTimes: [],
						sessionLengths: [],
						commonWorkflows: [],
					},
				},
				feedbackHistory: continuousLearningData.feedback || [],
				behaviorPatterns: (personalizationData?.behaviors || []).map(
					(behavior: unknown): BehaviorData => {
						const b = behavior as Record<string, unknown>;
						return {
							timeSpent: (b.timeSpent as number) || 0,
							userActions: (b.userActions as string[]) || [],
							scrollBehavior: b.scrollBehavior as BehaviorData['scrollBehavior'],
							editingBehavior: b.editingBehavior as BehaviorData['editingBehavior'],
							navigationBehavior:
								b.navigationBehavior as BehaviorData['navigationBehavior'],
							context: b.context as string | undefined,
						};
					}
				),
				recommendations: (personalizationData?.recommendations || []).map(
					(rec: unknown): LearningRecommendation => {
						const r = rec as Record<string, unknown>;
						return {
							type: (['content', 'feature', 'workflow', 'settings'].includes(
								r.type as string
							)
								? r.type
								: 'content') as 'content' | 'feature' | 'workflow' | 'settings',
							priority: (['low', 'medium', 'high'].includes(r.priority as string)
								? r.priority
								: 'medium') as 'low' | 'medium' | 'high',
							title: (r.title as string) || (r.content as string) || '',
							description: (r.description as string) || (r.content as string) || '',
							actionable: (r.actionable as boolean) || true,
							implementation:
								(r.implementation as LearningRecommendation['implementation']) || {
									steps: [],
									estimatedImpact: 0.5,
									effort: 'medium',
								},
							...r,
						};
					}
				),
				exportTimestamp: new Date().toISOString(),
				version: '1.0',
			};

			this.logger.info('Learning data exported', {
				userId,
				feedbackCount: continuousLearningData.feedback.length,
				promptEvolutionsCount: continuousLearningData.promptEvolutions.length,
			});

			return exportData;
		} catch (error) {
			this.logger.error('Failed to export learning data', {
				userId,
				error: (error as Error).message,
			});
			throw new AppError('Learning data export failed', ErrorCode.PROCESSING_ERROR);
		}
	}

	async importLearningData(data: LearningDataExport): Promise<void> {
		try {
			if (data.continuousLearning) {
				await this.continuousLearning.importLearningData(data.continuousLearning);
			}

			// Note: LearningDataExport doesn't currently include personalization data
			// This section is reserved for future personalization import functionality

			this.logger.info('Learning data imported successfully');
		} catch (error) {
			this.logger.error('Failed to import learning data', {
				error: (error as Error).message,
			});
			throw new AppError('Learning data import failed', ErrorCode.PROCESSING_ERROR);
		}
	}

	// Enhanced methods for integration with existing services
	async enhanceWithLearning<T>(
		operation: string,
		baseFunction: () => Promise<T>,
		options: {
			sessionId: string;
			userId?: string;
			context?: OperationContext;
			collectFeedback?: boolean;
		}
	): Promise<T> {
		const { sessionId, userId, context, collectFeedback = true } = options;
		const startTime = Date.now();

		try {
			// Get personalized configuration for the operation
			let personalizedContext = context;
			if (userId) {
				// This could personalize parameters, prompts, etc.
				personalizedContext = await this.getPersonalizedContext(
					userId,
					operation,
					context || {}
				);
			}

			// Execute the base function
			const result = await baseFunction();

			// Collect implicit feedback based on execution
			if (collectFeedback) {
				const executionTime = Date.now() - startTime;
				await this.collectImplicitFeedback(sessionId, operation, {
					timeSpent: executionTime,
					userActions: ['execute_operation'],
					success: true,
					context:
						typeof personalizedContext === 'string'
							? personalizedContext
							: JSON.stringify(personalizedContext),
				});
			}

			return result;
		} catch (error) {
			// Collect error feedback
			if (collectFeedback) {
				const executionTime = Date.now() - startTime;
				await this.collectImplicitFeedback(sessionId, operation, {
					timeSpent: executionTime,
					userActions: ['execute_operation', 'encounter_error'],
					success: false,
					error: (error as Error).message,
					context: typeof context === 'string' ? context : JSON.stringify(context),
				});
			}

			throw error;
		}
	}

	private setupEventListeners(): void {
		this.feedbackCollection.on('feedbackCollected', (feedback: FeedbackData) => {
			// Forward to continuous learning system
			this.continuousLearning.collectFeedback(feedback).catch((error) => {
				this.logger.error('Failed to forward feedback to continuous learning', {
					error: error.message,
				});
			});
		});

		// Listen for implicit feedback events
		this.feedbackCollection.on('implicitFeedback', ({ sessionId, feedback }) => {
			// Could trigger additional analysis or learning
			this.logger.debug('Implicit feedback received', {
				sessionId,
				feedback: feedback.operation,
			});
		});

		// Listen for learning insights updates
		this.continuousLearning.on('insightsUpdated', (insights: LearningInsights) => {
			this.logger.info('Learning insights updated', {
				popularOperations: insights.globalTrends.popularOperations.length,
			});
		});

		// Listen for prompt evolution events
		this.continuousLearning.on('promptEvolved', ({ templateId, confidence }) => {
			this.logger.info('Prompt evolved', { templateId, confidence });
		});
	}

	private async getPersonalizedContext(
		userId: string,
		operation: string,
		baseContext: OperationContext
	): Promise<OperationContext> {
		try {
			// Get user profile for personalization
			const profile = await this.personalizationEngine.exportUserProfile(userId);
			if (!profile) {
				return baseContext;
			}

			// Apply personalized settings based on user preferences
			const personalizedContext = {
				...baseContext,
				userPreferences: {
					complexityLevel: profile.writingPreferences.complexityLevel,
					tonePreferences: profile.writingPreferences.tonePreferences,
					preferredLength: profile.writingPreferences.preferredLength,
				},
				adaptationSettings: profile.adaptationSettings,
			};

			return personalizedContext;
		} catch (error) {
			this.logger.warn('Failed to get personalized context', {
				userId,
				operation,
				error: (error as Error).message,
			});
			return baseContext;
		}
	}
}
