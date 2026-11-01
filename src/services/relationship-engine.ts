import type { Neo4jManager } from '../handlers/database/neo4j-manager.js';
import {
	buildCoOccurrenceIndex,
	referenceSourceOptions,
	type RegistryEntity,
} from './document-references.js';
import { analysisDigest, analysisEnvelope } from './editorial/analysis-envelope.js';
import type { PersistentStore } from './editorial/persistent-store.js';
import { stableStoryId, storyIdentifier, storyText } from './editorial/provenance.js';
import type { ManuscriptSource } from './editorial/types.js';
import { cloneHMSMetadata } from './memory/hhm/document-index.js';

export const ENTITY_TYPES = ['Character', 'Location', 'Document', 'Theme', 'PlotThread'] as const;
export const MAX_RELATIONSHIPS = 10000;
export const MAX_RELATIONSHIP_RESULTS = 100;
const RELATIONSHIPS = 'story:relationships';
const SEQUENCES = 'story:sequences';

export interface Relationship {
	id: string;
	head: string;
	headType: (typeof ENTITY_TYPES)[number];
	relation: string;
	tail: string;
	tailType: (typeof ENTITY_TYPES)[number];
	properties?: Record<string, unknown>;
}

export function relationshipLimit(value: unknown = 10): number {
	if (
		!Number.isInteger(value) ||
		(value as number) < 1 ||
		(value as number) > MAX_RELATIONSHIP_RESULTS
	)
		throw new Error('Relationship result limit must be an integer from 1 to 100');
	return value as number;
}

export function relationshipInput(value: unknown): Relationship {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Invalid relationship');
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).some(
			(key) =>
				!['id', 'head', 'headType', 'relation', 'tail', 'tailType', 'properties'].includes(
					key
				)
		)
	)
		throw new Error('Unsupported relationship field');
	const headType = ENTITY_TYPES.find((type) => type === input.headType);
	const tailType = ENTITY_TYPES.find((type) => type === input.tailType);
	if (!headType || !tailType) throw new Error('Unsupported entity type');
	const head = storyText(input.head, 'Source entity', 128);
	const tail = storyText(input.tail, 'Target entity', 128);
	const relation = storyText(input.relation, 'Relationship label', 64);
	const id = stableStoryId(headType, head, relation, tailType, tail);
	if (input.id !== undefined && input.id !== '' && input.id !== id)
		throw new Error('Relationship identity does not match its endpoints and label');
	let properties: Record<string, unknown> | undefined;
	if (input.properties !== undefined) {
		properties = cloneHMSMetadata(input.properties as Record<string, unknown>);
		if (Buffer.byteLength(JSON.stringify(properties)) > 1024)
			throw new Error('Relationship properties exceed 1024 UTF-8 JSON bytes');
	}
	return {
		id,
		head,
		headType,
		relation,
		tail,
		tailType,
		...(properties === undefined ? {} : { properties }),
	};
}

export class RelationshipEngine {
	constructor(
		private readonly source: ManuscriptSource,
		private readonly store: PersistentStore,
		private readonly getNeo4j: () => Neo4jManager | null = () => null
	) {}

	snapshot() {
		const relationships = this.store
			.list<Relationship>(RELATIONSHIPS, {
				maxItems: MAX_RELATIONSHIPS,
				maxBytes: 32 * 1024 * 1024,
			})
			.map(relationshipInput);
		return {
			relationships,
			projectId: this.source.projectId,
			graphRevision: analysisDigest(relationships),
		};
	}

	addRelationship(input: Omit<Relationship, 'id'> & { id?: string }): string {
		const rel = relationshipInput(input);
		this.store.transaction(() => {
			const existing = this.store.get<Relationship>(RELATIONSHIPS, rel.id);
			if (existing !== undefined) {
				const previous = relationshipInput(existing);
				if (rel.properties === undefined && previous.properties !== undefined)
					rel.properties = previous.properties;
				if (analysisDigest(previous) === analysisDigest(rel)) return;
			} else if (this.store.count(RELATIONSHIPS) >= MAX_RELATIONSHIPS)
				throw new Error('Project relationship limit of 10000 reached');
			this.store.put(RELATIONSHIPS, rel.id, rel);
		});
		return rel.id;
	}

	findRelated(
		entity: string,
		relation?: string,
		k?: number,
		offset = 0,
		expectedRevision?: string
	) {
		const name = storyText(entity, 'Entity', 128);
		const label =
			relation === undefined ? undefined : storyText(relation, 'Relationship label', 64);
		const limit = relationshipLimit(k);
		if (
			!Number.isSafeInteger(offset) ||
			offset < 0 ||
			offset > MAX_RELATIONSHIPS ||
			(expectedRevision !== undefined &&
				(typeof expectedRevision !== 'string' ||
					!/^[a-f0-9]{64}$/.test(expectedRevision))) ||
			(offset > 0 && expectedRevision === undefined)
		)
			throw new Error(
				'Relationship pages require a bounded offset and the previous graphRevision'
			);
		const snapshot = this.snapshot();
		if (expectedRevision !== undefined && expectedRevision !== snapshot.graphRevision)
			throw new Error('Relationship graph changed; restart pagination');
		const matches = snapshot.relationships.filter(
			(rel) =>
				(rel.head === name || rel.tail === name) &&
				(label === undefined || rel.relation === label)
		);
		if (offset > matches.length) throw new Error('Relationship offset exceeds the match count');
		const nextOffset = offset + limit < matches.length ? offset + limit : null;
		return {
			...snapshot,
			relationships: matches.slice(offset, offset + limit),
			total: matches.length,
			offset,
			nextOffset,
			truncated: nextOffset !== null,
		};
	}

	storeSequence(id: string, sequence: string[]): void {
		storyIdentifier(id, 'Sequence id');
		if (!Array.isArray(sequence) || !sequence.length || sequence.length > 4096)
			throw new Error('A chapter sequence requires 1–4096 identifiers');
		const chapters = [...sequence].map((value) => storyIdentifier(value, 'Chapter id'));
		if (new Set(chapters).size !== chapters.length)
			throw new Error('Chapter identifiers must be unique');
		this.store.transaction(() => {
			if (!this.store.get(SEQUENCES, id) && this.store.count(SEQUENCES) >= 1000)
				throw new Error('Project chapter sequence limit of 1000 reached');
			this.store.put(SEQUENCES, id, { id, chapters });
		});
	}

	getCharacterNetwork() {
		const { relationships, ...identity } = this.snapshot();
		const network: Record<
			string,
			Array<{ target: string; relation: string; properties?: Record<string, unknown> }>
		> = Object.create(null);
		for (const rel of relationships) {
			if (rel.headType !== 'Character' || rel.tailType !== 'Character') continue;
			network[rel.head] ??= [];
			network[rel.tail] ??= [];
			network[rel.head].push({
				target: rel.tail,
				relation: rel.relation,
				...(rel.properties === undefined ? {} : { properties: rel.properties }),
			});
		}
		return { ...identity, network };
	}

	async discoverRelationships(k?: number) {
		const limit = relationshipLimit(k);
		const { relationships, graphRevision } = this.snapshot();
		const entities = new Map<string, RegistryEntity>();
		for (const rel of relationships) {
			for (const [type, name] of [
				[rel.headType, rel.head],
				[rel.tailType, rel.tail],
			]) {
				if (type !== 'Character' && type !== 'Location') continue;
				const id = stableStoryId(type, name);
				entities.set(id, {
					id,
					name,
					type: type === 'Character' ? 'character' : 'location',
				});
			}
		}
		const sourceOptions = referenceSourceOptions(entities.size);
		const documents = await this.source.list(sourceOptions);
		const characters = documents.reduce((total, document) => total + document.text.length, 0);
		const index = buildCoOccurrenceIndex(
			documents.map((doc) => ({ id: doc.documentId, title: doc.title, content: doc.text })),
			[...entities.values()]
		);
		const occurrences = new Map<string, Set<string>>();
		for (const doc of index)
			for (const entityId of doc.entityIds) {
				if (!occurrences.has(entityId)) occurrences.set(entityId, new Set());
				occurrences.get(entityId)!.add(doc.documentId);
			}
		const pairKey = (a: string, b: string) => JSON.stringify([a, b].sort());
		const known = new Set(
			relationships.map((rel) =>
				pairKey(
					stableStoryId(rel.headType, rel.head),
					stableStoryId(rel.tailType, rel.tail)
				)
			)
		);
		const candidates: Array<{ first: string; second: string; strength: number }> = [];
		const present = [...occurrences.keys()].sort();
		for (let i = 0; i < present.length; i++)
			for (let j = i + 1; j < present.length; j++) {
				const first = present[i],
					second = present[j];
				if (known.has(pairKey(first, second))) continue;
				const a = occurrences.get(first)!,
					b = occurrences.get(second)!;
				let shared = 0;
				for (const id of a) if (b.has(id)) shared++;
				if (shared)
					candidates.push({
						first,
						second,
						strength: shared / (a.size + b.size - shared),
					});
			}
		candidates.sort(
			(a, b) =>
				b.strength - a.strength ||
				(a.first < b.first ? -1 : a.first > b.first ? 1 : a.second < b.second ? -1 : 1)
		);
		const revisions = (docs: typeof documents) =>
			docs.map(({ documentId, revision }) => ({ documentId, revision }));
		if (
			analysisDigest(revisions(documents)) !==
				analysisDigest(revisions(await this.source.list(sourceOptions))) ||
			this.snapshot().graphRevision !== graphRevision
		)
			throw new Error('Saved manuscript or relationship graph changed during discovery');
		const envelope = analysisEnvelope(
			this.source.projectId,
			'manuscript',
			documents,
			{},
			'local',
			{ operation: 'discover_connections', graphRevision, limit }
		);
		envelope.policy.revisionChecked = true;
		const connections = candidates.slice(0, limit).map(({ first, second, strength }) => ({
			entity1: entities.get(first)!.name,
			entity1Type: entities.get(first)!.type,
			entity2: entities.get(second)!.name,
			entity2Type: entities.get(second)!.type,
			strength,
			documentIds: [...occurrences.get(first)!].filter((id) =>
				occurrences.get(second)!.has(id)
			),
		}));
		return {
			connections,
			total: candidates.length,
			truncated: candidates.length > limit,
			method: 'literal-whole-word-co-occurrence' as const,
			graphRevision,
			envelope,
			coverage: {
				documents: documents.length,
				entities: entities.size,
				sourceCharacters: characters,
			},
		};
	}

	async syncToNeo4j() {
		const neo4j = this.getNeo4j();
		if (!neo4j?.isAvailable()) throw new Error('Neo4j synchronization is unavailable');
		const { relationships, ...identity } = this.snapshot();
		let synced = 0;
		let errors = 0;
		for (const rel of relationships) {
			try {
				const result = await neo4j.query(
					`
					MERGE (source:StoryEntity {projectId: $projectId, kind: $headType, name: $head})
					MERGE (target:StoryEntity {projectId: $projectId, kind: $tailType, name: $tail})
					MERGE (source)-[edge:StoryRelationship {id: $id, projectId: $projectId}]->(target)
					SET edge.label = $relation, edge.propertiesJson = $propertiesJson
					RETURN edge.id AS id`,
					{
						...rel,
						projectId: this.source.projectId,
						propertiesJson: JSON.stringify(rel.properties ?? {}),
					}
				);
				if (result.records.length !== 1 || result.records[0].get('id') !== rel.id)
					throw new Error('Graph did not confirm the relationship');
				synced++;
			} catch {
				errors++;
			}
		}
		return {
			...identity,
			synced,
			errors,
			status: errors ? ('partial' as const) : ('complete' as const),
		};
	}
}
