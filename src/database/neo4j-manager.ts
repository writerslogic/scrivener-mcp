import type { Driver, Result } from 'neo4j-driver';
import neo4j from 'neo4j-driver';

export class Neo4jManager {
	private driver: Driver | null = null;
	private uri: string;
	private user: string;
	private password: string;
	private database: string;

	constructor(uri: string, user: string, password: string, database = 'scrivener') {
		this.uri = uri;
		this.user = user;
		this.password = password;
		this.database = database;
	}

	/**
	 * Initialize the Neo4j connection
	 */
	async initialize(): Promise<void> {
		try {
			// Create driver
			this.driver = neo4j.driver(this.uri, neo4j.auth.basic(this.user, this.password));

			// Verify connectivity
			await this.driver.verifyConnectivity();

			// Initialize schema
			await this.createConstraints();
			await this.createIndexes();
		} catch (error) {
			console.warn('Neo4j connection failed, continuing without graph database:', error);
			// Don't throw - allow the app to continue with just SQLite
			this.driver = null;
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
	async query(cypher: string, parameters: any = {}): Promise<Result> {
		if (!this.driver) {
			throw new Error('Neo4j not connected. Initialize first or check connection.');
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
	async readTransaction<T>(work: (tx: any) => Promise<T>): Promise<T> {
		if (!this.driver) {
			throw new Error('Neo4j not connected');
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
	async writeTransaction<T>(work: (tx: any) => Promise<T>): Promise<T> {
		if (!this.driver) {
			throw new Error('Neo4j not connected');
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
			character: record.get('c').properties,
			relationship: {
				type: record.get('r').type,
				properties: record.get('r').properties,
			},
			other: record.get('other').properties,
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
		return result.records.map((record: any) => record.get('d').properties);
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
			from: record.get('d').properties,
			to: record.get('next').properties,
			relationship: record.get('r').properties,
		}));

		// Character arc analysis
		const arcResult = await this.query(`
			MATCH (c:Character)-[:APPEARS_IN]->(d:Document)
			WITH c, collect(d) as documents
			RETURN c, documents
			ORDER BY c.name
		`);

		const characterArcs = arcResult.records.map((record: any) => ({
			character: record.get('c').properties,
			documents: record.get('documents').map((d: any) => d.properties),
		}));

		// Theme progression
		const themeResult = await this.query(`
			MATCH (t:Theme)-[:PRESENT_IN]->(d:Document)
			WITH t, collect(d) as documents
			RETURN t, documents
			ORDER BY t.name
		`);

		const themeProgression = themeResult.records.map((record: any) => ({
			theme: record.get('t').properties,
			documents: record.get('documents').map((d: any) => d.properties),
		}));

		return { documentFlow, characterArcs, themeProgression };
	}

	/**
	 * Check if Neo4j is available
	 */
	isAvailable(): boolean {
		return this.driver !== null;
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
