import { EventEmitter } from 'events';
import { getLogger } from '../../core/logger.js';
import type { FeedbackData } from './langchain-continuous-learning.js';
import { UserPersonalization } from './langchain-continuous-learning.js';

export interface PersonalizationProfile {
	userId: string;
	createdAt: Date;
	lastUpdated: Date;

	writingPreferences: {
		genres: string[];
		tonePreferences: ('formal' | 'casual' | 'creative' | 'academic' | 'business')[];
		styleGuides: string[];
		preferredLength: 'concise' | 'detailed' | 'comprehensive';
		complexityLevel: 'simple' | 'intermediate' | 'advanced';
	};

	behaviorPatterns: {
		activeHours: number[];
		sessionDuration: number;
		frequentOperations: Map<string, number>;
		preferredInputMethods: string[];
		responseSpeed: 'immediate' | 'thoughtful' | 'slow';
	};

	feedbackPatterns: {
		responsivenessToSuggestions: number; // 0-1
		feedbackFrequency: number; // responses per session
		commonComplaintTopics: string[];
		commonPraiseTopics: string[];
		satisfactionTrend: number[]; // last 10 sessions
	};

	adaptationSettings: {
		enableLearning: boolean;
		adaptationSpeed: 'conservative' | 'moderate' | 'aggressive';
		privacyLevel: 'minimal' | 'balanced' | 'comprehensive';
		shareDataForImprovement: boolean;
	};

	behaviors?: Array<{
		action: string;
		frequency: number;
		context: string[];
	}>;

	recommendations?: Array<{
		type: string;
		content: string;
		priority: number;
	}>;
}

export interface PersonalizedContent {
	originalContent: string;
	personalizedContent: string;
	adaptations: {
		type: 'tone' | 'complexity' | 'length' | 'style' | 'examples';
		description: string;
		confidence: number;
	}[];
	metadata: {
		templateUsed: string;
		personalizationScore: number;
		processingTime: number;
	};
}

export interface LearningRecommendation {
	type: 'content' | 'feature' | 'workflow' | 'settings';
	priority: 'low' | 'medium' | 'high';
	title: string;
	description: string;
	actionable: boolean;
	implementation: {
		steps: string[];
		estimatedImpact: number; // 0-1
		effort: 'low' | 'medium' | 'high';
	};
}

export class PersonalizationEngine extends EventEmitter {
	private userProfiles: Map<string, PersonalizationProfile>;
	private adaptationRules: Map<
		string,
		(profile: PersonalizationProfile, input: unknown) => unknown
	>;
	private learningModels: Map<string, any>; // Would be actual ML models in production
	private logger: ReturnType<typeof getLogger>;
	private isLearning: boolean = true;

	constructor() {
		super();
		this.userProfiles = new Map();
		this.adaptationRules = new Map();
		this.learningModels = new Map();
		this.logger = getLogger('PersonalizationEngine');
		this.initializeAdaptationRules();
	}

	async initialize(): Promise<void> {
		try {
			await this.loadUserProfiles();
			await this.initializeLearningModels();
			this.logger.info('Personalization engine initialized');
		} catch (error) {
			this.logger.error('Failed to initialize personalization engine', {
				error: (error as Error).message,
			});
			throw error;
		}
	}

	async createUserProfile(
		userId: string,
		initialPreferences?: Partial<PersonalizationProfile>
	): Promise<PersonalizationProfile> {
		const profile: PersonalizationProfile = {
			userId,
			createdAt: new Date(),
			lastUpdated: new Date(),

			writingPreferences: {
				genres: initialPreferences?.writingPreferences?.genres || [],
				tonePreferences: initialPreferences?.writingPreferences?.tonePreferences || [
					'casual',
				],
				styleGuides: initialPreferences?.writingPreferences?.styleGuides || [],
				preferredLength:
					initialPreferences?.writingPreferences?.preferredLength || 'detailed',
				complexityLevel:
					initialPreferences?.writingPreferences?.complexityLevel || 'intermediate',
			},

			behaviorPatterns: {
				activeHours: [],
				sessionDuration: 0,
				frequentOperations: new Map(),
				preferredInputMethods: [],
				responseSpeed: 'thoughtful',
			},

			feedbackPatterns: {
				responsivenessToSuggestions: 0.5,
				feedbackFrequency: 0,
				commonComplaintTopics: [],
				commonPraiseTopics: [],
				satisfactionTrend: [],
			},

			adaptationSettings: {
				enableLearning: true,
				adaptationSpeed: 'moderate',
				privacyLevel: 'balanced',
				shareDataForImprovement: true,
			},
		};

		this.userProfiles.set(userId, profile);
		this.logger.info('User profile created', { userId });

		return profile;
	}

	async updateUserProfile(userId: string, feedback: FeedbackData): Promise<void> {
		let profile = this.userProfiles.get(userId);

		if (!profile) {
			profile = await this.createUserProfile(userId);
		}

		try {
			// Update behavior patterns
			const currentHour = feedback.timestamp.getHours();
			if (!profile.behaviorPatterns.activeHours.includes(currentHour)) {
				profile.behaviorPatterns.activeHours.push(currentHour);
			}

			// Update frequent operations
			const currentCount =
				profile.behaviorPatterns.frequentOperations.get(feedback.operation) || 0;
			profile.behaviorPatterns.frequentOperations.set(feedback.operation, currentCount + 1);

			// Update feedback patterns
			profile.feedbackPatterns.feedbackFrequency =
				(profile.feedbackPatterns.feedbackFrequency + 1) / 2; // Moving average

			// Update satisfaction trend
			profile.feedbackPatterns.satisfactionTrend.push(feedback.userRating);
			if (profile.feedbackPatterns.satisfactionTrend.length > 10) {
				profile.feedbackPatterns.satisfactionTrend.shift();
			}

			// Analyze feedback content for topics
			if (feedback.userComments) {
				this.analyzeAndUpdateFeedbackTopics(profile, feedback);
			}

			// Update writing preferences based on context
			if (
				feedback.context.genre &&
				!profile.writingPreferences.genres.includes(feedback.context.genre)
			) {
				profile.writingPreferences.genres.push(feedback.context.genre);
			}

			profile.lastUpdated = new Date();
			this.userProfiles.set(userId, profile);

			this.logger.debug('User profile updated', { userId, operation: feedback.operation });
		} catch (error) {
			this.logger.error('Failed to update user profile', {
				userId,
				error: (error as Error).message,
			});
		}
	}

	async personalizeContent(
		userId: string,
		content: string,
		operation: string,
		context?: Record<string, unknown>
	): Promise<PersonalizedContent> {
		const startTime = Date.now();

		try {
			const profile = this.userProfiles.get(userId);
			if (!profile || !profile.adaptationSettings.enableLearning) {
				return {
					originalContent: content,
					personalizedContent: content,
					adaptations: [],
					metadata: {
						templateUsed: 'none',
						personalizationScore: 0,
						processingTime: Date.now() - startTime,
					},
				};
			}

			const adaptations: PersonalizedContent['adaptations'] = [];
			let personalizedContent = content;

			// Apply tone adaptations
			if (this.shouldAdaptTone(profile, operation)) {
				const toneAdaptation = await this.adaptTone(personalizedContent, profile);
				personalizedContent = toneAdaptation.content;
				adaptations.push({
					type: 'tone',
					description: toneAdaptation.description,
					confidence: toneAdaptation.confidence,
				});
			}

			// Apply complexity adaptations
			if (this.shouldAdaptComplexity(profile, operation)) {
				const complexityAdaptation = await this.adaptComplexity(
					personalizedContent,
					profile
				);
				personalizedContent = complexityAdaptation.content;
				adaptations.push({
					type: 'complexity',
					description: complexityAdaptation.description,
					confidence: complexityAdaptation.confidence,
				});
			}

			// Apply length adaptations
			if (this.shouldAdaptLength(profile, operation)) {
				const lengthAdaptation = await this.adaptLength(personalizedContent, profile);
				personalizedContent = lengthAdaptation.content;
				adaptations.push({
					type: 'length',
					description: lengthAdaptation.description,
					confidence: lengthAdaptation.confidence,
				});
			}

			// Apply style adaptations
			if (this.shouldAdaptStyle(profile, operation)) {
				const styleAdaptation = await this.adaptStyle(
					personalizedContent,
					profile,
					context
				);
				personalizedContent = styleAdaptation.content;
				adaptations.push({
					type: 'style',
					description: styleAdaptation.description,
					confidence: styleAdaptation.confidence,
				});
			}

			const personalizationScore = this.calculatePersonalizationScore(
				content,
				personalizedContent,
				adaptations
			);

			return {
				originalContent: content,
				personalizedContent,
				adaptations,
				metadata: {
					templateUsed: this.getTemplateId(operation),
					personalizationScore,
					processingTime: Date.now() - startTime,
				},
			};
		} catch (error) {
			this.logger.error('Content personalization failed', {
				userId,
				operation,
				error: (error as Error).message,
			});

			return {
				originalContent: content,
				personalizedContent: content,
				adaptations: [],
				metadata: {
					templateUsed: 'error',
					personalizationScore: 0,
					processingTime: Date.now() - startTime,
				},
			};
		}
	}

	async generatePersonalizedRecommendations(userId: string): Promise<LearningRecommendation[]> {
		const profile = this.userProfiles.get(userId);
		if (!profile) {
			return [];
		}

		const recommendations: LearningRecommendation[] = [];

		try {
			// Analyze usage patterns for workflow recommendations
			const workflowRecs = await this.generateWorkflowRecommendations(profile);
			recommendations.push(...workflowRecs);

			// Analyze satisfaction trends for feature recommendations
			const featureRecs = await this.generateFeatureRecommendations(profile);
			recommendations.push(...featureRecs);

			// Analyze feedback for content recommendations
			const contentRecs = await this.generateContentRecommendations(profile);
			recommendations.push(...contentRecs);

			// Sort by priority and impact
			recommendations.sort((a, b) => {
				const priorityWeight = { high: 3, medium: 2, low: 1 };
				const priorityDiff = priorityWeight[b.priority] - priorityWeight[a.priority];
				if (priorityDiff !== 0) return priorityDiff;

				return b.implementation.estimatedImpact - a.implementation.estimatedImpact;
			});

			this.logger.debug('Generated personalized recommendations', {
				userId,
				count: recommendations.length,
			});

			return recommendations;
		} catch (error) {
			this.logger.error('Failed to generate recommendations', {
				userId,
				error: (error as Error).message,
			});
			return [];
		}
	}

	async getAdaptivePromptSuggestions(
		userId: string,
		basePrompt: string,
		context: Record<string, unknown>
	): Promise<{
		suggestedPrompts: string[];
		rationale: string[];
		confidence: number;
	}> {
		const profile = this.userProfiles.get(userId);
		if (!profile) {
			return {
				suggestedPrompts: [basePrompt],
				rationale: ['No user profile available'],
				confidence: 0.1,
			};
		}

		try {
			const suggestions: string[] = [];
			const rationale: string[] = [];

			// Adapt based on complexity preference
			if (profile.writingPreferences.complexityLevel === 'simple') {
				suggestions.push(this.simplifyPrompt(basePrompt));
				rationale.push('Simplified for user preference');
			} else if (profile.writingPreferences.complexityLevel === 'advanced') {
				suggestions.push(this.enhancePrompt(basePrompt));
				rationale.push('Enhanced for advanced user');
			}

			// Adapt based on tone preferences
			for (const tone of profile.writingPreferences.tonePreferences) {
				suggestions.push(this.adaptPromptTone(basePrompt, tone));
				rationale.push(`Adapted for ${tone} tone preference`);
			}

			// Adapt based on recent feedback patterns
			if (profile.feedbackPatterns.commonComplaintTopics.includes('unclear')) {
				suggestions.push(this.clarifyPrompt(basePrompt));
				rationale.push('Added clarity based on feedback history');
			}

			const confidence = this.calculateAdaptationConfidence(profile, context);

			return {
				suggestedPrompts: suggestions.slice(0, 3), // Top 3 suggestions
				rationale: rationale.slice(0, 3),
				confidence,
			};
		} catch (error) {
			this.logger.error('Failed to generate adaptive prompt suggestions', {
				userId,
				error: (error as Error).message,
			});

			return {
				suggestedPrompts: [basePrompt],
				rationale: ['Error in adaptation'],
				confidence: 0.1,
			};
		}
	}

	async exportUserProfile(userId: string): Promise<PersonalizationProfile | null> {
		const profile = this.userProfiles.get(userId);
		if (!profile) return null;

		// Create a deep copy to avoid mutations
		return JSON.parse(JSON.stringify(profile));
	}

	async importUserProfile(profile: PersonalizationProfile): Promise<void> {
		this.userProfiles.set(profile.userId, profile);
		this.logger.info('User profile imported', { userId: profile.userId });
	}

	private initializeAdaptationRules(): void {
		// Tone adaptation rule
		this.adaptationRules.set('tone', (profile: PersonalizationProfile, input: unknown) => {
			const userTones = profile.writingPreferences.tonePreferences;
			return {
				shouldAdapt: userTones.length > 0,
				targetTone: userTones[0], // Primary preference
				confidence: userTones.length / 5, // Max 5 tones
			};
		});

		// Complexity adaptation rule
		this.adaptationRules.set(
			'complexity',
			(profile: PersonalizationProfile, input: unknown) => {
				const userLevel = profile.writingPreferences.complexityLevel;
				return {
					shouldAdapt: userLevel !== 'intermediate', // Default level
					targetLevel: userLevel,
					confidence: 0.8, // High confidence in explicit preference
				};
			}
		);

		// Length adaptation rule
		this.adaptationRules.set('length', (profile: PersonalizationProfile, input: unknown) => {
			const userPref = profile.writingPreferences.preferredLength;
			const responsiveness = profile.feedbackPatterns.responsivenessToSuggestions;
			return {
				shouldAdapt: responsiveness > 0.6, // Only for responsive users
				targetLength: userPref,
				confidence: responsiveness,
			};
		});
	}

	private async loadUserProfiles(): Promise<void> {
		// In a real implementation, this would load from persistent storage
		this.logger.debug('Loading user profiles from storage (placeholder)');
	}

	private async initializeLearningModels(): Promise<void> {
		// In a real implementation, this would load ML models
		this.logger.debug('Initializing learning models (placeholder)');
	}

	private analyzeAndUpdateFeedbackTopics(
		profile: PersonalizationProfile,
		feedback: FeedbackData
	): void {
		if (!feedback.userComments) return;

		const comment = feedback.userComments.toLowerCase();

		// Simple keyword detection for complaints
		const complaintKeywords = ['unclear', 'confusing', 'wrong', 'bad', 'poor', 'terrible'];
		const praiseKeywords = ['good', 'great', 'excellent', 'helpful', 'perfect', 'amazing'];

		for (const keyword of complaintKeywords) {
			if (
				comment.includes(keyword) &&
				!profile.feedbackPatterns.commonComplaintTopics.includes(keyword)
			) {
				profile.feedbackPatterns.commonComplaintTopics.push(keyword);
			}
		}

		for (const keyword of praiseKeywords) {
			if (
				comment.includes(keyword) &&
				!profile.feedbackPatterns.commonPraiseTopics.includes(keyword)
			) {
				profile.feedbackPatterns.commonPraiseTopics.push(keyword);
			}
		}
	}

	private shouldAdaptTone(profile: PersonalizationProfile, operation: string): boolean {
		return (
			profile.writingPreferences.tonePreferences.length > 0 &&
			profile.adaptationSettings.enableLearning
		);
	}

	private shouldAdaptComplexity(profile: PersonalizationProfile, operation: string): boolean {
		return (
			profile.writingPreferences.complexityLevel !== 'intermediate' &&
			profile.adaptationSettings.enableLearning
		);
	}

	private shouldAdaptLength(profile: PersonalizationProfile, operation: string): boolean {
		return (
			profile.feedbackPatterns.responsivenessToSuggestions > 0.6 &&
			profile.adaptationSettings.enableLearning
		);
	}

	private shouldAdaptStyle(profile: PersonalizationProfile, operation: string): boolean {
		return (
			profile.writingPreferences.styleGuides.length > 0 &&
			profile.adaptationSettings.enableLearning
		);
	}

	private async adaptTone(
		content: string,
		profile: PersonalizationProfile
	): Promise<{
		content: string;
		description: string;
		confidence: number;
	}> {
		// Simplified tone adaptation
		const targetTone = profile.writingPreferences.tonePreferences[0];
		let adaptedContent = content;

		switch (targetTone) {
			case 'formal':
				adaptedContent = content.replace(/don't/g, 'do not').replace(/can't/g, 'cannot');
				break;
			case 'casual':
				adaptedContent = content.replace(/do not/g, "don't").replace(/cannot/g, "can't");
				break;
			case 'creative':
				adaptedContent = content; // Would use more sophisticated adaptation
				break;
		}

		return {
			content: adaptedContent,
			description: `Adapted to ${targetTone} tone`,
			confidence: 0.7,
		};
	}

	private async adaptComplexity(
		content: string,
		profile: PersonalizationProfile
	): Promise<{
		content: string;
		description: string;
		confidence: number;
	}> {
		const targetLevel = profile.writingPreferences.complexityLevel;
		let adaptedContent = content;

		if (targetLevel === 'simple') {
			// Simplify vocabulary and sentence structure
			adaptedContent = content.replace(/utilize/g, 'use').replace(/facilitate/g, 'help');
		} else if (targetLevel === 'advanced') {
			// Add more sophisticated terminology
			adaptedContent = content
				.replace(/\buse\b/g, 'utilize')
				.replace(/\bhelp\b/g, 'facilitate');
		}

		return {
			content: adaptedContent,
			description: `Adapted to ${targetLevel} complexity`,
			confidence: 0.8,
		};
	}

	private async adaptLength(
		content: string,
		profile: PersonalizationProfile
	): Promise<{
		content: string;
		description: string;
		confidence: number;
	}> {
		const preferredLength = profile.writingPreferences.preferredLength;
		let adaptedContent = content;

		if (preferredLength === 'concise') {
			// Shorten content by removing redundant phrases
			const sentences = content.split('. ');
			adaptedContent = sentences.slice(0, Math.ceil(sentences.length * 0.7)).join('. ');
		} else if (preferredLength === 'comprehensive') {
			// Expand with additional details and examples
			adaptedContent = `${content}\n\nFor example, this approach can be particularly effective when...`;
		}

		return {
			content: adaptedContent,
			description: `Adapted to ${preferredLength} length preference`,
			confidence: 0.6,
		};
	}

	private async adaptStyle(
		content: string,
		profile: PersonalizationProfile,
		context?: Record<string, unknown>
	): Promise<{
		content: string;
		description: string;
		confidence: number;
	}> {
		// Style adaptation based on user's style guides and preferences
		let adaptedContent = content;
		const styleGuides = profile.writingPreferences.styleGuides;

		if (styleGuides.includes('AP')) {
			// Apply AP style conventions
			adaptedContent = content.replace(/\bOK\b/g, 'OK').replace(/email/g, 'e-mail');
		}

		return {
			content: adaptedContent,
			description: `Applied ${styleGuides.join(', ')} style guide(s)`,
			confidence: 0.7,
		};
	}

	private calculatePersonalizationScore(
		original: string,
		personalized: string,
		adaptations: PersonalizedContent['adaptations']
	): number {
		if (original === personalized) return 0;

		const adaptationScore =
			adaptations.reduce((sum, adaptation) => sum + adaptation.confidence, 0) /
			adaptations.length;

		const changeRatio = Math.abs(personalized.length - original.length) / original.length;

		return Math.min(adaptationScore + changeRatio * 0.3, 1.0);
	}

	private async generateWorkflowRecommendations(
		profile: PersonalizationProfile
	): Promise<LearningRecommendation[]> {
		const recommendations: LearningRecommendation[] = [];

		// Analyze frequent operations for workflow optimization
		const sortedOps = Array.from(profile.behaviorPatterns.frequentOperations.entries())
			.sort(([, a], [, b]) => b - a)
			.slice(0, 3);

		for (const [operation, count] of sortedOps) {
			if (count > 5) {
				// Frequently used
				recommendations.push({
					type: 'workflow',
					priority: 'medium',
					title: `Optimize ${operation} workflow`,
					description: `You use ${operation} frequently (${count} times). Consider creating shortcuts or templates.`,
					actionable: true,
					implementation: {
						steps: [
							`Create keyboard shortcut for ${operation}`,
							'Set up template for common parameters',
							'Enable one-click access in UI',
						],
						estimatedImpact: 0.7,
						effort: 'low',
					},
				});
			}
		}

		return recommendations;
	}

	private async generateFeatureRecommendations(
		profile: PersonalizationProfile
	): Promise<LearningRecommendation[]> {
		const recommendations: LearningRecommendation[] = [];

		// Analyze satisfaction trend for feature suggestions
		const recentSatisfaction = profile.feedbackPatterns.satisfactionTrend.slice(-5);
		if (recentSatisfaction.length >= 3) {
			const avgSatisfaction =
				recentSatisfaction.reduce((sum, rating) => sum + rating, 0) /
				recentSatisfaction.length;

			if (avgSatisfaction < 3.5) {
				recommendations.push({
					type: 'feature',
					priority: 'high',
					title: 'Explore advanced features',
					description:
						'Your recent satisfaction scores suggest you might benefit from advanced features.',
					actionable: true,
					implementation: {
						steps: [
							'Review available advanced features',
							'Enable beta features in settings',
							'Schedule feature tutorial session',
						],
						estimatedImpact: 0.8,
						effort: 'medium',
					},
				});
			}
		}

		return recommendations;
	}

	private async generateContentRecommendations(
		profile: PersonalizationProfile
	): Promise<LearningRecommendation[]> {
		const recommendations: LearningRecommendation[] = [];

		// Analyze feedback topics for content suggestions
		if (profile.feedbackPatterns.commonComplaintTopics.includes('unclear')) {
			recommendations.push({
				type: 'content',
				priority: 'high',
				title: 'Improve content clarity',
				description:
					'Your feedback indicates clarity issues. Enable enhanced explanations.',
				actionable: true,
				implementation: {
					steps: [
						'Enable detailed explanations in settings',
						'Turn on step-by-step guidance',
						'Activate contextual help',
					],
					estimatedImpact: 0.9,
					effort: 'low',
				},
			});
		}

		return recommendations;
	}

	private simplifyPrompt(prompt: string): string {
		return prompt
			.replace(/complex|sophisticated|advanced/g, 'simple')
			.replace(/utilize/g, 'use')
			.replace(/facilitate/g, 'help');
	}

	private enhancePrompt(prompt: string): string {
		return prompt
			.replace(/simple/g, 'sophisticated')
			.replace(/\buse\b/g, 'utilize')
			.replace(/\bhelp\b/g, 'facilitate');
	}

	private adaptPromptTone(prompt: string, tone: string): string {
		switch (tone) {
			case 'formal':
				return prompt.replace(/don't/g, 'do not').replace(/can't/g, 'cannot');
			case 'casual':
				return prompt.replace(/do not/g, "don't").replace(/cannot/g, "can't");
			default:
				return prompt;
		}
	}

	private clarifyPrompt(prompt: string): string {
		return `${prompt}\n\nPlease provide clear, step-by-step instructions with examples.`;
	}

	private calculateAdaptationConfidence(
		profile: PersonalizationProfile,
		context: Record<string, unknown>
	): number {
		let confidence = 0.5; // Base confidence

		// Higher confidence with more feedback data
		if (profile.feedbackPatterns.satisfactionTrend.length > 5) {
			confidence += 0.2;
		}

		// Higher confidence with explicit preferences
		if (profile.writingPreferences.tonePreferences.length > 0) {
			confidence += 0.2;
		}

		// Higher confidence with recent activity
		const daysSinceLastUpdate =
			(Date.now() - profile.lastUpdated.getTime()) / (1000 * 60 * 60 * 24);
		if (daysSinceLastUpdate < 7) {
			confidence += 0.1;
		}

		return Math.min(confidence, 1.0);
	}

	private getTemplateId(operation: string): string {
		return `template_${operation.replace(/[^a-zA-Z0-9]/g, '_')}`;
	}
}
