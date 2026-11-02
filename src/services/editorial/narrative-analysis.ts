import {
	type ManuscriptContext,
	type compareManuscriptReports,
	listManuscriptRules,
	listStructureTemplates,
	parseManuscriptReport,
	checkGrammar,
} from 'narrative-lens';
import type { ManuscriptSource, SourceDocument } from './types.js';
import type { PersistentStore } from './persistent-store.js';
import { analysisDigest, analysisEnvelope, type AnalysisEnvelope } from './analysis-envelope.js';
import { ReportTransport } from './report-transport.js';
export type { AnalysisEnvelope } from './analysis-envelope.js';
import { storyIdentifier } from './provenance.js';
import { narrativeWorker, NARRATIVE_INPUT_BYTES } from './narrative-worker.js';
import { NarrativeContext } from './narrative-context.js';
import { setTimeout } from 'node:timers/promises';

export const NARRATIVE_ANNOTATIONS = {
	causality: ['analyzeAuthorCausality', 'nodes', 'interventions'],
	knowledge: ['analyzeAuthorKnowledge', 'propositions', 'events'],
	epistemics: ['analyzeAuthorEpistemics', 'propositions', 'events', 'queries'],
	reader: ['buildAuthorMentalModel', 'propositions', 'events'],
	promises: ['analyzePromiseEvents', 'events'],
	subtext: ['analyzeSubtextAnnotations', 'annotations'],
	themes: ['analyzeThematicAnnotations', 'theses', 'annotations'],
	coreference: ['resolveAuthorCoreference', 'links'],
	uncertainty: ['measureNarrativeUncertainty', 'observations'],
	history: ['analyzeHistoricalCatalogue', 'catalogue', 'usages', 'targetYear', 'toleranceYears'],
} as const;

export type LensManuscript = Parameters<ManuscriptContext['analyze']>[0];
export type LensReport = ReturnType<ManuscriptContext['analyze']>;
export type LensConfiguration = NonNullable<LensManuscript['configuration']>;
export type LensFinding = LensReport['findings'][number];
export type LensSceneControls = Omit<LensManuscript['scenes'][number], 'id' | 'text'>;

export interface NarrativeControls {
	configuration?: LensConfiguration;
	scenes?: Record<string, LensSceneControls>;
	knownCharacters?: string[];
}

export interface FindingReviewState {
	projectId: string;
	findingId: string;
	action: 'accepted' | 'dismissed' | 'recheck_required' | 'still_present' | 'resolved';
	sceneIds: string[];
	sourceRevisions: Array<{ documentId: string; revision: string }>;
	baselineName: string;
	baselineHash: string;
	disposition: 'accepted' | 'dismissed';
	updatedAt?: string;
	createdAt: string;
	note?: string;
}

export interface NarrativeSnapshot {
	projectId: string;
	createdAt: string;
	envelope: AnalysisEnvelope;
	sources: Array<{ documentId: string; revision: string; title: string; path: string }>;
	report: LensReport;
}

interface AnalysisOptions {
	baseline?: string;
	saveAs?: string;
	signal?: AbortSignal;
}

interface AnalysisResult {
	envelope: AnalysisEnvelope;
	snapshot: NarrativeSnapshot;
	comparison?: ReturnType<typeof compareManuscriptReports>;
	comparisonBaseline?: { name: string; envelope: AnalysisEnvelope };
	cache: ReturnType<ManuscriptContext['stats']>;
	findingIds: string[];
}

function validateControls(controls: unknown): asserts controls is NarrativeControls {
	const object = (value: unknown): value is Record<string, unknown> =>
		value !== null &&
		typeof value === 'object' &&
		(Object.getPrototypeOf(value) === Object.prototype ||
			Object.getPrototypeOf(value) === null);
	if (
		!object(controls) ||
		Object.keys(controls).some(
			(key) => !['configuration', 'scenes', 'knownCharacters'].includes(key)
		)
	)
		throw new Error('Unknown narrative control fields');
	if (controls.scenes !== undefined) {
		if (!object(controls.scenes))
			throw new Error('Scene controls must be an object keyed by document ID');
		for (const value of Object.values(controls.scenes))
			if (!object(value) || 'id' in value || 'text' in value)
				throw new Error('Scene controls cannot replace saved text or identity');
	}
	if (Buffer.byteLength(JSON.stringify(controls)) > 1024 * 1024)
		throw new Error('Narrative controls exceed 1 MiB');
}

export class NarrativeAnalysis {
	private static readonly cacheMaxBytes = 16 * 1024 * 1024;
	private readonly context = new NarrativeContext(NarrativeAnalysis.cacheMaxBytes);
	private readonly namespace: string;
	private active?: Promise<unknown>;
	private pendingCount = 0;
	private closed = false;
	readonly transport = new ReportTransport();

	constructor(
		private readonly source: ManuscriptSource,
		private readonly store: PersistentStore
	) {
		this.namespace = `narrative-lens:${source.projectId}`;
	}

	capabilities({ signal }: { signal?: AbortSignal } = {}): Promise<{
		rules: ReturnType<typeof listManuscriptRules>;
		structureTemplates: string[];
		cache: ReturnType<ManuscriptContext['stats']>;
		authorAnnotations: typeof NARRATIVE_ANNOTATIONS;
		limitations: string;
		documentation: string;
		authorEvidence: { source: string; causalityExample: object; promisesExample: object };
	}> {
		return this.run(async () => ({
			rules: listManuscriptRules(),
			structureTemplates: listStructureTemplates(),
			cache: await this.context.stats({ signal }),
			authorAnnotations: NARRATIVE_ANNOTATIONS,
			documentation:
				'https://github.com/writerslogic/narrative-lens/blob/main/docs/INTEGRATION.md',
			authorEvidence: {
				source: 'Replace SOURCE with {sceneId: binder UUID, utf16Start: integer, utf16End: integer, quote: exact saved substring}. Offsets are UTF-16, end-exclusive.',
				causalityExample: {
					kind: 'causality',
					input: {
						nodes: [
							{
								id: 'door-open',
								mechanism: { kind: 'fixed', value: true },
								evidence: 'SOURCE',
							},
						],
						interventions: [{ nodeId: 'door-open', value: false }],
					},
				},
				promisesExample: {
					kind: 'promises',
					input: {
						events: [
							{
								kind: 'setup',
								id: 'letter',
								description: 'Deliver the letter',
								evidence: 'SOURCE',
							},
							{
								kind: 'resolution',
								id: 'delivery',
								setupId: 'letter',
								outcome: 'fulfilled',
								evidence: 'SOURCE',
							},
						],
					},
				},
			},
			limitations:
				'Heuristic findings are review aids, not calibrated editorial judgments. Model-dependent coverage is reported by the library.',
		}));
	}

	async annotations(
		kind: keyof typeof NARRATIVE_ANNOTATIONS,
		input: Record<string, unknown>,
		{ signal }: { signal?: AbortSignal } = {}
	) {
		signal?.throwIfAborted();
		if (!Object.prototype.hasOwnProperty.call(NARRATIVE_ANNOTATIONS, kind))
			throw new Error('Unknown author annotation analysis');
		const [operation, ...fields] = NARRATIVE_ANNOTATIONS[kind];
		if (
			!input ||
			typeof input !== 'object' ||
			Array.isArray(input) ||
			Object.keys(input).some((key) => !(fields as readonly string[]).includes(key))
		)
			throw new Error('Annotation inputs must match the selected analysis fields');
		for (const field of fields) {
			const value = input[field];
			if (field === 'targetYear' || field === 'toleranceYears') {
				const minimum = field === 'targetYear' ? -2147483648 : 0;
				const maximum = field === 'targetYear' ? 2147483647 : 4294967295;
				if (
					typeof value !== 'number' ||
					!Number.isInteger(value) ||
					value < minimum ||
					value > maximum
				)
					throw new Error(`${field} must be an integer from ${minimum} to ${maximum}`);
			} else if (!Array.isArray(value) || value.length > 4096)
				throw new Error(`${field} must be an array with at most 4096 items`);
		}
		if (Buffer.byteLength(JSON.stringify(input)) > NARRATIVE_INPUT_BYTES)
			throw new Error('Narrative operation input exceeds 64 MiB');
		input = structuredClone(input);
		return this.run(async () => {
			signal?.throwIfAborted();
			const args = fields.map((field) => input[field]);
			const documents = await this.source.list();
			const controls = this.controls();
			const envelope = analysisEnvelope(
				this.source.projectId,
				'annotation',
				documents,
				controls,
				'author-evidence',
				{ kind, input }
			);
			const result = await narrativeWorker(
				operation,
				[this.manuscript(documents, controls), ...args],
				{ signal }
			);
			const current = await this.source.list();
			signal?.throwIfAborted();
			if (
				current.length !== documents.length ||
				current.some(
					(document, index) =>
						document.documentId !== documents[index].documentId ||
						document.revision !== documents[index].revision
				)
			)
				throw new Error('Saved manuscript changed during annotation analysis');
			envelope.policy.revisionChecked = true;
			return {
				projectId: this.source.projectId,
				kind,
				envelope,
				result,
				sources: documents.map(({ documentId, revision }) => ({ documentId, revision })),
			};
		});
	}

	controls(): NarrativeControls {
		const controls = this.store.get<unknown>(this.namespace, 'controls');
		if (controls === undefined) return {};
		validateControls(controls);
		return controls;
	}

	analyzeDocument(
		document: SourceDocument,
		{ signal }: { signal?: AbortSignal } = {}
	): Promise<LensReport & { envelope: AnalysisEnvelope }> {
		return this.run(async () => {
			signal?.throwIfAborted();
			if (document.projectId !== this.source.projectId)
				throw new Error('Narrative source belongs to another project');
			const controls = this.controls();
			const selected = controls.scenes?.[document.documentId];
			const appliedControls = {
				...controls,
				scenes: selected ? { [document.documentId]: selected } : {},
			};
			const report = await this.context.analyzeAsync(
				this.manuscript([document], appliedControls),
				{ signal }
			);
			if ((await this.source.read(document.documentId)).revision !== document.revision)
				throw new Error('Saved source changed during narrative analysis');
			signal?.throwIfAborted();
			const envelope = analysisEnvelope(
				this.source.projectId,
				'document',
				[document],
				appliedControls,
				'configured'
			);
			envelope.policy.revisionChecked = true;
			return { ...report, envelope };
		});
	}

	async suggestEdits(document: SourceDocument) {
		const report = await this.analyzeDocument(document);
		const allowed = new Set(
			report.findings
				.filter((finding) => finding.ruleId === 'NL-GRAMMAR-WHITESPACE')
				.flatMap((finding) =>
					finding.evidence.map(({ range }) => `${range.utf16Start}:${range.utf16End}`)
				)
		);
		return checkGrammar(document.text)
			.filter(
				(finding) =>
					finding.kind === 'whitespace' &&
					finding.replacements.length === 1 &&
					allowed.has(`${finding.utf16Start}:${finding.utf16End}`)
			)
			.slice(0, 1000)
			.map((finding) => ({
				start: finding.utf16Start,
				end: finding.utf16End,
				text: finding.replacements[0],
			}));
	}

	findingId(finding: LensFinding): string {
		return analysisDigest({
			ruleId: finding.ruleId,
			fingerprint: finding.fingerprint,
			scope: finding.scope,
			evidence: finding.evidence.map(({ sceneId, range, quote }) => ({
				sceneId,
				range,
				quote,
			})),
		});
	}

	recordFindingDecision(
		action: 'accept' | 'dismiss',
		baselineName: string,
		findingId: string,
		note?: string,
		{ signal }: { signal?: AbortSignal } = {}
	): Promise<FindingReviewState> {
		return this.run(async () => {
			signal?.throwIfAborted();
			if (!['accept', 'dismiss'].includes(action))
				throw new Error('Invalid finding decision');
			if (note !== undefined && (typeof note !== 'string' || note.length > 4096))
				throw new Error('Finding note exceeds 4096 characters');
			const snapshot = this.baseline(baselineName);
			const finding = snapshot.report.findings.find(
				(item) => this.findingId(item) === findingId
			);
			if (!finding) throw new Error('Finding was not found in this baseline');
			const documents = await this.source.list();
			this.assertRevisions(documents, snapshot.sources);
			const report = await this.context.analyzeAsync(
				this.manuscript(documents, this.controls()),
				{ signal }
			);
			if (!report.findings.some((current) => this.findingId(current) === findingId))
				throw new Error('Finding is no longer present; refresh analysis');
			this.assertRevisions(await this.source.list(), snapshot.sources);
			signal?.throwIfAborted();
			const disposition = action === 'accept' ? 'accepted' : 'dismissed';
			const state: FindingReviewState = {
				projectId: this.source.projectId,
				findingId,
				action: disposition,
				disposition,
				sceneIds: this.findingSceneIds(finding),
				sourceRevisions: snapshot.sources,
				baselineName,
				baselineHash: analysisDigest(snapshot.report),
				createdAt: new Date().toISOString(),
				note,
			};
			this.store.put(`${this.namespace}:finding-reviews`, findingId, state);
			return state;
		});
	}

	recheckFinding(
		findingId: string,
		currentBaseline: string,
		{ signal }: { signal?: AbortSignal } = {}
	): Promise<FindingReviewState> {
		return this.run(async () => {
			signal?.throwIfAborted();
			const previous = this.findingReview(findingId);
			if (!previous) throw new Error('Finding review was not found');
			const original = this.baseline(previous.baselineName);
			if (analysisDigest(original.report) !== previous.baselineHash)
				throw new Error('Reviewed baseline was replaced; record a new decision');
			const expected = this.baseline(currentBaseline);
			const documents = await this.source.list();
			this.assertRevisions(documents, expected.sources);
			const report = await this.context.analyzeAsync(
				this.manuscript(documents, this.controls()),
				{ signal }
			);
			const comparison = await this.compareReports(original.report, report, signal);
			this.assertRevisions(await this.source.list(), expected.sources);
			signal?.throwIfAborted();
			const persistent = comparison.persistent.some(
				(item) => this.findingId(item.before) === findingId
			);
			const resolved = comparison.resolved.some((item) => this.findingId(item) === findingId);
			const state: FindingReviewState = {
				...previous,
				action: persistent ? 'still_present' : resolved ? 'resolved' : 'recheck_required',
				sourceRevisions: documents.map(({ documentId, revision }) => ({
					documentId,
					revision,
				})),
				updatedAt: new Date().toISOString(),
			};
			this.store.put(`${this.namespace}:finding-reviews`, findingId, state);
			return state;
		});
	}

	private assertRevisions(
		documents: SourceDocument[],
		expected: Array<{ documentId: string; revision: string }>
	): void {
		if (
			documents.length !== expected.length ||
			documents.some(
				(document, index) =>
					document.documentId !== expected[index]?.documentId ||
					document.revision !== expected[index]?.revision
			)
		)
			throw new Error('Saved source revision changed; re-run analysis');
	}

	findingReview(findingId: string): FindingReviewState | undefined {
		return this.store.get<FindingReviewState>(`${this.namespace}:finding-reviews`, findingId);
	}

	private findingSceneIds(finding: LensFinding): string[] {
		const scope = finding.scope as
			| { kind: 'passage' | 'scene'; sceneId: string }
			| { kind: 'manuscript'; sceneIds: string[] };
		const ids =
			scope.kind === 'manuscript'
				? scope.sceneIds
				: [scope.sceneId, ...finding.evidence.map((evidence) => evidence.sceneId)];
		return [...new Set(ids)].filter(Boolean);
	}

	private manuscript(documents: SourceDocument[], controls: NarrativeControls): LensManuscript {
		const ids = new Set(documents.map((document) => document.documentId));
		for (const id of Object.keys(controls.scenes ?? {})) {
			if (!ids.has(id))
				throw new Error(`Scene controls refer to an unselected document: ${id}`);
		}
		return {
			documentId: this.source.projectId,
			knownCharacters: controls.knownCharacters,
			configuration: controls.configuration,
			scenes: documents.map((document) => ({
				...controls.scenes?.[document.documentId],
				id: document.documentId,
				text: document.text,
			})),
		};
	}

	private run<T>(operation: () => Promise<T>): Promise<T> {
		if (this.closed) return Promise.reject(new Error('Narrative analysis is closed'));
		if (this.pendingCount >= 8)
			return Promise.reject(
				new Error('Narrative analysis queue is full; retry after pending operations')
			);
		this.pendingCount++;
		const pending = (this.active ?? Promise.resolve()).catch(() => undefined).then(operation);
		this.active = pending;
		const finished = () => {
			this.pendingCount--;
			if (this.active === pending) this.active = undefined;
		};
		void pending.then(finished, finished);
		return pending;
	}

	async setControls(
		controls: NarrativeControls,
		{ signal }: { signal?: AbortSignal } = {}
	): Promise<NarrativeControls> {
		signal?.throwIfAborted();
		validateControls(controls);
		controls = structuredClone(controls);
		return this.run(async () => {
			const documents = await this.source.list();
			// Native validation owns the analysis contract, including configuration and scene controls.
			await this.context.analyzeAsync(this.manuscript(documents, controls), { signal });
			this.assertRevisions(await this.source.list(), documents);
			signal?.throwIfAborted();
			this.store.put(this.namespace, 'controls', controls);
			return controls;
		});
	}

	private async compareReports(
		before: LensReport,
		after: LensReport,
		signal?: AbortSignal
	): Promise<ReturnType<typeof compareManuscriptReports>> {
		return (await narrativeWorker('compareManuscriptReports', [before, after], {
			signal,
		})) as ReturnType<typeof compareManuscriptReports>;
	}

	analyze(options: AnalysisOptions = {}): Promise<AnalysisResult> {
		return this.runAnalysis(options, 'object');
	}

	serializedAnalysis(options: AnalysisOptions = {}): Promise<string> {
		return this.runAnalysis(options, 'json');
	}

	private runAnalysis(options: AnalysisOptions, format: 'object'): Promise<AnalysisResult>;
	private runAnalysis(options: AnalysisOptions, format: 'json'): Promise<string>;
	private runAnalysis(
		{ baseline, saveAs, signal }: AnalysisOptions,
		format: 'object' | 'json'
	): Promise<AnalysisResult | string> {
		return this.run(async () => {
			signal?.throwIfAborted();
			if (baseline !== undefined) storyIdentifier(baseline, 'Baseline name');
			if (saveAs !== undefined) storyIdentifier(saveAs, 'Baseline name');
			const prior = baseline ? this.storedBaseline(baseline) : undefined;
			const documents = await this.source.list();
			signal?.throwIfAborted();
			const controls = this.controls();
			const envelope = analysisEnvelope(
				this.source.projectId,
				'manuscript',
				documents,
				controls,
				'configured'
			);
			const report = await this.context.analyzeAsync(this.manuscript(documents, controls), {
				signal,
			});
			signal?.throwIfAborted();
			const comparison =
				prior && format === 'object'
					? await this.compareReports(prior.report, report, signal)
					: undefined;
			const comparisonJson =
				prior && format === 'json'
					? await narrativeWorker('compareManuscriptReports', [prior.report, report], {
							signal,
							format: 'json',
						})
					: undefined;
			const cache = await this.context.stats({ signal });
			// Deliver pending cancellation before the final revision check and synchronous commit.
			await setTimeout(0);
			signal?.throwIfAborted();
			const current = await this.source.list();
			signal?.throwIfAborted();
			if (
				current.length !== documents.length ||
				current.some(
					(document, index) =>
						document.documentId !== documents[index].documentId ||
						document.revision !== documents[index].revision
				)
			) {
				throw new Error(
					'Saved manuscript changed during analysis; retry against the current revision'
				);
			}
			envelope.policy.revisionChecked = true;
			const snapshot: NarrativeSnapshot = {
				projectId: this.source.projectId,
				createdAt: envelope.createdAt,
				envelope,
				sources: documents.map(({ documentId, revision, title, path }) => ({
					documentId,
					revision,
					title,
					path,
				})),
				report,
			};
			const result = {
				envelope,
				snapshot,
				comparison,
				comparisonBaseline: prior
					? { name: baseline!, envelope: prior.envelope }
					: undefined,
				cache,
				findingIds: report.findings.map((finding) => this.findingId(finding)),
			};
			let serialized = JSON.stringify(result);
			if (comparisonJson !== undefined)
				serialized = `${serialized.slice(0, -1)},"comparison":${comparisonJson}}`;
			if (Buffer.byteLength(serialized) > 16 * 1024 * 1024)
				throw new Error('Narrative report exceeds 16 MiB; reduce the findings budget');
			if (saveAs) {
				this.store.transaction(() => {
					if (
						!this.store.get(`${this.namespace}:baselines`, saveAs!) &&
						this.store.page(`${this.namespace}:baselines`, { limit: 32 }, ['createdAt'])
							.items.length >= 32
					)
						throw new Error(
							'At most 32 narrative baselines may be retained; delete one first'
						);
					this.store.put(`${this.namespace}:baselines`, saveAs!, snapshot);
				});
			}
			return format === 'json' ? serialized : result;
		});
	}

	baseline(name: string): NarrativeSnapshot {
		const snapshot = this.storedBaseline(name);
		return { ...snapshot, report: parseManuscriptReport(snapshot.report) };
	}

	private storedBaseline(name: string): NarrativeSnapshot {
		storyIdentifier(name, 'Baseline name');
		const snapshot = this.store.get<NarrativeSnapshot>(`${this.namespace}:baselines`, name);
		if (!snapshot) throw new Error('Narrative baseline was not found in this project');
		if (snapshot.projectId !== this.source.projectId)
			throw new Error('Narrative baseline belongs to another project');
		if (
			!snapshot.envelope ||
			snapshot.envelope.projectId !== snapshot.projectId ||
			!snapshot.envelope.policy.revisionChecked
		)
			throw new Error('Baseline provenance is unavailable; create a new baseline');
		snapshot.envelope.sourceFormat ??= 'saved-rtf';
		if (snapshot.report?.documentId !== this.source.projectId)
			throw new Error('Narrative baseline report belongs to another project');
		return snapshot;
	}

	deleteBaseline(name: string): void {
		storyIdentifier(name, 'Baseline name');
		this.store.delete(`${this.namespace}:baselines`, name);
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.active?.catch(() => undefined);
		await this.context.close();
		this.transport.clear();
	}
}
