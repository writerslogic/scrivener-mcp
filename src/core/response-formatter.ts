/**
 * Token-optimized response formatting for MCP tool outputs.
 *
 * - Strips null/undefined fields
 * - Minifies JSON (no indentation)
 * - Large payloads spill to disk, returning a tracker ID
 * - Error outputs masked to short actionable messages
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const PAYLOAD_THRESHOLD = 4000; // chars before spilling to disk
let spoolDir: string | undefined;
const MAX_SPOOL_BYTES = 64 * 1024 * 1024;
const spoolEntries = new Map<string, { filepath: string; bytes: number; createdAt: number }>();

function getSpoolDir(): string {
	if (!spoolDir) {
		spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrivener-mcp-spool-'));
		fs.chmodSync(spoolDir, 0o700);
	}
	return spoolDir;
}

/**
 * Recursively strip null, undefined, and empty-string values from an object.
 */
function stripEmpty(obj: unknown): unknown {
	if (obj === null || obj === undefined) return undefined;
	if (Array.isArray(obj)) return obj.map(stripEmpty).filter((v) => v !== undefined);
	if (typeof obj === 'object') {
		const cleaned: Record<string, unknown> = Object.create(null);
		for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
			const stripped = stripEmpty(v);
			if (stripped !== undefined) cleaned[k] = stripped;
		}
		return Object.keys(cleaned).length > 0 ? cleaned : undefined;
	}
	return obj;
}

/**
 * Compact JSON serialization: no indentation, nulls stripped.
 */
export function compact(data: unknown): string {
	return JSON.stringify(stripEmpty(data)) ?? 'null';
}

function spool(json: string, label: string): { id: string; filepath: string } {
	if (typeof label !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(label))
		throw new Error('Result label must contain 1–64 letters, digits, underscores or hyphens');
	cleanupSpool();
	const bytes = Buffer.byteLength(json);
	if (bytes > MAX_SPOOL_BYTES) throw new Error('Result exceeds the 64 MiB retrieval limit');
	let totalBytes = [...spoolEntries.values()].reduce((total, entry) => total + entry.bytes, 0);
	for (const [oldId, entry] of spoolEntries) {
		if (totalBytes + bytes <= MAX_SPOOL_BYTES && spoolEntries.size < 256) break;
		fs.rmSync(entry.filepath, { force: true });
		spoolEntries.delete(oldId);
		totalBytes -= entry.bytes;
	}
	const id = crypto.randomUUID();
	const filepath = path.join(getSpoolDir(), `${label}-${id}.json`);
	fs.writeFileSync(filepath, json, { flag: 'wx', mode: 0o600 });
	spoolEntries.set(id, { filepath, bytes, createdAt: Date.now() });
	return { id, filepath };
}

/**
 * Format a data payload for MCP response. If the payload exceeds the threshold,
 * spill to disk and return a tracker reference instead.
 */
export function formatPayload(data: unknown, label?: string): string {
	const json = compact(data);
	if (json.length <= PAYLOAD_THRESHOLD) return json;

	const { id, filepath } = spool(json, label ?? 'result');

	return compact({
		_ref: id,
		_file: filepath,
		_size: json.length,
		_preview: json.slice(0, 200),
		_hint: 'Use read_result with resultId equal to _ref to retrieve bounded chunks. Results expire after one hour or when the server restarts.',
	});
}

export function formatList(items: unknown[], label?: string): string {
	const json = compact(items);
	if (json.length <= PAYLOAD_THRESHOLD) return json;

	const { id, filepath } = spool(json, label ?? 'list');

	return compact({
		_ref: id,
		_file: filepath,
		_size: json.length,
		_count: items.length,
		_preview: items.slice(0, 3),
		_hint: 'Use read_result with resultId equal to _ref to retrieve bounded chunks. Results expire after one hour or when the server restarts.',
	});
}

export function readResult(
	resultId: string,
	offset = 0,
	limit = 16384
): {
	resultId: string;
	text: string;
	offset: number;
	nextOffset: number | null;
	totalBytes: number;
} {
	if (
		typeof resultId !== 'string' ||
		!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(resultId)
	)
		throw new Error('Invalid result identifier');
	if (
		!Number.isSafeInteger(offset) ||
		offset < 0 ||
		!Number.isInteger(limit) ||
		limit < 4 ||
		limit > 65536
	)
		throw new Error(
			'Result offset must be a non-negative safe integer and limit must be 4–65536 bytes'
		);
	cleanupSpool();
	const entry = spoolEntries.get(resultId);
	if (!entry)
		throw new Error('Result was not found or has expired; repeat the original read operation');
	if (offset > entry.bytes) throw new Error('Result offset exceeds its byte length');
	const fd = fs.openSync(
		entry.filepath,
		fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
	);
	try {
		const saved = fs.fstatSync(fd);
		if (
			!saved.isFile() ||
			saved.size !== entry.bytes ||
			fs.lstatSync(entry.filepath).isSymbolicLink()
		)
			throw new Error('Stored result changed; repeat the original read operation');
		const buffer = Buffer.alloc(Math.min(limit + 1, entry.bytes - offset));
		let count = 0;
		while (count < buffer.length) {
			const bytesRead = fs.readSync(fd, buffer, count, buffer.length - count, offset + count);
			if (!bytesRead) throw new Error('Stored result changed during retrieval');
			count += bytesRead;
		}
		if (buffer.length && (buffer[0] & 0xc0) === 0x80)
			throw new Error('Result offset must be a UTF-8 character boundary; use nextOffset');
		let end = Math.min(limit, count);
		while (end < count && (buffer[end] & 0xc0) === 0x80) end--;
		const next = offset + end;
		return {
			resultId,
			text: buffer.toString('utf8', 0, end),
			offset,
			nextOffset: next < entry.bytes ? next : null,
			totalBytes: entry.bytes,
		};
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Mask an error into a short, actionable message.
 * Strips stack traces, database tracebacks, and internal paths.
 */
export function formatError(error: unknown, operation?: string): string {
	let message: string;

	if (error instanceof Error) {
		message = error.message;
	} else if (typeof error === 'string') {
		message = error;
	} else {
		message = 'Operation failed';
	}

	// Strip file paths
	message = message.replace(/\/[^\s:]+\.(ts|js|mjs):\d+/g, '');
	// Strip stack traces
	message = message.replace(/\s+at\s+.+/g, '');
	// Strip SQL/Cypher query dumps
	message = message.replace(
		/(?:SELECT|INSERT|UPDATE|DELETE|MATCH|MERGE|CREATE)\s.{50,}/gi,
		'[query]'
	);
	// Truncate
	if (message.length > 200) message = `${message.slice(0, 197)}...`;

	// Translate internal service names to writer-friendly language
	const translations: [RegExp, string][] = [
		[/\bHolographicMemorySystem\b|\bHMS\b/g, 'semantic search'],
		[/\bhhmSystem\b|\bhhm\b/gi, 'semantic search'],
		[/\bNeo4j\b/gi, 'character graph database'],
		[/\bBullMQ\b/gi, 'background job queue'],
		[/\bIORedis\b|\bRedis\b/gi, 'background job queue'],
		[/\bLangChain\b/gi, 'AI writing assistant'],
		[/\bHandlerContext\b/g, 'server context'],
		[/\bOpenAI\b/g, 'AI service'],
	];
	for (const [pattern, replacement] of translations) {
		message = message.replace(pattern, replacement);
	}

	const prefix = operation ? `${operation}: ` : '';
	return `${prefix}${message.trim()}`;
}

/**
 * Clean up old spool files (older than 1 hour).
 */
export function cleanupSpool(): void {
	const cutoff = Date.now() - 3600000;
	for (const [id, entry] of spoolEntries) {
		if (entry.createdAt >= cutoff) continue;
		fs.rmSync(entry.filepath, { force: true });
		spoolEntries.delete(id);
	}
}
