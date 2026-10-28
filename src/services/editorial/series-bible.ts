import { randomUUID } from 'node:crypto';
import type { MemoryManager } from '../../memory-manager.js';
import type { PersistentStore } from './persistent-store.js';
import type {
	FactConfidence,
	FactKind,
	ManuscriptSource,
	SourceDocument,
	SourcePassage,
	StoryFact,
} from './types.js';
import {
	passageState,
	stableStoryId,
	storyIdentifier,
	storyText,
	verifyPassage,
	sourceKey,
} from './provenance.js';

export type StoryScope = StoryFact['scope'];

export interface SeriesDefinition {
	id: string;
	name: string;
	projects: Array<{ projectId: string; projectPath: string }>;
	createdAt: string;
	updatedAt: string;
}

export interface FactView extends StoryFact {
	sourceStates: Array<{ source: SourcePassage; state: 'current' | 'stale' | 'unavailable' }>;
	stale: boolean;
}

export interface CurateFactInput {
	id?: string;
	scope: StoryScope;
	kind: FactKind;
	subject: string;
	predicate: string;
	value: string;
	confidence?: FactConfidence;
	sources: SourcePassage[];
	storyTime?: string;
	intentional?: boolean;
	supersedes?: string;
}

export type FactCorrection = Partial<
	Pick<
		CurateFactInput,
		'subject' | 'predicate' | 'value' | 'confidence' | 'sources' | 'storyTime' | 'intentional'
	>
>;

type EvidenceReader = (passage: SourcePassage) => Promise<SourceDocument | undefined>;

const FACTS = 'story:facts';
const SERIES = 'story:series';
const CORRECTIONS = 'story:corrections';
const KINDS: readonly FactKind[] = ['character', 'alias', 'location', 'world-rule', 'chronology'];
const CONFIDENCES: readonly FactConfidence[] = ['confirmed', 'inferred', 'uncertain'];

export class SeriesBible {
	constructor(
		private readonly source: ManuscriptSource,
		private readonly projectStore: PersistentStore,
		private readonly seriesStore: PersistentStore = projectStore,
		private readonly resolveSource?: (
			projectId: string
		) => Promise<ManuscriptSource | undefined>
	) {}

	createSeries(name: string): SeriesDefinition {
		const now = new Date().toISOString();
		const series: SeriesDefinition = {
			id: randomUUID(),
			name: storyText(name, 'Series name', 200),
			projects: [{ projectId: this.source.projectId, projectPath: this.source.projectPath }],
			createdAt: now,
			updatedAt: now,
		};
		this.seriesStore.put(SERIES, series.id, series);
		return series;
	}

	joinSeries(seriesId: string): SeriesDefinition {
		storyIdentifier(seriesId, 'Series id');
		return this.seriesStore.transaction(() => {
			const series = this.seriesStore.get<SeriesDefinition>(SERIES, seriesId);
			if (!series) throw new Error('Series was not found in the selected series store');
			if (!series.projects.some((project) => project.projectId === this.source.projectId)) {
				if (series.projects.length >= 100)
					throw new Error('A series supports at most 100 explicitly selected projects');
				series.projects.push({
					projectId: this.source.projectId,
					projectPath: this.source.projectPath,
				});
				series.updatedAt = new Date().toISOString();
				this.seriesStore.put(SERIES, series.id, series);
			}
			return series;
		});
	}

	leaveSeries(seriesId: string): SeriesDefinition {
		return this.seriesStore.transaction(() => {
			const series = this.requireSeries(seriesId);
			series.projects = series.projects.filter(
				(project) => project.projectId !== this.source.projectId
			);
			series.updatedAt = new Date().toISOString();
			this.seriesStore.put(SERIES, series.id, series);
			return series;
		});
	}

	listSeries(): SeriesDefinition[] {
		return this.seriesStore
			.list<SeriesDefinition>(SERIES)
			.filter((series) =>
				series.projects.some((project) => project.projectId === this.source.projectId)
			);
	}

	async curate(input: CurateFactInput): Promise<StoryFact> {
		const store = this.storeFor(input.scope);
		const fact = await this.prepareFact(input);
		return store.transaction(() => {
			this.storeFor(input.scope);
			for (const passage of fact.sources) this.authorizeSource(fact.scope, passage.projectId);
			const existing = store.get<StoryFact>(FACTS, fact.id);
			if (existing) {
				if (this.signature(existing) !== this.signature(fact))
					throw new Error(
						'Fact id already belongs to different content; use a correction'
					);
				return existing;
			}
			if (fact.supersedes) throw new Error('Use correct to create an atomic fact correction');
			store.put(FACTS, fact.id, fact);
			return fact;
		});
	}

	async correct(scope: StoryScope, id: string, patch: FactCorrection): Promise<StoryFact> {
		const store = this.storeFor(scope);
		const original = this.requireFact(store, scope, id);
		if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0)
			throw new Error('A correction must change at least one fact field');
		const permitted = [
			'subject',
			'predicate',
			'value',
			'confidence',
			'sources',
			'storyTime',
			'intentional',
		];
		if (Object.keys(patch).some((key) => !permitted.includes(key)))
			throw new Error('Correction includes an unsupported field');
		const updated = await this.prepareFact({
			...original,
			...patch,
			id: undefined,
			supersedes: original.id,
		});
		const unchanged =
			this.signature(original) ===
			this.signature({ ...updated, supersedes: original.supersedes });
		return store.transaction(() => {
			this.storeFor(scope);
			for (const passage of updated.sources)
				this.authorizeSource(updated.scope, passage.projectId);
			const successor = store.get<{ id: string }>(CORRECTIONS, original.id);
			if (successor) {
				if (successor.id === updated.id) return this.requireFact(store, scope, updated.id);
				throw new Error(
					'This fact has already been corrected; read the current fact before applying another correction'
				);
			}
			if (unchanged) return original;
			store.put(FACTS, updated.id, updated);
			store.put(CORRECTIONS, original.id, { id: updated.id });
			return updated;
		});
	}

	async listFacts(
		scope: StoryScope,
		options: { includeSuperseded?: boolean; sourceDocuments?: readonly SourceDocument[] } = {}
	): Promise<FactView[]> {
		const store = this.storeFor(scope);
		const facts = store
			.list<StoryFact>(FACTS)
			.filter((fact) => fact.scope.kind === scope.kind && fact.scope.id === scope.id);
		const superseded = new Set(facts.flatMap((fact) => fact.supersedes ? [fact.supersedes] : []));
		const read = this.evidenceReader(scope, options.sourceDocuments);
		const results: FactView[] = [];
		for (const fact of facts) {
			if (!options.includeSuperseded && superseded.has(fact.id)) continue;
			const sourceStates = await this.sourceStates(fact.sources, read);
			results.push({
				...fact,
				sourceStates,
				stale: sourceStates.some((item) => item.state !== 'current'),
			});
		}
		return results;
	}

	async checkPassages(scope: StoryScope, passages: readonly SourcePassage[], sourceDocuments?: readonly SourceDocument[]): Promise<FactView['sourceStates']> {
		return this.sourceStates(passages, this.evidenceReader(scope, sourceDocuments));
	}

	private async sourceStates(passages: readonly SourcePassage[], read: EvidenceReader): Promise<FactView['sourceStates']> {
		const states: FactView['sourceStates'] = [];
		for (const passage of passages) states.push({ source: passage, state: passageState(await read(passage), passage) });
		return states;
	}

	async recheck(
		scope: StoryScope
	): Promise<{ facts: FactView[]; current: number; stale: number; unavailable: number }> {
		const facts = await this.listFacts(scope);
		return {
			facts,
			current: facts.filter((fact) => fact.sources.length > 0 && !fact.stale).length,
			stale: facts.filter((fact) =>
				fact.sourceStates.some((source) => source.state === 'stale')
			).length,
			unavailable: facts.filter((fact) =>
				fact.sourceStates.some((source) => source.state === 'unavailable')
			).length,
		};
	}

	async importMemory(memory: MemoryManager): Promise<StoryFact[]> {
		const scope: StoryScope = { kind: 'project', id: this.source.projectId };
		const imported: StoryFact[] = [];
		const characters = await memory.getAllCharacters();
		for (const character of characters) {
			const input = {
				scope,
				kind: 'character' as const,
				subject: character.name,
				predicate: 'profile',
				value: character.description || character.name,
				confidence: 'inferred' as const,
				sources: [],
			};
			const id = stableStoryId('memory', this.source.projectId, 'character', character.id);
			if (!this.projectStore.get(FACTS, id))
				imported.push(await this.curate({ ...input, id }));
		}
		const world = memory.getCustomContext('worldBuilding');
		if (world && typeof world === 'object' && !Array.isArray(world)) {
			const locations = (world as Record<string, unknown>).locations;
			if (Array.isArray(locations)) {
				for (const location of locations.slice(0, 1000)) {
					if (!location || typeof location !== 'object') continue;
					const entry = location as Record<string, unknown>;
					if (typeof entry.name !== 'string') continue;
					const id = stableStoryId(
						'memory',
						this.source.projectId,
						'location',
						entry.name
					);
					if (!this.projectStore.get(FACTS, id))
						imported.push(
							await this.curate({
								id,
								scope,
								kind: 'location',
								subject: entry.name,
								predicate: 'description',
								value:
									typeof entry.description === 'string' &&
									entry.description.trim()
										? entry.description
										: entry.name,
								confidence: 'inferred',
								sources: [],
							})
						);
				}
			}
		}
		const plots = await memory.getPlotThreads();
		for (const plot of plots) {
			const id = stableStoryId('memory', this.source.projectId, 'plot', plot.id);
			if (!this.projectStore.get(FACTS, id))
				imported.push(
					await this.curate({
						id,
						scope,
						kind: 'chronology',
						subject: plot.name,
						predicate: 'plot-thread',
						value: plot.description || plot.status,
						confidence: 'inferred',
						sources: [],
					})
				);
		}
		return imported;
	}

	private requireSeries(id: string): SeriesDefinition {
		storyIdentifier(id, 'Series id');
		const series = this.seriesStore.get<SeriesDefinition>(SERIES, id);
		if (
			!series ||
			!series.projects.some((project) => project.projectId === this.source.projectId)
		)
			throw new Error('The open project is not an explicitly selected member of this series');
		return series;
	}

	private storeFor(scope: StoryScope): PersistentStore {
		if (!scope || typeof scope !== 'object')
			throw new Error('An explicit project or series scope is required');
		storyIdentifier(scope.id, 'Scope id');
		if (scope.kind === 'project' && scope.id === this.source.projectId)
			return this.projectStore;
		if (scope.kind === 'series') {
			this.requireSeries(scope.id);
			return this.seriesStore;
		}
		throw new Error('Project scope must name the currently open project');
	}

	private authorizeSource(scope: StoryScope, projectId: string): void {
		storyIdentifier(projectId, 'Source project id');
		if (scope.kind === 'project' && projectId === this.source.projectId) return;
		if (
			scope.kind === 'series' &&
			this.requireSeries(scope.id).projects.some((project) => project.projectId === projectId)
		)
			return;
		throw new Error('Source project is outside the explicitly selected scope');
	}

	private evidenceReader(scope: StoryScope, sourceDocuments: readonly SourceDocument[] = []): EvidenceReader {
		this.storeFor(scope);
		const allowed = new Set(scope.kind === 'series' ? this.requireSeries(scope.id).projects.map((project) => project.projectId) : [this.source.projectId]);
		const sources = new Map<string, Promise<ManuscriptSource | undefined>>([[this.source.projectId, Promise.resolve(this.source)]]);
		const documents = new Map<string, Promise<SourceDocument | undefined>>(sourceDocuments.filter((document) => document.projectId === this.source.projectId).map((document) => [sourceKey(document), Promise.resolve(document)]));
		return (passage) => {
			if (!allowed.has(passage.projectId)) return Promise.resolve(undefined);
			const key = sourceKey(passage);
			let pending = documents.get(key);
			if (!pending) {
				pending = (async () => {
					let source = sources.get(passage.projectId);
					if (!source) {
						source = this.resolveSource?.(passage.projectId) ?? Promise.resolve(undefined);
						sources.set(passage.projectId, source);
					}
					const resolved = await source;
					if (!resolved) return undefined;
					try {
						return await resolved.read(passage.documentId);
					} catch (error) {
						if (error && typeof error === 'object' && 'code' in error && ['ENOENT', 'NOT_FOUND', 'DOCUMENT_NOT_FOUND'].includes(String(error.code))) return undefined;
						throw error;
					}
				})();
				documents.set(key, pending);
			}
			return pending;
		};
	}

	private async prepareFact(input: CurateFactInput): Promise<StoryFact> {
		this.storeFor(input.scope);
		if (!KINDS.includes(input.kind)) throw new Error('Unknown story fact kind');
		const confidence = input.confidence ?? 'inferred';
		if (!CONFIDENCES.includes(confidence)) throw new Error('Unknown story fact confidence');
		if (!Array.isArray(input.sources) || input.sources.length > 32)
			throw new Error('Fact sources must be an array of at most 32 passages');
		if (confidence === 'confirmed' && input.sources.length === 0)
			throw new Error(
				'Confirmed canon requires a verified source passage; source-free memory remains inferred'
			);
		if (input.intentional !== undefined && typeof input.intentional !== 'boolean')
			throw new Error('intentional must be a boolean');
		const sources: SourcePassage[] = [];
		const read = this.evidenceReader(input.scope);
		for (const passage of input.sources) {
			if (!passage || typeof passage !== 'object')
				throw new Error('Each fact source must be a source passage');
			storyIdentifier(passage.documentId, 'Source document id');
			this.authorizeSource(input.scope, passage.projectId);
			const document = await read(passage);
			if (!document)
				throw new Error(
					'Source document is unavailable; open or register the selected project before curating its facts'
				);
			sources.push(verifyPassage(document, passage));
		}
		const fact: StoryFact = {
			id: '',
			scope: { kind: input.scope.kind, id: input.scope.id },
			kind: input.kind,
			subject: storyText(input.subject, 'Fact subject', 200),
			predicate: storyText(input.predicate, 'Fact predicate', 200),
			value: storyText(input.value, 'Fact value'),
			confidence,
			sources,
			updatedAt: new Date().toISOString(),
		};
		if (input.storyTime !== undefined)
			fact.storyTime = storyText(input.storyTime, 'Story time', 200);
		if (input.intentional !== undefined) fact.intentional = input.intentional;
		if (input.supersedes !== undefined)
			fact.supersedes = storyIdentifier(input.supersedes, 'Superseded fact id');
		fact.id = input.id
			? storyIdentifier(input.id, 'Fact id')
			: stableStoryId('fact', this.signature(fact));
		return fact;
	}

	private signature(fact: StoryFact): string {
		const { id: _id, updatedAt: _updatedAt, ...content } = fact;
		return JSON.stringify(content);
	}

	private requireFact(store: PersistentStore, scope: StoryScope, id: string): StoryFact {
		storyIdentifier(id, 'Fact id');
		const fact = store.get<StoryFact>(FACTS, id);
		if (!fact || fact.scope.kind !== scope.kind || fact.scope.id !== scope.id)
			throw new Error('Fact not found in the selected scope');
		return fact;
	}
}
