import type { PersistentStore } from './persistent-store.js';

const RESERVATIONS = 'mutation-reservations';
const META = 'mutation-meta';
const USAGE = 'retention-usage-v1';
// A 512-unit snapshot title can require 3072 JSON bytes; also allow identities, dates and final state.
export const MUTATION_METADATA_RESERVE = 8192;

export interface MutationRetentionLimits {
	maxRecords: number;
	maxBytes: number;
}

interface Reservation {
	bytes: number;
	records: number;
	undoBytes?: number;
	undoId?: string;
}

interface Usage {
	bytes: number;
	records: number;
	entries: number;
}

export function mutationRetentionLimits(): MutationRetentionLimits {
	const read = (key: string, fallback: number): number => {
		const raw = process.env[key];
		if (raw === undefined) return fallback;
		if (!/^[1-9][0-9]{0,15}$/.test(raw))
			throw new Error(`${key} must be a positive safe integer`);
		const value = Number(raw);
		if (!Number.isSafeInteger(value)) throw new Error(`${key} must be a positive safe integer`);
		return value;
	};
	return {
		maxRecords: read('SCRIVENER_MUTATION_MAX_RECORDS', 20_000),
		maxBytes: read('SCRIVENER_MUTATION_MAX_BYTES', 1024 * 1024 * 1024),
	};
}

export class MutationRetention {
	constructor(
		private readonly store: PersistentStore,
		private readonly limits: MutationRetentionLimits,
		private readonly describe: (
			id: string,
			bytes: number
		) => { bytes: number; undoBytes?: number }
	) {
		if (
			![limits.maxRecords, limits.maxBytes].every(
				(value) => Number.isSafeInteger(value) && value > 0
			)
		)
			throw new Error('Mutation retention limits must be positive safe integers');
	}

	private reservation(id: string): Reservation | undefined {
		const value = this.store.get<Reservation>(RESERVATIONS, id);
		if (
			value !== undefined &&
			(!value ||
				typeof value !== 'object' ||
				!Number.isSafeInteger(value.bytes) ||
				value.bytes < 1 ||
				![1, 2].includes(value.records) ||
				(value.undoBytes !== undefined &&
					(!Number.isSafeInteger(value.undoBytes) ||
						value.undoBytes < 1 ||
						value.undoBytes >= value.bytes)) ||
				(value.undoBytes !== undefined) !== (value.records === 2) ||
				(value.undoBytes !== undefined && value.undoId !== undefined) ||
				(value.undoId !== undefined &&
					(typeof value.undoId !== 'string' ||
						!/^[A-Za-z0-9_-]{1,128}$/.test(value.undoId))))
		)
			throw new Error(
				'Malformed mutation retention reservation; manual inspection is required'
			);
		return value;
	}

	initialize(): void {
		this.store.transaction(() => {
			const usage: Usage = { bytes: 0, records: 0, entries: 0 };
			let after: string | undefined;
			do {
				const page = this.store.pageEntries('mutations', { after, limit: 100 });
				for (const entry of page.items) {
					let reservation = this.reservation(entry.id);
					if (!reservation) {
						const description = this.describe(entry.id, entry.bytes);
						reservation = {
							...description,
							bytes: description.bytes + (description.undoBytes ?? 0),
							records: description.undoBytes === undefined ? 1 : 2,
						};
						this.store.put(RESERVATIONS, entry.id, reservation);
					} else if (entry.bytes > reservation.bytes - (reservation.undoBytes ?? 0)) {
						// Earlier binaries can finish an existing receipt without updating this ledger.
						reservation.bytes =
							entry.bytes + (reservation.undoBytes ?? 0) + MUTATION_METADATA_RESERVE;
						this.store.put(RESERVATIONS, entry.id, reservation);
					}
					usage.bytes += reservation.bytes;
					usage.records += reservation.records;
					usage.entries++;
				}
				after = page.nextCursor ?? undefined;
			} while (after !== undefined);
			if (!Number.isSafeInteger(usage.bytes) || !Number.isSafeInteger(usage.records))
				throw new Error('Mutation retention accounting exceeds safe integer range');
			this.store.put(META, USAGE, usage);
		});
	}

	private usage(): Usage {
		let usage = this.store.get<Usage>(META, USAGE);
		if (
			!usage ||
			typeof usage !== 'object' ||
			![usage.bytes, usage.records, usage.entries].every(
				(value) => Number.isSafeInteger(value) && value >= 0
			)
		)
			throw new Error('Malformed mutation retention accounting; reopen the project');
		if (this.store.count('mutations') !== usage.entries) {
			this.initialize();
			usage = this.store.get<Usage>(META, USAGE)!;
		}
		return usage;
	}

	reserve(id: string, bytes: number, undoBytes?: number, undoOf?: string): void {
		const usage = this.usage();
		if (this.reservation(id))
			throw new Error('Mutation reservation already exists without its receipt');
		if (undoOf) {
			const original = this.reservation(undoOf);
			if (original?.undoBytes !== undefined && bytes <= original.undoBytes) {
				this.store.put(RESERVATIONS, id, { bytes: original.undoBytes, records: 1 });
				this.store.put(RESERVATIONS, undoOf, {
					bytes: original.bytes - original.undoBytes,
					records: 1,
					undoId: id,
				});
				this.store.put(META, USAGE, { ...usage, entries: usage.entries + 1 });
				return;
			}
		}
		const reservation: Reservation = {
			bytes: bytes + (undoBytes ?? 0),
			records: undoBytes === undefined ? 1 : 2,
			...(undoBytes === undefined ? {} : { undoBytes }),
		};
		if (
			reservation.records > this.limits.maxRecords - usage.records ||
			reservation.bytes > this.limits.maxBytes - usage.bytes
		)
			throw new Error(
				`Mutation history capacity reached (${usage.records}/${this.limits.maxRecords} reserved records, ${usage.bytes}/${this.limits.maxBytes} reserved bytes). No new mutation was staged. Existing replay, recovery and one reserved inverse undo remain available. Back up the project and increase SCRIVENER_MUTATION_MAX_RECORDS or SCRIVENER_MUTATION_MAX_BYTES, then reopen; do not delete recovery history.`
			);
		this.store.put(RESERVATIONS, id, reservation);
		this.store.put(META, USAGE, {
			bytes: usage.bytes + reservation.bytes,
			records: usage.records + reservation.records,
			entries: usage.entries + 1,
		});
	}

	release(id: string): void {
		const usage = this.usage();
		const reservation = this.reservation(id);
		if (!reservation) throw new Error('Missing mutation reservation during abort');
		this.store.delete(RESERVATIONS, id);
		this.store.put(META, USAGE, {
			bytes: usage.bytes - reservation.bytes,
			records: usage.records - reservation.records,
			entries: usage.entries - 1,
		});
	}
}
