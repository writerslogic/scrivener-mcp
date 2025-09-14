import nlp from 'compromise';
import type { Change } from '../content-enhancer.js';

export class DialogueEnhancer {
	strengthenDialogue(content: string, changes: Change[]): string {
		// Find dialogue patterns
		const dialogueRegex = /"([^"]*?)"/g;
		let result = content;
		const matches = [...content.matchAll(dialogueRegex)];

		for (const match of matches) {
			const dialogue = match[1];
			const fullMatch = match[0];

			// Analyze emotion in dialogue
			const emotion = this.analyzeDialogueEmotion(dialogue);
			
			// Find and enhance dialogue tags
			const contextBefore = content.substring(Math.max(0, match.index! - 50), match.index!);
			const contextAfter = content.substring(match.index! + fullMatch.length, match.index! + fullMatch.length + 50);
			
			const enhancedTag = this.selectContextualDialogueTag(emotion, contextBefore, contextAfter);
			
			if (enhancedTag) {
				const original = fullMatch + (contextAfter.match(/^\s*,?\s*\w+/) || [''])[0];
				const replacement = fullMatch + ', ' + enhancedTag;
				
				changes.push({
					type: 'dialogue-enhancement',
					original,
					replacement,
					reason: `Enhanced dialogue tag based on ${emotion} emotion`,
					location: { start: match.index!, end: match.index! + original.length },
				});
				
				result = result.replace(original, replacement);
			}
		}

		return result;
	}

	private analyzeDialogueEmotion(dialogue: string): string {
		const emotionPatterns: Record<string, RegExp[]> = {
			anger: [/damn|hell|angry|mad|furious/i, /!/],
			sadness: [/sorry|sad|cry|tears|hurt/i, /\.\.\./],
			excitement: [/wow|amazing|fantastic|great/i, /!/],
			fear: [/scared|afraid|terrified|worried/i, /\?/],
			neutral: [/.*/]
		};

		for (const [emotion, patterns] of Object.entries(emotionPatterns)) {
			if (patterns.some(pattern => pattern.test(dialogue))) {
				return emotion;
			}
		}

		return 'neutral';
	}

	private selectContextualDialogueTag(
		emotion: string,
		_contextBefore: string,
		_contextAfter: string
	): string {
		const dialogueTags: Record<string, string[]> = {
			anger: ['he snapped', 'she snarled', 'he growled', 'she hissed'],
			sadness: ['he whispered', 'she murmured', 'he sighed', 'she sobbed'],
			excitement: ['he exclaimed', 'she cheered', 'he shouted', 'she laughed'],
			fear: ['he stammered', 'she trembled', 'he gulped', 'she shivered'],
			neutral: ['he said', 'she replied', 'he noted', 'she observed']
		};

		const tags = dialogueTags[emotion] || dialogueTags.neutral;
		return tags[Math.floor(Math.random() * tags.length)];
	}
}