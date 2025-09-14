import { splitIntoSentences } from '../../../utils/text-metrics.js';
import type { Change, EnhancementOptions } from '../content-enhancer.js';

export class PacingEnhancer {
	fixPacing(content: string, changes: Change[], options: EnhancementOptions): string {
		const sentences = splitIntoSentences(content);
		const processedSentences: string[] = [];

		for (let i = 0; i < sentences.length; i++) {
			const sentence = sentences[i].trim();
			if (!sentence) {
				processedSentences.push(sentence);
				continue;
			}

			const wordCount = sentence.split(/\s+/).length;
			let modifiedSentence = sentence;

			// Handle overly long sentences (slow pacing)
			if (wordCount > 25) {
				const broken = this.breakLongSentence(sentence);
				if (broken !== sentence) {
					changes.push({
						type: 'pacing-fix',
						original: sentence,
						replacement: broken,
						reason: 'Broke long sentence to improve pacing',
						location: { start: 0, end: sentence.length },
					});
					modifiedSentence = broken;
				}
			}

			// Handle overly short sentences in sequence (choppy pacing)
			if (wordCount < 6 && i > 0) {
				const prevSentence = sentences[i - 1].trim();
				const prevWordCount = prevSentence.split(/\s+/).length;

				if (prevWordCount < 8 && this.canCombineSentences(prevSentence, sentence)) {
					const combined = this.combineSentences(prevSentence, sentence);
					changes.push({
						type: 'pacing-fix',
						original: prevSentence + ' ' + sentence,
						replacement: combined,
						reason: 'Combined short sentences to improve flow',
						location: { start: 0, end: (prevSentence + ' ' + sentence).length },
					});
					
					// Replace the previous sentence with the combined version
					processedSentences[processedSentences.length - 1] = combined;
					continue; // Skip adding current sentence separately
				}
			}

			processedSentences.push(modifiedSentence);
		}

		return processedSentences.join(' ');
	}

	fixContinuity(content: string, changes: Change[], context?: string): string {
		// Parse context for character and location information
		const contextInfo = context ? this.parseContext(context) : { characters: [], locations: [] };
		
		let result = content;

		// Fix character name consistency
		for (const character of contextInfo.characters) {
			const variations = this.findNameVariations(character, content);
			if (variations.length > 1) {
				// Use the most common variation as the standard
				const standard = variations[0];
				for (let i = 1; i < variations.length; i++) {
					const variation = variations[i];
					const regex = new RegExp(`\\b${variation}\\b`, 'g');
					if (regex.test(result)) {
						changes.push({
							type: 'continuity-fix',
							original: variation,
							replacement: standard,
							reason: `Standardized character name "${variation}" to "${standard}"`,
							location: { start: 0, end: variation.length },
						});
						result = result.replace(regex, standard);
					}
				}
			}
		}

		return result;
	}

	private breakLongSentence(sentence: string): string {
		// Find natural break points
		const breakPoints = [
			{ pattern: ' and ', replacement: '. ' },
			{ pattern: ' but ', replacement: '. However, ' },
			{ pattern: ' so ', replacement: '. Therefore, ' },
			{ pattern: '; ', replacement: '. ' },
			{ pattern: ', which ', replacement: '. This ' },
			{ pattern: ', that ', replacement: '. That ' }
		];

		for (const breakPoint of breakPoints) {
			const index = sentence.indexOf(breakPoint.pattern);
			if (index > 10 && index < sentence.length - 10) {
				const part1 = sentence.substring(0, index);
				const part2 = sentence.substring(index + breakPoint.pattern.length);
				
				if (part2) {
					const capitalizedPart2 = part2.charAt(0).toUpperCase() + part2.slice(1);
					return part1 + breakPoint.replacement + capitalizedPart2;
				}
			}
		}

		return sentence;
	}

	private canCombineSentences(sentence1: string, sentence2: string): boolean {
		// Check if sentences are related and suitable for combination
		const words1 = new Set(sentence1.toLowerCase().split(/\s+/).filter(w => w.length > 3));
		const words2 = new Set(sentence2.toLowerCase().split(/\s+/).filter(w => w.length > 3));
		
		const intersection = new Set([...words1].filter(x => words2.has(x)));
		const similarity = intersection.size / Math.max(words1.size, words2.size);
		
		// Combine if there's some thematic similarity
		return similarity > 0.2;
	}

	private combineSentences(sentence1: string, sentence2: string): string {
		// Choose appropriate conjunction based on relationship
		const conjunctions = ['and', 'while', 'as'];
		const conjunction = conjunctions[Math.floor(Math.random() * conjunctions.length)];
		
		return sentence1.replace(/\.$/, '') + ' ' + conjunction + ' ' + sentence2.toLowerCase();
	}

	private parseContext(context: string): { characters: string[]; locations: string[] } {
		// Simple pattern matching for character and location names
		const characterPattern = /(?:character|person|protagonist|hero|heroine):\s*([^,\n]+)/gi;
		const locationPattern = /(?:location|setting|place):\s*([^,\n]+)/gi;

		const characters: string[] = [];
		const locations: string[] = [];

		let match;
		while ((match = characterPattern.exec(context)) !== null) {
			characters.push(match[1].trim());
		}

		while ((match = locationPattern.exec(context)) !== null) {
			locations.push(match[1].trim());
		}

		// Also look for proper nouns that might be names
		const properNouns = context.match(/\b[A-Z][a-z]+\b/g) || [];
		characters.push(...properNouns.filter(name => name.length > 2));

		return {
			characters: [...new Set(characters)], // Remove duplicates
			locations: [...new Set(locations)]
		};
	}

	private findNameVariations(name: string, content: string): string[] {
		const variations = [name];
		
		// Look for common nickname patterns
		if (name.length > 4) {
			const shortForm = name.substring(0, 3);
			const regex = new RegExp(`\\b${shortForm}\\b`, 'g');
			if (regex.test(content)) {
				variations.push(shortForm);
			}
		}

		// Look for formal vs informal versions
		const formalPattern = new RegExp(`\\b(?:Mr|Mrs|Ms|Dr)\\.?\\s+${name}\\b`, 'gi');
		const matches = content.match(formalPattern);
		if (matches) {
			variations.push(...matches);
		}

		return [...new Set(variations)]; // Remove duplicates
	}
}