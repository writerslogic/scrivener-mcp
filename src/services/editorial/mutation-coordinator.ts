import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import * as path from 'node:path';
import { safeWriteFile } from '../../utils/common.js';
import { getDocumentPath, isValidScrivenerDocumentId } from '../../utils/scrivener-utils.js';
import { planSnapshot, writePlannedSnapshot, type SnapshotEntry } from '../snapshots.js';
import { PersistentStore } from './persistent-store.js';

const MAX_RAW_BYTES = 64 * 1024 * 1024;
const JOURNAL = 'mutations';
const CLAIMS = 'mutation-claims';
const PENDING = 'mutation-pending';
const activeClaims = new Set<string>();

export function documentRevision(raw: string | Buffer): string {
	return createHash('sha256').update(raw).digest('hex');
}

export interface MutationRecord {
	id: string;
	documentId: string;
	targetKind?: 'document' | 'binder' | 'snapshot';
	projectFile?: string;
	beforeRevision: string;
	afterRevision: string;
	beforeRaw: string;
	afterRaw: string;
	beforeExists: boolean;
	state: 'prepared' | 'committed' | 'conflicted';
	snapshotId?: string;
	snapshot?: SnapshotEntry;
	snapshotRequest?: { title: string; date: string };
	createdAt: string;
	completedAt?: string;
	undoes?: string;
}

interface MutationTarget {
	documentId: string;
	targetKind: 'document' | 'binder' | 'snapshot';
	projectFile?: string;
}

interface OperationOwner {
	ownerPid: number;
	host: string;
	token: string;
}

interface MutationClaim extends OperationOwner {
	operationId: string;
}

function assertOperationOwner(value: unknown): asserts value is OperationOwner {
	const owner = value as Partial<OperationOwner> | null;
	if (
		!owner ||
		!Number.isSafeInteger(owner.ownerPid) ||
		owner.ownerPid! <= 0 ||
		owner.ownerPid! > 2_147_483_647 ||
		typeof owner.host !== 'string' ||
		!owner.host.length ||
		owner.host.length > 255 ||
		typeof owner.token !== 'string' ||
		!/^[A-Za-z0-9_-]{1,128}$/.test(owner.token)
	)
		throw new Error('Malformed operation ownership record; manual inspection is required');
}

export function operationOwnerState(
	owner: OperationOwner,
	activeTokens: ReadonlySet<string>
): 'alive' | 'dead' | 'unknown' {
	assertOperationOwner(owner);
	if (owner.host !== hostname()) return 'unknown';
	if (owner.ownerPid === process.pid) return activeTokens.has(owner.token) ? 'alive' : 'unknown';
	try {
		process.kill(owner.ownerPid, 0);
		return 'alive';
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown';
	}
}

export interface CommitOptions {
	expectedRevision?: string;
	operationId?: string;
	undoes?: string;
	snapshotTitle?: string;
}

export class MutationCoordinator {
	private store?: PersistentStore;
	private indexInitialized = false;
	private ownsStore: boolean;
	readonly projectPath: string;

	constructor(projectPath: string, store?: PersistentStore) {
		this.projectPath = path.resolve(projectPath);
		this.store = store;
		this.ownsStore = !store;
	}

	private state(): PersistentStore {
		if (!this.store) {
			this.assertProjectPath(
				path.join(this.projectPath, '.scrivener-mcp', 'editorial.sqlite')
			);
			this.store = new PersistentStore(
				path.join(this.projectPath, '.scrivener-mcp', 'editorial.sqlite')
			);
			this.ownsStore = true;
		}
		if (!this.indexInitialized) {
			const store = this.store;
			store.transaction(() => {
				const version = store.get<number>('mutation-meta', 'pending-index-version');
				if (version === 1) return;
				if (version !== undefined)
					throw new Error('Unsupported mutation pending-index version');
				for (const value of store.list<MutationRecord>(JOURNAL)) {
					if (
						!value ||
						typeof value !== 'object' ||
						!['prepared', 'committed', 'conflicted'].includes(value.state)
					)
						throw new Error('Malformed mutation journal record');
					if (value.state === 'prepared') {
						const record = this.mutation(value);
						store.put(PENDING, record.id, { id: record.id });
					}
				}
				store.put('mutation-meta', 'pending-index-version', 1);
			});
			this.indexInitialized = true;
		}
		return this.store;
	}

	assertProjectPath(target: string): void {
		const root = realpathSync(this.projectPath);
		const relative = path.relative(this.projectPath, target);
		if (relative.startsWith('..') || path.isAbsolute(relative))
			throw new Error('Path leaves the project');
		let current = root;
		for (const component of relative.split(path.sep)) {
			current = path.join(current, component);
			try {
				if (lstatSync(current).isSymbolicLink())
					throw new Error('Refusing a symlink in a project mutation path');
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			}
		}
	}

	private documentPath(documentId: string): string {
		if (typeof documentId !== 'string' || !isValidScrivenerDocumentId(documentId))
			throw new Error('Invalid document ID');
		const target = getDocumentPath(this.projectPath, documentId);
		this.assertProjectPath(target);
		return target;
	}

	private projectFilePath(filePath: string): string {
		if (typeof filePath !== 'string' || filePath.includes('\0'))
			throw new Error('Invalid binder file path');
		const target = path.resolve(filePath);
		const parent = path.dirname(target);
		if (
			(process.platform === 'win32'
				? parent.toLowerCase() !== this.projectPath.toLowerCase()
				: parent !== this.projectPath) ||
			path.extname(target).toLowerCase() !== '.scrivx'
		)
			throw new Error('Binder file must be a .scrivx file directly inside the project');
		this.assertProjectPath(target);
		return target;
	}

	private targetPath(target: MutationTarget): string {
		return target.targetKind === 'binder'
			? this.projectFilePath(path.join(this.projectPath, target.projectFile ?? ''))
			: this.documentPath(target.documentId);
	}

	private async readSaved(
		target: string
	): Promise<{ raw: string; exists: boolean; revision: string }> {
		try {
			const visible = await fs.stat(target);
			if (
				!visible.isFile() ||
				!Number.isSafeInteger(visible.size) ||
				visible.size < 0 ||
				visible.size > MAX_RAW_BYTES
			)
				throw new Error('Saved content is not a supported regular file');
			const handle = await fs.open(target, 'r');
			try {
				const stat = await handle.stat();
				if (
					!stat.isFile() ||
					!Number.isSafeInteger(stat.size) ||
					stat.size < 0 ||
					stat.size > MAX_RAW_BYTES
				)
					throw new Error('Saved content is not a supported regular file');
				const buffer = Buffer.alloc(stat.size + 1);
				let count = 0;
				while (count < buffer.length) {
					const read = await handle.read(buffer, count, buffer.length - count, count);
					if (!read.bytesRead) break;
					count += read.bytesRead;
				}
				const final = await handle.stat();
				if (
					count !== stat.size ||
					final.size !== stat.size ||
					final.mtimeMs !== stat.mtimeMs
				)
					throw new Error('Saved content changed during the read; retry');
				const bytes = buffer.subarray(0, count);
				const raw = bytes.toString('utf8');
				if (!Buffer.from(raw).equals(bytes))
					throw new Error('Saved content is not valid UTF-8');
				return { raw, exists: true, revision: documentRevision(bytes) };
			} finally {
				await handle.close();
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT')
				return { raw: '', exists: false, revision: documentRevision('') };
			throw error;
		}
	}

	async readRaw(documentId: string): Promise<{ raw: string; exists: boolean; revision: string }> {
		return this.readSaved(this.documentPath(documentId));
	}

	async readProjectFile(
		filePath: string
	): Promise<{ raw: string; exists: boolean; revision: string }> {
		return this.readSaved(this.projectFilePath(filePath));
	}

	async readProjectArtifact(
		filePath: string
	): Promise<{ raw: string; exists: boolean; revision: string }> {
		const target = path.resolve(filePath);
		this.assertProjectPath(target);
		return this.readSaved(target);
	}

	private claim(): MutationClaim | undefined {
		const value = this.state().get<unknown>(CLAIMS, 'project');
		if (value === undefined) return undefined;
		assertOperationOwner(value);
		const claim = value as Partial<MutationClaim>;
		if (
			typeof claim.operationId !== 'string' ||
			!/^[A-Za-z0-9_-]{1,128}$/.test(claim.operationId)
		)
			throw new Error(
				'Malformed manuscript operation ownership record; manual inspection is required'
			);
		return claim as MutationClaim;
	}

	private mutation(value: unknown): MutationRecord {
		if (!value || typeof value !== 'object')
			throw new Error('Malformed mutation journal record');
		const record = value as Partial<MutationRecord>;
		if (
			typeof record.id !== 'string' ||
			!/^[A-Za-z0-9_-]{1,128}$/.test(record.id) ||
			typeof record.documentId !== 'string' ||
			typeof record.beforeRaw !== 'string' ||
			typeof record.afterRaw !== 'string' ||
			Buffer.byteLength(record.beforeRaw) > MAX_RAW_BYTES ||
			Buffer.byteLength(record.afterRaw) > MAX_RAW_BYTES ||
			record.beforeRevision !== documentRevision(record.beforeRaw) ||
			record.afterRevision !== documentRevision(record.afterRaw) ||
			typeof record.beforeExists !== 'boolean' ||
			(!record.beforeExists && record.beforeRaw !== '') ||
			!['prepared', 'committed', 'conflicted'].includes(record.state ?? '') ||
			(record.targetKind !== undefined &&
				record.targetKind !== 'document' &&
				record.targetKind !== 'binder' &&
				record.targetKind !== 'snapshot')
		)
			throw new Error('Malformed mutation journal record');
		if (record.targetKind === 'binder') {
			if (
				typeof record.projectFile !== 'string' ||
				path.basename(record.projectFile) !== record.projectFile ||
				path.extname(record.projectFile).toLowerCase() !== '.scrivx'
			)
				throw new Error('Malformed binder mutation target');
		} else if (!isValidScrivenerDocumentId(record.documentId))
			throw new Error('Malformed document mutation target');
		if (
			record.snapshot &&
			(record.snapshot.documentId !== record.documentId ||
				record.snapshot.snapshotId !== record.snapshotId)
		)
			throw new Error('Snapshot plan does not match its mutation journal');
		return record as MutationRecord;
	}

	get(operationId: string): MutationRecord | undefined {
		const value = this.state().get<unknown>(JOURNAL, operationId);
		if (value === undefined) return undefined;
		const record = this.mutation(value);
		if (record.id !== operationId)
			throw new Error('Mutation journal key does not match its operation ID');
		return record;
	}

	async recover(): Promise<MutationRecord[]> {
		const store = this.state();
		const recovered: MutationRecord[] = [];
		const visited = new Set<string>();
		let pending: string[] = [];
		while (true) {
			const claim = this.claim();
			if (claim) {
				const alive = operationOwnerState(claim, activeClaims);
				if (alive !== 'dead')
					throw new Error(
						alive === 'alive'
							? 'Another manuscript operation is active; retry after it completes'
							: 'Manuscript operation ownership is ambiguous; inspect the original server before recovery'
					);
			}
			if (!claim) {
				while (pending.length && visited.has(pending[pending.length - 1])) pending.pop();
				if (!pending.length)
					pending = store
						.list<{ id: string }>(PENDING)
						.map((record) => record.id)
						.filter((id) => !visited.has(id));
			}
			const operationId = claim?.operationId ?? pending.pop();
			if (!operationId) return recovered;
			visited.add(operationId);
			const token = randomUUID();
			store.transaction(() => {
				const current = this.claim();
				if (current?.token !== claim?.token)
					throw new Error('Recovery ownership changed; retry');
				store.put<MutationClaim>(CLAIMS, 'project', {
					operationId,
					ownerPid: process.pid,
					host: hostname(),
					token,
				});
				activeClaims.add(token);
			});
			try {
				const record = this.get(operationId);
				if (!record)
					throw new Error('Mutation journal is missing for an interrupted operation');
				if (record.state === 'prepared') {
					const current = await this.readSaved(
						this.targetPath({
							documentId: record.documentId,
							targetKind: record.targetKind ?? 'document',
							projectFile: record.projectFile,
						})
					);
					if (
						current.exists &&
						(current.revision === record.beforeRevision ||
							current.revision === record.afterRevision)
					)
						await this.ensureSnapshot(record);
					if (current.revision === record.afterRevision && current.exists) {
						if ((record.targetKind ?? 'document') === 'document')
							await this.syncChecksum(record.documentId, record.afterRaw);
						record.state = 'committed';
						record.completedAt = new Date().toISOString();
					} else if (
						current.revision !== record.beforeRevision ||
						current.exists !== record.beforeExists
					) {
						record.state = 'conflicted';
					}
					store.transaction(() => {
						store.put(JOURNAL, record.id, record);
						if (record.state !== 'prepared') store.delete(PENDING, record.id);
					});
				} else store.delete(PENDING, record.id);
				recovered.push(record);
			} finally {
				try {
					store.transaction(() => {
						if (store.get<MutationClaim>(CLAIMS, 'project')?.token === token)
							store.delete(CLAIMS, 'project');
					});
				} finally {
					activeClaims.delete(token);
				}
			}
		}
	}

	private async ensureSnapshot(record: MutationRecord): Promise<void> {
		if (record.targetKind === 'binder' || !record.beforeExists) return;
		if (!record.snapshot && record.snapshotId) return;
		this.assertProjectPath(
			path.join(this.projectPath, 'Snapshots', `${record.documentId}.snapshots`, 'index.xml')
		);
		if (!record.snapshot) {
			const request = record.snapshotRequest ?? {
				title: 'Before reviewed edit',
				date: record.createdAt,
			};
			record.snapshot = await planSnapshot(
				this.projectPath,
				record.documentId,
				request.title,
				new Date(request.date)
			);
			record.snapshotId = record.snapshot.snapshotId;
			this.state().put(JOURNAL, record.id, record);
		}
		this.assertProjectPath(
			path.join(
				this.projectPath,
				'Snapshots',
				`${record.documentId}.snapshots`,
				`${record.snapshot.snapshotId}.rtf`
			)
		);
		await writePlannedSnapshot(this.projectPath, record.snapshot, record.beforeRaw);
	}

	async snapshot(documentId: string, title: string, date: Date): Promise<SnapshotEntry> {
		if (
			typeof title !== 'string' ||
			title.length > 512 ||
			!(date instanceof Date) ||
			!Number.isFinite(date.getTime())
		)
			throw new Error('Invalid snapshot title or date');
		const before = await this.readRaw(documentId);
		if (!before.exists) throw new Error('Document has no saved content to snapshot');
		const record = await this.commitTarget(
			{ documentId, targetKind: 'snapshot' },
			before.raw,
			{ expectedRevision: before.revision, snapshotTitle: title },
			date
		);
		if (!record.snapshot)
			throw new Error('Snapshot metadata is missing from the completed operation');
		return record.snapshot;
	}

	async commit(
		documentId: string,
		afterRaw: string,
		options: CommitOptions = {}
	): Promise<MutationRecord> {
		return this.commitTarget({ documentId, targetKind: 'document' }, afterRaw, options);
	}

	async commitProjectFile(
		filePath: string,
		afterRaw: string,
		options: CommitOptions & { expectedRevision: string }
	): Promise<MutationRecord> {
		if (
			!options ||
			typeof options.expectedRevision !== 'string' ||
			!/^[a-f0-9]{64}$/.test(options.expectedRevision)
		)
			throw new Error('A valid expected binder revision is required');
		const target = this.projectFilePath(filePath);
		return this.commitTarget(
			{
				documentId: path.basename(target),
				targetKind: 'binder',
				projectFile: path.basename(target),
			},
			afterRaw,
			options
		);
	}

	private async commitTarget(
		targetInfo: MutationTarget,
		afterRaw: string,
		options: CommitOptions,
		snapshotDate = new Date()
	): Promise<MutationRecord> {
		const documentId = targetInfo.documentId;
		if (typeof afterRaw !== 'string' || Buffer.byteLength(afterRaw) > MAX_RAW_BYTES)
			throw new Error('Invalid saved content size');
		if (
			options.expectedRevision !== undefined &&
			!/^[a-f0-9]{64}$/.test(options.expectedRevision)
		)
			throw new Error('Invalid expected revision');
		const id = options.operationId ?? randomUUID();
		if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid operation ID');
		const target = this.targetPath(targetInfo);
		if (targetInfo.targetKind === 'document')
			this.assertProjectPath(path.join(this.projectPath, 'Files', 'Data', 'docs.checksum'));
		const store = this.state();
		await this.recover();
		const before = await this.readSaved(target);
		const afterRevision = documentRevision(afterRaw);
		const token = randomUUID();
		let record: MutationRecord;
		const alreadyCommitted = store.transaction(() => {
			const claim = this.claim();
			if (claim) throw new Error('Another manuscript operation acquired the project; retry');
			const prior = this.get(id);
			if (prior) {
				if (
					prior.documentId !== documentId ||
					(prior.targetKind ?? 'document') !== targetInfo.targetKind ||
					prior.projectFile !== targetInfo.projectFile ||
					prior.afterRevision !== afterRevision ||
					(options.expectedRevision !== undefined &&
						prior.beforeRevision !== options.expectedRevision)
				)
					throw new Error('Operation ID was already used for different content');
				if (prior.state === 'committed') return prior;
				if (prior.state === 'conflicted')
					throw new Error('Interrupted mutation conflicts with saved manuscript changes');
			}
			if (
				options.expectedRevision !== undefined &&
				before.revision !== options.expectedRevision
			)
				throw new Error('Stale document revision; refresh and review the saved changes');
			record = prior ?? {
				id,
				...targetInfo,
				beforeRevision: before.revision,
				afterRevision,
				beforeRaw: before.raw,
				afterRaw,
				beforeExists: before.exists,
				state: 'prepared',
				createdAt: new Date().toISOString(),
				undoes: options.undoes,
				snapshotRequest:
					targetInfo.targetKind !== 'binder' && before.exists
						? {
								title: options.snapshotTitle ?? 'Before reviewed edit',
								date: snapshotDate.toISOString(),
							}
						: undefined,
			};
			store.put(JOURNAL, id, record);
			store.put(PENDING, id, { id });
			store.put<MutationClaim>(CLAIMS, 'project', {
				operationId: id,
				ownerPid: process.pid,
				host: hostname(),
				token,
			});
			activeClaims.add(token);
			return undefined;
		});
		if (alreadyCommitted) return alreadyCommitted;
		record = this.get(id)!;
		try {
			let current = await this.readSaved(target);
			if (
				current.revision !== record.beforeRevision ||
				current.exists !== record.beforeExists
			)
				throw new Error('Saved manuscript changed while preparing the mutation');
			await this.ensureSnapshot(record);
			current = await this.readSaved(target);
			if (
				current.revision !== record.beforeRevision ||
				current.exists !== record.beforeExists
			)
				throw new Error('Saved manuscript changed before commit; the edit was not applied');
			this.assertProjectPath(target);
			if (targetInfo.targetKind !== 'snapshot') await safeWriteFile(target, afterRaw);
			if (targetInfo.targetKind === 'document') await this.syncChecksum(documentId, afterRaw);
			record.state = 'committed';
			record.completedAt = new Date().toISOString();
			store.transaction(() => {
				store.put(JOURNAL, id, record);
				store.delete(PENDING, id);
			});
			return record;
		} finally {
			try {
				store.transaction(() => {
					if (store.get<MutationClaim>(CLAIMS, 'project')?.token === token)
						store.delete(CLAIMS, 'project');
				});
			} finally {
				activeClaims.delete(token);
			}
		}
	}

	private async syncChecksum(documentId: string, raw: string): Promise<void> {
		const checksumPath = path.join(this.projectPath, 'Files', 'Data', 'docs.checksum');
		this.assertProjectPath(checksumPath);
		let existing: string;
		try {
			existing = await fs.readFile(checksumPath, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
			throw error;
		}
		const key = `${documentId}/content.rtf=`;
		const hash = createHash('sha1').update(raw).digest('hex');
		const lines = existing.split('\n').filter(Boolean);
		const index = lines.findIndex((line) => line.startsWith(key));
		if (index < 0) lines.push(`${key}${hash}`);
		else lines[index] = `${key}${hash}`;
		await safeWriteFile(checksumPath, `${lines.join('\n')}\n`);
	}

	close(): void {
		if (this.store && this.ownsStore) this.store.close();
		this.store = undefined;
		this.indexInitialized = false;
	}
}
