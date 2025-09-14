import { splitIntoSentences } from '../../utils/text-metrics.js';
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
		metrics: WritingMetrics,
		style: StyleAnalysis,
		quality: QualityIndicators
	): Promise<Suggestion[]> {
		const suggestions: Suggestion[] = [];

		// Sentence length suggestions
		if (metrics.averageSentenceLength > 25) {
			suggestions.push({
				type: 'style',
				severity: 'moderate',
				issue: 'Long average sentence length',
				suggestion: 'Consider breaking up longer sentences for better readability.',
				example: 'Split compound sentences at conjunctions like "and" or "but".',
			});
		}

		// Adverb usage
		if (style.adverbUsage === 'heavy') {
			suggestions.push({
				type: 'style',
				severity: 'minor',
				issue: 'Heavy adverb usage',
				suggestion: 'Replace adverbs with stronger verbs for more impactful writing.',
				example: 'Instead of "walked quickly", use "hurried" or "rushed".',
			});
		}

		// Passive voice
		if (style.passiveVoicePercentage > 20) {
			suggestions.push({
				type: 'clarity',
				severity: 'moderate',
				issue: 'High passive voice usage',
				suggestion:
					'Convert passive constructions to active voice for more engaging prose.',
				example: 'Change "The ball was thrown by John" to "John threw the ball".',
			});
		}

		// Repetitiveness
		if (quality.repetitiveness > 30) {
			suggestions.push({
				type: 'style',
				severity: 'major',
				issue: 'Repetitive word patterns detected',
				suggestion: 'Vary your word choice and sentence structure to improve flow.',
				example: 'Use synonyms and restructure similar sentences.',
			});
		}

		// Filter words
		if (quality.filterWords.length > 5) {
			suggestions.push({
				type: 'impact',
				severity: 'minor',
				issue: `Filter words weakening prose: ${quality.filterWords.slice(0, 5).join(', ')}`,
				suggestion: 'Remove or replace filter words for more direct, impactful writing.',
				example: 'Instead of "He thought it was strange", write "It was strange".',
			});
		}

		// Clichés
		if (quality.cliches.length > 0) {
			suggestions.push({
				type: 'style',
				severity: 'moderate',
				issue: `Clichés detected: ${quality.cliches.join(', ')}`,
				suggestion: 'Replace clichés with fresh, original descriptions.',
				example: "Create unique metaphors that fit your story's voice.",
			});
		}

		// Telling vs showing
		if (quality.tellingVsShowing > 0.3) {
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

		// Sentence length variation
		const sentences = splitIntoSentences(content);
		const longSentences = sentences.filter((s: string) => s.trim().split(/\s+/).length > 30);

		if (metrics.averageSentenceLength > 25 || longSentences.length > 0) {
			suggestions.push({
				type: 'clarity',
				severity: 'moderate',
				issue:
					longSentences.length > 0
						? 'Very long sentences detected'
						: 'Long average sentence length',
				suggestion: 'Break up long sentences for better readability and flow.',
				example: 'Split complex sentences into shorter, clearer statements.',
			});
		}

		return suggestions;
	}
}