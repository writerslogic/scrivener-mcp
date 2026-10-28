import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireProject } from './types.js';

const input = z
	.object({
		action: z.enum(['preflight', 'export']).default('preflight'),
		preset: z.enum(['submission-manuscript', 'beta-reader', 'ebook']),
		documentIds: z.array(z.string().uuid()).max(10000).optional(),
		frontMatterIds: z.array(z.string().uuid()).max(1000).optional(),
		includeAnnotations: z.boolean().optional(),
		allowWarnings: z.boolean().optional(),
		outputPath: z.string().min(1).max(4096).optional(),
	})
	.strict();

export const exportManuscriptHandler: ToolDefinition = {
	name: 'export_manuscript',
	title: 'Export Manuscript With Editorial Preset',
	description:
		'Preflight and export a submission manuscript, beta-reader DOCX or ebook EPUB using binder order, section types, preset typography and explicit front matter. Reports unsupported media, layouts and note placement before export; validates the generated archive. Does not reproduce the native Scrivener compile engine.',
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	inputSchema: {
		type: 'object',
		properties: {
			action: {
				type: 'string',
				enum: ['preflight', 'export'],
				description:
					'Default preflight reads sources and reports coverage without writing an export.',
			},
			preset: {
				type: 'string',
				enum: ['submission-manuscript', 'beta-reader', 'ebook'],
				description:
					'Submission: double-spaced DOCX; beta: readable DOCX; ebook: reflowable EPUB.',
			},
			documentIds: {
				type: 'array',
				items: { type: 'string' },
				description:
					'Optional manuscript text UUIDs, kept in binder order; omitted selects compilable draft documents.',
			},
			frontMatterIds: {
				type: 'array',
				items: { type: 'string' },
				description:
					'Active text UUIDs to prepend in this explicit order after the generated title page.',
			},
			includeAnnotations: {
				type: 'boolean',
				description: 'Include supported Scrivener annotations as labeled scene-end notes.',
			},
			allowWarnings: {
				type: 'boolean',
				description:
					'Acknowledge preflight warnings before exporting unsupported constructs.',
			},
			outputPath: {
				type: 'string',
				description:
					'Destination DOCX or EPUB path; default is the project .scrivener-mcp/exports directory.',
			},
		},
		required: ['preset'],
	},
	outputSchema: {
		type: 'object',
		properties: {
			result: {
				type: 'object',
				description:
					'Preflight readiness, selected document identities and findings, or export path, byte count, preset and archive validation evidence.',
			},
		},
		required: ['result'],
	},
	handler: async (args, context) => {
		const { action, outputPath, ...options } = input.parse(args);
		const project = requireProject(context);
		const result =
			action === 'preflight'
				? await project.preflightExport(options)
				: await project.exportManuscript(options, outputPath);
		return {
			content: [{ type: 'text', text: JSON.stringify(result) }],
			structuredContent: { result },
		};
	},
};
