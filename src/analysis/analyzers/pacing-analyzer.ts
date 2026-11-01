import { splitIntoSentences } from '../../utils/text-metrics.js';
import {
	aggregatePacing,
	analyzePacing,
	computeReadability,
	explainPacing,
	extractDialogue,
} from 'narrative-lens';
import { getLogger } from '../../core/logger.js';

export interface PacingAnalysis {
	overall: 'slow' | 'moderate' | 'fast' | 'variable' | 'unavailable';
	sections: { start: number; end: number; pace: 'slow' | 'moderate' | 'fast' }[];
	actionVsReflection: number | null; // ratio
	recommendedAdjustments: string[];
}

const logger = getLogger('pacing-analyzer');

export class PacingAnalyzer {
	async analyzePacing(content: string): Promise<PacingAnalysis> {
		try {
			if (!content || content.trim().length === 0) {
				return this.getDefaultPacingAnalysis();
			}

			// Optimized sentence parsing
			const sentences = splitIntoSentences(content);

			// Early exit for very small content
			if (sentences.length < 3) {
				return this.getDefaultPacingAnalysis();
			}

			const segmentCount = Math.min(3, Math.max(1, Math.floor(sentences.length / 5)));
			const segmentSize = Math.ceil(sentences.length / segmentCount);
			const metrics = Array.from({ length: segmentCount }, (_, index) => {
				const segment = sentences
					.slice(index * segmentSize, (index + 1) * segmentSize)
					.join(' ');
				const readability = computeReadability(segment);
				const dialogueWords = extractDialogue(segment, index, []).reduce(
					(sum, line) => sum + computeReadability(line.quote).wordCount,
					0
				);
				return analyzePacing(
					index,
					dialogueWords,
					readability.wordCount,
					readability.sentenceCount
				);
			});
			const aggregate = aggregatePacing(metrics);
			if (!aggregate) return this.getDefaultPacingAnalysis();
			const sections = aggregate.perSceneLabel.map((label, index) => ({
				start: ((index * segmentSize) / sentences.length) * 100,
				end:
					(Math.min((index + 1) * segmentSize, sentences.length) / sentences.length) *
					100,
				pace: this.adaptLabel(label),
			}));
			const overall = sections.every((section) => section.pace === sections[0].pace)
				? sections[0].pace
				: 'variable';

			// Optimized action vs reflection analysis with regex patterns
			const lowerContent = content.toLowerCase();
			const actionPattern =
				/\b(ran|jumped|grabbed|pushed|pulled|struck|moved|rushed|charged|attacked|defended|fought)\w*/g;
			const reflectionPattern =
				/\b(felt|thought|knew|realized|understood|believed|remembered|considered|pondered|reflected)\w*/g;

			const actionMatches = (lowerContent.match(actionPattern) || []).length;
			const reflectionMatches = (lowerContent.match(reflectionPattern) || []).length;
			const actionVsReflection = reflectionMatches ? actionMatches / reflectionMatches : null;

			// Smart recommendations based on analysis
			const recommendedAdjustments = metrics.flatMap((metric) => {
				const finding = explainPacing(
					metric.velocity,
					metric.sceneId,
					metric.isTalkingHead,
					metric.dialogueRatio
				);
				return finding?.suggestion ? [finding.suggestion] : [];
			});
			if (
				actionVsReflection !== null &&
				actionVsReflection < 0.3 &&
				reflectionMatches > actionMatches * 2
			) {
				recommendedAdjustments.push('Add more action sequences to balance reflection');
			}
			if (sections.length > 1 && sections.every((s) => s.pace === sections[0].pace)) {
				recommendedAdjustments.push('Vary pacing between sections for better rhythm');
			}

			return {
				overall: overall as 'slow' | 'moderate' | 'fast' | 'variable',
				sections: sections.slice(0, 5), // Limit for memory
				actionVsReflection,
				recommendedAdjustments: recommendedAdjustments.slice(0, 5), // Limit for memory
			};
		} catch (error) {
			logger.warn('Pacing analysis failed, using default', { error });
			return this.getDefaultPacingAnalysis();
		}
	}

	private adaptLabel(label: string): 'slow' | 'moderate' | 'fast' {
		if (label === 'slow' || label === 'very_slow') return 'slow';
		if (label === 'fast') return 'fast';
		if (label === 'good') return 'moderate';
		throw new Error('Unknown native pacing label');
	}

	getDefaultPacingAnalysis(): PacingAnalysis {
		return {
			overall: 'unavailable',
			sections: [],
			actionVsReflection: null,
			recommendedAdjustments: [],
		};
	}
}
