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
		doc = { projectId: 'workflow-fixture', documentId: '00000000-0000-4000-8000-000000000001', title: 'Chapter One', path: 'Draft/Chapter One', order: 0, text, revision: createHash('sha256').update(text).digest('hex'), metadata: {} };
		source = { projectId: doc.projectId, projectPath: dir, list: async () => [doc], read: async (id) => { if (id !== doc.documentId) throw new Error('Missing source'); return doc; } };
		store = new PersistentStore(join(dir, 'editorial.sqlite'));
		search = new PassageSearch(source, store);
		analyses = 0; proposals = new Map(); exports = 0;
		dependencies = {
			analyzeDocument: async (document) => { analyses++; return { revision: document.revision, wordCount: document.text.split(/\s+/u).length }; },
			propose: async (input) => { const prior = proposals.get(input.idempotencyKey); if (prior) return prior; const result = { id: `proposal-${proposals.size}`, ...input }; proposals.set(input.idempotencyKey, result); return result; },
			auditContinuity: async ({ documentIds }) => ({ documentIds, findings: [] }),
			exportBeta: async ({ outputPath, documentIds }) => { exports++; await mkdir(dirname(outputPath), { recursive: true }); await writeFile(outputPath, JSON.stringify({ documentIds, text: doc.text })); return { path: outputPath, documentIds }; },
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
		const workflow = await service.start({ kind: 'review-chapter', documentIds: [doc.documentId], idempotencyKey: 'chapter-review' });
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
		const repeated = await service.start({ kind: 'review-chapter', documentIds: [doc.documentId], idempotencyKey: 'chapter-review' });
		expect(repeated.id).toBe(workflow.id);
		expect((await service.resume(workflow.id)).state).toBe('completed');
		expect(analyses).toBe(1);
		expect(proposals.size).toBe(1);
	});

	it('retains a completed in-flight step when cancelled and resumes remaining work after reopening storage', async () => {
		let entered!: () => void;
		let finish!: () => void;
		const analysisStarted = new Promise<void>((resolve) => { entered = resolve; });
		const analysisRelease = new Promise<void>((resolve) => { finish = resolve; });
		dependencies.analyzeDocument = async () => { analyses++; entered(); await analysisRelease; return { checked: true }; };
		const workflow = await service.start({ kind: 'review-chapter', documentIds: [doc.documentId] });
		await analysisStarted;
		expect(service.cancel(workflow.id).state).toBe('cancelled');
		finish();
		const cancelled = await service.wait(workflow.id);
		expect(cancelled.state).toBe('cancelled');
		expect(cancelled.steps.find((step) => step.kind === 'analyze')?.state).toBe('completed');
		expect(proposals.size).toBe(0);
		await service.close(); await search.close(); store.close();
		store = new PersistentStore(join(dir, 'editorial.sqlite'));
		search = new PassageSearch(source, store);
		service = new WorkflowService(source, store, search, dependencies);
		await service.resume(workflow.id);
		expect((await service.wait(workflow.id)).state).toBe('completed');
		expect(analyses).toBe(1);
		expect(proposals.size).toBe(1);
	});

	it('rejects stale resumption and out-of-project scopes without starting new steps', async () => {
		const workflow = await service.start({ kind: 'review-chapter', documentIds: [doc.documentId] });
		service.cancel(workflow.id);
		await service.wait(workflow.id);
		doc = { ...doc, text: 'A saved external revision.', revision: 'changed-revision' };
		await expect(service.resume(workflow.id)).rejects.toThrow('Saved source changed');
		await expect(service.start({ kind: 'review-chapter', documentIds: ['foreign-document'] })).rejects.toThrow('out-of-project');
		expect(analyses).toBe(0);
		expect(proposals.size).toBe(0);
	});

	it('runs scoped continuity and beta export once, retaining the real export artifact and results', async () => {
		const audit = await service.start({ kind: 'audit-continuity' });
		const auditDone = await service.wait(audit.id);
		expect(auditDone.steps.find((step) => step.kind === 'continuity')?.result).toEqual({ documentIds: [doc.documentId], findings: [] });
		const beta = await service.start({ kind: 'beta-reader-draft', idempotencyKey: 'beta' });
		const done = await service.wait(beta.id);
		const artifact = done.steps.find((step) => step.kind === 'export')?.result as { path: string };
		expect(JSON.parse(await readFile(artifact.path, 'utf8')).documentIds).toEqual([doc.documentId]);
		await service.resume(beta.id);
		expect(exports).toBe(1);
		expect(done.cost.estimated).toBe(0);
	});
});
