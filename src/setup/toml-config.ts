import { parse, stringify, TomlDate } from 'smol-toml';

// Edits only the scrivener server table in a TOML client configuration (Grok Build).
// The rest of the file is never re-serialized: comments, ordering and formatting stay
// byte-for-byte, and every result is re-parsed to prove nothing else changed.

const ROOT = 'mcp_servers';

export type TomlInspection =
	{ ok: true; current: unknown; present: boolean } | { ok: false; reason: string };

export type TomlEdit = { ok: true; text: string; changed: boolean } | { ok: false; reason: string };

type Table = Record<string, unknown>;

const isTable = (value: unknown): value is Table =>
	value !== null &&
	typeof value === 'object' &&
	!Array.isArray(value) &&
	!(value instanceof Date);

function parseToml(
	text: string | null
): { ok: true; value: Table } | { ok: false; reason: string } {
	if (text === null || text.trim() === '') return { ok: true, value: {} };
	try {
		return { ok: true, value: parse(text) as Table };
	} catch {
		return { ok: false, reason: 'invalid TOML syntax' };
	}
}

function serverTable(root: Table): { ok: true; map: Table } | { ok: false; reason: string } {
	const map = root[ROOT];
	if (map === undefined) return { ok: true, map: {} };
	return isTable(map) ? { ok: true, map } : { ok: false, reason: `"${ROOT}" is not a table` };
}

/** Order-insensitive, type-tagged form so values compare structurally. */
function canonical(value: unknown): unknown {
	if (value instanceof TomlDate) return { $date: value.toISOString() };
	if (value instanceof Date) return { $date: value.toISOString() };
	if (typeof value === 'bigint') return { $int: value.toString() };
	if (typeof value === 'number') return { $num: Object.is(value, -0) ? '-0' : String(value) };
	if (Array.isArray(value)) return value.map(canonical);
	if (isTable(value))
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonical(value[key])])
		);
	return value;
}

export function sameValue(a: unknown, b: unknown): boolean {
	return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** The document with the scrivener server (and an emptied server table) taken out. */
function withoutServer(root: Table, name: string): Table {
	const rest = { ...root };
	const map = rest[ROOT];
	if (isTable(map)) {
		const { [name]: _removed, ...others } = map;
		if (Object.keys(others).length) rest[ROOT] = others;
		else delete rest[ROOT];
	}
	return rest;
}

// Settings Grok Build or the user own: `grok mcp enable|disable` writes `enabled` into the table.
const USER_OWNED = ['enabled', 'startup_timeout_sec', 'tool_timeout_sec'];

/** The desired table plus any user-owned settings already on the current one. */
export function withUserSettings(current: unknown, desired: Table): Table {
	if (!isTable(current)) return desired;
	const kept = USER_OWNED.filter((key) => key in current && !(key in desired));
	return kept.length
		? { ...desired, ...Object.fromEntries(kept.map((key) => [key, current[key]])) }
		: desired;
}

export function inspectToml(text: string | null, name: string): TomlInspection {
	const parsed = parseToml(text);
	if (!parsed.ok) return parsed;
	const table = serverTable(parsed.value);
	if (!table.ok) return table;
	return { ok: true, present: name in table.map, current: table.map[name] };
}

/** Key path of a table header line, or null when the line is not a header. */
function headerPath(line: string): string[] | null {
	if (!/^\s*\[/.test(line)) return null;
	let node: unknown;
	try {
		node = parse(line);
	} catch {
		return null;
	}
	const path: string[] = [];
	for (;;) {
		if (Array.isArray(node) && node.length === 1) node = node[0];
		if (!isTable(node)) return null;
		const keys = Object.keys(node);
		if (keys.length === 0) return path.length ? path : null;
		if (keys.length !== 1) return null;
		path.push(keys[0]);
		node = node[keys[0]];
	}
}

/** Remove every table whose header is mcp_servers.<name> or one of its subtables. */
function stripServer(lines: string[], name: string): { lines: string[]; at: number } {
	const kept: string[] = [];
	let at = -1;
	let inside = false;
	for (const line of lines) {
		const path = headerPath(line);
		if (path) {
			inside = path.length >= 2 && path[0] === ROOT && path[1] === name;
			if (inside && at < 0) at = kept.length;
		}
		if (!inside) kept.push(line);
	}
	return { lines: kept, at };
}

const manualFix = (name: string): string =>
	`the "${name}" server is defined in a form setup cannot edit safely (inline table or dotted keys); run \`grok mcp remove ${name}\` or edit the file by hand`;

function verify(
	original: Table,
	text: string,
	name: string,
	desired: Table | undefined
): string | null {
	let result: Table;
	try {
		result = parse(text) as Table;
	} catch {
		return manualFix(name);
	}
	if (!sameValue(withoutServer(result, name), withoutServer(original, name)))
		return manualFix(name);
	const map = result[ROOT];
	const current = isTable(map) ? map[name] : undefined;
	if (desired === undefined ? current !== undefined : !sameValue(current, desired))
		return manualFix(name);
	return null;
}

function splitLines(text: string): { lines: string[]; eol: string } {
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const body = text.endsWith(eol) ? text.slice(0, -eol.length) : text;
	return { lines: body === '' ? [] : body.split(eol), eol };
}

function trimBlankEdges(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1].trim() === '') end--;
	return lines.slice(0, end);
}

export function applyToml(text: string | null, name: string, entry: Table): TomlEdit {
	const parsed = parseToml(text);
	if (!parsed.ok) return parsed;
	const table = serverTable(parsed.value);
	if (!table.ok) return table;
	const desired = withUserSettings(table.map[name], entry);
	if (name in table.map && sameValue(table.map[name], desired))
		return { ok: true, text: text ?? '', changed: false };

	const { lines, eol } = splitLines(text ?? '');
	const block = splitLines(stringify({ [ROOT]: { [name]: desired } })).lines;
	const stripped = stripServer(lines, name);
	let out: string[];
	if (stripped.at >= 0) {
		const before = stripped.lines.slice(0, stripped.at);
		const after = stripped.lines.slice(stripped.at);
		out = [...before, ...trimBlankEdges(block), ...(after.length ? [''] : []), ...after];
	} else {
		const head = trimBlankEdges(stripped.lines);
		out = [...head, ...(head.length ? [''] : []), ...trimBlankEdges(block)];
	}
	const next = `${out.join(eol)}${eol}`;
	const failure = verify(parsed.value, next, name, desired);
	return failure ? { ok: false, reason: failure } : { ok: true, text: next, changed: true };
}

export function removeToml(text: string | null, name: string): TomlEdit {
	const parsed = parseToml(text);
	if (!parsed.ok) return parsed;
	const table = serverTable(parsed.value);
	if (!table.ok) return table;
	if (!(name in table.map)) return { ok: true, text: text ?? '', changed: false };

	const { lines, eol } = splitLines(text ?? '');
	const out = trimBlankEdges(stripServer(lines, name).lines);
	const next = out.length ? `${out.join(eol)}${eol}` : '';
	const failure = verify(parsed.value, next, name, undefined);
	return failure ? { ok: false, reason: failure } : { ok: true, text: next, changed: true };
}
