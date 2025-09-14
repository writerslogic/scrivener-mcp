/**
 * Document compilation and export service
 */

import { DOCUMENT_TYPES } from '../core/constants.js';
import { createError, ErrorCode } from '../core/errors.js';
import { getLogger } from '../core/logger.js';
import { getAccurateWordCount } from '../utils/text-metrics.js';
import type { ProjectMetadata, ProjectStatistics, ScrivenerDocument } from '../types/index.js';
import type { RTFContent } from './parsers/rtf-handler.js';
import { RTFHandler } from './parsers/rtf-handler.js';

const logger = getLogger('compilation-service');

export interface CompilationOptions {
	separator?: string;
	outputFormat?: 'text' | 'markdown' | 'html' | 'latex' | 'json';
	includeSynopsis?: boolean;
	includeNotes?: boolean;
	hierarchical?: boolean;
}

export interface SearchOptions {
	caseSensitive?: boolean;
	regex?: boolean;
	searchMetadata?: boolean;
	maxResults?: number;
}

export interface SearchResult {
	documentId: string;
	title: string;
	matches: string[];
	path?: string;
	wordCount?: number;
}

export class CompilationService {
	private rtfHandler: RTFHandler;

	constructor() {
		this.rtfHandler = new RTFHandler();
	}

	/**
	 * Compile multiple documents into a single output
	 */
	async compileDocuments(
		documents: Array<{ id: string; content: RTFContent | string; title: string }>,
		options: CompilationOptions = {}
	): Promise<string | object> {
		const {
			separator = '\n\n---\n\n',
			outputFormat = 'text',
			includeSynopsis = false,
			includeNotes = false,
		} = options;

		// Convert all content to RTFContent format
		const rtfContents = documents.map((doc) => {
			if (typeof doc.content === 'string') {
				return {
					plainText: doc.content,
					formattedText: [{ text: doc.content }],
					metadata: {},
				};
			}
			return doc.content as RTFContent;
		});

		switch (outputFormat) {
			case 'text':
				return this.compileToText(rtfContents, separator);

			case 'markdown':
				return this.compileToMarkdown(rtfContents, separator, documents);

			case 'html':
				return this.compileToHtml(rtfContents, separator, documents);

			case 'latex':
				return this.compileToLatex(rtfContents, documents);

			case 'json':
				return this.compileToJson(documents, rtfContents, {
					includeSynopsis,
					includeNotes,
				});

			default:
				throw createError(
					ErrorCode.INVALID_INPUT,
					undefined,
					`Unsupported output format: ${outputFormat}`
				);
		}
	}

	/**
	 * Search content across documents
	 */
	searchInDocuments(
		documents: Array<{
			id: string;
			content: string;
			title: string;
			metadata?: Record<string, unknown>;
		}>,
		query: string,
		options: SearchOptions = {}
	): SearchResult[] {
		const {
			caseSensitive = false,
			regex = false,
			searchMetadata = false,
			maxResults = Infinity,
		} = options;

		const results: SearchResult[] = [];
		let resultCount = 0;

		for (const doc of documents) {
			if (resultCount >= maxResults) break;

			const matches: string[] = [];

			// Search in content
			matches.push(...this.findMatches(doc.content, query, { caseSensitive, regex }));

			// Search in metadata if requested
			if (searchMetadata && doc.metadata) {
				if (this.matchesQuery(doc.title, query, caseSensitive)) {
					matches.push(`Title: ${doc.title}`);
				}

				if (
					doc.metadata.synopsis &&
					typeof doc.metadata.synopsis === 'string' &&
					this.matchesQuery(doc.metadata.synopsis, query, caseSensitive)
				) {
					matches.push(`Synopsis: ${doc.metadata.synopsis.substring(0, 100)}...`);
				}

				if (
					doc.metadata.notes &&
					typeof doc.metadata.notes === 'string' &&
					this.matchesQuery(doc.metadata.notes, query, caseSensitive)
				) {
					matches.push(`Notes: ${doc.metadata.notes.substring(0, 100)}...`);
				}

				if (doc.metadata.keywords && Array.isArray(doc.metadata.keywords)) {
					for (const keyword of doc.metadata.keywords as string[]) {
						if (
							typeof keyword === 'string' &&
							this.matchesQuery(keyword, query, caseSensitive)
						) {
							matches.push(`Keyword: ${keyword}`);
						}
					}
				}
			}

			if (matches.length > 0) {
				results.push({
					documentId: doc.id,
					title: doc.title,
					matches: matches.slice(0, 10), // Limit matches per document
					wordCount: getAccurateWordCount(doc.content),
				});
				resultCount++;
			}
		}

		return results;
	}

	/**
	 * Export project in various formats
	 */
	async exportProject(
		structure: ScrivenerDocument[],
		format: string,
		options: Record<string, unknown> = {}
	): Promise<{ format: string; content: string; metadata: Record<string, unknown> }> {
		logger.info(`Exporting project as ${format}`);

		let content = '';
		const metadata: Record<string, unknown> = {
			exportDate: new Date().toISOString(),
			format,
			documentCount: this.countDocuments(structure),
		};

		switch (format) {
			case 'markdown':
				content = this.exportAsMarkdown(structure, options);
				break;

			case 'html':
				content = this.exportAsHtml(structure, options);
				break;

			case 'json':
				content = JSON.stringify(structure, null, 2);
				break;

			case 'epub':
				// Placeholder for EPUB export
				throw createError(
					ErrorCode.NOT_IMPLEMENTED,
					undefined,
					'EPUB export not yet implemented'
				);

			default:
				throw createError(
					ErrorCode.INVALID_INPUT,
					undefined,
					`Unsupported export format: ${format}`
				);
		}

		return { format, content, metadata };
	}

	/**
	 * Extract annotations from RTF content
	 */
	extractAnnotations(rtfContent: string): Map<string, string> {
		return this.rtfHandler.preserveScrivenerAnnotations(rtfContent);
	}

	/**
	 * Get project statistics
	 */
	getStatistics(documents: ScrivenerDocument[]): ProjectStatistics {
		const stats: ProjectStatistics = {
			totalDocuments: 0,
			totalFolders: 0,
			totalWords: 0,
			totalCharacters: 0,
			draftDocuments: 0,
			researchDocuments: 0,
			trashedDocuments: 0,
			metadata: {} as ProjectMetadata,
			documentsByType: {} as Record<string, number>,
			documentsByStatus: {} as Record<string, number>,
			documentsByLabel: {} as Record<string, number>,
			averageDocumentLength: 0,
			longestDocument: null,
			shortestDocument: null,
			recentlyModified: [],
		};

		const processDocuments = (docs: ScrivenerDocument[]) => {
			for (const doc of docs) {
				stats.totalDocuments++;

				if (doc.type === DOCUMENT_TYPES.FOLDER) {
					stats.totalFolders++;
				}

				stats.documentsByType[doc.type] = (stats.documentsByType[doc.type] || 0) + 1;

				if (doc.children) {
					processDocuments(doc.children);
				}
			}
		};

		processDocuments(documents);

		const textDocs = stats.totalDocuments - stats.totalFolders;
		if (textDocs > 0) {
			stats.averageDocumentLength = Math.round(stats.totalWords / textDocs);
		}

		return stats;
	}

	// Private helper methods
	private compileToText(contents: RTFContent[], separator: string): string {
		return contents
			.map((c) => c.plainText)
			.filter((text) => text.trim())
			.join(separator);
	}

	private compileToMarkdown(
		contents: RTFContent[],
		separator: string,
		documents: Array<{ title: string }>
	): string {
		const parts: string[] = [];

		for (let i = 0; i < contents.length; i++) {
			const content = contents[i];
			const doc = documents[i];

			if (content.plainText?.trim()) {
				// Add document title as heading
				parts.push(`# ${doc.title}\n`);

				// Process formatted text
				if (content.formattedText) {
					let mdContent = '';
					for (const part of content.formattedText) {
						let text = part.text;
						if (part.style?.bold && part.style?.italic) {
							text = `***${text}***`;
						} else if (part.style?.bold) {
							text = `**${text}**`;
						} else if (part.style?.italic) {
							text = `*${text}*`;
						}
						mdContent += text;
					}
					parts.push(mdContent);
				} else {
					parts.push(content.plainText || '');
				}
			}
		}

		return parts.join(separator);
	}

	private compileToHtml(
		_contents: RTFContent[],
		_separator: string,
		_documents: Array<{ title: string }>
	): string {
		const parts: string[] = ['<!DOCTYPE html><html><body>'];

		parts.push('</body></html>');
		return parts.join('\n');
	}

	private compileToLatex(_contents: RTFContent[], _documents: Array<{ title: string }>): string {
		const parts: string[] = ['\\documentclass{article}', '\\begin{document}'];

		for (let i = 0; i < _contents.length; i++) {
			const content = _contents[i];
			const doc = _documents[i];

			if (content.plainText?.trim()) {
				parts.push(`\\section{${this.escapeLatex(doc.title)}}`);

				if (content.formattedText) {
					let latexContent = '';
					for (const part of content.formattedText) {
						let text = this.escapeLatex(part.text);
						if (part.style?.bold && part.style?.italic) {
							text = `\\textbf{\\textit{${text}}}`;
						} else if (part.style?.bold) {
							text = `\\textbf{${text}}`;
						} else if (part.style?.italic) {
							text = `\\textit{${text}}`;
						}
						latexContent += text;
					}
					parts.push(latexContent);
				} else {
					const text = content.plainText || '';
					parts.push(this.escapeLatex(text));
				}

				if (i < _contents.length - 1) {
					parts.push('\\par\\bigskip');
				}
			}
		}

		parts.push('\\end{document}');
		return parts.join('\n\n');
	}

	private compileToJson(
		documents: Array<{ id: string; title: string }>,
		contents: RTFContent[],
		options: { includeSynopsis?: boolean; includeNotes?: boolean }
	): object {
		const result = {
			documents: documents.map((doc, index) => {
				const content = contents[index];
				const docData: Record<string, unknown> = {
					id: doc.id,
					title: doc.title,
					content: content.plainText || '',
					wordCount: getAccurateWordCount(content.plainText || ''),
				};

				if (content.formattedText) {
					docData.formattedText = content.formattedText;
				}

				// Include optional metadata based on options
				if (options.includeSynopsis && content.metadata?.synopsis) {
					docData.synopsis = content.metadata.synopsis;
				}

				if (options.includeNotes && content.metadata?.notes) {
					docData.notes = content.metadata.notes;
				}

				return docData;
			}),
			totalWordCount: contents.reduce((sum, c) => {
				const text = c.plainText || '';
				return sum + getAccurateWordCount(text);
			}, 0),
			metadata: {
				compiledAt: new Date().toISOString(),
				documentCount: documents.length,
			},
		};

		return result;
	}

	private findMatches(
		content: string,
		query: string,
		options: { caseSensitive?: boolean; regex?: boolean }
	): string[] {
		const matches: string[] = [];

		if (options.regex) {
			try {
				const flags = options.caseSensitive ? 'g' : 'gi';
				const regex = new RegExp(query, flags);
				const found = content.match(regex);
				if (found) {
					// Get context around matches
					for (const match of found) {
						const index = content.indexOf(match);
						const contextStart = Math.max(0, index - 50);
						const contextEnd = Math.min(content.length, index + match.length + 50);
						matches.push(content.substring(contextStart, contextEnd));
					}
				}
			} catch (error) {
				logger.warn('Invalid regex pattern:', { query, error });
			}
		} else {
			const searchContent = options.caseSensitive ? content : content.toLowerCase();
			const searchQuery = options.caseSensitive ? query : query.toLowerCase();

			let index = searchContent.indexOf(searchQuery);
			while (index !== -1 && matches.length < 10) {
				const contextStart = Math.max(0, index - 50);
				const contextEnd = Math.min(content.length, index + query.length + 50);
				const context = content.substring(contextStart, contextEnd);

				// Avoid duplicate contexts
				if (!matches.includes(context)) {
					matches.push(context);
				}

				index = searchContent.indexOf(searchQuery, index + 1);
			}
		}

		return matches;
	}

	private matchesQuery(text: string, query: string, caseSensitive: boolean): boolean {
		const searchText = caseSensitive ? text : text.toLowerCase();
		const searchQuery = caseSensitive ? query : query.toLowerCase();
		return searchText.includes(searchQuery);
	}

	private exportAsMarkdown(
		structure: ScrivenerDocument[],
		options: Record<string, unknown>
	): string {
		const lines: string[] = [];
		const includeMetadata = (options.includeMetadata as boolean) ?? true;
		const maxDepth = (options.maxDepth as number) ?? Infinity;
		const includeWordCounts = (options.includeWordCounts as boolean) ?? false;
		const includeStatus = (options.includeStatus as boolean) ?? false;

		const processDocument = (doc: ScrivenerDocument, depth: number) => {
			if (depth > maxDepth) return;

			const heading = '#'.repeat(Math.min(depth + 1, 6));
			lines.push(`${heading} ${doc.title}`);

			if (includeMetadata) {
				if (doc.synopsis) {
					lines.push(`\n> ${doc.synopsis}\n`);
				}
				if (doc.keywords?.length) {
					lines.push(`**Keywords:** ${doc.keywords.join(', ')}\n`);
				}
				if (includeStatus && doc.status) {
					lines.push(`**Status:** ${doc.status}\n`);
				}
				if (includeWordCounts && doc.wordCount) {
					lines.push(`**Word Count:** ${doc.wordCount}\n`);
				}
			}

			if (doc.content) {
				lines.push(`\n${doc.content}\n`);
			}

			if (doc.children) {
				for (const child of doc.children) {
					processDocument(child, depth + 1);
				}
			}
		};

		for (const doc of structure) {
			processDocument(doc, 0);
		}

		return lines.join('\n');
	}

	private exportAsHtml(structure: ScrivenerDocument[], options: Record<string, unknown>): string {
		const includeMetadata = (options.includeMetadata as boolean) ?? true;
		const maxDepth = (options.maxDepth as number) ?? Infinity;
		const includeWordCounts = (options.includeWordCounts as boolean) ?? false;
		const includeStatus = (options.includeStatus as boolean) ?? false;

		const lines: string[] = [
			'<!DOCTYPE html>',
			'<html>',
			'<head>',
			'<meta charset="UTF-8">',
			'<title>Scrivener Project Export</title>',
			'<style>',
			'body { font-family: Georgia, serif; max-width: 800px; margin: 0 auto; padding: 20px; }',
			'h1, h2, h3, h4, h5, h6 { font-family: Arial, sans-serif; }',
			'.synopsis { font-style: italic; color: #666; }',
			'.keywords { color: #999; font-size: 0.9em; }',
			'.status { color: #007acc; font-weight: bold; }',
			'.word-count { color: #888; font-size: 0.8em; }',
			'</style>',
			'</head>',
			'<body>',
		];

		const processDocument = (doc: ScrivenerDocument, depth: number) => {
			if (depth > maxDepth) return;

			const tag = `h${Math.min(depth + 1, 6)}`;
			lines.push(`<${tag}>${this.escapeHtml(doc.title)}</${tag}>`);

			if (includeMetadata) {
				if (doc.synopsis) {
					lines.push(`<p class="synopsis">${this.escapeHtml(doc.synopsis)}</p>`);
				}

				if (doc.keywords?.length) {
					lines.push(
						`<p class="keywords">Keywords: ${doc.keywords.map((k: string) => this.escapeHtml(k)).join(', ')}</p>`
					);
				}

				if (includeStatus && doc.status) {
					lines.push(`<p class="status">Status: ${this.escapeHtml(doc.status)}</p>`);
				}

				if (includeWordCounts && doc.wordCount) {
					lines.push(`<p class="word-count">Word Count: ${doc.wordCount}</p>`);
				}
			}

			if (doc.content) {
				lines.push(`<div>${this.escapeHtml(doc.content)}</div>`);
			}

			if (doc.children) {
				lines.push('<div class="children">');
				for (const child of doc.children) {
					processDocument(child, depth + 1);
				}
				lines.push('</div>');
			}
		};

		for (const doc of structure) {
			processDocument(doc, 0);
		}

		lines.push('</body>', '</html>');
		return lines.join('\n');
	}

	private escapeHtml(text: string): string {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	private escapeLatex(text: string): string {
		return text
			.replace(/\\/g, '\\textbackslash{}')
			.replace(/[{}]/g, '\\$&')
			.replace(/[_%#&$]/g, '\\$&')
			.replace(/~/g, '\\textasciitilde{}')
			.replace(/\^/g, '\\textasciicircum{}');
	}

	private countDocuments(structure: ScrivenerDocument[]): number {
		let count = 0;
		const traverse = (docs: ScrivenerDocument[]) => {
			for (const doc of docs) {
				count++;
				if (doc.children) {
					traverse(doc.children);
				}
			}
		};
		traverse(structure);
		return count;
	}
}
