import * as fs from 'fs/promises';
import parseRTF from 'rtf-parser';
import { promisify } from 'util';
import type {
	RTFParserDocument,
	RTFParserContent,
	RTFParserContentNode,
} from './types/internal.js';

const parseRTFAsync = promisify(parseRTF.string);

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
		creationDate?: Date;
		modificationDate?: Date;
	};
}

/**
 * Comprehensive RTF handler for Scrivener documents
 */
export class RTFHandler {
	// RTF control word mappings
	private readonly SPECIAL_CHARS = new Map([
		['\\ldblquote', '"'],
		['\\rdblquote', '"'],
		['\\lquote', "'"],
		['\\rquote', "'"],
		['\\endash', '–'],
		['\\emdash', '—'],
		['\\bullet', '•'],
		['\\tab', '\t'],
		['\\line', '\n'],
		['\\par', '\n'],
		['\\~', ' '],
	]);

	private readonly SPECIAL_CHARS_REVERSE = new Map([
		['"', '\\ldblquote '],
		['"', '\\rdblquote '],
		["'", '\\lquote '],
		["'", '\\rquote '],
		['–', '\\endash '],
		['—', '\\emdash '],
		['•', '\\bullet '],
	]);

	/**
	 * Read and parse an RTF file
	 */
	async readRTF(filePath: string): Promise<RTFContent> {
		const rtfContent = await fs.readFile(filePath, 'utf-8');
		return this.parseRTF(rtfContent);
	}

	/**
	 * Parse RTF string content
	 */
	async parseRTF(rtfString: string): Promise<RTFContent> {
		try {
			// Try using the RTF parser library first
			const doc = (await parseRTFAsync(rtfString)) as RTFParserDocument;
			return this.convertRTFDocument(doc);
		} catch {
			// Fall back to enhanced manual parsing
			return this.enhancedRTFParse(rtfString);
		}
	}

	/**
	 * Write RTF content to a file
	 */
	async writeRTF(filePath: string, content: RTFContent | string): Promise<void> {
		const rtfString = this.unifiedConvertToRTF(content);
		await fs.writeFile(filePath, rtfString, 'utf-8');
	}

	/**
	 * Unified RTF conversion that handles both plain text and formatted content
	 */
	private unifiedConvertToRTF(content: RTFContent | string): string {
		const isPlainText = typeof content === 'string';

		// Build RTF header
		const header = this.buildRTFHeader(isPlainText ? undefined : content.metadata);

		// Build body content
		let body: string;
		if (isPlainText) {
			body = this.encodeTextForRTF(content);
		} else {
			body = this.buildFormattedRTF(content.formattedText);
		}

		return `${header}${body}}`;
	}

	/**
	 * Build RTF header with optional metadata
	 */
	private buildRTFHeader(metadata?: RTFContent['metadata']): string {
		const parts: string[] = ['{\\rtf1\\ansi\\deff0\\uc0'];

		// Add metadata if present
		if (metadata) {
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
		parts.push('{\\fonttbl{\\f0\\fnil\\fcharset0 Cochin;}{\\f1\\fnil\\fcharset0 Optima;}}');
		parts.push('{\\colortbl;\\red0\\green0\\blue0;}');
		parts.push('\\f0\\fs24\\cf1 ');

		return parts.join('');
	}

	/**
	 * Build formatted RTF body from text segments
	 */
	private buildFormattedRTF(segments: RTFContent['formattedText']): string {
		if (!segments || segments.length === 0) return '';

		return segments
			.map((segment) => {
				let text = this.encodeTextForRTF(segment.text);

				if (segment.style) {
					const styles: string[] = [];
					if (segment.style.bold) styles.push('\\b');
					if (segment.style.italic) styles.push('\\i');
					if (segment.style.underline) styles.push('\\ul');
					if (segment.style.strikethrough) styles.push('\\strike');

					if (styles.length > 0) {
						const styleString = styles.join(' ');
						const resetString = styles.map((s) => `${s}0`).join(' ');
						text = `{${styleString} ${text}${resetString}}`;
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
		const result: RTFContent = {
			plainText: '',
			formattedText: [],
		};

		// Extract metadata
		result.metadata = this.extractMetadata(rtfString);

		// Remove header sections
		const content = this.stripRTFHeaders(rtfString);

		// Parse formatting and content
		const segments = this.parseRTFSegments(content);

		// Build plain text and formatted text
		segments.forEach((segment) => {
			result.plainText += segment.text;
			result.formattedText.push(segment);
		});

		result.plainText = result.plainText.trim();

		return result;
	}

	/**
	 * Extract metadata from RTF info group
	 */
	private extractMetadata(rtfString: string): RTFContent['metadata'] | undefined {
		const infoMatch = rtfString.match(/\{\\info([^}]*(?:\{[^}]*\}[^}]*)*)\}/);
		if (!infoMatch) return undefined;

		const info = infoMatch[1];
		const metadata: RTFContent['metadata'] = {};

		// Extract individual metadata fields
		const extractField = (field: string) => {
			const regex = new RegExp(`\\\\${field}\\s+([^\\\\}]+)`);
			const match = info.match(regex);
			return match ? this.decodeRTFString(match[1]) : undefined;
		};

		metadata.title = extractField('title');
		metadata.author = extractField('author');
		metadata.subject = extractField('subject');
		metadata.keywords = extractField('keywords');

		return Object.keys(metadata).length > 0 ? metadata : undefined;
	}

	/**
	 * Strip RTF headers and control tables
	 */
	private stripRTFHeaders(rtfString: string): string {
		let content = rtfString;

		// Remove RTF declaration
		content = content.replace(/^\{\\rtf\d+[^}]*/, '');

		// Remove various table definitions
		const tables = [
			/\{\\fonttbl[^}]*(?:\{[^}]*\}[^}]*)*\}/g,
			/\{\\colortbl[^}]*\}/g,
			/\{\\stylesheet[^}]*(?:\{[^}]*\}[^}]*)*\}/g,
			/\{\\listtable[^}]*(?:\{[^}]*\}[^}]*)*\}/g,
			/\{\\listoverridetable[^}]*(?:\{[^}]*\}[^}]*)*\}/g,
			/\{\\info[^}]*(?:\{[^}]*\}[^}]*)*\}/g,
		];

		tables.forEach((regex) => {
			content = content.replace(regex, '');
		});

		// Remove Scrivener-specific control words
		content = content.replace(/\{\\Scrv_[^}]*\}/g, '');

		return content;
	}

	/**
	 * Parse RTF content into text segments with formatting
	 */
	private parseRTFSegments(content: string): Array<{ text: string; style?: RTFStyle }> {
		const segments: Array<{ text: string; style?: RTFStyle }> = [];
		const stack: RTFStyle[] = [{}];
		let currentText = '';
		let currentStyle = { ...stack[0] };

		// Enhanced tokenization
		const tokens = this.tokenizeRTF(content);

		for (const token of tokens) {
			if (token.type === 'control') {
				// Save current segment if we have text
				if (currentText) {
					segments.push({
						text: currentText,
						style:
							Object.keys(currentStyle).length > 0 ? { ...currentStyle } : undefined,
					});
					currentText = '';
				}

				// Handle control word
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
					stack.pop();
					currentStyle = { ...stack[stack.length - 1] };
				}
			} else if (token.type === 'text') {
				currentText += token.value;
			}
		}

		// Add any remaining text
		if (currentText) {
			segments.push({
				text: currentText,
				style: Object.keys(currentStyle).length > 0 ? currentStyle : undefined,
			});
		}

		return segments;
	}

	/**
	 * Tokenize RTF content for easier parsing
	 */
	private tokenizeRTF(content: string): Array<{ type: string; value: string }> {
		const tokens: Array<{ type: string; value: string }> = [];
		let i = 0;

		while (i < content.length) {
			const char = content[i];

			if (char === '\\') {
				// Control word or special character
				const controlMatch = content.slice(i).match(/^\\([a-z]+)(-?\d*)\s?/i);
				if (controlMatch) {
					tokens.push({ type: 'control', value: controlMatch[0] });
					i += controlMatch[0].length;
				} else if (content[i + 1] === "'") {
					// Hex character
					const hex = content.slice(i + 2, i + 4);
					tokens.push({ type: 'text', value: String.fromCharCode(parseInt(hex, 16)) });
					i += 4;
				} else if (
					content[i + 1] === '\\' ||
					content[i + 1] === '{' ||
					content[i + 1] === '}'
				) {
					// Escaped character
					tokens.push({ type: 'text', value: content[i + 1] });
					i += 2;
				} else {
					i++;
				}
			} else if (char === '{') {
				tokens.push({ type: 'group-start', value: '{' });
				i++;
			} else if (char === '}') {
				tokens.push({ type: 'group-end', value: '}' });
				i++;
			} else {
				// Regular text - collect until next control character
				let text = '';
				while (
					i < content.length &&
					content[i] !== '\\' &&
					content[i] !== '{' &&
					content[i] !== '}'
				) {
					text += content[i];
					i++;
				}
				if (text) {
					tokens.push({ type: 'text', value: text });
				}
			}
		}

		return tokens;
	}

	/**
	 * Apply RTF control word to current style
	 */
	private applyControlWord(control: string, style: RTFStyle): void {
		// Remove the backslash and any trailing space
		const cleaned = control.replace(/^\\/, '').replace(/\s+$/, '');

		// Check for special characters
		for (const [rtfChar] of this.SPECIAL_CHARS) {
			if (control.startsWith(rtfChar.slice(1))) {
				// This is handled in tokenization
				return;
			}
		}

		// Handle formatting controls
		switch (cleaned) {
			case 'b':
				style.bold = true;
				break;
			case 'b0':
				style.bold = false;
				break;
			case 'i':
				style.italic = true;
				break;
			case 'i0':
				style.italic = false;
				break;
			case 'ul':
				style.underline = true;
				break;
			case 'ul0':
			case 'ulnone':
				style.underline = false;
				break;
			case 'strike':
				style.strikethrough = true;
				break;
			case 'strike0':
				style.strikethrough = false;
				break;
		}

		// Handle font size
		const fsMatch = cleaned.match(/^fs(\d+)$/);
		if (fsMatch) {
			style.fontSize = parseInt(fsMatch[1]) / 2; // RTF uses half-points
		}
	}

	/**
	 * Convert from parsed RTF document structure
	 */
	private convertRTFDocument(doc: RTFParserDocument): RTFContent {
		const result: RTFContent = {
			plainText: '',
			formattedText: [],
			metadata: {},
		};

		// Extract metadata
		if (doc.meta) {
			result.metadata = {
				title: doc.meta.title,
				author: doc.meta.author,
				subject: doc.meta.subject,
				keywords: doc.meta.keywords,
				creationDate: doc.meta.creationDate,
				modificationDate: doc.meta.modificationDate,
			};
		}

		// Process content recursively
		const processContent = (content: RTFParserContent, currentStyle?: RTFStyle) => {
			if (typeof content === 'string') {
				result.plainText += content;
				result.formattedText.push({
					text: content,
					style: currentStyle,
				});
			} else if (Array.isArray(content)) {
				content.forEach((item) => processContent(item, currentStyle));
			} else if (typeof content === 'object' && content !== null) {
				// Type narrowing for RTFParserContentNode
				const node = content as RTFParserContentNode;

				if ('value' in node && typeof node.value === 'string') {
					// Handle rtf-parser output format
					const text = node.value;
					result.plainText += text;
					const style: RTFStyle = { ...currentStyle };
					if ('style' in node && node.style) {
						const nodeStyle = node.style as RTFStyle;
						if (nodeStyle.bold) style.bold = true;
						if (nodeStyle.italic) style.italic = true;
						if (nodeStyle.underline) style.underline = true;
					}
					result.formattedText.push({
						text,
						style,
					});
				} else if ('content' in node) {
					const style: RTFStyle = { ...currentStyle };

					// Apply style attributes
					if ('style' in node && node.style) {
						Object.assign(style, node.style);
					}

					if (Array.isArray(node.content)) {
						node.content.forEach((item) => processContent(item, style));
					} else if (node.content) {
						processContent(node.content, style);
					}
				}
			}
		};

		if (doc.content) {
			processContent(doc.content);
		}

		return result;
	}

	/**
	 * Convert to RTF (public interface)
	 */
	convertToRTF(plainText: string): string {
		return this.unifiedConvertToRTF(plainText);
	}

	/**
	 * Extract plain text from RTF
	 */
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
		// Remove RTF control words but preserve text
		let cleaned = text
			.replace(/\\[a-z]+\d*\s?/gi, '') // Remove control words
			.replace(/\\'([0-9a-fA-F]{2})/g, (_match, hex) =>
				String.fromCharCode(parseInt(hex, 16))
			) // Decode hex
			.replace(/\\([{}\\])/g, '$1') // Unescape special chars
			.replace(/\{|\}/g, '') // Remove braces
			.trim();

		// Apply special character replacements
		for (const [rtfChar, replacement] of this.SPECIAL_CHARS) {
			const pattern = new RegExp(rtfChar.replace(/\\/g, '\\\\'), 'g');
			cleaned = cleaned.replace(pattern, replacement);
		}

		return cleaned;
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

		// Convert line breaks
		encoded = encoded.replace(/\n/g, '\\par\n');
		encoded = encoded.replace(/\t/g, '\\tab ');

		// Replace special characters with RTF equivalents
		for (const [char, rtfEquiv] of this.SPECIAL_CHARS_REVERSE) {
			encoded = encoded.replace(new RegExp(char, 'g'), rtfEquiv);
		}

		// Encode non-ASCII characters
		encoded = this.encodeNonASCII(encoded);

		return encoded;
	}

	/**
	 * Helper: Encode RTF string (for metadata)
	 */
	private encodeRTFString(str: string): string {
		const encoded = str.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');

		return this.encodeNonASCII(encoded);
	}

	/**
	 * Helper: Decode RTF string
	 */
	private decodeRTFString(str: string): string {
		return str
			.replace(/\\'([0-9a-fA-F]{2})/g, (_match, hex) =>
				String.fromCharCode(parseInt(hex, 16))
			)
			.replace(/\\([{}\\])/g, '$1')
			.trim();
	}

	/**
	 * Helper: Encode non-ASCII characters
	 */
	private encodeNonASCII(text: string): string {
		// eslint-disable-next-line no-control-regex
		return text.replace(/[^\x00-\x7F]/g, (char) => {
			const code = char.charCodeAt(0);

			if (code < 256) {
				return `\\'${code.toString(16).padStart(2, '0')}`;
			}

			// Unicode characters
			if (code < 32768) {
				return `\\u${code}?`;
			} else {
				return `\\u${code - 65536}?`;
			}
		});
	}

	/**
	 * Merge multiple RTF files
	 */
	async mergeRTFFiles(filePaths: string[]): Promise<string> {
		const contents: RTFContent[] = [];

		for (const filePath of filePaths) {
			const rtfContent = await this.readRTF(filePath);
			contents.push(rtfContent);
		}

		// Merge all formatted text
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
