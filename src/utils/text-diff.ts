/**
 * Dependency-free paragraph-level diff. Splits two plain-text bodies into
 * paragraphs and reports which paragraphs were added or removed, using a
 * longest-common-subsequence (LCS) alignment so that unchanged paragraphs
 * between edits are not reported as churn. Intended for comparing a Scrivener
 * snapshot against the current document (or another snapshot).
 */

export interface ParagraphDiff {
	/** Paragraphs present in the new text but not aligned to the old text. */
	added: string[];
	/** Paragraphs present in the old text but not aligned to the new text. */
	removed: string[];
	/** Count of paragraphs common to both (the LCS length). */
	unchanged: number;
}

/** Split text into non-empty, trimmed paragraphs (blank-line or newline separated). */
export function splitParagraphs(text: string): string[] {
	return text
		.split(/\n+/)
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
}

/**
 * Diff two plain-text bodies at paragraph granularity. O(n·m) in paragraph
 * counts, which is bounded for real documents; identical input yields empty
 * added/removed.
 */
export function diffParagraphs(before: string, after: string): ParagraphDiff {
	const a = splitParagraphs(before);
	const b = splitParagraphs(after);

	// LCS table: lcs[i][j] = length of the longest common subsequence of a[i:] / b[j:].
	const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
		new Array<number>(b.length + 1).fill(0)
	);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			lcs[i][j] =
				a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}

	const added: string[] = [];
	const removed: string[] = [];
	let unchanged = 0;
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			unchanged++;
			i++;
			j++;
		} else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
			removed.push(a[i++]);
		} else {
			added.push(b[j++]);
		}
	}
	while (i < a.length) removed.push(a[i++]);
	while (j < b.length) added.push(b[j++]);

	return { added, removed, unchanged };
}

/**
 * Word-level change counts between two texts, via an LCS over whitespace-split
 * tokens. Reports how many words were added and removed (a within-paragraph edit
 * of one word counts as 1 and 1, not a whole paragraph). O(n·m) in token counts.
 */
export function diffWordCounts(before: string, after: string): { added: number; removed: number } {
	const a = before.split(/\s+/).filter(Boolean);
	const b = after.split(/\s+/).filter(Boolean);
	const m = a.length;
	const n = b.length;
	// Rolling two-row LCS length table to keep memory O(n) for large documents.
	let prev = new Array<number>(n + 1).fill(0);
	for (let x = m - 1; x >= 0; x--) {
		const cur = new Array<number>(n + 1).fill(0);
		for (let y = n - 1; y >= 0; y--) {
			cur[y] = a[x] === b[y] ? prev[y + 1] + 1 : Math.max(prev[y], cur[y + 1]);
		}
		prev = cur;
	}
	const common = prev[0];
	return { added: n - common, removed: m - common };
}
