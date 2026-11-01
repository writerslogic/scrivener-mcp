// Progressive tool activation requires clients to subscribe to tools/list_changed.

export const SERVER_CAPABILITIES = {
	tools: { listChanged: true },
	resources: {},
	extensions: { 'io.modelcontextprotocol/ui': {} },
} as const;
