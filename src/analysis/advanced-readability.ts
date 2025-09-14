/**
 * Advanced Readability Metrics Service
 * Provides comprehensive text readability analysis using multiple algorithms
 * Implements standard readability formulas manually for reliability
 */

// Type definitions are now in types/analysis.d.ts
import {
	validateInput,
	processBatch,
	truncate,
	formatDuration,
	formatBytes,
	getTextMetrics,
	splitIntoSentences,
	generateHash,
} from '../utils/common.js';
import { getLogger } from '../core/logger.js';

const logger = getLogger('advanced-readability');

export interface ReadabilityMetrics {
	[key: string]: number | string | ReadingLevel | ReadabilityRecommendation[] | undefined;
	// Core readability scores
	fleschReadingEase: number;
	fleschKincaidGrade: number;
	smogIndex: number;
	colemanLiauIndex: number;
	automatedReadabilityIndex: number;
	gunningFogIndex: number;
	linsearWriteFormula: number;

	// Text statistics
	textStandard: string;
	averageWordsPerSentence: number;
	daleChallReadabilityScore: number;
	gunningFog: number;
	syllableCount: number;
	lexiconCount: number;
	sentenceCount: number;
	characterCount: number;
	averageSentenceLength: number;
	averageSyllablesPerWord: number;
	averageLettersPerWord: number;
	difficultWords: number;

	// Derived metrics
	readingTimeMinutes: number;
	readingLevel: ReadingLevel;
	comprehensionDifficulty:
		| 'very_easy'
		| 'easy'
		| 'fairly_easy'
		| 'standard'
		| 'fairly_difficult'
		| 'difficult'
		| 'very_difficult';
	targetAudience: string;
	recommendations: ReadabilityRecommendation[];
}

export interface ReadabilityRecommendation {
	category:
		| 'sentence_length'
		| 'vocabulary'
		| 'paragraph_structure'
		| 'word_choice'
		| 'overall_structure';
	severity: 'low' | 'medium' | 'high';
	issue: string;
	suggestion: string;
	impact: string;
}

export interface ReadingLevel {
	grade: number;
	description: string;
	ageRange: string;
	examples: string[];
}

export interface ComparativeAnalysis {
	text1: ReadabilityMetrics;
	text2: ReadabilityMetrics;
	comparison: {
		easier: 'text1' | 'text2' | 'similar';
		keyDifferences: string[];
		recommendations: string[];
	};
}

export interface ReadabilityTrends {
	segments: Array<{
		position: number;
		fleschScore: number;
		avgSentenceLength: number;
		difficultWords: number;
	}>;
	overallTrend: 'improving' | 'declining' | 'stable';
	problematicSections: number[];
	recommendations?: string[];
}

export class AdvancedReadabilityService {
	private readingSpeedWPM = 200; // Average reading speed in words per minute

	/**
	 * Calculate comprehensive readability metrics for text
	 */
	calculateMetrics(text: string): ReadabilityMetrics {
		try {
			validateInput(
				{ text },
				{
					text: { type: 'string', required: true, minLength: 1 },
				}
			);

			if (!text || text.trim().length === 0) {
				return this.getEmptyMetrics();
			}

			const textMetrics = getTextMetrics(text);
			const textHash = generateHash(text);
			logger.debug('Calculating readability metrics', {
				textHash: truncate(textHash, 8),
				wordCount: textMetrics.wordCount,
				sentenceCount: textMetrics.sentenceCount,
				contentSize: formatBytes(text.length),
			});

			const calculateMetricsSync = () => {
				// Calculate basic text statistics using utility functions where possible
				const sentences = this.countSentences(text);
				const words = this.countWords(text);
				const syllables = this.countSyllables(text);
				const characters = this.countCharacters(text, false);
				const difficultWords = this.countDifficultWords(text);

				const sentenceCount = sentences.length;
				const lexiconCount = words.length;
				const syllableCount = syllables;
				const characterCount = characters;

				const averageSentenceLength = lexiconCount / sentenceCount;
				const averageSyllablesPerWord = syllableCount / lexiconCount;
				const averageLettersPerWord = characterCount / lexiconCount;

				// Calculate readability scores using manual implementations
				const fleschReadingEase = this.calculateFleschReadingEase(
					averageSentenceLength,
					averageSyllablesPerWord
				);
				const fleschKincaidGrade = this.calculateFleschKincaidGrade(
					averageSentenceLength,
					averageSyllablesPerWord
				);
				const smogIndex = this.calculateSmogIndex(
					sentenceCount,
					this.countComplexWords(text)
				);
				const colemanLiauIndex = this.calculateColemanLiauIndex(
					characterCount,
					lexiconCount,
					sentenceCount
				);
				const automatedReadabilityIndex = this.calculateAutomatedReadabilityIndex(
					characterCount,
					lexiconCount,
					sentenceCount
				);
				const gunningFogIndex = this.calculateGunningFogIndex(
					averageSentenceLength,
					this.countComplexWords(text),
					lexiconCount
				);
				const linsearWriteFormula = this.calculateLinsearWriteFormula(text);
				const textStandard = this.determineTextStandard(fleschKincaidGrade);

				// Calculate derived metrics
				const readingTimeMinutes = Math.ceil(lexiconCount / this.readingSpeedWPM);
				const readingLevel = this.determineReadingLevel(fleschKincaidGrade);
				const comprehensionDifficulty =
					this.determineComprehensionDifficulty(fleschReadingEase);
				const targetAudience = this.determineTargetAudience(
					fleschKincaidGrade,
					comprehensionDifficulty
				);
				const fullMetrics = {
					fleschReadingEase,
					fleschKincaidGrade,
					smogIndex,
					colemanLiauIndex,
					automatedReadabilityIndex,
					gunningFogIndex,
					linsearWriteFormula,
					textStandard,
					syllableCount,
					lexiconCount,
					sentenceCount,
					characterCount,
					averageSentenceLength,
					averageWordsPerSentence: averageSentenceLength,
					averageSyllablesPerWord,
					averageLettersPerWord,
					difficultWords,
					daleChallReadabilityScore: 0,
					gunningFog: gunningFogIndex,
					readingTimeMinutes,
					readingLevel,
					comprehensionDifficulty,
					targetAudience,
					recommendations: [],
				};
				const recommendations = this.generateRecommendations(fullMetrics);

				return {
					fleschReadingEase,
					fleschKincaidGrade,
					smogIndex,
					colemanLiauIndex,
					automatedReadabilityIndex,
					gunningFogIndex,
					linsearWriteFormula,
					textStandard,
					syllableCount,
					lexiconCount,
					sentenceCount,
					characterCount,
					averageSentenceLength,
					averageWordsPerSentence: averageSentenceLength,
					averageSyllablesPerWord,
					averageLettersPerWord,
					difficultWords,
					daleChallReadabilityScore: 0, // Not implemented yet
					gunningFog: gunningFogIndex,
					readingTimeMinutes,
					readingLevel,
					comprehensionDifficulty,
					targetAudience,
					recommendations,
				};
			};

			const startTime = performance.now();
			const result = calculateMetricsSync();
			const executionTime = performance.now() - startTime;

			logger.debug('Readability calculation completed', {
				executionTime: formatDuration(executionTime),
				fleschScore: result.fleschReadingEase,
			});

			return result;
		} catch (error) {
			logger.error('Failed to calculate readability metrics', { error });
			return this.getEmptyMetrics();
		}
	}

	/**
	 * Calculate metrics for multiple texts efficiently
	 */
	async calculateMetricsBatch(texts: string[]): Promise<ReadabilityMetrics[]> {
		try {
			validateInput(
				{ texts },
				{
					texts: { type: 'array', required: true, minLength: 1, maxLength: 1000 },
				}
			);

			// Optimized batch processing function
			const processBatchOfTexts = async (batch: string[]): Promise<ReadabilityMetrics[]> => {
				return batch.map((text) => {
					// Add minimal validation for each text
					if (!text || text.trim().length === 0) {
						return this.getEmptyMetrics();
					}
					return this.calculateMetrics(text);
				});
			};

			const startTime = performance.now();
			logger.debug('Starting batch readability calculation', {
				textsCount: texts.length,
				estimatedTime: formatDuration(texts.length * 50), // Rough estimate
			});

			const results = await processBatch(texts, processBatchOfTexts, 20);
			const flatResults = results.flat();

			const executionTime = performance.now() - startTime;
			logger.debug('Batch readability calculation completed', {
				textsProcessed: flatResults.length,
				executionTime: formatDuration(executionTime),
				averageTimePerText: formatDuration(executionTime / Math.max(texts.length, 1)),
			});

			return flatResults;
		} catch (error) {
			logger.error('Failed to calculate batch metrics', { error });
			return [];
		}
	}

	/**
	 * Compare readability between two texts
	 */
	compareReadability(text1: string, text2: string): ComparativeAnalysis {
		const metrics1 = this.calculateMetrics(text1);
		const metrics2 = this.calculateMetrics(text2);

		const easier = this.determineEasierText(metrics1, metrics2);
		const keyDifferences = this.identifyKeyDifferences(metrics1, metrics2);
		const recommendations = this.generateComparativeRecommendations(metrics1, metrics2);

		return {
			text1: metrics1,
			text2: metrics2,
			comparison: {
				easier,
				keyDifferences,
				recommendations,
			},
		};
	}

	/**
	 * Analyze readability trends across document sections
	 */
	analyzeReadabilityTrends(text: string, segmentCount: number = 10): ReadabilityTrends {
		const segments = this.splitTextIntoSegments(text, segmentCount);
		const segmentMetrics = segments.map((segment, index) => {
			const metrics = this.calculateMetrics(segment);
			return {
				position: ((index + 1) / segmentCount) * 100,
				fleschScore: metrics.fleschReadingEase,
				avgSentenceLength: metrics.averageSentenceLength,
				difficultWords: metrics.difficultWords,
			};
		});

		const overallTrend = this.determineTrend(segmentMetrics);
		const problematicSections = this.identifyProblematicSections(segmentMetrics);

		return {
			segments: segmentMetrics,
			overallTrend,
			problematicSections,
		};
	}

	/**
	 * Get readability recommendations for specific audience
	 */
	getAudienceSpecificRecommendations(
		text: string,
		targetAudience:
			| 'elementary'
			| 'middle_school'
			| 'high_school'
			| 'college'
			| 'graduate'
			| 'general_public'
	): ReadabilityRecommendation[] {
		const metrics = this.calculateMetrics(text);
		const targetGradeLevel = this.getTargetGradeLevel(targetAudience);
		const recommendations: ReadabilityRecommendation[] = [];

		// Check if current level matches target
		if (metrics.fleschKincaidGrade > targetGradeLevel + 2) {
			recommendations.push({
				category: 'overall_structure',
				severity: 'high',
				issue: `Text is ${Math.round(metrics.fleschKincaidGrade - targetGradeLevel)} grade levels above target audience`,
				suggestion: 'Simplify sentence structure and use more common vocabulary',
				impact: 'Will make content more accessible to target readers',
			});
		}

		// Add audience-specific recommendations
		recommendations.push(...this.getAudienceSpecificSuggestions(metrics, targetAudience));

		return recommendations;
	}

	/**
	 * Calculate readability score for different writing contexts
	 */
	getContextualReadability(
		text: string,
		context: 'academic' | 'business' | 'creative' | 'technical' | 'marketing' | 'educational'
	): { score: number; contextAppropriateness: string; suggestions: string[] } {
		const metrics = this.calculateMetrics(text);
		const contextRanges = this.getContextualRanges(context);

		let score = 0;
		let appropriateness = '';
		const suggestions: string[] = [];

		// Score based on context appropriateness
		if (
			contextRanges.minFlesch !== undefined &&
			contextRanges.maxFlesch !== undefined &&
			metrics.fleschReadingEase >= contextRanges.minFlesch &&
			metrics.fleschReadingEase <= contextRanges.maxFlesch
		) {
			score += 40;
		} else {
			suggestions.push(`Adjust complexity for ${context} context`);
		}

		if (
			contextRanges.minSentenceLength !== undefined &&
			contextRanges.maxSentenceLength !== undefined &&
			metrics.averageSentenceLength >= contextRanges.minSentenceLength &&
			metrics.averageSentenceLength <= contextRanges.maxSentenceLength
		) {
			score += 30;
		} else {
			suggestions.push(`Adjust sentence length for ${context} writing`);
		}

		if (
			contextRanges.minSyllables !== undefined &&
			contextRanges.maxSyllables !== undefined &&
			metrics.averageSyllablesPerWord >= contextRanges.minSyllables &&
			metrics.averageSyllablesPerWord <= contextRanges.maxSyllables
		) {
			score += 30;
		} else {
			suggestions.push(`Adjust vocabulary complexity for ${context} audience`);
		}

		// Determine appropriateness
		if (score >= 90) appropriateness = 'excellent';
		else if (score >= 70) appropriateness = 'good';
		else if (score >= 50) appropriateness = 'fair';
		else appropriateness = 'needs_improvement';

		return { score, contextAppropriateness: appropriateness, suggestions };
	}

	/**
	 * Determine reading level from grade level score
	 */
	private determineReadingLevel(gradeLevel: number): ReadingLevel {
		if (gradeLevel < 6) {
			return {
				grade: Math.round(gradeLevel),
				description: 'Elementary School',
				ageRange: '6-11 years',
				examples: ["Children's books", 'Simple instructions', 'Basic educational content'],
			};
		} else if (gradeLevel < 9) {
			return {
				grade: Math.round(gradeLevel),
				description: 'Middle School',
				ageRange: '12-14 years',
				examples: ['Young adult fiction', 'Educational materials', 'Simple news articles'],
			};
		} else if (gradeLevel < 13) {
			return {
				grade: Math.round(gradeLevel),
				description: 'High School',
				ageRange: '15-18 years',
				examples: ['Newspaper articles', 'Popular magazines', 'Most fiction'],
			};
		} else if (gradeLevel < 16) {
			return {
				grade: Math.round(gradeLevel),
				description: 'College Level',
				ageRange: '18-22 years',
				examples: ['Academic texts', 'Professional articles', 'Complex non-fiction'],
			};
		} else {
			return {
				grade: Math.round(gradeLevel),
				description: 'Graduate Level',
				ageRange: '22+ years',
				examples: ['Academic papers', 'Technical manuals', 'Scholarly articles'],
			};
		}
	}

	/**
	 * Determine comprehension difficulty from Flesch Reading Ease score
	 */
	private determineComprehensionDifficulty(
		fleschScore: number
	): ReadabilityMetrics['comprehensionDifficulty'] {
		if (fleschScore >= 90) return 'very_easy';
		if (fleschScore >= 80) return 'easy';
		if (fleschScore >= 70) return 'fairly_easy';
		if (fleschScore >= 60) return 'standard';
		if (fleschScore >= 50) return 'fairly_difficult';
		if (fleschScore >= 30) return 'difficult';
		return 'very_difficult';
	}

	/**
	 * Determine target audience based on metrics
	 */
	private determineTargetAudience(
		gradeLevel: number,
		difficulty: ReadabilityMetrics['comprehensionDifficulty']
	): string {
		if (gradeLevel < 6 || difficulty === 'very_easy') {
			return 'Elementary students, beginning readers';
		} else if (gradeLevel < 9 || difficulty === 'easy') {
			return 'Middle school students, general public';
		} else if (gradeLevel < 13 || difficulty === 'fairly_easy') {
			return 'High school students, casual readers';
		} else if (gradeLevel < 16 || difficulty === 'standard') {
			return 'College students, educated adults';
		} else {
			return 'Graduate students, professionals, academics';
		}
	}

	/**
	 * Generate readability recommendations
	 */
	private generateRecommendations(metrics: ReadabilityMetrics): ReadabilityRecommendation[] {
		const recommendations: ReadabilityRecommendation[] = [];

		// Sentence length recommendations
		if (metrics.averageSentenceLength > 25) {
			recommendations.push({
				category: 'sentence_length',
				severity: 'high',
				issue: `Sentences are too long (average: ${Math.round(
					metrics.averageSentenceLength
				)} words)`,
				suggestion: 'Break long sentences into shorter ones (aim for 15-20 words)',
				impact: 'Will improve readability and comprehension',
			});
		} else if (metrics.averageSentenceLength > 20) {
			recommendations.push({
				category: 'sentence_length',
				severity: 'medium',
				issue: 'Sentences are moderately long',
				suggestion: 'Consider shortening some sentences for better flow',
				impact: 'Will enhance readability',
			});
		}

		// Vocabulary recommendations
		if (metrics.averageSyllablesPerWord > 1.7) {
			recommendations.push({
				category: 'vocabulary',
				severity: 'high',
				issue: 'Complex vocabulary (high syllable count per word)',
				suggestion: 'Use simpler, more common words where possible',
				impact: 'Will make content more accessible',
			});
		}

		// Difficult words recommendations
		const difficultWordsPercentage = (metrics.difficultWords / metrics.lexiconCount) * 100;
		if (difficultWordsPercentage > 15) {
			recommendations.push({
				category: 'word_choice',
				severity: 'high',
				issue: `${Math.round(difficultWordsPercentage)}% of words are considered difficult`,
				suggestion: 'Replace difficult words with simpler alternatives',
				impact: 'Will significantly improve comprehension',
			});
		} else if (difficultWordsPercentage > 10) {
			recommendations.push({
				category: 'word_choice',
				severity: 'medium',
				issue: 'Moderate use of difficult words',
				suggestion: 'Consider simplifying some word choices',
				impact: 'Will improve accessibility',
			});
		}

		// Overall structure recommendations
		if (metrics.fleschReadingEase < 50) {
			recommendations.push({
				category: 'overall_structure',
				severity: 'high',
				issue: `Text is difficult to read (Flesch score: ${Math.round(
					metrics.fleschReadingEase
				)})`,
				suggestion:
					'Simplify overall writing style, use shorter sentences and common words',
				impact: 'Will dramatically improve readability',
			});
		}

		return recommendations;
	}

	/**
	 * Get empty metrics for error cases
	 */
	private getEmptyMetrics(): ReadabilityMetrics {
		return {
			fleschReadingEase: 0,
			fleschKincaidGrade: 0,
			smogIndex: 0,
			colemanLiauIndex: 0,
			automatedReadabilityIndex: 0,
			gunningFogIndex: 0,
			linsearWriteFormula: 0,
			textStandard: 'N/A',
			syllableCount: 0,
			lexiconCount: 0,
			sentenceCount: 0,
			characterCount: 0,
			averageSentenceLength: 0,
			averageSyllablesPerWord: 0,
			averageLettersPerWord: 0,
			difficultWords: 0,
			averageWordsPerSentence: 0,
			daleChallReadabilityScore: 0,
			gunningFog: 0,
			readingTimeMinutes: 0,
			readingLevel: {
				grade: 0,
				description: 'Unknown',
				ageRange: 'N/A',
				examples: [],
			},
			comprehensionDifficulty: 'standard',
			targetAudience: 'Unknown',
			recommendations: [],
		};
	}

	/**
	 * Determine which text is easier to read
	 */
	private determineEasierText(
		metrics1: ReadabilityMetrics,
		metrics2: ReadabilityMetrics
	): 'text1' | 'text2' | 'similar' {
		const score1 = metrics1.fleschReadingEase;
		const score2 = metrics2.fleschReadingEase;

		const difference = Math.abs(score1 - score2);

		if (difference < 5) {
			return 'similar';
		}

		return score1 > score2 ? 'text1' : 'text2';
	}

	/**
	 * Identify key differences between two texts
	 */
	private identifyKeyDifferences(
		metrics1: ReadabilityMetrics,
		metrics2: ReadabilityMetrics
	): string[] {
		const differences: string[] = [];

		const sentenceDiff = Math.abs(
			metrics1.averageSentenceLength - metrics2.averageSentenceLength
		);
		if (sentenceDiff > 3) {
			const longer =
				metrics1.averageSentenceLength > metrics2.averageSentenceLength
					? 'first'
					: 'second';
			differences.push(
				`The ${longer} text has significantly longer sentences (${Math.round(sentenceDiff)} word difference)`
			);
		}

		const syllableDiff = Math.abs(
			metrics1.averageSyllablesPerWord - metrics2.averageSyllablesPerWord
		);
		if (syllableDiff > 0.2) {
			const complex =
				metrics1.averageSyllablesPerWord > metrics2.averageSyllablesPerWord
					? 'first'
					: 'second';
			differences.push(`The ${complex} text uses more complex vocabulary`);
		}

		const gradeDiff = Math.abs(metrics1.fleschKincaidGrade - metrics2.fleschKincaidGrade);
		if (gradeDiff > 2) {
			const harder =
				metrics1.fleschKincaidGrade > metrics2.fleschKincaidGrade ? 'first' : 'second';
			differences.push(`The ${harder} text is ${Math.round(gradeDiff)} grade levels higher`);
		}

		return differences;
	}

	/**
	 * Generate comparative recommendations
	 */
	private generateComparativeRecommendations(
		metrics1: ReadabilityMetrics,
		metrics2: ReadabilityMetrics
	): string[] {
		const recommendations: string[] = [];

		if (metrics1.fleschReadingEase < metrics2.fleschReadingEase) {
			recommendations.push(
				'Consider adopting the simpler sentence structure from the second text'
			);
		} else if (metrics2.fleschReadingEase < metrics1.fleschReadingEase) {
			recommendations.push(
				'Consider adopting the simpler sentence structure from the first text'
			);
		}

		if (Math.abs(metrics1.averageSentenceLength - metrics2.averageSentenceLength) > 3) {
			const shorter =
				metrics1.averageSentenceLength < metrics2.averageSentenceLength
					? 'first'
					: 'second';
			recommendations.push(
				`The ${shorter} text's sentence length might be more appropriate for general audiences`
			);
		}

		return recommendations;
	}

	/**
	 * Split text into segments for trend analysis
	 */
	private splitTextIntoSegments(text: string, segmentCount: number): string[] {
		const sentences = splitIntoSentences(text);
		const sentencesPerSegment = Math.ceil(sentences.length / segmentCount);
		const segments: string[] = [];

		for (let i = 0; i < segmentCount; i++) {
			const start = i * sentencesPerSegment;
			const end = Math.min(start + sentencesPerSegment, sentences.length);
			const segment = `${sentences.slice(start, end).join('. ')}.`;
			segments.push(segment);
		}

		return segments;
	}

	/**
	 * Determine overall readability trend
	 */
	private determineTrend(
		segments: ReadabilityTrends['segments']
	): ReadabilityTrends['overallTrend'] {
		if (segments.length < 3) return 'stable';

		const firstThird = segments.slice(0, Math.floor(segments.length / 3));
		const lastThird = segments.slice(-Math.floor(segments.length / 3));

		const firstAvg = firstThird.reduce((sum, s) => sum + s.fleschScore, 0) / firstThird.length;
		const lastAvg = lastThird.reduce((sum, s) => sum + s.fleschScore, 0) / lastThird.length;

		const difference = lastAvg - firstAvg;

		if (difference > 5) return 'improving';
		if (difference < -5) return 'declining';
		return 'stable';
	}

	/**
	 * Identify problematic sections with low readability
	 */
	private identifyProblematicSections(segments: ReadabilityTrends['segments']): number[] {
		const averageScore = segments.reduce((sum, s) => sum + s.fleschScore, 0) / segments.length;
		const threshold = averageScore - 10; // 10 points below average

		return segments
			.map((segment, index) => ({ index, score: segment.fleschScore }))
			.filter((s) => s.score < threshold)
			.map((s) => s.index + 1); // Convert to 1-based indexing
	}

	/**
	 * Get target grade level for audience
	 */
	private getTargetGradeLevel(audience: string): number {
		const levels = {
			elementary: 5,
			middle_school: 8,
			high_school: 12,
			college: 15,
			graduate: 18,
			general_public: 10,
		};
		return levels[audience as keyof typeof levels] || 10;
	}

	/**
	 * Get audience-specific suggestions
	 */
	private getAudienceSpecificSuggestions(
		metrics: ReadabilityMetrics,
		audience: string
	): ReadabilityRecommendation[] {
		const suggestions: ReadabilityRecommendation[] = [];

		switch (audience) {
			case 'elementary':
				if (metrics.averageSentenceLength > 12) {
					suggestions.push({
						category: 'sentence_length',
						severity: 'high',
						issue: 'Sentences too long for elementary readers',
						suggestion: 'Use sentences with 8-12 words maximum',
						impact: 'Will match elementary reading comprehension',
					});
				}
				break;

			case 'general_public':
				if (metrics.fleschKincaidGrade > 10) {
					suggestions.push({
						category: 'overall_structure',
						severity: 'medium',
						issue: 'Content above general public reading level',
						suggestion: 'Simplify to 8th-10th grade level for broader accessibility',
						impact: 'Will reach wider audience',
					});
				}
				break;
		}

		return suggestions;
	}

	/**
	 * Get contextual ranges for different writing contexts
	 */
	private getContextualRanges(context: string): {
		fleschReadingEase: { min: number; max: number; target: number };
		fleschKincaidGrade: { min: number; max: number; target: number };
		minSentenceLength?: number;
		maxSentenceLength?: number;
		minSyllables?: number;
		maxSyllables?: number;
		minFlesch?: number;
		maxFlesch?: number;
	} {
		const ranges: Record<
			string,
			{
				minFlesch: number;
				maxFlesch: number;
				minSentenceLength: number;
				maxSentenceLength: number;
				minSyllables: number;
				maxSyllables: number;
			}
		> = {
			academic: {
				minFlesch: 30,
				maxFlesch: 60,
				minSentenceLength: 18,
				maxSentenceLength: 25,
				minSyllables: 1.6,
				maxSyllables: 2.1,
			},
			business: {
				minFlesch: 50,
				maxFlesch: 70,
				minSentenceLength: 15,
				maxSentenceLength: 22,
				minSyllables: 1.4,
				maxSyllables: 1.8,
			},
			creative: {
				minFlesch: 60,
				maxFlesch: 80,
				minSentenceLength: 12,
				maxSentenceLength: 20,
				minSyllables: 1.3,
				maxSyllables: 1.7,
			},
			technical: {
				minFlesch: 40,
				maxFlesch: 65,
				minSentenceLength: 16,
				maxSentenceLength: 24,
				minSyllables: 1.5,
				maxSyllables: 2.0,
			},
			marketing: {
				minFlesch: 65,
				maxFlesch: 85,
				minSentenceLength: 10,
				maxSentenceLength: 18,
				minSyllables: 1.2,
				maxSyllables: 1.6,
			},
			educational: {
				minFlesch: 55,
				maxFlesch: 75,
				minSentenceLength: 12,
				maxSentenceLength: 20,
				minSyllables: 1.3,
				maxSyllables: 1.7,
			},
		};

		const selected = ranges[context as keyof typeof ranges] || ranges.business;

		return {
			fleschReadingEase: {
				min: selected.minFlesch,
				max: selected.maxFlesch,
				target: (selected.minFlesch + selected.maxFlesch) / 2,
			},
			fleschKincaidGrade: {
				min: 5,
				max: 12,
				target: 8,
			},
			minSentenceLength: selected.minSentenceLength,
			maxSentenceLength: selected.maxSentenceLength,
			minSyllables: selected.minSyllables,
			maxSyllables: selected.maxSyllables,
			minFlesch: selected.minFlesch,
			maxFlesch: selected.maxFlesch,
		};
	}

	/**
	 * Manual text analysis methods
	 */
	private countSentences(text: string): string[] {
		return splitIntoSentences(text);
	}

	private countWords(text: string): string[] {
		return text
			.toLowerCase()
			.replace(/[^\w\s]/g, ' ')
			.split(/\s+/)
			.filter((w) => w.length > 0);
	}

	private countSyllables(text: string): number {
		const words = this.countWords(text);
		return words.reduce((total, word) => total + this.syllablesInWord(word), 0);
	}

	private syllablesInWord(word: string): number {
		word = word.toLowerCase();
		let count = 0;
		let previousWasVowel = false;

		for (let i = 0; i < word.length; i++) {
			const isVowel = /[aeiou]/.test(word[i]);
			if (isVowel && !previousWasVowel) {
				count++;
			}
			previousWasVowel = isVowel;
		}

		// Adjust for silent e
		if (word.endsWith('e') && count > 1) {
			count--;
		}

		return Math.max(1, count);
	}

	private countCharacters(text: string, includeSpaces: boolean = false): number {
		return includeSpaces ? text.length : text.replace(/\s/g, '').length;
	}

	private countDifficultWords(text: string): number {
		const words = this.countWords(text);
		return words.filter((word) => {
			// Words with 3+ syllables are considered difficult
			return this.syllablesInWord(word) >= 3;
		}).length;
	}

	private countComplexWords(text: string): number {
		return this.countDifficultWords(text);
	}

	private calculateFleschReadingEase(
		avgSentenceLength: number,
		avgSyllablesPerWord: number
	): number {
		return 206.835 - 1.015 * avgSentenceLength - 84.6 * avgSyllablesPerWord;
	}

	private calculateFleschKincaidGrade(
		avgSentenceLength: number,
		avgSyllablesPerWord: number
	): number {
		return 0.39 * avgSentenceLength + 11.8 * avgSyllablesPerWord - 15.59;
	}

	private calculateSmogIndex(sentenceCount: number, complexWords: number): number {
		if (sentenceCount < 3) return 0;
		return 1.043 * Math.sqrt(complexWords * (30 / sentenceCount)) + 3.1291;
	}

	private calculateColemanLiauIndex(
		characters: number,
		words: number,
		sentences: number
	): number {
		const L = (characters / words) * 100;
		const S = (sentences / words) * 100;
		return 0.0588 * L - 0.296 * S - 15.8;
	}

	private calculateAutomatedReadabilityIndex(
		characters: number,
		words: number,
		sentences: number
	): number {
		return 4.71 * (characters / words) + 0.5 * (words / sentences) - 21.43;
	}

	private calculateGunningFogIndex(
		avgSentenceLength: number,
		complexWords: number,
		totalWords: number
	): number {
		const complexWordPercentage = (complexWords / totalWords) * 100;
		return 0.4 * (avgSentenceLength + complexWordPercentage);
	}

	private calculateLinsearWriteFormula(text: string): number {
		const words = this.countWords(text);
		const sentences = this.countSentences(text);

		let easyWords = 0;
		let difficultWords = 0;

		words.forEach((word) => {
			if (this.syllablesInWord(word) < 3) {
				easyWords++;
			} else {
				difficultWords++;
			}
		});

		const score =
			(100 - (difficultWords / words.length) * 100 + easyWords / sentences.length) / 2;
		return score > 20 ? score / 2 : (score - 2) / 2;
	}

	private determineTextStandard(gradeLevel: number): string {
		if (gradeLevel < 1) return '1st grade';
		if (gradeLevel < 2) return '2nd grade';
		if (gradeLevel < 3) return '3rd grade';
		if (gradeLevel < 4) return '4th grade';
		if (gradeLevel < 5) return '5th grade';
		if (gradeLevel < 6) return '6th grade';
		if (gradeLevel < 7) return '7th grade';
		if (gradeLevel < 8) return '8th grade';
		if (gradeLevel < 9) return '9th grade';
		if (gradeLevel < 10) return '10th grade';
		if (gradeLevel < 11) return '11th grade';
		if (gradeLevel < 12) return '12th grade';
		if (gradeLevel < 13) return '12th grade';
		if (gradeLevel < 16) return 'College level';
		return 'Graduate level';
	}
}

// Export singleton instance
export const advancedReadabilityService = new AdvancedReadabilityService();
