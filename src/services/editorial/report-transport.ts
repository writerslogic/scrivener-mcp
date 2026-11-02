import { RESULT_METADATA_BYTE_RESERVE } from '../../core/response-formatter.js';
import { createHash } from 'node:crypto';
import type { HandlerResult } from '../../handlers/types.js';

export const REPORT_PAGE_BYTES = 1024 * 1024;
const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const CACHE_BYTES = 32 * 1024 * 1024;

class CachedReport {
	readonly data: Buffer;
	readonly length: number;
	private readonly offsets = [{ unit: 0, byte: 0 }];

	constructor(serialized: string) {
		this.data = Buffer.from(serialized);
		this.length = serialized.length;
		for (let unit = 0, byte = 0; unit < serialized.length;) {
			let end = Math.min(unit + 4096, serialized.length);
			if (/[\uDC00-\uDFFF]/.test(serialized[end] ?? '')) end--;
			byte += Buffer.byteLength(serialized.slice(unit, end));
			this.offsets.push({ unit: end, byte });
			unit = end;
		}
	}

	private byteOffset(unit: number, roundDown: boolean): number {
		let low = 0,
			high = this.offsets.length - 1;
		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			if (this.offsets[mid].unit <= unit) low = mid;
			else high = mid - 1;
		}
		const point = this.offsets[low];
		const text = this.data.toString(
			'utf8',
			point.byte,
			this.offsets[low + 1]?.byte ?? this.data.length
		);
		let relative = unit - point.unit;
		if (/[\uDC00-\uDFFF]/.test(text[relative] ?? '')) {
			if (!roundDown) throw new Error('pageCursor splits a Unicode character');
			relative--;
		}
		return point.byte + Buffer.byteLength(text.slice(0, relative));
	}

	slice(start: number, units: number): string {
		if (start > this.length) throw new Error('pageCursor is outside the report');
		return this.data.toString(
			'utf8',
			this.byteOffset(start, false),
			this.byteOffset(Math.min(this.length, start + units), true)
		);
	}
}

function response(action: string, result: object): HandlerResult {
	const structuredContent = { action, result };
	return {
		content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
		structuredContent,
	};
}

export function reportPageOptions(args: Record<string, unknown>) {
	const limit = args.pageByteLimit === undefined ? REPORT_PAGE_BYTES : args.pageByteLimit;
	if (
		typeof limit !== 'number' ||
		!Number.isSafeInteger(limit) ||
		limit < 16384 ||
		limit > 4 * 1024 * 1024
	)
		throw new Error('pageByteLimit must be an integer from 16384 to 4194304');
	const cursor = args.pageCursor === undefined ? '0' : args.pageCursor;
	if (
		typeof cursor !== 'string' ||
		!/^(0|[1-9][0-9]*)$/.test(cursor) ||
		!Number.isSafeInteger(Number(cursor))
	)
		throw new Error('pageCursor must be a non-negative integer string');
	const start = Number(cursor);
	return { limit, start };
}

export class ReportTransport {
	private readonly reports = new Map<string, CachedReport>();
	private bytes = 0;
	private pageCosts = new Uint32Array(0);

	clear(): void {
		this.reports.clear();
		this.bytes = 0;
		this.pageCosts = new Uint32Array(0);
	}

	page(action: string, args: Record<string, unknown>, value?: object): HandlerResult {
		return this.pageSerialized(
			action,
			args,
			value === undefined ? undefined : JSON.stringify(value)
		);
	}

	pageSerialized(
		action: string,
		args: Record<string, unknown>,
		serialized?: string
	): HandlerResult {
		const { limit, start } = reportPageOptions(args);
		const payloadLimit = limit - RESULT_METADATA_BYTE_RESERVE;
		let reportId: string;
		let report: CachedReport;
		if (serialized !== undefined) {
			if (start !== 0 || args.reportId !== undefined)
				throw new Error('A new report must start at cursor 0 without reportId');
			const bytes = Buffer.byteLength(serialized);
			if (bytes > MAX_REPORT_BYTES) throw new Error('Narrative report exceeds 16 MiB');
			reportId = createHash('sha256').update(action).update(serialized).digest('hex');
			if (!this.reports.has(reportId)) {
				while (this.bytes + bytes > CACHE_BYTES || this.reports.size >= 32) {
					const oldest = this.reports.keys().next().value!;
					this.bytes -= this.reports.get(oldest)!.data.length;
					this.reports.delete(oldest);
				}
				this.reports.set(reportId, new CachedReport(serialized));
				this.bytes += bytes;
			}
			report = this.reports.get(reportId)!;
		} else {
			if (typeof args.reportId !== 'string' || !/^[a-f0-9]{64}$/.test(args.reportId))
				throw new Error('A continuation requires reportId');
			reportId = args.reportId;
			const saved = this.reports.get(reportId);
			if (saved === undefined) throw new Error('Report expired; start a new analysis');
			report = saved;
		}
		const fragment = report.slice(start, Math.floor(payloadLimit / 2));
		if (start === 0 && report.length * 2 < payloadLimit) {
			const complete = response(action, { ...JSON.parse(fragment), reportId });
			if (Buffer.byteLength(JSON.stringify(complete)) <= payloadLimit) return complete;
		}
		const makePage = (end: number, data = fragment.slice(0, end - start)) =>
			response(action, {
				reportId,
				encoding: 'json-fragment',
				data,
				pagination: {
					byteLimit: limit,
					start,
					end,
					total: report.length,
					nextCursor: end < report.length ? String(end) : null,
				},
			});
		let low = start,
			high = start + fragment.length;
		if (this.pageCosts.length <= fragment.length)
			this.pageCosts = new Uint32Array(fragment.length + 1);
		const costs = this.pageCosts;
		// JSON.stringify has escaped controls and lone surrogates. Count the fragment in
		// structuredContent and again inside content.text without repeatedly serializing it.
		for (let index = start; index < high; index++) {
			const code = fragment.charCodeAt(index - start);
			const bytes =
				code === 34 || code === 92
					? 6
					: code < 128
						? 2
						: code < 2048 || (code >= 0xd800 && code <= 0xdfff)
							? 4
							: 6;
			costs[index - start + 1] = costs[index - start] + bytes;
		}
		const pageBytes = (end: number) =>
			Buffer.byteLength(JSON.stringify(makePage(end, ''))) + costs[end - start];
		// The final null cursor can be shorter than a preceding numeric cursor.
		if (high === report.length && pageBytes(high) <= payloadLimit) return makePage(high);
		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			if (pageBytes(mid) <= payloadLimit) low = mid;
			else high = mid - 1;
		}
		if (low < report.length && /[\uDC00-\uDFFF]/.test(fragment[low - start] ?? '')) low--;
		if (low === start && start < report.length)
			throw new Error('Report page envelope exceeds pageByteLimit');
		return makePage(low);
	}
}
