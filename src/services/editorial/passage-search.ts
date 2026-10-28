import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { HolographicMemorySystem } from '../memory/hhm/holographic-memory-system.js';
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

const STOP = new Set(
	'a an and are as at be been but by for from had has have he her him his i in is it its of on or she that the their them they this to was we were what when where which who will with you your find show passage scene about'.split(
		' '
	)
);
const INDEX_VERSION = 1;
const MAX_PASSAGES = 50000;

interface IndexedPassage extends SourcePassage {
	id: string;
	concepts: string[];
	terms: string[];
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
	index: { changedDocuments: number; removedDocuments: number; passages: number };
}

function terms(text: string): string[] {
	return (
		text
			.normalize('NFKC')
			.toLocaleLowerCase('en')
			.match(/[\p{L}\p{N}]+/gu) || []
	).filter((word) => !STOP.has(word));
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
			terms: terms(quote),
		});
		start = end;
	}
	return chunks;
}

export class PassageSearch {
	private readonly namespace: string;
	private engine?: HolographicMemorySystem;
	private externalEngine: boolean;
	private cachePath?: string;
	private loaded = new Set<string>();
	private readonly cachedRevisions = new Map<string, string>();
	private indexGeneration = 0;
	private engineGeneration = -1;
	private engineWork: Promise<void> = Promise.resolve();
	private refreshing?: Promise<{
		changedDocuments: number;
		removedDocuments: number;
		passages: number;
	}>;
	private enginePromise?: Promise<HolographicMemorySystem>;
	private readonly activeSearches = new Set<Promise<PassageSearchResult>>();
	private closed = false;

	constructor(
		private readonly source: ManuscriptSource,
		private readonly store: PersistentStore,
		hms?: HolographicMemorySystem
	) {
		this.namespace = `passage-documents:${source.projectId}`;
		this.engine = hms;
		this.externalEngine = !!hms;
	}

	async refresh(): Promise<{
		changedDocuments: number;
		removedDocuments: number;
		passages: number;
	}> {
		if (this.closed) throw new Error('Passage search service is closed');
		if (this.refreshing) return this.refreshing;
		this.refreshing = this.refreshIndex();
		try {
			return await this.refreshing;
		} finally {
			this.refreshing = undefined;
		}
	}

	private async refreshIndex(): Promise<{
		changedDocuments: number;
		removedDocuments: number;
		passages: number;
	}> {
		const documents = await this.source.list();
		const current = new Map(documents.map((doc) => [doc.documentId, doc]));
		if (current.size !== documents.length) throw new Error('Source returned duplicate document identities');
		const existing = new Map(this.store.list<IndexedDocument>(this.namespace).map((doc) => [doc.documentId, doc]));
		let changedDocuments = 0;
		let removedDocuments = 0;
		let total = 0;
		const updates: IndexedDocument[] = [];
		for (const doc of documents) {
			if (doc.projectId !== this.source.projectId)
				throw new Error('Source returned a document outside the project scope');
			const prior = existing.get(doc.documentId);
			let next: IndexedDocument;
			if (
				!prior ||
				prior.revision !== doc.revision ||
				prior.version !== INDEX_VERSION ||
				prior.title !== doc.title ||
				prior.path !== doc.path
			) {
				next = {
					version: INDEX_VERSION,
					projectId: doc.projectId,
					documentId: doc.documentId,
					revision: doc.revision,
					title: doc.title,
					path: doc.path,
					passages: chunkDocument(doc),
				};
				updates.push(next);
				changedDocuments++;
			} else next = prior;
			total += next.passages.length;
			if (total > MAX_PASSAGES)
				throw new Error(`Local passage index exceeds ${MAX_PASSAGES} passages`);
		}
		this.store.transaction(() => {
			for (const prior of existing.values())
				if (!current.has(prior.documentId)) {
					this.store.delete(this.namespace, prior.documentId);
					removedDocuments++;
				}
			for (const update of updates) this.store.put(this.namespace, update.documentId, update);
		});
		if (changedDocuments || removedDocuments || [...this.cachedRevisions].some(([id, revision]) => current.get(id)?.revision !== revision))
			this.indexGeneration++;
		return { changedDocuments, removedDocuments, passages: total };
	}

	private async getEngine(): Promise<HolographicMemorySystem> {
		if (this.enginePromise) return this.enginePromise;
		if (!this.engine) {
			this.enginePromise = (async () => {
				const root = join(this.source.projectPath, '.scrivener-mcp', 'cache');
				await mkdir(root, { recursive: true, mode: 0o700 });
				this.cachePath = await mkdtemp(join(root, 'passage-hms-'));
				this.engine = new HolographicMemorySystem({
					storagePath: join(this.cachePath, 'index.db'),
					dimensions: 512,
					maxMemories: MAX_PASSAGES,
				});
				return this.engine;
			})();
			try {
				return await this.enginePromise;
			} finally {
				this.enginePromise = undefined;
			}
		}
		return this.engine;
	}

	search(query: string, options: PassageSearchOptions = {}): Promise<PassageSearchResult> {
		if (this.closed) return Promise.reject(new Error('Passage search service is closed'));
		const task = this.searchPassages(query, options);
		this.activeSearches.add(task);
		void task.then(
			() => this.activeSearches.delete(task),
			() => this.activeSearches.delete(task)
		);
		return task;
	}

	private async searchPassages(
		query: string,
		options: PassageSearchOptions
	): Promise<PassageSearchResult> {
		if (typeof query !== 'string' || !query.trim() || query.length > 2048)
			throw new Error('Search query must contain 1 to 2048 UTF-16 code units');
		const limit = options.limit ?? 10;
		const contextChars = options.contextChars ?? 240;
		const mode = options.mode ?? 'hybrid';
		if (!Number.isInteger(limit) || limit < 1 || limit > 50)
			throw new Error('Search limit must be an integer from 1 to 50');
		if (!Number.isInteger(contextChars) || contextChars < 0 || contextChars > 2000)
			throw new Error('Search context must be an integer from 0 to 2000');
		if (!['hybrid', 'keyword', 'semantic'].includes(mode))
			throw new Error('Unknown passage search mode');
		if (
			options.documentIds &&
			(!Array.isArray(options.documentIds) ||
				options.documentIds.length > 10000 ||
				options.documentIds.some((id) => typeof id !== 'string' || !id || id.length > 128))
		)
			throw new Error('Invalid document search scope');
		const index = await this.refresh();
		const generation = this.indexGeneration;
		const scopedIds = options.documentIds ? new Set(options.documentIds) : undefined;
		const entries = this.store
			.list<IndexedDocument>(this.namespace)
			.flatMap((doc) => (scopedIds && !scopedIds.has(doc.documentId) ? [] : doc.passages));
		const queryTerms = [...new Set(terms(query))];
		const queryConcepts = concepts(query);
		const hmsScores = new Map<string, number>();
		if (entries.length && mode === 'hybrid') {
			const pending = this.engineWork.then(async () => {
			if (this.engineGeneration !== -1 && this.engineGeneration !== generation)
				await this.disposeEngine();
			const engine = await this.getEngine();
			this.engineGeneration = generation;
			for (const entry of entries) this.cachedRevisions.set(entry.documentId, entry.revision);
			const missing = entries.filter((entry) => !this.loaded.has(entry.id));
			if (missing.length) {
				await engine.memorizeBatch(
					missing.map((entry) => ({
						id: entry.id,
						text: `${entry.quote}\n${entry.concepts.map((concept) => `storyconcept${concept}`).join(' ')}`,
					}))
				);
				for (const entry of missing) this.loaded.add(entry.id);
			}
			for (const hit of await engine.queryText(
				`${query}\n${queryConcepts.map((concept) => `storyconcept${concept}`).join(' ')}`,
				Math.min(this.loaded.size, MAX_PASSAGES)
			))
				hmsScores.set(hit.id, Math.max(0, Math.min(1, hit.similarity)));
			});
			this.engineWork = pending.catch(() => undefined);
			await pending;
		}
		const documentFrequency = new Map<string, number>();
		const queryTermSet = new Set(queryTerms);
		let totalTerms = 0;
		const weightedEntries = entries.map((entry) => {
			const counts = new Map<string, number>();
			for (const term of entry.terms) {
				if (queryTermSet.has(term)) counts.set(term, (counts.get(term) ?? 0) + 1);
			}
			for (const term of counts.keys())
				documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
			totalTerms += entry.terms.length;
			return { entry, counts };
		});
		const averageLength = totalTerms / Math.max(entries.length, 1);
		const ranked = weightedEntries
			.map(({ entry, counts }) => {
				let bm25 = 0;
				for (const term of queryTerms) {
					const count = counts.get(term) ?? 0;
					if (!count) continue;
					const frequency = documentFrequency.get(term) ?? 0;
					bm25 +=
						(Math.log(1 + (entries.length - frequency + 0.5) / (frequency + 0.5)) *
							count *
							2.2) /
						(count +
							1.2 *
								(0.25 + (0.75 * entry.terms.length) / Math.max(averageLength, 1)));
				}
				const keywordScore = bm25 / (bm25 + 1);
				const matchedConcepts = queryConcepts.filter((concept) =>
					entry.concepts.includes(concept)
				);
				const semanticScore =
					matchedConcepts.length /
					Math.sqrt(Math.max(1, queryConcepts.length * entry.concepts.length));
				const hmsScore = hmsScores.get(entry.id) ?? 0;
				const score =
					mode === 'keyword'
						? keywordScore
						: mode === 'semantic'
							? semanticScore
							: 0.5 * keywordScore + 0.45 * semanticScore + 0.05 * hmsScore;
				return { entry, keywordScore, semanticScore, hmsScore, matchedConcepts, score };
			})
			.filter((hit) =>
				mode === 'semantic'
					? hit.semanticScore > 0
					: mode === 'keyword'
						? hit.keywordScore > 0
						: hit.keywordScore > 0 || hit.semanticScore > 0
			)
			.sort(
				(a, b) =>
					b.score - a.score ||
					a.entry.documentId.localeCompare(b.entry.documentId) ||
					a.entry.start - b.entry.start
			)
			.slice(0, limit);
		const results: PassageMatch[] = [];
		const sourceDocuments = new Map<string, Promise<SourceDocument>>();
		for (const hit of ranked) {
			let pending = sourceDocuments.get(hit.entry.documentId);
			if (!pending) {
				pending = this.source.read(hit.entry.documentId);
				sourceDocuments.set(hit.entry.documentId, pending);
			}
			const doc = await pending;
			if (doc.projectId !== this.source.projectId || doc.revision !== hit.entry.revision)
				continue;
			const { id: _id, concepts: _concepts, terms: _terms, ...passage } = hit.entry;
			const contextStart = Math.max(0, passage.start - contextChars);
			const contextEnd = Math.min(doc.text.length, passage.end + contextChars);
			results.push({
				...passage,
				context: doc.text.slice(contextStart, contextEnd),
				contextStart,
				contextEnd,
				score: hit.score,
				keywordScore: hit.keywordScore,
				semanticScore: hit.semanticScore,
				hmsScore: hit.hmsScore,
				matchedConcepts: hit.matchedConcepts,
			});
		}
		return {
			results,
			query,
			mode,
			method: 'Local story-concept cosine + BM25 + HMS text vectors (v1)',
			limitations:
				'Conceptual retrieval uses a bounded English story-concept vocabulary, not a general language embedding model. HMS token vectors contribute only to hybrid ranking; unknown concepts need keyword search. No provider is contacted.',
			index,
		};
	}

	async close(): Promise<void> {
		this.closed = true;
		const refresh = this.refreshing;
		const failures: unknown[] = [];
		await Promise.allSettled(this.activeSearches);
		try { await refresh; } catch (error) { failures.push(error); }
		try { await this.disposeEngine(); } catch (error) { failures.push(error); }
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) throw new Error('Passage search resources failed to close', { cause: failures });
	}

	private async disposeEngine(): Promise<void> {
		const engine = this.engine;
		const owned = !this.externalEngine;
		const cachePath = this.cachePath;
		this.engine = undefined;
		this.externalEngine = false;
		this.cachePath = undefined;
		this.engineGeneration = -1;
		this.loaded.clear();
		this.cachedRevisions.clear();
		const failures: unknown[] = [];
		if (owned) {
			try { await engine?.destroy(); } catch (error) { failures.push(error); }
			try {
				if (cachePath) await rm(cachePath, { recursive: true, force: true });
			} catch (error) { failures.push(error); }
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) throw new Error('Passage search resources failed to close', { cause: failures });
	}
}
