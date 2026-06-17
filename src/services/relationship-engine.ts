import { getLogger } from '../core/logger.js';

export interface Relationship {
	id: string;
	head: string;
	headType: string;
	relation: string;
	tail: string;
	tailType: string;
	properties?: Record<string, unknown>;
}

/**
 * Bridges HMS triplet storage and Neo4j graph for relationship management.
 * HMS is the primary store; Neo4j is optional and best-effort.
 */
export class RelationshipEngine {
	private logger = getLogger('relationship-engine');
	private static readonly MAX_LOCAL_TRIPLETS = 10000;
	private localTriplets: Map<string, Relationship> = new Map();

	constructor(
		private hms: any, // HolographicMemorySystem - use any to avoid circular deps
		private neo4j: any | null // Neo4jManager - null when not connected
	) {
		if (!hms) {
			throw new Error('RelationshipEngine requires an HMS instance');
		}
	}

	/**
	 * Generate a deterministic ID for a relationship.
	 */
	private generateId(rel: Omit<Relationship, 'id'>): string {
		return `${rel.headType}:${rel.head}--${rel.relation}--${rel.tailType}:${rel.tail}`;
	}

	/**
	 * Store a single relationship in HMS and optionally Neo4j.
	 */
	async addRelationship(rel: Relationship): Promise<void> {
		const id = rel.id || this.generateId(rel);
		const normalized: Relationship = { ...rel, id };

		// Store in local index with eviction
		this.localTriplets.set(id, normalized);
		if (this.localTriplets.size > RelationshipEngine.MAX_LOCAL_TRIPLETS) {
			const oldest = this.localTriplets.keys().next().value;
			if (oldest) this.localTriplets.delete(oldest);
		}

		// Store in HMS triplet memory if the method exists (native engine only)
		if (typeof this.hms.memorizeTriplet === 'function') {
			try {
				await this.hms.memorizeTriplet(
					id,
					normalized.head,
					normalized.relation,
					normalized.tail
				);
			} catch (error) {
				this.logger.warn('HMS memorizeTriplet failed, relationship stored locally only', {
					id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		} else {
			// Fallback: store as text in HMS for vector similarity search
			const text = `${normalized.headType} ${normalized.head} ${normalized.relation} ${normalized.tailType} ${normalized.tail}`;
			try {
				await this.hms.memorizeText(text, id);
			} catch (error) {
				this.logger.warn('HMS memorizeText fallback failed', {
					id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		// If Neo4j is available, sync there too
		if (this.neo4j) {
			try {
				await this.neo4j.createRelationship(
					normalized.head,
					normalized.headType,
					normalized.tail,
					normalized.tailType,
					normalized.relation,
					normalized.properties || {}
				);
			} catch (error) {
				this.logger.warn('Neo4j createRelationship failed, HMS is primary store', {
					id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	/**
	 * Store a batch of relationships. Returns counts of successful operations.
	 */
	async addRelationshipBatch(
		rels: Relationship[]
	): Promise<{ stored: number; neo4jSynced: number }> {
		let stored = 0;
		let neo4jSynced = 0;

		for (const rel of rels) {
			const id = rel.id || this.generateId(rel);
			const normalized: Relationship = { ...rel, id };

			this.localTriplets.set(id, normalized);

			// HMS storage
			if (typeof this.hms.memorizeTriplet === 'function') {
				try {
					await this.hms.memorizeTriplet(
						id,
						normalized.head,
						normalized.relation,
						normalized.tail
					);
					stored++;
				} catch (error) {
					this.logger.warn('HMS memorizeTriplet failed in batch', {
						id,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			} else {
				const text = `${normalized.headType} ${normalized.head} ${normalized.relation} ${normalized.tailType} ${normalized.tail}`;
				try {
					await this.hms.memorizeText(text, id);
					stored++;
				} catch (error) {
					this.logger.warn('HMS memorizeText fallback failed in batch', {
						id,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}

			// Neo4j sync
			if (this.neo4j) {
				try {
					await this.neo4j.createRelationship(
						normalized.head,
						normalized.headType,
						normalized.tail,
						normalized.tailType,
						normalized.relation,
						normalized.properties || {}
					);
					neo4jSynced++;
				} catch (error) {
					this.logger.warn('Neo4j sync failed in batch', {
						id,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}

		this.logger.info('Batch relationship storage complete', {
			stored,
			neo4jSynced,
			total: rels.length,
		});
		return { stored, neo4jSynced };
	}

	/**
	 * Find relationships involving an entity, optionally filtered by relation type.
	 */
	async findRelated(entity: string, relation?: string, k?: number): Promise<Relationship[]> {
		const limit = k || 10;

		// Try HMS triplet query if available (native engine)
		if (typeof this.hms.queryTriplet === 'function') {
			try {
				const results = await this.hms.queryTriplet(entity, relation || '', limit);
				return results
					.map((r: { id: string; similarity: number }) => {
						const cached = this.localTriplets.get(r.id);
						if (cached) return cached;
						// Reconstruct from ID format: headType:head--relation--tailType:tail
						return this.parseRelationshipId(r.id);
					})
					.filter((r: Relationship | null): r is Relationship => r !== null);
			} catch (error) {
				this.logger.warn('HMS queryTriplet failed, falling back to local index', {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		// Fallback: search local triplet index
		const results: Relationship[] = [];
		for (const rel of this.localTriplets.values()) {
			if (results.length >= limit) break;

			const matchesEntity = rel.head === entity || rel.tail === entity;
			const matchesRelation = !relation || rel.relation === relation;

			if (matchesEntity && matchesRelation) {
				results.push(rel);
			}
		}

		return results;
	}

	/**
	 * Store a sequence (e.g., plot progression) in HMS.
	 */
	async storeSequence(id: string, sequence: string[]): Promise<void> {
		if (typeof this.hms.memorizeSequence === 'function') {
			try {
				await this.hms.memorizeSequence(id, sequence);
			} catch (error) {
				this.logger.warn('HMS memorizeSequence failed', {
					id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		} else {
			// Fallback: store as concatenated text
			const text = sequence.join(' -> ');
			try {
				await this.hms.memorizeText(text, id);
			} catch (error) {
				this.logger.warn('HMS memorizeText sequence fallback failed', {
					id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	/**
	 * Get the character relationship network.
	 * Uses Neo4j if available, otherwise builds from local triplets.
	 */
	async getCharacterNetwork(): Promise<Record<string, unknown>> {
		// Try Neo4j first
		if (
			this.neo4j &&
			typeof this.neo4j.isAvailable === 'function' &&
			this.neo4j.isAvailable()
		) {
			try {
				const result = await this.neo4j.query(`
					MATCH (c1:Character)-[r]->(c2:Character)
					RETURN c1.name AS from, type(r) AS relation, c2.name AS to, properties(r) AS props
				`);

				const network: Record<
					string,
					Array<{ target: string; relation: string; properties: Record<string, unknown> }>
				> = {};
				for (const record of result.records) {
					const from = record.get('from') as string;
					const to = record.get('to') as string;
					const relation = record.get('relation') as string;
					const props = record.get('props') as Record<string, unknown>;

					if (!network[from]) network[from] = [];
					network[from].push({ target: to, relation, properties: props || {} });
				}

				return network;
			} catch (error) {
				this.logger.warn('Neo4j character network query failed, falling back to local', {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		// Fallback: build from local triplets
		const network: Record<string, Array<{ target: string; relation: string }>> = {};
		for (const rel of this.localTriplets.values()) {
			if (
				rel.headType.toLowerCase() === 'character' &&
				rel.tailType.toLowerCase() === 'character'
			) {
				if (!network[rel.head]) network[rel.head] = [];
				network[rel.head].push({ target: rel.tail, relation: rel.relation });
			}
		}

		return network;
	}

	/**
	 * Discover potential relationships using HMS batch query.
	 */
	async discoverRelationships(
		k?: number
	): Promise<Array<{ entity1: string; entity2: string; strength: number }>> {
		const limit = k || 10;
		const discoveries: Array<{ entity1: string; entity2: string; strength: number }> = [];

		// Collect known character names from local triplets
		const characters = new Set<string>();
		for (const rel of this.localTriplets.values()) {
			if (rel.headType.toLowerCase() === 'character') characters.add(rel.head);
			if (rel.tailType.toLowerCase() === 'character') characters.add(rel.tail);
		}

		if (characters.size === 0) return discoveries;

		const characterList = Array.from(characters);

		// Try HMS batch query if available
		if (typeof this.hms.queryBatch === 'function') {
			try {
				const results = await this.hms.queryBatch(characterList, limit);
				for (let i = 0; i < characterList.length; i++) {
					const matches = results[i];
					if (!matches) continue;
					for (const match of matches) {
						if (match.id !== characterList[i] && match.similarity > 0.3) {
							discoveries.push({
								entity1: characterList[i],
								entity2: match.id,
								strength: match.similarity,
							});
						}
					}
				}
			} catch (error) {
				this.logger.warn('HMS queryBatch failed for relationship discovery', {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		} else {
			// Fallback: query each character individually via HMS text query
			for (const character of characterList) {
				try {
					const results = await this.hms.queryText(character, limit);
					for (const r of results) {
						if (r.id !== character && r.similarity > 0.3) {
							discoveries.push({
								entity1: character,
								entity2: r.id,
								strength: r.similarity,
							});
						}
					}
				} catch (error) {
					this.logger.warn('HMS queryText failed for character', {
						character,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}

		// Deduplicate (a->b and b->a)
		const seen = new Set<string>();
		return discoveries.filter((d) => {
			const key = [d.entity1, d.entity2].sort().join('|');
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}

	/**
	 * Replay all locally stored triplets into Neo4j.
	 */
	async syncToNeo4j(): Promise<{ synced: number; errors: number }> {
		if (!this.neo4j) {
			return { synced: 0, errors: 0 };
		}

		let synced = 0;
		let errors = 0;

		for (const rel of this.localTriplets.values()) {
			try {
				await this.neo4j.createRelationship(
					rel.head,
					rel.headType,
					rel.tail,
					rel.tailType,
					rel.relation,
					rel.properties || {}
				);
				synced++;
			} catch (error) {
				errors++;
				this.logger.warn('Failed to sync relationship to Neo4j', {
					id: rel.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		this.logger.info('Neo4j sync complete', { synced, errors, total: this.localTriplets.size });
		return { synced, errors };
	}

	/**
	 * Check if Neo4j backend is available.
	 */
	isNeo4jAvailable(): boolean {
		return (
			this.neo4j !== null &&
			typeof this.neo4j.isAvailable === 'function' &&
			this.neo4j.isAvailable()
		);
	}

	/**
	 * Parse a relationship from its deterministic ID format.
	 */
	private parseRelationshipId(id: string): Relationship | null {
		// Format: headType:head--relation--tailType:tail
		const match = id.match(/^([^:]+):(.+?)--(.+?)--([^:]+):(.+)$/);
		if (!match) return null;

		return {
			id,
			headType: match[1],
			head: match[2],
			relation: match[3],
			tailType: match[4],
			tail: match[5],
		};
	}
}
