import { computeReadability } from 'narrative-lens';
/**
 * Advanced Readability Metrics Service
 * Provides comprehensive text readability analysis using multiple algorithms
 * Delegates supported readability formulas to Narrative Lens
 */

import { validateInput, processBatch, splitIntoSentences } from '../utils/common.js';
import { getLogger } from '../core/logger.js';

const logger = getLogger('advanced-readability');

export interface AvailableReadabilityMetrics {
	availability: 'available';
	// Core readability scores
	fleschReadingEase: number;
	fleschKincaidGrade: number;
	smogIndex: number | null;
	smogAvailable: boolean;
	colemanLiauIndex: number;
	automatedReadabilityIndex: number;
	gunningFogIndex: number;
	linsearWriteFormula: null;

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

export type UnavailableReadabilityMetrics = {
	[
		Key in keyof Omit<
			AvailableReadabilityMetrics,
			'availability' | 'readingLevel' | 'comprehensionDifficulty'
		>
	]: AvailableReadabilityMetrics[Key] extends number
		? number | null
		: AvailableReadabilityMetrics[Key];
} & {
	availability: 'unavailable';
	reason: 'empty_text' | 'no_words' | 'analysis_failed';
	readingLevel: null;
	comprehensionDifficulty: 'unavailable';
};

export type ReadabilityMetrics = AvailableReadabilityMetrics | UnavailableReadabilityMetrics;

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
		easier: 'text1' | 'text2' | 'similar' | 'unavailable';
		keyDifferences: string[];
		recommendations: string[];
	};
}

export interface ReadabilityTrends {
	segments: Array<{
		position: number;
		fleschScore: number | null;
		avgSentenceLength: number | null;
		difficultWords: number | null;
	}>;
	overallTrend: 'improving' | 'declining' | 'stable' | 'unavailable';
	problematicSections: number[];
	recommendations?: string[];
}

export class AdvancedReadabilityService {
	private readingSpeedWPM = 200; // Average reading speed in words per minute

	calculateMetrics(text: string): ReadabilityMetrics {
		if (typeof text !== 'string') throw new TypeError('text must be a string');
		const characterCount = text.replace(/\s/g, '').length;
		try {
			const readability = computeReadability(text);
			const counts = {
				syllableCount: readability.syllableCount,
				lexiconCount: readability.wordCount,
				sentenceCount: readability.sentenceCount,
				characterCount,
				difficultWords: readability.polysyllableCount,
				readingTimeMinutes: Math.ceil(readability.wordCount / this.readingSpeedWPM),
			};
			if (readability.wordCount === 0 || readability.sentenceCount === 0)
				return this.getUnavailableMetrics(text.trim() ? 'no_words' : 'empty_text', counts);
			const comprehensionDifficulty = this.determineComprehensionDifficulty(
				readability.fleschEase
			);
			const metrics: AvailableReadabilityMetrics = {
				availability: 'available',
				...counts,
				fleschReadingEase: readability.fleschEase,
				fleschKincaidGrade: readability.fkgl,
				smogIndex: readability.smogAvailable ? readability.smog : null,
				smogAvailable: readability.smogAvailable,
				colemanLiauIndex: readability.colemanLiau,
				automatedReadabilityIndex: readability.ari,
				gunningFogIndex: readability.gunningFog,
				linsearWriteFormula: null,
				textStandard: this.determineTextStandard(readability.fkgl),
				averageSentenceLength: readability.wordCount / readability.sentenceCount,
				averageWordsPerSentence: readability.wordCount / readability.sentenceCount,
				averageSyllablesPerWord: readability.syllableCount / readability.wordCount,
				averageLettersPerWord: characterCount / readability.wordCount,
				daleChallReadabilityScore: readability.daleChall,
				gunningFog: readability.gunningFog,
				readingLevel: this.determineReadingLevel(readability.fkgl),
				comprehensionDifficulty,
				targetAudience: this.determineTargetAudience(
					readability.fkgl,
					comprehensionDifficulty
				),
				recommendations: [],
			};
			metrics.recommendations = this.generateRecommendations(metrics);
			return metrics;
		} catch (error) {
			logger.error('Failed to calculate readability metrics', { error });
			return this.getUnavailableMetrics('analysis_failed', { characterCount });
		}
	}

	async calculateMetricsBatch(texts: string[]): Promise<ReadabilityMetrics[]> {
		validateInput(
			{ texts },
			{ texts: { type: 'array', required: true, minLength: 1, maxLength: 1000 } }
		);
		return processBatch(
			texts,
			async (batch) => batch.map((text) => this.calculateMetrics(text)),
			20
		);
	}

	compareReadability(text1: string, text2: string): ComparativeAnalysis {
		const metrics1 = this.calculateMetrics(text1);
		const metrics2 = this.calculateMetrics(text2);

		if (metrics1.availability === 'unavailable' || metrics2.availability === 'unavailable')
			return {
				text1: metrics1,
				text2: metrics2,
				comparison: {
					easier: 'unavailable',
					keyDifferences: [],
					recommendations: [],
				},
			};

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

	analyzeReadabilityTrends(text: string, segmentCount: number = 10): ReadabilityTrends {
		if (!Number.isInteger(segmentCount) || segmentCount < 1 || segmentCount > 1000)
			throw new Error('segmentCount must be an integer from 1 to 1000');
		const segments = this.splitTextIntoSegments(text, segmentCount);
		const segmentMetrics = segments.map((segment, index) => {
			const metrics = this.calculateMetrics(segment);
			return {
				position: ((index + 1) / segments.length) * 100,
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
		if (metrics.availability === 'unavailable') return [];
		const targetGradeLevel = this.getTargetGradeLevel(targetAudience);
		const recommendations: ReadabilityRecommendation[] = [];

		if (metrics.fleschKincaidGrade > targetGradeLevel + 2) {
			recommendations.push({
				category: 'overall_structure',
				severity: 'high',
				issue: `Text is ${Math.round(metrics.fleschKincaidGrade - targetGradeLevel)} grade levels above target audience`,
				suggestion: 'Simplify sentence structure and use more common vocabulary',
				impact: 'Will make content more accessible to target readers',
			});
		}

		recommendations.push(...this.getAudienceSpecificSuggestions(metrics, targetAudience));

		return recommendations;
	}

	getContextualReadability(
		text: string,
		context: 'academic' | 'business' | 'creative' | 'technical' | 'marketing' | 'educational'
	): { score: number | null; contextAppropriateness: string; suggestions: string[] } {
		const metrics = this.calculateMetrics(text);
		if (metrics.availability === 'unavailable')
			return { score: null, contextAppropriateness: 'unavailable', suggestions: [] };
		const contextRanges = this.getContextualRanges(context);

		let score = 0;
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

		const appropriateness =
			score >= 90
				? 'excellent'
				: score >= 70
					? 'good'
					: score >= 50
						? 'fair'
						: 'needs_improvement';

		return { score, contextAppropriateness: appropriateness, suggestions };
	}

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

	private determineComprehensionDifficulty(
		fleschScore: number
	): AvailableReadabilityMetrics['comprehensionDifficulty'] {
		if (fleschScore >= 90) return 'very_easy';
		if (fleschScore >= 80) return 'easy';
		if (fleschScore >= 70) return 'fairly_easy';
		if (fleschScore >= 60) return 'standard';
		if (fleschScore >= 50) return 'fairly_difficult';
		if (fleschScore >= 30) return 'difficult';
		return 'very_difficult';
	}

	private determineTargetAudience(
		gradeLevel: number,
		difficulty: AvailableReadabilityMetrics['comprehensionDifficulty']
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

	private generateRecommendations(
		metrics: AvailableReadabilityMetrics
	): ReadabilityRecommendation[] {
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

	private getUnavailableMetrics(
		reason: UnavailableReadabilityMetrics['reason'],
		counts: Partial<
			Pick<
				AvailableReadabilityMetrics,
				| 'syllableCount'
				| 'lexiconCount'
				| 'sentenceCount'
				| 'characterCount'
				| 'difficultWords'
				| 'readingTimeMinutes'
			>
		> = {}
	): UnavailableReadabilityMetrics {
		return {
			availability: 'unavailable',
			reason,
			fleschReadingEase: null,
			fleschKincaidGrade: null,
			smogIndex: null,
			smogAvailable: false,
			colemanLiauIndex: null,
			automatedReadabilityIndex: null,
			gunningFogIndex: null,
			linsearWriteFormula: null,
			textStandard: 'unavailable',
			syllableCount: counts.syllableCount ?? null,
			lexiconCount: counts.lexiconCount ?? null,
			sentenceCount: counts.sentenceCount ?? null,
			characterCount: counts.characterCount ?? null,
			difficultWords: counts.difficultWords ?? null,
			readingTimeMinutes: counts.readingTimeMinutes ?? null,
			averageSentenceLength: null,
			averageSyllablesPerWord: null,
			averageLettersPerWord: null,
			averageWordsPerSentence: null,
			daleChallReadabilityScore: null,
			gunningFog: null,
			readingLevel: null,
			comprehensionDifficulty: 'unavailable',
			targetAudience: 'unavailable',
			recommendations: [],
		};
	}

	private determineEasierText(
		metrics1: AvailableReadabilityMetrics,
		metrics2: AvailableReadabilityMetrics
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
		metrics1: AvailableReadabilityMetrics,
		metrics2: AvailableReadabilityMetrics
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

	private generateComparativeRecommendations(
		metrics1: AvailableReadabilityMetrics,
		metrics2: AvailableReadabilityMetrics
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

	private splitTextIntoSegments(text: string, segmentCount: number): string[] {
		const sentences = splitIntoSentences(text);
		const count = Math.min(sentences.length, segmentCount);
		return Array.from({ length: count }, (_, index) =>
			sentences
				.slice(
					Math.floor((index * sentences.length) / count),
					Math.floor(((index + 1) * sentences.length) / count)
				)
				.join(' ')
		);
	}

	private determineTrend(
		segments: ReadabilityTrends['segments']
	): ReadabilityTrends['overallTrend'] {
		const measured = segments.filter(
			(segment): segment is typeof segment & { fleschScore: number } =>
				segment.fleschScore !== null
		);
		if (measured.length !== segments.length || measured.length < 3) return 'unavailable';

		const firstThird = measured.slice(0, Math.floor(measured.length / 3));
		const lastThird = measured.slice(-Math.floor(measured.length / 3));

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
		const measured = segments.flatMap((segment, index) =>
			segment.fleschScore === null ? [] : [{ index, score: segment.fleschScore }]
		);
		if (measured.length < 2) return [];
		const averageScore =
			measured.reduce((sum, segment) => sum + segment.score, 0) / measured.length;
		const threshold = averageScore - 10; // 10 points below average

		return measured.filter((s) => s.score < threshold).map((s) => s.index + 1); // Convert to 1-based indexing
	}

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

	private getAudienceSpecificSuggestions(
		metrics: AvailableReadabilityMetrics,
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
