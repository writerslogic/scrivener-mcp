import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { analyzeWorkflowDocument } from '../../handlers/async-handlers.js';
import type { SourceDocument, ManuscriptSource } from './types.js';
import type { PersistentStore } from './persistent-store.js';
import type { PassageSearch } from './passage-search.js';

export type WorkflowKind = 'review-chapter' | 'audit-continuity' | 'beta-reader-draft';
type WorkflowState = 'ready' | 'running' | 'cancelled' | 'failed' | 'completed' | 'interrupted';
type StepState = 'pending' | 'running' | 'completed' | 'failed';

interface WorkflowStep {
	id: string;
	kind: 'index' | 'analyze' | 'propose' | 'continuity' | 'export';
	documentId?: string;
	state: StepState;
	result?: unknown;
	error?: string;
}

interface WorkflowOwner {
	instance: string;
	pid: number;
	host: string;
}

export interface EditorialWorkflow {
	id: string;
	projectId: string;
	kind: WorkflowKind;
	state: WorkflowState;
	createdAt: string;
	updatedAt: string;
	scope: Array<{ documentId: string; revision: string; title: string; characters: number }>;
	steps: WorkflowStep[];
	progress: number;
	usage: {
		localSteps: number;
		analyzedCharacters: number;
		providerRequests: number;
		providerTokens: number;
	};
	cost: { currency: 'USD'; estimated: number; actual: number; basis: string };
	owner?: WorkflowOwner;
	error?: string;
	idempotencyKey?: string;
	allowExportWarnings?: boolean;
	readonly initialAllowExportWarnings?: boolean;
}

export interface WorkflowDependencies {
	analyzeDocument?: (document: SourceDocument) => Promise<unknown>;
	propose: (input: {
		documentId: string;
		expectedRevision: string;
		edits: Array<{ start: number; end: number; text: string }>;
		title: string;
		idempotencyKey: string;
	}) => Promise<unknown>;
	auditContinuity: (input: { documentIds: string[] }) => Promise<unknown>;
	exportBeta: (input: {
		workflowId: string;
		documentIds: string[];
		outputPath: string;
		allowWarnings?: boolean;
	}) => Promise<unknown>;
}

function validateExportWarningAcknowledgment(value: unknown, kind: WorkflowKind): void {
	if (value !== undefined && typeof value !== 'boolean')
		throw new Error('allowExportWarnings must be a boolean');
	if (value !== undefined && kind !== 'beta-reader-draft')
		throw new Error('allowExportWarnings applies only to the beta-reader-draft workflow');
}

function processAlive(owner: WorkflowOwner): 'alive' | 'dead' | 'unknown' {
	if (owner.host !== hostname()) return 'unknown';
	try {
		process.kill(owner.pid, 0);
		return 'alive';
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown';
	}
}

export class WorkflowService {
	private readonly namespace: string;
	private readonly instance = randomUUID();
	private readonly running = new Map<string, Promise<void>>();
	private closed = false;

	constructor(
		private readonly source: ManuscriptSource,
		private readonly store: PersistentStore,
		private readonly search: PassageSearch,
		private readonly dependencies: WorkflowDependencies
	) {
		this.namespace = `editorial-workflows:${source.projectId}`;
	}

	async start(input: {
		kind: WorkflowKind;
		documentIds?: string[];
		idempotencyKey?: string;
		allowExportWarnings?: boolean;
	}): Promise<EditorialWorkflow> {
		if (this.closed) throw new Error('Workflow service is closed');
		if (!['review-chapter', 'audit-continuity', 'beta-reader-draft'].includes(input.kind))
			throw new Error('Unknown editorial workflow');
		validateExportWarningAcknowledgment(input.allowExportWarnings, input.kind);
		if (
			input.idempotencyKey !== undefined &&
			(typeof input.idempotencyKey !== 'string' ||
				!input.idempotencyKey ||
				input.idempotencyKey.length > 200)
		)
			throw new Error('Workflow idempotency key must contain 1 to 200 characters');
		if (
			input.documentIds &&
			(!Array.isArray(input.documentIds) ||
				input.documentIds.length === 0 ||
				input.documentIds.length > 10000 ||
				input.documentIds.some((id) => typeof id !== 'string' || !id || id.length > 128))
		)
			throw new Error('Invalid workflow document scope');
		if (input.kind === 'review-chapter' && !input.documentIds?.length)
			throw new Error('Review this chapter requires an explicit document scope');
		const all = await this.source.list();
		const selected = input.documentIds
			? new Set(input.documentIds)
			: new Set(all.map((doc) => doc.documentId));
		const documents = all.filter((doc) => selected.has(doc.documentId));
		if (
			!documents.length ||
			documents.length !== selected.size ||
			documents.some((doc) => doc.projectId !== this.source.projectId)
		)
			throw new Error('Workflow scope contains missing or out-of-project documents');
		const id = input.idempotencyKey
			? createHash('sha256')
					.update(`${this.source.projectId}:${input.idempotencyKey}`)
					.digest('hex')
			: randomUUID();
		const prior = this.store.get<EditorialWorkflow>(this.namespace, id);
		if (prior) {
			if (
				prior.kind !== input.kind ||
				(prior.initialAllowExportWarnings ?? false) !==
					(input.allowExportWarnings ?? false) ||
				prior.scope.map((doc) => doc.documentId).join('\0') !==
					documents.map((doc) => doc.documentId).join('\0')
			)
				throw new Error(
					'Workflow idempotency key was already used for a different request'
				);
			return this.get(id);
		}
		const steps: WorkflowStep[] = [{ id: 'index', kind: 'index', state: 'pending' }];
		if (input.kind !== 'audit-continuity') {
			for (const doc of documents) {
				steps.push({
					id: `analyze:${doc.documentId}`,
					kind: 'analyze',
					documentId: doc.documentId,
					state: 'pending',
				});
				if (input.kind === 'review-chapter')
					steps.push({
						id: `propose:${doc.documentId}`,
						kind: 'propose',
						documentId: doc.documentId,
						state: 'pending',
					});
			}
		}
		if (input.kind === 'audit-continuity')
			steps.push({ id: 'continuity', kind: 'continuity', state: 'pending' });
		if (input.kind === 'beta-reader-draft')
			steps.push({ id: 'export', kind: 'export', state: 'pending' });
		const now = new Date().toISOString();
		const workflow: EditorialWorkflow = {
			id,
			projectId: this.source.projectId,
			kind: input.kind,
			state: 'ready',
			createdAt: now,
			updatedAt: now,
			scope: documents.map((doc) => ({
				documentId: doc.documentId,
				revision: doc.revision,
				title: doc.title,
				characters: doc.text.length,
			})),
			steps,
			progress: 0,
			usage: { localSteps: 0, analyzedCharacters: 0, providerRequests: 0, providerTokens: 0 },
			cost: {
				currency: 'USD',
				estimated: 0,
				actual: 0,
				basis: 'Local deterministic analysis, continuity, proposals and export. No provider calls or token charges; client chat costs are outside this server.',
			},
			idempotencyKey: input.idempotencyKey,
			...(input.kind === 'beta-reader-draft'
				? {
						allowExportWarnings: input.allowExportWarnings ?? false,
						initialAllowExportWarnings: input.allowExportWarnings ?? false,
					}
				: {}),
		};
		this.store.transaction(() => {
			if (this.store.get(this.namespace, id))
				throw new Error(
					'Workflow request was created concurrently; retry with the same key'
				);
			this.store.put(this.namespace, id, workflow);
		});
		this.schedule(id);
		return workflow;
	}

	get(id: string): EditorialWorkflow {
		if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(id))
			throw new Error('Invalid workflow identifier');
		const value = this.store.get<EditorialWorkflow>(this.namespace, id);
		if (!value || value.projectId !== this.source.projectId)
			throw new Error('Editorial workflow was not found in this project');
		if (value.state === 'running' && value.owner && processAlive(value.owner) === 'dead')
			return {
				...value,
				state: 'interrupted',
				error: 'The previous server stopped. Resume validates saved source revisions before continuing.',
			};
		return value;
	}

	list(): EditorialWorkflow[] {
		return this.store
			.list<EditorialWorkflow>(this.namespace)
			.map((workflow) => this.get(workflow.id))
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	cancel(id: string): EditorialWorkflow {
		return this.store.transaction(() => {
			const workflow = this.get(id);
			if (workflow.state === 'completed' || workflow.state === 'cancelled') return workflow;
			workflow.state = 'cancelled';
			workflow.updatedAt = new Date().toISOString();
			this.store.put(this.namespace, id, workflow);
			return workflow;
		});
	}

	async resume(
		id: string,
		options: { allowExportWarnings?: boolean } = {}
	): Promise<EditorialWorkflow> {
		if (this.closed) throw new Error('Workflow service is closed');
		if (!options || typeof options !== 'object' || Array.isArray(options))
			throw new Error('Workflow resume options must be an object');
		const workflow = this.get(id);
		validateExportWarningAcknowledgment(options.allowExportWarnings, workflow.kind);
		if (workflow.state === 'completed') return workflow;
		if (this.running.has(id)) {
			if (
				options.allowExportWarnings !== undefined &&
				options.allowExportWarnings !== (workflow.allowExportWarnings ?? false)
			)
				throw new Error(
					'Workflow is still running; wait for it to stop before changing export acknowledgment'
				);
			return workflow;
		}
		if (workflow.owner && processAlive(workflow.owner) !== 'dead')
			throw new Error(
				'Workflow owner is still running or cannot be identified safely; wait for it to finish before resuming'
			);
		await this.validateScope(workflow);
		const ready = this.store.transaction(() => {
			const current = this.get(id);
			if (current.state === 'completed') return false;
			if (current.owner && processAlive(current.owner) !== 'dead')
				throw new Error('Workflow is owned by another active or ambiguous server');
			if (options.allowExportWarnings !== undefined)
				current.allowExportWarnings = options.allowExportWarnings;
			current.state = 'ready';
			current.error = undefined;
			current.owner = undefined;
			for (const step of current.steps)
				if (step.state !== 'completed') {
					step.state = 'pending';
					step.error = undefined;
				}
			this.store.put(this.namespace, id, current);
			return true;
		});
		if (ready) this.schedule(id);
		return this.get(id);
	}

	async wait(id: string): Promise<EditorialWorkflow> {
		await this.running.get(id);
		return this.get(id);
	}

	private schedule(id: string): void {
		const task = new Promise<void>((resolve) => setImmediate(resolve)).then(() => this.run(id));
		this.running.set(id, task);
		void task.then(
			() => this.running.delete(id),
			() => this.running.delete(id)
		);
	}

	private async validateScope(workflow: EditorialWorkflow): Promise<Map<string, SourceDocument>> {
		const documents = new Map<string, SourceDocument>();
		for (const expected of workflow.scope) {
			const current = await this.source.read(expected.documentId);
			if (current.projectId !== workflow.projectId || current.revision !== expected.revision)
				throw new Error(
					`Saved source changed for document ${expected.documentId}; start a new workflow to review the new revision`
				);
			documents.set(current.documentId, current);
		}
		return documents;
	}

	private update(
		id: string,
		operation: (workflow: EditorialWorkflow) => void
	): EditorialWorkflow {
		return this.store.transaction(() => {
			const workflow = this.get(id);
			if (workflow.owner?.instance !== this.instance)
				throw new Error('Workflow ownership changed during execution');
			operation(workflow);
			workflow.updatedAt = new Date().toISOString();
			this.store.put(this.namespace, id, workflow);
			return workflow;
		});
	}

	private async run(id: string): Promise<void> {
		try {
			this.store.transaction(() => {
				const workflow = this.get(id);
				if (workflow.state !== 'ready' || this.closed) return;
				if (workflow.owner && processAlive(workflow.owner) !== 'dead')
					throw new Error('Workflow is owned by another server');
				workflow.owner = { instance: this.instance, pid: process.pid, host: hostname() };
				workflow.state = 'running';
				this.store.put(this.namespace, id, workflow);
			});
			if (this.get(id).owner?.instance !== this.instance) return;
			for (let index = 0; index < this.get(id).steps.length; index++) {
				const current = this.get(id);
				if (this.closed || current.state === 'cancelled') break;
				const step = current.steps[index];
				if (step.state === 'completed') continue;
				const docs = await this.validateScope(current);
				if (this.get(id).state === 'cancelled' || this.closed) break;
				this.update(id, (workflow) => {
					workflow.steps[index].state = 'running';
				});
				const document = step.documentId ? docs.get(step.documentId) : undefined;
				let result: unknown;
				switch (step.kind) {
					case 'index':
						result = await this.search.refresh();
						break;
					case 'analyze': {
						if (!document) throw new Error('Workflow document is missing');
						result = this.dependencies.analyzeDocument
							? await this.dependencies.analyzeDocument(document)
							: await analyzeWorkflowDocument({
									documentId: document.documentId,
									content: document.text,
								});
						break;
					}
					case 'propose': {
						if (!document) throw new Error('Workflow document is missing');
						const edits: Array<{ start: number; end: number; text: string }> = [];
						for (const match of document.text.matchAll(/[^\S\r\n]{2,}(?=\S)/gu)) {
							const start = match.index ?? 0;
							if (start === 0 || /[\r\n]/u.test(document.text[start - 1])) continue;
							edits.push({ start, end: start + match[0].length, text: ' ' });
							if (edits.length >= 1000) break;
						}
						result = edits.length
							? await this.dependencies.propose({
									documentId: document.documentId,
									expectedRevision: document.revision,
									edits,
									title: 'Review spacing suggestions',
									idempotencyKey: `workflow:${id}:${step.id}`,
								})
							: {
									proposalId: null,
									message:
										'No mechanical spacing edits proposed; consult the completed prose analysis for editorial suggestions.',
								};
						break;
					}
					case 'continuity':
						result = await this.dependencies.auditContinuity({
							documentIds: current.scope.map((doc) => doc.documentId),
						});
						break;
					case 'export':
						result = await this.dependencies.exportBeta({
							workflowId: id,
							allowWarnings: current.allowExportWarnings,
							documentIds: current.scope.map((doc) => doc.documentId),
							outputPath: join(
								this.source.projectPath,
								'.scrivener-mcp',
								'exports',
								`beta-reader-${id}.docx`
							),
						});
						break;
				}
				this.update(id, (workflow) => {
					workflow.steps[index].state = 'completed';
					workflow.steps[index].result = result;
					workflow.usage.localSteps++;
					if (step.kind === 'analyze')
						workflow.usage.analyzedCharacters += document?.text.length ?? 0;
					workflow.progress = Math.round(
						(workflow.steps.filter((item) => item.state === 'completed').length * 100) /
							workflow.steps.length
					);
				});
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			this.update(id, (workflow) => {
				if (workflow.state !== 'cancelled')
					workflow.state = workflow.steps.every((step) => step.state === 'completed')
						? 'completed'
						: 'interrupted';
				workflow.owner = undefined;
			});
		} catch (error) {
			const workflow = this.store.get<EditorialWorkflow>(this.namespace, id);
			if (workflow?.owner?.instance === this.instance) {
				this.update(id, (record) => {
					if (record.state !== 'cancelled') record.state = 'failed';
					record.error =
						error instanceof Error ? error.message : 'Editorial workflow failed';
					const active = record.steps.find((step) => step.state === 'running');
					if (active) {
						active.state = 'failed';
						active.error = record.error;
					}
					record.owner = undefined;
				});
			}
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		await Promise.all(this.running.values());
	}
}
