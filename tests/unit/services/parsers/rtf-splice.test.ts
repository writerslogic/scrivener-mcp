/**
 * Locks the fidelity-preserving RTF splice: the raw-text scan must reproduce the
 * reader's plain text (so the offset map is trustworthy), a no-op edit must be
 * byte-identical, and a real edit must preserve every surrounding byte while the
 * result re-parses to exactly the intended text.
 */

import { RTFHandler } from '../../../../src/services/parsers/rtf-handler.js';
import {
	scanRawText,
	spliceRtfText,
	describeReplacedConstructs,
} from '../../../../src/services/parsers/rtf-splice.js';

const handler = new RTFHandler();

// A document exercising a stylesheet, a named style ref, an ignorable destination,
// bold, and an embedded footnote group — the things a regenerate would destroy.
const RICH_RTF =
	`{\\rtf1\\ansi\\deff0` +
	`{\\fonttbl\\f0 Times;}` +
	`{\\colortbl;\\red0\\green0\\blue0;}` +
	`{\\*\\expandedcolortbl;;}` +
	`{\\stylesheet{\\s1 Heading;}}` +
	`\\pard\\s1\\f0\\fs24 The quick brown fox.\\par` +
	`Second {\\b bold} paragraph{\\Scrv_fn\\id1 a footnote\\Scrv_fn_end} here.}`;

async function canonical(raw: string): Promise<string> {
	return (await handler.parseRTF(raw)).plainText.trim();
}

describe('scanRawText parity', () => {
	it('reproduces the reader plain text exactly', async () => {
		expect(scanRawText(RICH_RTF).text.trim()).toBe(await canonical(RICH_RTF));
	});
});

describe('spliceRtfText', () => {
	it('is byte-identical for a no-op edit', async () => {
		const c = await canonical(RICH_RTF);
		const out = spliceRtfText(RICH_RTF, c, c);
		expect(out).not.toBeNull();
		expect(out!.rtf).toBe(RICH_RTF);
	});

	it('preserves surrounding RTF and re-parses to the intended text', async () => {
		const c = await canonical(RICH_RTF);
		const edited = c.replace('quick brown fox', 'slow red dog');
		const out = spliceRtfText(RICH_RTF, c, edited);
		expect(out).not.toBeNull();
		// The result reads back as exactly the edit...
		expect((await handler.parseRTF(out!.rtf)).plainText.trim()).toBe(edited);
		// ...and the untouched structure survives byte-for-byte.
		expect(out!.rtf).toContain('{\\stylesheet{\\s1 Heading;}}');
		expect(out!.rtf).toContain('{\\*\\expandedcolortbl;;}');
		expect(out!.rtf).toContain('{\\Scrv_fn\\id1 a footnote\\Scrv_fn_end}');
		expect(out!.rtf).toContain('\\s1');
	});

	it('preserves the untouched region between two separate edits (multi-region)', async () => {
		const c = await canonical(RICH_RTF);
		// Edit the first sentence AND the last word, leaving the middle untouched.
		const edited = c.replace('quick brown fox', 'slow red dog').replace(/here\.$/, 'there.');
		const out = spliceRtfText(RICH_RTF, c, edited);
		expect(out).not.toBeNull();
		expect((await handler.parseRTF(out!.rtf)).plainText.trim()).toBe(edited);
		// The bold run and footnote sit BETWEEN the two edits and must survive verbatim —
		// a single prefix/suffix splice would have flattened them.
		expect(out!.rtf).toContain('{\\b bold}');
		expect(out!.rtf).toContain('{\\Scrv_fn\\id1 a footnote\\Scrv_fn_end}');
		// Only the two small changed spans are regenerated, not the whole middle.
		expect(out!.replacedRaw.length).toBeLessThan(RICH_RTF.length / 2);
	});

	it('returns null when the scan cannot reproduce the canonical text', () => {
		// canonical claims text the RTF does not contain -> unsafe to map -> bail.
		expect(spliceRtfText(RICH_RTF, 'text that is not in the document at all', 'x')).toBeNull();
	});
});

describe('describeReplacedConstructs', () => {
	it('names footnotes, images, and inline styling in a replaced span', () => {
		expect(describeReplacedConstructs('plain text only')).toEqual([]);
		expect(describeReplacedConstructs('a {\\Scrv_fn\\id1 note} b')).toContain('footnote');
		expect(describeReplacedConstructs('x {\\pict\\jpegblip ff} y')).toContain('inline image');
		expect(describeReplacedConstructs('some \\b bold text')).toContain(
			'inline styling within the edited text'
		);
	});
});
