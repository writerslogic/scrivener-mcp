/**
 * MCP server capabilities.
 *
 * The skill registry mutates the advertised tool set at runtime — skills
 * activate on open_project/use_skill and register their tools then. A server
 * that does this MUST advertise `tools.listChanged: true`, otherwise clients
 * never subscribe to notifications/tools/list_changed and the progressively
 * disclosed tools (create_document, search, ...) never surface, leaving callers
 * looping on use_skill with "No such tool available".
 *
 * Kept in its own leaf module so it carries no heavy imports and can be
 * asserted in a unit test without booting the server or loading the handler graph.
 */
export const SERVER_CAPABILITIES = {
	tools: { listChanged: true },
} as const;
