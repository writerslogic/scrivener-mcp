import { EventEmitter } from 'events';
import { getLogger } from '../../core/logger.js';
import type { FeedbackData } from './langchain-continuous-learning.js';

export interface FeedbackWidget {
	id: string;
	sessionId: string;
	operation: string;
	timestamp: Date;
	isVisible: boolean;
	autoHideDelay?: number;
}

export interface FeedbackUI {
	showRatingDialog(options: {
		title: string;
		message: string;
		context?: Record<string, unknown>;
		onRating: (rating: number, comments?: string) => void;
		onSkip?: () => void;
	}): void;

	showInlineRating(options: {
		elementId: string;
		operation: string;
		onRating: (rating: number) => void;
	}): void;

	collectImplicitFeedback(options: {
		operation: string;
		userActions: string[];
		timeSpent: number;
	}): ImplicitFeedback;
}

export interface ImplicitFeedback {
	operation: string;
	engagementScore: number; // 0-1
	usagePatterns: {
		timeSpent: number;
		actionsPerformed: string[];
		completionRate: number;
	};
	inferredSatisfaction: number; // 1-5 estimated
}

export interface FeedbackPrompt {
	trigger: 'completion' | 'time_based' | 'error' | 'session_end';
	timing: {
		delay?: number;
		frequency?: 'always' | 'periodic' | 'adaptive';
	};
	content: {
		question: string;
		followUpQuestions?: string[];
		contextualHints?: string[];
	};
}

export class FeedbackCollectionService extends EventEmitter {
	private activeWidgets: Map<string, FeedbackWidget>;
	private feedbackPrompts: Map<string, FeedbackPrompt>;
	private sessionData: Map<
		string,
		{
			startTime: Date;
			operations: string[];
			interactions: number;
			errors: number;
		}
	>;
	private logger: ReturnType<typeof getLogger>;
	private adaptivePrompting: boolean = true;
	private userFeedbackHistory: Map<string, FeedbackData[]> = new Map();

	constructor() {
		super();
		this.activeWidgets = new Map();
		this.feedbackPrompts = new Map();
		this.sessionData = new Map();
		this.logger = getLogger('FeedbackCollection');
		this.initializePrompts();
	}

	async initializeSession(sessionId: string, userId?: string): Promise<void> {
		this.sessionData.set(sessionId, {
			startTime: new Date(),
			operations: [],
			interactions: 0,
			errors: 0,
		});

		// Set up adaptive prompting based on user history
		if (userId && this.adaptivePrompting) {
			await this.setupAdaptivePrompting(sessionId, userId);
		}

		this.logger.debug('Feedback collection session initialized', { sessionId, userId });
	}

	async collectExplicitFeedback(
		sessionId: string,
		operation: string,
		result: unknown,
		options?: {
			immediate?: boolean;
			customPrompt?: string;
			userId?: string;
		}
	): Promise<void> {
		const { immediate = false, customPrompt, userId } = options || {};

		try {
			const sessionData = this.sessionData.get(sessionId);
			if (!sessionData) {
				throw new Error(`Session ${sessionId} not found`);
			}

			sessionData.operations.push(operation);
			sessionData.interactions++;

			if (immediate || this.shouldPromptForFeedback(sessionId, operation, userId)) {
				await this.showFeedbackPrompt({
					sessionId,
					operation,
					result,
					customPrompt,
					userId,
				});
			}
		} catch (error) {
			this.logger.error('Failed to collect explicit feedback', {
				error: (error as Error).message,
			});
		}
	}

	async collectImplicitFeedback(
		sessionId: string,
		operation: string,
		behaviorData: {
			timeSpent: number;
			userActions: string[];
			scrollBehavior?: { scrollDepth: number; timeSpent: number };
			editingBehavior?: { charactersTyped: number; deletions: number };
			navigationBehavior?: { pagesVisited: string[]; backNavigations: number };
		}
	): Promise<ImplicitFeedback> {
		try {
			const engagementScore = this.calculateEngagementScore(behaviorData);
			const completionRate = this.calculateCompletionRate(
				operation,
				behaviorData.userActions
			);
			const inferredSatisfaction = this.inferSatisfaction(
				engagementScore,
				completionRate,
				behaviorData
			);

			const implicitFeedback: ImplicitFeedback = {
				operation,
				engagementScore,
				usagePatterns: {
					timeSpent: behaviorData.timeSpent,
					actionsPerformed: behaviorData.userActions,
					completionRate,
				},
				inferredSatisfaction,
			};

			// Store for later analysis
			this.emit('implicitFeedback', { sessionId, feedback: implicitFeedback });

			this.logger.debug('Implicit feedback collected', {
				sessionId,
				operation,
				engagementScore,
				inferredSatisfaction,
			});

			return implicitFeedback;
		} catch (error) {
			this.logger.error('Failed to collect implicit feedback', {
				error: (error as Error).message,
			});
			throw error;
		}
	}

	async showContextualFeedbackPrompt(options: {
		sessionId: string;
		operation: string;
		context: {
			documentType?: string;
			currentContent?: string;
			userGoal?: string;
		};
		result: unknown;
		userId?: string;
	}): Promise<void> {
		const { sessionId, operation, context, result, userId } = options;

		try {
			const prompt = this.generateContextualPrompt(operation, context, result);

			await this.showFeedbackDialog({
				sessionId,
				operation,
				prompt,
				onFeedback: async (rating: number, comments?: string) => {
					await this.processFeedback({
						sessionId,
						userId,
						operation,
						rating,
						comments,
						context,
						result,
					});
				},
			});
		} catch (error) {
			this.logger.error('Failed to show contextual feedback prompt', {
				error: (error as Error).message,
			});
		}
	}

	async setupMicroFeedback(options: {
		sessionId: string;
		operations: string[];
		thumbsUpDown?: boolean;
		starRating?: boolean;
		quickComments?: string[];
	}): Promise<void> {
		const {
			sessionId,
			operations,
			thumbsUpDown = true,
			starRating = false,
			quickComments = [],
		} = options;

		for (const operation of operations) {
			const widgetId = `${sessionId}-${operation}-micro`;

			const widget: FeedbackWidget = {
				id: widgetId,
				sessionId,
				operation,
				timestamp: new Date(),
				isVisible: false,
				autoHideDelay: 10000, // 10 seconds
			};

			this.activeWidgets.set(widgetId, widget);
		}

		this.logger.debug('Micro feedback widgets setup', {
			sessionId,
			operations: operations.length,
		});
	}

	async analyzeSessionFeedback(sessionId: string): Promise<{
		explicitFeedback: FeedbackData[];
		implicitMetrics: {
			engagementScore: number;
			completionRate: number;
			errorRate: number;
			sessionDuration: number;
		};
		recommendations: string[];
	}> {
		try {
			const sessionData = this.sessionData.get(sessionId);
			if (!sessionData) {
				throw new Error(`Session ${sessionId} not found`);
			}

			const sessionDuration = Date.now() - sessionData.startTime.getTime();
			const explicitFeedback = await this.getSessionFeedback(sessionId);

			const implicitMetrics = {
				engagementScore: this.calculateSessionEngagement(sessionData),
				completionRate:
					sessionData.operations.length > 0
						? (sessionData.operations.length - sessionData.errors) /
							sessionData.operations.length
						: 0,
				errorRate:
					sessionData.operations.length > 0
						? sessionData.errors / sessionData.operations.length
						: 0,
				sessionDuration,
			};

			const recommendations = this.generateSessionRecommendations(
				explicitFeedback,
				implicitMetrics
			);

			return { explicitFeedback, implicitMetrics, recommendations };
		} catch (error) {
			this.logger.error('Failed to analyze session feedback', {
				error: (error as Error).message,
			});
			throw error;
		}
	}

	async endSession(
		sessionId: string,
		options?: {
			showExitSurvey?: boolean;
			userId?: string;
		}
	): Promise<void> {
		const { showExitSurvey = false, userId } = options || {};

		try {
			if (showExitSurvey) {
				await this.showExitSurvey(sessionId, userId);
			}

			// Clean up session data
			this.sessionData.delete(sessionId);

			// Remove session widgets
			for (const [widgetId, widget] of this.activeWidgets.entries()) {
				if (widget.sessionId === sessionId) {
					this.activeWidgets.delete(widgetId);
				}
			}

			this.logger.debug('Feedback collection session ended', { sessionId });
		} catch (error) {
			this.logger.error('Failed to end feedback session', {
				error: (error as Error).message,
			});
		}
	}

	private initializePrompts(): void {
		// Enhancement completion prompt
		this.feedbackPrompts.set('enhancement_completion', {
			trigger: 'completion',
			timing: { frequency: 'adaptive' },
			content: {
				question: 'How satisfied are you with this enhancement?',
				followUpQuestions: [
					'Did the enhancement meet your expectations?',
					'How could this be improved?',
				],
				contextualHints: ['Consider the quality, relevance, and usefulness of the changes'],
			},
		});

		// Error recovery prompt
		this.feedbackPrompts.set('error_recovery', {
			trigger: 'error',
			timing: { delay: 2000, frequency: 'always' },
			content: {
				question: 'We encountered an issue. How can we help you continue?',
				followUpQuestions: [
					'Was the error message helpful?',
					'What were you trying to accomplish?',
				],
			},
		});

		// Session end prompt
		this.feedbackPrompts.set('session_end', {
			trigger: 'session_end',
			timing: { frequency: 'periodic' },
			content: {
				question: 'How was your overall experience?',
				followUpQuestions: [
					'What worked well?',
					'What could be improved?',
					'Would you recommend this to others?',
				],
			},
		});
	}

	private async setupAdaptivePrompting(sessionId: string, userId: string): Promise<void> {
		const userHistory = this.userFeedbackHistory.get(userId) || [];

		// Analyze user's feedback patterns
		if (userHistory.length > 0) {
			const avgRating =
				userHistory.reduce((sum, fb) => sum + fb.userRating, 0) / userHistory.length;
			const feedbackFrequency = userHistory.length;

			// Adjust prompting strategy based on history
			if (avgRating >= 4.0 && feedbackFrequency >= 5) {
				// Happy user - reduce prompting frequency
				this.setPromptFrequency(sessionId, 'low');
			} else if (avgRating <= 2.0) {
				// Unsatisfied user - increase prompting for specific feedback
				this.setPromptFrequency(sessionId, 'high');
			}
		}
	}

	private shouldPromptForFeedback(
		sessionId: string,
		operation: string,
		userId?: string
	): boolean {
		// Implement smart prompting logic
		const sessionData = this.sessionData.get(sessionId);
		if (!sessionData) return false;

		// Don't prompt too frequently
		if (sessionData.interactions < 3) return false;

		// Prompt after errors
		if (sessionData.errors > 0) return true;

		// Prompt for new operations
		const operationCount = sessionData.operations.filter((op) => op === operation).length;
		return operationCount === 1; // First time using this operation
	}

	private calculateEngagementScore(behaviorData: {
		timeSpent: number;
		userActions: string[];
		scrollBehavior?: { scrollDepth: number; timeSpent: number };
		editingBehavior?: { charactersTyped: number; deletions: number };
	}): number {
		let score = 0;

		// Time-based engagement (normalized to 0-0.4)
		const timeScore = Math.min(behaviorData.timeSpent / 300000, 0.4); // 5 minutes max
		score += timeScore;

		// Action-based engagement (0-0.3)
		const actionScore = Math.min(behaviorData.userActions.length / 20, 0.3);
		score += actionScore;

		// Scroll behavior (0-0.15)
		if (behaviorData.scrollBehavior) {
			const scrollScore = Math.min(behaviorData.scrollBehavior.scrollDepth / 100, 0.15);
			score += scrollScore;
		}

		// Editing behavior (0-0.15)
		if (behaviorData.editingBehavior) {
			const editScore = Math.min(behaviorData.editingBehavior.charactersTyped / 1000, 0.15);
			score += editScore;
		}

		return Math.min(score, 1.0);
	}

	private calculateCompletionRate(operation: string, userActions: string[]): number {
		// Define expected actions for common operations
		const expectedActions = {
			enhance_content: ['select_text', 'apply_enhancement', 'review_result'],
			compile_documents: ['select_documents', 'choose_format', 'generate_compilation'],
			semantic_search: ['enter_query', 'review_results', 'select_document'],
		};

		const expected = expectedActions[operation as keyof typeof expectedActions] || [];
		if (expected.length === 0) return 1.0;

		const completed = expected.filter((action) => userActions.includes(action)).length;
		return completed / expected.length;
	}

	private inferSatisfaction(
		engagementScore: number,
		completionRate: number,
		behaviorData: Record<string, unknown>
	): number {
		// Simple satisfaction inference model
		let satisfaction = 1; // Start at lowest satisfaction

		// High engagement suggests satisfaction
		if (engagementScore > 0.7) satisfaction += 2;
		else if (engagementScore > 0.4) satisfaction += 1;

		// High completion rate suggests satisfaction
		if (completionRate > 0.8) satisfaction += 1.5;
		else if (completionRate > 0.5) satisfaction += 0.5;

		// Quick exits suggest dissatisfaction
		if (Number(behaviorData.timeSpent) < 10000) satisfaction -= 1; // Less than 10 seconds

		// Many deletions suggest frustration
		if (
			(behaviorData.editingBehavior as any)?.deletions >
			(behaviorData.editingBehavior as any)?.charactersTyped * 0.3
		) {
			satisfaction -= 0.5;
		}

		return Math.max(1, Math.min(5, satisfaction));
	}

	private generateContextualPrompt(
		operation: string,
		context: Record<string, unknown>,
		result: unknown
	): string {
		const basePrompts = {
			enhance_content: 'How helpful was this content enhancement?',
			compile_documents: 'How satisfied are you with the compiled document?',
			semantic_search: 'Did the search results meet your needs?',
			analyze_writing: 'How useful was this writing analysis?',
		};

		let prompt =
			basePrompts[operation as keyof typeof basePrompts] || 'How was this experience?';

		// Add contextual information
		if (context.documentType) {
			prompt += ` (for your ${context.documentType})`;
		}

		return prompt;
	}

	private async showFeedbackDialog(options: {
		sessionId: string;
		operation: string;
		prompt: string;
		onFeedback: (rating: number, comments?: string) => Promise<void>;
	}): Promise<void> {
		// This would integrate with the UI layer to show actual dialogs
		// For now, we'll emit an event that the UI can listen to
		this.emit('showFeedbackDialog', options);
	}

	private async showFeedbackPrompt(options: {
		sessionId: string;
		operation: string;
		result: unknown;
		customPrompt?: string;
		userId?: string;
	}): Promise<void> {
		const prompt =
			options.customPrompt ||
			this.generateContextualPrompt(options.operation, {}, options.result);

		await this.showFeedbackDialog({
			sessionId: options.sessionId,
			operation: options.operation,
			prompt,
			onFeedback: async (rating: number, comments?: string) => {
				await this.processFeedback({
					sessionId: options.sessionId,
					userId: options.userId,
					operation: options.operation,
					rating,
					comments,
					context: {},
					result: options.result,
				});
			},
		});
	}

	private async processFeedback(options: {
		sessionId: string;
		userId?: string;
		operation: string;
		rating: number;
		comments?: string;
		context: Record<string, unknown>;
		result: unknown;
	}): Promise<void> {
		const feedbackData: FeedbackData = {
			sessionId: options.sessionId,
			userId: options.userId,
			operation: options.operation,
			input: options.context,
			output: options.result,
			userRating: options.rating,
			userComments: options.comments,
			timestamp: new Date(),
			context: {
				documentType: options.context.documentType as string | undefined,
				genre: options.context.genre as string | undefined,
				userExperience: 'intermediate', // Would be determined from user profile
				targetAudience: options.context.targetAudience as string | undefined,
			},
		};

		// Store user feedback history
		if (options.userId) {
			const history = this.userFeedbackHistory.get(options.userId) || [];
			history.push(feedbackData);
			this.userFeedbackHistory.set(options.userId, history);
		}

		this.emit('feedbackCollected', feedbackData);
	}

	private async getSessionFeedback(sessionId: string): Promise<FeedbackData[]> {
		// In a real implementation, this would query a database
		// For now, return empty array
		return [];
	}

	private calculateSessionEngagement(sessionData: {
		startTime: Date;
		operations: string[];
		interactions: number;
		errors: number;
	}): number {
		const duration = Date.now() - sessionData.startTime.getTime();
		const operationsPerMinute = (sessionData.operations.length / duration) * 60000;
		const interactionsPerMinute = (sessionData.interactions / duration) * 60000;

		// Normalize to 0-1 scale
		return Math.min((operationsPerMinute + interactionsPerMinute) / 10, 1.0);
	}

	private generateSessionRecommendations(
		explicitFeedback: FeedbackData[],
		implicitMetrics: Record<string, unknown>
	): string[] {
		const recommendations: string[] = [];

		if ((implicitMetrics.errorRate as number) > 0.3) {
			recommendations.push('Consider improving error handling and user guidance');
		}

		if ((implicitMetrics.engagementScore as number) < 0.3) {
			recommendations.push('Look into user interface improvements to increase engagement');
		}

		if (explicitFeedback.length > 0) {
			const avgRating =
				explicitFeedback.reduce((sum, fb) => sum + fb.userRating, 0) /
				explicitFeedback.length;
			if (avgRating < 3.0) {
				recommendations.push('Review recent changes - user satisfaction has declined');
			}
		}

		return recommendations;
	}

	private async showExitSurvey(sessionId: string, userId?: string): Promise<void> {
		const surveyPrompt = this.feedbackPrompts.get('session_end');
		if (!surveyPrompt) return;

		await this.showFeedbackDialog({
			sessionId,
			operation: 'session_end',
			prompt: surveyPrompt.content.question,
			onFeedback: async (rating: number, comments?: string) => {
				await this.processFeedback({
					sessionId,
					userId,
					operation: 'session_end',
					rating,
					comments,
					context: { type: 'exit_survey' },
					result: { sessionEnd: true },
				});
			},
		});
	}

	private setPromptFrequency(sessionId: string, frequency: 'high' | 'medium' | 'low'): void {
		// Adjust prompting behavior for this session
		// This would modify internal prompting logic
		this.logger.debug('Prompt frequency adjusted', { sessionId, frequency });
	}
}
