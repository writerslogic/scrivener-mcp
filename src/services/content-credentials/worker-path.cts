import { join } from 'node:path';

export function credentialWorkerPath(): string {
	return join(__dirname, 'sdk-worker.js');
}
