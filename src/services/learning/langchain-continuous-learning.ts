import { EventEmitter } from 'events';
import { getLogger } from '../../core/logger.js';
import { AppError, ErrorCode } from '../../utils/common.js';

export interface FeedbackData {
	sessionId: string;
	userId?: string;
	operation: string;
	input: unknown;
	output: unknown;
	userRating: number; // 1-5 scale
	userComments?: string;
	timestamp: Date;
	context: {
		documentType?: string;
		genre?: string;
		userExperience?: 'beginner' | 'intermediate' | 'advanced';
		targetAudience?: string;
		operation?: string;
		sessionId?: string;
		type?: string;
		engagementScore?: number;
		completionRate?: number;
	};
}

export interface PromptEvolution {
	templateId: string;
	originalPrompt: string;
	currentPrompt: string;
	performanceMetrics: {
		averageRating: number;
		successRate: number;
		usageCount: number;
		lastUpdated: Date;
	};
	variations: Array<{
		prompt: string;
		aTestResults: {
			ratingA: number;
			ratingB: number;
			significanceLevel: number;
		};
	}>;
}

export interface UserPersonalization {
	userId: string;
	preferences: {
		writingStyle: string[];
		tonePreferences: string[];
		contentTypes: string[];
		difficultyLevel: 'beginner' | 'intermediate' | 'advanced';
	};
	learningPatterns: {
		frequentOperations: string[];
		preferredFeedbackTypes: string[];
		responseToSuggestions: 'accepts_most' | 'selective' | 'rarely_accepts';
	};
	customizedPrompts: Map<string, string>;
	performanceHistory: Array<{
		operation: string;
		satisfaction: number;
		timestamp: Date;
	}>;
}

export interface LearningInsights {
	globalTrends: {
		popularOperations: string[];
		emergingPatterns: string[];
		commonIssues: string[];
	};
	promptOptimizations: {
		highPerformingPrompts: string[];
		underperformingPrompts: string[];
		suggestedImprovements: string[];
	};
	userBehaviorPatterns: {
		peakUsageTimes: string[];
		sessionLengths: number[];
		commonWorkflows: string[];
	};
}

export class LangChainContinuousLearning extends EventEmitter {
	private feedbackStore: Map<string, FeedbackData[]>;
	private promptEvolutions: Map<string, PromptEvolution>;
	private userProfiles: Map<string, UserPersonalization>;
	private abTestingActive: Map<string, boolean>;
	private logger: ReturnType<typeof getLogger>;
	private learningEnabled: boolean = true;

	constructor() {
		super();
		this.feedbackStore = new Map();
		this.promptEvolutions = new Map();
		this.userProfiles = new Map();
		this.abTestingActive = new Map();
		this.logger = getLogger('ContinuousLearning');
	}

	async initialize(): Promise<void> {
		try {
			await this.loadExistingData();
			this.startPeriodicAnalysis();
			this.logger.info('Continuous learning system initialized');
		} catch (error) {
			this.logger.error('Failed to initialize continuous learning system', {
				error: (error as Error).message,
			});
			throw new AppError(
				'Continuous learning initialization failed',
				ErrorCode.INITIALIZATION_ERROR
			);
		}
	}

	async collectFeedback(feedback: FeedbackData): Promise<void> {
		if (!this.learningEnabled) {
			return;
		}

		try {
			const sessionFeedback = this.feedbackStore.get(feedback.sessionId) || [];
			sessionFeedback.push(feedback);
			this.feedbackStore.set(feedback.sessionId, sessionFeedback);

			await this.updateUserPersonalization(feedback);
			await this.analyzePromptPerformance(feedback);

			this.logger.debug('Feedback collected', {
				sessionId: feedback.sessionId,
				rating: feedback.userRating,
				operation: feedback.operation,
			});

			this.emit('feedbackCollected', feedback);
		} catch (error) {
			this.logger.error('Failed to collect feedback', { error: (error as Error).message });
		}
	}

	async getPersonalizedPrompt(
		templateId: string,
		userId?: string,
		context?: Record<string, unknown>
	): Promise<string> {
		try {
			const basePrompt = await this.getOptimizedPrompt(templateId);

			if (!userId) {
				return basePrompt;
			}

			const userProfile = this.userProfiles.get(userId);
			if (!userProfile) {
				return basePrompt;
			}

			return this.personalizePrompt(basePrompt, userProfile, context);
		} catch (error) {
			this.logger.error('Failed to get personalized prompt', {
				error: (error as Error).message,
			});
			throw new AppError('Prompt personalization failed', ErrorCode.PROCESSING_ERROR);
		}
	}

	async evolvePrompt(templateId: string): Promise<{ prompt: string; confidence: number }> {
		try {
			const evolution = this.promptEvolutions.get(templateId);
			if (!evolution) {
				throw new AppError(
					`No evolution data for template ${templateId}`,
					ErrorCode.NOT_FOUND
				);
			}

			const feedback = this.getFeedbackForTemplate(templateId);
			if (feedback.length < 10) {
				return { prompt: evolution.currentPrompt, confidence: 0.1 };
			}

			const analysisResults = await this.analyzePromptEffectiveness(feedback, evolution);

			if (analysisResults.shouldEvolve) {
				const newPrompt = await this.generateImprovedPrompt(evolution, analysisResults);
				evolution.currentPrompt = newPrompt;
				evolution.performanceMetrics.lastUpdated = new Date();

				this.promptEvolutions.set(templateId, evolution);
				this.logger.info(`Evolved prompt for template ${templateId}`);

				return { prompt: newPrompt, confidence: analysisResults.confidence };
			}

			return { prompt: evolution.currentPrompt, confidence: analysisResults.confidence };
		} catch (error) {
			this.logger.error('Failed to evolve prompt', { error: (error as Error).message });
			throw new AppError('Prompt evolution failed', ErrorCode.PROCESSING_ERROR);
		}
	}

	async startABTest(templateId: string, variantPrompt: string): Promise<string> {
		try {
			const evolution = this.promptEvolutions.get(templateId);
			if (!evolution) {
				throw new AppError(
					`Template ${templateId} not found for A/B testing`,
					ErrorCode.NOT_FOUND
				);
			}

			const testId = `${templateId}-${Date.now()}`;
			evolution.variations.push({
				prompt: variantPrompt,
				aTestResults: {
					ratingA: 0,
					ratingB: 0,
					significanceLevel: 0,
				},
			});

			this.abTestingActive.set(testId, true);
			this.promptEvolutions.set(templateId, evolution);

			this.logger.info(`Started A/B test for template ${templateId}`, { testId });
			return testId;
		} catch (error) {
			this.logger.error('Failed to start A/B test', { error: (error as Error).message });
			throw new AppError('A/B test initialization failed', ErrorCode.PROCESSING_ERROR);
		}
	}

	async getLearningInsights(): Promise<LearningInsights> {
		try {
			const allFeedback = Array.from(this.feedbackStore.values()).flat();

			return {
				globalTrends: await this.analyzeGlobalTrends(allFeedback),
				promptOptimizations: await this.analyzePromptOptimizations(),
				userBehaviorPatterns: await this.analyzeUserBehaviorPatterns(allFeedback),
			};
		} catch (error) {
			this.logger.error('Failed to get learning insights', {
				error: (error as Error).message,
			});
			throw new AppError('Learning insights generation failed', ErrorCode.PROCESSING_ERROR);
		}
	}

	async exportLearningData(): Promise<{
		feedback: FeedbackData[];
		promptEvolutions: PromptEvolution[];
		userProfiles: UserPersonalization[];
		insights: LearningInsights;
	}> {
		try {
			return {
				feedback: Array.from(this.feedbackStore.values()).flat(),
				promptEvolutions: Array.from(this.promptEvolutions.values()),
				userProfiles: Array.from(this.userProfiles.values()),
				insights: await this.getLearningInsights(),
			};
		} catch (error) {
			this.logger.error('Failed to export learning data', {
				error: (error as Error).message,
			});
			throw new AppError('Learning data export failed', ErrorCode.PROCESSING_ERROR);
		}
	}

	async importLearningData(data: {
		feedback?: FeedbackData[];
		promptEvolutions?: PromptEvolution[];
		userProfiles?: UserPersonalization[];
	}): Promise<void> {
		try {
			if (data.feedback) {
				for (const feedback of data.feedback) {
					await this.collectFeedback(feedback);
				}
			}

			if (data.promptEvolutions) {
				for (const evolution of data.promptEvolutions) {
					this.promptEvolutions.set(evolution.templateId, evolution);
				}
			}

			if (data.userProfiles) {
				for (const profile of data.userProfiles) {
					this.userProfiles.set(profile.userId, profile);
				}
			}

			this.logger.info('Learning data imported successfully');
		} catch (error) {
			this.logger.error('Failed to import learning data', {
				error: (error as Error).message,
			});
			throw new AppError('Learning data import failed', ErrorCode.PROCESSING_ERROR);
		}
	}

	private async loadExistingData(): Promise<void> {
		// In a real implementation, this would load from persistent storage
		// For now, initialize with empty data structures
		this.logger.debug('Loading existing learning data (placeholder implementation)');
	}

	private startPeriodicAnalysis(): void {
		setInterval(
			async () => {
				try {
					await this.performPeriodicAnalysis();
				} catch (error) {
					this.logger.error('Periodic analysis failed', {
						error: (error as Error).message,
					});
				}
			},
			24 * 60 * 60 * 1000
		); // Daily analysis
	}

	private async performPeriodicAnalysis(): Promise<void> {
		this.logger.debug('Performing periodic learning analysis');

		// Analyze all templates for potential improvements
		for (const [templateId] of this.promptEvolutions) {
			try {
				await this.evolvePrompt(templateId);
			} catch (error) {
				this.logger.warn(`Failed to analyze template ${templateId}`, {
					error: (error as Error).message,
				});
			}
		}

		// Emit insights update
		const insights = await this.getLearningInsights();
		this.emit('insightsUpdated', insights);
	}

	private async updateUserPersonalization(feedback: FeedbackData): Promise<void> {
		if (!feedback.userId) {
			return;
		}

		const profile = this.userProfiles.get(feedback.userId) || {
			userId: feedback.userId,
			preferences: {
				writingStyle: [] as string[],
				tonePreferences: [] as string[],
				contentTypes: [] as string[],
				difficultyLevel: 'intermediate',
			},
			learningPatterns: {
				frequentOperations: [] as string[],
				preferredFeedbackTypes: [] as string[],
				responseToSuggestions: 'selective',
			},
			customizedPrompts: new Map(),
			performanceHistory: [] as Array<{
				operation: string;
				satisfaction: number;
				timestamp: Date;
			}>,
		};

		// Update performance history
		profile.performanceHistory.push({
			operation: feedback.operation,
			satisfaction: feedback.userRating,
			timestamp: feedback.timestamp,
		});

		// Keep only last 100 entries
		if (profile.performanceHistory.length > 100) {
			profile.performanceHistory = profile.performanceHistory.slice(-100);
		}

		// Update frequent operations
		const operationCount = profile.learningPatterns.frequentOperations.filter(
			(op) => op === feedback.operation
		).length;

		if (operationCount === 0) {
			profile.learningPatterns.frequentOperations.push(feedback.operation);
		}

		// Analyze response patterns
		if (feedback.userRating >= 4) {
			profile.learningPatterns.responseToSuggestions = 'accepts_most';
		} else if (feedback.userRating <= 2) {
			profile.learningPatterns.responseToSuggestions = 'rarely_accepts';
		}

		this.userProfiles.set(feedback.userId, profile);
	}

	private async analyzePromptPerformance(feedback: FeedbackData): Promise<void> {
		const templateId = this.extractTemplateId(feedback.operation);
		if (!templateId) {
			return;
		}

		let evolution = this.promptEvolutions.get(templateId);
		if (!evolution) {
			evolution = {
				templateId,
				originalPrompt: 'Base prompt', // Would be loaded from template registry
				currentPrompt: 'Base prompt',
				performanceMetrics: {
					averageRating: 0,
					successRate: 0,
					usageCount: 0,
					lastUpdated: new Date(),
				},
				variations: [],
			};
		}

		// Update metrics
		const currentRating = evolution.performanceMetrics.averageRating;
		const currentCount = evolution.performanceMetrics.usageCount;

		evolution.performanceMetrics.averageRating =
			(currentRating * currentCount + feedback.userRating) / (currentCount + 1);
		evolution.performanceMetrics.usageCount = currentCount + 1;
		evolution.performanceMetrics.successRate =
			feedback.userRating >= 3
				? evolution.performanceMetrics.successRate + 0.1
				: evolution.performanceMetrics.successRate - 0.1;

		this.promptEvolutions.set(templateId, evolution);
	}

	private personalizePrompt(
		basePrompt: string,
		userProfile: UserPersonalization,
		context?: Record<string, unknown>
	): string {
		let personalizedPrompt = basePrompt;

		// Adapt based on user experience level
		if (userProfile.preferences.difficultyLevel === 'beginner') {
			personalizedPrompt += '\n\nPlease provide clear, simple explanations with examples.';
		} else if (userProfile.preferences.difficultyLevel === 'advanced') {
			personalizedPrompt += '\n\nProvide advanced techniques and nuanced suggestions.';
		}

		// Adapt based on writing style preferences
		if (userProfile.preferences.writingStyle.length > 0) {
			personalizedPrompt += `\n\nConsider the user's preferred writing styles: ${userProfile.preferences.writingStyle.join(', ')}.`;
		}

		// Adapt based on response patterns
		if (userProfile.learningPatterns.responseToSuggestions === 'selective') {
			personalizedPrompt +=
				'\n\nProvide focused, high-impact suggestions rather than comprehensive lists.';
		}

		return personalizedPrompt;
	}

	private getFeedbackForTemplate(templateId: string): FeedbackData[] {
		const allFeedback = Array.from(this.feedbackStore.values()).flat();
		return allFeedback.filter((fb) => this.extractTemplateId(fb.operation) === templateId);
	}

	private async analyzePromptEffectiveness(
		feedback: FeedbackData[],
		evolution: PromptEvolution
	): Promise<{ shouldEvolve: boolean; confidence: number; issues: string[] }> {
		const recentFeedback = feedback.filter(
			(fb) => fb.timestamp > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
		);

		if (recentFeedback.length < 5) {
			return {
				shouldEvolve: false,
				confidence: 0.1,
				issues: ['Insufficient recent feedback'],
			};
		}

		const averageRating =
			recentFeedback.reduce((sum, fb) => sum + fb.userRating, 0) / recentFeedback.length;
		const lowRatingCount = recentFeedback.filter((fb) => fb.userRating <= 2).length;
		const issues = this.identifyCommonIssues(recentFeedback);

		const shouldEvolve = averageRating < 3.5 || lowRatingCount / recentFeedback.length > 0.3;
		const confidence = Math.min(recentFeedback.length / 20, 1.0);

		return { shouldEvolve, confidence, issues };
	}

	private async generateImprovedPrompt(
		evolution: PromptEvolution,
		analysis: { issues: string[] }
	): Promise<string> {
		// This is a simplified implementation
		// In a real system, this would use LangChain to generate improved prompts
		let improvedPrompt = evolution.currentPrompt;

		if (analysis.issues.includes('unclear_instructions')) {
			improvedPrompt += '\n\nProvide step-by-step instructions for clarity.';
		}

		if (analysis.issues.includes('lack_of_examples')) {
			improvedPrompt += '\n\nInclude specific examples to illustrate points.';
		}

		if (analysis.issues.includes('tone_mismatch')) {
			improvedPrompt += "\n\nMatch the tone and style of the user's writing.";
		}

		return improvedPrompt;
	}

	private identifyCommonIssues(feedback: FeedbackData[]): string[] {
		const issues: string[] = [];
		const comments = feedback.map((fb) => fb.userComments).filter(Boolean);

		const commonWords = ['unclear', 'confusing', 'example', 'tone', 'style', 'length'];
		for (const word of commonWords) {
			const mentions = comments.filter((comment) =>
				comment?.toLowerCase().includes(word)
			).length;

			if (mentions > feedback.length * 0.2) {
				issues.push(`${word}_related`);
			}
		}

		return issues;
	}

	private async analyzeGlobalTrends(feedback: FeedbackData[]): Promise<{
		popularOperations: string[];
		emergingPatterns: string[];
		commonIssues: string[];
	}> {
		const operationCounts = new Map<string, number>();
		const recentFeedback = feedback.filter(
			(fb) => fb.timestamp > new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
		);

		for (const fb of recentFeedback) {
			operationCounts.set(fb.operation, (operationCounts.get(fb.operation) || 0) + 1);
		}

		const popularOperations = Array.from(operationCounts.entries())
			.sort(([, a], [, b]) => b - a)
			.slice(0, 10)
			.map(([op]) => op);

		return {
			popularOperations,
			emergingPatterns: this.identifyEmergingPatterns(recentFeedback),
			commonIssues: this.identifyCommonIssues(recentFeedback),
		};
	}

	private identifyEmergingPatterns(feedback: FeedbackData[]): string[] {
		// Simplified pattern detection
		const patterns: string[] = [];

		const genreDistribution = new Map<string, number>();
		for (const fb of feedback) {
			const genre = fb.context.genre;
			if (genre) {
				genreDistribution.set(genre, (genreDistribution.get(genre) || 0) + 1);
			}
		}

		const topGenres = Array.from(genreDistribution.entries())
			.sort(([, a], [, b]) => b - a)
			.slice(0, 3)
			.map(([genre]) => `${genre}_increasing`);

		patterns.push(...topGenres);
		return patterns;
	}

	private async analyzePromptOptimizations(): Promise<{
		highPerformingPrompts: string[];
		underperformingPrompts: string[];
		suggestedImprovements: string[];
	}> {
		const highPerforming: string[] = [];
		const underperforming: string[] = [];
		const improvements: string[] = [];

		for (const [templateId, evolution] of this.promptEvolutions) {
			if (evolution.performanceMetrics.averageRating >= 4.0) {
				highPerforming.push(templateId);
			} else if (evolution.performanceMetrics.averageRating <= 2.5) {
				underperforming.push(templateId);
				improvements.push(
					`Improve ${templateId}: Add more specific examples and clearer instructions`
				);
			}
		}

		return {
			highPerformingPrompts: highPerforming,
			underperformingPrompts: underperforming,
			suggestedImprovements: improvements,
		};
	}

	private async analyzeUserBehaviorPatterns(feedback: FeedbackData[]): Promise<{
		peakUsageTimes: string[];
		sessionLengths: number[];
		commonWorkflows: string[];
	}> {
		const hourCounts = new Map<number, number>();
		const workflows = new Map<string, number>();

		for (const fb of feedback) {
			const hour = fb.timestamp.getHours();
			hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);

			workflows.set(fb.operation, (workflows.get(fb.operation) || 0) + 1);
		}

		const peakHours = Array.from(hourCounts.entries())
			.sort(([, a], [, b]) => b - a)
			.slice(0, 3)
			.map(([hour]) => `${hour}:00`);

		const commonWorkflows = Array.from(workflows.entries())
			.sort(([, a], [, b]) => b - a)
			.slice(0, 5)
			.map(([workflow]) => workflow);

		return {
			peakUsageTimes: peakHours,
			sessionLengths: [15, 30, 45, 60], // Placeholder - would calculate actual session lengths
			commonWorkflows,
		};
	}

	private extractTemplateId(operation: string): string | null {
		// Extract template ID from operation string
		// This is a simplified implementation
		const match = operation.match(/template:(\w+)/);
		return match ? match[1] : operation.split(':')[0];
	}

	private async getOptimizedPrompt(templateId: string): Promise<string> {
		const evolution = this.promptEvolutions.get(templateId);
		return evolution?.currentPrompt || `Base prompt for ${templateId}`;
	}
}
