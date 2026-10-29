#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { MIN_NODE_MAJOR, MIN_NODE_VERSION, isSupportedRuntime } from '../dist/setup/runtime.js';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const required = /^>=(\d+\.\d+\.\d+)$/.exec(manifest.engines?.node ?? '');
if (
	!required ||
	required[1] !== MIN_NODE_VERSION ||
	Number(required[1].split('.')[0]) !== MIN_NODE_MAJOR
)
	throw new Error('Package engine and setup runtime requirements disagree');

const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const matrix = /node-version:\s*\[([^\]]+)\]/
	.exec(workflow)?.[1]
	.split(',')
	.map((item) => item.trim().replace(/^['"]|['"]$/g, ''));
if (!matrix?.includes(MIN_NODE_VERSION))
	throw new Error('CI must exercise the exact minimum supported Node version');
const platforms = /os:\s*\[([^\]]+)\]/.exec(workflow)?.[1]
	.split(',')
	.map((item) => item.trim().replace(/^['"]|['"]$/g, ''));
if (!['ubuntu-latest', 'macos-latest', 'windows-latest'].every((os) => platforms?.includes(os)))
	throw new Error('CI must cover Linux, macOS and Windows');

if (
	!isSupportedRuntime({
		node: process.execPath,
		npx: null,
		version: process.version,
		major: Number(process.versions.node.split('.')[0]),
		source: 'runtime-policy',
	})
)
	throw new Error(`Use a stable Node runtime satisfying ${manifest.engines.node}`);

process.stdout.write(
	`Runtime policy agrees: Node ${manifest.engines.node}; running ${process.version}\n`
);
