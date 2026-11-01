// Handlers construct AIClient without a server reference; this bridge supplies client sampling.

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

let samplingServer: Server | null = null;

/** Called once at startup with the MCP server instance (null to clear, for tests). */
export function registerSamplingServer(server: Server | null): void {
	samplingServer = server;
}

/**
 * The server instance when the connected client supports sampling, else null.
 * Client capabilities are only known after the initialize handshake, so this
 * must be consulted at call time, not at registration time.
 */
export function getSamplingServer(): Server | null {
	if (process.env.SCRIVENER_LOCAL_ONLY === 'true') return null;
	if (!samplingServer) return null;
	return samplingServer.getClientCapabilities()?.sampling ? samplingServer : null;
}
