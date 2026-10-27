import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { DocumentManager } from '../document-manager.js';
import type { ProjectWriter, WriteOptions } from '../project-writer.js';
import type { WriteFidelityReport } from '../../project-types.js';
import type { PersistentStore } from './persistent-store.js';
import type { MutationRecord } from './mutation-coordinator.js';

const PROPOSALS = 'review-proposals';
const APPLICATIONS = 'review-applications';
const BATCHES = 'review-batches';
const running = new Set<string>();
const MAX_TEXT = 10_000_000;

export interface ProposedEditInput {
	start: number;
	end: number;
	text: string;
}

export interface ProposedEdit extends ProposedEditInput {
	id: string;
	before: string;
	status: 'pending' | 'accepted' | 'rejected';
}

export interface ChangeProposal {
	id: string;
	documentId: string;
	title: string;
	sourceRevision: string;
	currentRevision: string;
	before: string;
	edits: ProposedEdit[];
	sequence: number;
	createdAt: string;
	applyingOperation?: string;
}

export interface ProposalPreview {
	proposalId: string;
	documentId: string;
	sourceRevision: string;
	revision: string;
	before: string;
	after: string;
	editIds: string[];
	fidelity: WriteFidelityReport;
}

export interface ReviewApplication {
	id: string;
	proposalId: string;
	editIds: string[];
	beforeRevision: string;
	afterRevision?: string;
	state: 'preparing' | 'committed' | 'interrupted' | 'failed' | 'undone';
	ownerPid: number;
	host: string;
	token: string;
	fidelity?: WriteFidelityReport;
}

export interface ApplyProposalOptions extends WriteOptions {
	editIds?: string[];
}

export interface ReviewBatch {
	id: string;
	proposalIds: string[];
	completed: Array<{ proposalId: string; operationId: string }>;
	state: 'applying' | 'completed' | 'interrupted';
	failedProposalId?: string;
}

function identity(value: string, label: string): string {
	if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) throw new Error(`Invalid ${label}`);
	return value;
}

function digest(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function stableUuid(value: unknown): string {
	const bytes = createHash('sha256').update(JSON.stringify(value)).digest().subarray(0, 16);
	bytes[6] = (bytes[6] & 15) | 80;
	bytes[8] = (bytes[8] & 63) | 128;
	const hex = bytes.toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function selectedEdits(proposal: ChangeProposal, editIds?: string[]): ProposedEdit[] {
	if (editIds !== undefined && (!Array.isArray(editIds) || editIds.length > 1000 || editIds.some((id) => typeof id !== 'string' || id.length > 160) || new Set(editIds).size !== editIds.length)) throw new Error('Invalid edit selection');
	const selected = editIds ? proposal.edits.filter((edit) => editIds.includes(edit.id)) : proposal.edits.filter((edit) => edit.status === 'pending');
	if (editIds && selected.length !== editIds.length) throw new Error('Selection contains an unknown edit ID');
	if (selected.some((edit) => edit.status !== 'pending')) throw new Error('Only pending edits may be selected');
	return selected;
}

function compose(proposal: ChangeProposal, additional: string[] = []): string {
	let text = proposal.before;
	const edits = proposal.edits.filter((edit) => edit.status === 'accepted' || additional.includes(edit.id));
	const length = edits.reduce((total, edit) => total + edit.text.length - (edit.end - edit.start), proposal.before.length);
	if (length > MAX_TEXT) throw new Error('Proposed manuscript text exceeds the supported length');
	for (const edit of [...edits].sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
	return text;
}

function applicationOwner(application: ReviewApplication): 'alive' | 'dead' | 'unknown' {
	if (!Number.isSafeInteger(application.ownerPid) || application.ownerPid <= 0 || application.ownerPid > 2_147_483_647 || typeof application.host !== 'string' || !application.host.length || application.host.length > 255 || typeof application.token !== 'string' || !application.token.length || application.token.length > 128) throw new Error('Malformed review application ownership record; manual inspection is required');
	if (application.host !== hostname()) return 'unknown';
	if (application.ownerPid === process.pid) return running.has(application.token) ? 'alive' : 'unknown';
	try {
		process.kill(application.ownerPid, 0);
		return 'alive';
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown';
	}
}

export class ReviewService {
	constructor(
		_projectPath: string,
		private readonly documents: DocumentManager,
		private readonly writer: ProjectWriter,
		private readonly store: PersistentStore
	) {}

	list(): ChangeProposal[] {
		return this.store.list<ChangeProposal>(PROPOSALS);
	}

	listApplications(): ReviewApplication[] {
		return this.store.list<ReviewApplication>(APPLICATIONS);
	}

	listBatches(): ReviewBatch[] {
		return this.store.list<ReviewBatch>(BATCHES);
	}

	get(proposalId: string): ChangeProposal {
		const proposal = this.store.get<ChangeProposal>(PROPOSALS, identity(proposalId, 'proposal ID'));
		if (!proposal) throw new Error('Change proposal was not found');
		return proposal;
	}

	async propose(input: { documentId: string; expectedRevision?: string; edits: ProposedEditInput[]; title?: string; idempotencyKey?: string }): Promise<ChangeProposal> {
		if (!Array.isArray(input.edits) || input.edits.length < 1 || input.edits.length > 1000) throw new Error('A proposal must contain between 1 and 1000 edits');
		if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 256)) throw new Error('Invalid proposal title');
		if (input.idempotencyKey !== undefined && (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.length || input.idempotencyKey.length > 256)) throw new Error('Invalid proposal idempotency key');
		const id = input.idempotencyKey ? stableUuid(['proposal', input.idempotencyKey]) : randomUUID();
		const prior = this.store.get<ChangeProposal>(PROPOSALS, id);
		if (prior) {
			if (prior.documentId !== input.documentId || prior.title !== (input.title ?? 'Proposed manuscript changes') || digest(prior.edits.map(({ start, end, text }) => ({ start, end, text }))) !== digest(input.edits) || (input.expectedRevision !== undefined && input.expectedRevision !== prior.sourceRevision)) throw new Error('Idempotency key was already used for a different proposal');
			return prior;
		}
		const saved = await this.documents.getMutationCoordinator().readRaw(input.documentId);
		if (!saved.exists) throw new Error('Cannot propose edits to a document without saved content');
		if (input.expectedRevision !== undefined && input.expectedRevision !== saved.revision) throw new Error('Stale document revision; refresh before proposing changes');
		const prepared = await this.writer.prepareDocument(input.documentId, await this.documents.readDocument(input.documentId), saved.revision);
		const before = prepared.beforeText;
		const sorted = [...input.edits].sort((a, b) => a.start - b.start);
		let previous: ProposedEditInput | undefined;
		for (const edit of sorted) {
			if (!edit || !Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.end) || edit.start < 0 || edit.end < edit.start || edit.end > before.length || typeof edit.text !== 'string' || edit.text.length > MAX_TEXT) throw new Error('Invalid proposed edit range or text');
			if (previous && (previous.end > edit.start || previous.start === edit.start)) throw new Error('Proposed edits overlap or insert ambiguously at one position');
			for (const offset of [edit.start, edit.end]) {
				if (offset > 0 && offset < before.length && /[\uD800-\uDBFF]/.test(before[offset - 1]) && /[\uDC00-\uDFFF]/.test(before[offset])) throw new Error('Edit range splits a Unicode character');
			}
			previous = edit;
		}
		const proposal: ChangeProposal = { id, documentId: input.documentId, title: input.title ?? 'Proposed manuscript changes', sourceRevision: saved.revision, currentRevision: saved.revision, before, edits: input.edits.map((edit) => ({ ...edit, id: randomUUID(), before: before.slice(edit.start, edit.end), status: 'pending' })), sequence: 0, createdAt: new Date().toISOString() };
		compose(proposal, proposal.edits.map((edit) => edit.id));
		return this.store.transaction(() => {
			if (this.store.get(PROPOSALS, id)) throw new Error('Proposal ID was concurrently created; retry');
			this.store.put(PROPOSALS, id, proposal);
			return proposal;
		});
	}

	async preview(proposalId: string, editIds?: string[]): Promise<ProposalPreview> {
		const proposal = this.get(proposalId);
		const selection = selectedEdits(proposal, editIds);
		const after = compose(proposal, selection.map((edit) => edit.id));
		const prepared = await this.writer.prepareDocument(proposal.documentId, after, proposal.currentRevision);
		return { proposalId, documentId: proposal.documentId, sourceRevision: proposal.sourceRevision, revision: proposal.currentRevision, before: prepared.beforeText, after: prepared.afterText, editIds: selection.map((edit) => edit.id), fidelity: prepared.fidelity };
	}

	reject(proposalId: string, editIds?: string[]): ChangeProposal {
		return this.store.transaction(() => {
			const proposal = this.get(proposalId);
			if (proposal.applyingOperation) throw new Error('Proposal is being applied; recover or wait before changing decisions');
			for (const edit of selectedEdits(proposal, editIds)) edit.status = 'rejected';
			this.store.put(PROPOSALS, proposal.id, proposal);
			return proposal;
		});
	}

	async apply(proposalId: string, options: ApplyProposalOptions = {}): Promise<ReviewApplication> {
		await this.recover();
		let proposal = this.get(proposalId);
		const id = identity(options.operationId ?? stableUuid(['application', proposal.id, proposal.sequence + 1]), 'operation ID');
		const prior = this.store.get<ReviewApplication>(APPLICATIONS, id);
		if (prior) {
			if (prior.proposalId !== proposalId || (options.editIds && digest([...prior.editIds].sort()) !== digest([...options.editIds].sort()))) throw new Error('Operation ID was already used for a different application');
			if (prior.state === 'committed') return prior;
			if (prior.state === 'undone') throw new Error('Application was undone; use a new operation ID to apply it again');
		}
		const selection = selectedEdits(proposal, options.editIds ?? prior?.editIds);
		if (!selection.length) throw new Error('There are no selected pending edits to apply');
		const prepared = await this.writer.prepareDocument(proposal.documentId, compose(proposal, selection.map((edit) => edit.id)), proposal.currentRevision);
		if (prepared.fidelity.atRisk.length && options.allowFormattingLoss !== true) throw new Error(`Preview discloses formatting loss; pass allowFormattingLoss: true to acknowledge: ${prepared.fidelity.atRisk.join(', ')}`);
		const token = randomUUID();
		const application: ReviewApplication = { id, proposalId, editIds: selection.map((edit) => edit.id), beforeRevision: proposal.currentRevision, state: 'preparing', ownerPid: process.pid, host: hostname(), token, fidelity: prepared.fidelity };
		this.store.transaction(() => {
			proposal = this.get(proposalId);
			if (proposal.currentRevision !== prepared.beforeRevision || proposal.applyingOperation) throw new Error('Proposal decisions changed while preparing application');
			selectedEdits(proposal, application.editIds);
			proposal.applyingOperation = id;
			this.store.put(PROPOSALS, proposalId, proposal);
			this.store.put(APPLICATIONS, id, application);
			running.add(token);
		});
		try {
			const result = await this.writer.commitPrepared(prepared, { ...options, operationId: id });
			application.afterRevision = result.mutation.afterRevision;
			application.fidelity = result.fidelity;
			return this.finalize(application, result.mutation);
		} catch (error) {
			const mutation = this.documents.getMutationCoordinator().get(id);
			if (mutation?.state === 'committed') return this.finalize(application, mutation);
			application.state = mutation ? 'interrupted' : 'failed';
			this.store.transaction(() => {
				const current = this.get(proposalId);
				if (current.applyingOperation === id) delete current.applyingOperation;
				this.store.put(PROPOSALS, proposalId, current);
				this.store.put(APPLICATIONS, id, application);
			});
			throw error;
		} finally {
			running.delete(token);
		}
	}

	private finalize(application: ReviewApplication, mutation: MutationRecord): ReviewApplication {
		return this.store.transaction(() => {
			const current = this.store.get<ReviewApplication>(APPLICATIONS, application.id);
			if (current?.state === 'committed') return current;
			if (current?.state === 'undone') throw new Error('Application was already undone');
			const proposal = this.get(application.proposalId);
			for (const edit of proposal.edits) if (application.editIds.includes(edit.id)) edit.status = 'accepted';
			proposal.currentRevision = mutation.afterRevision;
			proposal.sequence++;
			delete proposal.applyingOperation;
			application.state = 'committed';
			application.afterRevision = mutation.afterRevision;
			if (application.fidelity) application.fidelity.snapshotId = mutation.snapshotId;
			this.store.put(PROPOSALS, proposal.id, proposal);
			this.store.put(APPLICATIONS, application.id, application);
			return application;
		});
	}

	async undo(operationId: string, options: Pick<WriteOptions, 'force'> = {}): Promise<MutationRecord> {
		const application = this.store.get<ReviewApplication>(APPLICATIONS, identity(operationId, 'operation ID'));
		const mutation = this.documents.getMutationCoordinator().get(operationId);
		if (!application || !mutation || application.state !== 'committed' && application.state !== 'undone') throw new Error('Completed review application was not found');
		const undoId = stableUuid(['undo', operationId]);
		const prior = this.documents.getMutationCoordinator().get(undoId);
		if (prior?.state === 'committed') {
			this.finalizeUndo(application, prior);
			return prior;
		}
		const result = await this.writer.restoreRaw(mutation.documentId, mutation.beforeRaw, { ...options, expectedRevision: mutation.afterRevision, operationId: undoId, undoes: operationId, snapshotTitle: 'Before undo of reviewed edit' });
		this.documents.clearCache(mutation.documentId);
		this.finalizeUndo(application, result);
		return result;
	}

	private finalizeUndo(application: ReviewApplication, result: MutationRecord): void {
		this.store.transaction(() => {
			if (this.store.get<ReviewApplication>(APPLICATIONS, application.id)?.state === 'undone') return;
			const proposal = this.get(application.proposalId);
			for (const edit of proposal.edits) if (application.editIds.includes(edit.id)) edit.status = 'pending';
			proposal.currentRevision = result.afterRevision;
			proposal.sequence++;
			application.state = 'undone';
			this.store.put(PROPOSALS, proposal.id, proposal);
			this.store.put(APPLICATIONS, application.id, application);
		});
	}

	async recover(): Promise<ReviewApplication[]> {
		await this.documents.getMutationCoordinator().recover();
		const recovered: ReviewApplication[] = [];
		for (const application of this.store.list<ReviewApplication>(APPLICATIONS)) {
			if (application.state === 'committed') {
				const undo = this.documents.getMutationCoordinator().get(stableUuid(['undo', application.id]));
				if (undo?.state === 'committed') {
					this.finalizeUndo(application, undo);
					recovered.push(application);
				}
				continue;
			}
			if (application.state !== 'preparing' && application.state !== 'interrupted') continue;
			if (application.state === 'preparing') {
				const owner = applicationOwner(application);
				if (owner === 'alive') continue;
				if (owner === 'unknown') throw new Error('Review application ownership is ambiguous; inspect the original server before recovery');
			}
			const mutation = this.documents.getMutationCoordinator().get(application.id);
			if (mutation?.state === 'committed') recovered.push(this.finalize(application, mutation));
			else {
				application.state = mutation?.state === 'conflicted' ? 'failed' : 'interrupted';
				this.store.transaction(() => {
					const proposal = this.get(application.proposalId);
					if (proposal.applyingOperation === application.id) delete proposal.applyingOperation;
					this.store.put(PROPOSALS, proposal.id, proposal);
					this.store.put(APPLICATIONS, application.id, application);
				});
				recovered.push(application);
			}
		}
		return recovered;
	}

	async applyBatch(proposalIds: string[], options: Omit<ApplyProposalOptions, 'editIds'> = {}): Promise<ReviewBatch> {
		await this.recover();
		if (!Array.isArray(proposalIds) || !proposalIds.length || proposalIds.length > 100 || new Set(proposalIds).size !== proposalIds.length) throw new Error('A batch requires 1 to 100 distinct proposal IDs');
		const id = identity(options.operationId ?? randomUUID(), 'batch ID');
		const prior = this.store.get<ReviewBatch>(BATCHES, id);
		if (prior && digest(prior.proposalIds) !== digest(proposalIds)) throw new Error('Batch ID was already used for a different selection');
		const batch: ReviewBatch = prior ?? { id, proposalIds, completed: [], state: 'applying' };
		if (batch.state === 'completed') return batch;
		const documents = proposalIds.map((proposalId) => this.get(proposalId).documentId);
		if (new Set(documents).size !== documents.length) throw new Error('A batch may contain only one proposal per document; combine edits into one proposal first');
		for (const proposalId of proposalIds) {
			if (batch.completed.some((entry) => entry.proposalId === proposalId)) continue;
			const preview = await this.preview(proposalId);
			if (preview.fidelity.atRisk.length && !options.allowFormattingLoss) throw new Error('Batch contains disclosed formatting loss; acknowledge it before application');
		}
		this.store.put(BATCHES, id, batch);
		for (const proposalId of proposalIds) {
			if (batch.completed.some((entry) => entry.proposalId === proposalId)) continue;
			try {
				const application = await this.apply(proposalId, { ...options, operationId: stableUuid(['batch', id, proposalId]) });
				batch.completed.push({ proposalId, operationId: application.id });
				this.store.put(BATCHES, id, batch);
			} catch (error) {
				batch.state = 'interrupted';
				batch.failedProposalId = proposalId;
				this.store.put(BATCHES, id, batch);
				throw new Error(`Batch ${id} interrupted after ${batch.completed.length} applications; resume with the same batch ID`, { cause: error });
			}
		}
		batch.state = 'completed';
		delete batch.failedProposalId;
		this.store.put(BATCHES, id, batch);
		return batch;
	}
}
