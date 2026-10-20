import type { ServerEntry } from './runtime.js';
import { SERVER_NAME } from './clients.js';

export interface InstallLinks {
	cursor: string;
	/** VS Code documents a command, not a link: run it in a terminal. */
	vscodeCommand: string;
	lmStudio: string;
	raycast: string;
}

function b64(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString('base64');
}

/**
 * One-click install links. A link only opens the client's own install dialog, so it cannot
 * check or fix Node; pass an entry built from a verified runtime to make the command absolute.
 */
export function installLinks(entry: ServerEntry): InstallLinks {
	const stdio = { ...entry };
	return {
		cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER_NAME}&config=${encodeURIComponent(b64(stdio))}`,
		vscodeCommand: `code --add-mcp '${JSON.stringify({ name: SERVER_NAME, type: 'stdio', ...entry }).replace(/'/g, `'\\''`)}'`,
		lmStudio: `lmstudio://add_mcp?name=${SERVER_NAME}&config=${encodeURIComponent(b64(stdio))}`,
		raycast: `raycast://mcp/install?${encodeURIComponent(JSON.stringify({ name: SERVER_NAME, type: 'stdio', ...entry }))}`,
	};
}
