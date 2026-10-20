import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep server caches and local databases beside this installation, regardless
// of which workspace Codex uses to launch the stdio process.
process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
await import('../dist/index.js');
