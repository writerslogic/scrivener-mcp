import { RTF_TEXT_CONTROLS } from './rtf-handler.js';
import { isStructurallyValidRtf, readRtfControl, rtfGroupEnd } from './rtf-validation.js';

/** Header/table destinations that contribute no body text (mirrors the reader's strip). */
const SKIP_GROUP_KEYWORDS = [
	'\\fonttbl',
	'\\colortbl',
	'\\stylesheet',
	'\\listtable',
	'\\listoverridetable',
	'\\info',
	'\\*\\shppict',
	'\\pict',
];

/** Result of scanning raw RTF: the body plain text and, per character, its raw byte offset. */
interface ScanResult {
	text: string;
	/** offsets[k] = index in rawRtf where text[k] originates; offsets[text.length] = end. */
	offsets: number[];
	ends: number[];
}

/** Does rawRtf, at index i, begin one of the skip-group destinations? Returns the keyword length matched. */
function matchSkipGroup(raw: string, i: number): number {
	if (raw[i] !== '{') return 0;
	for (const kw of SKIP_GROUP_KEYWORDS) {
		if (raw.startsWith(kw, i + 1)) return kw.length;
	}
	return 0;
}

/** Skip a brace-balanced group starting at `i` (which is `{`). Returns index past the `}`. */
function skipGroup(raw: string, i: number): number {
	const end = rtfGroupEnd(raw, i);
	if (end === undefined) throw new Error('RTF contains an invalid opaque group');
	return end;
}

/**
 * Scan raw RTF into body plain text plus a per-character raw-offset map, mirroring
 * the reader's decoding (control words, `\uc`/`\u`, `\'hh`, escaped chars, group
 * skipping). Deliberately best-effort: the caller checks it against the canonical
 * parser and bails on any mismatch.
 */
export function scanRawText(raw: string): ScanResult {
	const text: string[] = [];
	const offsets: number[] = [];
	const ends: number[] = [];
	let uc = 1;
	const ucStack: number[] = [];
	let i = 0;

	// Skip the leading "{\rtf1..." declaration up to the first control-word boundary,
	// matching the reader, without consuming body braces.
	const decl = raw.match(/^\{\\rtf\d+ ?/);
	if (decl) i = decl[0].length;

	const push = (ch: string, at: number, end: number) => {
		for (let index = 0; index < ch.length; index++) {
			text.push(ch[index]);
			offsets.push(at);
			ends.push(end);
		}
	};

	while (i < raw.length) {
		const ch = raw[i];

		// Drop ignorable destinations ({\*\...}), Scrivener control groups, and
		// header/table/image destinations entirely — matching the reader's strip.
		if (ch === '{') {
			if (
				raw.startsWith('{\\*', i) ||
				raw.startsWith('{\\Scrv_', i) ||
				matchSkipGroup(raw, i) > 0
			) {
				i = skipGroup(raw, i);
				continue;
			}
			ucStack.push(uc);
			i++; // ordinary group-start: inherits style, contributes no text itself
			continue;
		}
		if (ch === '}') {
			uc = ucStack.pop() ?? 1;
			i++;
			continue;
		}

		if (ch === '\\') {
			const start = i;
			const control = raw.slice(i).match(/^\\([a-z]+)(-?\d*)\s?/i);
			if (control) {
				const word = control[1].toLowerCase();
				const param = control[2];
				if (word === 'par' || word === 'line' || word === 'sect') {
					i += control[0].length;
					push('\n', start, i);
				} else if (RTF_TEXT_CONTROLS.has(`\\${word}`)) {
					i += control[0].length;
					push(RTF_TEXT_CONTROLS.get(`\\${word}`)!, start, i);
				} else if (word === 'bin') {
					const binary = readRtfControl(raw, i);
					if (!binary) throw new Error('Invalid RTF binary data');
					i = binary.end;
				} else if (word === 'uc') {
					const n = parseInt(param, 10);
					uc = Number.isNaN(n) ? 1 : Math.max(0, n);
					i += control[0].length;
				} else if (word === 'u' && param) {
					let code = parseInt(param, 10);
					if (code < 0) code += 65536;
					i += control[0].length;
					for (let skipped = 0; skipped < uc && i < raw.length; skipped++) {
						if (raw[i] === '{' || raw[i] === '}') break;
						if (raw[i] === '\\' && raw[i + 1] === "'") i += 4;
						else if (raw[i] === '\\') break;
						else i++;
					}
					push(String.fromCodePoint(code), start, i);
				} else {
					i += control[0].length; // formatting/other control word: no text
				}
			} else if (raw[i + 1] === "'") {
				push(String.fromCharCode(parseInt(raw.slice(i + 2, i + 4), 16)), i, i + 4);
				i += 4;
			} else if (raw[i + 1] === '\\' || raw[i + 1] === '{' || raw[i + 1] === '}') {
				push(raw[i + 1], i, i + 2);
				i += 2;
			} else {
				// Lone backslash (Cocoa line-wrap): the reader skips it and keeps the
				// following newline as text, which we mirror.
				i++;
			}
		} else {
			push(ch, i, i + 1);
			i++;
		}
	}

	offsets.push(raw.length);
	return { text: text.join(''), offsets, ends };
}

/**
 * Inspect the raw RTF span an edit replaced and name any non-round-trippable
 * constructs it contained (so the caller can warn and snapshot). Empty when the
 * span was plain prose — a clean, fully-preserving edit.
 */
export function describeReplacedConstructs(replacedRaw: string): string[] {
	const risks: string[] = [];
	if (/\\Scrv_fn\b/.test(replacedRaw)) risks.push('footnote');
	if (/\\Scrv_(annot|comm|inl)\b/.test(replacedRaw)) risks.push('annotation/comment');
	if (/\\pict\b|\\shppict\b|\\NeXTGraphic\b/.test(replacedRaw)) risks.push('inline image');
	if (/\\field\b/.test(replacedRaw)) risks.push('linked field');
	if (/\\bin-?\d+\b/i.test(replacedRaw)) risks.push('embedded binary data');
	if (/\{\\\*|\\Scrv_/.test(replacedRaw)) risks.push('opaque RTF metadata within the edited text');
	// Inline formatting toggles inside the replaced text can't survive a text edit.
	if (/\\(?:b|i|ul|strike|cf|cs|s|highlight)(?:-?\d+)?(?=[^a-z]|$)/i.test(replacedRaw)) {
		risks.push('inline styling within the edited text');
	}
	return risks;
}

/** Escape a run of plain text for inclusion in RTF, encoding non-ASCII as `\uN` (fallback-free). */
function escapeInline(text: string): string {
	let out = '';
	for (let index = 0; index < text.length; index++) {
		const ch = text[index];
		const code = text.charCodeAt(index);
		if (ch === '\\') out += '\\\\';
		else if (ch === '{') out += '\\{';
		else if (ch === '}') out += '\\}';
		else if (ch === '\n') out += '\\par\n';
		else if (ch === '\t') out += '\\tab ';
		else if (code < 128) out += ch;
		else out += `\\u${code > 32767 ? code - 65536 : code} `;
	}
	return out;
}

function tokenize(text: string): string[] {
	return text.match(/\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]+/gu) ?? [];
}

function safeReplacementSpan(raw: string, start: number, end: number): boolean {
	for (let offset = start; offset < end;) {
		if (raw[offset] === '{') {
			const groupEnd = rtfGroupEnd(raw, offset);
			if (groupEnd === undefined || groupEnd > end) return false;
			offset = groupEnd;
		} else if (raw[offset] === '}') return false;
		else if (raw[offset] === '\\') {
			const control = readRtfControl(raw, offset);
			if (
				!control || control.end > end ||
				control.word !== undefined && control.word !== 'u' &&
				!RTF_TEXT_CONTROLS.has(`\\${control.word}`) && control.word !== 'sect'
			)
				return false;
			offset = control.end;
		} else offset++;
	}
	return true;
}

interface MatchBlock {
	a: number; // token index in old
	b: number; // token index in new
	size: number; // matched token count
}

/**
 * Longest matching blocks between two token sequences (difflib's SequenceMatcher
 * algorithm, without junk heuristics so preservation is maximized). Returns blocks
 * in order, terminated by a zero-size sentinel at (a.length, b.length).
 */
function matchingBlocks(a: string[], b: string[]): MatchBlock[] {
	const b2j = new Map<string, number[]>();
	for (let j = 0; j < b.length; j++) {
		const list = b2j.get(b[j]);
		if (list) list.push(j);
		else b2j.set(b[j], [j]);
	}

	const findLongest = (alo: number, ahi: number, blo: number, bhi: number): MatchBlock => {
		let besti = alo;
		let bestj = blo;
		let bestsize = 0;
		let j2len = new Map<number, number>();
		for (let i = alo; i < ahi; i++) {
			const newj2len = new Map<number, number>();
			const js = b2j.get(a[i]);
			if (js) {
				for (const j of js) {
					if (j < blo) continue;
					if (j >= bhi) break;
					const k = (j2len.get(j - 1) ?? 0) + 1;
					newj2len.set(j, k);
					if (k > bestsize) {
						besti = i - k + 1;
						bestj = j - k + 1;
						bestsize = k;
					}
				}
			}
			j2len = newj2len;
		}
		return { a: besti, b: bestj, size: bestsize };
	};

	const blocks: MatchBlock[] = [];
	const queue: Array<[number, number, number, number]> = [[0, a.length, 0, b.length]];
	while (queue.length) {
		const [alo, ahi, blo, bhi] = queue.pop() as [number, number, number, number];
		const m = findLongest(alo, ahi, blo, bhi);
		if (m.size > 0) {
			blocks.push(m);
			if (alo < m.a && blo < m.b) queue.push([alo, m.a, blo, m.b]);
			if (m.a + m.size < ahi && m.b + m.size < bhi)
				queue.push([m.a + m.size, ahi, m.b + m.size, bhi]);
		}
	}
	blocks.sort((x, y) => x.a - y.a || x.b - y.b);
	blocks.push({ a: a.length, b: b.length, size: 0 });
	return blocks;
}

/** Guard against pathological O(n·m) diffs on very large documents. */
const MAX_DIFF_TOKENS = 60_000;

/**
 * Produce a new RTF equal to `originalRaw` with its text changed to `newText`,
 * preserving EVERY unchanged region byte-for-byte — not just the head and tail.
 * A token-level diff finds all unchanged spans; each is emitted from the original
 * raw bytes (keeping interleaved styles/images/footnotes), and only the changed
 * gaps are re-encoded. Returns null when the edit can't be safely mapped (scan/
 * canonical mismatch, empty text, or an oversized diff) — the caller falls back.
 * `replacedRaw` is the concatenation of the original raw spans that were replaced,
 * for fidelity reporting.
 */
export function spliceRtfText(
	originalRaw: string,
	canonicalPlainText: string,
	newText: string
): { rtf: string; replacedRaw: string } | null {
	if (!isStructurallyValidRtf(originalRaw)) return null;
	const scan = scanRawText(originalRaw);

	// Align the trimmed canonical text within the (untrimmed) scan so offsets map
	// canonical positions to raw bytes. Bail unless the scan reproduces canonical
	// exactly — that equivalence is what makes the offset map trustworthy.
	const lead = scan.text.length - scan.text.trimStart().length;
	if (scan.text.trim() !== canonicalPlainText) return null;
	if (canonicalPlainText.length === 0) return null;

	const rawStartOf = (canonicalIndex: number): number =>
		canonicalIndex === canonicalPlainText.length
			? scan.ends[lead + canonicalIndex - 1]
			: scan.offsets[lead + canonicalIndex];

	const oldTokens = tokenize(canonicalPlainText);
	const newTokens = tokenize(newText);
	if (oldTokens.length > MAX_DIFF_TOKENS || newTokens.length > MAX_DIFF_TOKENS) return null;

	// Cumulative character offsets per token, so token indices map to char ranges.
	const cum = (tokens: string[]): number[] => {
		const c = [0];
		for (let i = 0; i < tokens.length; i++) c.push(c[i] + tokens[i].length);
		return c;
	};
	const oldCum = cum(oldTokens);
	const newCum = cum(newTokens);

	const wrap = (text: string): string => (text.length > 0 ? `{\\uc0 ${escapeInline(text)}}` : '');

	const out: string[] = [];
	const replaced: string[] = [];
	let rawCursor = 0;
	let prevOldChar = 0;
	let prevNewChar = 0;

	for (const block of matchingBlocks(oldTokens, newTokens)) {
		const blockOldChar = oldCum[block.a];
		const blockNewChar = newCum[block.b];

		if (blockOldChar > prevOldChar || blockNewChar > prevNewChar) {
			const start = rawStartOf(prevOldChar);
			const end = blockOldChar > prevOldChar ? scan.ends[lead + blockOldChar - 1] : start;
			if (!safeReplacementSpan(originalRaw, start, end)) return null;
			out.push(originalRaw.slice(rawCursor, start), wrap(newText.slice(prevNewChar, blockNewChar)));
			replaced.push(originalRaw.slice(start, end));
			rawCursor = end;
		}

		if (block.size > 0) {
			const matchEndChar = oldCum[block.a + block.size];
			prevOldChar = matchEndChar;
			prevNewChar = newCum[block.b + block.size];
		}
	}

	out.push(originalRaw.slice(rawCursor));
	const rtf = out.join('');
	return isStructurallyValidRtf(rtf) ? { rtf, replacedRaw: replaced.join('') } : null;
}
