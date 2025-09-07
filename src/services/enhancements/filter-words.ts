/**
 * Filter words elimination enhancement
 */

import type { Change } from '../../types/enhancements.js';

const FILTER_WORDS = [
	'felt',
	'saw',
	'heard',
	'noticed',
	'realized',
	'thought',
	'knew',
	'understood',
	'seemed',
	'appeared',
	'looked',
	'sounded',
	'watched',
	'observed',
	'considered',
	'wondered',
	'decided',
	'believed',
	'supposed',
	'figured',
	'guessed',
	'could see',
	'could hear',
	'could feel',
	'could tell',
];

export class FilterWordsEnhancer {
	eliminate(content: string, changes: Change[]): string {
		let offset = 0;

		// Process each sentence
		const sentences = content.split(/(?<=[.!?])\s+/);

		for (let i = 0; i < sentences.length; i++) {
			const sentence = sentences[i];

			for (const filterWord of FILTER_WORDS) {
				const regex = new RegExp(`\\b(${filterWord})\\b`, 'gi');
				const matches = sentence.matchAll(regex);

				for (const match of matches) {
					if (!match.index) continue;

					// Check context to ensure it's being used as a filter
					const before = sentence.substring(0, match.index);
					const after = sentence.substring(match.index + match[0].length);

					if (this.isFilterUsage(before, after, filterWord)) {
						const rewrite = this.rewriteWithoutFilter(
							sentence,
							match.index,
							filterWord
						);

						if (rewrite && rewrite !== sentence) {
							changes.push({
								type: 'filter-word-elimination',
								original: sentence,
								replacement: rewrite,
								reason: `Removed filter word "${filterWord}" to show instead of tell`,
								location: {
									start: offset + match.index,
									end: offset + match.index + match[0].length,
								},
							});

							sentences[i] = rewrite;
							break; // Move to next sentence after change
						}
					}
				}
			}

			offset += sentence.length + 1; // +1 for space
		}

		return sentences.join(' ');
	}

	private isFilterUsage(before: string, after: string, _filterWord: string): boolean {
		// Check if it's actually filtering perception
		const subjectPattern = /\b(he|she|they|I|we|[A-Z][a-z]+)\s*$/i;
		const hasSubject = subjectPattern.test(before);

		// Check if followed by perception/thought content
		const perceptionPattern = /^\s*(that|how|the|a|an|his|her|their)/i;
		const hasPerceptionContent = perceptionPattern.test(after);

		return hasSubject && hasPerceptionContent;
	}

	private rewriteWithoutFilter(
		sentence: string,
		filterIndex: number,
		filterWord: string
	): string | null {
		// Extract the core observation
		const patterns: Record<string, (sentence: string) => string | null> = {
			saw: (s) => this.convertVisualFilter(s),
			heard: (s) => this.convertAuditoryFilter(s),
			felt: (s) => this.convertTactileFilter(s),
			realized: (s) => this.convertCognitiveFilter(s),
			noticed: (s) => this.convertObservationFilter(s),
		};

		const converter = patterns[filterWord.toLowerCase()];
		return converter ? converter(sentence) : null;
	}

	private convertVisualFilter(sentence: string): string | null {
		// "She saw the door open" -> "The door opened"
		const match = sentence.match(/(\w+)\s+saw\s+(.*)/i);
		if (match) {
			const [, , observation] = match;
			// Remove articles and possessives that don't make sense without subject
			const cleaned = observation.replace(/^(the|a|an|his|her|their|my|your)\s+/, '');
			return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
		}
		return null;
	}

	private convertAuditoryFilter(sentence: string): string | null {
		// "He heard footsteps approaching" -> "Footsteps approached"
		const match = sentence.match(/(\w+)\s+heard\s+(.*)/i);
		if (match) {
			const [, , sound] = match;
			const cleaned = sound.replace(/^(the|a|an)\s+/, '');
			return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
		}
		return null;
	}

	private convertTactileFilter(sentence: string): string | null {
		// "She felt the cold wind" -> "Cold wind swept past"
		const match = sentence.match(/(\w+)\s+felt\s+(.*)/i);
		if (match) {
			const [, , sensation] = match;
			// Add action verbs for physical sensations
			if (sensation.includes('cold')) {
				return `${sensation.replace('cold', 'Cold')} swept past.`;
			}
			if (sensation.includes('warm') || sensation.includes('hot')) {
				return `${sensation.charAt(0).toUpperCase() + sensation.slice(1)} enveloped the area.`;
			}
			return sensation.charAt(0).toUpperCase() + sensation.slice(1);
		}
		return null;
	}

	private convertCognitiveFilter(sentence: string): string | null {
		// "He realized the truth" -> State the truth directly
		const match = sentence.match(/(\w+)\s+realized\s+(.*)/i);
		if (match) {
			const [, , realization] = match;
			// Remove "that" if present
			const cleaned = realization.replace(/^that\s+/, '');
			return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
		}
		return null;
	}

	private convertObservationFilter(sentence: string): string | null {
		// "She noticed the broken window" -> "The window was broken"
		const match = sentence.match(/(\w+)\s+noticed\s+(.*)/i);
		if (match) {
			const [, , observation] = match;
			const cleaned = observation.replace(/^(the|a|an)\s+/, '');

			// Add appropriate verb if missing
			if (!cleaned.includes('was') && !cleaned.includes('were')) {
				if (
					cleaned.includes('broken') ||
					cleaned.includes('open') ||
					cleaned.includes('closed')
				) {
					return `The ${cleaned.replace(/^(\w+)\s+/, '$1 was ')}`;
				}
			}

			return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
		}
		return null;
	}
}
