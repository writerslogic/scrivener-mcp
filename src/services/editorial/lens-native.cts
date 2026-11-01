import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

export function narrativeModulePath(): string {
	return createRequire(__filename).resolve('narrative-lens');
}

export function narrativeVersion(): string {
	const metadata = JSON.parse(
		readFileSync(join(dirname(narrativeModulePath()), 'package.json'), 'utf8')
	);
	if (typeof metadata.version !== 'string')
		throw new Error('Narrative Lens version metadata is invalid');
	return metadata.version;
}
