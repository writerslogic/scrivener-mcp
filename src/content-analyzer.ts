// import type { ScrivenerDocument } from './scrivener-project.js';
import { classifier as wordClassifier } from './ml-word-classifier-pro.js';
import { openaiService } from './openai-service.js';
import type {
	StyleAnalysis as OpenAIStyleAnalysis,
	CharacterAnalysis as OpenAICharacterAnalysis,
	PlotAnalysis as OpenAIPlotAnalysis,
} from './openai-service.js';
import { webContentParser } from './web-content-parser.js';
import { advancedReadabilityService } from './advanced-readability.js';
import type {
	ReadabilityMetrics,
	ReadabilityComparison,
	ReadabilityTrends,
	WritingSuggestion,
	ParsedWebContent,
	ResearchData,
	ContentExtractionOptions,
} from './types/analysis.js';

export interface ContentAnalysis {
	documentId: string;
	timestamp: string;
	metrics: WritingMetrics;
	style: StyleAnalysis;
	structure: StructureAnalysis;
	quality: QualityIndicators;
	suggestions: Suggestion[];
	emotions: EmotionalAnalysis;
	pacing: PacingAnalysis;
}

export interface WritingMetrics {
	wordCount: number;
	sentenceCount: number;
	paragraphCount: number;
	averageSentenceLength: number;
	averageParagraphLength: number;
	readingTime: number; // in minutes
	fleschReadingEase: number;
	fleschKincaidGrade: number;
}

export interface StyleAnalysis {
	sentenceVariety: 'low' | 'medium' | 'high';
	vocabularyComplexity: 'simple' | 'moderate' | 'complex' | 'advanced';
	adverbUsage: 'minimal' | 'moderate' | 'heavy';
	passiveVoicePercentage: number;
	dialoguePercentage: number;
	descriptionPercentage: number;
	mostFrequentWords: { word: string; count: number }[];
	styleConsistency: number; // 0-100
}

export interface StructureAnalysis {
	sceneBreaks: number;
	chapters: number;
	averageSceneLength: number;
	openingStrength: 'weak' | 'moderate' | 'strong';
	endingStrength: 'weak' | 'moderate' | 'strong';
	hookPresence: boolean;
	cliffhangers: number;
}

export interface QualityIndicators {
	repetitiveness: number; // 0-100, lower is better
	cliches: string[];
	filterWords: string[];
	tellingVsShowing: number; // ratio
	sensoryDetails: 'lacking' | 'adequate' | 'rich';
	whiteSpace: 'cramped' | 'balanced' | 'excessive';
}

export interface Suggestion {
	type: 'style' | 'structure' | 'grammar' | 'clarity' | 'impact';
	severity: 'minor' | 'moderate' | 'major';
	location?: { paragraph: number; sentence?: number };
	issue: string;
	suggestion: string;
	example?: string;
}

export interface EmotionalAnalysis {
	dominantEmotion: string;
	emotionalArc: { position: number; emotion: string; intensity: number }[];
	tensionLevel: number; // 0-100
	moodConsistency: number; // 0-100
}

export interface PacingAnalysis {
	overall: 'slow' | 'moderate' | 'fast' | 'variable';
	sections: { start: number; end: number; pace: 'slow' | 'moderate' | 'fast' }[];
	actionVsReflection: number; // ratio
	recommendedAdjustments: string[];
}

export class ContentAnalyzer {
	// ML classifier replaces hardcoded word lists
	private classifier = wordClassifier;

	// Keep only for backward compatibility reference
	private commonWords = new Set([
		'the',
		'a',
		'an',
		'and',
		'or',
		'but',
		'in',
		'on',
		'at',
		'to',
		'for',
		'of',
		'with',
		'as',
		'by',
		'that',
		'this',
		'it',
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
		'will',
		'would',
		'could',
		'should',
	]);

	// Filter words are now detected dynamically by ML classifier
	// Remove unused hardcoded list

	private clichePhrases = [
		'dark and stormy night',
		'in the nick of time',
		'avoid like the plague',
		'dead as a doornail',
		'fit as a fiddle',
		'time will tell',
		'only time will tell',
		'lost track of time',
		'all walks of life',
		'calm before the storm',
		'cry over spilled milk',
		'every cloud has a silver lining',
	];

	async analyzeContent(content: string, documentId: string): Promise<ContentAnalysis> {
		const metrics = this.calculateMetrics(content);
		const style = this.analyzeStyle(content);
		const structure = this.analyzeStructure(content);
		const quality = this.assessQuality(content);
		const suggestions = this.generateSuggestions(content, metrics, style, quality);
		const emotions = this.analyzeEmotions(content);
		const pacing = this.analyzePacing(content);

		return {
			documentId,
			timestamp: new Date().toISOString(),
			metrics,
			style,
			structure,
			quality,
			suggestions,
			emotions,
			pacing,
		};
	}

	private calculateMetrics(content: string): WritingMetrics {
		const words = content.split(/\s+/).filter((w) => w.length > 0);
		const sentences = content.split(/[.!?]+/).filter((s) => s.trim().length > 0);
		const paragraphs = content.split(/\n\n+/).filter((p) => p.trim().length > 0);

		const wordCount = words.length;
		const sentenceCount = sentences.length;
		const paragraphCount = paragraphs.length;
		const averageSentenceLength = sentenceCount > 0 ? wordCount / sentenceCount : 0;
		const averageParagraphLength = paragraphCount > 0 ? wordCount / paragraphCount : 0;
		const readingTime = Math.ceil(wordCount / 250); // Average reading speed

		// Calculate readability scores
		const { fleschReadingEase, fleschKincaidGrade } = this.calculateReadability(
			wordCount,
			sentenceCount,
			this.countSyllables(words)
		);

		return {
			wordCount,
			sentenceCount,
			paragraphCount,
			averageSentenceLength,
			averageParagraphLength,
			readingTime,
			fleschReadingEase,
			fleschKincaidGrade,
		};
	}

	private analyzeStyle(content: string): StyleAnalysis {
		const sentences = content.split(/[.!?]+/).filter((s) => s.trim().length > 0);
		const words = content
			.toLowerCase()
			.split(/\s+/)
			.filter((w) => w.length > 0);

		// Sentence variety
		const sentenceLengths = sentences.map((s) => s.split(/\s+/).length);
		const lengthVariance = this.calculateVariance(sentenceLengths);
		const sentenceVariety =
			lengthVariance > 50 ? 'high' : lengthVariance > 20 ? 'medium' : 'low';

		// Vocabulary complexity
		// const uniqueWords = new Set(words);
		const complexWords = words.filter((w) => this.countSyllables([w]) > 2).length;
		const vocabularyComplexity =
			complexWords / words.length > 0.3
				? 'advanced'
				: complexWords / words.length > 0.2
					? 'complex'
					: complexWords / words.length > 0.1
						? 'moderate'
						: 'simple';

		// Adverb usage
		const adverbs = words.filter((w) => w.endsWith('ly')).length;
		const adverbUsage =
			adverbs / words.length > 0.05
				? 'heavy'
				: adverbs / words.length > 0.02
					? 'moderate'
					: 'minimal';

		// Passive voice - detect using pattern-based auxiliary verb detection
		const passiveCount = words.filter((w) => this.isPassiveIndicator(w)).length;
		const passiveVoicePercentage = (passiveCount / sentences.length) * 100;

		// Dialogue vs description
		const dialogueLines = content
			.split('\n')
			.filter((line) => line.includes('"') || line.includes("'"));
		const dialoguePercentage = (dialogueLines.length / content.split('\n').length) * 100;
		const descriptionPercentage = 100 - dialoguePercentage;

		// Most frequent words (excluding common words)
		const wordFrequency = new Map<string, number>();
		words.forEach((word) => {
			if (!this.commonWords.has(word) && word.length > 3) {
				wordFrequency.set(word, (wordFrequency.get(word) || 0) + 1);
			}
		});
		const mostFrequentWords = Array.from(wordFrequency.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 10)
			.map(([word, count]) => ({ word, count }));

		return {
			sentenceVariety,
			vocabularyComplexity,
			adverbUsage,
			passiveVoicePercentage,
			dialoguePercentage,
			descriptionPercentage,
			mostFrequentWords,
			styleConsistency: 85, // Simplified for now
		};
	}

	private analyzeStructure(content: string): StructureAnalysis {
		const lines = content.split('\n');
		const paragraphs = content.split(/\n\n+/);

		// Scene breaks (looking for common indicators)
		const sceneBreaks = lines.filter(
			(line) => line.trim() === '***' || line.trim() === '* * *' || line.trim() === '#'
		).length;

		// Chapters (looking for chapter headings)
		const chapters = lines.filter((line) =>
			/^(Chapter|CHAPTER|Ch\.|Part|PART)\s+\d+/i.test(line.trim())
		).length;

		const averageSceneLength =
			sceneBreaks > 0 ? content.length / (sceneBreaks + 1) : content.length;

		// Opening and ending analysis
		const firstParagraph = paragraphs[0] || '';
		const lastParagraph = paragraphs[paragraphs.length - 1] || '';

		const openingStrength = this.assessOpeningStrength(firstParagraph);
		const endingStrength = this.assessEndingStrength(lastParagraph);

		const hookPresence = this.detectHook(firstParagraph);
		const cliffhangers = this.countCliffhangers(paragraphs);

		return {
			sceneBreaks,
			chapters,
			averageSceneLength,
			openingStrength,
			endingStrength,
			hookPresence,
			cliffhangers,
		};
	}

	private assessQuality(content: string): QualityIndicators {
		const words = content.toLowerCase().split(/\s+/);
		const sentences = content.split(/[.!?]+/).filter((s) => s.trim().length > 0);

		// Repetitiveness
		const wordPairs = new Map<string, number>();
		for (let i = 0; i < words.length - 1; i++) {
			const pair = `${words[i]} ${words[i + 1]}`;
			wordPairs.set(pair, (wordPairs.get(pair) || 0) + 1);
		}
		const repetitivePairs = Array.from(wordPairs.values()).filter((count) => count > 2).length;
		const repetitiveness = Math.min((repetitivePairs / wordPairs.size) * 100, 100);

		// Cliches
		const foundClichés = this.clichePhrases.filter((cliché) =>
			content.toLowerCase().includes(cliché)
		);

		// Filter words - use ML classifier instead of hardcoded list
		const foundFilterWords: string[] = [];
		const processedWords = new Set<string>();

		for (let i = 0; i < words.length; i++) {
			const word = words[i];
			if (!processedWords.has(word)) {
				// Find the word's position in the original content
				const wordIndex = content
					.toLowerCase()
					.indexOf(word, i > 0 ? content.toLowerCase().indexOf(words[i - 1]) : 0);
				const classification = this.classifier.classify(word, content, wordIndex);

				if (classification.isFilterWord && classification.confidence > 0.5) {
					foundFilterWords.push(word);
					processedWords.add(word);
				}
			}
		}

		// Telling vs showing (pattern-based cognitive verb detection)
		const tellingCount = words.filter((w) => this.isCognitiveVerb(w)).length;
		const actionWords = words.filter((w) => w.endsWith('ed') || w.endsWith('ing')).length;
		const tellingVsShowing = tellingCount / Math.max(actionWords, 1);

		// Sensory details
		const sensoryWords = [
			'saw',
			'heard',
			'smelled',
			'tasted',
			'touched',
			'felt',
			'bright',
			'dark',
			'loud',
			'quiet',
			'soft',
			'hard',
			'sweet',
			'bitter',
		];
		const sensoryCount = words.filter((w) => sensoryWords.some((s) => w.includes(s))).length;
		const sensoryDetails =
			sensoryCount / sentences.length > 1
				? 'rich'
				: sensoryCount / sentences.length > 0.5
					? 'adequate'
					: 'lacking';

		// White space
		const paragraphs = content.split(/\n\n+/);
		const avgParagraphLength = content.length / paragraphs.length;
		const whiteSpace =
			avgParagraphLength < 200
				? 'balanced'
				: avgParagraphLength < 500
					? 'balanced'
					: avgParagraphLength < 1000
						? 'cramped'
						: 'cramped';

		return {
			repetitiveness,
			cliches: foundClichés,
			filterWords: foundFilterWords,
			tellingVsShowing,
			sensoryDetails,
			whiteSpace,
		};
	}

	private generateSuggestions(
		_content: string,
		metrics: WritingMetrics,
		style: StyleAnalysis,
		quality: QualityIndicators
	): Suggestion[] {
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
		const sentences = _content.split(/[.!?]+/).filter((s: string) => s.trim());
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

	private analyzeEmotions(content: string): EmotionalAnalysis {
		// Pattern-based emotion detection using semantic field analysis

		const words = content.toLowerCase().split(/\s+/);
		const emotionCounts = new Map<string, number>();

		const emotionAnalysis = this.analyzeEmotionPatterns(words);
		for (const [emotion, count] of Object.entries(emotionAnalysis)) {
			if (count > 0) emotionCounts.set(emotion, count);
		}

		const dominantEmotion =
			Array.from(emotionCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || 'neutral';

		// Simplified emotional arc
		const segments = this.splitIntoSegments(content, 5);
		const emotionalArc = segments.map((segment, index) => {
			const segmentEmotions = this.detectSegmentEmotion(segment);
			return {
				position: (index + 1) / segments.length,
				emotion: segmentEmotions.emotion,
				intensity: segmentEmotions.intensity,
			};
		});

		// Tension level using semantic pattern detection
		const tensionCount = words.filter((w) => this.isConflictWord(w)).length;
		const sentenceCount = content.split(/[.!?]+/).filter((s) => s.trim().length > 0).length;
		const tensionLevel = Math.min((tensionCount / sentenceCount) * 100, 100);

		return {
			dominantEmotion,
			emotionalArc,
			tensionLevel,
			moodConsistency: 75, // Simplified
		};
	}

	private analyzePacing(content: string): PacingAnalysis {
		// const paragraphs = content.split(/\n\n+/);
		const sentences = content.split(/[.!?]+/);

		// Analyze sentence lengths for pacing
		const sentenceLengths = sentences.map((s) => s.split(/\s+/).length);
		const avgLength = sentenceLengths.reduce((a, b) => a + b, 0) / sentenceLengths.length;

		// Determine overall pacing
		const overall =
			avgLength < 10
				? 'fast'
				: avgLength < 15
					? 'moderate'
					: avgLength < 20
						? 'moderate'
						: 'slow';

		// Analyze sections
		const sections = this.splitIntoSegments(content, 3).map((segment, index) => {
			const segmentSentences = segment.split(/[.!?]+/);
			const segmentAvg =
				segmentSentences.map((s) => s.split(/\s+/).length).reduce((a, b) => a + b, 0) /
				segmentSentences.length;

			return {
				start: index * (100 / 3),
				end: (index + 1) * (100 / 3),
				pace:
					segmentAvg < 10
						? ('fast' as const)
						: segmentAvg < 20
							? ('moderate' as const)
							: ('slow' as const),
			};
		});

		// Action vs reflection using morphological pattern analysis

		const words = content.toLowerCase().split(/\s+/);
		const actionCount = words.filter((w) => this.isActionWord(w)).length;
		const reflectionCount = words.filter((w) => this.isReflectionWord(w)).length;
		const actionVsReflection = actionCount / Math.max(reflectionCount, 1);

		// Recommendations
		const recommendedAdjustments: string[] = [];
		if (overall === 'slow') {
			recommendedAdjustments.push(
				'Consider shortening sentences and paragraphs to increase pace'
			);
		}
		if (actionVsReflection < 0.5) {
			recommendedAdjustments.push('Add more action sequences to balance reflection');
		}
		if (sections.every((s) => s.pace === sections[0].pace)) {
			recommendedAdjustments.push('Vary pacing between sections for better rhythm');
		}

		return {
			overall: overall as 'slow' | 'moderate' | 'fast' | 'variable',
			sections,
			actionVsReflection,
			recommendedAdjustments,
		};
	}

	// Helper methods
	private countSyllables(words: string[]): number {
		return words.reduce((count, word) => {
			word = word.toLowerCase().replace(/[^a-z]/g, '');
			let syllables = 0;
			let previousWasVowel = false;

			for (let i = 0; i < word.length; i++) {
				const isVowel = /[aeiou]/.test(word[i]);
				if (isVowel && !previousWasVowel) syllables++;
				previousWasVowel = isVowel;
			}

			// Adjustments
			if (word.endsWith('e')) syllables--;
			if (word.endsWith('le') && word.length > 2) syllables++;
			if (syllables === 0) syllables = 1;

			return count + syllables;
		}, 0);
	}

	private calculateReadability(words: number, sentences: number, syllables: number) {
		// Handle edge cases
		if (words === 0 || sentences === 0) {
			return {
				fleschReadingEase: 0,
				fleschKincaidGrade: 0,
			};
		}

		const avgSyllablesPerWord = syllables / words;
		const avgWordsPerSentence = words / sentences;

		const fleschReadingEase =
			206.835 - 1.015 * avgWordsPerSentence - 84.6 * avgSyllablesPerWord;
		const fleschKincaidGrade = 0.39 * avgWordsPerSentence + 11.8 * avgSyllablesPerWord - 15.59;

		return {
			fleschReadingEase: Math.max(0, Math.min(100, fleschReadingEase)),
			fleschKincaidGrade: Math.max(0, fleschKincaidGrade),
		};
	}

	private calculateVariance(numbers: number[]): number {
		const mean = numbers.reduce((a, b) => a + b, 0) / numbers.length;
		const squaredDifferences = numbers.map((n) => Math.pow(n - mean, 2));
		return squaredDifferences.reduce((a, b) => a + b, 0) / numbers.length;
	}

	private assessOpeningStrength(paragraph: string): 'weak' | 'moderate' | 'strong' {
		if (!paragraph) return 'weak';

		const hasHook = this.detectHook(paragraph);
		const hasAction = /\b(ran|jumped|crashed|exploded|screamed)\b/i.test(paragraph);
		const hasDialogue = paragraph.includes('"') || paragraph.includes("'");
		const isShort = paragraph.length < 200;

		const strength = [hasHook, hasAction, hasDialogue, isShort].filter(Boolean).length;

		return strength >= 3 ? 'strong' : strength >= 2 ? 'moderate' : 'weak';
	}

	private assessEndingStrength(paragraph: string): 'weak' | 'moderate' | 'strong' {
		if (!paragraph) return 'weak';

		const hasResolution = /\b(finally|resolved|ended|complete|finished)\b/i.test(paragraph);
		const hasCliffhanger =
			paragraph.endsWith('?') || /\b(but|however|suddenly)\b/i.test(paragraph.slice(-50));
		const hasImpact = paragraph.length < 150;

		const strength = [hasResolution || hasCliffhanger, hasImpact].filter(Boolean).length;

		return strength === 2 ? 'strong' : strength === 1 ? 'moderate' : 'weak';
	}

	private detectHook(text: string): boolean {
		const hookPatterns = [
			/^"[^"]+"/, // Opens with dialogue
			/^\w+\s+(ran|jumped|crashed|fell|screamed)/i, // Opens with action
			/^(The|A)\s+\w+\s+was\s+dead/i, // Opens with shocking statement
			/\?$/, // Opens with question
		];

		return hookPatterns.some((pattern) => pattern.test(text.slice(0, 100)));
	}

	private countCliffhangers(paragraphs: string[]): number {
		return paragraphs.filter((p) => {
			if (!p.trim()) return false;

			// Check if paragraph ends with a question
			if (p.trim().endsWith('?')) return true;

			// Check for cliffhanger keywords at the end
			const lastSentence = p.split(/[.!?]/).pop()?.trim() || '';
			return /\b(but|however|suddenly|then)\b/i.test(lastSentence);
		}).length;
	}

	private splitIntoSegments(content: string, count: number): string[] {
		const segmentLength = Math.ceil(content.length / count);
		const segments: string[] = [];

		for (let i = 0; i < count; i++) {
			segments.push(content.slice(i * segmentLength, (i + 1) * segmentLength));
		}

		return segments;
	}

	private detectSegmentEmotion(segment: string) {
		const words = segment.toLowerCase().split(/\s+/);
		let maxEmotion = 'neutral';
		let maxCount = 0;

		const emotionAnalysis = this.analyzeEmotionPatterns(words);
		for (const [emotion, count] of Object.entries(emotionAnalysis)) {
			if (count > maxCount) {
				maxCount = count;
				maxEmotion = emotion;
			}
		}

		return {
			emotion: maxEmotion,
			intensity: Math.min((maxCount / words.length) * 100, 100),
		};
	}

	// Pattern-based helper methods to replace hardcoded word lists
	private isPassiveIndicator(word: string): boolean {
		const auxiliaryVerbs = ['was', 'were', 'been', 'being', 'be', 'is', 'are', 'am'];
		return auxiliaryVerbs.includes(word.toLowerCase());
	}

	private isCognitiveVerb(word: string): boolean {
		// Pattern-based detection of cognitive/mental state verbs
		const cognitivePatterns = [
			'felt',
			'thought',
			'knew',
			'realized',
			'understood',
			'believed',
			'remembered',
			'considered',
			'pondered',
			'reflected',
		];
		return (
			cognitivePatterns.includes(word.toLowerCase()) ||
			word.endsWith('ized') ||
			word.endsWith('ought') ||
			word.includes('think')
		);
	}

	private isConflictWord(word: string): boolean {
		// Pattern-based conflict/tension detection
		if (word.includes('fight') || word.includes('battle') || word.includes('conflict'))
			return true;
		if (word.includes('struggle') || word.includes('tension') || word.includes('pressure'))
			return true;
		if (word.includes('clash') || word.includes('dispute') || word.includes('argument'))
			return true;
		return false;
	}

	private analyzeEmotionPatterns(words: string[]): Record<string, number> {
		const emotionCounts: Record<string, number> = {
			joy: 0,
			sadness: 0,
			anger: 0,
			fear: 0,
			surprise: 0,
			disgust: 0,
		};

		for (const word of words) {
			const lowerWord = word.toLowerCase();

			// Pattern-based emotion detection using morphological analysis
			if (this.isJoyWord(lowerWord)) emotionCounts.joy++;
			else if (this.isSadnessWord(lowerWord)) emotionCounts.sadness++;
			else if (this.isAngerWord(lowerWord)) emotionCounts.anger++;
			else if (this.isFearWord(lowerWord)) emotionCounts.fear++;
			else if (this.isSurpriseWord(lowerWord)) emotionCounts.surprise++;
			else if (this.isDisgustWord(lowerWord)) emotionCounts.disgust++;
		}

		return emotionCounts;
	}

	private isJoyWord(word: string): boolean {
		return (
			word.includes('happ') ||
			word.includes('joy') ||
			word.includes('cheer') ||
			word.includes('delight') ||
			word.includes('pleas') ||
			word.includes('excit')
		);
	}

	private isSadnessWord(word: string): boolean {
		return (
			word.includes('sad') ||
			word.includes('depress') ||
			word.includes('grief') ||
			word.includes('sorrow') ||
			word.includes('melanchol') ||
			word.includes('miser')
		);
	}

	private isAngerWord(word: string): boolean {
		return (
			word.includes('ang') ||
			word.includes('fur') ||
			word.includes('rage') ||
			word.includes('mad') ||
			word.includes('irrit') ||
			word.includes('annoy')
		);
	}

	private isFearWord(word: string): boolean {
		return (
			word.includes('afraid') ||
			word.includes('scar') ||
			word.includes('terror') ||
			word.includes('anxi') ||
			word.includes('worr') ||
			word.includes('nerv')
		);
	}

	private isSurpriseWord(word: string): boolean {
		return (
			word.includes('surpris') ||
			word.includes('shock') ||
			word.includes('amaz') ||
			word.includes('astonish') ||
			word.includes('stun')
		);
	}

	private isDisgustWord(word: string): boolean {
		return (
			word.includes('disgust') ||
			word.includes('revol') ||
			word.includes('repuls') ||
			word.includes('sicken')
		);
	}

	private isActionWord(word: string): boolean {
		// Pattern-based action verb detection
		const actionPatterns =
			/^(ran|jumped|grabbed|pushed|pulled|struck|moved|rushed|charged|attacked|defended|fought)/i;
		return (
			actionPatterns.test(word) ||
			(word.endsWith('ed') && word.length > 4 && this.isPhysicalActionStem(word.slice(0, -2)))
		);
	}

	private isReflectionWord(word: string): boolean {
		return this.isCognitiveVerb(word);
	}

	private isPhysicalActionStem(stem: string): boolean {
		// CVC pattern common in action verbs
		const actionPattern = /^[bcdfghjklmnpqrstvwxyz][aeiou][bcdfghjklmnpqrstvwxyz]$/;
		return actionPattern.test(stem) || stem.length <= 4;
	}

	/**
	 * Get advanced readability analysis using multiple algorithms
	 */
	async getAdvancedReadabilityAnalysis(content: string): Promise<ReadabilityMetrics> {
		return advancedReadabilityService.calculateMetrics(content);
	}

	/**
	 * Compare readability between two texts
	 */
	async compareReadability(text1: string, text2: string): Promise<ReadabilityComparison> {
		return advancedReadabilityService.compareReadability(text1, text2);
	}

	/**
	 * Analyze readability trends across document sections
	 */
	async analyzeReadabilityTrends(
		content: string,
		segments: number = 10
	): Promise<ReadabilityTrends> {
		return advancedReadabilityService.analyzeReadabilityTrends(content, segments);
	}

	/**
	 * Get AI-powered writing suggestions using OpenAI
	 */
	async getAISuggestions(
		content: string,
		context?: { genre?: string; targetAudience?: string; style?: string }
	): Promise<WritingSuggestion[]> {
		if (!openaiService.isConfigured()) {
			return [];
		}

		try {
			return await openaiService.getWritingSuggestions(content, context);
		} catch (error) {
			console.error('AI suggestions error:', error);
			return [];
		}
	}

	/**
	 * Analyze writing style using AI
	 */
	async analyzeStyleWithAI(content: string): Promise<OpenAIStyleAnalysis | null> {
		if (!openaiService.isConfigured()) {
			return null;
		}

		try {
			return await openaiService.analyzeStyle(content);
		} catch (error) {
			console.error('AI style analysis error:', error);
			return null;
		}
	}

	/**
	 * Analyze characters using AI
	 */
	async analyzeCharactersWithAI(
		content: string,
		characterNames?: string[]
	): Promise<OpenAICharacterAnalysis[]> {
		if (!openaiService.isConfigured()) {
			return [];
		}

		try {
			return await openaiService.analyzeCharacters(content, characterNames);
		} catch (error) {
			console.error('AI character analysis error:', error);
			return [];
		}
	}

	/**
	 * Analyze plot structure using AI
	 */
	async analyzePlotWithAI(content: string): Promise<OpenAIPlotAnalysis | null> {
		if (!openaiService.isConfigured()) {
			return null;
		}

		try {
			return await openaiService.analyzePlot(content);
		} catch (error) {
			console.error('AI plot analysis error:', error);
			return null;
		}
	}

	/**
	 * Parse HTML content and extract text
	 */
	parseWebContent(
		html: string,
		baseUrl?: string,
		options?: ContentExtractionOptions
	): ParsedWebContent {
		return webContentParser.parseHtmlContent(html, baseUrl, options);
	}

	/**
	 * Convert HTML to Markdown
	 */
	convertHtmlToMarkdown(
		html: string,
		options?: { preserveImages?: boolean; preserveLinks?: boolean }
	): string {
		return webContentParser.htmlToMarkdown(html, options);
	}

	/**
	 * Extract research data from web content
	 */
	extractResearchData(parsedContent: ParsedWebContent, keywords?: string[]): ResearchData {
		return webContentParser.extractResearchData(parsedContent, keywords);
	}

	/**
	 * Configure OpenAI service
	 */
	configureOpenAI(config: {
		apiKey?: string;
		model?: string;
		maxTokens?: number;
		temperature?: number;
	}): void {
		openaiService.configure(config);
	}

	/**
	 * Check if OpenAI is configured
	 */
	isOpenAIConfigured(): boolean {
		return openaiService.isConfigured();
	}

	/**
	 * Generate writing prompts using AI
	 */
	async generateWritingPrompts(options: any = {}): Promise<any> {
		if (!openaiService.isConfigured()) {
			return {
				prompts: [],
				overallTheme: 'Creative Writing',
				writingGoals: []
			};
		}

		try {
			return await openaiService.generateWritingPrompts(options);
		} catch (error) {
			console.error('AI prompt generation error:', error);
			return {
				prompts: [],
				overallTheme: 'Creative Writing',
				writingGoals: []
			};
		}
	}
	
	/**
	 * Get the OpenAI service instance
	 */
	getOpenAIService() {
		return openaiService;
	}
}
