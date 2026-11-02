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

export interface StoryState {
	schemaVersion: 1;
	scope: StoryScope;
	revision: string;
	facts: StoryFact[];
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
		const superseded = new Set(
			facts.flatMap((fact) => (fact.supersedes ? [fact.supersedes] : []))
		);
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

	async checkPassages(
		scope: StoryScope,
		passages: readonly SourcePassage[],
		sourceDocuments?: readonly SourceDocument[]
	): Promise<FactView['sourceStates']> {
		return this.sourceStates(passages, this.evidenceReader(scope, sourceDocuments));
	}

	private async sourceStates(
		passages: readonly SourcePassage[],
		read: EvidenceReader
	): Promise<FactView['sourceStates']> {
		const states: FactView['sourceStates'] = [];
		for (const passage of passages)
			states.push({ source: passage, state: passageState(await read(passage), passage) });
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

	exportState(scope: StoryScope): StoryState {
		const store = this.storeFor(scope);
		const facts = store
			.list<StoryFact>(FACTS, { maxItems: 1000, maxBytes: 4 * 1024 * 1024 })
			.filter((fact) => fact.scope.kind === scope.kind && fact.scope.id === scope.id);
		return {
			schemaVersion: 1,
			scope: { ...scope },
			revision: stableStoryId('story-state', JSON.stringify(facts)),
			facts,
		};
	}

	async importState(
		scope: StoryScope,
		input: unknown,
		expectedRevision: string
	): Promise<StoryState> {
		const store = this.storeFor(scope);
		if (!/^[a-f0-9]{64}$/.test(expectedRevision))
			throw new Error('Expected story-state revision must be a SHA-256 digest');
		if (!input || typeof input !== 'object' || Array.isArray(input))
			throw new Error('A story-state object is required');
		const snapshot = input as StoryState;
		if (
			Object.keys(input).some(
				(key) => !['schemaVersion', 'scope', 'revision', 'facts'].includes(key)
			) ||
			snapshot.schemaVersion !== 1 ||
			snapshot.scope?.kind !== scope.kind ||
			snapshot.scope?.id !== scope.id ||
			!/^[a-f0-9]{64}$/.test(snapshot.revision) ||
			!Array.isArray(snapshot.facts) ||
			snapshot.facts.length > 1000 ||
			Buffer.byteLength(JSON.stringify(input)) > 4 * 1024 * 1024
		)
			throw new Error('Invalid, foreign or oversized story-state snapshot');
		if (this.exportState(scope).revision !== expectedRevision)
			throw new Error('Story state changed; export the current state before importing');
		const facts = new Map<string, StoryFact>();
		for (const value of snapshot.facts) {
			if (
				!value ||
				typeof value !== 'object' ||
				Array.isArray(value) ||
				Object.keys(value).some(
					(key) =>
						![
							'id',
							'scope',
							'kind',
							'subject',
							'predicate',
							'value',
							'confidence',
							'sources',
							'storyTime',
							'intentional',
							'supersedes',
							'updatedAt',
						].includes(key)
				) ||
				value.scope?.kind !== scope.kind ||
				value.scope?.id !== scope.id ||
				typeof value.updatedAt !== 'string' ||
				value.updatedAt.length !== 24 ||
				!Number.isFinite(Date.parse(value.updatedAt)) ||
				new Date(value.updatedAt).toISOString() !== value.updatedAt
			)
				throw new Error('Invalid story-state fact');
			storyIdentifier(value.id, 'Fact id');
			const fact = await this.prepareFact(value);
			fact.updatedAt = value.updatedAt;
			if (facts.has(fact.id)) throw new Error('Duplicate story-state fact identity');
			facts.set(fact.id, fact);
		}
		return store.transaction(() => {
			if (this.exportState(scope).revision !== expectedRevision)
				throw new Error('Story state changed during import');
			const combined = new Map(this.exportState(scope).facts.map((fact) => [fact.id, fact]));
			for (const fact of facts.values()) {
				for (const source of fact.sources) this.authorizeSource(scope, source.projectId);
				const existing = store.get<StoryFact>(FACTS, fact.id);
				if (existing && JSON.stringify(existing) !== JSON.stringify(fact))
					throw new Error('Fact identity conflicts with saved content; use a correction');
				combined.set(fact.id, fact);
			}
			if (
				combined.size > 1000 ||
				Buffer.byteLength(JSON.stringify([...combined.values()])) > 4 * 1024 * 1024
			)
				throw new Error('Merged story state exceeds its bounded import budget');
			const successors = new Map<string, string>();
			for (const fact of combined.values()) {
				if (!fact.supersedes) continue;
				if (!combined.has(fact.supersedes) || successors.has(fact.supersedes))
					throw new Error('Ambiguous or missing fact correction history');
				successors.set(fact.supersedes, fact.id);
				const seen = new Set([fact.id]);
				let previous: StoryFact | undefined = combined.get(fact.supersedes);
				while (previous) {
					if (seen.has(previous.id)) throw new Error('Cyclic fact correction history');
					seen.add(previous.id);
					previous = previous.supersedes ? combined.get(previous.supersedes) : undefined;
				}
			}
			for (const fact of facts.values()) store.put(FACTS, fact.id, fact);
			for (const [previous, id] of successors) store.put(CORRECTIONS, previous, { id });
			return this.exportState(scope);
		});
	}

	async importMemory(memory: MemoryManager): Promise<StoryFact[]> {
		const snapshot = memory.getMemorySnapshot();
		const revision = memory.memoryRevision(snapshot);
		const scope: StoryScope = { kind: 'project', id: this.source.projectId };
		const inputs = new Map<string, CurateFactInput>();
		const add = (
			sourceKind: string,
			sourceId: string,
			kind: FactKind,
			subject: string,
			predicate: string,
			value: string
		) => {
			const id = stableStoryId('memory', this.source.projectId, sourceKind, sourceId);
			if (this.projectStore.get(FACTS, id)) return;
			const previous = inputs.get(id);
			if (previous && previous.value !== value)
				throw new Error(
					'Memory contains conflicting facts with the same identity; curate them explicitly'
				);
			inputs.set(id, {
				id,
				scope,
				kind,
				subject,
				predicate,
				value,
				confidence: 'inferred',
				sources: [],
			});
		};
		for (const character of snapshot.characters)
			add(
				'character',
				character.id,
				'character',
				character.name,
				'profile',
				character.description || character.name
			);
		for (const element of snapshot.worldBuilding)
			add(
				'world',
				element.id,
				element.type === 'location' ? 'location' : 'world-rule',
				element.name,
				'description',
				element.description || element.name
			);
		const canonicalLocations = new Set(
			snapshot.worldBuilding
				.filter((element) => element.type === 'location')
				.map((element) =>
					JSON.stringify([element.name, element.description || element.name])
				)
		);
		let remainingLocations = 1000;
		for (const world of [snapshot.customContext.worldBuilding, snapshot.customContext]) {
			if (!world || typeof world !== 'object' || Array.isArray(world)) continue;
			const locations = (world as Record<string, unknown>).locations;
			if (Array.isArray(locations)) {
				remainingLocations -= locations.length;
				if (remainingLocations < 0)
					throw new Error(
						'Legacy world memory exceeds the 1000-location import limit; curate selected facts explicitly'
					);
				for (const location of locations) {
					if (!location || typeof location !== 'object') continue;
					const entry = location as Record<string, unknown>;
					if (typeof entry.name !== 'string') continue;
					const value =
						typeof entry.description === 'string' && entry.description.trim()
							? entry.description
							: entry.name;
					if (canonicalLocations.has(JSON.stringify([entry.name, value]))) continue;
					add('location', entry.name, 'location', entry.name, 'description', value);
				}
			}
		}
		for (const plot of snapshot.plotThreads)
			add(
				'plot',
				plot.id,
				'chronology',
				plot.name,
				'plot-thread',
				plot.description || plot.status || plot.name
			);
		const prepared: StoryFact[] = [];
		for (const input of inputs.values()) prepared.push(await this.prepareFact(input));
		if (memory.memoryRevision() !== revision)
			throw new Error('Project memory changed during import; retry');
		return this.projectStore.transaction(() => {
			const imported: StoryFact[] = [];
			for (const fact of prepared) {
				if (this.projectStore.get(FACTS, fact.id)) continue;
				this.projectStore.put(FACTS, fact.id, fact);
				imported.push(fact);
			}
			return imported;
		});
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

	private evidenceReader(
		scope: StoryScope,
		sourceDocuments: readonly SourceDocument[] = []
	): EvidenceReader {
		this.storeFor(scope);
		const allowed = new Set(
			scope.kind === 'series'
				? this.requireSeries(scope.id).projects.map((project) => project.projectId)
				: [this.source.projectId]
		);
		const sources = new Map<string, Promise<ManuscriptSource | undefined>>([
			[this.source.projectId, Promise.resolve(this.source)],
		]);
		const documents = new Map<string, Promise<SourceDocument | undefined>>(
			sourceDocuments
				.filter((document) => document.projectId === this.source.projectId)
				.map((document) => [sourceKey(document), Promise.resolve(document)])
		);
		return (passage) => {
			if (!allowed.has(passage.projectId)) return Promise.resolve(undefined);
			const key = sourceKey(passage);
			let pending = documents.get(key);
			if (!pending) {
				pending = (async () => {
					let source = sources.get(passage.projectId);
					if (!source) {
						source =
							this.resolveSource?.(passage.projectId) ?? Promise.resolve(undefined);
						sources.set(passage.projectId, source);
					}
					const resolved = await source;
					if (!resolved) return undefined;
					try {
						return await resolved.read(passage.documentId);
					} catch (error) {
						if (
							error &&
							typeof error === 'object' &&
							'code' in error &&
							['ENOENT', 'NOT_FOUND', 'DOCUMENT_NOT_FOUND'].includes(
								String(error.code)
							)
						)
							return undefined;
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
