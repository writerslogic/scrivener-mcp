import * as fs from 'node:fs';
import * as path from 'node:path';
import { compact, formatList, formatPayload } from '../../../src/core/response-formatter.js';

const directories = new Set<string>();

afterAll(() => {
	for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
});

function result(text: string): Record<string, unknown> | unknown[] | string {
	const parsed = JSON.parse(text);
	if (parsed?._file) directories.add(path.dirname(parsed._file));
	return parsed;
}

test('empty and hostile-shaped payloads remain valid JSON without modifying prototypes', () => {
	for (const value of [undefined, null, {}]) expect(compact(value)).toBe('null');
	const data = JSON.parse(
		'{"__proto__":{"admin":true},"zero":0,"empty":"","false":false,"nil":null}'
	);
	const parsed = JSON.parse(compact(data));
	expect(parsed).toEqual(
		JSON.parse('{"__proto__":{"admin":true},"zero":0,"empty":"","false":false}')
	);
	expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true);
	expect(parsed.admin).toBeUndefined();
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
				const reference = parsed as { _file: string; _ref: string };
				expect(reference._ref).toMatch(/^[a-f0-9-]{36}$/);
				const stored = fs.readFileSync(reference._file, 'utf8');
				expect(stored).toHaveLength(length);
				expect(JSON.parse(stored)).toEqual(
					name === 'list' ? ['x'.repeat(length - 4)] : 'x'.repeat(length - 2)
				);
				if (process.platform !== 'win32')
					expect(fs.statSync(reference._file).mode & 0o777).toBe(0o600);
			}
		}
	);

	test.each([63, 64, 65])('bounds a label of length %i', (length) => {
		if (length > 64) expect(() => format(4001, 'a'.repeat(length))).toThrow(/1–64/);
		else expect(result(format(4001, 'a'.repeat(length)))).toHaveProperty('_file');
	});

	test.each(['../escape', '/absolute', 'unsafe\\path'])(
		'rejects path-shaped labels: %s',
		(label) => {
			expect(() => format(4001, label)).toThrow(/Result label/);
		}
	);
});
