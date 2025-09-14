import { getLogger } from '../../core/logger.js';
import { splitIntoSentences } from '../../utils/text-metrics.js';

export interface EmotionalAnalysis {
	dominantEmotion: string;
	emotionalArc: { position: number; emotion: string; intensity: number }[];
	tensionLevel: number; // 0-100
	moodConsistency: number; // 0-100
}

const logger = getLogger('emotion-analyzer');

export class EmotionAnalyzer {
	async analyzeEmotions(content: string): Promise<EmotionalAnalysis> {
		try {
			if (!content || content.trim().length === 0) {
				return this.getDefaultEmotionalAnalysis();
			}

			// Optimize word processing with regex patterns
			const lowerContent = content.toLowerCase();
			const words = lowerContent.split(/\s+/).filter((w) => w.length > 2);

			// Early exit for very small content
			if (words.length < 10) {
				return this.getDefaultEmotionalAnalysis();
			}

			// Use regex patterns for faster emotion detection
			const emotionPatterns = {
				joy: /\b(happ|joy|cheer|delight|pleas|excit|glad|elat)\w*/g,
				sadness: /\b(sad|depress|grief|sorrow|melanchol|miser|despair)\w*/g,
				anger: /\b(ang|fur|rage|mad|irrit|annoy|hostil)\w*/g,
				fear: /\b(afraid|scar|terror|anxi|worr|nerv|dread)\w*/g,
				surprise: /\b(surpris|shock|amaz|astonish|stun)\w*/g,
				disgust: /\b(disgust|revol|repuls|sicken)\w*/g,
			};

			const emotionCounts: Record<string, number> = {};
			for (const [emotion, pattern] of Object.entries(emotionPatterns)) {
				const matches = lowerContent.match(pattern) || [];
				emotionCounts[emotion] = matches.length;
			}

			const dominantEmotion =
				Object.entries(emotionCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'neutral';

			// Simplified emotional arc for performance
			const segmentCount = Math.min(5, Math.max(2, Math.floor(content.length / 1000)));
			const segments = this.splitIntoSegments(content, segmentCount);
			const emotionalArc = segments.map((segment, index) => {
				const segmentEmotions = this.detectSegmentEmotion(segment);
				return {
					position: (index + 1) / segments.length,
					emotion: segmentEmotions.emotion,
					intensity: Math.min(segmentEmotions.intensity, 100),
				};
			});

			// Optimized tension level calculation
			const tensionPattern =
				/\b(fight|battle|conflict|struggle|tension|pressure|clash|dispute|argument)\w*/g;
			const tensionMatches = (lowerContent.match(tensionPattern) || []).length;
			const sentenceCount = Math.max(splitIntoSentences(content).length, 1);
			const tensionLevel = Math.min((tensionMatches / sentenceCount) * 100, 100);

			return {
				dominantEmotion,
				emotionalArc: emotionalArc.slice(0, 10), // Limit for memory
				tensionLevel: Math.max(0, tensionLevel),
				moodConsistency: 75, // Simplified for performance
			};
		} catch (error) {
			logger.warn('Emotion analysis failed, using default', { error });
			return this.getDefaultEmotionalAnalysis();
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

	private getDefaultEmotionalAnalysis(): EmotionalAnalysis {
		return {
			dominantEmotion: 'neutral',
			emotionalArc: [],
			tensionLevel: 50,
			moodConsistency: 75,
		};
	}
}