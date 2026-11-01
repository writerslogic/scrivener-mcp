import { analyzeOpeningChecked } from 'narrative-lens';

export interface StructureAnalysis {
	sceneBreaks: number | null;
	chapters: number | null;
	averageSceneLength: number | null;
	openingStrength: 'weak' | 'moderate' | 'strong' | 'unassessed';
	openingEvidence?: ReturnType<typeof analyzeOpeningChecked>;
	endingStrength: 'weak' | 'moderate' | 'strong' | 'unavailable';
	hookPresence: boolean | null;
	cliffhangers: number | null;
}

export class StructureAnalyzer {
	analyzeStructure(content: string): StructureAnalysis {
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

		const openingEvidence = analyzeOpeningChecked(firstParagraph, 'general');
		const openingStrength = 'unassessed' as const;
		const endingStrength = this.assessEndingStrength(lastParagraph);

		const hookPresence = openingEvidence.hookType !== null;
		const cliffhangers = this.countCliffhangers(paragraphs);

		return {
			sceneBreaks,
			chapters,
			averageSceneLength,
			openingStrength,
			openingEvidence,
			endingStrength,
			hookPresence,
			cliffhangers,
		};
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

	private countCliffhangers(paragraphs: string[]): number {
		return paragraphs.filter((p) => {
			if (!p.trim()) return false;

			if (p.trim().endsWith('?')) return true;

			const lastSentence = p.split(/[.!?]/).pop()?.trim() || '';
			return /\b(but|however|suddenly|then)\b/i.test(lastSentence);
		}).length;
	}
}
