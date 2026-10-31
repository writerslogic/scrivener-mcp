import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

const configRequire = createRequire(require.resolve('jest-config'));
const merge = configRequire('deepmerge') as typeof import('../../../vendor/deepmerge/index.js');

test.each([
	['null prototype', Object.create(null)],
	['null placeholder', { session: null }],
	['primitive placeholder', { session: 3 }],
	['own poison key', JSON.parse('{"__proto__":{"admin":true}}')],
])('Jest dependency rejects prototype poisoning with %s', (_name, target) => {
	const source = JSON.parse(
		'{"__proto__":{"admin":true},"session":{"__proto__":{"admin":true}},"constructor":{"prototype":{"admin":true}},"prototype":{"admin":true},"safe":1}'
	);
	const result = merge(target, source) as Record<string, unknown>;
	expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
	expect(result.admin).toBeUndefined();
	expect(result.safe).toBe(1);
	expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(false);
	expect(Object.prototype.hasOwnProperty.call(result, 'constructor')).toBe(false);
	expect(Object.prototype.hasOwnProperty.call(result, 'prototype')).toBe(false);
	const session = result.session as Record<string, unknown>;
	expect(Object.getPrototypeOf(session)).toBe(Object.prototype);
	expect(session.admin).toBeUndefined();
	expect(({} as Record<string, unknown>).admin).toBeUndefined();
});

test('patched development dependency preserves arrays, symbols and custom merge behavior', () => {
	const symbol = Symbol('fixture');
	const target = { items: [{ value: 1 }], nested: { a: 1 }, [symbol]: 'retained' };
	const result = merge(target, { items: [{ value: 2 }], nested: { b: 2 } });
	expect(result.items).toEqual([{ value: 1 }, { value: 2 }]);
	expect(result.items[0]).not.toBe(target.items[0]);
	expect(result.nested).toEqual({ a: 1, b: 2 });
	expect(result[symbol]).toBe('retained');
	expect(merge.all([{ a: 1 }, { b: 2 }])).toEqual({ a: 1, b: 2 });
	expect(
		merge({ items: [1] }, { items: [2] }, { customMerge: () => (_left, right) => right })
	).toEqual({ items: [2] });
});

test('unexpected throwing property checks fail closed', () => {
	const target = new Proxy(
		{},
		{
			has: () => {
				throw new Error('Unavailable property');
			},
		}
	);
	expect(merge(target, { admin: true })).toEqual({});
});

test('Jest glob dependency stops directory traversal after cancellation', async () => {
	const { glob } = configRequire('glob') as {
		glob(pattern: string, options: Record<string, unknown>): Promise<string[]>;
	};
	const root = await mkdtemp(join(tmpdir(), 'scrivener-glob-security-'));
	try {
		await mkdir(join(root, 'nested', 'deeper'), { recursive: true });
		await writeFile(join(root, 'nested', 'deeper', 'story.txt'), 'saved fixture');
		expect(await glob('**/*.txt', { cwd: root, posix: true })).toEqual([
			'nested/deeper/story.txt',
		]);
		const controller = new AbortController();
		let reads = 0;
		const operation = glob('**/*', {
			cwd: root,
			signal: controller.signal,
			fs: {
				...fs,
				readdir(...args: unknown[]) {
					reads++;
					controller.abort(new Error('Stop fixture traversal'));
					return Reflect.apply(fs.readdir, fs, args);
				},
			},
		});
		await expect(operation).rejects.toThrow('Stop fixture traversal');
		await setTimeout(50);
		expect(reads).toBe(1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('Jest minimatch dependency bounds repeated globstar-parent preprocessing', () => {
	const result = spawnSync(
		process.execPath,
		[
			'-e',
			`const assert = require('node:assert/strict');
const { Minimatch, minimatch } = require(process.argv[1]);
new Minimatch('**/../'.repeat(24) + 'story.txt', { optimizationLevel: 2 });
assert(minimatch('draft/東京.txt', '**/*.txt'));
assert(!minimatch('draft/東京.rtf', '**/*.txt'));`,
			configRequire.resolve('minimatch'),
		],
		{ timeout: 2000, encoding: 'utf8', maxBuffer: 8192 }
	);
	expect(result.error).toBeUndefined();
	expect(result.signal).toBeNull();
	expect(result.status).toBe(0);
});
