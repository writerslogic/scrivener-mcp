import { collectProseExamples } from 'narrative-lens';
import type { WritingMetrics } from './metrics-analyzer.js';
import type { StyleAnalysis } from './style-analyzer.js';
import type { QualityIndicators } from './quality-analyzer.js';

export interface Suggestion {
	type: 'style' | 'structure' | 'grammar' | 'clarity' | 'impact';
	severity: 'minor' | 'moderate' | 'major';
	location?: { paragraph: number; sentence?: number };
	issue: string;
	suggestion: string;
	example?: string;
}

export class SuggestionGenerator {
	async generateSuggestions(
		content: string,
		_metrics: WritingMetrics,
		style: StyleAnalysis,
		quality: QualityIndicators,
		proseFindings: ReturnType<typeof collectProseExamples> = style.proseFindings ??
			collectProseExamples([content])
	): Promise<Suggestion[]> {
		const suggestions: Suggestion[] = [];
		const seen = new Set<string>();
		for (const finding of proseFindings) {
			const key = JSON.stringify([
				finding.sceneId,
				finding.issueType,
				finding.snippet,
				finding.suggestion,
			]);
			if (seen.has(key)) continue;
			seen.add(key);
			suggestions.push({
				type: 'style',
				severity: 'minor',
				issue: finding.issueType,
				suggestion: finding.suggestion,
				example: finding.snippet,
			});
		}

		// Repetitiveness
		if (quality.repetitiveness !== null && quality.repetitiveness > 30) {
			suggestions.push({
				type: 'style',
				severity: 'major',
				issue: 'Repetitive word patterns detected',
				suggestion: 'Vary your word choice and sentence structure to improve flow.',
				example: 'Use synonyms and restructure similar sentences.',
			});
		}

		// Telling vs showing
		if (quality.tellingVsShowing !== null && quality.tellingVsShowing > 0.3) {
			suggestions.push({
				type: 'impact',
				severity: 'major',
				issue: 'High ratio of telling vs showing',
				suggestion: 'Show character emotions and reactions through actions and dialogue.',
				example:
					'Instead of "She was angry", write "She slammed the door, her hands trembling".',
			});
		}

		// Sensory details
		if (quality.sensoryDetails === 'lacking') {
			suggestions.push({
				type: 'impact',
				severity: 'moderate',
				issue: 'Lacking sensory details',
				suggestion:
					'Add sight, sound, smell, taste, and touch descriptions to immerse readers.',
				example: 'Describe the environment using multiple senses.',
			});
		}

		return suggestions;
	}
}
