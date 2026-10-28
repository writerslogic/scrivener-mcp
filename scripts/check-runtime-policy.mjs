#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import {
	MIN_NODE_MAJOR,
	MIN_NODE_API_VERSION,
	MIN_NODE_VERSION,
	SUPPORTED_NODE_RANGE,
	isSupportedRuntime,
} from '../dist/setup/runtime.js';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (
	manifest.engines?.node !== SUPPORTED_NODE_RANGE ||
	Number(MIN_NODE_VERSION.split('.')[0]) !== MIN_NODE_MAJOR
)
	throw new Error(
		`Package engine and setup runtime requirements disagree; expected ${SUPPORTED_NODE_RANGE}`
	);

const bootstrap = await readFile(new URL('./bootstrap-mac.sh', import.meta.url), 'utf8');
const bootstrapMinimum = /^MIN_VERSION='([^']+)'$/m.exec(bootstrap)?.[1];
const bootstrapNextMinimum = /^NEXT_MIN_VERSION='([^']+)'$/m.exec(bootstrap)?.[1];
const bootstrapNapi = /^MIN_NAPI=(\d+)$/m.exec(bootstrap)?.[1];
if (
	bootstrapMinimum !== MIN_NODE_VERSION ||
	`^${bootstrapMinimum} || >=${bootstrapNextMinimum}` !== SUPPORTED_NODE_RANGE ||
	bootstrapNapi !== String(MIN_NODE_API_VERSION)
)
	throw new Error('Bootstrap and setup runtime requirements disagree');

const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const matrix = /node-version:\s*\[([^\]]+)\]/
	.exec(workflow)?.[1]
	.split(',')
	.map((item) => item.trim().replace(/^['"]|['"]$/g, ''));
if (!matrix?.includes(MIN_NODE_VERSION))
	throw new Error('CI must exercise the exact minimum supported Node version');
const platforms = /os:\s*\[([^\]]+)\]/
	.exec(workflow)?.[1]
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
	throw new Error(`Use a stable Node runtime satisfying ${SUPPORTED_NODE_RANGE}`);

const napiText = process.versions.napi;
const napi = Number(napiText);
if (
	typeof napiText !== 'string' ||
	!/^(0|[1-9]\d*)$/.test(napiText) ||
	!Number.isSafeInteger(napi) ||
	napi < MIN_NODE_API_VERSION
)
	throw new Error(`The current Node runtime must provide N-API ${MIN_NODE_API_VERSION} or newer`);

process.stdout.write(
	`Runtime policy agrees: Node ${manifest.engines.node}, N-API >=${MIN_NODE_API_VERSION}; running ${process.version}, N-API ${napi}\n`
);
