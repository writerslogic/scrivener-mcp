/**
 * Tests for CompilationService
 */

import { CompilationService } from '../../../src/services/compilation-service.js';
import { RTFHandler } from '../../../src/services/parsers/rtf-handler.js';
import type { RTFContent } from '../../../src/services/parsers/rtf-handler.js';

// Mock RTFHandler
jest.mock('../../../src/services/parsers/rtf-handler.js');

describe('CompilationService', () => {
	let compilationService: CompilationService;
	let mockRtfHandler: jest.Mocked<RTFHandler>;

	beforeEach(() => {
		jest.clearAllMocks();
		compilationService = new CompilationService();
		mockRtfHandler = (compilationService as any).rtfHandler;
	});

	describe('compileDocuments', () => {
		const mockDocuments = [
			{
				id: 'doc1',
				title: 'Chapter 1',
				content: {
					plainText: 'Chapter 1 content',
					formattedText: [{ text: 'Chapter 1 content' }],
					metadata: {
						synopsis: 'Chapter 1 synopsis',
						notes: 'Chapter 1 notes',
					},
				} as RTFContent,
			},
			{
				id: 'doc2',
				title: 'Chapter 2',
				content: {
					plainText: 'Chapter 2 content',
					formattedText: [
						{ text: 'Chapter 2 ', style: { bold: true } },
						{ text: 'content', style: { italic: true } },
					],
					metadata: {
						synopsis: 'Chapter 2 synopsis',
						notes: 'Chapter 2 notes',
					},
				} as RTFContent,
			},
		];

		describe('JSON compilation', () => {
			it('should compile to JSON with default options', async () => {
				const result = await compilationService.compileDocuments(mockDocuments, {
					outputFormat: 'json',
				});

				expect(result).toMatchObject({
					documents: expect.arrayContaining([
						expect.objectContaining({
							id: 'doc1',
							title: 'Chapter 1',
							content: 'Chapter 1 content',
							wordCount: 3,
						}),
					]),
					totalWordCount: 6,
					metadata: expect.objectContaining({
						documentCount: 2,
					}),
				});
			});

			it('should include synopsis when option is set', async () => {
				const result = await compilationService.compileDocuments(mockDocuments, {
					outputFormat: 'json',
					includeSynopsis: true,
				}) as any;

				expect(result.documents[0].synopsis).toBe('Chapter 1 synopsis');
				expect(result.documents[1].synopsis).toBe('Chapter 2 synopsis');
			});

			it('should include notes when option is set', async () => {
				const result = await compilationService.compileDocuments(mockDocuments, {
					outputFormat: 'json',
					includeNotes: true,
				}) as any;

				expect(result.documents[0].notes).toBe('Chapter 1 notes');
				expect(result.documents[1].notes).toBe('Chapter 2 notes');
			});

			it('should exclude metadata when options are false', async () => {
				const result = await compilationService.compileDocuments(mockDocuments, {
					outputFormat: 'json',
					includeSynopsis: false,
					includeNotes: false,
				}) as any;

				expect(result.documents[0].synopsis).toBeUndefined();
				expect(result.documents[0].notes).toBeUndefined();
			});
		});

		describe('Markdown compilation', () => {
			it('should compile to markdown with formatting', async () => {
				const result = await compilationService.compileDocuments(mockDocuments, {
					outputFormat: 'markdown',
				});

				expect(result).toContain('# Chapter 1');
				expect(result).toContain('Chapter 1 content');
				expect(result).toContain('# Chapter 2');
				expect(result).toContain('**Chapter 2 ***content*');
			});

			it('should use custom separator', async () => {
				const result = await compilationService.compileDocuments(mockDocuments, {
					outputFormat: 'markdown',
					separator: '\n***\n',
				});

				expect(result).toContain('\n***\n');
			});
		});

		describe('HTML compilation', () => {
			it('should compile to HTML with proper escaping', async () => {
				const docsWithSpecialChars = [{
					id: 'doc1',
					title: 'Chapter & Title',
					content: 'Content with <tags> & "quotes"',
				}];

				const result = await compilationService.compileDocuments(docsWithSpecialChars, {
					outputFormat: 'html',
				});

				expect(result).toContain('Chapter &amp; Title');
				expect(result).toContain('Content with &lt;tags&gt; &amp; &quot;quotes&quot;');
				expect(result).toContain('<!DOCTYPE html>');
			});

			it('should apply formatting styles', async () => {
				const result = await compilationService.compileDocuments(mockDocuments, {
					outputFormat: 'html',
				});

				expect(result).toContain('<b>Chapter 2 </b>');
				expect(result).toContain('<i>content</i>');
			});
		});

		describe('LaTeX compilation', () => {
			it('should compile to LaTeX with proper escaping', async () => {
				const docsWithSpecialChars = [{
					id: 'doc1',
					title: 'Chapter_with_underscores',
					content: 'Content with $math$ and %percent',
				}];

				const result = await compilationService.compileDocuments(docsWithSpecialChars, {
					outputFormat: 'latex',
				});

				expect(result).toContain('\\section{Chapter\\_with\\_underscores}');
				expect(result).toContain('Content with \\$math\\$ and \\%percent');
				expect(result).toContain('\\documentclass{article}');
				expect(result).toContain('\\begin{document}');
				expect(result).toContain('\\end{document}');
			});
		});

		describe('Text compilation', () => {
			it('should compile to plain text', async () => {
				const result = await compilationService.compileDocuments(mockDocuments, {
					outputFormat: 'text',
				});

				expect(result).toBe('Chapter 1 content\n\n---\n\nChapter 2 content');
			});

			it('should handle string content', async () => {
				const docsWithStringContent = [
					{ id: 'doc1', title: 'Title', content: 'Plain string content' },
				];

				const result = await compilationService.compileDocuments(docsWithStringContent, {
					outputFormat: 'text',
				});

				expect(result).toBe('Plain string content');
			});
		});

		it('should throw error for unsupported format', async () => {
			await expect(
				compilationService.compileDocuments(mockDocuments, {
					outputFormat: 'unsupported' as any,
				})
			).rejects.toThrow('Unsupported output format: unsupported');
		});
	});

	describe('extractAnnotations', () => {
		it('should extract annotations from RTF content', () => {
			const mockAnnotations = new Map([
				['annotation1', 'This is an annotation'],
				['comment1', 'This is a comment'],
				['footnote1', 'This is a footnote'],
			]);

			mockRtfHandler.preserveScrivenerAnnotations = jest.fn().mockReturnValue(mockAnnotations);

			const rtfContent = '{\\rtf1 Some content with annotations}';
			const result = compilationService.extractAnnotations(rtfContent);

			expect(result).toBe(mockAnnotations);
			expect(mockRtfHandler.preserveScrivenerAnnotations).toHaveBeenCalledWith(rtfContent);
		});

		it('should return empty map for content without annotations', () => {
			mockRtfHandler.preserveScrivenerAnnotations = jest.fn().mockReturnValue(new Map());

			const result = compilationService.extractAnnotations('{\\rtf1 Plain content}');

			expect(result.size).toBe(0);
		});
	});

	describe('searchInDocuments', () => {
		const mockSearchDocs = [
			{
				id: 'doc1',
				title: 'Test Document',
				content: 'This is a test document with some content about testing.',
				metadata: {
					synopsis: 'A document for testing search',
					notes: 'Contains test-related content',
					keywords: ['test', 'search', 'document'],
				},
			},
			{
				id: 'doc2',
				title: 'Another Document',
				content: 'This document has different content without the search term.',
				metadata: {
					synopsis: 'Another synopsis',
					notes: 'Different notes',
				},
			},
		];

		it('should find matches in content', () => {
			const results = compilationService.searchInDocuments(mockSearchDocs, 'test');

			expect(results).toHaveLength(1);
			expect(results[0].documentId).toBe('doc1');
			expect(results[0].matches.length).toBeGreaterThan(0);
			expect(results[0].wordCount).toBe(10);
		});

		it('should perform case-sensitive search when enabled', () => {
			// Search for 'This' which is capitalized in the content
			const results = compilationService.searchInDocuments(mockSearchDocs, 'This', {
				caseSensitive: true,
			});

			expect(results).toHaveLength(2); // Both docs start with 'This'
			
			// Search for 'test' lowercase should find matches
			const resultsLowercase = compilationService.searchInDocuments(mockSearchDocs, 'test', {
				caseSensitive: true,
			});

			expect(resultsLowercase).toHaveLength(1);
			expect(resultsLowercase[0].documentId).toBe('doc1');
			expect(resultsLowercase[0].matches.length).toBeGreaterThan(0);
		});

		it('should search in metadata when enabled', () => {
			const results = compilationService.searchInDocuments(mockSearchDocs, 'synopsis', {
				searchMetadata: true,
			});

			expect(results).toHaveLength(1); // Only doc2 has 'synopsis' in metadata
			expect(results[0].documentId).toBe('doc2');
			expect(results[0].matches).toContainEqual(expect.stringContaining('Synopsis: '));
		});

		it('should search in keywords', () => {
			const results = compilationService.searchInDocuments(mockSearchDocs, 'search', {
				searchMetadata: true,
			});

			expect(results).toHaveLength(2); // Both docs have 'search' (doc1 in keyword, doc2 in content)
			// Find the doc1 result
			const doc1Result = results.find(r => r.documentId === 'doc1');
			expect(doc1Result?.matches).toContainEqual('Keyword: search');
		});

		it('should limit results when maxResults is set', () => {
			const manyDocs = Array(10).fill(null).map((_, i) => ({
				id: `doc${i}`,
				title: `Document ${i}`,
				content: `Content with test in document ${i}`,
				metadata: {},
			}));

			const results = compilationService.searchInDocuments(manyDocs, 'test', {
				maxResults: 3,
			});

			expect(results).toHaveLength(3);
		});

		it('should handle regex search', () => {
			const results = compilationService.searchInDocuments(mockSearchDocs, 'test.*document', {
				regex: true,
			});

			expect(results).toHaveLength(1);
			expect(results[0].documentId).toBe('doc1');
		});

		it('should handle invalid regex gracefully', () => {
			const results = compilationService.searchInDocuments(mockSearchDocs, '[invalid(regex', {
				regex: true,
			});

			expect(results).toHaveLength(0);
		});
	});

	describe('exportProject', () => {
		const mockStructure: any[] = [
			{
				id: 'doc1',
				title: 'Chapter 1',
				type: 'Text',
				path: '/Draft/Chapter 1',
				content: 'Chapter 1 content',
				synopsis: 'Chapter 1 synopsis',
				keywords: ['chapter', 'one'],
				status: 'Draft',
				wordCount: 100,
				children: [],
			},
			{
				id: 'folder1',
				title: 'Part 1',
				type: 'Folder',
				path: '/Draft/Part 1',
				children: [
					{
						id: 'doc2',
						title: 'Chapter 2',
						type: 'Text',
						path: '/Draft/Part 1/Chapter 2',
						content: 'Chapter 2 content',
						children: [],
					},
				],
			},
		];

		describe('Markdown export', () => {
			it('should export with default options', async () => {
				const result = await compilationService.exportProject(mockStructure, 'markdown');

				expect(result.format).toBe('markdown');
				expect(result.content).toContain('# Chapter 1');
				expect(result.content).toContain('> Chapter 1 synopsis');
				expect(result.content).toContain('**Keywords:** chapter, one');
				expect(result.content).toContain('Chapter 1 content');
				expect(result.metadata.documentCount).toBe(3);
			});

			it('should respect maxDepth option', async () => {
				const result = await compilationService.exportProject(mockStructure, 'markdown', {
					maxDepth: 0,
				});

				expect(result.content).toContain('Chapter 1');
				expect(result.content).not.toContain('Chapter 2');
			});

			it('should include status and word count when options are set', async () => {
				const result = await compilationService.exportProject(mockStructure, 'markdown', {
					includeStatus: true,
					includeWordCounts: true,
				});

				expect(result.content).toContain('**Status:** Draft');
				expect(result.content).toContain('**Word Count:** 100');
			});

			it('should exclude metadata when option is false', async () => {
				const result = await compilationService.exportProject(mockStructure, 'markdown', {
					includeMetadata: false,
				});

				expect(result.content).not.toContain('> Chapter 1 synopsis');
				expect(result.content).not.toContain('**Keywords:**');
			});
		});

		describe('HTML export', () => {
			it('should export with proper HTML structure', async () => {
				const result = await compilationService.exportProject(mockStructure, 'html');

				expect(result.format).toBe('html');
				expect(result.content).toContain('<!DOCTYPE html>');
				expect(result.content).toContain('<h1>Chapter 1</h1>');
				expect(result.content).toContain('<p class="synopsis">Chapter 1 synopsis</p>');
				expect(result.content).toContain('<p class="keywords">Keywords: chapter, one</p>');
			});

			it('should include custom styles for status and word count', async () => {
				const result = await compilationService.exportProject(mockStructure, 'html', {
					includeStatus: true,
					includeWordCounts: true,
				});

				expect(result.content).toContain('.status { color: #007acc; font-weight: bold; }');
				expect(result.content).toContain('.word-count { color: #888; font-size: 0.8em; }');
				expect(result.content).toContain('<p class="status">Status: Draft</p>');
				expect(result.content).toContain('<p class="word-count">Word Count: 100</p>');
			});

			it('should respect maxDepth option', async () => {
				const result = await compilationService.exportProject(mockStructure, 'html', {
					maxDepth: 0,
				});

				expect(result.content).toContain('Chapter 1');
				expect(result.content).not.toContain('Chapter 2');
			});
		});

		describe('JSON export', () => {
			it('should export as JSON string', async () => {
				const result = await compilationService.exportProject(mockStructure, 'json');

				expect(result.format).toBe('json');
				const parsed = JSON.parse(result.content);
				expect(parsed).toEqual(mockStructure);
			});
		});

		it('should throw error for EPUB format (not implemented)', async () => {
			await expect(
				compilationService.exportProject(mockStructure, 'epub')
			).rejects.toThrow('EPUB export not yet implemented');
		});

		it('should throw error for unsupported format', async () => {
			await expect(
				compilationService.exportProject(mockStructure, 'pdf')
			).rejects.toThrow('Unsupported export format: pdf');
		});
	});

	describe('getStatistics', () => {
		it('should calculate project statistics', () => {
			const documents: any[] = [
				{ id: '1', title: 'Doc1', type: 'Text', path: '/Draft/Doc1', children: [] },
				{ id: '2', title: 'Folder1', type: 'Folder', path: '/Draft/Folder1', children: [
					{ id: '3', title: 'Doc2', type: 'Text', path: '/Draft/Folder1/Doc2', children: [] },
				]},
			];

			const stats = compilationService.getStatistics(documents);

			expect(stats).toMatchObject({
				totalDocuments: 3,
				textDocuments: 2,
				folders: 1,
				documentsByType: {
					Text: 2,
					Folder: 1,
				},
			});
		});
	});
});