import { AppError, ErrorCode, safeStringify } from '../../utils/common.js';
import { SQLQueryBuilder } from './query-builder.js';
import type { SQLiteManager } from './sqlite-manager.js';
import type { Neo4jManager } from './neo4j-manager.js';
import type { RelationshipEngine } from '../../services/relationship-engine.js';
import type { TransactionCoordinator } from './transaction-coordinator.js';

/** Two-phase document sync, character sync and relationship writes across the stores. */
export class DatabaseSync {
	constructor(
		private readonly getSqlite: () => SQLiteManager | null,
		private readonly getNeo4j: () => Neo4jManager | null,
		private readonly getRelationshipEngine: () => RelationshipEngine | null,
		private readonly transactions: TransactionCoordinator
	) {}

	private get sqliteManager(): SQLiteManager | null {
		return this.getSqlite();
	}

	private get neo4jManager(): Neo4jManager | null {
		return this.getNeo4j();
	}

	private get relationshipEngine(): RelationshipEngine | null {
		return this.getRelationshipEngine();
	}

	private beginTransaction(): Promise<string> {
		return this.transactions.begin();
	}

	private prepareTransaction(transactionId: string): Promise<boolean> {
		return this.transactions.prepare(transactionId);
	}

	private commitTransaction(transactionId: string): Promise<void> {
		return this.transactions.commit(transactionId);
	}

	private rollbackTransaction(transactionId: string): Promise<void> {
		return this.transactions.rollback(transactionId);
	}

	/**
	 * Sync document data with two-phase commit
	 */
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
		const transactionId = await this.beginTransaction();
		const txn = this.transactions.get(transactionId)!;

		try {
			// Phase 1: Prepare SQLite operation
			if (this.sqliteManager) {
				const sqliteOp: (typeof txn.operations)[0] = {
					type: 'sqlite',
					operation: 'upsert_document',
					data: documentData,
					status: 'pending',
				};
				txn.operations.push(sqliteOp);

				const { sql, params } = SQLQueryBuilder.insert('documents', {
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

				const stmt = this.sqliteManager
					.getDatabase()
					.prepare(sql.replace('INSERT', 'INSERT OR REPLACE'));
				stmt.run(params);

				sqliteOp.status = 'prepared';
			}

			// Phase 1: Prepare Neo4j operation
			if (this.neo4jManager && this.neo4jManager.isAvailable()) {
				const neo4jOp: (typeof txn.operations)[0] = {
					type: 'neo4j',
					operation: 'upsert_document',
					data: documentData,
					status: 'pending',
				};
				txn.operations.push(neo4jOp);

				await this.neo4jManager.upsertDocument(documentData);
				neo4jOp.status = 'prepared';
			}

			// Phase 2: Prepare and commit
			const prepared = await this.prepareTransaction(transactionId);
			if (prepared) {
				await this.commitTransaction(transactionId);
			} else {
				throw new AppError('Failed to prepare transaction', ErrorCode.DATABASE_ERROR);
			}
		} catch (error) {
			await this.rollbackTransaction(transactionId);
			throw error;
		}
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
		// Update SQLite
		if (this.sqliteManager) {
			const { sql, params } = SQLQueryBuilder.insert('characters', {
				id: characterData.id,
				name: characterData.name,
				role: characterData.role || null,
				description: characterData.description || null,
				traits: safeStringify(characterData.traits || []),
				notes: characterData.notes || null,
				modified_at: new Date().toISOString(),
			});

			const stmt = this.sqliteManager
				.getDatabase()
				.prepare(sql.replace('INSERT', 'INSERT OR REPLACE'));
			stmt.run(params);
		}

		// Update Neo4j if available
		if (this.neo4jManager) {
			await this.neo4jManager.upsertCharacter(characterData);
		}
	}

	/**
	 * Create relationships between entities
	 */
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

				stmt.run([fromId, toId, relationshipType, safeStringify(properties)]);
			}
		}

		// Store in Neo4j
		if (this.neo4jManager) {
			const fromLabel = this.getNodeLabel(fromType);
			const toLabel = this.getNodeLabel(toType);

			await this.neo4jManager.createRelationship(
				fromId,
				fromLabel,
				toId,
				toLabel,
				relationshipType,
				properties
			);
		}

		// Also write to RelationshipEngine for HMS-backed storage
		if (this.relationshipEngine) {
			await this.relationshipEngine.addRelationship({
				id: `${fromType}:${fromId}--${relationshipType}--${toType}:${toId}`,
				head: fromId,
				headType: this.getNodeLabel(fromType),
				relation: relationshipType,
				tail: toId,
				tailType: this.getNodeLabel(toType),
				properties,
			});
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
