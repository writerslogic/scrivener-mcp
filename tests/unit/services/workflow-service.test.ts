import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassageSearch } from '../../../src/services/editorial/passage-search.js';
import { PersistentStore } from '../../../src/services/editorial/persistent-store.js';
import { WorkflowService } from '../../../src/services/editorial/workflow-service.js';
import type { WorkflowDependencies } from '../../../src/services/editorial/workflow-service.js';
import type { ManuscriptSource, SourceDocument } from '../../../src/services/editorial/types.js';

describe('durable editorial workflows', () => {
	let dir: string;
	let store: PersistentStore;
	let search: PassageSearch;
	let service: WorkflowService;
	let source: ManuscriptSource;
	let doc: SourceDocument;
	let analyses: number;
	let proposals: Map<string, unknown>;
	let exports: number;
	let dependencies: WorkflowDependencies;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'scrivener-workflows-'));
		const text = 'Mira  waited beside the door. Her hands shook.';
		doc = {
			projectId: 'workflow-fixture',
			documentId: '00000000-0000-4000-8000-000000000001',
			title: 'Chapter One',
			path: 'Draft/Chapter One',
			order: 0,
			text,
			revision: createHash('sha256').update(text).digest('hex'),
			metadata: {},
		};
		source = {
			projectId: doc.projectId,
			projectPath: dir,
			list: async () => [doc],
			read: async (id) => {
				if (id !== doc.documentId) throw new Error('Missing source');
				return doc;
			},
		};
		store = new PersistentStore(join(dir, 'editorial.sqlite'));
		search = new PassageSearch(source, store);
		analyses = 0;
		proposals = new Map();
		exports = 0;
		dependencies = {
			analyzeDocument: async (document) => {
				analyses++;
				return {
					revision: document.revision,
					wordCount: document.text.split(/\s+/u).length,
				};
			},
			propose: async (input) => {
				const prior = proposals.get(input.idempotencyKey);
				if (prior) return prior;
				const result = { id: `proposal-${proposals.size}`, ...input };
				proposals.set(input.idempotencyKey, result);
				return result;
			},
			auditContinuity: async ({ documentIds }) => ({ documentIds, findings: [] }),
			exportBeta: async ({ outputPath, documentIds }) => {
				exports++;
				await mkdir(dirname(outputPath), { recursive: true });
				await writeFile(outputPath, JSON.stringify({ documentIds, text: doc.text }));
				return { path: outputPath, documentIds };
			},
		};
		service = new WorkflowService(source, store, search, dependencies);
	});

	afterEach(async () => {
		await service.close();
		await search.close();
		store.close();
		await rm(dir, { recursive: true, force: true });
	});

	it('reviews the requested chapter through analysis and proposals without altering the source', async () => {
		const before = doc.text;
		const workflow = await service.start({
			kind: 'review-chapter',
			documentIds: [doc.documentId],
			idempotencyKey: 'chapter-review',
		});
		const done = await service.wait(workflow.id);
		expect(done.state).toBe('completed');
		expect(done.progress).toBe(100);
		expect(done.cost.actual).toBe(0);
		expect(done.usage.providerRequests).toBe(0);
		expect(done.scope[0].revision).toBe(doc.revision);
		expect(proposals.size).toBe(1);
		expect(doc.text).toBe(before);
		await service.close();
		service = new WorkflowService(source, store, search, dependencies);
		const repeated = await service.start({
			kind: 'review-chapter',
			documentIds: [doc.documentId],
			idempotencyKey: 'chapter-review',
		});
		expect(repeated.id).toBe(workflow.id);
		expect((await service.resume(workflow.id)).state).toBe('completed');
		expect(analyses).toBe(1);
		expect(proposals.size).toBe(1);
	});

	it('retains a completed in-flight step when cancelled and resumes remaining work after reopening storage', async () => {
		let entered!: () => void;
		let finish!: () => void;
		const analysisStarted = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const analysisRelease = new Promise<void>((resolve) => {
			finish = resolve;
		});
		dependencies.analyzeDocument = async () => {
			analyses++;
			entered();
			await analysisRelease;
			return { checked: true };
		};
		const workflow = await service.start({
			kind: 'review-chapter',
			documentIds: [doc.documentId],
		});
		await analysisStarted;
		expect(service.cancel(workflow.id).state).toBe('cancelled');
		finish();
		const cancelled = await service.wait(workflow.id);
		expect(cancelled.state).toBe('cancelled');
		expect(cancelled.steps.find((step) => step.kind === 'analyze')?.state).toBe('completed');
		expect(proposals.size).toBe(0);
		await service.close();
		await search.close();
		store.close();
		store = new PersistentStore(join(dir, 'editorial.sqlite'));
		search = new PassageSearch(source, store);
		service = new WorkflowService(source, store, search, dependencies);
		await service.resume(workflow.id);
		expect((await service.wait(workflow.id)).state).toBe('completed');
		expect(analyses).toBe(1);
		expect(proposals.size).toBe(1);
	});

	it('rejects stale resumption and out-of-project scopes without starting new steps', async () => {
		const workflow = await service.start({
			kind: 'review-chapter',
			documentIds: [doc.documentId],
		});
		service.cancel(workflow.id);
		await service.wait(workflow.id);
		doc = { ...doc, text: 'A saved external revision.', revision: 'changed-revision' };
		await expect(service.resume(workflow.id)).rejects.toThrow('Saved source changed');
		await expect(
			service.start({ kind: 'review-chapter', documentIds: ['foreign-document'] })
		).rejects.toThrow('out-of-project');
		expect(analyses).toBe(0);
		expect(proposals.size).toBe(0);
	});

	it('runs scoped continuity and beta export once, retaining the real export artifact and results', async () => {
		const audit = await service.start({ kind: 'audit-continuity' });
		const auditDone = await service.wait(audit.id);
		expect(auditDone.steps.find((step) => step.kind === 'continuity')?.result).toEqual({
			documentIds: [doc.documentId],
			findings: [],
		});
		const beta = await service.start({ kind: 'beta-reader-draft', idempotencyKey: 'beta' });
		const done = await service.wait(beta.id);
		const artifact = done.steps.find((step) => step.kind === 'export')?.result as {
			path: string;
		};
		expect(JSON.parse(await readFile(artifact.path, 'utf8')).documentIds).toEqual([
			doc.documentId,
		]);
		await service.resume(beta.id);
		expect(exports).toBe(1);
		expect(done.cost.estimated).toBe(0);
	});

	it('resumes a preflight-blocked beta draft after durable acknowledgment without replaying analyses or completed exports', async () => {
		const exportBeta = dependencies.exportBeta;
		dependencies.exportBeta = async (input) => {
			if (!input.allowWarnings)
				throw new Error('Export preflight: unsupported image; acknowledge disclosed warnings to resume');
			return exportBeta(input);
		};
		const request = { kind: 'beta-reader-draft' as const, idempotencyKey: 'beta-warning', allowExportWarnings: false };
		const started = await service.start(request);
		const failed = await service.wait(started.id);
		expect(failed.state).toBe('failed');
		expect(failed.error).toContain('unsupported image');
		expect(failed.steps.find((step) => step.kind === 'analyze')?.state).toBe('completed');
		expect(analyses).toBe(1);
		expect(exports).toBe(0);
		await service.close();
		await search.close();
		store.close();
		store = new PersistentStore(join(dir, 'editorial.sqlite'));
		search = new PassageSearch(source, store);
		service = new WorkflowService(source, store, search, dependencies);
		expect(service.get(started.id).allowExportWarnings).toBe(false);
		await service.resume(started.id, { allowExportWarnings: true });
		const completed = await service.wait(started.id);
		expect(completed.state).toBe('completed');
		expect(completed.allowExportWarnings).toBe(true);
		expect(analyses).toBe(1);
		expect(exports).toBe(1);
		expect((await service.start(request)).id).toBe(started.id);
		await expect(service.start({ ...request, allowExportWarnings: true })).rejects.toThrow('different request');
		const repeated = await service.resume(started.id, { allowExportWarnings: false });
		expect(repeated.state).toBe('completed');
		expect(repeated.allowExportWarnings).toBe(true);
		expect(repeated.usage.localSteps).toBe(completed.usage.localSteps);
		expect(exports).toBe(1);
	});

	it('retains a prior beta export acknowledgment when resuming without a new flag', async () => {
		const exportBeta = dependencies.exportBeta;
		let interrupted = false;
		dependencies.exportBeta = async (input) => {
			if (!input.allowWarnings) throw new Error('Export warnings require acknowledgment');
			if (!interrupted) { interrupted = true; throw new Error('Transient local export failure'); }
			return exportBeta(input);
		};
		const started = await service.start({ kind: 'beta-reader-draft', allowExportWarnings: true });
		expect((await service.wait(started.id)).state).toBe('failed');
		await service.resume(started.id);
		expect((await service.wait(started.id)).allowExportWarnings).toBe(true);
		expect(service.get(started.id).state).toBe('completed');
		expect(analyses).toBe(1);
		expect(exports).toBe(1);
	});

	it.each([null, 'true', 1])('rejects non-boolean export acknowledgment %s on start and resume', async (value) => {
		const allowExportWarnings = value as unknown as boolean;
		await expect(service.start({ kind: 'beta-reader-draft', allowExportWarnings })).rejects.toThrow('must be a boolean');
		const started = await service.start({ kind: 'beta-reader-draft' });
		service.cancel(started.id);
		await service.wait(started.id);
		await expect(service.resume(started.id, { allowExportWarnings })).rejects.toThrow('must be a boolean');
	});

	it('rejects export acknowledgment for chapter and continuity workflows', async () => {
		for (const kind of ['review-chapter', 'audit-continuity'] as const) {
			await expect(service.start({ kind, documentIds: [doc.documentId], allowExportWarnings: false })).rejects.toThrow('only to the beta-reader');
			const started = await service.start({ kind, documentIds: [doc.documentId] });
			service.cancel(started.id);
			await service.wait(started.id);
			await expect(service.resume(started.id, { allowExportWarnings: true })).rejects.toThrow('only to the beta-reader');
		}
	});
});
