import { createHash } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
	HolographicMemorySystem,
	type HMSDocumentInput,
	type HMSDocumentResult,
} from '../memory/hhm/holographic-memory-system.js';
import type { ManuscriptSource, SourceDocument, SourcePassage } from './types.js';
import type { PersistentStore } from './persistent-store.js';

const CONCEPTS: Array<{ name: string; pattern: RegExp }> = [
	{
		name: 'betrayal',
		pattern:
			/\b(?:betray\w*|treacher\w*|traitor\w*|double.cross\w*|sold (?:their|her|his) (?:secret|plan)\w*|stabbed .{0,30} in the back)\b/iu,
	},
	{
		name: 'trust',
		pattern:
			/\b(?:trust\w*|loyal\w*|faithful\w*|closest friend|trusted companion|kept .{0,20} promise)\b/iu,
	},
	{
		name: 'grief',
		pattern:
			/\b(?:grie\w*|mourn\w*|bereav\w*|funeral\w*|wept beside .{0,20} grave|loss of .{0,20} loved|death of .{0,20} loved)\b/iu,
	},
	{
		name: 'fear',
		pattern:
			/\b(?:fear\w*|afraid|terror\w*|fright\w*|panic\w*|dread\w*|trembl\w*|heart raced|hands shook|cold sweat)\b/iu,
	},
	{
		name: 'anger',
		pattern:
			/\b(?:angry|anger\w*|furious|fury|rage\w*|enraged|clenched .{0,12} fists?|seething)\b/iu,
	},
	{
		name: 'affection',
		pattern:
			/\b(?:love\w*|affection\w*|romanc\w*|kiss\w*|adore\w*|tender\w*|held .{0,20} hand)\b/iu,
	},
	{
		name: 'isolation',
		pattern:
			/\b(?:isolat\w*|lonel\w*|alone|solitude|abandon\w*|nobody came|no one came|without a friend)\b/iu,
	},
	{
		name: 'concealment',
		pattern:
			/\b(?:secret\w*|conceal\w*|hidden|hid\w*|disguis\w*|cover.up|kept .{0,20} from|under a false name)\b/iu,
	},
	{
		name: 'deception',
		pattern:
			/\b(?:decei\w*|decept\w*|lied|lying|liar\w*|dishonest\w*|falsehood\w*|untruth\w*|fabricat\w*)\b/iu,
	},
	{
		name: 'escape',
		pattern:
			/\b(?:escap\w*|flee\w*|fled|flight|run away|ran away|broke free|break free|evad\w*)\b/iu,
	},
	{
		name: 'pursuit',
		pattern: /\b(?:pursu\w*|chas\w*|hunt\w*|stalk\w*|track\w*|followed .{0,20} trail)\b/iu,
	},
	{
		name: 'conflict',
		pattern:
			/\b(?:conflict\w*|fight\w*|fought|battl\w*|combat\w*|war|duel\w*|clashed|drawn swords?)\b/iu,
	},
	{
		name: 'injury',
		pattern:
			/\b(?:injur\w*|wound\w*|bleed\w*|bled|blood\w*|fractur\w*|broken bone\w*|scar\w*)\b/iu,
	},
	{
		name: 'healing',
		pattern:
			/\b(?:heal\w*|recover\w*|medic\w*|doctor\w*|physician\w*|bandag\w*|remed\w*|nurs\w*)\b/iu,
	},
	{
		name: 'discovery',
		pattern:
			/\b(?:discover\w*|reveal\w*|uncover\w*|revelation\w*|realiz\w*|realise\w*|found out|learned the truth)\b/iu,
	},
	{
		name: 'memory',
		pattern:
			/\b(?:memor\w*|remember\w*|recollect\w*|reminisc\w*|flashback\w*|recalled|years earlier|childhood)\b/iu,
	},
	{
		name: 'authority',
		pattern:
			/\b(?:authorit\w*|power\w*|ruler\w*|king\w*|queen\w*|govern\w*|command\w*|throne\w*)\b/iu,
	},
	{
		name: 'rebellion',
		pattern:
			/\b(?:rebel\w*|revolt\w*|resist\w*|uprising\w*|defian\w*|mutin\w*|overthrow\w*)\b/iu,
	},
	{
		name: 'journey',
		pattern:
			/\b(?:journey\w*|travel\w*|voyage\w*|expedition\w*|set sail|sailed|rode toward|road to)\b/iu,
	},
	{
		name: 'homecoming',
		pattern:
			/\b(?:homecom\w*|return\w* home|back home|reunion\w*|reunit\w*|welcome\w* back)\b/iu,
	},
	{
		name: 'sacrifice',
		pattern:
			/\b(?:sacrific\w*|gave .{0,20} life|give .{0,20} life|laid down .{0,15} life|for .{0,20} sake)\b/iu,
	},
	{
		name: 'forgiveness',
		pattern:
			/\b(?:forgiv\w*|forgave|pardon\w*|reconcil\w*|made peace|make peace|let go of .{0,20} resentment)\b/iu,
	},
	{
		name: 'captivity',
		pattern:
			/\b(?:captiv\w*|prison\w*|imprison\w*|dungeon\w*|cage\w*|chained|locked .{0,15} cell|held hostage)\b/iu,
	},
	{
		name: 'hunger',
		pattern:
			/\b(?:hunger\w*|hungry|starv\w*|famish\w*|empty stomach|had not eaten|hadn't eaten)\b/iu,
	},
	{
		name: 'weather',
		pattern:
			/\b(?:weather|storm\w*|rain\w*|snow\w*|thunder\w*|lightning|blizzard\w*|sunshine)\b/iu,
	},
	{
		name: 'wealth',
		pattern: /\b(?:wealth\w*|rich\w*|fortune\w*|treasure\w*|gold|silver|money|coin\w*)\b/iu,
	},
	{
		name: 'poverty',
		pattern:
			/\b(?:povert\w*|poor|destitut\w*|penniless|beggar\w*|could not afford|couldn't afford)\b/iu,
	},
	{
		name: 'justice',
		pattern: /\b(?:justic\w*|trial\w*|judg\w*|verdict\w*|guilt\w*|innocen\w*|punish\w*)\b/iu,
	},
	{
		name: 'death',
		pattern: /\b(?:death|dead|died|dying|kill\w*|murder\w*|corpse\w*|grave\w*)\b/iu,
	},
	{
		name: 'hope',
		pattern:
			/\b(?:hope\w*|optimis\w*|a new beginning|second chance|better tomorrow|light at the end)\b/iu,
	},
];

const INDEX_VERSION = 2;
const MAX_PASSAGES = 50000;
const BATCH_SIZE = 512;
const EMBEDDING_SPACE = {
	model: 'scrivener-story-concepts',
	revision: '1',
	dimensions: CONCEPTS.length,
};

interface IndexedPassage extends SourcePassage {
	id: string;
	concepts: string[];
}

interface IndexedDocument {
	version: number;
	projectId: string;
	documentId: string;
	revision: string;
	title: string;
	path: string;
	passages: IndexedPassage[];
}

export interface PassageSearchOptions {
	limit?: number;
	mode?: 'hybrid' | 'keyword' | 'semantic';
	contextChars?: number;
	documentIds?: string[];
}

export interface PassageMatch extends SourcePassage {
	context: string;
	contextStart: number;
	contextEnd: number;
	score: number;
	keywordScore: number;
	semanticScore: number;
	hmsScore: number;
	matchedConcepts: string[];
}

export interface PassageSearchResult {
	results: PassageMatch[];
	query: string;
	mode: 'hybrid' | 'keyword' | 'semantic';
	method: string;
	limitations: string;
	index: { changedDocuments: number; removedDocuments: number; passages: number; documents: number };
}

function concepts(text: string): string[] {
	return CONCEPTS.filter((concept) => concept.pattern.test(text)).map((concept) => concept.name);
}

function chunkDocument(doc: SourceDocument): IndexedPassage[] {
	if (doc.text.length > 8 * 1024 * 1024)
		throw new Error('Document exceeds the local passage index limit of 8 Mi UTF-16 code units');
	const chunks: IndexedPassage[] = [];
	let start = 0;
	let line = 1;
	let lineOffset = 0;
	while (start < doc.text.length) {
		while (start < doc.text.length && /\s/u.test(doc.text[start])) start++;
		if (start >= doc.text.length) break;
		let end = Math.min(start + 1400, doc.text.length);
		if (end < doc.text.length) {
			const candidate = doc.text.slice(start, end);
			const paragraph = candidate.lastIndexOf('\n\n');
			const sentence = Math.max(
				candidate.lastIndexOf('. '),
				candidate.lastIndexOf('? '),
				candidate.lastIndexOf('! ')
			);
			const boundary =
				paragraph > 300
					? paragraph
					: sentence > 300
						? sentence + 1
						: candidate.lastIndexOf(' ');
			if (boundary > 0) end = start + boundary;
			else if (/[\uD800-\uDBFF]/u.test(doc.text[end - 1])) end--;
		}
		while (end > start && /\s/u.test(doc.text[end - 1])) end--;
		if (end <= start) end = Math.min(start + 1400, doc.text.length);
		const quote = doc.text.slice(start, end);
		while (lineOffset < start) {
			if (doc.text.charCodeAt(lineOffset++) === 10) line++;
		}
		chunks.push({
			id: createHash('sha256')
				.update(`${doc.projectId}:${doc.documentId}:${doc.revision}:${start}:${end}`)
				.digest('hex'),
			projectId: doc.projectId,
			documentId: doc.documentId,
			revision: doc.revision,
			title: doc.title,
			path: doc.path,
			start,
			end,
			line,
			quote,
			concepts: concepts(quote),
		});
		start = end;
	}
	return chunks;
}

interface IndexSummary {
	changedDocuments: number;
	removedDocuments: number;
	passages: number;
	documents: number;
}

interface SyncCatalog {
	version: number;
	projectId: string;
	applied: string[];
	pending: string[];
}

interface RankedPassage {
	entry: IndexedPassage;
	score: number;
	keywordScore: number;
	semanticScore: number;
	hmsScore: number;
	matchedConcepts: string[];
}

const indexWork = new Map<string, Promise<void>>();
const volatileCatalogs = new WeakMap<HolographicMemorySystem, SyncCatalog>();

function sequence<T>(key: string, operation: () => Promise<T>): Promise<T> {
	const task = (indexWork.get(key) ?? Promise.resolve()).then(operation);
	const settled = task.then(() => undefined, () => undefined);
	indexWork.set(key, settled);
	void settled.then(() => {
		if (indexWork.get(key) === settled) indexWork.delete(key);
	});
	return task;
}

function sourceUri(passage: IndexedPassage): string {
	return `scrivener://${encodeURIComponent(passage.projectId)}/${encodeURIComponent(passage.documentId)}`;
}

function embedding(names: string[]): number[] | undefined {
	if (!names.length) return undefined;
	const present = new Set(names);
	const magnitude = Math.sqrt(names.length);
	return CONCEPTS.map((concept) => present.has(concept.name) ? 1 / magnitude : 0);
}

function documentInput(passage: IndexedPassage): HMSDocumentInput {
	const vector = embedding(passage.concepts);
	return {
		id: passage.id,
		text: passage.quote,
		sourceUri: sourceUri(passage),
		version: passage.revision,
		metadata: {
			projectId: passage.projectId,
			sourceDocumentId: passage.documentId,
			passageId: passage.id,
			revision: passage.revision,
			start: passage.start,
			end: passage.end,
			indexVersion: INDEX_VERSION,
		},
		chunkWords: 4096,
		overlapWords: 0,
		storeText: true,
		...(vector ? { embeddings: [vector] } : {}),
	};
}

function checkedHit(hit: HMSDocumentResult, passage: IndexedPassage | undefined): IndexedPassage {
	if (
		!passage || typeof hit.id !== 'string' || !hit.id || hit.id.length > 256 ||
		hit.documentId !== passage.id || hit.version !== passage.revision ||
		hit.sourceUri !== sourceUri(passage) || hit.startByte !== 0 ||
		hit.endByte !== Buffer.byteLength(passage.quote, 'utf8') ||
		(hit.text !== undefined && hit.text !== passage.quote) ||
		hit.metadata?.projectId !== passage.projectId ||
		hit.metadata?.sourceDocumentId !== passage.documentId ||
		hit.metadata?.passageId !== passage.id || hit.metadata?.revision !== passage.revision ||
		hit.metadata?.indexVersion !== INDEX_VERSION ||
		hit.metadata?.start !== passage.start || hit.metadata?.end !== passage.end ||
		!Number.isFinite(hit.score) || !Number.isFinite(hit.lexicalScore) ||
		(hit.semanticScore !== undefined && !Number.isFinite(hit.semanticScore))
	) throw new Error('Local passage index returned inconsistent source provenance');
	return passage;
}

export class PassageSearch {
	private readonly namespace: string;
	private readonly syncNamespace: string;
	private readonly cachePath: string;
	private engine?: HolographicMemorySystem;
	private readonly externalEngine: boolean;
	private bootstrapNative = true;
	private refreshing?: Promise<IndexSummary>;
	private enginePromise?: Promise<HolographicMemorySystem>;
	private readonly activeSearches = new Set<Promise<PassageSearchResult>>();
	private closing?: Promise<void>;
	private closed = false;

	constructor(
		private readonly source: ManuscriptSource,
		private readonly store: PersistentStore,
		hms?: HolographicMemorySystem
	) {
		this.namespace = `passage-documents:${source.projectId}`;
		this.syncNamespace = `passage-hms:${source.projectId}`;
		this.cachePath = join(resolve(source.projectPath), '.scrivener-mcp', 'cache', 'passage-hms-v2');
		this.engine = hms;
		this.externalEngine = !!hms;
	}

	async refresh(): Promise<IndexSummary> {
		if (this.closed) throw new Error('Passage search service is closed');
		if (this.refreshing) return this.refreshing;
		this.refreshing = sequence(this.cachePath, async () => (await this.updateIndex()).index);
		try {
			return await this.refreshing;
		} finally {
			this.refreshing = undefined;
		}
	}

	private async refreshIndex(): Promise<IndexSummary> {
		const documents = await this.source.list();
		if (documents.length > 10000) throw new Error('Local passage index exceeds 10000 documents');
		const current = new Set(documents.map((doc) => doc.documentId));
		if (new Set(documents.map((doc) => doc.documentId.toLowerCase())).size !== documents.length)
			throw new Error('Source returned duplicate document identities');
		const existing = new Map(
			this.store.list<IndexedDocument>(this.namespace).map((doc) => [doc.documentId, doc])
		);
		let changedDocuments = 0;
		let removedDocuments = 0;
		let total = 0;
		let indexedDocuments = 0;
		const updates: IndexedDocument[] = [];
		for (const doc of documents) {
			if (doc.projectId !== this.source.projectId)
				throw new Error('Source returned a document outside the project scope');
			const prior = existing.get(doc.documentId);
			let next: IndexedDocument;
			if (
				!prior || prior.revision !== doc.revision || prior.version !== INDEX_VERSION ||
				prior.title !== doc.title || prior.path !== doc.path
			) {
				next = {
					version: INDEX_VERSION, projectId: doc.projectId, documentId: doc.documentId,
					revision: doc.revision, title: doc.title, path: doc.path,
					passages: chunkDocument(doc),
				};
				updates.push(next);
				changedDocuments++;
			} else next = prior;
			total += next.passages.length;
			if (next.passages.length) indexedDocuments++;
			if (total > MAX_PASSAGES)
				throw new Error(`Local passage index exceeds ${MAX_PASSAGES} passages`);
		}
		const removed = [...existing.values()].filter((prior) => !current.has(prior.documentId));
		removedDocuments = removed.length;
		if (removed.length || updates.length) this.store.transaction(() => {
			for (const prior of removed) this.store.delete(this.namespace, prior.documentId);
			for (const update of updates) this.store.put(this.namespace, update.documentId, update);
		});
		return { changedDocuments, removedDocuments, passages: total, documents: indexedDocuments };
	}

	private async getEngine(): Promise<HolographicMemorySystem> {
		if (this.engine) return this.engine;
		if (this.enginePromise) return this.enginePromise;
		this.enginePromise = (async () => {
			let directory = resolve(this.source.projectPath);
			for (const part of ['.scrivener-mcp', 'cache', 'passage-hms-v2']) {
				directory = join(directory, part);
				await mkdir(directory, { recursive: true, mode: 0o700 });
				const info = await lstat(directory);
				if (info.isSymbolicLink() || !info.isDirectory())
					throw new Error('Local passage cache must use ordinary project directories');
			}
			const storagePath = join(this.cachePath, 'index.db');
			try {
				const info = await lstat(storagePath);
				if (info.isSymbolicLink()) throw new Error('Local passage cache cannot be a symlink');
				this.bootstrapNative = false;
			} catch (error) {
				if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
			}
			this.engine = new HolographicMemorySystem({
				storagePath, dimensions: CONCEPTS.length, embeddingSpace: EMBEDDING_SPACE,
			});
			return this.engine;
		})();
		try {
			return await this.enginePromise;
		} finally {
			this.enginePromise = undefined;
		}
	}

	private async updateIndex(): Promise<{
		index: IndexSummary;
		entries: IndexedPassage[];
		engine: HolographicMemorySystem;
	}> {
		const index = await this.refreshIndex();
		const entries = this.store.list<IndexedDocument>(this.namespace).flatMap((doc) => {
			if (doc.version !== INDEX_VERSION || doc.projectId !== this.source.projectId ||
				doc.passages.some((entry) => entry.projectId !== doc.projectId || entry.documentId !== doc.documentId ||
					entry.revision !== doc.revision || !/^[a-f0-9]{64}$/.test(entry.id) ||
					!Number.isSafeInteger(entry.start) || !Number.isSafeInteger(entry.end) ||
					!Number.isSafeInteger(entry.line) || entry.start < 0 || entry.end <= entry.start || entry.line < 1 ||
					entry.end - entry.start !== entry.quote.length || entry.quote.length > 1400))
				throw new Error('Local passage catalog contains inconsistent source provenance');
			return doc.passages;
		});
		if (entries.length !== index.passages || new Set(entries.map((entry) => entry.id)).size !== entries.length)
			throw new Error('Local passage catalog contains inconsistent identities');
		const engine = await this.getEngine();
		await this.synchronize(engine, entries);
		return { index, entries, engine };
	}

	private async synchronize(engine: HolographicMemorySystem, entries: IndexedPassage[]): Promise<void> {
		const persistent = engine.getStats().persistentDocuments === true;
		let catalog = (persistent ? this.store.get<SyncCatalog>(this.syncNamespace, 'v2') : volatileCatalogs.get(engine)) ?? {
			version: INDEX_VERSION, projectId: this.source.projectId, applied: [], pending: [],
		};
		if (
			catalog.version !== INDEX_VERSION || catalog.projectId !== this.source.projectId ||
			![catalog.applied, catalog.pending].every((ids) => Array.isArray(ids) && ids.length <= MAX_PASSAGES &&
				ids.every((id) => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)))
		) throw new Error('Local passage synchronization catalog is invalid');
		const save = (next: SyncCatalog) => {
			if (persistent) this.store.put(this.syncNamespace, 'v2', next);
			else volatileCatalogs.set(engine, next);
			catalog = next;
		};
		const wanted = new Set(entries.map((entry) => entry.id));
		const obsolete = [...new Set([...catalog.applied, ...catalog.pending])].filter((id) => !wanted.has(id));
		if (obsolete.length) {
			for (const id of obsolete) await engine.deleteDocument(id);
			await engine.flush();
			save({ ...catalog, applied: catalog.applied.filter((id) => wanted.has(id)), pending: catalog.pending.filter((id) => wanted.has(id)) });
		}
		const applied = new Set(catalog.applied);
		const pending = new Set(catalog.pending);
		const missing = entries.filter((entry) => (persistent && this.bootstrapNative) || !applied.has(entry.id) || pending.has(entry.id));
		if (missing.length) {
			for (const entry of missing) pending.add(entry.id);
			save({ ...catalog, pending: [...pending] });
			for (let offset = 0; offset < missing.length; offset += BATCH_SIZE) {
				const batch = missing.slice(offset, offset + BATCH_SIZE);
				for (const entry of batch) await engine.deleteDocument(entry.id);
				const ids = await engine.memorizeDocuments(batch.map(documentInput));
				if (ids.length !== batch.length || ids.some((id) => !Number.isSafeInteger(id) || id < 0))
					throw new Error('Local passage index did not store every complete passage');
			}
			await engine.flush();
			save({ ...catalog, applied: [...wanted], pending: [] });
		}
		this.bootstrapNative = false;
	}

	search(query: string, options: PassageSearchOptions = {}): Promise<PassageSearchResult> {
		if (this.closed) return Promise.reject(new Error('Passage search service is closed'));
		const task = this.searchPassages(query, options);
		this.activeSearches.add(task);
		void task.then(() => this.activeSearches.delete(task), () => this.activeSearches.delete(task));
		return task;
	}

	private async searchPassages(query: string, options: PassageSearchOptions): Promise<PassageSearchResult> {
		if (typeof query !== 'string' || !query.trim() || query.length > 2048)
			throw new Error('Search query must contain 1 to 2048 UTF-16 code units');
		const limit = options.limit ?? 10;
		const contextChars = options.contextChars ?? 240;
		const mode = options.mode ?? 'hybrid';
		if (!Number.isInteger(limit) || limit < 1 || limit > 50)
			throw new Error('Search limit must be an integer from 1 to 50');
		if (!Number.isInteger(contextChars) || contextChars < 0 || contextChars > 2000)
			throw new Error('Search context must be an integer from 0 to 2000');
		if (!['hybrid', 'keyword', 'semantic'].includes(mode)) throw new Error('Unknown passage search mode');
		if (options.documentIds && (!Array.isArray(options.documentIds) || options.documentIds.length > 10000 ||
			options.documentIds.some((id) => typeof id !== 'string' || !id || id.length > 128)))
			throw new Error('Invalid document search scope');
		const queryConcepts = concepts(query);
		const { index, ranked } = await sequence(this.cachePath, async () => {
			const { index, entries, engine } = await this.updateIndex();
			const scopedIds = options.documentIds ? new Set(options.documentIds) : undefined;
			const scoped = entries.filter((entry) => !scopedIds || scopedIds.has(entry.documentId));
			if (!scoped.length || (mode === 'semantic' && !queryConcepts.length)) return { index, ranked: [] };
			const byId = new Map(scoped.map((entry) => [entry.id, entry]));
			const k = Math.min(scoped.length, Math.max(100, limit * 4), 1000);
			const hits = await engine.searchDocuments(query, {
				k, candidateLimit: Math.min(4096, Math.max(k, limit * 32)),
				...(scopedIds ? { documentIds: [...byId.keys()], filter: { projectId: this.source.projectId, indexVersion: INDEX_VERSION } } : {}),
				embedding: embedding(queryConcepts),
				lexicalWeight: mode === 'semantic' ? 0 : mode === 'hybrid' && queryConcepts.length ? 0.5 : 1,
				semanticWeight: mode === 'keyword' || !queryConcepts.length ? 0 : mode === 'semantic' ? 1 : 0.5,
				fusion: 'blend',
			});
			if (hits.length > k) throw new Error('Local passage index exceeded its retrieval limit');
			const seen = new Set<string>();
			const ranked: RankedPassage[] = [];
			for (const hit of hits) {
				const entry = checkedHit(hit, byId.get(hit.documentId));
				if (seen.has(entry.id)) throw new Error('Local passage index returned duplicate passages');
				seen.add(entry.id);
				const matchedConcepts = queryConcepts.filter((concept) => entry.concepts.includes(concept));
				const keywordScore = Math.max(0, hit.lexicalScore) / (Math.max(0, hit.lexicalScore) + 1);
				const semanticScore = matchedConcepts.length / Math.sqrt(Math.max(1, queryConcepts.length * entry.concepts.length));
				if (mode === 'semantic' ? semanticScore <= 0 : mode === 'keyword' ? keywordScore <= 0 : keywordScore <= 0 && semanticScore <= 0) continue;
				const score = Math.max(0, Math.min(1, hit.score));
				ranked.push({ entry, keywordScore, semanticScore, hmsScore: score, matchedConcepts, score });
			}
			ranked.sort((a, b) => b.score - a.score || a.entry.documentId.localeCompare(b.entry.documentId) || a.entry.start - b.entry.start);
			return { index, ranked: ranked.slice(0, limit) };
		});
		const results: PassageMatch[] = [];
		const documents = new Map<string, Promise<SourceDocument>>();
		for (const hit of ranked) {
			let pending = documents.get(hit.entry.documentId);
			if (!pending) {
				pending = this.source.read(hit.entry.documentId);
				documents.set(hit.entry.documentId, pending);
			}
			const doc = await pending;
			if (doc.projectId !== this.source.projectId || doc.documentId !== hit.entry.documentId ||
				doc.revision !== hit.entry.revision || doc.text.slice(hit.entry.start, hit.entry.end) !== hit.entry.quote) continue;
			const { id: _id, concepts: _concepts, ...passage } = hit.entry;
			let contextStart = Math.max(0, passage.start - contextChars);
			let contextEnd = Math.min(doc.text.length, passage.end + contextChars);
			if (/[\uDC00-\uDFFF]/u.test(doc.text[contextStart] ?? '') && /[\uD800-\uDBFF]/u.test(doc.text[contextStart - 1] ?? '')) contextStart--;
			if (/[\uDC00-\uDFFF]/u.test(doc.text[contextEnd] ?? '') && /[\uD800-\uDBFF]/u.test(doc.text[contextEnd - 1] ?? '')) contextEnd++;
			results.push({ ...passage, context: doc.text.slice(contextStart, contextEnd), contextStart, contextEnd,
				score: hit.score, keywordScore: hit.keywordScore, semanticScore: hit.semanticScore,
				hmsScore: hit.hmsScore, matchedConcepts: hit.matchedConcepts });
		}
		return {
			results, query, mode,
			method: 'HMS document BM25 + supplied local story-concept vectors (v2)',
			limitations: 'Conceptual retrieval uses a bounded English story-concept vocabulary, not a general language embedding model. HMS fuses BM25 with these supplied concept vectors; unknown concepts need keyword search. No provider is contacted.',
			index,
		};
	}

	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		const refresh = this.refreshing;
		this.closing = (async () => {
			await Promise.allSettled(this.activeSearches);
			const failures: unknown[] = [];
			try { await refresh; } catch (error) { failures.push(error); }
			const engine = this.engine;
			this.engine = undefined;
			if (!this.externalEngine) {
				try { await engine?.destroy(); } catch (error) { failures.push(error); }
			}
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) throw new Error('Passage search resources failed to close', { cause: failures });
		})();
		return this.closing;
	}
}
