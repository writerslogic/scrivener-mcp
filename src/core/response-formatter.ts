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
const SPOOL_DIR = path.join(os.tmpdir(), 'scrivener-mcp-spool');

function ensureSpoolDir(): void {
	if (!fs.existsSync(SPOOL_DIR)) {
		fs.mkdirSync(SPOOL_DIR, { recursive: true });
	}
}

/**
 * Recursively strip null, undefined, and empty-string values from an object.
 */
function stripEmpty(obj: unknown): unknown {
	if (obj === null || obj === undefined) return undefined;
	if (Array.isArray(obj)) return obj.map(stripEmpty).filter((v) => v !== undefined);
	if (typeof obj === 'object') {
		const cleaned: Record<string, unknown> = {};
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
	return JSON.stringify(stripEmpty(data));
}

/**
 * Format a data payload for MCP response. If the payload exceeds the threshold,
 * spill to disk and return a tracker reference instead.
 */
export function formatPayload(data: unknown, label?: string): string {
	const json = compact(data);
	if (json.length <= PAYLOAD_THRESHOLD) return json;

	ensureSpoolDir();
	const id = crypto.randomUUID().slice(0, 8);
	const filename = `${label || 'result'}-${id}.json`;
	const filepath = path.join(SPOOL_DIR, filename);
	fs.writeFileSync(filepath, json);

	return compact({
		_ref: id,
		_file: filepath,
		_size: json.length,
		_preview: json.slice(0, 200),
		_hint: `Full result written to ${filepath}. Use read_file or fs to access.`,
	});
}

/**
 * Format a list/array result with automatic spill for large result sets.
 */
export function formatList(items: unknown[], label?: string): string {
	const json = compact(items);
	if (json.length <= PAYLOAD_THRESHOLD) return json;

	ensureSpoolDir();
	const id = crypto.randomUUID().slice(0, 8);
	const filename = `${label || 'list'}-${id}.json`;
	const filepath = path.join(SPOOL_DIR, filename);
	fs.writeFileSync(filepath, json);

	return compact({
		_ref: id,
		_file: filepath,
		_count: items.length,
		_preview: items.slice(0, 3),
		_hint: `${items.length} items. Full list at ${filepath}.`,
	});
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
	if (message.length > 200) message = message.slice(0, 197) + '...';

	const prefix = operation ? `${operation}: ` : '';
	return `${prefix}${message.trim()}`;
}

/**
 * Clean up old spool files (older than 1 hour).
 */
export function cleanupSpool(): void {
	if (!fs.existsSync(SPOOL_DIR)) return;
	const cutoff = Date.now() - 3600000;
	for (const file of fs.readdirSync(SPOOL_DIR)) {
		const filepath = path.join(SPOOL_DIR, file);
		try {
			const stat = fs.statSync(filepath);
			if (stat.mtimeMs < cutoff) fs.unlinkSync(filepath);
		} catch {
			// ignore cleanup errors
		}
	}
}
