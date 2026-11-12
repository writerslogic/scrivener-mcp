import * as path from 'path';
import { safeReadFile, safeWriteFile } from '../../utils/common.js';
import { isStructurallyValidRtf, readRtfControl, rtfGroupEnd } from './rtf-validation.js';

import { assertRtfText, rtfTextTokens } from './rtf-text.js';
export { RTF_TEXT_CONTROLS } from './rtf-text.js';

export interface RTFStyle {
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	fontSize?: number;
	fontFamily?: string;
	color?: string;
	backgroundColor?: string;
}

export interface RTFContent {
	plainText: string;
	formattedText: Array<{
		text: string;
		style?: RTFStyle;
	}>;
	metadata?: {
		title?: string;
		author?: string;
		subject?: string;
		keywords?: string;
		synopsis?: string;
		notes?: string;
		creationDate?: Date;
		modificationDate?: Date;
	};
}

/**
 * Comprehensive RTF handler for Scrivener documents
 */
export class RTFHandler {
	/**
	 * Find a brace-balanced RTF group by keyword (e.g. "\\info").
	 * Uses linear scanning instead of regex to avoid ReDoS on nested braces.
	 * Returns the content between the outermost braces, or null if not found.
	 */
	private findBraceGroup(input: string, keyword: string): string | null {
		const idx = this.findBraceGroupStart(input, keyword);
		if (idx === -1) return null;

		const end = rtfGroupEnd(input, idx);
		return end === undefined ? null : input.substring(idx + 1 + keyword.length, end - 1);
	}

	private findBraceGroupStart(input: string, keyword: string, from = 0): number {
		for (let offset = from; offset < input.length;) {
			if (input[offset] === '\\') {
				const control = readRtfControl(input, offset);
				if (!control) return -1;
				offset = control.end;
			} else {
				if (
					input.startsWith(`{${keyword}`, offset) &&
					!/[a-zA-Z]/.test(input[offset + keyword.length + 1] ?? '')
				)
					return offset;
				offset++;
			}
		}
		return -1;
	}

	async readRTF(filePath: string): Promise<RTFContent> {
		const resolved = path.resolve(filePath);
		if (resolved.includes('\0') || /\.\.[\\/]/.test(filePath)) {
			throw new Error(`Invalid file path: ${filePath}`);
		}
		const rtfContent = await safeReadFile(resolved);
		return this.parseRTF(rtfContent);
	}

	async parseRTF(rtfString: string): Promise<RTFContent> {
		return this.enhancedRTFParse(rtfString);
	}

	async writeRTF(filePath: string, content: RTFContent | string): Promise<void> {
		const resolved = path.resolve(filePath);
		if (resolved.includes('\0') || /\.\.[\\/]/.test(filePath)) {
			throw new Error(`Invalid file path: ${filePath}`);
		}
		const rtfString = this.unifiedConvertToRTF(content);
		await safeWriteFile(resolved, rtfString);
	}

	/**
	 * Unified RTF conversion that handles both plain text and formatted content
	 */
	private unifiedConvertToRTF(content: RTFContent | string): string {
		const isPlainText = typeof content === 'string';
		if (
			!isPlainText &&
			content.formattedText.length > 0 &&
			content.formattedText.map((segment) => segment.text).join('') !== content.plainText
		)
			throw new Error(
				'Formatted RTF spans must concatenate to the exact plainText, including whitespace'
			);

		const header = this.buildRTFHeader(isPlainText ? undefined : content.metadata);

		let body: string;
		if (isPlainText) {
			body = this.encodeTextForRTF(content);
		} else if (content.formattedText.length === 0) {
			body = this.encodeTextForRTF(content.plainText);
		} else {
			body = this.buildFormattedRTF(content.formattedText);
		}

		const raw = `${header}${body}}`;
		if (!isStructurallyValidRtf(raw)) throw new Error('Generated RTF is structurally invalid');
		return raw;
	}

	private buildRTFHeader(metadata?: RTFContent['metadata']): string {
		const parts: string[] = ['{\\rtf1\\ansi\\deff0\\uc1'];

		// Generator identification
		parts.push('{\\*\\generator WritersLogic Scrivener MCP;}');

		if (metadata) {
			for (const key of ['synopsis', 'notes', 'creationDate', 'modificationDate'] as const) {
				if (metadata[key] !== undefined)
					throw new Error(
						`RTF serialization does not support metadata ${key}; use the project metadata operation instead`
					);
			}
			const info: string[] = [];
			if (metadata.title) info.push(`{\\title ${this.encodeRTFString(metadata.title)}}`);
			if (metadata.author) info.push(`{\\author ${this.encodeRTFString(metadata.author)}}`);
			if (metadata.subject)
				info.push(`{\\subject ${this.encodeRTFString(metadata.subject)}}`);
			if (metadata.keywords)
				info.push(`{\\keywords ${this.encodeRTFString(metadata.keywords)}}`);

			if (info.length > 0) {
				parts.push(`{\\info${info.join('')}}`);
			}
		}

		// Font and color tables
		parts.push(
			'{\\fonttbl{\\f0\\fswiss\\fcharset0 Helvetica;}{\\f1\\fnil\\fcharset0 Cochin;}{\\f2\\fnil\\fcharset0 Optima;}}'
		);
		parts.push('{\\colortbl;\\red0\\green0\\blue0;}');
		parts.push('\\f0\\fs24\\cf1 ');

		return parts.join('');
	}

	private buildFormattedRTF(segments: RTFContent['formattedText']): string {
		if (!segments || segments.length === 0) return '';

		return segments
			.map((segment) => {
				let text = this.encodeTextForRTF(segment.text);

				if (segment.style) {
					const styles: string[] = [];
					for (const key of ['fontFamily', 'color', 'backgroundColor'] as const) {
						if (segment.style[key] !== undefined)
							throw new Error(
								`RTF serialization does not support ${
									key
								}; use a preserving text edit or explicitly remove the unsupported style`
							);
					}
					if (segment.style.fontSize !== undefined) {
						const halfPoints = segment.style.fontSize * 2;
						if (!Number.isInteger(halfPoints) || halfPoints < 1 || halfPoints > 32767)
							throw new Error(
								'RTF font size must be 0.5 to 16383.5 points in half-point increments'
							);
						styles.push(`\\fs${halfPoints}`);
					}
					if (segment.style.bold) styles.push('\\b');
					if (segment.style.italic) styles.push('\\i');
					if (segment.style.underline) styles.push('\\ul');
					if (segment.style.strikethrough) styles.push('\\strike');

					if (styles.length > 0) {
						const styleString = styles.join(' ');
						text = `{${styleString} ${text}}`;
					}
				}

				return text;
			})
			.join('');
	}

	/**
	 * Enhanced manual RTF parsing with better Scrivener support
	 */
	private enhancedRTFParse(rtfString: string): RTFContent {
		if (typeof rtfString !== 'string') throw new TypeError('RTF content must be a string');
		for (let offset = 0; offset < rtfString.length;) {
			if (rtfString[offset] !== '\\') {
				offset++;
				continue;
			}
			const control = readRtfControl(rtfString, offset);
			if (!control) throw new Error('Invalid RTF control sequence');
			if (control.word === 'bin') {
				// Binary lengths can consume group delimiters, making structural recovery ambiguous.
				if (!isStructurallyValidRtf(rtfString)) throw new Error('Invalid RTF binary data');
				break;
			}
			offset = control.end;
		}
		const result: RTFContent = {
			plainText: '',
			formattedText: [],
		};

		result.metadata = this.extractMetadata(rtfString);

		const segments = this.parseRTFSegments(rtfString);

		const plainTextParts: string[] = [];
		segments.forEach((segment) => {
			plainTextParts.push(segment.text);
			result.formattedText.push(segment);
		});

		result.plainText = plainTextParts.join('');

		return result;
	}

	private extractMetadata(rtfString: string): RTFContent['metadata'] | undefined {
		const info = this.findBraceGroup(rtfString, '\\info');
		if (!info) return undefined;
		const metadata: RTFContent['metadata'] = {};

		const extractField = (field: string) => {
			const value = this.findBraceGroup(info, `\\${field}`);
			if (value === null) return undefined;
			return this.parseRTFSegments(rtfString, field)
				.map((run) => run.text)
				.join('');
		};

		metadata.title = extractField('title');
		metadata.author = extractField('author');
		metadata.subject = extractField('subject');
		metadata.keywords = extractField('keywords');

		return Object.keys(metadata).length > 0 ? metadata : undefined;
	}

	private parseRTFSegments(
		content: string,
		metadataField?: string
	): Array<{ text: string; style?: RTFStyle }> {
		const segments: Array<{ text: string; style?: RTFStyle }> = [];
		const stack: RTFStyle[] = [{}];
		let currentText = '';
		let currentStyle = { ...stack[0] };

		// Enhanced tokenization
		const tokens = rtfTextTokens(content, metadataField);

		for (const token of tokens) {
			if (token.type === 'control') {
				if (currentText) {
					segments.push({
						text: currentText,
						style:
							Object.keys(currentStyle).length > 0 ? { ...currentStyle } : undefined,
					});
					currentText = '';
				}

				this.applyControlWord(token.value, currentStyle);
			} else if (token.type === 'group-start') {
				stack.push({ ...currentStyle });
			} else if (token.type === 'group-end') {
				if (currentText) {
					segments.push({
						text: currentText,
						style:
							Object.keys(currentStyle).length > 0 ? { ...currentStyle } : undefined,
					});
					currentText = '';
				}
				if (stack.length > 1) {
					currentStyle = stack.pop()!;
				}
			} else if (token.type === 'text') {
				currentText += token.value;
			}
		}

		if (currentText) {
			segments.push({
				text: currentText,
				style: Object.keys(currentStyle).length > 0 ? currentStyle : undefined,
			});
		}

		return segments;
	}

	/**
	 * Apply RTF control word to current style
	 */
	private applyControlWord(control: string, style: RTFStyle): void {
		const cleaned = control.replace(/^\\/, '').replace(/\s+$/, '');

		const toggles = {
			b: 'bold',
			i: 'italic',
			ul: 'underline',
			strike: 'strikethrough',
		} as const;
		const toggle = /^(b|i|ul|strike)(-?\d+)?$/.exec(cleaned);
		if (toggle) {
			style[toggles[toggle[1] as keyof typeof toggles]] =
				toggle[2] === undefined || Number(toggle[2]) !== 0;
			return;
		}
		if (cleaned === 'plain') {
			for (const key of Object.keys(style) as Array<keyof RTFStyle>) delete style[key];
		} else if (cleaned === 'ulnone') style.underline = false;

		const fsMatch = cleaned.match(/^fs(\d+)$/);
		if (fsMatch) {
			style.fontSize = parseInt(fsMatch[1]) / 2; // RTF uses half-points
		}
	}

	convertToRTF(content: RTFContent | string): string {
		return this.unifiedConvertToRTF(content);
	}

	extractPlainText(rtfString: string): string {
		const parsed = this.enhancedRTFParse(rtfString);
		return parsed.plainText;
	}

	/**
	 * Enhanced Scrivener annotation preservation
	 */
	preserveScrivenerAnnotations(rtfString: string): Map<string, string> {
		const annotations = new Map<string, string>();

		// Enhanced patterns for various Scrivener annotation formats
		const patterns = [
			// Standard annotations
			/\{\\Scrv_annot\\id(\d+)([^}]*)\}([^{]*(?:\{[^}]*\}[^{]*)*)\{\\Scrv_annot_end\}/g,
			// Comments
			/\{\\Scrv_comm\\id(\d+)([^}]*)\}([^{]*(?:\{[^}]*\}[^{]*)*)\{\\Scrv_comm_end\}/g,
			// Inline annotations
			/\{\\Scrv_inl\\id(\d+)([^}]*)\}([^{]*(?:\{[^}]*\}[^{]*)*)\{\\Scrv_inl_end\}/g,
			// Footnotes
			/\{\\Scrv_fn\\id(\d+)([^}]*)\}([^{]*(?:\{[^}]*\}[^{]*)*)\{\\Scrv_fn_end\}/g,
			// Custom metadata
			/\{\\Scrv_meta\\type([^\\}]+)\\id(\d+)\}([^{]*(?:\{[^}]*\}[^{]*)*)\{\\Scrv_meta_end\}/g,
		];

		patterns.forEach((pattern, index) => {
			let match;
			const regex = new RegExp(pattern.source, pattern.flags);

			while ((match = regex.exec(rtfString)) !== null) {
				let id: string;
				let content: string;
				let type = '';

				if (index === 4) {
					// Custom metadata pattern
					type = match[1];
					id = match[2];
					content = match[3];
				} else {
					id = match[1];
					content = match[3] || match[2]; // Some formats have content in different positions
				}

				// Clean the content
				content = this.cleanAnnotationText(content);

				// Store with type prefix if applicable
				const key = type
					? `${type}_${id}`
					: `${['annot', 'comm', 'inl', 'fn'][index]}_${id}`;
				annotations.set(key, content);
			}
		});

		return annotations;
	}

	/**
	 * Clean annotation text by removing RTF formatting
	 */
	private cleanAnnotationText(text: string): string {
		return this.parseRTFSegments(text)
			.map((run) => run.text)
			.join('');
	}

	/**
	 * Helper: Encode text for RTF
	 */
	private encodeTextForRTF(text: string): string {
		let encoded = text;

		// Escape special characters
		encoded = encoded.replace(/\\/g, '\\\\');
		encoded = encoded.replace(/\{/g, '\\{');
		encoded = encoded.replace(/\}/g, '\\}');

		encoded = encoded.replace(/\n/g, '\\par\n');
		encoded = encoded.replace(/\t/g, '\\tab ');
		encoded = encoded.replace(/\f/g, '\\page ');

		encoded = encoded.replace(/\r/g, String.raw`\u13?`);

		// Encode non-ASCII characters
		encoded = this.encodeNonASCII(encoded);

		return encoded;
	}

	/**
	 * Helper: Encode RTF string (for metadata)
	 */
	private encodeRTFString(str: string): string {
		return this.encodeTextForRTF(str);
	}

	/**
	 * Helper: Encode non-ASCII characters
	 */
	private encodeNonASCII(text: string): string {
		assertRtfText(text);
		// eslint-disable-next-line no-control-regex
		return text.replace(/[^\x00-\x7F]/g, (char) => {
			const code = char.charCodeAt(0);

			// Unicode characters
			if (code < 32768) {
				return `\\u${code}?`;
			} else {
				return `\\u${code - 65536}?`;
			}
		});
	}

	async mergeRTFFiles(filePaths: string[]): Promise<string> {
		const contents: RTFContent[] = [];

		for (const filePath of filePaths) {
			const rtfContent = await this.readRTF(filePath);
			contents.push(rtfContent);
		}

		const merged: RTFContent = {
			plainText: contents.map((c) => c.plainText).join('\n\n'),
			formattedText: [],
		};

		contents.forEach((content, index) => {
			if (index > 0) {
				merged.formattedText.push({ text: '\n\n' });
			}
			merged.formattedText.push(...content.formattedText);
		});

		return this.unifiedConvertToRTF(merged);
	}
}
