/**
 * Style Guide Formatting Utilities
 * Consolidates style guide formatting across AI services
 */

import type { StyleGuide } from '../memory-manager.js';

export interface StyleGuideContextOptions {
	contextType?: 'general' | 'critique' | 'perspective' | 'analysis';
	includeGuidelines?: boolean;
	maxGuidelines?: number;
	customFields?: string[];
}

/**
 * Format style guide information for prompts
 * Eliminates duplicate style guide formatting code
 */
export function formatStyleGuideContext(
	styleGuide?: StyleGuide,
	options: StyleGuideContextOptions = {}
): string {
	if (!styleGuide) return '';

	const {
		contextType = 'general',
		includeGuidelines = true,
		maxGuidelines = 3,
		customFields = [],
	} = options;

	// Base context always includes these core fields
	let context = `\n\nStyle Guide Context:
- Genre: ${styleGuide.genre || 'Not specified'}
- Target Audience: ${styleGuide.audience || 'Not specified'}
- Tone: ${styleGuide.tone || 'Not specified'}`;

	// Add voice if available
	if (styleGuide.voice) {
		context += `\n- Voice: ${styleGuide.voice}`;
	}

	// Add style notes if available
	if (styleGuide.styleNotes) {
		context += `\n- Style Notes: ${styleGuide.styleNotes}`;
	}

	// Add custom fields if specified
	for (const field of customFields) {
		const value = (styleGuide as unknown as Record<string, unknown>)[field];
		if (value) {
			const fieldName = field.charAt(0).toUpperCase() + field.slice(1);
			context += `\n- ${fieldName}: ${value}`;
		}
	}

	// Add guidelines based on context type
	if (includeGuidelines && styleGuide.customGuidelines?.length) {
		const guidelines = styleGuide.customGuidelines.slice(0, maxGuidelines).join(', ');

		switch (contextType) {
			case 'critique':
				context += `\n- Guidelines to check: ${guidelines}
- Focus on adherence to specified requirements`;
				break;
			case 'perspective':
				context += `\n- Key guidelines: ${guidelines}
- Apply these principles in analysis`;
				break;
			case 'analysis':
				context += `\n- Analytical guidelines: ${guidelines}
- Consider these standards in evaluation`;
				break;
			default:
				context += `\n- Guidelines: ${guidelines}`;
		}
	}

	// Add context-specific instructions
	switch (contextType) {
		case 'critique':
			context += `\n\nPlease evaluate how well the content aligns with these style guide requirements.`;
			break;
		case 'perspective':
			context += `\n\nConsider these style requirements when providing your perspective.`;
			break;
		case 'analysis':
			context += `\n\nAnalyze the content against these style guide standards.`;
			break;
		default:
			context += `\n\nPlease consider these style requirements in your response.`;
	}

	return context;
}

/**
 * Generate style guide validation prompt
 */
export function createStyleGuideValidationPrompt(
	styleGuide: StyleGuide,
	content: string,
	focusAreas: string[] = []
): string {
	const context = formatStyleGuideContext(styleGuide, {
		contextType: 'critique',
		includeGuidelines: true,
	});

	let prompt = `Evaluate this content against the style guide requirements:${context}

Content to evaluate:
"${content}"`;

	if (focusAreas.length > 0) {
		prompt += `\n\nFocus evaluation on: ${focusAreas.join(', ')}`;
	}

	prompt += `\n\nProvide:
1. Compliance score (0-100)
2. Areas of alignment
3. Areas needing improvement
4. Specific recommendations`;

	return prompt;
}

/**
 * Check if content has sufficient style guide information
 */
export function hasMinimalStyleGuideInfo(styleGuide?: StyleGuide): boolean {
	if (!styleGuide) return false;

	// Consider sufficient if it has at least genre or tone + target audience
	const hasGenre = !!styleGuide.genre;
	const hasTone = !!styleGuide.tone;
	const hasAudience = !!styleGuide.audience;

	return (hasGenre || hasTone) && hasAudience;
}

/**
 * Extract style guide summary for logging
 */
export function getStyleGuideSummary(styleGuide?: StyleGuide): Record<string, unknown> {
	if (!styleGuide) return { hasStyleGuide: false };

	return {
		hasStyleGuide: true,
		genre: styleGuide.genre || 'unspecified',
		tone: styleGuide.tone || 'unspecified',
		audience: styleGuide.audience || 'unspecified',
		hasGuidelines: !!styleGuide.customGuidelines?.length,
		guidelineCount: styleGuide.customGuidelines?.length || 0,
		hasVoice: !!styleGuide.voice,
		hasStyleNotes: !!styleGuide.styleNotes,
	};
}
