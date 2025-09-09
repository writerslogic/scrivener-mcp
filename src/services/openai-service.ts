/**
 * OpenAI API Integration Service
 * Provides advanced AI-powered writing suggestions and analysis
 */

import OpenAI from 'openai';
import { ApplicationError as AppError, ErrorCode } from '../core/errors.js';
import { getLogger } from '../core/logger.js';
import { safeParse } from '../utils/common.js';

const logger = getLogger('openai-service');

export interface OpenAIConfig {
	apiKey?: string;
	model?: string;
	maxTokens?: number;
	temperature?: number;
}

export interface WritingSuggestion {
	type: 'grammar' | 'style' | 'clarity' | 'tone' | 'structure' | 'character' | 'plot';
	severity: 'low' | 'medium' | 'high';
	original: string;
	suggestion: string;
	explanation: string;
	confidence: number;
}

export interface StyleAnalysis {
	tone: string;
	voice: string;
	strengths: string[];
	weaknesses: string[];
	suggestions: WritingSuggestion[];
}

export interface CharacterAnalysis {
	name: string;
	consistency: number;
	development: string;
	dialogue_quality: number;
	suggestions: string[];
}

export interface PlotAnalysis {
	pacing: 'slow' | 'moderate' | 'fast';
	tension: number;
	structure_issues: string[];
	plot_holes: string[];
	suggestions: string[];
}

export class OpenAIService {
	private client: OpenAI | null = null;
	private config: OpenAIConfig;

	constructor(config: OpenAIConfig = {}) {
		this.config = {
			model: 'gpt-4o-mini',
			maxTokens: 2000,
			temperature: 0.3,
			...config,
		};

		if (config.apiKey) {
			this.client = new OpenAI({
				apiKey: config.apiKey,
			});
		}
	}

	/**
	 * Configure OpenAI service with API key
	 */
	configure(config: OpenAIConfig): void {
		this.config = { ...this.config, ...config };

		if (config.apiKey) {
			this.client = new OpenAI({
				apiKey: config.apiKey,
			});
		}
	}

	/**
	 * Check if service is configured and ready
	 */
	isConfigured(): boolean {
		return this.client !== null && !!this.config.apiKey;
	}

	/**
	 * Get advanced writing suggestions using GPT
	 */
	async getWritingSuggestions(
		text: string,
		context?: { genre?: string; targetAudience?: string; style?: string }
	): Promise<WritingSuggestion[]> {
		if (!this.client) {
			throw new AppError(
				'OpenAI service not configured. Please provide an API key.',
				ErrorCode.CONFIGURATION_ERROR
			);
		}

		const prompt = this.buildSuggestionsPrompt(text, context);

		try {
			const response = await this.client.chat.completions.create({
				model: this.config.model!,
				messages: [
					{
						role: 'system',
						content:
							'You are an expert writing coach and editor. Analyze the provided text and return suggestions in valid JSON format.',
					},
					{
						role: 'user',
						content: prompt,
					},
				],
				max_tokens: this.config.maxTokens,
				temperature: this.config.temperature,
			});

			const content = response.choices[0]?.message?.content;
			if (!content) {
				return [];
			}

			return this.parseWritingSuggestions(content);
		} catch (error) {
			logger.error('OpenAI API error', { error });
			return [];
		}
	}

	/**
	 * Analyze writing style using GPT
	 */
	async analyzeStyle(text: string): Promise<StyleAnalysis> {
		if (!this.client) {
			throw new AppError(
				'OpenAI service not configured. Please provide an API key.',
				ErrorCode.CONFIGURATION_ERROR
			);
		}

		const prompt = `Analyze the writing style of the following text and provide a detailed assessment:

TEXT:
${text}

Please analyze:
1. Overall tone (formal, casual, academic, literary, etc.)
2. Voice characteristics (first/third person, narrator type, etc.)
3. Key strengths in the writing
4. Areas that need improvement
5. Specific suggestions for enhancement

Return your analysis in this JSON format:
{
    "tone": "description of tone",
    "voice": "description of voice",
    "strengths": ["strength1", "strength2", ...],
    "weaknesses": ["weakness1", "weakness2", ...],
    "suggestions": [
        {
            "type": "style|grammar|clarity|tone|structure",
            "severity": "low|medium|high",
            "original": "text excerpt",
            "suggestion": "improvement",
            "explanation": "why this helps",
            "confidence": 0.85
        }
    ]
}`;

		try {
			const response = await this.client.chat.completions.create({
				model: this.config.model!,
				messages: [
					{
						role: 'system',
						content:
							'You are a professional writing analyst. Provide detailed style analysis in valid JSON format.',
					},
					{
						role: 'user',
						content: prompt,
					},
				],
				max_tokens: this.config.maxTokens,
				temperature: this.config.temperature,
			});

			const content = response.choices[0]?.message?.content;
			if (!content) {
				return this.getDefaultStyleAnalysis();
			}

			return this.parseStyleAnalysis(content);
		} catch (error) {
			logger.error('OpenAI API error', { error });
			return this.getDefaultStyleAnalysis();
		}
	}

	/**
	 * Analyze character development and consistency
	 */
	async analyzeCharacters(text: string, characterNames?: string[]): Promise<CharacterAnalysis[]> {
		if (!this.client) {
			throw new AppError(
				'OpenAI service not configured. Please provide an API key.',
				ErrorCode.CONFIGURATION_ERROR
			);
		}

		const charactersPrompt =
			characterNames && characterNames.length > 0
				? `Focus on these specific characters: ${characterNames.join(', ')}.`
				: 'Identify and analyze all significant characters in the text.';

		const prompt = `Analyze character development in the following text:

TEXT:
${text}

${charactersPrompt}

For each character, assess:
1. Consistency of personality and behavior
2. Character development arc
3. Dialogue quality and authenticity
4. Areas for improvement

Return analysis in this JSON format:
{
    "characters": [
        {
            "name": "Character Name",
            "consistency": 0.85,
            "development": "well-developed|developing|flat|inconsistent",
            "dialogue_quality": 0.90,
            "suggestions": ["suggestion1", "suggestion2"]
        }
    ]
}`;

		try {
			const response = await this.client.chat.completions.create({
				model: this.config.model!,
				messages: [
					{
						role: 'system',
						content:
							'You are a character development expert. Analyze characters and return valid JSON.',
					},
					{
						role: 'user',
						content: prompt,
					},
				],
				max_tokens: this.config.maxTokens,
				temperature: this.config.temperature,
			});

			const content = response.choices[0]?.message?.content;
			if (!content) {
				return [];
			}

			return this.parseCharacterAnalysis(content);
		} catch (error) {
			logger.error('OpenAI API error', { error });
			return [];
		}
	}

	/**
	 * Analyze plot structure and pacing
	 */
	async analyzePlot(text: string): Promise<PlotAnalysis> {
		if (!this.client) {
			throw new AppError(
				'OpenAI service not configured. Please provide an API key.',
				ErrorCode.CONFIGURATION_ERROR
			);
		}

		const prompt = `Analyze the plot structure and pacing of the following text:

TEXT:
${text}

Assess:
1. Overall pacing (slow, moderate, fast)
2. Tension levels throughout
3. Structural issues or weaknesses
4. Potential plot holes or inconsistencies
5. Suggestions for improvement

Return analysis in this JSON format:
{
    "pacing": "slow|moderate|fast",
    "tension": 0.75,
    "structure_issues": ["issue1", "issue2"],
    "plot_holes": ["hole1", "hole2"],
    "suggestions": ["suggestion1", "suggestion2"]
}`;

		try {
			const response = await this.client.chat.completions.create({
				model: this.config.model!,
				messages: [
					{
						role: 'system',
						content:
							'You are a plot structure expert. Analyze narrative structure and return valid JSON.',
					},
					{
						role: 'user',
						content: prompt,
					},
				],
				max_tokens: this.config.maxTokens,
				temperature: this.config.temperature,
			});

			const content = response.choices[0]?.message?.content;
			if (!content) {
				return this.getDefaultPlotAnalysis();
			}

			return this.parsePlotAnalysis(content);
		} catch (error) {
			logger.error('OpenAI API error', { error });
			return this.getDefaultPlotAnalysis();
		}
	}

	/**
	 * Analyze project context to generate more relevant prompts
	 */
	async analyzeProjectForPrompts(projectData: {
		characters: Array<{ name: string; role?: string; traits?: string[] }>;
		plotThreads: Array<{ name: string; status?: string }>;
		themes: string[];
		genre?: string;
		recentScenes?: string[];
		wordCount?: number;
	}): Promise<{
		suggestedPromptTypes: string[];
		contextualThemes: string[];
		characterDevelopmentNeeds: string[];
		plotGaps: string[];
		recommendedExercises: string[];
	}> {
		if (!this.client) {
			// Return sensible defaults if not configured
			return {
				suggestedPromptTypes: ['character', 'dialogue', 'scene'],
				contextualThemes: projectData.themes || [],
				characterDevelopmentNeeds: [],
				plotGaps: [],
				recommendedExercises: [
					'character voice practice',
					'scene setting',
					'dialogue dynamics',
				],
			};
		}

		try {
			const prompt = `Analyze this writing project data and suggest areas for development:
			
Characters: ${JSON.stringify(projectData.characters.slice(0, 10))}
Plot Threads: ${JSON.stringify(projectData.plotThreads.slice(0, 10))}
Themes: ${projectData.themes.join(', ')}
Genre: ${projectData.genre || 'fiction'}
Current Word Count: ${projectData.wordCount || 0}

Provide a JSON response with:
{
	"suggestedPromptTypes": ["types of prompts that would benefit this project"],
	"contextualThemes": ["themes to explore based on existing content"],
	"characterDevelopmentNeeds": ["specific character aspects needing development"],
	"plotGaps": ["plot areas that could be expanded"],
	"recommendedExercises": ["specific writing exercises for this project"]
}`;

			const response = await this.client.chat.completions.create({
				model: this.config.model || 'gpt-4o-mini',
				messages: [
					{
						role: 'system',
						content:
							'You are a writing coach analyzing a project to suggest targeted exercises.',
					},
					{ role: 'user', content: prompt },
				],
				max_tokens: 500,
				temperature: 0.5,
			});

			const content = response.choices[0]?.message?.content || '{}';
			const analysis = safeParse(content, {}) as {
				suggestedPromptTypes?: string[];
				contextualThemes?: string[];
				characterDevelopmentNeeds?: string[];
				plotGaps?: string[];
				recommendedExercises?: string[];
			};

			return {
				suggestedPromptTypes: analysis.suggestedPromptTypes || ['character', 'scene'],
				contextualThemes: analysis.contextualThemes || projectData.themes,
				characterDevelopmentNeeds: analysis.characterDevelopmentNeeds || [],
				plotGaps: analysis.plotGaps || [],
				recommendedExercises: analysis.recommendedExercises || [],
			};
		} catch (_error) {
			// Return defaults on error
			logger.warn('Failed to generate suggestions, returning defaults', { error: _error });
			return {
				suggestedPromptTypes: ['character', 'dialogue', 'scene'],
				contextualThemes: projectData.themes || [],
				characterDevelopmentNeeds: [],
				plotGaps: [],
				recommendedExercises: ['character development', 'plot advancement'],
			};
		}
	}

	/**
	 * Generate intelligent, context-aware writing prompts
	 */
	async generateWritingPrompts(
		options: {
			genre?: string;
			theme?: string;
			count?: number;
			complexity?: 'simple' | 'moderate' | 'complex';
			promptType?: 'scene' | 'character' | 'dialogue' | 'description' | 'conflict' | 'mixed';
			existingCharacters?: string[];
			currentPlotPoints?: string[];
			storyContext?: string;
			targetWordCount?: number;
			writingStyle?: string;
			mood?: string;
		} = {}
	): Promise<{
		prompts: Array<{
			prompt: string;
			type: string;
			difficulty: string;
			estimatedWords: number;
			tips: string[];
			relatedCharacters?: string[];
			suggestedTechniques?: string[];
		}>;
		overallTheme: string;
		writingGoals: string[];
	}> {
		if (!this.client) {
			throw new AppError(
				'OpenAI service not configured. Please provide an API key.',
				ErrorCode.CONFIGURATION_ERROR
			);
		}

		const {
			genre = 'general fiction',
			theme = 'human experience',
			count = 5,
			complexity = 'moderate',
			promptType = 'mixed',
			existingCharacters = [],
			currentPlotPoints = [],
			storyContext = '',
			targetWordCount = 500,
			writingStyle = 'balanced',
			mood = 'varied',
		} = options;

		// Build intelligent context
		const contextElements = [];

		if (genre) contextElements.push(`Genre: ${genre}`);
		if (theme) contextElements.push(`Theme: ${theme}`);
		if (existingCharacters.length > 0) {
			contextElements.push(
				`Existing Characters: ${existingCharacters.slice(0, 5).join(', ')}`
			);
		}
		if (currentPlotPoints.length > 0) {
			contextElements.push(
				`Current Plot Elements: ${currentPlotPoints.slice(0, 3).join('; ')}`
			);
		}
		if (storyContext) {
			contextElements.push(`Story Context: ${storyContext.substring(0, 200)}...`);
		}
		contextElements.push(`Target Word Count: ${targetWordCount}`);
		contextElements.push(`Writing Style: ${writingStyle}`);
		contextElements.push(`Mood: ${mood}`);

		const promptInstructions = `Generate ${count} intelligent, contextual writing prompts with the following requirements:

CONTEXT:
${contextElements.join('\n')}

REQUIREMENTS:
- Complexity Level: ${complexity}
- Prompt Type Focus: ${promptType}
- Each prompt should build on or relate to the existing story elements when provided
- Prompts should encourage ${complexity === 'simple' ? 'straightforward narrative development' : complexity === 'complex' ? 'layered, nuanced storytelling with multiple elements' : 'balanced storytelling with moderate depth'}
- Consider the target word count for appropriate scope

Generate prompts that:
1. Are specific and actionable
2. Include clear conflict or tension
3. Suggest a beginning, middle, or end point
4. Can integrate with existing characters/plot if provided
5. Match the requested mood and style

Return in this JSON format:
{
    "prompts": [
        {
            "prompt": "The actual writing prompt",
            "type": "scene|character|dialogue|description|conflict",
            "difficulty": "beginner|intermediate|advanced",
            "estimatedWords": 500,
            "tips": ["tip1", "tip2"],
            "relatedCharacters": ["character1"],
            "suggestedTechniques": ["show don't tell", "unreliable narrator", etc]
        }
    ],
    "overallTheme": "The connecting theme across all prompts",
    "writingGoals": ["goal1", "goal2", "goal3"]
}`;

		try {
			const response = await this.client.chat.completions.create({
				model: this.config.model!,
				messages: [
					{
						role: 'system',
						content: `You are an expert creative writing instructor and story consultant. Generate intelligent, contextual writing prompts that consider the writer's existing work, style, and goals. Always return valid JSON that can be parsed.`,
					},
					{
						role: 'user',
						content: promptInstructions,
					},
				],
				max_tokens: Math.min(this.config.maxTokens || 2000, 3000),
				temperature: complexity === 'simple' ? 0.6 : complexity === 'complex' ? 0.9 : 0.75,
			});

			const content = response.choices[0]?.message?.content;
			if (!content) {
				return this.getDefaultPromptResponse(count, genre, theme);
			}

			try {
				// Clean the response to ensure valid JSON
				const cleanedContent = content
					.replace(/```json\n?/g, '')
					.replace(/```\n?/g, '')
					.trim();

				const result = safeParse(cleanedContent, {}) as {
					prompts?: any[];
					overallTheme?: string;
					writingGoals?: string[];
				};

				// Validate and enhance the response
				if (result.prompts && Array.isArray(result.prompts)) {
					// Ensure all prompts have required fields
					result.prompts = result.prompts.map((p: any, index: number) => ({
						prompt: p.prompt || `Writing prompt ${index + 1}`,
						type: p.type || promptType,
						difficulty: p.difficulty || this.mapComplexityToDifficulty(complexity),
						estimatedWords: p.estimatedWords || targetWordCount,
						tips: Array.isArray(p.tips)
							? p.tips
							: this.getDefaultTips(p.type || promptType),
						relatedCharacters: Array.isArray(p.relatedCharacters)
							? p.relatedCharacters
							: [],
						suggestedTechniques: Array.isArray(p.suggestedTechniques)
							? p.suggestedTechniques
							: this.getDefaultTechniques(complexity),
					}));
				} else {
					return this.getDefaultPromptResponse(count, genre, theme);
				}

				// Ensure other fields exist
				result.overallTheme = result.overallTheme || `${theme} in ${genre}`;
				result.writingGoals = Array.isArray(result.writingGoals)
					? result.writingGoals
					: this.getDefaultWritingGoals(complexity);

				return result as {
					prompts: Array<{
						prompt: string;
						type: string;
						difficulty: string;
						estimatedWords: number;
						tips: string[];
						relatedCharacters?: string[];
						suggestedTechniques?: string[];
					}>;
					overallTheme: string;
					writingGoals: string[];
				};
			} catch (parseError) {
				logger.error('Failed to parse prompt response', { error: parseError });
				return this.getDefaultPromptResponse(count, genre, theme);
			}
		} catch (error) {
			logger.error('OpenAI API error', { error });
			return this.getDefaultPromptResponse(count, genre, theme);
		}
	}

	/**
	 * Generate actual content based on a writing prompt
	 */
	async generateContent(
		prompt: string,
		options: {
			length?: number;
			style?: 'narrative' | 'dialogue' | 'descriptive' | 'academic' | 'creative';
			tone?: string;
			perspective?: '1st' | '2nd' | '3rd';
			genre?: string;
			context?: string;
		} = {}
	): Promise<{
		content: string;
		wordCount: number;
		type: string;
		suggestions: string[];
		alternativeVersions: string[];
	}> {
		if (!this.client) {
			throw new AppError(
				'OpenAI service not configured. Please provide an API key.',
				ErrorCode.CONFIGURATION_ERROR
			);
		}

		const {
			length = 500,
			style = 'creative',
			tone = 'engaging',
			perspective = '3rd',
			genre = 'general fiction',
			context = '',
		} = options;

		const systemPrompt = `You are a skilled creative writer. Generate high-quality content based on the given prompt.

Style: ${style}
Tone: ${tone}  
Perspective: ${perspective} person
Genre: ${genre}
Target length: ${length} words
${context ? `Context: ${context}` : ''}

Requirements:
1. Create engaging, well-written content that matches the specified parameters
2. Maintain consistent voice and style throughout
3. Include vivid details and sensory elements where appropriate
4. Ensure proper pacing and structure
5. Return response in JSON format with content, suggestions, and alternatives`;

		const userPrompt = `Writing prompt: "${prompt}"

Please generate content based on this prompt and return in this exact JSON format:
{
  "content": "The generated content here",
  "suggestions": ["Writing tip 1", "Writing tip 2", "Writing tip 3"],
  "alternativeVersions": ["Brief alternative approach 1", "Brief alternative approach 2"]
}`;

		try {
			const response = await this.client.chat.completions.create({
				model: this.config.model || 'gpt-3.5-turbo',
				messages: [
					{ role: 'system', content: systemPrompt },
					{ role: 'user', content: userPrompt },
				],
				max_tokens: Math.min(length * 2 + 500, this.config.maxTokens || 2000),
				temperature: this.config.temperature || 0.7,
			});

			const content = response.choices[0]?.message?.content?.trim();
			if (!content) {
				return this.getDefaultContentResponse(prompt, length, style);
			}

			try {
				const result = safeParse(content, {}) as {
					content?: string;
					suggestions?: string[];
					alternativeVersions?: string[];
				};

				return {
					content: result.content || `Generated content for: ${prompt}`,
					wordCount: result.content ? result.content.split(' ').length : length,
					type: style,
					suggestions: Array.isArray(result.suggestions)
						? result.suggestions
						: [
								'Consider expanding on character motivations',
								'Add more sensory details',
							],
					alternativeVersions: Array.isArray(result.alternativeVersions)
						? result.alternativeVersions
						: [],
				};
			} catch (parseError) {
				logger.error('Failed to parse content response', { error: parseError });
				return this.getDefaultContentResponse(prompt, length, style);
			}
		} catch (error) {
			logger.error('OpenAI API error during content generation', { error });
			return this.getDefaultContentResponse(prompt, length, style);
		}
	}

	/**
	 * Get default content response when API fails
	 */
	private getDefaultContentResponse(prompt: string, length: number, style: string) {
		return {
			content: `Generated ${style} content based on the prompt: "${prompt}"\n\nThis is placeholder content that would be replaced by AI-generated text. The actual implementation would create engaging, contextually appropriate content matching your specified parameters.`,
			wordCount: Math.max(50, Math.floor(length * 0.3)),
			type: style,
			suggestions: [
				'Consider expanding on character motivations',
				'Add more sensory details to enhance immersion',
				'Vary sentence structure for better flow',
			],
			alternativeVersions: [
				'Try a different narrative perspective',
				"Explore the scene from another character's viewpoint",
			],
		};
	}

	/**
	 * Get default prompt response when API fails
	 */
	private getDefaultPromptResponse(count: number, genre: string, theme: string): any {
		const prompts = [];
		const types = ['scene', 'character', 'dialogue', 'description', 'conflict'];

		for (let i = 0; i < count; i++) {
			const type = types[i % types.length];
			prompts.push({
				prompt: this.getDefaultPromptByType(type, genre, theme),
				type,
				difficulty: 'intermediate',
				estimatedWords: 500,
				tips: this.getDefaultTips(type),
				relatedCharacters: [],
				suggestedTechniques: this.getDefaultTechniques('moderate'),
			});
		}

		return {
			prompts,
			overallTheme: `Exploring ${theme} through ${genre}`,
			writingGoals: this.getDefaultWritingGoals('moderate'),
		};
	}

	/**
	 * Get default prompt by type
	 */
	private getDefaultPromptByType(type: string, genre: string, theme: string): string {
		const prompts: Record<string, string> = {
			scene: `Write a pivotal scene in a ${genre} story where the ${theme} becomes undeniable. Include sensory details and emotional stakes.`,
			character: `Create a character in a ${genre} setting whose internal conflict embodies ${theme}. Show their struggle through action and dialogue.`,
			dialogue: `Write a dialogue-heavy scene in the ${genre} genre where two characters debate opposing views on ${theme}. Let their personalities shine through their speech patterns.`,
			description: `Describe a location in a ${genre} story that symbolically represents ${theme}. Use atmospheric details to create mood.`,
			conflict: `Develop a conflict in a ${genre} narrative where ${theme} creates an impossible choice for your protagonist.`,
		};

		return prompts[type] || prompts.scene;
	}

	/**
	 * Get default tips by prompt type
	 */
	private getDefaultTips(type: string): string[] {
		const tips: Record<string, string[]> = {
			scene: [
				'Start in medias res - in the middle of action',
				'Use all five senses to ground the reader',
				'End with a hook or revelation',
			],
			character: [
				'Show character through action, not just description',
				'Give them a clear want and a hidden need',
				'Create contradictions to add depth',
			],
			dialogue: [
				'Each character should have a distinct voice',
				"Use subtext - what's not said is often more important",
				'Avoid on-the-nose dialogue',
			],
			description: [
				'Use specific, concrete details over general descriptions',
				'Integrate description with action',
				"Consider the POV character's emotional state",
			],
			conflict: [
				'Make both choices have merit',
				'Raise the stakes progressively',
				'Connect the external conflict to internal struggle',
			],
		};

		return tips[type] || tips.scene;
	}

	/**
	 * Get default techniques based on complexity
	 */
	private getDefaultTechniques(complexity: string): string[] {
		const techniques: Record<string, string[]> = {
			simple: ["Show don't tell", 'Active voice', 'Clear structure'],
			moderate: ['Symbolism', 'Foreshadowing', 'Parallel action', 'Metaphor'],
			complex: [
				'Unreliable narrator',
				'Non-linear timeline',
				'Multiple POVs',
				'Metafiction',
				'Stream of consciousness',
			],
		};

		return techniques[complexity] || techniques.moderate;
	}

	/**
	 * Get default writing goals
	 */
	private getDefaultWritingGoals(complexity: string): string[] {
		const goals: Record<string, string[]> = {
			simple: [
				'Establish clear narrative progression',
				'Develop one main character',
				'Resolve the primary conflict',
			],
			moderate: [
				'Balance multiple story elements',
				'Develop character relationships',
				'Create thematic resonance',
				'Build narrative tension',
			],
			complex: [
				'Layer multiple meanings and interpretations',
				'Subvert genre expectations',
				'Explore philosophical questions',
				'Create structural innovation',
				'Develop complex character psychology',
			],
		};

		return goals[complexity] || goals.moderate;
	}

	/**
	 * Map complexity to difficulty
	 */
	private mapComplexityToDifficulty(complexity: string): string {
		const mapping: Record<string, string> = {
			simple: 'beginner',
			moderate: 'intermediate',
			complex: 'advanced',
		};

		return mapping[complexity] || 'intermediate';
	}

	/**
	 * Build prompt for writing suggestions
	 */
	private buildSuggestionsPrompt(
		text: string,
		context?: { genre?: string; targetAudience?: string; style?: string }
	): string {
		let contextInfo = '';
		if (context) {
			const parts = [];
			if (context.genre) parts.push(`Genre: ${context.genre}`);
			if (context.targetAudience) parts.push(`Target Audience: ${context.targetAudience}`);
			if (context.style) parts.push(`Style: ${context.style}`);
			contextInfo = parts.length > 0 ? `\nContext: ${parts.join(', ')}\n` : '';
		}

		return `Analyze the following text and provide specific writing suggestions:${contextInfo}
TEXT:
${text}

Focus on:
1. Grammar and syntax errors
2. Style improvements
3. Clarity and readability
4. Tone consistency
5. Structure and flow

Return suggestions in this JSON format:
[
    {
        "type": "grammar|style|clarity|tone|structure",
        "severity": "low|medium|high",
        "original": "exact text excerpt",
        "suggestion": "improved version",
        "explanation": "why this improvement helps",
        "confidence": 0.85
    }
]`;
	}

	/**
	 * Parse writing suggestions from GPT response
	 */
	private parseWritingSuggestions(content: string): WritingSuggestion[] {
		try {
			// Try to extract JSON from response
			const jsonMatch = content.match(/\[[\s\S]*\]/);
			const jsonStr = jsonMatch ? jsonMatch[0] : content;

			const suggestions = safeParse(jsonStr, []);

			if (Array.isArray(suggestions)) {
				return suggestions.map((s: any) => ({
					type: s.type || 'style',
					severity: s.severity || 'medium',
					original: s.original || '',
					suggestion: s.suggestion || '',
					explanation: s.explanation || '',
					confidence: s.confidence || 0.5,
				}));
			}

			return [];
		} catch (error) {
			logger.error('Failed to parse writing suggestions', { error });
			return [];
		}
	}

	/**
	 * Parse style analysis from GPT response
	 */
	private parseStyleAnalysis(content: string): StyleAnalysis {
		try {
			const jsonMatch = content.match(/\{[\s\S]*\}/);
			const jsonStr = jsonMatch ? jsonMatch[0] : content;

			const analysis: any = safeParse(jsonStr, {});

			return {
				tone: analysis.tone || 'neutral',
				voice: analysis.voice || 'third person',
				strengths: Array.isArray(analysis.strengths) ? analysis.strengths : [],
				weaknesses: Array.isArray(analysis.weaknesses) ? analysis.weaknesses : [],
				suggestions: Array.isArray(analysis.suggestions) ? analysis.suggestions : [],
			};
		} catch (error) {
			logger.error('Failed to parse style analysis', { error });
			return this.getDefaultStyleAnalysis();
		}
	}

	/**
	 * Parse character analysis from GPT response
	 */
	private parseCharacterAnalysis(content: string): CharacterAnalysis[] {
		try {
			const jsonMatch = content.match(/\{[\s\S]*\}/);
			const jsonStr = jsonMatch ? jsonMatch[0] : content;

			const analysis = safeParse(jsonStr, {}) as Record<string, any>;

			if (analysis.characters && Array.isArray(analysis.characters)) {
				return analysis.characters.map((char: Record<string, any>) => ({
					name: String(char.name || 'Unknown'),
					consistency: Number(char.consistency || 0.5),
					development: String(char.development || 'developing'),
					dialogue_quality: Number(char.dialogue_quality || 0.5),
					suggestions: Array.isArray(char.suggestions) ? char.suggestions : [],
				}));
			}

			return [];
		} catch (error) {
			logger.error('Failed to parse character analysis', { error });
			return [];
		}
	}

	/**
	 * Parse plot analysis from GPT response
	 */
	private parsePlotAnalysis(content: string): PlotAnalysis {
		try {
			const jsonMatch = content.match(/\{[\s\S]*\}/);
			const jsonStr = jsonMatch ? jsonMatch[0] : content;

			const analysis = safeParse(jsonStr, {}) as Record<string, any>;

			return {
				pacing: analysis.pacing || 'moderate',
				tension: analysis.tension || 0.5,
				structure_issues: Array.isArray(analysis.structure_issues)
					? analysis.structure_issues
					: [],
				plot_holes: Array.isArray(analysis.plot_holes) ? analysis.plot_holes : [],
				suggestions: Array.isArray(analysis.suggestions) ? analysis.suggestions : [],
			};
		} catch (error) {
			logger.error('Failed to parse plot analysis', { error });
			return this.getDefaultPlotAnalysis();
		}
	}

	/**
	 * Default style analysis fallback
	 */
	private getDefaultStyleAnalysis(): StyleAnalysis {
		return {
			tone: 'neutral',
			voice: 'third person',
			strengths: [],
			weaknesses: [],
			suggestions: [],
		};
	}

	/**
	 * Default plot analysis fallback
	 */
	private getDefaultPlotAnalysis(): PlotAnalysis {
		return {
			pacing: 'moderate',
			tension: 0.5,
			structure_issues: [],
			plot_holes: [],
			suggestions: [],
		};
	}
}

// Export singleton instance
export const openaiService = new OpenAIService();
