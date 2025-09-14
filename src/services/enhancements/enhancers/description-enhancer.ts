import nlp from 'compromise';
import { MLWordClassifierPro } from '../../../analysis/ml-word-classifier-pro.js';
import { splitIntoSentences } from '../../../utils/text-metrics.js';
import type { Change } from '../content-enhancer.js';

export class DescriptionEnhancer {
	private classifier: MLWordClassifierPro;

	constructor(classifier: MLWordClassifierPro) {
		this.classifier = classifier;
	}

	enhanceDescriptions(content: string, changes: Change[]): string {
		const sentences = splitIntoSentences(content);
		const processedSentences: string[] = [];

		for (const sentence of sentences) {
			if (!sentence.trim()) {
				processedSentences.push(sentence);
				continue;
			}

			let enhanced = sentence;
			const doc = nlp(sentence);
			const nouns = doc.nouns().json();

			// Enhance nouns with contextual adjectives
			for (const noun of nouns) {
				if (this.shouldEnhanceNoun(noun.text)) {
					const adjective = this.generateContextualAdjective(noun.text, sentence);
					if (adjective && !sentence.toLowerCase().includes(adjective.toLowerCase())) {
						const enhanced_noun = `${adjective} ${noun.text}`;
						changes.push({
							type: 'description-enhancement',
							original: noun.text,
							replacement: enhanced_noun,
							reason: `Added descriptive adjective "${adjective}" to enhance "${noun.text}"`,
							location: { start: 0, end: noun.text.length },
						});
						enhanced = enhanced.replace(new RegExp(`\\b${noun.text}\\b`, 'i'), enhanced_noun);
					}
				}
			}

			processedSentences.push(enhanced);
		}

		return processedSentences.join(' ');
	}

	addSensoryDetails(content: string, changes: Change[]): string {
		const sentences = splitIntoSentences(content);
		const processedSentences: string[] = [];

		for (const sentence of sentences) {
			if (!sentence.trim()) {
				processedSentences.push(sentence);
				continue;
			}

			let enhanced = sentence;

			// Check if sentence lacks sensory detail
			if (this.lacksSensoryDetail(sentence)) {
				const sensoryEnhancement = this.enrichWithSensory(sentence);
				if (sensoryEnhancement !== sentence) {
					changes.push({
						type: 'sensory-enhancement',
						original: sentence,
						replacement: sensoryEnhancement,
						reason: 'Added sensory details to immerse the reader',
						location: { start: 0, end: sentence.length },
					});
					enhanced = sensoryEnhancement;
				}
			}

			processedSentences.push(enhanced);
		}

		return processedSentences.join(' ');
	}

	expandContent(
		content: string,
		changes: Change[],
		targetLength?: number
	): string {
		const sentences = splitIntoSentences(content);
		const originalWordCount = content.split(/\s+/).length;
		const target = targetLength || Math.floor(originalWordCount * 1.3);

		let result = content;
		let currentWordCount = originalWordCount;

		// Add descriptive details
		if (currentWordCount < target) {
			result = this.enhanceDescriptions(result, changes);
			currentWordCount = result.split(/\s+/).length;
		}

		// Add sensory details
		if (currentWordCount < target) {
			result = this.addSensoryDetails(result, changes);
			currentWordCount = result.split(/\s+/).length;
		}

		// Expand with action details
		if (currentWordCount < target) {
			result = this.expandWithActionDetails(result, changes);
		}

		return result;
	}

	private shouldEnhanceNoun(noun: string): boolean {
		const genericNouns = ['thing', 'stuff', 'place', 'person', 'object', 'item'];
		const score = this.calculateGenericScore(noun);
		return genericNouns.includes(noun.toLowerCase()) || score > 0.7;
	}

	private calculateGenericScore(noun: string): number {
		const genericTerms = ['thing', 'stuff', 'item', 'object', 'place', 'area', 'spot', 'location'];
		let score = 0;

		// Check for exact matches
		if (genericTerms.includes(noun.toLowerCase())) {
			score += 0.8;
		}

		// Check for generic endings
		if (noun.length <= 4) {
			score += 0.3; // Short nouns tend to be generic
		}

		// Check for vague descriptors
		const vaguePatterns = /^(some|any|this|that|the)\s/i;
		if (vaguePatterns.test(noun)) {
			score += 0.4;
		}

		return Math.min(score, 1.0);
	}

	private generateContextualAdjective(noun: string, context: string): string {
		const nounCategory = this.categorizeNoun(noun);
		const contextAnalysis = this.analyzeContext(context);

		const adjectiveMap: Record<string, Record<string, string[]>> = {
			person: {
				positive: ['kind', 'gentle', 'wise', 'cheerful', 'confident'],
				negative: ['stern', 'worried', 'tired', 'anxious', 'frustrated'],
				neutral: ['tall', 'young', 'elderly', 'slender', 'robust']
			},
			place: {
				positive: ['beautiful', 'peaceful', 'bright', 'spacious', 'welcoming'],
				negative: ['gloomy', 'cramped', 'abandoned', 'deteriorating', 'shadowy'],
				neutral: ['large', 'small', 'distant', 'nearby', 'familiar']
			},
			object: {
				positive: ['pristine', 'elegant', 'valuable', 'useful', 'beautiful'],
				negative: ['broken', 'worn', 'rusty', 'damaged', 'neglected'],
				neutral: ['heavy', 'light', 'round', 'square', 'metallic']
			},
			default: {
				positive: ['remarkable', 'impressive', 'wonderful', 'excellent', 'outstanding'],
				negative: ['troublesome', 'difficult', 'problematic', 'concerning', 'unfortunate'],
				neutral: ['typical', 'ordinary', 'common', 'regular', 'standard']
			}
		};

		const categoryAdjectives = adjectiveMap[nounCategory] || adjectiveMap.default;
		const moodAdjectives = categoryAdjectives[contextAnalysis.mood] || categoryAdjectives.neutral;

		return moodAdjectives[Math.floor(Math.random() * moodAdjectives.length)];
	}

	private categorizeNoun(noun: string): string {
		const categories: Record<string, string[]> = {
			person: ['man', 'woman', 'person', 'child', 'boy', 'girl', 'friend', 'stranger', 'neighbor'],
			place: ['house', 'room', 'building', 'street', 'park', 'store', 'office', 'kitchen', 'garden'],
			object: ['car', 'book', 'table', 'chair', 'phone', 'computer', 'door', 'window', 'box'],
			nature: ['tree', 'flower', 'mountain', 'river', 'sky', 'cloud', 'grass', 'stone', 'leaf']
		};

		for (const [category, words] of Object.entries(categories)) {
			if (words.includes(noun.toLowerCase())) {
				return category;
			}
		}
		return 'default';
	}

	private analyzeContext(sentence: string): { mood: string; sceneType: string } {
		const positiveWords = ['happy', 'bright', 'beautiful', 'wonderful', 'peaceful', 'joyful'];
		const negativeWords = ['dark', 'sad', 'angry', 'frightened', 'worried', 'gloomy', 'terrible'];

		const lowerSentence = sentence.toLowerCase();
		const hasPositive = positiveWords.some(word => lowerSentence.includes(word));
		const hasNegative = negativeWords.some(word => lowerSentence.includes(word));

		let mood = 'neutral';
		if (hasPositive && !hasNegative) mood = 'positive';
		else if (hasNegative && !hasPositive) mood = 'negative';

		const sceneType = this.detectSceneType(sentence);

		return { mood, sceneType };
	}

	private detectSceneType(sentence: string): string {
		const actionWords = ['ran', 'jumped', 'fought', 'crashed', 'rushed', 'grabbed'];
		const dialogueIndicators = ['"', "'", 'said', 'asked', 'replied', 'whispered'];
		const descriptionWords = ['looked', 'appeared', 'seemed', 'was', 'stood'];

		const lowerSentence = sentence.toLowerCase();

		if (actionWords.some(word => lowerSentence.includes(word))) return 'action';
		if (dialogueIndicators.some(indicator => sentence.includes(indicator))) return 'dialogue';
		if (descriptionWords.some(word => lowerSentence.includes(word))) return 'description';

		return 'narrative';
	}

	private enrichWithSensory(sentence: string): string {
		const context = this.analyzeContext(sentence);
		const sensoryEnhancement = this.generateSensoryEnhancement(context.sceneType, context);

		if (sensoryEnhancement) {
			const insertionPoint = this.findBestInsertionPoint(sentence);
			const before = sentence.substring(0, insertionPoint);
			const after = sentence.substring(insertionPoint);
			return before + sensoryEnhancement + after;
		}

		return sentence;
	}

	private generateSensoryEnhancement(sceneType: string, context: { mood: string }): string {
		const sensoryDetails: Record<string, Record<string, string[]>> = {
			action: {
				positive: [', his heart racing with excitement,', ', the wind rushing through his hair,'],
				negative: [', his muscles aching with effort,', ', sweat stinging his eyes,'],
				neutral: [', his footsteps echoing,', ', the sound of movement filling the air,']
			},
			dialogue: {
				positive: [', her voice warm and melodic,', ', speaking in gentle tones,'],
				negative: [', his voice tight with tension,', ', words spoken through gritted teeth,'],
				neutral: [', her voice cutting through the silence,', ', speaking in measured tones,']
			},
			description: {
				positive: [', bathed in golden sunlight,', ', the air fresh and clean,'],
				negative: [', shrouded in shadow,', ', the air thick and oppressive,'],
				neutral: [', lit by dim light,', ', the air still and quiet,']
			}
		};

		const sceneDetails = sensoryDetails[sceneType] || sensoryDetails.description;
		const moodDetails = sceneDetails[context.mood] || sceneDetails.neutral;

		return moodDetails[Math.floor(Math.random() * moodDetails.length)];
	}

	private findBestInsertionPoint(sentence: string): number {
		// Find a natural break point in the sentence for sensory insertion
		const breakPatterns = [',', ' and ', ' but ', ' while '];

		for (const pattern of breakPatterns) {
			const index = sentence.indexOf(pattern);
			if (index > 10 && index < sentence.length - 10) {
				return index + pattern.length;
			}
		}

		// If no natural break, insert before the last clause
		const lastComma = sentence.lastIndexOf(',');
		if (lastComma > sentence.length / 2) {
			return lastComma;
		}

		// Default to middle of sentence
		return Math.floor(sentence.length / 2);
	}

	private lacksSensoryDetail(sentence: string): boolean {
		const sensoryScore = this.calculateSensoryScore(sentence);
		return sensoryScore < 0.3;
	}

	private calculateSensoryScore(sentence: string): number {
		const sensoryWords = [
			// Sight
			'bright', 'dark', 'colorful', 'shimmering', 'glowing', 'shadowy',
			// Sound
			'loud', 'quiet', 'echoing', 'whispered', 'roaring', 'crackling',
			// Smell
			'fragrant', 'pungent', 'sweet', 'acrid', 'fresh', 'musty',
			// Touch
			'rough', 'smooth', 'cold', 'warm', 'soft', 'hard', 'wet', 'dry',
			// Taste
			'sweet', 'bitter', 'sour', 'salty', 'spicy'
		];

		const words = sentence.toLowerCase().split(/\s+/);
		const sensoryCount = words.filter(word => 
			sensoryWords.some(sensory => word.includes(sensory))
		).length;

		return sensoryCount / words.length;
	}

	private expandWithActionDetails(content: string, changes: Change[]): string {
		const sentences = splitIntoSentences(content);
		const processedSentences: string[] = [];

		for (const sentence of sentences) {
			if (!sentence.trim()) {
				processedSentences.push(sentence);
				continue;
			}

			let expanded = sentence;

			// Look for action verbs and expand them
			const actionExpansion = this.generateActionExpansion(sentence);
			if (actionExpansion !== sentence) {
				changes.push({
					type: 'action-expansion',
					original: sentence,
					replacement: actionExpansion,
					reason: 'Expanded action for more vivid description',
					location: { start: 0, end: sentence.length },
				});
				expanded = actionExpansion;
			}

			processedSentences.push(expanded);
		}

		return processedSentences.join(' ');
	}

	private generateActionExpansion(sentence: string): string {
		const actionVerbs = ['walked', 'ran', 'looked', 'turned', 'opened', 'closed'];
		const expansions: Record<string, string[]> = {
			walked: ['strolled leisurely', 'hurried quickly', 'wandered aimlessly'],
			ran: ['sprinted desperately', 'jogged steadily', 'dashed frantically'],
			looked: ['gazed intently', 'glanced nervously', 'stared in wonder'],
			turned: ['spun around quickly', 'rotated slowly', 'pivoted gracefully'],
			opened: ['carefully unlocked', 'gently pushed open', 'forcefully threw open'],
			closed: ['firmly shut', 'gently pulled closed', 'slammed shut']
		};

		let result = sentence;
		for (const [verb, alternatives] of Object.entries(expansions)) {
			if (sentence.toLowerCase().includes(verb)) {
				const expansion = alternatives[Math.floor(Math.random() * alternatives.length)];
				result = result.replace(new RegExp(`\\b${verb}\\b`, 'i'), expansion);
				break;
			}
		}

		return result;
	}
}