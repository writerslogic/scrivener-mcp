import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sourceRoot = resolve(__dirname, '../../..');
const requireFromProject = createRequire(join(sourceRoot, 'package.json'));
let directory: string;
let config: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'scrivener-postinstall-'));
	config = join(
		directory,
		'home',
		'Library',
		'Application Support',
		'Claude',
		'claude_desktop_config.json'
	);
	mkdirSync(dirname(config), { recursive: true });
	mkdirSync(join(directory, 'scripts'), { recursive: true });
	mkdirSync(join(directory, 'dist/setup'), { recursive: true });
	writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
	copyFileSync(
		join(sourceRoot, 'scripts/postinstall.cjs'),
		join(directory, 'scripts/postinstall.cjs')
	);
	for (const name of ['clients', 'config-file'])
		copyFileSync(
			join(sourceRoot, `src/setup/${name}.ts`),
			join(directory, `dist/setup/${name}.ts`)
		);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function install(fault?: string, extraEnv: NodeJS.ProcessEnv = {}) {
	const args = ['--import', pathToFileURL(requireFromProject.resolve('tsx')).href];
	if (fault) {
		const preload = join(directory, 'fault.cjs');
		writeFileSync(
			preload,
			`const fs=require('node:fs'); ${fault}\nrequire('node:module').syncBuiltinESMExports();`
		);
		args.push('--require', preload);
	}
	args.push(join(directory, 'scripts/postinstall.cjs'));
	return spawnSync(process.execPath, args, {
		cwd: directory,
		encoding: 'utf8',
		timeout: 15000,
		maxBuffer: 65536,
		env: {
			PATH: process.env.PATH,
			HOME: join(directory, 'home'),
			USERPROFILE: join(directory, 'home'),
			APPDATA: join(directory, 'home'),
			TEST_CONFIG: config,
			SCRIVENER_LOCAL_ONLY: 'true',
			SCRIVENER_DISABLE_KEY_DISCOVERY: '1',
			...extraEnv,
		},
	});
}

describe('non-CI postinstall in a disposable home', () => {
	it('uses shared publication, preserves unrelated settings, creates backup and is idempotent', () => {
		const original = '{"preferences":{"keep":true},"mcpServers":{"other":{"command":"local"}}}';
		writeFileSync(config, original);
		const result = install();
		expect(result.status).toBe(0);
		expect(result.stdout).toBe('');
		expect(result.stderr).toContain('Configured for Claude Desktop');
		const current = readFileSync(config, 'utf8');
		expect(JSON.parse(current)).toEqual({
			preferences: { keep: true },
			mcpServers: {
				other: { command: 'local' },
				scrivener: { command: 'npx', args: ['scrivener-mcp'] },
			},
		});
		const backups = readdirSync(dirname(config)).filter((name) =>
			name.includes('.scrivener-backup-')
		);
		expect(backups).toHaveLength(1);
		expect(readFileSync(join(dirname(config), backups[0]), 'utf8')).toBe(original);
		expect(install().status).toBe(0);
		expect(readFileSync(config, 'utf8')).toBe(current);
	});

	it.each(['{broken', '[]', '{"mcpServers":[]}'])(
		'leaves invalid configuration untouched: %s',
		(original) => {
			writeFileSync(config, original);
			const result = install();
			expect(result.status).toBe(0);
			expect(result.stderr).toContain('untouched');
			expect(readFileSync(config, 'utf8')).toBe(original);
		}
	);

	it('retains a custom scrivener server entry', () => {
		const original = '{"mcpServers":{"scrivener":{"command":"custom","args":[]}}}';
		writeFileSync(config, original);
		expect(install().status).toBe(0);
		expect(readFileSync(config, 'utf8')).toBe(original);
		expect(readdirSync(dirname(config))).toHaveLength(1);
	});

	it('keeps complete original bytes and cleans temporary data after publication failure', () => {
		const original = '{"preferences":{"keep":true}}';
		writeFileSync(config, original);
		const result = install(
			`fs.renameSync=function(){throw Error('injected publication failure');};`
		);
		expect(result.status).toBe(0);
		expect(result.stderr).toContain('configure manually');
		expect(readFileSync(config, 'utf8')).toBe(original);
		expect(
			readdirSync(dirname(config)).filter((name) => name.includes('.scrivener-tmp-'))
		).toEqual([]);
		expect(install().stderr).toContain('Configured');
	});

	it('refuses a concurrent external change during backup', () => {
		writeFileSync(config, '{}');
		const result = install(
			`const sync=fs.fsyncSync; let calls=0; fs.fsyncSync=function(fd){sync(fd); if(++calls===2) fs.writeFileSync(process.env.TEST_CONFIG,'{"external":true}');};`
		);
		expect(result.status).toBe(0);
		expect(result.stderr).toContain('changed before publication');
		expect(readFileSync(config, 'utf8')).toBe('{"external":true}');
	});

	it.each([{ CI: 'true' }, { SCRIVENER_SKIP_POSTINSTALL: 'true' }])(
		'skips configuration when disabled: %j',
		(env) => {
			expect(install(undefined, env).status).toBe(0);
			expect(existsSync(config)).toBe(false);
		}
	);

	it('reports missing built setup code without touching configuration', () => {
		writeFileSync(config, '{}');
		rmSync(join(directory, 'dist'), { recursive: true });
		const result = install();
		expect(result.status).toBe(0);
		expect(result.stderr).toContain('Automatic configuration unavailable');
		expect(readFileSync(config, 'utf8')).toBe('{}');
	});
});
