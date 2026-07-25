/**
 * Bridge between the MCP server instance and AIClient for client-side
 * sampling (sampling/createMessage). When the connected MCP client advertises
 * the sampling capability, the server can run chat completions through the
 * client's own model -- no API key required. The bridge exists because
 * handlers construct AIClient ad hoc and have no reference to the server.
 */

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
	if (!samplingServer) return null;
	return samplingServer.getClientCapabilities()?.sampling ? samplingServer : null;
}
