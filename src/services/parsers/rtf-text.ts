import { readRtfControl, rtfGroupEnd } from './rtf-validation.js';

export const RTF_TEXT_CONTROLS: ReadonlyMap<string, string> = new Map([
	['\\ldblquote', '“'],
	['\\rdblquote', '”'],
	['\\lquote', '‘'],
	['\\rquote', '’'],
	['\\endash', '–'],
	['\\emdash', '—'],
	['\\bullet', '•'],
	['\\tab', '\t'],
	['\\line', '\u2028'],
	['\\par', '\n'],
	['\\page', '\f'],
	['\\~', '\u00a0'],
	['\\_', '\u2011'],
	['\\-', '\u00ad'],
]);

interface RtfToken {
	type: 'text' | 'control' | 'group-start' | 'group-end';
	value: string;
	start: number;
	end: number;
}

interface TextState {
	uc: number;
	codepage: number;
	font?: number;
	inTable?: boolean;
	inInfo?: boolean;
	selectedMetadata?: boolean;
}

const DESTINATIONS = new Set([
	'fonttbl',
	'colortbl',
	'stylesheet',
	'listtable',
	'listoverridetable',
	'listtext',
	'pntext',
	'info',
	'pict',
]);
const cp1252 = new TextDecoder('windows-1252', { fatal: true });

export function assertRtfText(text: string): void {
	if (/[\uD800-\uDFFF]/u.test(text))
		throw new Error(
			'RTF text contains an unpaired Unicode surrogate; repair the text before writing'
		);
}

function decodeByte(byte: number, codepage: number): string {
	if (codepage === -2)
		throw new Error('Unsupported RTF Symbol font encoding; save as Unicode RTF');
	if (byte < 128) return String.fromCharCode(byte);
	if (codepage !== 1252)
		throw new Error(
			`Unsupported RTF byte encoding ${codepage}; save the document as Unicode RTF before reading or editing`
		);
	return cp1252.decode(Uint8Array.of(byte));
}

/** One decoded UTF-16 stream for reads, styles and raw edit offsets; no whitespace normalization. */
export function* rtfTextTokens(raw: string, metadataField?: string): Generator<RtfToken> {
	let state: TextState = { uc: 1, codepage: 1252 };
	const stack: TextState[] = [];
	const fonts = new Map<number, { codepage?: number; charset?: number }>();
	let defaultFont: number | undefined;
	const fontCodepage = (): number => {
		const font = fonts.get(state.font ?? defaultFont ?? -1);
		return (
			font?.codepage ??
			(font?.charset === undefined || font.charset === 0 || font.charset === 1
				? state.codepage
				: -font.charset)
		);
	};
	const isDocument = /^[\s\uFEFF]*\{\\rtf1\b/.test(raw);
	for (let i = raw[0] === '\uFEFF' ? 1 : 0; i < raw.length;) {
		const start = i;
		const ch = raw[i];
		if (ch === '{') {
			const control = readRtfControl(raw, i + 1);
			if (
				raw.startsWith('{\\*', i) ||
				raw.startsWith('{\\Scrv_', i) ||
				(DESTINATIONS.has(control?.word ?? '') &&
					!(metadataField && control?.word === 'info'))
			) {
				const end = rtfGroupEnd(raw, i);
				if (end === undefined) throw new Error('Invalid RTF destination group');
				if (control?.word === 'fonttbl') {
					let font: number | undefined;
					for (let at = control.end; at < end;) {
						if (raw[at] !== '\\') {
							at++;
							continue;
						}
						const entry = readRtfControl(raw, at);
						if (!entry) throw new Error('Invalid RTF font table');
						if (entry.word === 'f') {
							font = entry.parameter;
							if (font !== undefined) fonts.set(font, {});
						} else if (font !== undefined && entry.word === 'cpg') {
							if (entry.parameter === undefined || entry.parameter < 1)
								throw new Error('Invalid RTF font code page');
							fonts.set(font, { ...fonts.get(font), codepage: entry.parameter });
						} else if (font !== undefined && entry.word === 'fcharset') {
							if (
								entry.parameter === undefined ||
								entry.parameter < 0 ||
								entry.parameter > 255
							)
								throw new Error('Invalid RTF font character set');
							fonts.set(font, { ...fonts.get(font), charset: entry.parameter });
						}
						at = entry.end;
					}
				}
				i = end;
				continue;
			}
			stack.push({ ...state });
			if (control?.word === 'info') state.inInfo = true;
			if (metadataField && state.inInfo && control?.word === metadataField)
				state.selectedMetadata = true;
			i++;
			if (!metadataField || state.selectedMetadata)
				yield { type: 'group-start', value: ch, start, end: i };
			continue;
		}
		if (ch === '}') {
			const selected = state.selectedMetadata;
			state = stack.pop() ?? { uc: 1, codepage: 1252 };
			i++;
			if (!metadataField || selected) yield { type: 'group-end', value: ch, start, end: i };
			if (metadataField && selected && !state.selectedMetadata) return;
			continue;
		}
		if (ch === '\r' || ch === '\n') {
			i++;
			continue;
		}
		if (ch !== '\\') {
			if (isDocument && stack.length === 0 && /[ \t]/.test(ch)) {
				i++;
				continue;
			}
			if (ch.charCodeAt(0) > 127)
				throw new Error(
					'Unsupported unescaped non-ASCII RTF text; save as Unicode RTF with escaped characters before reading or editing'
				);
			if (fontCodepage() === -2)
				throw new Error('Unsupported RTF Symbol font encoding; save as Unicode RTF');
			i++;
			if (!metadataField || state.selectedMetadata)
				yield { type: 'text', value: ch, start, end: i };
			continue;
		}
		const control = readRtfControl(raw, i);
		if (!control) throw new Error('Invalid RTF control sequence');
		i = control.end;
		const { word, parameter } = control;
		if (
			word === 'sect' ||
			word === 'nestcell' ||
			word === 'nestrow' ||
			(word === 'itap' && (parameter ?? 0) > 1)
		)
			throw new Error(
				'Unsupported RTF section break or nested table; use separate documents or simple paragraphs before reading or editing'
			);
		if (word === 'intbl') state.inTable = parameter !== 0;
		else if (word === 'pard') state.inTable = false;
		if (word === 'upr')
			throw new Error(
				'Unsupported RTF alternate Unicode destination; save as Unicode-only RTF before reading or editing'
			);
		if (word === 'uc') {
			if (parameter === undefined || parameter < 0 || parameter > 32767)
				throw new Error('Invalid RTF Unicode fallback length');
			state.uc = parameter;
		} else if (word === 'ansicpg') {
			if (parameter === undefined || parameter < 1) throw new Error('Invalid RTF code page');
			state.codepage = parameter;
		} else if (word === 'mac' || word === 'pc' || word === 'pca') {
			state.codepage = word === 'mac' ? 10000 : word === 'pc' ? 437 : 850;
		} else if (word === 'ansi') state.codepage = 1252;
		else if (word === 'deff') defaultFont = parameter;
		else if (word === 'f') state.font = parameter;
		else if (word === 'plain') state.font = defaultFont;
		if (word === 'u') {
			if (parameter === undefined || parameter < -32768 || parameter > 65535)
				throw new Error('Invalid RTF Unicode code unit');
			for (let skipped = 0; skipped < state.uc && i < raw.length;) {
				if (raw[i] === '{' || raw[i] === '}') break;
				if (raw[i] === '\r' || raw[i] === '\n') {
					i++;
					continue;
				}
				if (raw[i] === '\\') {
					const fallback = readRtfControl(raw, i);
					if (!fallback) throw new Error('Invalid RTF Unicode fallback');
					i = fallback.end;
				} else i++;
				skipped++;
			}
			if (!metadataField || state.selectedMetadata)
				yield {
					type: 'text',
					value: String.fromCharCode(parameter < 0 ? parameter + 65536 : parameter),
					start,
					end: i,
				};
		} else if (word === 'cell' && state.inTable) {
			if (!metadataField || state.selectedMetadata)
				yield { type: 'text', value: '\n', start, end: i };
		} else if (raw[start + 1] === "'") {
			const codepage = fontCodepage();
			if (!metadataField || state.selectedMetadata)
				yield {
					type: 'text',
					value: decodeByte(
						Number.parseInt(raw.slice(start + 2, start + 4), 16),
						codepage
					),
					start,
					end: i,
				};
		} else if (!word && /[\\{}]/.test(raw[start + 1])) {
			if (!metadataField || state.selectedMetadata)
				yield { type: 'text', value: raw[start + 1], start, end: i };
		} else if (!word && /[\r\n]/.test(raw[start + 1])) {
			if (raw[start + 1] === '\r' && raw[i] === '\n') i++;
			if (!metadataField || state.selectedMetadata)
				yield { type: 'text', value: '\n', start, end: i };
		} else {
			const value = RTF_TEXT_CONTROLS.get(word ? `\\${word}` : raw.slice(start, i));
			if (!metadataField || state.selectedMetadata) {
				if (value !== undefined) yield { type: 'text', value, start, end: i };
				else yield { type: 'control', value: raw.slice(start, i), start, end: i };
			}
		}
	}
}
