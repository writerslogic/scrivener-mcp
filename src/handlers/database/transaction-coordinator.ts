import { getLogger } from '../../core/logger.js';
import { AppError, ErrorCode } from '../../utils/common.js';
import { generateScrivenerUUID } from '../../utils/scrivener-utils.js';
import type { SQLiteManager } from './sqlite-manager.js';

const logger = getLogger('database');

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

/** Two-phase-commit bookkeeping around the SQLite transaction. */
export class TransactionCoordinator {
	private readonly log: Map<string, TransactionLog> = new Map();

	constructor(private readonly getSqlite: () => SQLiteManager | null) {}

	get(transactionId: string): TransactionLog | undefined {
		return this.log.get(transactionId);
	}

	async begin(): Promise<string> {
		const transactionId = generateScrivenerUUID();

		this.log.set(transactionId, {
			id: transactionId,
			timestamp: new Date(),
			operations: [],
			status: 'in_progress',
		});

		this.getSqlite()?.beginTransaction();

		return transactionId;
	}

	async prepare(transactionId: string): Promise<boolean> {
		const txn = this.log.get(transactionId);
		if (!txn) {
			throw new AppError('Transaction not found', ErrorCode.DATABASE_ERROR);
		}

		try {
			txn.operations.forEach((op) => {
				if (op.status === 'pending') {
					op.status = 'prepared';
				}
			});

			txn.status = 'prepared';
			return true;
		} catch (_error) {
			logger.error('Transaction preparation failed', { transactionId, error: _error });
			await this.rollback(transactionId);
			return false;
		}
	}

	async commit(transactionId: string): Promise<void> {
		const txn = this.log.get(transactionId);
		if (!txn || txn.status !== 'prepared') {
			throw new AppError('Transaction not prepared', ErrorCode.DATABASE_ERROR);
		}

		try {
			this.getSqlite()?.commit();

			txn.status = 'committed';
			txn.operations.forEach((op) => (op.status = 'committed'));

			this.cleanup();
		} catch (error) {
			await this.rollback(transactionId);
			throw error;
		}
	}

	async rollback(transactionId: string): Promise<void> {
		const txn = this.log.get(transactionId);
		if (!txn) return;

		this.getSqlite()?.rollback();

		txn.status = 'rolled_back';
		txn.operations.forEach((op) => (op.status = 'rolled_back'));
	}

	/** Drop finished transactions older than the retention window. */
	private cleanup(): void {
		const now = Date.now();

		const toDelete: string[] = [];
		this.log.forEach((entry, id) => {
			const age = now - entry.timestamp.getTime();
			if (
				age >= LOG_RETENTION_MS &&
				entry.status !== 'in_progress' &&
				entry.status !== 'prepared'
			) {
				toDelete.push(id);
			}
		});

		toDelete.forEach((id) => this.log.delete(id));
	}
}
