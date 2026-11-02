import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	disposeSpool,
	compact,
	formatList,
	formatPayload,
	readResult,
} from '../../../src/core/response-formatter.js';

afterAll(() => disposeSpool());

test.each([4, 4095, 65535, 65536])(
	'reconstructs a large Unicode result using bounded %i-byte pages',
	(limit) => {
		const value = { manuscript: 'Café — 東京 🌙\n'.repeat(600) };
		const reference = result(formatPayload(value)) as { _ref: string };
		let offset: number | null = 0;
		let recovered = '';
		do {
			const page = readResult(reference._ref, offset, limit);
			expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(limit);
			expect(page.text).not.toContain('\ufffd');
			recovered += page.text;
			offset = page.nextOffset;
		} while (offset !== null);
		expect(JSON.parse(recovered)).toEqual(value);
	}
);

test('rejects traversal, foreign results, invalid byte boundaries and allocation sizes', () => {
	const reference = result(formatPayload('🌙'.repeat(2500))) as { _ref: string };
	for (const id of ['../private', '00000000-0000-4000-8000-000000000000'])
		expect(() => readResult(id)).toThrow(/identifier|not found/);
	for (const limit of [3, 65537, Infinity, 4.5])
		expect(() => readResult(reference._ref, 0, limit)).toThrow(/limit/);
	for (const offset of [-1, 2, Number.MAX_SAFE_INTEGER + 1])
		expect(() => readResult(reference._ref, offset)).toThrow(/offset/);
});

test('expired result identifiers cannot disclose prior content', () => {
	const reference = result(formatPayload('private'.repeat(1000))) as { _ref: string };
	const now = Date.now();
	const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 3600001);
	try {
		expect(() => readResult(reference._ref)).toThrow(/expired/);
	} finally {
		clock.mockRestore();
	}
});

function result(text: string): Record<string, unknown> | unknown[] | string {
	const parsed = JSON.parse(text);
	return parsed;
}

test('empty and hostile-shaped payloads remain valid JSON without modifying prototypes', () => {
	for (const value of [undefined, null]) expect(compact(value)).toBe('null');
	expect(compact({})).toBe('{}');
	const data = JSON.parse(
		'{"__proto__":{"admin":true},"zero":0,"empty":"","false":false,"nil":null}'
	);
	const parsed = JSON.parse(compact(data));
	expect(parsed).toEqual(data);
	expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true);
	expect(parsed.admin).toBeUndefined();
});

test('preserves unavailable metrics, tuple positions, empty metadata and standard date serialization', () => {
	const data = {
		readability: null,
		metadata: {},
		missing: undefined,
		series: [null, {}, [], 'scene', undefined, 0, false],
		createdAt: new Date('2026-10-31T00:00:00.000Z'),
	};
	expect(JSON.parse(compact(data))).toEqual({
		readability: null,
		metadata: {},
		series: [null, {}, [], 'scene', null, 0, false],
		createdAt: '2026-10-31T00:00:00.000Z',
	});
	expect(data.series).toHaveLength(7);
});

test.each(['payload', 'list'])(
	'retains the same semantics after %s spooling and reconstruction',
	(kind) => {
		const entries = [null, {}, { score: null, quote: '🌙'.repeat(2200) }, [], false];
		const value = kind === 'list' ? entries : { entries, unavailable: null, metadata: {} };
		const reference = result(kind === 'list' ? formatList(entries) : formatPayload(value)) as {
			_ref: string;
		};
		let offset: number | null = 0;
		let text = '';
		do {
			const page = readResult(reference._ref, offset, 4096);
			text += page.text;
			offset = page.nextOffset;
		} while (offset !== null);
		expect(JSON.parse(text)).toEqual(value);
	}
);

test('keeps list references bounded even when their first entries contain large Unicode findings', () => {
	const entries = ['🌙'.repeat(20000), { evidence: '東京'.repeat(10000) }, null];
	const text = formatList(entries);
	expect(Buffer.byteLength(text)).toBeLessThan(2048);
	const reference = result(text) as { _ref: string };
	let offset: number | null = 0,
		recovered = '';
	do {
		const page = readResult(reference._ref, offset);
		recovered += page.text;
		offset = page.nextOffset;
	} while (offset !== null);
	expect(JSON.parse(recovered)).toEqual(entries);
});

describe.each([
	{
		name: 'payload',
		format: (length: number, label?: string) => formatPayload('x'.repeat(length - 2), label),
	},
	{
		name: 'list',
		format: (length: number, label?: string) => formatList(['x'.repeat(length - 4)], label),
	},
])('$name spooling', ({ name, format }) => {
	test.each([3999, 4000, 4001])(
		'handles %i serialized characters at the spill boundary',
		(length) => {
			const text = format(length);
			const parsed = result(text);
			if (length <= 4000) expect(text).toHaveLength(length);
			else {
				const reference = parsed as { _ref: string };
				expect(reference).not.toHaveProperty('_file');
				expect(reference._ref).toMatch(/^[a-f0-9-]{36}$/);
				const stored = readResult(reference._ref, 0, 65536).text;
				expect(stored).toHaveLength(length);
				expect(JSON.parse(stored)).toEqual(
					name === 'list' ? ['x'.repeat(length - 4)] : 'x'.repeat(length - 2)
				);
			}
		}
	);

	test.each([63, 64, 65])('bounds a label of length %i', (length) => {
		if (length > 64) expect(() => format(4001, 'a'.repeat(length))).toThrow(/1–64/);
		else expect(result(format(4001, 'a'.repeat(length)))).toHaveProperty('_ref');
	});

	test.each(['../escape', '/absolute', 'unsafe\\path'])(
		'rejects path-shaped labels: %s',
		(label) => {
			expect(() => format(4001, label)).toThrow(/Result label/);
		}
	);
});

test('restart cleanup reclaims expired dead owners while preserving live, fresh and unidentified directories', () => {
	const os = require('node:os') as typeof import('node:os');
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-ownership-test-'));
	// Whole seconds avoid filesystem timestamp rounding across the exact expiry boundary.
	const now = Math.floor(Date.now() / 1000) * 1000;
	const locations = new Map<string, string>();
	for (const [label, pid, age] of [
		['dead00', 4242, 3600001],
		['live00', process.pid, 3600001],
		['fresh0', 4242, 3599999],
		['limit0', 4242, 3600000],
		['other0', undefined, 3600001],
	] as const) {
		const name = `scrivener-mcp-spool-${label}`;
		const dir = path.join(root, name);
		fs.mkdirSync(dir, { mode: 0o700 });
		fs.writeFileSync(path.join(dir, 'result.json'), 'Private fixture');
		if (pid)
			fs.writeFileSync(
				path.join(dir, '.owner.json'),
				JSON.stringify({ version: 1, pid, host: os.hostname(), directory: name })
			);
		fs.utimesSync(dir, new Date(now - age), new Date(now - age));
		locations.set(label, dir);
	}
	const temporary = jest.spyOn(os, 'tmpdir').mockReturnValue(root);
	const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
	const kill = jest.spyOn(process, 'kill').mockImplementation((pid) => {
		if (pid === 4242) throw Object.assign(new Error('No process'), { code: 'ESRCH' });
		return true;
	});
	try {
		jest.isolateModules(() => {
			const formatter =
				require('../../../src/core/response-formatter.js') as typeof import('../../../src/core/response-formatter.js');
			const reference = JSON.parse(formatter.formatPayload('x'.repeat(5000)));
			expect(fs.existsSync(locations.get('dead00')!)).toBe(false);
			for (const label of ['live00', 'fresh0', 'limit0', 'other0'])
				expect(
					fs.readFileSync(path.join(locations.get(label)!, 'result.json'), 'utf8')
				).toBe('Private fixture');
			expect(fs.existsSync(path.join(locations.get('other0')!, '.owner.json'))).toBe(false);
			formatter.disposeSpool();
			formatter.disposeSpool();
			expect(
				fs
					.readdirSync(root)
					.filter(
						(name) =>
							![...locations.values()].some((dir) => path.basename(dir) === name)
					)
			).toEqual([]);
			expect(() => formatter.readResult(reference._ref)).toThrow(/expired/);
		});
	} finally {
		kill.mockRestore();
		clock.mockRestore();
		temporary.mockRestore();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('keeps spool paths private while retaining restrictive filesystem modes', () => {
	const write = jest.spyOn(require('fs') as typeof import('node:fs'), 'writeFileSync');
	try {
		const response = formatPayload('private fixture'.repeat(500));
		const reference = JSON.parse(response);
		expect(reference).not.toHaveProperty('_file');
		const file = write.mock.calls
			.map(([file]) => String(file))
			.find((file) => file.endsWith(`-${reference._ref}.json`))!;
		expect(file).toBeDefined();
		expect(response).not.toContain(file);
		expect(response).not.toContain(path.dirname(file));
		if (process.platform !== 'win32') {
			expect(fs.statSync(file).mode & 0o777).toBe(0o600);
			expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
		}
	} finally {
		write.mockRestore();
	}
});
