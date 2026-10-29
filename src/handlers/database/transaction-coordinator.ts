import { AppError, ErrorCode } from '../../utils/common.js';
import { generateScrivenerUUID } from '../../utils/scrivener-utils.js';
import type { SQLiteManager } from './sqlite-manager.js';

type OperationStatus = 'pending' | 'prepared' | 'committed' | 'rolled_back';

export interface TransactionLog {
	id: string;
	timestamp: Date;
	operations: Array<{
		type: 'sqlite' | 'neo4j';
		operation: string;
		data: unknown;
		status: OperationStatus;
	}>;
	status: 'in_progress' | 'prepared' | 'committed' | 'rolled_back';
}

const LOG_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Nested tickets share one SQLite transaction and commit in reverse begin order. */
export class TransactionCoordinator {
	private readonly log: Map<string, TransactionLog> = new Map();
	private readonly active: string[] = [];
	private readonly members = new Set<string>();
	private owner?: SQLiteManager | null;
	private connection?: ReturnType<SQLiteManager['getDatabase']>;

	constructor(private readonly getSqlite: () => SQLiteManager | null) {}

	get(transactionId: string): TransactionLog | undefined {
		return this.log.get(transactionId);
	}

	async begin(): Promise<string> {
		const sqlite = this.getSqlite();
		if (this.active.length) {
			this.assertConnection();
			if (sqlite !== this.owner)
				throw new AppError(
					'Transaction database changed while a transaction is active',
					ErrorCode.DATABASE_ERROR
				);
		}
		const connection = sqlite?.getDatabase();
		sqlite?.beginTransaction();
		const transactionId = generateScrivenerUUID();
		if (!this.active.length) {
			this.cleanup();
			this.owner = sqlite;
			this.connection = connection;
		}

		this.log.set(transactionId, {
			id: transactionId,
			timestamp: new Date(),
			operations: [],
			status: 'in_progress',
		});

		this.active.push(transactionId);
		this.members.add(transactionId);

		return transactionId;
	}

	async prepare(transactionId: string): Promise<boolean> {
		const txn = this.log.get(transactionId);
		if (!txn) {
			throw new AppError('Transaction not found', ErrorCode.DATABASE_ERROR);
		}
		if (txn.status === 'committed') return true;
		if (txn.status === 'rolled_back')
			throw new AppError('Transaction was rolled back', ErrorCode.DATABASE_ERROR);
		this.assertConnection();

		try {
			txn.operations.forEach((op) => {
				if (op.status === 'pending') {
					op.status = 'prepared';
				}
			});

			txn.status = 'prepared';
			return true;
		} catch {
			await this.rollback(transactionId);
			return false;
		}
	}

	async commit(transactionId: string): Promise<void> {
		const txn = this.log.get(transactionId);
		if (txn?.status === 'committed') return;
		if (!txn || txn.status !== 'prepared') {
			throw new AppError('Transaction not prepared', ErrorCode.DATABASE_ERROR);
		}
		this.assertConnection();
		if (this.active[this.active.length - 1] !== transactionId)
			throw new AppError(
				'Nested transactions must commit in reverse begin order',
				ErrorCode.DATABASE_ERROR
			);

		try {
			this.owner?.commit();

			txn.status = 'committed';
			txn.operations.forEach((op) => (op.status = 'committed'));

			this.active.pop();
			if (!this.active.length) this.finishGroup();
		} catch (error) {
			try {
				await this.rollback(transactionId);
			} catch (rollbackError) {
				throw new AggregateError(
					[error, rollbackError],
					'Transaction commit and rollback failed',
					{ cause: rollbackError }
				);
			}
			throw error;
		}
	}

	async rollback(transactionId: string): Promise<void> {
		const txn = this.log.get(transactionId);
		if (!txn || txn.status === 'rolled_back') return;
		if (txn.status === 'committed')
			throw new AppError(
				'Committed transaction cannot be rolled back',
				ErrorCode.DATABASE_ERROR
			);
		if (!this.members.has(transactionId))
			throw new AppError('Transaction is no longer active', ErrorCode.DATABASE_ERROR);
		if (this.connection?.open) this.owner?.rollback();
		this.markRolledBack();
		this.finishGroup();
	}

	private assertConnection(): void {
		if (this.connection && (!this.connection.open || !this.connection.inTransaction)) {
			const closed = !this.connection.open;
			this.markRolledBack();
			this.finishGroup();
			throw new AppError(
				closed
					? 'Transaction database closed before completion'
					: 'Transaction is no longer active',
				ErrorCode.DATABASE_ERROR
			);
		}
	}

	private markRolledBack(): void {
		for (const id of this.members) {
			const txn = this.log.get(id)!;
			txn.status = 'rolled_back';
			txn.operations.forEach((op) => (op.status = 'rolled_back'));
		}
	}

	private finishGroup(): void {
		this.active.length = 0;
		this.members.clear();
		this.owner = undefined;
		this.connection = undefined;
		this.cleanup();
	}

	/** Drop finished transactions older than the retention window. */
	private cleanup(): void {
		const now = Date.now();

		this.log.forEach((entry, id) => {
			const age = now - entry.timestamp.getTime();
			if (
				age >= LOG_RETENTION_MS &&
				entry.status !== 'in_progress' &&
				entry.status !== 'prepared'
			) {
				this.log.delete(id);
			}
		});
	}
}
