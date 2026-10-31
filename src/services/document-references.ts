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

import type { SourceScopeOptions } from './editorial/types.js';

export const MAX_REFERENCE_ENTITIES = 256;
export const MAX_REFERENCE_DOCUMENTS = 1000;
export const MAX_REFERENCE_CHARACTERS = 2 * 1024 * 1024;
export const MAX_REFERENCE_WORK = 128 * 1024 * 1024;
export const MAX_REFERENCE_POSITIONS = 1_000_000;
export const MAX_REFERENCE_RESULT_BYTES = 16 * 1024 * 1024;

export function referenceSourceOptions(
	entityCount: number,
	scope: 'draft' | 'all' = 'draft'
): Required<SourceScopeOptions> {
	if (!Number.isInteger(entityCount) || entityCount < 0 || entityCount > MAX_REFERENCE_ENTITIES)
		throw new Error('Reference analysis supports at most 256 entities');
	return {
		scope,
		maxDocuments: MAX_REFERENCE_DOCUMENTS,
		maxCharacters: Math.min(
			MAX_REFERENCE_CHARACTERS,
			Math.floor(MAX_REFERENCE_WORK / Math.max(1, entityCount))
		),
	};
}

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
	/** UTF-16 offsets of every literal match within the admitted source. */
	positions: number[];
}

/** All entity mentions found in one document. */
export interface DocumentReferences {
	documentId: string;
	title: string;
	mentions: EntityMention[];
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a case-insensitive, whole-word matcher for an entity's name and aliases.
 * Unicode letter/mark/number boundaries preserve names outside ASCII as well as
 * apostrophes and hyphens, without matching "Al" inside "Also".
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
	return new RegExp(
		`(?<![\\p{L}\\p{M}\\p{N}_])(?:${terms.join('|')})(?![\\p{L}\\p{M}\\p{N}_])`,
		'giu'
	);
}

function matchersFor(entities: RegistryEntity[]) {
	return entities.map((entity) => ({ entity, matcher: buildMatcher(entity) }));
}

export function findEntityMentions(doc: DocumentText, entities: RegistryEntity[]): EntityMention[] {
	return mentionsFor(doc, matchersFor(entities), { positions: 0, bytes: 0 });
}

function mentionsFor(
	doc: DocumentText,
	matchers: ReturnType<typeof matchersFor>,
	budget: { positions: number; bytes: number }
): EntityMention[] {
	const content = doc.content ?? '';
	if (!content) return [];

	const mentions: EntityMention[] = [];
	for (const { entity, matcher } of matchers) {
		if (!matcher) continue;
		matcher.lastIndex = 0;

		const positions: number[] = [];
		let count = 0;
		let match: RegExpExecArray | null;
		while ((match = matcher.exec(content)) !== null) {
			count++;
			if (++budget.positions > MAX_REFERENCE_POSITIONS)
				throw new Error('Reference analysis exceeds 1000000 source positions');
			positions.push(match.index);
			// Guard against zero-length matches (shouldn't happen with \b + literal).
			if (match.index === matcher.lastIndex) matcher.lastIndex++;
		}

		if (count > 0) {
			const mention = {
				entityId: entity.id,
				entityName: entity.name,
				type: entity.type,
				count,
				positions,
			};
			budget.bytes += Buffer.byteLength(JSON.stringify(mention));
			if (budget.bytes > MAX_REFERENCE_RESULT_BYTES)
				throw new Error('Reference analysis exceeds 16 MiB of mention evidence');
			mentions.push(mention);
		}
	}
	return mentions;
}

export function buildReferenceIndex(
	docs: DocumentText[],
	entities: RegistryEntity[]
): DocumentReferences[] {
	validateReferenceScope(docs, entities.length);
	const matchers = matchersFor(entities);
	const index: DocumentReferences[] = [];
	const budget = { positions: 0, bytes: 0 };
	for (const doc of docs) {
		const mentions = mentionsFor(doc, matchers, budget);
		if (mentions.length > 0) index.push({ documentId: doc.id, title: doc.title, mentions });
	}
	return index;
}

function validateReferenceScope(docs: DocumentText[], entityCount: number) {
	const limits = referenceSourceOptions(entityCount);
	if (
		docs.length > limits.maxDocuments ||
		docs.reduce((total, document) => total + document.content.length, 0) > limits.maxCharacters
	)
		throw new Error(
			'Reference analysis exceeds its document, source-character or character/entity work budget'
		);
}

export function buildCoOccurrenceIndex(docs: DocumentText[], entities: RegistryEntity[]) {
	validateReferenceScope(docs, entities.length);
	const matchers = matchersFor(entities);
	return docs
		.map((doc) => ({
			documentId: doc.id,
			entityIds: matchers.flatMap(({ entity, matcher }) => {
				if (!matcher) return [];
				matcher.lastIndex = 0;
				return matcher.test(doc.content) ? [entity.id] : [];
			}),
		}))
		.filter((document) => document.entityIds.length);
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
	entityIdOrName: string,
	entities: RegistryEntity[]
): ReferencingDocument[] {
	const needle = entityIdOrName.trim().toLowerCase();
	const exact = entities.find((entity) => entity.id === entityIdOrName);
	const candidates = exact
		? [exact]
		: entities.filter((entity) => entity.name.toLowerCase() === needle);
	if (candidates.length > 1)
		throw new Error('Entity name is ambiguous; provide its unique registry ID');
	if (!candidates.length) return [];
	const results: ReferencingDocument[] = [];
	for (const entry of index) {
		const mention = entry.mentions.find((m) => m.entityId === candidates[0].id);
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
		{ name: string; type: 'character' | 'location'; related: Map<string, string> }
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
				related: new Map<string, string>(),
			};
			for (const o of overlap) bucket.related.set(o.entityId, o.entityName);
			tally.set(m.entityId, bucket);
		}
	}

	return Array.from(tally.entries())
		.map(([entityId, v]) => ({
			entityId,
			entityName: v.name,
			type: v.type,
			coOccurrences: v.related.size,
			relatedTo: Array.from(v.related.values()),
		}))
		.sort((a, b) => b.coOccurrences - a.coOccurrences);
}
