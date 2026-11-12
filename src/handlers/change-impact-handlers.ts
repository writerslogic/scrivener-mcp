import { z } from 'zod';
import { impactInput } from '../services/editorial/change-impact.js';
import { requireProject, type ToolDefinition } from './types.js';

const passage = z
	.object({
		projectId: z.string().min(1).max(200).describe('Source project identity.'),
		documentId: z.string().uuid().describe('Source scene UUID.'),
		revision: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.describe('Saved source revision.'),
		title: z.string().max(1000).describe('Source title.'),
		path: z.string().max(4000).describe('Binder path.'),
		start: z.number().int().min(0).describe('Inclusive UTF-16 offset.'),
		end: z.number().int().min(1).describe('Exclusive UTF-16 offset.'),
		line: z.number().int().min(1).describe('One-based source line.'),
		quote: z.string().min(1).max(10000).describe('Exact source quotation.'),
	})
	.strict();
const dependencyInput = z
	.object({
		action: z
			.enum(['list', 'link', 'unlink'])
			.describe('List, record or remove an author-confirmed dependency.'),
		id: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.optional()
			.describe('Dependency identity to remove.'),
		kind: z
			.enum(['causal', 'timeline', 'revelation'])
			.optional()
			.describe('Author-assigned relationship meaning.'),
		prerequisite: passage
			.optional()
			.describe('Verified passage establishing the prerequisite.'),
		dependent: passage.optional().describe('Verified passage depending on the prerequisite.'),
		explanation: z
			.string()
			.trim()
			.min(1)
			.max(2000)
			.optional()
			.describe('Why this dependency matters to the story.'),
		after: z
			.string()
			.min(1)
			.max(160)
			.optional()
			.describe('Next-page cursor from the prior list response.'),
		limit: z
			.number()
			.int()
			.min(1)
			.max(100)
			.default(20)
			.describe('Maximum dependency records per page.'),
	})
	.strict();
const outputSchema: ToolDefinition['outputSchema'] = {
	type: 'object',
	properties: {
		result: {
			type: 'object',
			description: 'Revision-bound advisory impact report or persistent dependency result.',
		},
	},
	required: ['result'],
};
const reply = (result: object) => ({
	content: [{ type: 'text' as const, text: JSON.stringify(result) }],
	structuredContent: { result },
});
export const changeImpactHandlers: ToolDefinition[] = [
	{
		name: 'analyze_change_impact',
		title: 'Preview Story Change Impact',
		description:
			'Preview a saved scene replacement, removal or move against cited story facts, continuity findings and author-recorded causal, timeline and revelation dependencies. Returns source evidence and candidate name references without modifying the manuscript; stale revisions fail.',
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: z.toJSONSchema(impactInput, {
			io: 'input',
			target: 'draft-07',
		}) as ToolDefinition['inputSchema'],
		outputSchema,
		handler: async (args, context) =>
			reply(
				await requireProject(context)
					.getEditorialServices()
					.impact.analyze(impactInput.parse(args))
			),
	},
	{
		name: 'story_dependencies',
		title: 'Record Story Dependencies',
		description:
			'Record author-confirmed causal, timeline or revelation dependencies between two verified saved scene passages, list them with bounded pagination, or remove an obsolete relationship. These annotations support advisory change-impact previews and never edit manuscript text.',
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: z.toJSONSchema(dependencyInput, {
			io: 'input',
			target: 'draft-07',
		}) as ToolDefinition['inputSchema'],
		outputSchema,
		handler: async (args, context) => {
			const request = dependencyInput.parse(args);
			const service = requireProject(context).getEditorialServices().impact;
			if (request.action === 'list') return reply(service.dependencyPage(request));
			if (request.action === 'unlink') {
				if (!request.id) throw new Error('id is required for unlink');
				service.unlink(request.id);
				return reply({ removed: request.id });
			}
			const { kind, prerequisite, dependent, explanation } = request;
			if (!kind || !prerequisite || !dependent || !explanation)
				throw new Error('link requires kind, prerequisite, dependent and explanation');
			return reply(await service.link({ kind, prerequisite, dependent, explanation }));
		},
	},
];
