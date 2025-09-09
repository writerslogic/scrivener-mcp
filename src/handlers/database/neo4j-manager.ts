import type { Driver, ManagedTransaction, QueryResult } from 'neo4j-driver';
import neo4j from 'neo4j-driver';
import { getLogger } from '../../core/logger.js';
import type { QueryParameters } from '../../types/database.js';
import { AppError, ErrorCode } from '../../utils/common.js';
import { waitForServiceReady } from '../../utils/condition-waiter.js';
import { extractValues, nodeToObject } from '../../utils/database.js';

const logger = getLogger('neo4j');

export class Neo4jManager {
	private driver: Driver | null = null;
	private uri: string;
	private user: string;
	private password: string;
	private database: string;
	private connectionRetries: number = 3;
	private retryDelay: number = 1000;
	private isConnected: boolean = false;
	private lastHealthCheck: Date | null = null;
	private healthCheckInterval: number = 60000; // 1 minute

	constructor(uri: string, user: string, password: string, database = 'scrivener') {
		this.uri = uri;
		this.user = user;
		this.password = password;
		this.database = database;
	}

	/**
	 * Initialize the Neo4j connection with retry logic
	 */
	async initialize(): Promise<void> {
		for (let attempt = 1; attempt <= this.connectionRetries; attempt++) {
			try {
				// Create driver with connection pool settings
				this.driver = neo4j.driver(this.uri, neo4j.auth.basic(this.user, this.password), {
					maxConnectionPoolSize: 50,
					connectionAcquisitionTimeout: 10000,
					connectionTimeout: 30000,
					maxTransactionRetryTime: 30000,
				});

				// Verify connectivity
				await this.driver.verifyConnectivity();
				this.isConnected = true;
				this.lastHealthCheck = new Date();

				// Initialize schema
				await this.createConstraints();
				await this.createIndexes();

				return; // Success
			} catch (error) {
				const isLastAttempt = attempt === this.connectionRetries;
				if (!isLastAttempt) {
					// Wait for service to be ready instead of fixed delay
					try {
						const parsedUrl = new URL(this.uri);
						await waitForServiceReady(
							parsedUrl.hostname,
							parseInt(parsedUrl.port) || 7687,
							this.retryDelay * attempt
						);
					} catch {
						// If condition wait fails (invalid URL or service check), fall back to basic exponential backoff
						await new Promise((resolve) =>
							setTimeout(resolve, this.retryDelay * attempt)
						);
					}
				} else {
					logger.warn(
						'Neo4j connection failed after retries, continuing without graph database',
						{ error }
					);
					// Don't throw - allow the app to continue with just SQLite
					this.driver = null;
					this.isConnected = false;
				}
			}
		}
	}

	/**
	 * Create database constraints
	 */
	private async createConstraints(): Promise<void> {
		if (!this.driver) return;

		const session = this.driver.session({ database: this.database });

		try {
			// Document constraints
			await session.run(`
				CREATE CONSTRAINT document_id IF NOT EXISTS
				FOR (d:Document) REQUIRE d.id IS UNIQUE
			`);

			// Character constraints
			await session.run(`
				CREATE CONSTRAINT character_id IF NOT EXISTS
				FOR (c:Character) REQUIRE c.id IS UNIQUE
			`);

			await session.run(`
				CREATE CONSTRAINT character_name IF NOT EXISTS
				FOR (c:Character) REQUIRE c.name IS UNIQUE
			`);

			// Theme constraints
			await session.run(`
				CREATE CONSTRAINT theme_id IF NOT EXISTS
				FOR (t:Theme) REQUIRE t.id IS UNIQUE
			`);

			// Plot thread constraints
			await session.run(`
				CREATE CONSTRAINT plot_thread_id IF NOT EXISTS
				FOR (p:PlotThread) REQUIRE p.id IS UNIQUE
			`);
		} finally {
			await session.close();
		}
	}

	/**
	 * Create database indexes
	 */
	private async createIndexes(): Promise<void> {
		if (!this.driver) return;

		const session = this.driver.session({ database: this.database });

		try {
			// Document indexes
			await session.run(`
				CREATE INDEX document_title IF NOT EXISTS
				FOR (d:Document) ON (d.title)
			`);

			await session.run(`
				CREATE INDEX document_type IF NOT EXISTS
				FOR (d:Document) ON (d.type)
			`);

			// Character indexes
			await session.run(`
				CREATE INDEX character_role IF NOT EXISTS
				FOR (c:Character) ON (c.role)
			`);

			// Theme indexes
			await session.run(`
				CREATE INDEX theme_name IF NOT EXISTS
				FOR (t:Theme) ON (t.name)
			`);
		} finally {
			await session.close();
		}
	}

	/**
	 * Execute a Cypher query
	 */
	async query(cypher: string, parameters: QueryParameters = {}): Promise<QueryResult> {
		if (!this.driver) {
			throw new AppError(
				'Neo4j not connected. Initialize first or check connection.',
				ErrorCode.DATABASE_ERROR
			);
		}

		const session = this.driver.session({ database: this.database });
		try {
			return await session.run(cypher, parameters);
		} finally {
			await session.close();
		}
	}

	/**
	 * Execute a read transaction
	 */
	async readTransaction<T>(work: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
		if (!this.driver) {
			throw new AppError('Neo4j not connected', ErrorCode.DATABASE_ERROR);
		}

		const session = this.driver.session({ database: this.database });
		try {
			return await session.executeRead(work);
		} finally {
			await session.close();
		}
	}

	/**
	 * Execute a write transaction
	 */
	async writeTransaction<T>(work: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
		if (!this.driver) {
			throw new AppError('Neo4j not connected', ErrorCode.DATABASE_ERROR);
		}

		const session = this.driver.session({ database: this.database });
		try {
			return await session.executeWrite(work);
		} finally {
			await session.close();
		}
	}

	/**
	 * Create or update a document node
	 */
	async upsertDocument(documentData: {
		id: string;
		title: string;
		type: string;
		synopsis?: string;
		notes?: string;
		wordCount?: number;
	}): Promise<void> {
		if (!this.driver) return;

		const cypher = `
			MERGE (d:Document {id: $id})
			SET d.title = $title,
				d.type = $type,
				d.synopsis = $synopsis,
				d.notes = $notes,
				d.wordCount = $wordCount,
				d.updatedAt = datetime()
			RETURN d
		`;

		await this.query(cypher, documentData);
	}

	/**
	 * Create or update a character node
	 */
	async upsertCharacter(characterData: {
		id: string;
		name: string;
		role?: string;
		description?: string;
		traits?: string[];
	}): Promise<void> {
		if (!this.driver) return;

		const cypher = `
			MERGE (c:Character {id: $id})
			SET c.name = $name,
				c.role = $role,
				c.description = $description,
				c.traits = $traits,
				c.updatedAt = datetime()
			RETURN c
		`;

		await this.query(cypher, characterData);
	}

	/**
	 * Create relationship between nodes
	 */
	async createRelationship(
		fromId: string,
		fromLabel: string,
		toId: string,
		toLabel: string,
		relationshipType: string,
		properties: any = {}
	): Promise<void> {
		if (!this.driver) return;

		const cypher = `
			MATCH (from:${fromLabel} {id: $fromId})
			MATCH (to:${toLabel} {id: $toId})
			MERGE (from)-[r:${relationshipType}]->(to)
			SET r += $properties,
				r.createdAt = coalesce(r.createdAt, datetime()),
				r.updatedAt = datetime()
			RETURN r
		`;

		await this.query(cypher, { fromId, toId, properties });
	}

	/**
	 * Find character relationships
	 */
	async findCharacterRelationships(characterId: string): Promise<any[]> {
		if (!this.driver) return [];

		const cypher = `
			MATCH (c:Character {id: $characterId})-[r]-(other)
			RETURN c, r, other, labels(other) as otherLabels
		`;

		const result = await this.query(cypher, { characterId });
		return result.records.map((record: any) => ({
			character: nodeToObject(record.get('c')),
			relationship: {
				type: record.get('r').type,
				properties: nodeToObject(record.get('r')),
			},
			other: nodeToObject(record.get('other')),
			otherLabels: record.get('otherLabels'),
		}));
	}

	/**
	 * Find documents connected to a character
	 */
	async findDocumentsForCharacter(characterId: string): Promise<any[]> {
		if (!this.driver) return [];

		const cypher = `
			MATCH (c:Character {id: $characterId})-[:APPEARS_IN]->(d:Document)
			RETURN d
			ORDER BY d.title
		`;

		const result = await this.query(cypher, { characterId });
		return extractValues(result, 'd').map(nodeToObject);
	}

	/**
	 * Find story structure and relationships
	 */
	async analyzeStoryStructure(): Promise<{
		documentFlow: any[];
		characterArcs: any[];
		themeProgression: any[];
	}> {
		if (!this.driver) return { documentFlow: [], characterArcs: [], themeProgression: [] };

		// Document flow analysis
		const flowResult = await this.query(`
			MATCH (d:Document)-[r:FOLLOWS]->(next:Document)
			RETURN d, r, next
			ORDER BY d.title
		`);

		const documentFlow = flowResult.records.map((record: any) => ({
			from: nodeToObject(record.get('d')),
			to: nodeToObject(record.get('next')),
			relationship: nodeToObject(record.get('r')),
		}));

		// Character arc analysis
		const arcResult = await this.query(`
			MATCH (c:Character)-[:APPEARS_IN]->(d:Document)
			WITH c, collect(d) as documents
			RETURN c, documents
			ORDER BY c.name
		`);

		const characterArcs = arcResult.records.map((record: any) => ({
			character: nodeToObject(record.get('c')),
			documents: record.get('documents').map((d: any) => nodeToObject(d)),
		}));

		// Theme progression
		const themeResult = await this.query(`
			MATCH (t:Theme)-[:PRESENT_IN]->(d:Document)
			WITH t, collect(d) as documents
			RETURN t, documents
			ORDER BY t.name
		`);

		const themeProgression = themeResult.records.map((record: any) => ({
			theme: nodeToObject(record.get('t')),
			documents: record.get('documents').map((d: any) => nodeToObject(d)),
		}));

		return { documentFlow, characterArcs, themeProgression };
	}

	/**
	 * Check if Neo4j is available
	 */
	isAvailable(): boolean {
		return this.driver !== null && this.isConnected;
	}

	/**
	 * Check database health
	 */
	async checkHealth(): Promise<{ healthy: boolean; details: Record<string, unknown> }> {
		try {
			// Check if we need a health check
			const now = new Date();
			if (
				this.lastHealthCheck &&
				now.getTime() - this.lastHealthCheck.getTime() < this.healthCheckInterval
			) {
				return {
					healthy: this.isConnected,
					details: {
						lastCheck: this.lastHealthCheck,
						cached: true,
					},
				};
			}

			if (!this.driver) {
				return {
					healthy: false,
					details: { error: 'Driver not initialized' },
				};
			}

			// Try to run a simple query
			const session = this.driver.session({ database: this.database });
			try {
				await session.run('RETURN 1');
				this.isConnected = true;
				this.lastHealthCheck = now;

				// Get database statistics
				const stats = await session.run(
					'CALL dbms.queryJmx("org.neo4j:*") YIELD attributes'
				);

				return {
					healthy: true,
					details: {
						connected: true,
						lastCheck: now,
						stats: stats.records.length > 0 ? stats.records[0].get('attributes') : {},
					},
				};
			} finally {
				await session.close();
			}
		} catch (error) {
			this.isConnected = false;
			return {
				healthy: false,
				details: {
					error: (error as Error).message,
					lastCheck: this.lastHealthCheck,
				},
			};
		}
	}

	/**
	 * Execute query with retry logic
	 */
	async queryWithRetry(
		cypher: string,
		params: QueryParameters = {},
		retries: number = 3
	): Promise<QueryResult> {
		if (!this.driver) {
			throw new AppError('Neo4j not connected', ErrorCode.DATABASE_ERROR);
		}

		let lastError: Error | null = null;

		for (let attempt = 1; attempt <= retries; attempt++) {
			const session = this.driver.session({ database: this.database });
			try {
				const result = await session.run(cypher, params);
				return result;
			} catch (error) {
				lastError = error as Error;

				// Check if it's a transient error that should be retried
				const errorCode = (error as Error & { code?: string }).code;
				if (errorCode && this.isTransientError(errorCode) && attempt < retries) {
					// Wait for service to recover instead of fixed delay
					try {
						const parsedUrl = new URL(this.uri);
						await waitForServiceReady(
							parsedUrl.hostname,
							parseInt(parsedUrl.port) || 7687,
							this.retryDelay * attempt
						);
					} catch {
						// If condition wait fails (invalid URL or service check), fall back to basic exponential backoff
						await new Promise((resolve) =>
							setTimeout(resolve, this.retryDelay * attempt)
						);
					}
					continue;
				}

				// Check if connection is lost and try to reconnect
				if (errorCode && this.isConnectionError(errorCode) && attempt < retries) {
					this.isConnected = false;
					await this.reconnect();
					continue;
				}

				throw error;
			} finally {
				await session.close();
			}
		}

		throw lastError || new AppError('Query failed after retries', ErrorCode.DATABASE_ERROR);
	}

	/**
	 * Check if error is transient and should be retried
	 */
	private isTransientError(code: string): boolean {
		const transientCodes = [
			'Neo.TransientError.Transaction.DeadlockDetected',
			'Neo.TransientError.Transaction.LockClientStopped',
			'Neo.TransientError.General.DatabaseUnavailable',
		];
		return transientCodes.some((c) => code?.includes(c));
	}

	/**
	 * Check if error is connection-related
	 */
	private isConnectionError(code: string): boolean {
		const connectionCodes = [
			'ServiceUnavailable',
			'SessionExpired',
			'Neo.ClientError.Security.AuthenticationRateLimit',
		];
		return connectionCodes.some((c) => code?.includes(c));
	}

	/**
	 * Try to reconnect to Neo4j
	 */
	private async reconnect(): Promise<void> {
		if (this.driver) {
			await this.driver.close();
		}
		await this.initialize();
	}

	/**
	 * Get connection info
	 */
	getConnectionInfo(): { uri: string; database: string; connected: boolean } {
		return {
			uri: this.uri,
			database: this.database,
			connected: this.driver !== null,
		};
	}

	/**
	 * Close the connection
	 */
	async close(): Promise<void> {
		if (this.driver) {
			await this.driver.close();
			this.driver = null;
		}
	}
}
