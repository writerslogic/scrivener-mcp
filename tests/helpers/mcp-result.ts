import { CallToolResultSchema } from '@modelcontextprotocol/core';
import { z } from 'zod';

export const ScrivenerToolResultSchema = CallToolResultSchema.extend({
	structuredContent: z.record(z.string(), z.unknown()).optional(),
});
