import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { NarrativeContext } from '../../../src/services/editorial/narrative-context.js';
import * as worker from '../../../src/services/editorial/narrative-worker.js';
import { analysisEnvelope } from '../../../src/services/editorial/analysis-envelope.js';
import { manuscriptAnalysisHandlers } from '../../../src/handlers/manuscript-analysis-handlers.js';
import {
	executeRegisteredHandler,
	initializeSkillRegistry,
	validateRegisteredArgs,
} from '../../../src/handlers/skill-registry.js';
import { analyzeCraftLocalHandler } from '../../../src/handlers/narrative-lens-handlers.js';
import { WorkflowService } from '../../../src/services/editorial/workflow-service.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { PersistentStore } from '../../../src/services/editorial/persistent-store.js';
import {
	NarrativeAnalysis,
	NARRATIVE_ANNOTATIONS,
	type NarrativeControls,
} from '../../../src/services/editorial/narrative-analysis.js';
import type { SourceDocument, ManuscriptSource } from '../../../src/services/editorial/types.js';

describe('Narrative Lens project adapter with the native engine', () => {
	let directory: string;
	let store: PersistentStore;
	let service: NarrativeAnalysis;
	let source: ManuscriptSource;
	let document: SourceDocument;
	function replace(text: string): void {
		document = {
			projectId: 'lens-project',
			documentId: 'scene-one',
			title: 'Opening',
			path: 'Draft/Opening',
			order: 0,
			text,
			revision: createHash('sha256').update(text).digest('hex'),
			metadata: {},
		};
	}
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), 'scrivener-lens-'));
		store = new PersistentStore(join(directory, 'editorial.sqlite'));
		replace('🌙 Mira was was tired.');
		source = {
			projectId: document.projectId,
			projectPath: directory,
			list: async () => [document],
			read: async () => document,
		};
		service = new NarrativeAnalysis(source, store);
		await service.setControls({ configuration: { rules: ['NL-GRAMMAR-REPETITION'] } });
	});
	afterEach(async () => {
		await service.close();
		store.close();
		await rm(directory, { recursive: true, force: true });
	});
	it('preserves exact Unicode evidence and compares persisted revisions after reopening', async () => {
		const first = await service.analyze({ saveAs: 'before' });
		expect(first.snapshot.report.findings).toHaveLength(1);
		const evidence = first.snapshot.report.findings[0].evidence[0];
		expect(document.text.slice(evidence.range.utf16Start, evidence.range.utf16End)).toBe(
			evidence.quote
		);
		expect(first.snapshot.sources[0].revision).toBe(document.revision);
		const legacy = JSON.parse(JSON.stringify(first.snapshot));
		delete legacy.envelope.sourceFormat;
		store.put('narrative-lens:lens-project:baselines', 'before', legacy);
		await service.close();
		service = new NarrativeAnalysis(source, store);
		replace('🌙 Mira was tired.');
		const next = await service.analyze({ baseline: 'before' });
		expect(next.comparison?.resolved).toHaveLength(1);
		expect(next.comparisonBaseline).toEqual({ name: 'before', envelope: first.envelope });
		expect(next.envelope.sourceRevisions).not.toEqual(
			next.comparisonBaseline!.envelope.sourceRevisions
		);
		expect(next.snapshot.report.findings).toHaveLength(0);
		expect(service.baseline('before').report.findings).toHaveLength(1);
		expect(service.baseline('before').envelope.sourceFormat).toBe('saved-rtf');
		await service.analyze({ saveAs: 'before' });
		expect(next.comparisonBaseline!.envelope.sourceRevisions).toEqual(
			first.envelope.sourceRevisions
		);
	});
	it.each(['unchanged', 'edited'])(
		'preserves native comparison and report semantics on the serialized path for %s text',
		async (change) => {
			await service.analyze({ saveAs: 'original' });
			if (change === 'edited') replace('🌙 Mira was tired.');
			const value = await service.analyze({ baseline: 'original' });
			const serialized = await service.serializedAnalysis({
				baseline: 'original',
				saveAs: 'serialized',
			});
			const result = JSON.parse(serialized);
			expect(result.comparison).toEqual(value.comparison);
			expect(result.comparisonBaseline).toEqual(value.comparisonBaseline);
			expect(result.snapshot.report).toEqual(value.snapshot.report);
			expect(result.snapshot.sources).toEqual(value.snapshot.sources);
			expect(result.findingIds).toEqual(value.findingIds);
			expect(result.envelope.requestId).toBe(value.envelope.requestId);
			expect(result.envelope.policy.revisionChecked).toBe(true);
			expect(service.baseline('serialized').report).toEqual(result.snapshot.report);
		}
	);
	it.each(['shape', 'summary', 'project'])(
		'rejects a malformed %s baseline before saving a comparison',
		async (fault) => {
			const first = await service.analyze({ saveAs: 'before' });
			const malformed = structuredClone(first.snapshot);
			if (fault === 'shape') malformed.report.findings = null as never;
			else if (fault === 'summary') malformed.report.summary.returnedFindings++;
			else malformed.report.documentId = 'another-project';
			store.put('narrative-lens:lens-project:baselines', 'before', malformed);
			await expect(
				service.analyze({ baseline: 'before', saveAs: 'invalid' })
			).rejects.toThrow();
			expect(() => service.baseline('invalid')).toThrow('not found');
			expect(() => service.baseline('before')).toThrow();
		}
	);
	it.each([-1, 0, 1])(
		'checks the combined serialized comparison budget at 16 MiB plus %i before committing',
		async (delta) => {
			await service.analyze({ saveAs: 'original' });
			const first = await service.analyze({ baseline: 'original' });
			const comparison = structuredClone(first.comparison!);
			comparison.persistent[0].before.message = '';
			const overhead = Buffer.byteLength(JSON.stringify({ ...first, comparison }));
			comparison.persistent[0].before.message = 'x'.repeat(
				16 * 1024 * 1024 - overhead + delta
			);
			const compare = jest
				.spyOn(worker, 'narrativeWorker')
				.mockResolvedValueOnce(JSON.stringify(comparison));
			try {
				const pending = service.serializedAnalysis({
					baseline: 'original',
					saveAs: 'boundary',
				});
				if (delta <= 0) {
					expect(Buffer.byteLength(await pending)).toBe(16 * 1024 * 1024 + delta);
					expect(store.count(`narrative-lens:${source.projectId}:baselines`)).toBe(2);
				} else {
					await expect(pending).rejects.toThrow(/exceeds 16 MiB/);
					expect(store.count(`narrative-lens:${source.projectId}:baselines`)).toBe(1);
				}
			} finally {
				compare.mockRestore();
			}
		}
	);

	it('uses native author intentions and rejects unknown configuration without replacing controls', async () => {
		await service.setControls({
			configuration: { rules: ['NL-GRAMMAR-REPETITION'] },
			scenes: { 'scene-one': { intentions: ['repetition'] } },
		});
		expect((await service.analyze()).snapshot.report.findings).toHaveLength(0);
		const prior = service.controls();
		await expect(
			service.setControls({ configuration: { invented: true } } as never)
		).rejects.toThrow();
		expect(service.controls()).toEqual(prior);
	});
	it.each([null, [], 'corrupted', { unexpected: true }])(
		'rejects malformed saved controls instead of analyzing with defaults: %j',
		async (controls) => {
			store.put('narrative-lens:lens-project', 'controls', controls);
			await expect(service.analyze()).rejects.toThrow(/control/i);
			expect(() => service.controls()).toThrow(/control/i);
		}
	);
	it.each(['queued', 'validated'])(
		'persists only the admitted controls when callers mutate %s input',
		async (phase) => {
			const controls = {
				configuration: { rules: ['NL-GRAMMAR-REPETITION'] },
			} satisfies NarrativeControls;
			const expected = structuredClone(controls);
			let calls = 0;
			source.list = async () => {
				if (phase === 'validated' && ++calls === 2)
					controls.configuration.rules[0] = 'invented' as never;
				return [document];
			};
			const pending = service.setControls(controls);
			if (phase === 'queued') controls.configuration.rules[0] = 'invented' as never;
			await expect(pending).resolves.toEqual(expected);
			expect(service.controls()).toEqual(expected);
			expect((await service.analyze()).snapshot.report.findings).toHaveLength(1);
		}
	);

	it('binds annotation identity to the same admitted evidence used by the worker', async () => {
		const input = {
			nodes: [
				{
					id: 'tired',
					mechanism: { kind: 'fixed', value: true },
					evidence: {
						sceneId: document.documentId,
						utf16Start: 0,
						utf16End: document.text.length,
						quote: document.text,
					},
				},
			],
			interventions: [{ nodeId: 'tired', value: false }],
		};
		const expected = analysisEnvelope(
			source.projectId,
			'annotation',
			[document],
			service.controls(),
			'author-evidence',
			{ kind: 'causality', input }
		);
		source.list = async () => {
			input.nodes = [{ ...input.nodes[0], mechanism: { kind: 'fixed', value: false } }];
			return [document];
		};
		const response = await service.annotations('causality', input);
		expect(response.result).toMatchObject({
			changes: [{ nodeId: 'tired', before: true, after: false }],
		});
		expect(response.envelope.requestId).toBe(expected.requestId);
	});
	it.each(['queued', 'after-worker'])(
		'honors the admitted annotation signal when cancelled %s',
		async (phase) => {
			const controller = new AbortController();
			const replacement = new AbortController();
			const options = { signal: controller.signal };
			let calls = 0;
			source.list = async () => {
				if (phase === 'after-worker' && ++calls === 2) controller.abort();
				return [document];
			};
			const pending = service.annotations(
				'history',
				{ catalogue: [], usages: [], targetYear: -300, toleranceYears: 0 },
				options
			);
			options.signal = replacement.signal;
			if (phase === 'queued') controller.abort();
			await expect(pending).rejects.toThrow(/abort|cancelled/i);
			expect(replacement.signal.aborted).toBe(false);
			expect((await service.analyze()).findingIds).toHaveLength(1);
		}
	);
	it('checks annotation bytes before copying or reading source at the admission boundary', async () => {
		const limit = 1024;
		const budget = jest.replaceProperty(worker, 'NARRATIVE_INPUT_BYTES', limit);
		const dispatch = jest
			.spyOn(worker, 'narrativeWorker')
			.mockResolvedValue({ targetYear: -300 });
		const listing = jest.spyOn(source, 'list');
		try {
			for (const delta of [-1, 0, 1]) {
				const input = {
					catalogue: [
						{
							id: 'history',
							term: 'Mira',
							earliestYear: -300,
							basis: 'author_constraint',
							reference: '',
							context: 'fixture',
							senseAmbiguous: false,
						},
					],
					usages: [],
					targetYear: -300,
					toleranceYears: 0,
				};
				const overhead = Buffer.byteLength(JSON.stringify(input));
				input.catalogue[0].reference = 'é' + 'x'.repeat(limit + delta - overhead - 2);
				expect(Buffer.byteLength(JSON.stringify(input))).toBe(limit + delta);
				const reads = listing.mock.calls.length;
				const calls = dispatch.mock.calls.length;
				const pending = service.annotations('history', input);
				if (delta <= 0) {
					expect((await pending).envelope.policy.revisionChecked).toBe(true);
					expect(dispatch).toHaveBeenCalledTimes(calls + 1);
				} else {
					await expect(pending).rejects.toThrow('input exceeds');
					expect(listing).toHaveBeenCalledTimes(reads);
					expect(dispatch).toHaveBeenCalledTimes(calls);
				}
			}
		} finally {
			budget.restore();
			dispatch.mockRestore();
			listing.mockRestore();
		}
	});
	it('rejects changed source instead of saving a misleading baseline', async () => {
		let calls = 0;
		source.list = async () => {
			if (++calls === 2) replace('Mira was awake.');
			return [document];
		};
		await expect(service.analyze({ saveAs: 'stale' })).rejects.toThrow(/changed during/);
		expect(() => service.baseline('stale')).toThrow(/not found/);
	});

	it('snapshots queued request options and does not save a cancelled public analysis', async () => {
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((done) => {
			release = done;
		});
		const started = new Promise<void>((done) => {
			entered = done;
		});
		const listing = jest.spyOn(source, 'list').mockImplementationOnce(async () => {
			entered();
			await gate;
			return [document];
		});
		const options = { saveAs: 'requested' };
		const pending = service.analyze(options);
		await started;
		options.saveAs = 'changed-after-admission';
		release();
		await pending;
		expect(service.baseline('requested').sources).toHaveLength(1);
		expect(() => service.baseline(options.saveAs)).toThrow('not found');
		const controller = new AbortController();
		listing.mockImplementationOnce(async () => {
			controller.abort();
			return [document];
		});
		await expect(
			manuscriptAnalysisHandlers[0].handler(
				{ saveAs: 'cancelled' },
				{ project: { getEditorialServices: () => ({ narrative: service }) } } as never,
				{ signal: controller.signal }
			)
		).rejects.toThrow();
		expect(() => service.baseline('cancelled')).toThrow('not found');
		listing.mockRestore();
		expect((await service.analyze()).findingIds).toHaveLength(1);
	});
	it.each(['analyze', 'document', 'configure', 'decision', 'recheck'] as const)(
		'forwards cancellation to the native context for %s without committing state',
		async (action) => {
			const baseline = await service.analyze({ saveAs: 'review' });
			const findingId = baseline.findingIds[0];
			const previous = await service.recordFindingDecision('dismiss', 'review', findingId);
			const controls = service.controls();
			const controller = new AbortController();
			const options = { signal: controller.signal };
			const native = NarrativeContext.prototype.analyzeAsync;
			const call = jest
				.spyOn(NarrativeContext.prototype, 'analyzeAsync')
				.mockImplementationOnce(function (this: NarrativeContext, input, admitted) {
					expect(admitted?.signal).toBe(controller.signal);
					controller.abort();
					return native.call(this, input, admitted);
				});
			try {
				const pending =
					action === 'analyze'
						? service.analyze({ saveAs: 'cancelled', ...options })
						: action === 'document'
							? service.analyzeDocument(document, options)
							: action === 'configure'
								? service.setControls(
										{ configuration: { rules: ['NL-GRAMMAR-WHITESPACE'] } },
										options
									)
								: action === 'decision'
									? service.recordFindingDecision(
											'accept',
											'review',
											findingId,
											undefined,
											options
										)
									: service.recheckFinding(findingId, 'review', options);
				await expect(pending).rejects.toThrow(/abort|cancelled/i);
				expect(service.controls()).toEqual(controls);
				expect(service.findingReview(findingId)).toEqual(previous);
				expect(() => service.baseline('cancelled')).toThrow('not found');
			} finally {
				call.mockRestore();
			}
			expect((await service.analyze()).findingIds).toHaveLength(1);
		}
	);

	it.each([
		['analyze', 'cancel'],
		['analyze', 'edit'],
		['recheck', 'cancel'],
		['recheck', 'edit'],
	] as const)('does not commit %s state after %s during comparison', async (action, change) => {
		const original = await service.analyze({ saveAs: 'review' });
		const id = original.findingIds[0];
		const decision = await service.recordFindingDecision('dismiss', 'review', id);
		const native = worker.narrativeWorker;
		let entered!: () => void;
		let release!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const comparison = jest
			.spyOn(worker, 'narrativeWorker')
			.mockImplementationOnce(async (...args) => {
				const result = await native(...args);
				entered();
				await gate;
				return result;
			});
		const controller = new AbortController();
		try {
			const pending =
				action === 'analyze'
					? service.analyze({
							baseline: 'review',
							saveAs: 'uncommitted',
							signal: controller.signal,
						})
					: service.recheckFinding(id, 'review', { signal: controller.signal });
			const rejected = expect(pending).rejects.toThrow(
				change === 'cancel' ? /abort/i : /changed/
			);
			await started;
			if (change === 'cancel') controller.abort();
			else replace('🌙 Mira was awake.');
			release();
			await rejected;
			expect(service.findingReview(id)).toEqual(decision);
			expect(() => service.baseline('uncommitted')).toThrow('not found');
			expect(service.baseline('review')).toEqual(original.snapshot);
		} finally {
			release();
			comparison.mockRestore();
		}
		expect(
			(await service.analyze({ saveAs: 'recovered' })).envelope.policy.revisionChecked
		).toBe(true);
	});

	it('delivers pending cancellation before committing a completed native report', async () => {
		const controller = new AbortController();
		const native = NarrativeContext.prototype.analyzeAsync;
		let cancellation: ReturnType<typeof setTimeout> | undefined;
		const analyze = jest
			.spyOn(NarrativeContext.prototype, 'analyzeAsync')
			.mockImplementationOnce(async function (this: NarrativeContext, ...args) {
				const report = await native.apply(this, args);
				cancellation = setTimeout(() => controller.abort(), 0);
				return report;
			});
		try {
			await expect(
				service.analyze({ saveAs: 'uncommitted', signal: controller.signal })
			).rejects.toThrow(/abort/i);
			expect(() => service.baseline('uncommitted')).toThrow('not found');
		} finally {
			clearTimeout(cancellation);
			analyze.mockRestore();
		}
		expect(
			(await service.analyze({ saveAs: 'recovered' })).envelope.policy.revisionChecked
		).toBe(true);
	});

	it.each([-1, 0, 1])(
		'checks the complete result budget before saving a baseline at 16 MiB plus %i',
		async (delta) => {
			const first = await service.analyze();
			const report = structuredClone(first.snapshot.report);
			const diagnostic = { code: 'fixture', message: '', sceneIds: [] };
			report.diagnostics.push(diagnostic);
			const overhead = Buffer.byteLength(
				JSON.stringify({ ...first, snapshot: { ...first.snapshot, report } })
			);
			diagnostic.message = 'x'.repeat(16 * 1024 * 1024 - overhead + delta);
			const analyze = jest
				.spyOn(NarrativeContext.prototype, 'analyzeAsync')
				.mockResolvedValueOnce(report);
			try {
				if (delta <= 0) {
					const result = await service.analyze({ saveAs: 'boundary' });
					expect(Buffer.byteLength(JSON.stringify(result))).toBe(
						16 * 1024 * 1024 + delta
					);
					expect(store.count(`narrative-lens:${source.projectId}:baselines`)).toBe(1);
				} else {
					await expect(service.analyze({ saveAs: 'boundary' })).rejects.toThrow(
						'exceeds 16 MiB'
					);
					expect(store.count(`narrative-lens:${source.projectId}:baselines`)).toBe(0);
				}
			} finally {
				analyze.mockRestore();
			}
		}
	);
	it('reuses upstream scene caches and invalidates edits beyond a shared prefix', async () => {
		replace('Mira waited quietly. '.repeat(100) + 'She was was tired.');
		await service.analyze();
		expect((await service.analyze()).cache.reusedScenes).toBeGreaterThan(0);
		replace('Mira waited quietly. '.repeat(100) + 'She was tired.');
		const edited = await service.analyze();
		expect(edited.snapshot.report.findings).toHaveLength(0);
		expect(edited.cache.recomputedScenes).toBeGreaterThan(0);
	});
	it('isolates baselines by project and closes deterministically', async () => {
		await service.analyze({ saveAs: 'before' });
		const other = new NarrativeAnalysis({ ...source, projectId: 'other' }, store);
		try {
			expect(() => other.baseline('before')).toThrow(/not found/);
		} finally {
			await other.close();
		}
		await service.close();
		await expect(service.analyze()).rejects.toThrow(/closed/);
	});
	it('bounds retained baselines while allowing explicit replacement and deletion', async () => {
		const { snapshot } = await service.analyze();
		for (let index = 0; index < 31; index++)
			store.put('narrative-lens:lens-project:baselines', `saved-${index}`, snapshot);
		await service.analyze({ saveAs: 'last' });
		await expect(service.analyze({ saveAs: 'excess' })).rejects.toThrow(/At most 32/);
		await service.analyze({ saveAs: 'last' });
		service.deleteBaseline('last');
		await service.analyze({ saveAs: 'replacement' });
		expect(() => service.baseline('last')).toThrow(/not found/);
		expect(service.baseline('replacement').projectId).toBe(source.projectId);
	});
	it('validates author evidence in the native worker and rejects altered quotations', async () => {
		const evidence = {
			sceneId: document.documentId,
			utf16Start: 0,
			utf16End: document.text.length,
			quote: document.text,
		};
		const nodes = [{ id: 'tired', mechanism: { kind: 'fixed', value: true }, evidence }];
		const result = await service.annotations('causality', {
			nodes,
			interventions: [{ nodeId: 'tired', value: false }],
		});
		expect(result.result).toMatchObject({
			documentId: source.projectId,
			changes: [{ nodeId: 'tired', before: true, after: false }],
		});
		await expect(
			service.annotations('causality', {
				nodes: [{ ...nodes[0], evidence: { ...evidence, quote: 'invented' } }],
				interventions: [],
			})
		).rejects.toThrow();
		await expect(
			service.annotations('causality', { nodes: [], interventions: [], unknown: true })
		).rejects.toThrow(/fields/);
	});

	it('exercises all author annotation modes and native evidence failure paths', async () => {
		replace('Mira saw Mira was was tired.');
		await service.setControls({
			configuration: { rules: ['NL-GRAMMAR-REPETITION'] },
			knownCharacters: ['Mira'],
		});
		const antecedent = {
			sceneId: document.documentId,
			utf16Start: 0,
			utf16End: 4,
			quote: 'Mira',
		};
		const mention = {
			sceneId: document.documentId,
			utf16Start: 9,
			utf16End: 13,
			quote: 'Mira',
		};
		const evidence = {
			sceneId: document.documentId,
			utf16Start: 0,
			utf16End: document.text.length,
			quote: document.text,
		};
		const proposition = { id: 'p1', description: 'Mira is tired', truth: 'true', evidence };
		const event = {
			id: 'e1',
			sequence: 1,
			propositionId: 'p1',
			action: { kind: 'truth', value: 'true' },
			evidence,
		};
		const characterEvent = {
			id: 'e2',
			sequence: 2,
			propositionId: 'p1',
			action: {
				kind: 'know',
				actor: { kind: 'character', characterId: 'Mira' },
				value: true,
			},
			evidence,
		};
		const cases = [
			[
				'causality',
				{
					nodes: [{ id: 'n1', mechanism: { kind: 'fixed', value: true }, evidence }],
					interventions: [],
				},
			],
			['knowledge', { propositions: [proposition], events: [event] }],
			[
				'epistemics',
				{
					propositions: [proposition],
					events: [event, characterEvent],
					queries: [
						{
							id: 'q1',
							propositionId: 'p1',
							observer: { kind: 'reader' },
							subject: { kind: 'character', characterId: 'Mira' },
							atSequence: null,
						},
					],
				},
			],
			[
				'reader',
				{
					propositions: [proposition],
					events: [
						event,
						{
							...characterEvent,
							action: { kind: 'know', actor: { kind: 'reader' }, value: true },
						},
					],
				},
			],
			[
				'promises',
				{
					events: [
						{ kind: 'setup', id: 'promise', description: 'Mira will rest', evidence },
					],
				},
			],
			[
				'subtext',
				{
					annotations: [
						{
							id: 's1',
							surface: evidence,
							implied: 'Mira hides exhaustion',
							subtextType: 'EmotionalDenial',
							characters: ['Mira'],
							resolution: null,
						},
					],
				},
			],
			[
				'themes',
				{
					theses: [{ id: 't1', statement: 'Rest matters', opposes: [] }],
					annotations: [
						{
							id: 'ta1',
							thesisId: 't1',
							source: evidence,
							valence: 'Supporting',
							delivery: 'Narration',
						},
					],
				},
			],
			[
				'coreference',
				{
					links: [{ id: 'c1', mention, antecedent, characterId: 'Mira' }],
				},
			],
			[
				'uncertainty',
				{
					observations: [
						{
							questionId: 'u1',
							sceneId: document.documentId,
							outcomes: [{ id: 'rest', probability: 1 }],
						},
					],
				},
			],
			[
				'history',
				{
					catalogue: [
						{
							id: 'h1',
							term: 'Mira',
							earliestYear: -100,
							basis: 'author_constraint',
							reference: 'fixture',
							context: 'BCE fixture',
							senseAmbiguous: false,
						},
					],
					usages: [{ id: 'hu1', entryId: 'h1', evidence: antecedent }],
					targetYear: -300,
					toleranceYears: 0,
				},
			],
		] as const;
		const corruptSource = (
			value: unknown,
			edit: (source: Record<string, unknown>) => void
		): unknown => {
			const copy = JSON.parse(JSON.stringify(value));
			const visit = (current: unknown): boolean => {
				if (!current || typeof current !== 'object') return false;
				const record = current as Record<string, unknown>;
				if (
					typeof record.sceneId === 'string' &&
					typeof record.quote === 'string' &&
					typeof record.utf16Start === 'number' &&
					typeof record.utf16End === 'number'
				) {
					edit(record);
					return true;
				}
				return Object.values(record).some(visit);
			};
			expect(visit(copy)).toBe(true);
			return copy;
		};
		const validate = new AjvJsonSchemaValidator().getValidator(
			manuscriptAnalysisHandlers[1].inputSchema as never
		);
		expect(cases.map(([kind]) => kind).sort()).toEqual(
			Object.keys(NARRATIVE_ANNOTATIONS).sort()
		);
		for (const [kind, input] of cases) {
			expect(validate({ kind, input }).valid).toBe(true);
			const malformed = { ...input, [Object.keys(input)[0]]: 'invalid' };
			expect(validate({ kind, input: malformed }).valid).toBe(false);
			const nested = JSON.parse(JSON.stringify(input));
			const field = Object.keys(nested)[0];
			const property = Object.keys(nested[field][0])[0];
			nested[field][0][property] = 17;
			expect(validate({ kind, input: nested }).valid).toBe(false);
			expect(() =>
				validateRegisteredArgs('analyze_narrative_annotations', { kind, input: nested })
			).toThrow(`/input/${field}/0/${property}`);
			const response = await service.annotations(kind, input);
			expect(response.envelope.sourceRevisions).toEqual([
				{ documentId: document.documentId, revision: document.revision },
			]);
			const native = response.result as Record<string, unknown>;
			const nonempty: Record<string, string> = {
				causality: 'nodes',
				knowledge: 'propositions',
				promises: 'promises',
				subtext: 'instances',
				themes: 'evidence',
				coreference: 'links',
				uncertainty: 'measurements',
				history: 'candidates',
			};
			if (nonempty[kind])
				expect((native[nonempty[kind]] as unknown[]).length).toBeGreaterThan(0);
			else {
				expect(native.knowledge).toMatchObject({ propositions: [{ id: 'p1' }] });
				if (kind === 'reader') expect(native.readerChanges).toHaveLength(1);
				if (kind === 'epistemics') expect(native.answers).toHaveLength(1);
			}
		}
		for (const [kind, input] of cases) {
			if (kind === 'uncertainty') {
				await expect(
					service.annotations(kind, {
						observations: [{ questionId: 'bad', sceneId: 'missing', outcomes: [] }],
					})
				).rejects.toThrow();
				continue;
			}
			await expect(
				service.annotations(
					kind,
					corruptSource(input, (source) => {
						source.quote = 'invented';
					}) as Record<string, unknown>
				)
			).rejects.toThrow();
			await expect(
				service.annotations(
					kind,
					corruptSource(input, (source) => {
						source.utf16End = 999;
					}) as Record<string, unknown>
				)
			).rejects.toThrow();
		}
	});

	it('records decisions, refuses stale revisions, and rechecks through upstream comparison after restart', async () => {
		replace('🌙 Mira was was tired.');
		const second = {
			...document,
			documentId: 'scene-two',
			text: 'Mira rested.',
			revision: 'second',
		};
		source.list = async () => [document, second];
		await service.setControls({
			configuration: { rules: ['NL-GRAMMAR-REPETITION'] },
			scenes: { 'scene-two': { intentions: ['repetition'] } },
		});
		const tool = manuscriptAnalysisHandlers[0];
		const context = {
			project: { getEditorialServices: () => ({ narrative: service }) },
		} as never;
		const outputValidator = new AjvJsonSchemaValidator().getValidator(
			tool.outputSchema! as never
		);
		const call = async (args: Record<string, unknown>) => {
			const response = await tool.handler(args, context);
			expect(outputValidator(response.structuredContent).valid).toBe(true);
			return response.structuredContent!.result as Record<string, any>;
		};
		const initial = await call({ saveAs: 'review-original' });
		const findingId = initial.findingIds[0];
		const accepted = await call({
			action: 'accept_finding',
			baseline: 'review-original',
			findingId,
			note: 'reviewed',
		});
		expect(accepted.disposition).toBe('accepted');
		const dismissed = await call({
			action: 'dismiss_finding',
			baseline: 'review-original',
			findingId,
		});
		expect(dismissed.disposition).toBe('dismissed');
		await service.close();
		store.close();
		store = new PersistentStore(join(directory, 'editorial.sqlite'));
		service = new NarrativeAnalysis(source, store);
		replace('🌙🌙 Mira was was tired.');
		await expect(
			call({ action: 'accept_finding', baseline: 'review-original', findingId })
		).rejects.toThrow(/revision changed/);
		await call({ saveAs: 'review-shifted' });
		expect(
			await call({ action: 'recheck_finding', baseline: 'review-shifted', findingId })
		).toMatchObject({ action: 'still_present', disposition: 'dismissed' });
		replace('🌙🌙 Mira was tired.');
		const final = await call({ saveAs: 'review-current', baseline: 'review-original' });
		expect(final.comparison.resolved).toHaveLength(1);
		expect(
			await call({ action: 'recheck_finding', baseline: 'review-current', findingId })
		).toMatchObject({ action: 'resolved', disposition: 'dismissed' });
		expect(document.text).toBe('🌙🌙 Mira was tired.');
	});
	it('does not treat disabled coverage as resolution and rejects replaced review baselines', async () => {
		const before = await service.analyze({ saveAs: 'review' });
		const id = before.findingIds[0];
		await service.recordFindingDecision('dismiss', 'review', id);
		await service.setControls({ configuration: { rules: ['NL-GRAMMAR-WHITESPACE'] } });
		await service.analyze({ saveAs: 'disabled' });
		expect((await service.recheckFinding(id, 'disabled')).action).toBe('recheck_required');
		await service.analyze({ saveAs: 'review' });
		await expect(service.recheckFinding(id, 'disabled')).rejects.toThrow(
			/baseline was replaced/
		);
	});

	it('cancels one dispatched request without cancelling a concurrent request on the same project', async () => {
		initializeSkillRegistry();
		let entered!: () => void;
		let release!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		source.list = async () => {
			if (++calls === 1) {
				entered();
				await blocked;
			}
			return [document];
		};
		const context = {
			project: { getEditorialServices: () => ({ narrative: service }) },
		} as never;
		const args = {
			kind: 'history',
			input: { catalogue: [], usages: [], targetYear: -300, toleranceYears: 0 },
		};
		const cancelled = new AbortController();
		const independent = new AbortController();
		const first = executeRegisteredHandler('analyze_narrative_annotations', args, context, {
			signal: cancelled.signal,
		});
		const rejection = expect(first).rejects.toThrow(/cancelled/i);
		await started;
		const second = executeRegisteredHandler('analyze_narrative_annotations', args, context, {
			signal: independent.signal,
		});
		cancelled.abort();
		release();
		await rejection;
		expect((await second).structuredContent).toMatchObject({
			action: 'annotations',
			result: { envelope: { policy: { revisionChecked: true } } },
		});
		expect(independent.signal.aborted).toBe(false);
	});

	it('recovers the queue after a cancelled annotation and validates array boundaries before native dispatch', async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			service.annotations(
				'history',
				{ catalogue: [], usages: [], targetYear: 0, toleranceYears: 0 },
				{ signal: controller.signal }
			)
		).rejects.toThrow();
		const validate = new AjvJsonSchemaValidator().getValidator(
			manuscriptAnalysisHandlers[1].inputSchema as never
		);
		const entry = {
			id: 'history',
			term: 'Mira',
			earliestYear: -300,
			basis: 'author_constraint',
			reference: 'fixture',
			context: 'fixture',
			senseAmbiguous: false,
		};
		for (const count of [4095, 4096, 4097]) {
			const input = {
				catalogue: Array.from({ length: count }, (_, i) => ({ ...entry, id: `h${i}` })),
				usages: [],
				targetYear: 0,
				toleranceYears: 0,
			};
			expect(validate({ kind: 'history', input }).valid).toBe(count <= 4096);
			if (count === 4097)
				await expect(service.annotations('history', input)).rejects.toThrow(
					/catalogue.*4096/
				);
		}
		expect((await service.analyze()).snapshot.report.findings).toHaveLength(1);
	});

	it.each(['intentions', 'suppression'])(
		'keeps %s consistent across standalone, manuscript and workflow results',
		async (mode) => {
			await service.setControls({
				configuration: {
					rules: ['NL-GRAMMAR-REPETITION'],
					...(mode === 'suppression'
						? {
								suppressions: [
									{
										ruleId: 'NL-GRAMMAR-REPETITION',
										reason: 'intentional',
										sceneId: 'scene-one',
									},
								],
							}
						: {}),
				},
				scenes:
					mode === 'intentions' ? { 'scene-one': { intentions: ['repetition'] } } : {},
			});
			const manuscript = await service.analyze();
			const context = {
				project: { getEditorialServices: () => ({ narrative: service, source }) },
			} as never;
			const configured = (
				await analyzeCraftLocalHandler.handler(
					{ documentId: document.documentId, policy: 'configured' },
					context
				)
			).structuredContent!;
			expect(configured.report).toMatchObject({
				findings: manuscript.snapshot.report.findings,
			});
			expect(configured.envelope).toMatchObject({
				sourceRevisions: manuscript.envelope.sourceRevisions,
				engine: { configurationHash: manuscript.envelope.engine.configurationHash },
				policy: {
					mode: 'configured',
					authorIntentionsApplied: mode === 'intentions',
					suppressionsApplied: mode === 'suppression',
					revisionChecked: true,
				},
			});
			const raw = (
				await analyzeCraftLocalHandler.handler({ documentId: document.documentId }, context)
			).structuredContent!;
			expect(raw.grammar).toHaveLength(1);
			expect(raw.envelope).toMatchObject({
				policy: { mode: 'raw', authorIntentionsApplied: false },
			});
			const workflow = new WorkflowService(
				source,
				store,
				{ refresh: async () => ({}) } as never,
				{
					analyzeDocument: (doc) => service.analyzeDocument(doc),
					suggestEdits: (doc) => service.suggestEdits(doc),
					propose: async () => {
						throw new Error('Unexpected proposal');
					},
					auditContinuity: async () => ({}),
					exportBeta: async () => ({}),
				}
			);
			try {
				const started = await workflow.start({
					kind: 'review-chapter',
					documentIds: [document.documentId],
				});
				const done = await workflow.wait(started.id);
				expect(done.state).toBe('completed');
				expect(done.steps.find((step) => step.kind === 'analyze')?.result).toMatchObject({
					findings: [],
					envelope: {
						sourceRevisions: manuscript.envelope.sourceRevisions,
						policy: { mode: 'configured', revisionChecked: true },
					},
				});
			} finally {
				await workflow.close();
			}
		}
	);

	it.each([-2147483648, -300, -1, 0, 1, 2147483647])(
		'accepts native signed historical year %s',
		async (year) => {
			expect(
				(
					await service.annotations('history', {
						catalogue: [],
						usages: [],
						targetYear: year,
						toleranceYears: 0,
					})
				).result
			).toMatchObject({ targetYear: year });
		}
	);
	it.each([-2147483649, 2147483648, 0.5])(
		'rejects out-of-range or fractional historical year %s',
		async (targetYear) => {
			await expect(
				service.annotations('history', {
					catalogue: [],
					usages: [],
					targetYear,
					toleranceYears: 0,
				})
			).rejects.toThrow(/targetYear/);
		}
	);
	it.each([0, 1, 4294967295])('accepts native unsigned tolerance %s', async (toleranceYears) => {
		expect(
			(
				await service.annotations('history', {
					catalogue: [],
					usages: [],
					targetYear: -300,
					toleranceYears,
				})
			).result
		).toMatchObject({ toleranceYears });
	});
	it.each([-1, 4294967296])('rejects native tolerance boundary %s', async (toleranceYears) => {
		await expect(
			service.annotations('history', {
				catalogue: [],
				usages: [],
				targetYear: -300,
				toleranceYears,
			})
		).rejects.toThrow(/toleranceYears/);
	});

	it('rejects control fields that could replace saved source and leaves controls intact', async () => {
		const prior = service.controls();
		for (const controls of [
			new Date(),
			{ unknown: true },
			{ scenes: [] },
			{ scenes: { 'scene-one': { text: 'invented' } } },
			{ scenes: { absent: { purpose: 'action' } } },
		]) {
			await expect(service.setControls(controls as never)).rejects.toThrow();
			expect(service.controls()).toEqual(prior);
		}
	});
	it.each([7, 8])(
		'drains %s admitted operations on close and rejects the ninth',
		async (count) => {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			source.list = async () => {
				await gate;
				return [document];
			};
			const analyses = Array.from({ length: count }, () => service.analyze());
			if (count === 8) await expect(service.analyze()).rejects.toThrow(/queue is full/);
			let closed = false;
			const closing = service.close().then(() => {
				closed = true;
			});
			await Promise.resolve();
			expect(closed).toBe(false);
			release();
			await Promise.all(analyses);
			await closing;
			await expect(service.analyze()).rejects.toThrow(/closed/);
		}
	);
	it('proposes only native exact whitespace replacements and respects intentions', async () => {
		replace('Mira  was was tired.');
		await service.setControls({
			configuration: { rules: ['NL-GRAMMAR-WHITESPACE', 'NL-GRAMMAR-REPETITION'] },
		});
		expect(await service.suggestEdits(document)).toEqual([{ start: 5, end: 6, text: '' }]);
		await service.setControls({ configuration: { rules: ['NL-GRAMMAR-REPETITION'] } });
		expect(await service.suggestEdits(document)).toEqual([]);
	});
});
