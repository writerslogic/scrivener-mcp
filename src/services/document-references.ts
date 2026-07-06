/**
 * Document-level cross-reference detection (issue #27). Given the project's
 * entity registry (characters, locations) and the plain text of its documents,
 * this computes which documents mention which entities, with per-document counts
 * and character offsets. It is pure and deterministic — no Neo4j, no AI — so the
 * query handlers work for every user; Neo4j is an optional persistence layer
 * layered on top (see document-graph-handlers). Matching is exact, whole-word,
 * and case-insensitive; implicit references ("the old house" → a named place)
 * are intentionally out of scope here and belong to the AI-assisted path.
 */

/** A known entity from the project's character/location registry. */
export interface RegistryEntity {
	id: string;
	name: string;
	type: 'character' | 'location';
	/** Optional alternative names; matched in addition to `name`. */
	aliases?: string[];
}

/** The plain text of one document. */
export interface DocumentText {
	id: string;
	title: string;
	content: string;
}

/** One entity's occurrences within a single document. */
export interface EntityMention {
	entityId: string;
	entityName: string;
	type: 'character' | 'location';
	count: number;
	/** Character offsets of each match, capped to keep payloads bounded. */
	positions: number[];
}

/** All entity mentions found in one document. */
export interface DocumentReferences {
	documentId: string;
	title: string;
	mentions: EntityMention[];
}

/** Cap stored offsets per entity/document so a heavily-repeated name can't bloat output. */
const MAX_POSITIONS = 100;

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a case-insensitive, whole-word matcher for an entity's name and aliases.
 * `\b` boundaries keep "Al" from matching inside "Also" while still matching
 * names containing apostrophes or hyphens (word chars sit between the boundaries).
 * Returns null when the entity has no non-empty search term.
 */
function buildMatcher(entity: RegistryEntity): RegExp | null {
	const terms = [entity.name, ...(entity.aliases ?? [])]
		.map((t) => t?.trim())
		.filter((t): t is string => !!t)
		.map(escapeRegExp);
	if (terms.length === 0) return null;
	// Longer terms first so "Mary Jane" wins over "Mary" at the same position.
	terms.sort((a, b) => b.length - a.length);
	return new RegExp(`\\b(?:${terms.join('|')})\\b`, 'gi');
}

/** Find every registry entity mentioned in a single document. */
export function findEntityMentions(doc: DocumentText, entities: RegistryEntity[]): EntityMention[] {
	const content = doc.content ?? '';
	if (!content) return [];

	const mentions: EntityMention[] = [];
	for (const entity of entities) {
		const matcher = buildMatcher(entity);
		if (!matcher) continue;

		const positions: number[] = [];
		let count = 0;
		let match: RegExpExecArray | null;
		while ((match = matcher.exec(content)) !== null) {
			count++;
			if (positions.length < MAX_POSITIONS) positions.push(match.index);
			// Guard against zero-length matches (shouldn't happen with \b + literal).
			if (match.index === matcher.lastIndex) matcher.lastIndex++;
		}

		if (count > 0) {
			mentions.push({
				entityId: entity.id,
				entityName: entity.name,
				type: entity.type,
				count,
				positions,
			});
		}
	}
	return mentions;
}

/** Build the full document → entity mention index for a project. */
export function buildReferenceIndex(
	docs: DocumentText[],
	entities: RegistryEntity[]
): DocumentReferences[] {
	const index: DocumentReferences[] = [];
	for (const doc of docs) {
		const mentions = findEntityMentions(doc, entities);
		if (mentions.length > 0) {
			index.push({ documentId: doc.id, title: doc.title, mentions });
		}
	}
	return index;
}

/** Entities a specific document references (empty when the doc has none). */
export function referencesForDocument(
	index: DocumentReferences[],
	documentId: string
): EntityMention[] {
	return index.find((entry) => entry.documentId === documentId)?.mentions ?? [];
}

/** A document that references a given entity, with how many times. */
export interface ReferencingDocument {
	documentId: string;
	title: string;
	count: number;
}

/**
 * Documents that reference an entity, identified by exact id or (failing that)
 * case-insensitive name. Sorted by descending mention count.
 */
export function documentsReferencing(
	index: DocumentReferences[],
	entityIdOrName: string
): ReferencingDocument[] {
	const needle = entityIdOrName.trim().toLowerCase();
	const results: ReferencingDocument[] = [];
	for (const entry of index) {
		const mention = entry.mentions.find(
			(m) => m.entityId === entityIdOrName || m.entityName.toLowerCase() === needle
		);
		if (mention) {
			results.push({
				documentId: entry.documentId,
				title: entry.title,
				count: mention.count,
			});
		}
	}
	return results.sort((a, b) => b.count - a.count);
}

/**
 * Registry entities that are never mentioned in any document — introduced in the
 * registry but with no textual presence (candidates for removal or follow-up).
 */
export function orphanedEntities(
	index: DocumentReferences[],
	entities: RegistryEntity[]
): RegistryEntity[] {
	const mentioned = new Set<string>();
	for (const entry of index) {
		for (const m of entry.mentions) mentioned.add(m.entityId);
	}
	return entities.filter((e) => !mentioned.has(e.id));
}

/** A suggested cross-reference a document is missing, with why. */
export interface SuggestedConnection {
	entityId: string;
	entityName: string;
	type: 'character' | 'location';
	/** Number of the document's existing entities this one co-occurs with elsewhere. */
	coOccurrences: number;
	/** The document's entities that this suggestion frequently appears alongside. */
	relatedTo: string[];
}

/**
 * Suggest entities a document might be missing: entities it does not mention but
 * that frequently co-occur — in other documents — with the entities it does
 * mention. Deterministic graph inference (no AI); ranked by co-occurrence
 * strength. Returns [] when the document has no mentions of its own.
 */
export function suggestConnections(
	index: DocumentReferences[],
	documentId: string
): SuggestedConnection[] {
	const own = referencesForDocument(index, documentId);
	if (own.length === 0) return [];
	const ownIds = new Set(own.map((m) => m.entityId));

	// For each candidate entity, tally which of the document's own entities it
	// shares a document with, elsewhere in the project.
	const tally = new Map<
		string,
		{ name: string; type: 'character' | 'location'; related: Set<string> }
	>();
	for (const entry of index) {
		if (entry.documentId === documentId) continue;
		const here = entry.mentions.map((m) => m.entityId);
		const overlap = own.filter((m) => here.includes(m.entityId));
		if (overlap.length === 0) continue;
		for (const m of entry.mentions) {
			if (ownIds.has(m.entityId)) continue;
			const bucket = tally.get(m.entityId) ?? {
				name: m.entityName,
				type: m.type,
				related: new Set<string>(),
			};
			for (const o of overlap) bucket.related.add(o.entityName);
			tally.set(m.entityId, bucket);
		}
	}

	return Array.from(tally.entries())
		.map(([entityId, v]) => ({
			entityId,
			entityName: v.name,
			type: v.type,
			coOccurrences: v.related.size,
			relatedTo: Array.from(v.related),
		}))
		.sort((a, b) => b.coOccurrences - a.coOccurrences);
}
