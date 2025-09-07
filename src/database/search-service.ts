/**
 * Full-Text Search Service
 * Provides advanced search capabilities across SQLite and Neo4j
 */

import type { Neo4jManager } from './neo4j-manager.js';
import type { SQLiteManager } from './sqlite-manager.js';

export interface SearchResult {
	id: string;
	type: 'document' | 'character' | 'plot' | 'theme' | 'location';
	title: string;
	snippet: string;
	relevance: number;
	metadata?: Record<string, any>;
}

export interface SearchOptions {
	limit?: number;
	offset?: number;
	types?: Array<'document' | 'character' | 'plot' | 'theme' | 'location'>;
	fuzzy?: boolean;
	caseSensitive?: boolean;
	wholeWord?: boolean;
	dateRange?: { from?: string; to?: string };
	sortBy?: 'relevance' | 'date' | 'title';
}

export class SearchService {
	constructor(
		private sqliteManager: SQLiteManager | null,
		private neo4jManager: Neo4jManager | null
	) {}

	/**
	 * Perform full-text search across all content
	 */
	async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
		const results: SearchResult[] = [];
		const {
			limit = 50,
			offset = 0,
			types = ['document', 'character', 'plot', 'theme', 'location'],
			sortBy = 'relevance',
		} = options;

		// Prepare search query
		const searchQuery = this.prepareSearchQuery(query, options);

		// Search documents if requested
		if (types.includes('document') && this.sqliteManager) {
			const docResults = await this.searchDocuments(searchQuery, options);
			results.push(...docResults);
		}

		// Search characters if requested
		if (types.includes('character')) {
			const charResults = await this.searchCharacters(searchQuery, options);
			results.push(...charResults);
		}

		// Search plot threads if requested
		if (types.includes('plot')) {
			const plotResults = await this.searchPlotThreads(searchQuery, options);
			results.push(...plotResults);
		}

		// Search themes if requested
		if (types.includes('theme')) {
			const themeResults = await this.searchThemes(searchQuery, options);
			results.push(...themeResults);
		}

		// Search locations if requested
		if (types.includes('location')) {
			const locResults = await this.searchLocations(searchQuery, options);
			results.push(...locResults);
		}

		// Sort results
		const sorted = this.sortResults(results, sortBy);

		// Apply pagination
		return sorted.slice(offset, offset + limit);
	}

	/**
	 * Search within documents using FTS5
	 */
	private async searchDocuments(query: string, options: SearchOptions): Promise<SearchResult[]> {
		if (!this.sqliteManager) return [];

		try {
			const ftsQuery = options.fuzzy ? `"${query}"*` : `"${query}"`;

			const sql = `
				SELECT
					d.id,
					d.title,
					COALESCE(snippet(documents_fts, 1, '<mark>', '</mark>', '...', 64), d.synopsis) as snippet,
					rank * -1 as relevance,
					d.type as doc_type,
					d.modified_at
				FROM documents_fts
				JOIN documents d ON documents_fts.id = d.id
				WHERE documents_fts MATCH ?
				${options.dateRange ? 'AND d.modified_at BETWEEN ? AND ?' : ''}
				ORDER BY rank
				LIMIT 100
			`;

			const params = [ftsQuery];
			if (options.dateRange) {
				params.push(options.dateRange.from || '1900-01-01');
				params.push(options.dateRange.to || '2100-01-01');
			}

			const results = this.sqliteManager.query(sql, params) as any[];

			return results.map((r) => ({
				id: r.id,
				type: 'document' as const,
				title: r.title,
				snippet: r.snippet,
				relevance: Math.abs(r.relevance),
				metadata: {
					docType: r.doc_type,
					modifiedAt: r.modified_at,
				},
			}));
		} catch (error) {
			console.error('Document search error:', error);
			return [];
		}
	}

	/**
	 * Search characters
	 */
	private async searchCharacters(query: string, options: SearchOptions): Promise<SearchResult[]> {
		const results: SearchResult[] = [];

		// Search in SQLite
		if (this.sqliteManager) {
			const sql = `
				SELECT id, name, description, role
				FROM characters
				WHERE name LIKE ? OR description LIKE ?
			`;

			const searchPattern = options.fuzzy ? `%${query}%` : query;
			const sqlResults = this.sqliteManager.query(sql, [
				searchPattern,
				searchPattern,
			]) as any[];

			results.push(
				...sqlResults.map((r) => ({
					id: r.id,
					type: 'character' as const,
					title: r.name,
					snippet: this.createSnippet(r.description, query),
					relevance: this.calculateRelevance(`${r.name} ${r.description}`, query),
					metadata: { role: r.role },
				}))
			);
		}

		// Search in Neo4j for relationships
		if (this.neo4jManager?.isAvailable()) {
			const cypherResults = await this.neo4jManager.query(
				`
				MATCH (c:Character)
				WHERE c.name CONTAINS $query OR c.description CONTAINS $query
				OPTIONAL MATCH (c)-[r:RELATES_TO]-(other:Character)
				WITH c, collect(DISTINCT other.name) as related
				RETURN c.id as id, c.name as name, c.description as description, related
				LIMIT 50
			`,
				{ query }
			);

			cypherResults.records.forEach((record) => {
				const existing = results.find((r) => r.id === record.get('id'));
				if (!existing) {
					results.push({
						id: record.get('id'),
						type: 'character',
						title: record.get('name'),
						snippet: this.createSnippet(record.get('description'), query),
						relevance: this.calculateRelevance(record.get('name'), query),
						metadata: { relatedCharacters: record.get('related') },
					});
				} else if (existing.metadata) {
					existing.metadata.relatedCharacters = record.get('related');
				}
			});
		}

		return results;
	}

	/**
	 * Search plot threads
	 */
	private async searchPlotThreads(
		query: string,
		options: SearchOptions
	): Promise<SearchResult[]> {
		if (!this.sqliteManager) return [];

		const sql = `
			SELECT id, name, description, status
			FROM plot_threads
			WHERE name LIKE ? OR description LIKE ?
		`;

		const searchPattern = options.fuzzy ? `%${query}%` : query;
		const results = this.sqliteManager.query(sql, [searchPattern, searchPattern]) as any[];

		return results.map((r) => ({
			id: r.id,
			type: 'plot' as const,
			title: r.name,
			snippet: this.createSnippet(r.description, query),
			relevance: this.calculateRelevance(`${r.name} ${r.description}`, query),
			metadata: { status: r.status },
		}));
	}

	/**
	 * Search themes
	 */
	private async searchThemes(query: string, options: SearchOptions): Promise<SearchResult[]> {
		if (!this.sqliteManager) return [];

		const sql = `
			SELECT id, name, description
			FROM themes
			WHERE name LIKE ? OR description LIKE ?
		`;

		const searchPattern = options.fuzzy ? `%${query}%` : query;
		const results = this.sqliteManager.query(sql, [searchPattern, searchPattern]) as any[];

		return results.map((r) => ({
			id: r.id,
			type: 'theme' as const,
			title: r.name,
			snippet: this.createSnippet(r.description, query),
			relevance: this.calculateRelevance(`${r.name} ${r.description}`, query),
		}));
	}

	/**
	 * Search locations
	 */
	private async searchLocations(query: string, options: SearchOptions): Promise<SearchResult[]> {
		if (!this.sqliteManager) return [];

		const sql = `
			SELECT id, name, description, type, significance
			FROM locations
			WHERE name LIKE ? OR description LIKE ?
		`;

		const searchPattern = options.fuzzy ? `%${query}%` : query;
		const results = this.sqliteManager.query(sql, [searchPattern, searchPattern]) as any[];

		return results.map((r) => ({
			id: r.id,
			type: 'location' as const,
			title: r.name,
			snippet: this.createSnippet(r.description, query),
			relevance: this.calculateRelevance(`${r.name} ${r.description}`, query),
			metadata: {
				locationType: r.type,
				significance: r.significance,
			},
		}));
	}

	/**
	 * Semantic search using embeddings (future enhancement)
	 */
	async semanticSearch(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
		// This would integrate with OpenAI embeddings for semantic search
		// For now, fall back to regular search
		return this.search(query, options);
	}

	/**
	 * Search for connections between entities
	 */
	async searchConnections(
		entity1: string,
		entity2: string,
		maxHops: number = 3
	): Promise<
		Array<{
			path: string[];
			length: number;
			type: string;
		}>
	> {
		if (!this.neo4jManager?.isAvailable()) {
			return [];
		}

		const result = await this.neo4jManager.query(
			`
			MATCH path = shortestPath(
				(start)-[*..${maxHops}]-(end)
			)
			WHERE (start.name = $entity1 OR start.id = $entity1)
			AND (end.name = $entity2 OR end.id = $entity2)
			RETURN [n in nodes(path) | COALESCE(n.name, n.title, n.id)] as path,
				   length(path) as length,
				   [r in relationships(path) | type(r)] as types
			LIMIT 5
		`,
			{ entity1, entity2 }
		);

		return result.records.map((r) => ({
			path: r.get('path'),
			length: r.get('length'),
			type: r.get('types').join(' -> '),
		}));
	}

	/**
	 * Helper methods
	 */
	private prepareSearchQuery(query: string, options: SearchOptions): string {
		let prepared = query;

		// Handle whole word search
		if (options.wholeWord) {
			prepared = `\\b${prepared}\\b`;
		}

		// Handle case sensitivity
		if (!options.caseSensitive) {
			prepared = prepared.toLowerCase();
		}

		return prepared;
	}

	private createSnippet(text: string, query: string, maxLength: number = 150): string {
		if (!text) return '';

		const lowerText = text.toLowerCase();
		const lowerQuery = query.toLowerCase();
		const index = lowerText.indexOf(lowerQuery);

		if (index === -1) {
			return text.substring(0, maxLength) + (text.length > maxLength ? '...' : '');
		}

		const start = Math.max(0, index - 50);
		const end = Math.min(text.length, index + query.length + 50);
		let snippet = text.substring(start, end);

		if (start > 0) snippet = `...${snippet}`;
		if (end < text.length) snippet = `${snippet}...`;

		// Highlight the match
		const regex = new RegExp(`(${query})`, 'gi');
		snippet = snippet.replace(regex, '<mark>$1</mark>');

		return snippet;
	}

	private calculateRelevance(text: string, query: string): number {
		if (!text) return 0;

		const lowerText = text.toLowerCase();
		const lowerQuery = query.toLowerCase();

		// Exact match gets highest score
		if (lowerText === lowerQuery) return 100;

		// Title/name match gets high score
		if (lowerText.startsWith(lowerQuery)) return 80;

		// Count occurrences
		const regex = new RegExp(lowerQuery, 'gi');
		const matches = text.match(regex);
		const occurrences = matches ? matches.length : 0;

		// Calculate score based on occurrences and position
		const index = lowerText.indexOf(lowerQuery);
		const positionScore = index === -1 ? 0 : (1 - index / lowerText.length) * 20;
		const occurrenceScore = Math.min(occurrences * 10, 50);

		return positionScore + occurrenceScore;
	}

	private sortResults(results: SearchResult[], sortBy: string): SearchResult[] {
		switch (sortBy) {
			case 'relevance':
				return results.sort((a, b) => b.relevance - a.relevance);
			case 'title':
				return results.sort((a, b) => a.title.localeCompare(b.title));
			case 'date':
				return results.sort((a, b) => {
					const dateA = a.metadata?.modifiedAt || '0';
					const dateB = b.metadata?.modifiedAt || '0';
					return dateB.localeCompare(dateA);
				});
			default:
				return results;
		}
	}

	/**
	 * Get search suggestions based on partial input
	 */
	async getSuggestions(partial: string, limit: number = 10): Promise<string[]> {
		const suggestions: Set<string> = new Set();

		if (this.sqliteManager) {
			// Get character names
			const chars = this.sqliteManager.query(
				'SELECT DISTINCT name FROM characters WHERE name LIKE ? LIMIT ?',
				[`${partial}%`, limit]
			) as Array<{ name: string }>;
			chars.forEach((c) => suggestions.add(c.name));

			// Get document titles
			const docs = this.sqliteManager.query(
				'SELECT DISTINCT title FROM documents WHERE title LIKE ? LIMIT ?',
				[`${partial}%`, limit]
			) as Array<{ title: string }>;
			docs.forEach((d) => suggestions.add(d.title));

			// Get plot thread names
			const plots = this.sqliteManager.query(
				'SELECT DISTINCT name FROM plot_threads WHERE name LIKE ? LIMIT ?',
				[`${partial}%`, limit]
			) as Array<{ name: string }>;
			plots.forEach((p) => suggestions.add(p.name));
		}

		return Array.from(suggestions).slice(0, limit);
	}
}
