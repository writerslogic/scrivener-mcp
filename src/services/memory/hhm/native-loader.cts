import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type * as NativeModule from 'holographic-memory';

// A CommonJS bridge resolves from this package under both ESM and Jest's transform.
const localRequire = createRequire(__filename);

export function loadNativeBinding(): { module: typeof NativeModule; version: string } {
	const entry = localRequire.resolve('holographic-memory');
	const manifest = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')) as {
		version?: unknown;
	};
	const match =
		typeof manifest.version === 'string' ? /^0\.6\.(\d+)$/.exec(manifest.version) : null;
	if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 4)
		throw new Error('Unsupported HMS package version');
	const module = localRequire('holographic-memory') as typeof NativeModule;
	if (typeof module.HolographicMemorySystem !== 'function')
		throw new Error('HMS native binding is unavailable');
	return { module, version: manifest.version as string };
}
