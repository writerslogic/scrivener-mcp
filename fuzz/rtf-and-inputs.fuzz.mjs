import { scanRawText, describeReplacedConstructs, spliceRtfText } from '../dist/services/parsers/rtf-splice.js';
import { parseModelJson } from '../dist/utils/json-parse.js';
import { escapeRegExp } from '../dist/utils/regex.js';

const MAX_INPUT_BYTES = 64 * 1024;

/**
 * Jazzer.js fuzz target for the untrusted text parsers used by the MCP server.
 * OSS-Fuzz supplies arbitrary buffers and treats uncaught exceptions, hangs,
 * and native crashes as findings.
 *
 * @param {Buffer} data
 */
export function fuzz(data) {
	const bounded = data.subarray(0, MAX_INPUT_BYTES);
	const input = bounded.toString('utf8');

	const scan = scanRawText(input);
	describeReplacedConstructs(input);
	parseModelJson(input);

	// Exercise literal-regex construction with arbitrary Unicode input.
	const literal = input.slice(0, 4096);
	new RegExp(escapeRegExp(literal), 'u').test(literal);

	// Exercise the fidelity-preserving RTF splicer only when the scanner found
	// canonical text. Mutating the text forces both matching and replacement paths.
	if (scan.text.length > 0) {
		const midpoint = Math.floor(scan.text.length / 2);
		const replacement = `${scan.text.slice(0, midpoint)}${literal.slice(0, 64)}`;
		spliceRtfText(input, scan.text, replacement);
	}
}
