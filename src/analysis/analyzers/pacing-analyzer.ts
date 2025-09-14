import { getLogger } from '../../core/logger.js';

export interface PacingAnalysis {
	overall: 'slow' | 'moderate' | 'fast' | 'variable';
	sections: { start: number; end: number; pace: 'slow' | 'moderate' | 'fast' }[];
	actionVsReflection: number; // ratio
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
			const sentences = content.split(/[.!?]+/).filter((s) => s.trim().length > 0);

			// Early exit for very small content
			if (sentences.length < 3) {
				return this.getDefaultPacingAnalysis();
			}

			// Analyze sentence lengths for pacing with optimized calculation
			const sentenceLengths = sentences.map((s) => {
				const wordCount = s.trim().split(/\s+/).length;
				return Math.max(wordCount, 1); // Ensure minimum length of 1
			});

			const totalWords = sentenceLengths.reduce((a, b) => a + b, 0);
			const avgLength = totalWords / sentenceLengths.length;

			// Determine overall pacing with safer bounds
			const overall =
				avgLength < 10
					? 'fast'
					: avgLength < 15
						? 'moderate'
						: avgLength < 20
							? 'moderate'
							: 'slow';

			// Analyze sections with dynamic segment count
			const segmentCount = Math.min(3, Math.max(1, Math.floor(sentences.length / 5)));
			const sections = this.splitIntoSegments(content, segmentCount).map((segment, index) => {
				const segmentSentences = segment.split(/[.!?]+/).filter((s) => s.trim().length > 0);

				if (segmentSentences.length === 0) {
					return {
						start: index * (100 / segmentCount),
						end: (index + 1) * (100 / segmentCount),
						pace: 'moderate' as const,
					};
				}

				const segmentLengths = segmentSentences.map((s) => s.trim().split(/\s+/).length);
				const segmentAvg =
					segmentLengths.reduce((a, b) => a + b, 0) / segmentLengths.length;

				return {
					start: index * (100 / segmentCount),
					end: (index + 1) * (100 / segmentCount),
					pace:
						segmentAvg < 10
							? ('fast' as const)
							: segmentAvg < 20
								? ('moderate' as const)
								: ('slow' as const),
				};
			});

			// Optimized action vs reflection analysis with regex patterns
			const lowerContent = content.toLowerCase();
			const actionPattern =
				/\b(ran|jumped|grabbed|pushed|pulled|struck|moved|rushed|charged|attacked|defended|fought)\w*/g;
			const reflectionPattern =
				/\b(felt|thought|knew|realized|understood|believed|remembered|considered|pondered|reflected)\w*/g;

			const actionMatches = (lowerContent.match(actionPattern) || []).length;
			const reflectionMatches = (lowerContent.match(reflectionPattern) || []).length;
			const actionVsReflection = actionMatches / Math.max(reflectionMatches, 1);

			// Smart recommendations based on analysis
			const recommendedAdjustments: string[] = [];
			if (overall === 'slow' && avgLength > 25) {
				recommendedAdjustments.push(
					'Consider shortening sentences and paragraphs to increase pace'
				);
			}
			if (actionVsReflection < 0.3 && reflectionMatches > actionMatches * 2) {
				recommendedAdjustments.push('Add more action sequences to balance reflection');
			}
			if (sections.length > 1 && sections.every((s) => s.pace === sections[0].pace)) {
				recommendedAdjustments.push('Vary pacing between sections for better rhythm');
			}

			return {
				overall: overall as 'slow' | 'moderate' | 'fast' | 'variable',
				sections: sections.slice(0, 5), // Limit for memory
				actionVsReflection: Math.min(Math.max(actionVsReflection, 0), 10),
				recommendedAdjustments: recommendedAdjustments.slice(0, 5), // Limit for memory
			};
		} catch (error) {
			logger.warn('Pacing analysis failed, using default', { error });
			return this.getDefaultPacingAnalysis();
		}
	}

	private splitIntoSegments(content: string, count: number): string[] {
		const segmentLength = Math.ceil(content.length / count);
		const segments: string[] = [];

		for (let i = 0; i < count; i++) {
			segments.push(content.slice(i * segmentLength, (i + 1) * segmentLength));
		}

		return segments;
	}

	private getDefaultPacingAnalysis(): PacingAnalysis {
		return {
			overall: 'moderate',
			sections: [],
			actionVsReflection: 1.0,
			recommendedAdjustments: [],
		};
	}
}