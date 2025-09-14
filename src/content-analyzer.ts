// import type { ScrivenerDocument } from './scrivener-project.js';
import { advancedReadabilityService } from './analysis/advanced-readability.js';
import { classifier as wordClassifier } from './analysis/ml-word-classifier-pro.js';
import { cached, caches } from './core/cache.js';
import { getLogger } from './core/logger.js';
import type {
	CharacterAnalysis as OpenAICharacterAnalysis,
	PlotAnalysis as OpenAIPlotAnalysis,
	StyleAnalysis as OpenAIStyleAnalysis,
} from './services/openai-service.js';
import { OpenAIService } from './services/openai-service.js';
import { webContentParser } from './services/web-content-parser.js';
import { nlpAnalyzer } from './services/analysis/nlp-sentiment-analyzer.js';
import { advancedAnalyzer } from './services/analysis/advanced-content-analyzer.js';
import type {
	ContentExtractionOptions,
	ParsedWebContent,
	ReadabilityComparison,
	ReadabilityMetrics,
	ReadabilityTrends,
	ResearchData,
	WritingSuggestion,
} from './types/analysis.js';
import {
	getWordPairs,
	splitIntoSentences,
	getAccurateWordCount,
	getAccurateSentenceCount,
	getAccurateParagraphCount,
	generateHash,
} from './utils/common.js';

const openaiService = new OpenAIService();

const logger = getLogger('content-analyzer');

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

	@cached(
		(content: string, documentId: string) => {
			const contentHash = generateHash(content);
			return `analysis:${documentId}:${contentHash}`;
		},
		caches.analysis,
		300_000 // Cache for 5 minutes
	)
	async analyzeContent(content: string, documentId: string): Promise<ContentAnalysis> {
		logger.debug(`Analyzing content for document ${documentId}`);
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
		// Use accurate counting methods
		const wordCount = getAccurateWordCount(content);
		const sentenceCount = getAccurateSentenceCount(content);
		const paragraphCount = getAccurateParagraphCount(content);
		const averageSentenceLength = sentenceCount > 0 ? wordCount / sentenceCount : 0;
		const averageParagraphLength = paragraphCount > 0 ? wordCount / paragraphCount : 0;
		const readingTime = Math.ceil(wordCount / 250); // Average reading speed

		// Use advanced analyzer for accurate readability scores with fallback
		const readabilityScores = advancedAnalyzer.calculateReadability(content);

		// Calculate our own readability metrics as backup/validation
		const syllableCount = this.countSyllables(content.split(/\s+/));
		const fallbackReadability = this.calculateReadability(
			wordCount,
			sentenceCount,
			syllableCount
		);

		return {
			wordCount,
			sentenceCount,
			paragraphCount,
			averageSentenceLength,
			averageParagraphLength,
			readingTime,
			// Use advanced scores if available, fallback to our calculation
			fleschReadingEase:
				readabilityScores.fleschReadingEase || fallbackReadability.fleschReadingEase,
			fleschKincaidGrade:
				readabilityScores.fleschKincaidGrade || fallbackReadability.fleschKincaidGrade,
		};
	}

	private analyzeStyle(content: string): StyleAnalysis {
		const sentences = splitIntoSentences(content);
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

		// Analyze content patterns using helper methods
		const patterns = this.analyzeContentPatterns(content);
		const conflictDensity = (patterns.conflictWords / patterns.totalWords) * 100;
		const actionDensity = (patterns.actionWords / patterns.totalWords) * 100;
		const reflectionDensity = (patterns.reflectionWords / patterns.totalWords) * 100;

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

		// Calculate style consistency based on various metrics
		const styleConsistency = this.calculateStyleConsistency({
			sentences,
			paragraphs: content.split(/\n\n+/),
			sentenceVariety: parseFloat(sentenceVariety),
			vocabularyComplexity: parseFloat(vocabularyComplexity),
		});

		return {
			sentenceVariety,
			vocabularyComplexity,
			adverbUsage,
			passiveVoicePercentage,
			dialoguePercentage,
			descriptionPercentage,
			mostFrequentWords,
			styleConsistency,
		} as any;
	}

	private calculateStyleConsistency(data: {
		sentences: string[];
		paragraphs: string[];
		sentenceVariety: number;
		vocabularyComplexity: number;
	}): number {
		// Calculate sentence length consistency
		const sentenceLengths = data.sentences.map((s) => s.split(/\s+/).length);
		const avgSentenceLength =
			sentenceLengths.reduce((a, b) => a + b, 0) / sentenceLengths.length;
		const sentenceLengthStdDev = Math.sqrt(
			sentenceLengths.reduce((sum, len) => sum + Math.pow(len - avgSentenceLength, 2), 0) /
				sentenceLengths.length
		);
		const sentenceLengthCV = (sentenceLengthStdDev / avgSentenceLength) * 100;

		// Calculate paragraph length consistency
		const paragraphLengths = data.paragraphs.map((p) => p.split(/\s+/).length);
		const avgParagraphLength =
			paragraphLengths.reduce((a, b) => a + b, 0) / paragraphLengths.length;
		const paragraphLengthStdDev = Math.sqrt(
			paragraphLengths.reduce((sum, len) => sum + Math.pow(len - avgParagraphLength, 2), 0) /
				paragraphLengths.length
		);
		const paragraphLengthCV = (paragraphLengthStdDev / avgParagraphLength) * 100;

		// Calculate overall consistency score
		// Lower coefficient of variation means more consistency
		const sentenceConsistencyScore = Math.max(0, 100 - sentenceLengthCV);
		const paragraphConsistencyScore = Math.max(0, 100 - paragraphLengthCV);

		// Weight different aspects of consistency
		const weights = {
			sentenceLength: 0.3,
			paragraphLength: 0.2,
			sentenceVariety: 0.25,
			vocabularyComplexity: 0.25,
		};

		const weightedScore =
			sentenceConsistencyScore * weights.sentenceLength +
			paragraphConsistencyScore * weights.paragraphLength +
			data.sentenceVariety * weights.sentenceVariety +
			data.vocabularyComplexity * weights.vocabularyComplexity;

		return Math.round(Math.min(100, Math.max(0, weightedScore)));
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
		const sentences = splitIntoSentences(content);

		// Repetitiveness
		const wordPairs = new Map<string, number>();
		const pairs = getWordPairs(words);
		for (const [word1, word2] of pairs) {
			const pair = `${word1} ${word2}`;
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
		// Use NLP-based sentiment analysis for accurate context-aware emotion detection
		const overallSentiment = nlpAnalyzer.analyzeSentiment(content);
		const dominantEmotion = overallSentiment.emotion;

		// Sophisticated emotional arc analysis with proper context
		const emotionalArcData = nlpAnalyzer.analyzeEmotionalArc(content, 10);
		const emotionalArc = emotionalArcData.map((data, index) => {
			const prevEmotion = index > 0 ? emotionalArcData[index - 1].emotion : null;
			const emotionShift = prevEmotion && prevEmotion !== data.emotion;

			return {
				position: data.position,
				emotion: data.emotion,
				intensity: Math.round(data.intensity),
				transition: emotionShift || undefined,
			};
		});

		// Calculate tension level using context-aware analysis
		const tensionWords = [
			'tension',
			'conflict',
			'danger',
			'threat',
			'suspense',
			'crisis',
			'confrontation',
			'struggle',
			'clash',
			'peril',
			'risk',
			'jeopardy',
		];
		const sentences = splitIntoSentences(content);
		let tensionScore = 0;

		sentences.forEach((sentence) => {
			const sentimentResult = nlpAnalyzer.analyzeSentiment(sentence);
			// Check for tension words with proper negation handling
			const hasTension = tensionWords.some((word) => {
				const regex = new RegExp(`\\b${word}\\b`, 'i');
				if (sentence.match(regex)) {
					// Check if it's negated in the sentiment analysis
					const negated = sentimentResult.negations.some((neg) =>
						neg.scope.some((scopeWord) => scopeWord.toLowerCase().includes(word))
					);
					return !negated;
				}
				return false;
			});

			if (hasTension) tensionScore++;

			// High negative sentiment with high intensity also indicates tension
			if (sentimentResult.comparative < -0.3 && Math.abs(sentimentResult.score) > 2) {
				tensionScore += 0.5;
			}
		});

		const tensionLevel = Math.min((tensionScore / sentences.length) * 100, 100);

		// Calculate mood consistency based on emotional transitions
		const moodConsistency = this.calculateMoodConsistency(emotionalArc);

		return {
			dominantEmotion,
			emotionalArc,
			tensionLevel,
			moodConsistency,
		};
	}

	private isEmotionalWord(word: string): boolean {
		const emotionalWords = [
			'love',
			'hate',
			'fear',
			'joy',
			'sad',
			'happy',
			'angry',
			'excited',
			'nervous',
			'anxious',
			'hopeful',
			'desperate',
			'passionate',
			'lonely',
			'devastated',
			'thrilled',
			'terrified',
			'elated',
			'miserable',
			'furious',
		];
		return emotionalWords.includes(word.toLowerCase());
	}

	private calculateMoodConsistency(
		emotionalArc: Array<{ emotion: string; intensity: number; transition?: boolean }>
	): number {
		if (emotionalArc.length < 2) return 100;

		// Count emotional transitions
		const transitionCount = emotionalArc.filter((arc) => arc.transition).length;
		const transitionRate = transitionCount / (emotionalArc.length - 1);

		// Calculate intensity variance
		const intensities = emotionalArc.map((arc) => arc.intensity);
		const avgIntensity = intensities.reduce((a, b) => a + b, 0) / intensities.length;
		const intensityVariance = Math.sqrt(
			intensities.reduce((sum, int) => sum + Math.pow(int - avgIntensity, 2), 0) /
				intensities.length
		);

		// Lower transition rate and lower intensity variance = higher consistency
		const transitionScore = Math.max(0, 100 - transitionRate * 100);
		const intensityScore = Math.max(0, 100 - intensityVariance);

		return Math.round(transitionScore * 0.6 + intensityScore * 0.4);
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

		// Use NLP-based pacing analysis for accurate verb type detection
		const pacingData = nlpAnalyzer.analyzePacing(content);
		const actionVsReflection = pacingData.actionDensity / (1 - pacingData.actionDensity || 0.1);

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

			// First check if it's an emotional word at all for performance
			if (!this.isEmotionalWord(lowerWord)) continue;

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
			logger.error('AI suggestions error', { error });
			return [];
		}
	}

	/**
	 * Analyze writing style using AI
	 */
	@cached(
		(content: string) => `ai-style:${content.substring(0, 100)}:${content.length}`,
		caches.analysis,
		600_000 // Cache for 10 minutes
	)
	async analyzeStyleWithAI(content: string): Promise<OpenAIStyleAnalysis | null> {
		if (!openaiService.isConfigured()) {
			return null;
		}

		try {
			return await openaiService.analyzeStyle(content);
		} catch (error) {
			logger.error('AI style analysis error', { error });
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
			logger.error('AI character analysis error', { error });
			return [];
		}
	}

	/**
	 * Analyze plot structure using AI
	 */
	@cached(
		(content: string) => `ai-plot:${content.substring(0, 100)}:${content.length}`,
		caches.analysis,
		600_000 // Cache for 10 minutes
	)
	async analyzePlotWithAI(content: string): Promise<OpenAIPlotAnalysis | null> {
		if (!openaiService.isConfigured()) {
			return null;
		}

		try {
			return await openaiService.analyzePlot(content);
		} catch (error) {
			logger.error('AI plot analysis error', { error });
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
	async generateWritingPrompts(
		options: {
			genre?: string;
			theme?: string;
			count?: number;
			complexity?: 'simple' | 'moderate' | 'complex';
			promptType?: 'scene' | 'character' | 'dialogue' | 'description' | 'conflict' | 'mixed';
			existingCharacters?: string[];
			currentPlotPoints?: string[];
			storyContext?: string;
			targetWordCount?: number;
			writingStyle?: string;
			mood?: string;
		} = {}
	): Promise<{
		prompts: Array<{
			prompt: string;
			type: string;
			difficulty: string;
			estimatedWords: number;
			tips: string[];
			relatedCharacters?: string[];
			suggestedTechniques?: string[];
		}>;
		overallTheme: string;
		writingGoals: string[];
	}> {
		if (!openaiService.isConfigured()) {
			return {
				prompts: [],
				overallTheme: 'Creative Writing',
				writingGoals: [],
			};
		}

		try {
			return await openaiService.generateWritingPrompts(options);
		} catch (error) {
			logger.error('AI prompt generation error', { error });
			return {
				prompts: [],
				overallTheme: 'Creative Writing',
				writingGoals: [],
			};
		}
	}

	/**
	 * Get the OpenAI service instance
	 */
	getOpenAIService() {
		return openaiService;
	}

	/**
	 * Analyze content for different types of word patterns
	 */
	private analyzeContentPatterns(content: string): {
		conflictWords: number;
		actionWords: number;
		reflectionWords: number;
		totalWords: number;
	} {
		const words = content.toLowerCase().split(/\s+/);
		let conflictWords = 0;
		let actionWords = 0;
		let reflectionWords = 0;

		for (const word of words) {
			if (this.isConflictWord(word)) conflictWords++;
			if (this.isActionWord(word)) actionWords++;
			if (this.isReflectionWord(word)) reflectionWords++;
		}

		return {
			conflictWords,
			actionWords,
			reflectionWords,
			totalWords: words.length,
		};
	}
}
