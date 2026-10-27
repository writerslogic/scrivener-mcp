import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import * as path from 'node:path';
import { safeWriteFile } from '../../utils/common.js';
import { getDocumentPath, isValidScrivenerDocumentId } from '../../utils/scrivener-utils.js';
import { createSnapshot } from '../snapshots.js';
import { PersistentStore } from './persistent-store.js';

const MAX_RAW_BYTES = 64 * 1024 * 1024;
const JOURNAL = 'mutations';
const CLAIMS = 'mutation-claims';
const activeClaims = new Set<string>();

export function documentRevision(raw: string | Buffer): string {
	return createHash('sha256').update(raw).digest('hex');
}

export interface MutationRecord {
	id: string;
	documentId: string;
	beforeRevision: string;
	afterRevision: string;
	beforeRaw: string;
	afterRaw: string;
	beforeExists: boolean;
	state: 'prepared' | 'committed' | 'conflicted';
	snapshotId?: string;
	createdAt: string;
	completedAt?: string;
	undoes?: string;
}

interface MutationClaim {
	operationId: string;
	ownerPid: number;
	host: string;
	token: string;
}

export interface CommitOptions {
	expectedRevision?: string;
	operationId?: string;
	undoes?: string;
	snapshotTitle?: string;
}

export class MutationCoordinator {
	private store?: PersistentStore;
	private readonly suppliedStore: boolean;
	readonly projectPath: string;

	constructor(projectPath: string, store?: PersistentStore) {
		this.projectPath = path.resolve(projectPath);
		this.store = store;
		this.suppliedStore = Boolean(store);
	}

	private state(): PersistentStore {
		if (!this.store) {
			this.assertSafePath(path.join(this.projectPath, '.scrivener-mcp', 'editorial.sqlite'));
			this.store = new PersistentStore(
				path.join(this.projectPath, '.scrivener-mcp', 'editorial.sqlite')
			);
		}
		return this.store;
	}

	private assertSafePath(target: string): void {
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
		this.assertSafePath(target);
		return target;
	}

	async readRaw(documentId: string): Promise<{ raw: string; exists: boolean; revision: string }> {
		const target = this.documentPath(documentId);
		try {
			const stat = await fs.stat(target);
			if (!stat.isFile() || stat.size > MAX_RAW_BYTES)
				throw new Error('Document is not a supported regular file');
			const bytes = await fs.readFile(target);
			if (bytes.length > MAX_RAW_BYTES)
				throw new Error('Document exceeds the supported size');
			const raw = bytes.toString('utf8');
			if (!Buffer.from(raw).equals(bytes)) throw new Error('Document RTF is not valid UTF-8');
			return { raw, exists: true, revision: documentRevision(bytes) };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT')
				return { raw: '', exists: false, revision: documentRevision('') };
			throw error;
		}
	}

	get(operationId: string): MutationRecord | undefined {
		return this.state().get<MutationRecord>(JOURNAL, operationId);
	}

	private ownerAlive(claim: MutationClaim): 'alive' | 'dead' | 'unknown' {
		if (claim.host !== hostname()) return 'unknown';
		if (claim.ownerPid === process.pid) return activeClaims.has(claim.token) ? 'alive' : 'dead';
		try {
			process.kill(claim.ownerPid, 0);
			return 'alive';
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown';
		}
	}

	async recover(): Promise<MutationRecord[]> {
		const store = this.state();
		const recovered: MutationRecord[] = [];
		const visited = new Set<string>();
		while (true) {
			const claim = store.get<MutationClaim>(CLAIMS, 'project');
			if (claim) {
				const alive = this.ownerAlive(claim);
				if (alive !== 'dead')
					throw new Error(
						alive === 'alive'
							? 'Another manuscript operation is active; retry after it completes'
							: 'Manuscript operation ownership is ambiguous; inspect the original server before recovery'
					);
			}
			const operationId =
				claim?.operationId ??
				store
					.list<MutationRecord>(JOURNAL)
					.find((record) => record.state === 'prepared' && !visited.has(record.id))?.id;
			if (!operationId) return recovered;
			visited.add(operationId);
			const token = randomUUID();
			store.transaction(() => {
				const current = store.get<MutationClaim>(CLAIMS, 'project');
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
				const record = store.get<MutationRecord>(JOURNAL, operationId);
				if (!record)
					throw new Error('Mutation journal is missing for an interrupted operation');
				if (record.state === 'prepared') {
					const current = await this.readRaw(record.documentId);
					if (current.revision === record.afterRevision && current.exists) {
						await this.syncChecksum(record.documentId, record.afterRaw);
						record.state = 'committed';
						record.completedAt = new Date().toISOString();
					} else if (
						current.revision !== record.beforeRevision ||
						current.exists !== record.beforeExists
					) {
						record.state = 'conflicted';
					}
					store.put(JOURNAL, record.id, record);
				}
				recovered.push(record);
			} finally {
				store.transaction(() => {
					if (store.get<MutationClaim>(CLAIMS, 'project')?.token === token)
						store.delete(CLAIMS, 'project');
				});
				activeClaims.delete(token);
			}
		}
	}

	async commit(
		documentId: string,
		afterRaw: string,
		options: CommitOptions = {}
	): Promise<MutationRecord> {
		if (typeof afterRaw !== 'string' || Buffer.byteLength(afterRaw) > MAX_RAW_BYTES)
			throw new Error('Invalid RTF content size');
		if (
			options.expectedRevision !== undefined &&
			!/^[a-f0-9]{64}$/.test(options.expectedRevision)
		)
			throw new Error('Invalid expected revision');
		const id = options.operationId ?? randomUUID();
		if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid operation ID');
		const target = this.documentPath(documentId);
		const store = this.state();
		await this.recover();
		const before = await this.readRaw(documentId);
		const afterRevision = documentRevision(afterRaw);
		const token = randomUUID();
		let record: MutationRecord;
		const alreadyCommitted = store.transaction(() => {
			const claim = store.get<MutationClaim>(CLAIMS, 'project');
			if (claim) throw new Error('Another manuscript operation acquired the project; retry');
			const prior = store.get<MutationRecord>(JOURNAL, id);
			if (prior) {
				if (
					prior.documentId !== documentId ||
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
				documentId,
				beforeRevision: before.revision,
				afterRevision,
				beforeRaw: before.raw,
				afterRaw,
				beforeExists: before.exists,
				state: 'prepared',
				createdAt: new Date().toISOString(),
				undoes: options.undoes,
			};
			store.put(JOURNAL, id, record);
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
		record = store.get<MutationRecord>(JOURNAL, id)!;
		try {
			let current = await this.readRaw(documentId);
			if (
				current.revision !== record.beforeRevision ||
				current.exists !== record.beforeExists
			)
				throw new Error('Saved manuscript changed while preparing the mutation');
			if (record.beforeExists && !record.snapshotId) {
				this.assertSafePath(
					path.join(this.projectPath, 'Snapshots', `${documentId}.snapshots`, 'index.xml')
				);
				record.snapshotId = (
					await createSnapshot(
						this.projectPath,
						documentId,
						options.snapshotTitle ?? 'Before reviewed edit',
						new Date()
					)
				).snapshotId;
				store.put(JOURNAL, id, record);
			}
			current = await this.readRaw(documentId);
			if (
				current.revision !== record.beforeRevision ||
				current.exists !== record.beforeExists
			)
				throw new Error('Saved manuscript changed before commit; the edit was not applied');
			this.assertSafePath(target);
			await safeWriteFile(target, afterRaw);
			await this.syncChecksum(documentId, afterRaw);
			record.state = 'committed';
			record.completedAt = new Date().toISOString();
			store.put(JOURNAL, id, record);
			return record;
		} finally {
			store.transaction(() => {
				if (store.get<MutationClaim>(CLAIMS, 'project')?.token === token)
					store.delete(CLAIMS, 'project');
			});
			activeClaims.delete(token);
		}
	}

	private async syncChecksum(documentId: string, raw: string): Promise<void> {
		const checksumPath = path.join(this.projectPath, 'Files', 'Data', 'docs.checksum');
		this.assertSafePath(checksumPath);
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
		if (this.store && !this.suppliedStore) this.store.close();
		this.store = undefined;
	}
}
