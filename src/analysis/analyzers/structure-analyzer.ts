export interface StructureAnalysis {
	sceneBreaks: number;
	chapters: number;
	averageSceneLength: number;
	openingStrength: 'weak' | 'moderate' | 'strong';
	endingStrength: 'weak' | 'moderate' | 'strong';
	hookPresence: boolean;
	cliffhangers: number;
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
}