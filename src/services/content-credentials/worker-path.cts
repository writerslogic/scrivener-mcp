import { join } from 'node:path';
import { createRequire } from 'node:module';

const localRequire = createRequire(__filename);

export function credentialWorkerPath(): string {
	return join(__dirname, 'sdk-worker.js');
}

function packageVersion(packagePath: string): string {
	const { version } = localRequire(packagePath) as { version?: unknown };
	if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version))
		throw new Error('Invalid installed Content Credentials SDK version');
	return version;
}

export function credentialSdkVersion(): string {
	return packageVersion('@contentauth/c2pa-node/package.json');
}

export function credentialProductVersion(): string {
	return packageVersion('../../../package.json');
}
