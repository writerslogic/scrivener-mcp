/**
 * Web Content Parser Service
 * Extracts and processes content from HTML sources using Cheerio
 */

import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import type { ContentExtractionOptions } from './types/analysis.js';

export interface ParsedWebContent {
	title?: string;
	author?: string;
	publishDate?: string;
	content: string;
	summary?: string;
	metadata: {
		wordCount?: number;
		paragraphCount?: number;
		imageCount?: number;
		linkCount?: number;
		headingCount?: number;
		[key: string]: string | number | boolean | undefined;
	};
	links: Array<{
		text: string;
		url: string;
		type?: 'internal' | 'external' | string;
	}>;
	images: Array<{
		alt?: string;
		src?: string;
		url?: string;
		title?: string;
		caption?: string;
	}>;
	headings?: Array<{
		level: number;
		text: string;
		id?: string;
	}>;
}

export interface ResearchExtraction {
	facts: string[];
	quotes: string[];
	statistics: string[];
	sources: string[];
	keyTerms: string[];
	relevanceScore: number;
}

// ContentExtractionOptions is imported from types/analysis.js

export class WebContentParser {
	private turndownService: TurndownService;

	constructor() {
		this.turndownService = new TurndownService({
			headingStyle: 'atx',
			bulletListMarker: '-',
			codeBlockStyle: 'fenced',
		});

		// Configure turndown service for better markdown conversion
		this.turndownService.addRule('removeComments', {
			filter: (node) => node.nodeType === 8,
			replacement: () => '',
		});

		this.turndownService.addRule('removeScript', {
			filter: ['script', 'style', 'noscript'],
			replacement: () => '',
		});
	}

	/**
	 * Parse HTML content and extract structured data
	 */
	parseHtmlContent(
		html: string,
		baseUrl?: string,
		options: ContentExtractionOptions = {}
	): ParsedWebContent {
		const $ = cheerio.load(html);

		// Remove unwanted elements
		if (options.removeElements) {
			options.removeElements.forEach((selector) => {
				$(selector).remove();
			});
		}

		// Remove scripts, styles, and other non-content elements
		$(
			'script, style, noscript, nav, footer, aside, .ads, .advertisement, .social-share'
		).remove();

		// Extract metadata
		const title = this.extractTitle($);
		const author = this.extractAuthor($);
		const publishDate = this.extractPublishDate($);

		// Extract main content
		const content = this.extractMainContent($, options.mainContentSelector);
		const summary = this.extractSummary($);

		// Extract structural elements
		const links = options.includeLinks ? this.extractLinks($, baseUrl) : [];
		const images = options.includeImages ? this.extractImages($, baseUrl) : [];
		const headings = options.includeHeadings ? this.extractHeadings($) : [];

		// Calculate metadata
		const metadata = this.calculateMetadata($, content);

		return {
			title,
			author,
			publishDate,
			content: options.convertToMarkdown ? this.turndownService.turndown(content) : content,
			summary,
			metadata,
			links,
			images,
			headings,
		};
	}

	/**
	 * Extract research-relevant data from parsed content
	 */
	extractResearchData(parsedContent: ParsedWebContent, keywords?: string[]): ResearchExtraction {
		const $ = cheerio.load(parsedContent.content);
		const text = $('body').text() || parsedContent.content;

		// Extract facts (sentences with specific patterns)
		const facts = this.extractFacts(text);

		// Extract quotes (text in quotation marks or blockquotes)
		const quotes = this.extractQuotes($, text);

		// Extract statistics (numbers with context)
		const statistics = this.extractStatistics(text);

		// Extract sources (citations, references)
		const sources = this.extractSources($, parsedContent.links);

		// Extract key terms
		const keyTerms = this.extractKeyTerms(text, keywords);

		// Calculate relevance score
		const relevanceScore = this.calculateRelevanceScore(text, keyTerms, keywords);

		return {
			facts,
			quotes,
			statistics,
			sources,
			keyTerms,
			relevanceScore,
		};
	}

	/**
	 * Convert HTML to clean, readable markdown
	 */
	htmlToMarkdown(
		html: string,
		options?: { preserveImages?: boolean; preserveLinks?: boolean }
	): string {
		if (options?.preserveImages === false) {
			html = html.replace(/<img[^>]*>/gi, '');
		}

		if (options?.preserveLinks === false) {
			html = html.replace(/<a[^>]*>(.*?)<\/a>/gi, '$1');
		}

		return this.turndownService.turndown(html);
	}

	/**
	 * Extract article or blog post content from common CMS structures
	 */
	extractArticleContent(html: string): { title: string; content: string; metadata: any } {
		const $ = cheerio.load(html);

		// Try common article selectors
		const articleSelectors = [
			'article',
			'.post-content',
			'.entry-content',
			'.article-content',
			'.content',
			'main',
			'.main-content',
		];

		let articleContent = '';
		for (const selector of articleSelectors) {
			const element = $(selector);
			if (element.length > 0 && element.text().trim().length > 200) {
				articleContent = element.html() || '';
				break;
			}
		}

		// Fallback to body if no article content found
		if (!articleContent) {
			articleContent = $('body').html() || html;
		}

		return {
			title: this.extractTitle($),
			content: this.turndownService.turndown(articleContent),
			metadata: this.extractArticleMetadata($),
		};
	}

	/**
	 * Extract main content using various strategies
	 */
	private extractMainContent($: cheerio.Root, selector?: string): string {
		if (selector) {
			const selected = $(selector);
			if (selected.length > 0) {
				return selected.html() || '';
			}
		}

		// Try common content selectors in order of preference
		const contentSelectors = [
			'article',
			'.post-content',
			'.entry-content',
			'.article-content',
			'.content',
			'main .content',
			'#content',
			'.main-content',
			'main',
		];

		for (const selector of contentSelectors) {
			const element = $(selector);
			if (element.length > 0) {
				const text = element.text().trim();
				if (text.length > 100) {
					// Ensure substantial content
					return element.html() || '';
				}
			}
		}

		// Fallback: extract from body, removing navigation and sidebars
		$('nav, .nav, .navigation, .sidebar, .side-bar, header, footer').remove();
		return $('body').html() || '';
	}

	/**
	 * Extract title using multiple strategies
	 */
	private extractTitle($: cheerio.Root): string {
		// Try different title sources in order of preference
		const titleSources = [
			'h1',
			'.title',
			'.post-title',
			'.article-title',
			'.entry-title',
			'title',
			'[property="og:title"]',
			'[name="twitter:title"]',
		];

		for (const source of titleSources) {
			const element = $(source);
			if (element.length > 0) {
				const title =
					source === 'title' || source.includes('[')
						? element.attr('content') || element.text()
						: element.text();

				if (title && title.trim().length > 0) {
					return title.trim();
				}
			}
		}

		return 'Untitled';
	}

	/**
	 * Extract author information
	 */
	private extractAuthor($: cheerio.Root): string | undefined {
		const authorSelectors = [
			'.author',
			'.byline',
			'.post-author',
			'.article-author',
			'[rel="author"]',
			'[property="author"]',
			'[name="author"]',
		];

		for (const selector of authorSelectors) {
			const element = $(selector);
			if (element.length > 0) {
				const author = element.attr('content') || element.text();
				if (author && author.trim().length > 0) {
					return author.trim();
				}
			}
		}

		return undefined;
	}

	/**
	 * Extract publish date
	 */
	private extractPublishDate($: cheerio.Root): string | undefined {
		const dateSelectors = [
			'time[datetime]',
			'.date',
			'.publish-date',
			'.post-date',
			'[property="article:published_time"]',
			'[name="date"]',
		];

		for (const selector of dateSelectors) {
			const element = $(selector);
			if (element.length > 0) {
				const date = element.attr('datetime') || element.attr('content') || element.text();
				if (date && date.trim().length > 0) {
					return date.trim();
				}
			}
		}

		return undefined;
	}

	/**
	 * Extract summary or description
	 */
	private extractSummary($: cheerio.Root): string | undefined {
		const summarySelectors = [
			'.summary',
			'.excerpt',
			'.description',
			'[name="description"]',
			'[property="og:description"]',
			'[name="twitter:description"]',
		];

		for (const selector of summarySelectors) {
			const element = $(selector);
			if (element.length > 0) {
				const summary = element.attr('content') || element.text();
				if (summary && summary.trim().length > 0) {
					return summary.trim();
				}
			}
		}

		return undefined;
	}

	/**
	 * Extract all links from content
	 */
	private extractLinks(
		$: cheerio.Root,
		baseUrl?: string
	): Array<{ text: string; url: string; type: 'internal' | 'external' }> {
		const links: Array<{ text: string; url: string; type: 'internal' | 'external' }> = [];

		$('a[href]').each((_, element) => {
			const $el = $(element);
			const href = $el.attr('href');
			const text = $el.text().trim();

			if (href && text) {
				let url = href;

				// Convert relative URLs to absolute if baseUrl provided
				if (baseUrl && href.startsWith('/')) {
					url = new URL(href, baseUrl).href;
				}

				const type =
					href.startsWith('http') && baseUrl && !href.includes(new URL(baseUrl).hostname)
						? 'external'
						: 'internal';

				links.push({ text, url, type });
			}
		});

		return links;
	}

	/**
	 * Extract all images from content
	 */
	private extractImages(
		$: cheerio.Root,
		baseUrl?: string
	): Array<{ alt: string; src: string; title?: string }> {
		const images: Array<{ alt: string; src: string; title?: string }> = [];

		$('img[src]').each((_, element) => {
			const $el = $(element);
			const src = $el.attr('src');
			const alt = $el.attr('alt') || '';
			const title = $el.attr('title');

			if (src) {
				let imageSrc = src;

				// Convert relative URLs to absolute if baseUrl provided
				if (baseUrl && src.startsWith('/')) {
					imageSrc = new URL(src, baseUrl).href;
				}

				images.push({ alt, src: imageSrc, title });
			}
		});

		return images;
	}

	/**
	 * Extract headings structure
	 */
	private extractHeadings($: cheerio.Root): Array<{ level: number; text: string; id?: string }> {
		const headings: Array<{ level: number; text: string; id?: string }> = [];

		$('h1, h2, h3, h4, h5, h6').each((_, element) => {
			const $el = $(element);
			const tagName = (element as any).tagName || (element as any).name || 'h1';
			const level = parseInt(tagName.charAt(1)) || 1;
			const text = $el.text().trim();
			const id = $el.attr('id');

			if (text) {
				headings.push({ level, text, id });
			}
		});

		return headings;
	}

	/**
	 * Calculate content metadata
	 */
	private calculateMetadata($: cheerio.Root, content: string): ParsedWebContent['metadata'] {
		const contentDoc = cheerio.load(content);
		const bodyText = contentDoc('body').text();
		const text = bodyText || content.replace(/<[^>]*>/g, ''); // Strip HTML as fallback
		const words = text
			.trim()
			.split(/\s+/)
			.filter((word: string) => word.length > 0);

		return {
			wordCount: words.length,
			paragraphCount: $('p').length,
			imageCount: $('img').length,
			linkCount: $('a[href]').length,
			headingCount: $('h1, h2, h3, h4, h5, h6').length,
		};
	}

	/**
	 * Extract factual statements
	 */
	private extractFacts(text: string): string[] {
		const facts: string[] = [];
		const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);

		// Look for sentences with factual patterns
		const factPatterns = [
			/\b\d+(\.\d+)?%?\b/, // Numbers/percentages
			/\b(according to|research shows|studies indicate|data reveals)\b/i,
			/\b(proved|demonstrated|discovered|found|established)\b/i,
			/\b(since|during|in \d{4}|between \d{4})\b/i, // Time references
		];

		sentences.forEach((sentence) => {
			if (
				sentence.trim().length > 20 &&
				factPatterns.some((pattern) => pattern.test(sentence))
			) {
				facts.push(sentence.trim());
			}
		});

		return facts.slice(0, 20); // Limit to 20 facts
	}

	/**
	 * Extract quotes from content
	 */
	private extractQuotes($: cheerio.Root, text: string): string[] {
		const quotes: string[] = [];

		// Extract blockquotes
		$('blockquote').each((_, element) => {
			const quote = $(element).text().trim();
			if (quote.length > 10) {
				quotes.push(quote);
			}
		});

		// Extract quoted text from content
		const quotedText = text.match(/"([^"]{20,500})"/g);
		if (quotedText) {
			quotedText.forEach((quote) => {
				quotes.push(quote.replace(/"/g, '').trim());
			});
		}

		return [...new Set(quotes)].slice(0, 10); // Remove duplicates, limit to 10
	}

	/**
	 * Extract statistics and numerical data
	 */
	private extractStatistics(text: string): string[] {
		const statistics: string[] = [];
		const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);

		// Look for sentences with statistical patterns
		const statPatterns = [
			/\b\d+(\.\d+)?%\b/, // Percentages
			/\b\d{1,3}(,\d{3})*(\.\d+)?\b/, // Large numbers with commas
			/\b(increased|decreased|rose|fell|dropped) by \d+/i,
			/\b\d+ (times|fold) (more|less|higher|lower)\b/i,
		];

		sentences.forEach((sentence) => {
			if (
				sentence.trim().length > 15 &&
				statPatterns.some((pattern) => pattern.test(sentence))
			) {
				statistics.push(sentence.trim());
			}
		});

		return statistics.slice(0, 15); // Limit to 15 statistics
	}

	/**
	 * Extract source references
	 */
	private extractSources($: cheerio.Root, links: ParsedWebContent['links']): string[] {
		const sources: string[] = [];

		// Add external links as potential sources
		links
			.filter((link) => link.type === 'external')
			.forEach((link) => {
				sources.push(`${link.text} (${link.url})`);
			});

		// Look for citation patterns
		$('.citation, .reference, .source').each((_, element) => {
			const citation = $(element).text().trim();
			if (citation.length > 5) {
				sources.push(citation);
			}
		});

		return [...new Set(sources)].slice(0, 10); // Remove duplicates, limit to 10
	}

	/**
	 * Extract key terms from content
	 */
	private extractKeyTerms(text: string, keywords?: string[]): string[] {
		const words = text
			.toLowerCase()
			.replace(/[^\w\s]/g, ' ')
			.split(/\s+/)
			.filter((word) => word.length > 3);

		// Count word frequency
		const frequency: { [key: string]: number } = {};
		words.forEach((word) => {
			frequency[word] = (frequency[word] || 0) + 1;
		});

		// Get most frequent terms
		const keyTerms = Object.entries(frequency)
			.filter(([_word, count]) => count > 2)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 20)
			.map(([word]) => word);

		// Add provided keywords if they appear in text
		if (keywords) {
			keywords.forEach((keyword) => {
				if (
					text.toLowerCase().includes(keyword.toLowerCase()) &&
					!keyTerms.includes(keyword.toLowerCase())
				) {
					keyTerms.unshift(keyword.toLowerCase());
				}
			});
		}

		return keyTerms.slice(0, 15);
	}

	/**
	 * Calculate relevance score based on key terms and keywords
	 */
	private calculateRelevanceScore(text: string, keyTerms: string[], keywords?: string[]): number {
		if (!keywords || keywords.length === 0) {
			return 0.5; // Default relevance
		}

		let matches = 0;
		const textLower = text.toLowerCase();

		keywords.forEach((keyword) => {
			const keywordLower = keyword.toLowerCase();
			if (textLower.includes(keywordLower)) {
				matches++;
				// Bonus for exact matches in key terms
				if (keyTerms.includes(keywordLower)) {
					matches += 0.5;
				}
			}
		});

		return Math.min(matches / keywords.length, 1.0);
	}

	/**
	 * Extract article-specific metadata
	 */
	private extractArticleMetadata($: cheerio.Root): any {
		const metadata: any = {};

		// Extract Open Graph and Twitter Card metadata
		$('meta[property^="og:"], meta[name^="twitter:"]').each((_, element) => {
			const $el = $(element);
			const property = $el.attr('property') || $el.attr('name');
			const content = $el.attr('content');

			if (property && content) {
				metadata[property] = content;
			}
		});

		// Extract JSON-LD structured data
		$('script[type="application/ld+json"]').each((_, element) => {
			try {
				const jsonLd = JSON.parse($(element).html() || '');
				metadata.jsonLd = jsonLd;
			} catch {
				// Ignore invalid JSON-LD
			}
		});

		return metadata;
	}
}

// Export singleton instance
export const webContentParser = new WebContentParser();
