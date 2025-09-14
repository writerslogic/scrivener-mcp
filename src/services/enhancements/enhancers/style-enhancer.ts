import nlp from 'compromise';
import type { StyleGuide } from '../../../memory-manager.js';
import { MLWordClassifierPro } from '../../../analysis/ml-word-classifier-pro.js';
import { splitIntoSentences } from '../../../utils/text-metrics.js';
import type { Change, EnhancementOptions } from '../content-enhancer.js';

export class StyleEnhancer {
	private classifier: MLWordClassifierPro;

	constructor(classifier: MLWordClassifierPro) {
		this.classifier = classifier;
	}

	eliminateFilterWords(content: string, changes: Change[]): string {
		const doc = nlp(content);
		const sentences = doc.sentences().json();
		let result = content;

		for (let i = 0; i < sentences.length; i++) {
			const sentence = sentences[i];
			const words = nlp(sentence.text).json()[0]?.terms || [];

			for (let j = words.length - 1; j >= 0; j--) {
				const word = words[j];
				const wordText = word.text.toLowerCase();

				// Use ML classifier to identify filter words
				const classification = this.classifier.classify(wordText, content, 0);
				if (
					classification.isFilterWord &&
					classification.confidence > 0.7 &&
					this.shouldRemoveFilterWord(
						wordText,
						j > 0 ? words[j - 1].text : '',
						j < words.length - 1 ? words[j + 1].text : ''
					)
				) {
					const before = word.pre || '';
					const after = word.post || '';
					const replacement = before + after;

					changes.push({
						type: 'filter-word-removal',
						original: before + word.text + after,
						replacement: replacement,
						reason: `Removed filter word "${word.text}" for more direct writing`,
						location: { start: word.index || 0, end: (word.index || 0) + word.text.length },
					});

					result = result.replace(before + word.text + after, replacement);
				}
			}
		}

		return result;
	}

	strengthenVerbs(content: string, changes: Change[]): string {
		const doc = nlp(content);
		const sentences = doc.sentences().json();
		let result = content;

		for (const sentence of sentences) {
			const verbs = nlp(sentence.text).verbs().json();

			for (const verb of verbs) {
				if (this.isWeakVerb(verb.text)) {
					const strengthened = this.strengthenVerb(verb.text);
					if (strengthened && strengthened !== verb.text) {
						changes.push({
							type: 'verb-strengthening',
							original: verb.text,
							replacement: strengthened,
							reason: `Replaced weak verb "${verb.text}" with stronger "${strengthened}"`,
							location: { start: verb.index || 0, end: (verb.index || 0) + verb.text.length },
						});

						result = result.replace(verb.text, strengthened);
					}
				}
			}
		}

		return result;
	}

	varySentences(content: string, changes: Change[]): string {
		const sentences = splitIntoSentences(content);
		let result = content;
		const processedSentences: string[] = [];

		for (let i = 0; i < sentences.length; i++) {
			const sentence = sentences[i].trim();
			if (!sentence) {
				processedSentences.push(sentence);
				continue;
			}

			const prevSentence = i > 0 ? sentences[i - 1].trim() : '';
			let modifiedSentence = sentence;

			// Check for similar openings
			if (prevSentence && this.startsSimilarly(sentence, prevSentence)) {
				const varied = this.varyOpening(sentence);
				if (varied !== sentence) {
					changes.push({
						type: 'sentence-variation',
						original: sentence,
						replacement: varied,
						reason: 'Varied sentence opening to avoid repetition',
						location: { start: 0, end: sentence.length },
					});
					modifiedSentence = varied;
				}
			}

			// Check for length variation
			const prevLength = prevSentence.split(/\s+/).length;
			const currentLength = sentence.split(/\s+/).length;

			if (prevLength > 0 && Math.abs(currentLength - prevLength) < 3 && currentLength > 8) {
				const lengthVaried = this.varyLength(modifiedSentence, prevLength);
				if (lengthVaried !== modifiedSentence) {
					changes.push({
						type: 'length-variation',
						original: modifiedSentence,
						replacement: lengthVaried,
						reason: 'Varied sentence length for better rhythm',
						location: { start: 0, end: modifiedSentence.length },
					});
					modifiedSentence = lengthVaried;
				}
			}

			// Add transitions where needed
			if (prevSentence && this.needsTransition(prevSentence, sentence)) {
				const transition = this.selectTransition(prevSentence, sentence);
				if (transition) {
					const withTransition = transition + ' ' + modifiedSentence.toLowerCase();
					changes.push({
						type: 'transition-addition',
						original: modifiedSentence,
						replacement: withTransition,
						reason: `Added transition "${transition}" to improve flow`,
						location: { start: 0, end: modifiedSentence.length },
					});
					modifiedSentence = withTransition;
				}
			}

			processedSentences.push(modifiedSentence);
		}

		return processedSentences.join(' ');
	}

	matchStyle(content: string, changes: Change[], styleGuide?: StyleGuide): string {
		if (!styleGuide) return content;

		let result = content;
		const doc = nlp(content);

		// Apply vocabulary preferences (check if extended style guide has vocabulary)
		const extendedStyleGuide = styleGuide as any;
		if (extendedStyleGuide.vocabulary) {
			for (const [original, replacement] of Object.entries(extendedStyleGuide.vocabulary)) {
				const regex = new RegExp(`\\b${original}\\b`, 'gi');
				if (regex.test(result)) {
					changes.push({
						type: 'style-matching',
						original,
						replacement: String(replacement),
						reason: `Applied style guide preference: "${original}" → "${replacement}"`,
						location: { start: 0, end: original.length },
					});
					result = result.replace(regex, String(replacement));
				}
			}
		}

		return result;
	}

	private shouldRemoveFilterWord(word: string, before: string, after: string): boolean {
		// Don't remove if it's part of a direct quote
		if (before.includes('"') || after.includes('"')) return false;

		// Don't remove if it changes the meaning significantly
		const problematicContext = ['not', 'never', 'hardly', 'barely', 'scarcely'];
		if (problematicContext.some((ctx) => before.toLowerCase().includes(ctx))) return false;

		return true;
	}

	private isWeakVerb(verb: string): boolean {
		const weakVerbs = [
			'is',
			'was',
			'are',
			'were',
			'be',
			'been',
			'being',
			'have',
			'has',
			'had',
			'do',
			'does',
			'did',
			'get',
			'got',
			'make',
			'made',
			'put',
			'take',
			'took',
			'go',
			'went',
			'come',
			'came',
		];
		return weakVerbs.includes(verb.toLowerCase());
	}

	private strengthenVerb(verb: string): string | null {
		const verbMappings: Record<string, string[]> = {
			'is being': ['becomes', 'remains', 'appears'],
			'was being': ['became', 'remained', 'appeared'],
			'get': ['obtain', 'acquire', 'receive', 'fetch'],
			'got': ['obtained', 'acquired', 'received', 'fetched'],
			'make': ['create', 'craft', 'build', 'generate'],
			'made': ['created', 'crafted', 'built', 'generated'],
			'put': ['place', 'position', 'insert', 'set'],
			'take': ['grab', 'seize', 'capture', 'select'],
			'took': ['grabbed', 'seized', 'captured', 'selected'],
			'go': ['travel', 'move', 'proceed', 'advance'],
			'went': ['traveled', 'moved', 'proceeded', 'advanced'],
		};

		const options = verbMappings[verb.toLowerCase()];
		return options ? options[Math.floor(Math.random() * options.length)] : null;
	}

	private startsSimilarly(sentence1: string, sentence2: string): boolean {
		const words1 = sentence1.trim().split(/\s+/);
		const words2 = sentence2.trim().split(/\s+/);

		if (words1.length === 0 || words2.length === 0) return false;

		// Check first word
		if (words1[0].toLowerCase() === words2[0].toLowerCase()) return true;

		// Check first two words for patterns like "The man" vs "The woman"
		if (words1.length >= 2 && words2.length >= 2) {
			if (
				words1[0].toLowerCase() === words2[0].toLowerCase() &&
				words1[1].toLowerCase().length > 3 &&
				words2[1].toLowerCase().length > 3
			) {
				return true;
			}
		}

		return false;
	}

	private varyOpening(sentence: string): string {
		const words = sentence.trim().split(/\s+/);
		if (words.length < 2) return sentence;

		const firstWord = words[0].toLowerCase();
		const variations: Record<string, string[]> = {
			the: ['A', 'That', 'This', 'Every', 'Each'],
			he: ['The man', 'He', 'That person'],
			she: ['The woman', 'She', 'That person'],
			it: ['The thing', 'That', 'This'],
			they: ['Those people', 'The group', 'Everyone'],
		};

		const options = variations[firstWord];
		if (options) {
			const replacement = options[Math.floor(Math.random() * options.length)];
			return replacement + ' ' + words.slice(1).join(' ');
		}

		// Try to move an adverb or prepositional phrase to the beginning
		for (let i = 1; i < words.length; i++) {
			if (words[i].endsWith('ly') || ['in', 'on', 'at', 'by', 'with', 'during'].includes(words[i].toLowerCase())) {
				// Move this word/phrase to beginning
				const moved = words[i];
				const remaining = [...words.slice(0, i), ...words.slice(i + 1)];
				return moved.charAt(0).toUpperCase() + moved.slice(1) + ', ' + remaining.join(' ').toLowerCase();
			}
		}

		return sentence;
	}

	private varyLength(sentence: string, prevLength: number): string {
		const words = sentence.split(/\s+/);
		const currentLength = words.length;

		if (prevLength > 15 && currentLength > 15) {
			// Both long - try to shorten current
			return this.breakLongSentence(sentence);
		} else if (prevLength < 8 && currentLength < 8) {
			// Both short - try to expand current
			return this.expandSentence(sentence);
		}

		return sentence;
	}

	private needsTransition(sentence1: string, sentence2: string): boolean {
		const topicShift = this.detectTopicShift(sentence1, sentence2);
		return topicShift > 0.7; // High topic shift indicates need for transition
	}

	private detectTopicShift(sentence1: string, sentence2: string): number {
		const words1 = new Set(sentence1.toLowerCase().split(/\s+/).filter(w => w.length > 3));
		const words2 = new Set(sentence2.toLowerCase().split(/\s+/).filter(w => w.length > 3));

		const intersection = new Set([...words1].filter(x => words2.has(x)));
		const union = new Set([...words1, ...words2]);

		if (union.size === 0) return 1;

		const similarity = intersection.size / union.size;
		return 1 - similarity; // Higher value = more topic shift
	}

	private selectTransition(sentence1: string, sentence2: string): string {
		const transitionType = this.analyzeTransitionType(sentence1, sentence2);

		const transitions: Record<string, string[]> = {
			contrast: ['However', 'Nevertheless', 'On the other hand', 'In contrast', 'Yet'],
			addition: ['Furthermore', 'Moreover', 'Additionally', 'Also', 'Besides'],
			sequence: ['Then', 'Next', 'Afterward', 'Subsequently', 'Following this'],
			cause: ['Therefore', 'Consequently', 'As a result', 'Thus', 'Hence'],
			example: ['For instance', 'For example', 'Specifically', 'In particular'],
			summary: ['In summary', 'Overall', 'In conclusion', 'To summarize'],
		};

		const options = transitions[transitionType] || transitions.sequence;
		return options[Math.floor(Math.random() * options.length)];
	}

	private analyzeTransitionType(sentence1: string, sentence2: string): string {
		const s1Lower = sentence1.toLowerCase();
		const s2Lower = sentence2.toLowerCase();

		// Check for contrast indicators
		const contrastWords = ['but', 'however', 'although', 'despite', 'while', 'whereas'];
		if (contrastWords.some(word => s2Lower.includes(word))) return 'contrast';

		// Check for causation
		const causeWords = ['because', 'since', 'due to', 'as a result', 'therefore'];
		if (causeWords.some(word => s2Lower.includes(word))) return 'cause';

		// Check for examples
		if (s2Lower.includes('example') || s2Lower.includes('instance')) return 'example';

		// Default to sequence
		return 'sequence';
	}

	private breakLongSentence(sentence: string): string {
		// Find natural break points (conjunctions, semicolons, etc.)
		const breakPoints = [' and ', ' but ', ' or ', ' so ', '; ', ', which ', ', that '];
		
		for (const breakPoint of breakPoints) {
			const index = sentence.indexOf(breakPoint);
			if (index > 10 && index < sentence.length - 10) {
				const part1 = sentence.substring(0, index).trim();
				const part2 = sentence.substring(index + breakPoint.length).trim();
				
				if (part2) {
					return part1 + '. ' + part2.charAt(0).toUpperCase() + part2.slice(1);
				}
			}
		}
		
		return sentence;
	}

	private expandSentence(sentence: string): string {
		// Add descriptive elements to short sentences
		const words = sentence.split(/\s+/);
		
		// Find verbs and add adverbs
		for (let i = 0; i < words.length; i++) {
			const word = words[i].toLowerCase();
			if (this.isActionVerb(word)) {
				const adverb = this.selectAdverb(word);
				if (adverb) {
					words.splice(i + 1, 0, adverb);
					break;
				}
			}
		}
		
		return words.join(' ');
	}

	private isActionVerb(word: string): boolean {
		const actionVerbs = ['ran', 'walked', 'jumped', 'moved', 'spoke', 'looked', 'turned', 'went'];
		return actionVerbs.includes(word);
	}

	private selectAdverb(verb: string): string | null {
		const adverbMappings: Record<string, string[]> = {
			'ran': ['quickly', 'swiftly', 'desperately'],
			'walked': ['slowly', 'carefully', 'purposefully'],
			'jumped': ['suddenly', 'gracefully', 'frantically'],
			'spoke': ['softly', 'firmly', 'hesitantly'],
			'looked': ['intently', 'briefly', 'suspiciously'],
		};

		const options = adverbMappings[verb];
		return options ? options[Math.floor(Math.random() * options.length)] : null;
	}
}