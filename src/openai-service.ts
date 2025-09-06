/**
 * OpenAI API Integration Service
 * Provides advanced AI-powered writing suggestions and analysis
 */

import OpenAI from 'openai';
import { AppError, ErrorCode } from './utils/common.js';

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
			console.error('OpenAI API error:', error);
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
			console.error('OpenAI API error:', error);
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
			console.error('OpenAI API error:', error);
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
			console.error('OpenAI API error:', error);
			return this.getDefaultPlotAnalysis();
		}
	}

	/**
	 * Generate creative writing prompts
	 */
	async generateWritingPrompts(
		genre?: string,
		theme?: string,
		count: number = 5
	): Promise<string[]> {
		if (!this.client) {
			throw new AppError(
				'OpenAI service not configured. Please provide an API key.',
				ErrorCode.CONFIGURATION_ERROR
			);
		}

		const genreText = genre ? `in the ${genre} genre` : '';
		const themeText = theme ? `exploring the theme of ${theme}` : '';

		const prompt = `Generate ${count} creative writing prompts ${genreText} ${themeText}. 
        Make them specific, engaging, and designed to spark creativity.
        
        Return as a JSON array of strings:
        ["prompt1", "prompt2", "prompt3", ...]`;

		try {
			const response = await this.client.chat.completions.create({
				model: this.config.model!,
				messages: [
					{
						role: 'system',
						content:
							'You are a creative writing instructor. Generate inspiring writing prompts in JSON format.',
					},
					{
						role: 'user',
						content: prompt,
					},
				],
				max_tokens: this.config.maxTokens,
				temperature: 0.8, // Higher creativity for prompts
			});

			const content = response.choices[0]?.message?.content;
			if (!content) {
				return [];
			}

			try {
				const prompts = JSON.parse(content);
				return Array.isArray(prompts) ? prompts : [];
			} catch {
				return [];
			}
		} catch (error) {
			console.error('OpenAI API error:', error);
			return [];
		}
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

			const suggestions = JSON.parse(jsonStr);

			if (Array.isArray(suggestions)) {
				return suggestions.map((s) => ({
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
			console.error('Failed to parse writing suggestions:', error);
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

			const analysis = JSON.parse(jsonStr);

			return {
				tone: analysis.tone || 'neutral',
				voice: analysis.voice || 'third person',
				strengths: Array.isArray(analysis.strengths) ? analysis.strengths : [],
				weaknesses: Array.isArray(analysis.weaknesses) ? analysis.weaknesses : [],
				suggestions: Array.isArray(analysis.suggestions) ? analysis.suggestions : [],
			};
		} catch (error) {
			console.error('Failed to parse style analysis:', error);
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

			const analysis = JSON.parse(jsonStr);

			if (analysis.characters && Array.isArray(analysis.characters)) {
				return analysis.characters.map((char: Record<string, unknown>) => ({
					name: char.name || 'Unknown',
					consistency: char.consistency || 0.5,
					development: char.development || 'developing',
					dialogue_quality: char.dialogue_quality || 0.5,
					suggestions: Array.isArray(char.suggestions) ? char.suggestions : [],
				}));
			}

			return [];
		} catch (error) {
			console.error('Failed to parse character analysis:', error);
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

			const analysis = JSON.parse(jsonStr);

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
			console.error('Failed to parse plot analysis:', error);
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
