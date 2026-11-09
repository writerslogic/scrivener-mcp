import { safeStringify } from '../../utils/common.js';
import { escapeIdentifier } from '../../utils/database.js';
import { SQLQueryBuilder } from './query-builder.js';
import type { SQLiteManager } from './sqlite-manager.js';
import type { Neo4jManager } from './neo4j-manager.js';

/** Document sync, character sync and relationship writes across the stores. */
export class DatabaseSync {
	constructor(
		private readonly getSqlite: () => SQLiteManager | null,
		private readonly getNeo4j: () => Neo4jManager | null
	) {}

	private get sqliteManager(): SQLiteManager | null {
		return this.getSqlite();
	}

	private get neo4jManager(): Neo4jManager | null {
		return this.getNeo4j();
	}

	private upsert(
		sqlite: SQLiteManager | null,
		table: 'documents' | 'characters',
		data: { id: string } & Record<string, unknown>
	): void {
		if (!sqlite) return;
		const { sql, params } = SQLQueryBuilder.insert(table, data);
		const updates = Object.keys(data)
			.filter((column) => column !== 'id')
			.map((column) => `${escapeIdentifier(column)} = excluded.${escapeIdentifier(column)}`);
		sqlite
			.getDatabase()
			.prepare(`${sql} ON CONFLICT(id) DO UPDATE SET ${updates.join(', ')}`)
			.run(...params);
	}

	/** Synchronize the optional graph before the atomic local upsert. */
	async syncDocumentData(documentData: {
		id: string;
		title: string;
		type: string;
		path: string;
		synopsis?: string;
		notes?: string;
		wordCount?: number;
		characterCount?: number;
	}): Promise<void> {
		const sqlite = this.sqliteManager;
		const neo4j = this.neo4jManager;
		if (neo4j?.isAvailable()) await neo4j.upsertDocument(documentData);
		this.upsert(sqlite, 'documents', {
			id: documentData.id,
			title: documentData.title,
			type: documentData.type,
			path: documentData.path,
			synopsis: documentData.synopsis || null,
			notes: documentData.notes || null,
			word_count: documentData.wordCount || 0,
			character_count: documentData.characterCount || 0,
			modified_at: new Date().toISOString(),
		});
	}

	/**
	 * Sync character data between databases
	 */
	async syncCharacterData(characterData: {
		id: string;
		name: string;
		role?: string;
		description?: string;
		traits?: string[];
		notes?: string;
	}): Promise<void> {
		const sqlite = this.sqliteManager;
		if (sqlite) {
			this.upsert(sqlite, 'characters', {
				id: characterData.id,
				name: characterData.name,
				role: characterData.role || null,
				description: characterData.description || null,
				traits: safeStringify(characterData.traits || []),
				notes: characterData.notes || null,
				modified_at: new Date().toISOString(),
			});
		}

		const neo4j = this.neo4jManager;
		if (neo4j?.isAvailable()) await neo4j.upsertCharacter(characterData);
	}

	async createRelationship(
		fromId: string,
		fromType: string,
		toId: string,
		toType: string,
		relationshipType: string,
		properties: Record<string, unknown> = {}
	): Promise<void> {
		// Store in SQLite relationships table
		if (this.sqliteManager) {
			if (fromType === 'document' && toType === 'document') {
				const stmt = this.sqliteManager.getDatabase().prepare(`
					INSERT OR REPLACE INTO document_relationships
					(source_document_id, target_document_id, relationship_type, notes)
					VALUES (?, ?, ?, ?)
				`);

				stmt.run(fromId, toId, relationshipType, safeStringify(properties));
			}
		}

		// Store in Neo4j
		const neo4j = this.neo4jManager;
		if (neo4j?.isAvailable()) {
			const fromLabel = this.getNodeLabel(fromType);
			const toLabel = this.getNodeLabel(toType);

			await neo4j.createRelationship(
				fromId,
				fromLabel,
				toId,
				toLabel,
				relationshipType,
				properties
			);
		}
	}

	/**
	 * Helper to get Neo4j node label from type
	 */
	private getNodeLabel(type: string): string {
		switch (type.toLowerCase()) {
			case 'document':
				return 'Document';
			case 'character':
				return 'Character';
			case 'theme':
				return 'Theme';
			case 'plot':
			case 'plotthread':
				return 'PlotThread';
			default:
				return 'Entity';
		}
	}
}
