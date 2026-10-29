import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { constants, lstatSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import * as path from 'node:path';
import { safeWriteFile } from '../../utils/common.js';
import { getDocumentPath, isValidScrivenerDocumentId } from '../../utils/scrivener-utils.js';
import { planSnapshot, writePlannedSnapshot, type SnapshotEntry } from '../snapshots.js';
import { PersistentStore } from './persistent-store.js';

const MAX_RAW_BYTES = 64 * 1024 * 1024;
const MAX_EXPORT_BYTES = 32 * 1024 * 1024;
const MAX_EXPORT_RESULT_BYTES = 8 * 1024 * 1024;
const SAVED_READ_FLAGS =
	constants.O_RDONLY |
	(constants.O_NOFOLLOW ?? 0) |
	(constants.O_NONBLOCK ?? 0) |
	(constants.O_NOCTTY ?? 0);
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

export interface ExportPublicationRequest {
	operationId: string;
	requestHash: string;
	outputPath: string;
}

interface ExportPublicationRecord {
	id: string;
	targetKind: 'export';
	requestHash: string;
	projectFile: string;
	state: 'prepared' | 'committed' | 'conflicted';
	createdAt: string;
	completedAt?: string;
	artifact?: {
		bytes: number;
		sha256: string;
		base64: string;
		result: Record<string, unknown>;
	};
}

function isExportPublication(value: unknown): value is ExportPublicationRecord {
	return (
		!!value &&
		typeof value === 'object' &&
		(value as { targetKind?: unknown }).targetKind === 'export'
	);
}

export class MutationCoordinator {
	private store?: PersistentStore;
	private indexInitialized = false;
	private ownsStore: boolean;
	private readonly activeMutations = new Set<Promise<unknown>>();
	private closePromise?: Promise<void>;
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
				for (const value of store.list<MutationRecord | ExportPublicationRecord>(JOURNAL)) {
					if (
						!value ||
						typeof value !== 'object' ||
						!['prepared', 'committed', 'conflicted'].includes(value.state)
					)
						throw new Error('Malformed mutation journal record');
					if (value.state === 'prepared') {
						const record = isExportPublication(value)
							? this.exportPublication(value)
							: this.mutation(value);
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

	private async readSavedBytes(
		target: string,
		maximum = MAX_RAW_BYTES
	): Promise<{ bytes: Buffer; exists: boolean; revision: string }> {
		try {
			const handle = await fs.open(target, SAVED_READ_FLAGS);
			try {
				const stat = await handle.stat();
				if (
					!stat.isFile() ||
					!Number.isSafeInteger(stat.size) ||
					stat.size < 0 ||
					stat.size > maximum
				)
					throw new Error('Saved content is not a supported regular file');
				if (process.platform === 'win32' || !constants.O_NOFOLLOW) {
					// Windows lacks atomic no-follow and may omit path volume IDs; compare descriptor identities.
					const verification = await fs.open(target, SAVED_READ_FLAGS);
					try {
						this.assertProjectPath(target);
						const [originalIdentity, currentIdentity, entry] = await Promise.all([
							handle.stat({ bigint: true }),
							verification.stat({ bigint: true }),
							fs.lstat(target, { bigint: true }),
						]);
						if (
							entry.isSymbolicLink() ||
							!entry.isFile() ||
							!currentIdentity.isFile() ||
							originalIdentity.dev !== currentIdentity.dev ||
							originalIdentity.ino !== currentIdentity.ino ||
							entry.ino !== currentIdentity.ino
						)
							throw new Error('Saved content changed while opening; retry');
					} finally {
						await verification.close();
					}
				}
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
				return { bytes, exists: true, revision: documentRevision(bytes) };
			} finally {
				await handle.close();
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT')
				return { bytes: Buffer.alloc(0), exists: false, revision: documentRevision('') };
			throw error;
		}
	}

	private async readSaved(
		target: string
	): Promise<{ raw: string; exists: boolean; revision: string }> {
		const saved = await this.readSavedBytes(target);
		const raw = saved.bytes.toString('utf8');
		if (!Buffer.from(raw).equals(saved.bytes))
			throw new Error('Saved content is not valid UTF-8');
		return { raw, exists: saved.exists, revision: saved.revision };
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

	recover(): Promise<MutationRecord[]> {
		return this.trackMutation(this.recoverPending());
	}

	private trackMutation<T>(mutation: Promise<T>): Promise<T> {
		const tracked = mutation.finally(() => this.activeMutations.delete(tracked));
		this.activeMutations.add(tracked);
		return tracked;
	}

	private async recoverPending(): Promise<MutationRecord[]> {
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
				const value = store.get<unknown>(JOURNAL, operationId);
				if (isExportPublication(value)) {
					const publication = this.exportPublication(value);
					if (publication.id !== operationId)
						throw new Error('Export journal key does not match its operation ID');
					await this.recoverExportPublication(publication);
					continue;
				}
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

	private exportPath(filePath: string): string {
		if (
			typeof filePath !== 'string' ||
			filePath.includes('\0') ||
			filePath.length > 4096 ||
			!path.isAbsolute(filePath)
		)
			throw new Error('Export publication requires an absolute path');
		const target = path.resolve(filePath);
		const relative = path.relative(
			path.join(this.projectPath, '.scrivener-mcp', 'exports'),
			target
		);
		if (
			path.dirname(relative) !== '.' ||
			!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.(docx|epub|pdf)$/i.test(relative) ||
			/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(relative)
		)
			throw new Error(
				'Workflow exports require a safe filename directly inside .scrivener-mcp/exports'
			);
		return target;
	}

	private exportPublication(value: unknown): ExportPublicationRecord {
		if (!isExportPublication(value)) throw new Error('Malformed export publication journal');
		const record = value;
		if (
			typeof record.id !== 'string' ||
			!/^[A-Za-z0-9_-]{1,128}$/.test(record.id) ||
			typeof record.requestHash !== 'string' ||
			!/^[a-f0-9]{64}$/.test(record.requestHash) ||
			typeof record.projectFile !== 'string' ||
			record.projectFile.length > 4096 ||
			!record.projectFile.startsWith('.scrivener-mcp/exports/') ||
			/[\\/]/.test(record.projectFile.slice('.scrivener-mcp/exports/'.length)) ||
			!['prepared', 'committed', 'conflicted'].includes(record.state) ||
			typeof record.createdAt !== 'string' ||
			record.createdAt.length > 64 ||
			!Number.isFinite(Date.parse(record.createdAt))
		)
			throw new Error('Malformed export publication journal');
		this.exportPath(path.join(this.projectPath, ...record.projectFile.split('/')));
		if (record.state === 'committed' && !record.artifact)
			throw new Error('Committed export publication has no prepared artifact');
		if (record.artifact) {
			const artifact = record.artifact;
			if (
				!Number.isSafeInteger(artifact.bytes) ||
				artifact.bytes < 1 ||
				artifact.bytes > MAX_EXPORT_BYTES ||
				typeof artifact.sha256 !== 'string' ||
				!/^[a-f0-9]{64}$/.test(artifact.sha256) ||
				typeof artifact.base64 !== 'string' ||
				artifact.base64.length > Math.ceil(MAX_EXPORT_BYTES / 3) * 4 ||
				!artifact.result ||
				typeof artifact.result !== 'object' ||
				Array.isArray(artifact.result) ||
				Buffer.byteLength(JSON.stringify(artifact.result)) > MAX_EXPORT_RESULT_BYTES
			)
				throw new Error('Malformed prepared export artifact');
			const bytes = Buffer.from(artifact.base64, 'base64');
			if (
				bytes.length !== artifact.bytes ||
				bytes.toString('base64') !== artifact.base64 ||
				documentRevision(bytes) !== artifact.sha256
			)
				throw new Error('Prepared export artifact failed its integrity check');
		}
		return record;
	}

	private async readExport(record: ExportPublicationRecord) {
		const target = this.exportPath(
			path.join(this.projectPath, ...record.projectFile.split('/'))
		);
		this.assertProjectPath(target);
		const saved = await this.readSavedBytes(target, MAX_EXPORT_BYTES);
		this.assertProjectPath(target);
		return saved;
	}

	private checkpointExport(record: ExportPublicationRecord): void {
		this.state().transaction(() => {
			this.state().put(JOURNAL, record.id, record);
			if (record.state !== 'prepared') this.state().delete(PENDING, record.id);
		});
	}

	private async recoverExportPublication(record: ExportPublicationRecord): Promise<void> {
		if (record.state !== 'prepared') {
			this.state().delete(PENDING, record.id);
			return;
		}
		const current = await this.readExport(record);
		if (!current.exists) return;
		if (
			record.artifact &&
			current.revision === record.artifact.sha256 &&
			current.bytes.length === record.artifact.bytes
		) {
			record.state = 'committed';
			record.completedAt = new Date().toISOString();
		} else record.state = 'conflicted';
		this.checkpointExport(record);
	}

	publishExport(
		request: ExportPublicationRequest,
		prepare: () => Promise<{ buffer: Buffer; result: Record<string, unknown> }>
	): Promise<Record<string, unknown>> {
		return this.trackMutation(this.publishExportData(request, prepare));
	}

	private async publishExportData(
		request: ExportPublicationRequest,
		prepare: () => Promise<{ buffer: Buffer; result: Record<string, unknown> }>
	): Promise<Record<string, unknown>> {
		request = { ...request };
		if (
			!request ||
			typeof request.operationId !== 'string' ||
			!/^[A-Za-z0-9_-]{1,128}$/.test(request.operationId) ||
			typeof request.requestHash !== 'string' ||
			!/^[a-f0-9]{64}$/.test(request.requestHash)
		)
			throw new Error('Export publication requires bounded operation and request identities');
		const target = this.exportPath(request.outputPath);
		this.assertProjectPath(target);
		await this.recover();
		const store = this.state();
		const token = randomUUID();
		const record = store.transaction(() => {
			if (this.claim())
				throw new Error('Another manuscript operation acquired the project; retry');
			const previous = store.get<unknown>(JOURNAL, request.operationId);
			const prior = previous === undefined ? undefined : this.exportPublication(previous);
			const projectFile = `.scrivener-mcp/exports/${path.basename(target)}`;
			if (
				prior &&
				(prior.id !== request.operationId ||
					prior.requestHash !== request.requestHash ||
					prior.projectFile !== projectFile)
			)
				throw new Error('Export operation ID was already used for a different request');
			if (prior?.state === 'conflicted')
				throw new Error(
					'Export publication conflicts with an existing or changed artifact; start a new workflow'
				);
			if (prior?.state === 'committed') return prior;
			const next: ExportPublicationRecord = prior ?? {
				id: request.operationId,
				targetKind: 'export',
				requestHash: request.requestHash,
				projectFile,
				state: 'prepared',
				createdAt: new Date().toISOString(),
			};
			store.put(JOURNAL, next.id, next);
			store.put(PENDING, next.id, { id: next.id });
			store.put<MutationClaim>(CLAIMS, 'project', {
				operationId: next.id,
				ownerPid: process.pid,
				host: hostname(),
				token,
			});
			return next;
		});
		if (record.state === 'committed') return this.exportResult(record);
		activeClaims.add(token);
		try {
			if (!record.artifact) {
				if ((await this.readExport(record)).exists) {
					record.state = 'conflicted';
					this.checkpointExport(record);
					throw new Error('Export destination already exists; it was not overwritten');
				}
				const prepared = await prepare();
				if (
					!Buffer.isBuffer(prepared.buffer) ||
					prepared.buffer.length < 1 ||
					prepared.buffer.length > MAX_EXPORT_BYTES
				)
					throw new Error('Workflow export artifact must contain 1 through 32 MiB');
				const json = JSON.stringify(prepared.result);
				if (
					!prepared.result ||
					typeof prepared.result !== 'object' ||
					Array.isArray(prepared.result) ||
					!json ||
					Buffer.byteLength(json) > MAX_EXPORT_RESULT_BYTES
				)
					throw new Error('Workflow export result exceeds its 8 MiB metadata limit');
				record.artifact = {
					bytes: prepared.buffer.length,
					sha256: documentRevision(prepared.buffer),
					base64: prepared.buffer.toString('base64'),
					result: JSON.parse(json) as Record<string, unknown>,
				};
				store.transaction(() => {
					if (this.claim()?.token !== token)
						throw new Error('Export publication ownership changed');
					store.put(JOURNAL, record.id, record);
				});
			}
			await this.writeExportArtifact(record);
			record.state = 'committed';
			record.completedAt = new Date().toISOString();
			this.checkpointExport(record);
			return await this.exportResult(record);
		} catch (error) {
			const persisted = store.get<ExportPublicationRecord>(JOURNAL, record.id);
			if (persisted?.state === 'prepared' && !persisted.artifact)
				store.transaction(() => {
					if (this.claim()?.token !== token)
						throw new Error('Export publication ownership changed during abort');
					store.delete(JOURNAL, record.id);
					store.delete(PENDING, record.id);
					store.delete(CLAIMS, 'project');
				});
			throw error;
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

	private async writeExportArtifact(record: ExportPublicationRecord): Promise<void> {
		if (!record.artifact) throw new Error('Export publication has no prepared artifact');
		const current = await this.readExport(record);
		if (current.exists) {
			if (
				current.revision === record.artifact.sha256 &&
				current.bytes.length === record.artifact.bytes
			)
				return;
			record.state = 'conflicted';
			this.checkpointExport(record);
			throw new Error('Export destination changed; it was not overwritten');
		}
		const target = this.exportPath(
			path.join(this.projectPath, ...record.projectFile.split('/'))
		);
		try {
			await this.publishNewFile(target, Buffer.from(record.artifact.base64, 'base64'));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		}
		const published = await this.readExport(record);
		if (
			!published.exists ||
			published.revision !== record.artifact.sha256 ||
			published.bytes.length !== record.artifact.bytes
		) {
			record.state = 'conflicted';
			this.checkpointExport(record);
			throw new Error(
				'Published export conflicts with the prepared artifact; it was not overwritten'
			);
		}
	}

	private async publishNewFile(target: string, bytes: Buffer): Promise<void> {
		if (!Buffer.isBuffer(bytes) || bytes.length > MAX_RAW_BYTES)
			throw new Error('New saved content exceeds its publication size limit');
		const parent = path.dirname(target);
		this.assertProjectPath(target);
		await fs.mkdir(parent, { recursive: true, mode: 0o700 });
		this.assertProjectPath(target);
		const staging = await fs.mkdtemp(path.join(parent, '.mutation-publication-'));
		try {
			const temporary = path.join(staging, 'artifact');
			const handle = await fs.open(temporary, 'wx', 0o600);
			try {
				await handle.writeFile(bytes);
				await handle.sync();
			} finally {
				await handle.close();
			}
			this.assertProjectPath(target);
			await fs.link(temporary, target);
		} finally {
			await fs.rm(staging, { recursive: true, force: true });
		}
	}

	private async exportResult(record: ExportPublicationRecord): Promise<Record<string, unknown>> {
		if (!record.artifact || record.state !== 'committed')
			throw new Error('Export receipt is incomplete');
		const current = await this.readExport(record);
		if (
			!current.exists ||
			current.revision !== record.artifact.sha256 ||
			current.bytes.length !== record.artifact.bytes
		)
			throw new Error('Published export changed or disappeared; start a new workflow');
		const result = JSON.parse(JSON.stringify(record.artifact.result)) as Record<
			string,
			unknown
		>;
		return {
			...result,
			path: this.exportPath(path.join(this.projectPath, ...record.projectFile.split('/'))),
			bytes: record.artifact.bytes,
			receipt: {
				operationId: record.id,
				requestHash: record.requestHash,
				sha256: record.artifact.sha256,
			},
		};
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

	snapshot(documentId: string, title: string, date: Date): Promise<SnapshotEntry> {
		return this.trackMutation(this.createSnapshot(documentId, title, date));
	}

	private async createSnapshot(
		documentId: string,
		title: string,
		date: Date
	): Promise<SnapshotEntry> {
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

	private commitTarget(
		targetInfo: MutationTarget,
		afterRaw: string,
		options: CommitOptions,
		snapshotDate = new Date()
	): Promise<MutationRecord> {
		return this.trackMutation(this.commitToTarget(targetInfo, afterRaw, options, snapshotDate));
	}

	private async commitToTarget(
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
		const canonicalKey = key.toLowerCase();
		// Scrivener's native checksum sidecar uses SHA-1; revision and conflict checks use SHA-256.
		const hash = createHash('sha1').update(raw).digest('hex');
		const lines: string[] = [];
		let updated = false;
		for (const line of existing.split('\n').filter(Boolean)) {
			if (line.slice(0, key.length).toLowerCase() !== canonicalKey) {
				lines.push(line);
			} else if (!updated) {
				lines.push(`${line.slice(0, key.length)}${hash}${line.endsWith('\r') ? '\r' : ''}`);
				updated = true;
			}
		}
		if (!updated) lines.push(`${key}${hash}${existing.includes('\r\n') ? '\r' : ''}`);
		await safeWriteFile(checksumPath, `${lines.join('\n')}\n`);
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		if (!this.activeMutations.size) {
			this.closeStore();
			return Promise.resolve();
		}
		this.closePromise = this.drainAndClose();
		return this.closePromise;
	}

	private async drainAndClose(): Promise<void> {
		const errors = new Set<unknown>();
		try {
			while (this.activeMutations.size) {
				for (const result of await Promise.allSettled(this.activeMutations)) {
					if (result.status === 'rejected') errors.add(result.reason);
				}
			}
			try {
				this.closeStore();
			} catch (error) {
				errors.add(error);
			}
			if (errors.size === 1) throw errors.values().next().value;
			if (errors.size > 1)
				throw new AggregateError(errors, 'Manuscript mutations failed during shutdown');
		} finally {
			this.closePromise = undefined;
		}
	}

	private closeStore(): void {
		if (this.store && this.ownsStore) this.store.close();
		this.store = undefined;
		this.indexInitialized = false;
	}
}
