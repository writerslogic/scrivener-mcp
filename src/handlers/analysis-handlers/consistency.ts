import { compact } from '../../core/response-formatter.js';
import type { ContinuityCheck } from '../../services/editorial/continuity-service.js';
import { continuityFindingSchema, storyFactSchema } from '../story-handlers.js';
import type { HandlerResult, ToolDefinition } from '../types.js';
import { getOptionalStringArg, requireProject } from '../types.js';

export const checkConsistencyHandler: ToolDefinition = {
	name: 'check_consistency',
	title: 'Check Project Consistency',
	description:
		'Audit the manuscript in binder order against curated story facts and narrowly extracted explicit attribute statements. Findings include source quotations, document identities, saved revisions and review state. Narrative candidates remain inferred; flashbacks and intentional variations are respected. Recheck or review findings with continuity_findings.',
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			checkTypes: {
				type: 'array',
				items: {
					type: 'string',
					enum: ['characters', 'timeline', 'locations', 'plotThreads', 'all'],
				},
				description:
					'Continuity dimensions to inspect; defaults to all. Categories without quoted curated facts do not produce speculative contradictions.',
			},
			documentIds: {
				type: 'array',
				items: { type: 'string' },
				description:
					'Optional chapter scope: exact manuscript document ids. Binder order and project canon are retained.',
			},
			seriesId: {
				type: 'string',
				description:
					'Optional explicitly joined series whose curated facts should also be considered.',
			},
		},
	},
	outputSchema: {
		type: 'object',
		properties: {
			issues: {
				type: 'array',
				description: 'Unresolved findings in binder order, tied to quoted evidence.',
				items: continuityFindingSchema,
			},
			counts: {
				type: 'object',
				description: 'Unresolved finding counts by severity.',
				properties: {
					total: { type: 'number', description: 'Total unresolved findings.' },
					errors: { type: 'number', description: 'Confirmed canon conflicts.' },
					warnings: {
						type: 'number',
						description: 'Candidate mismatches requiring author review.',
					},
					info: { type: 'number', description: 'Informational findings.' },
				},
				required: ['total', 'errors', 'warnings', 'info'],
			},
			checkTypes: {
				type: 'array',
				description: 'Continuity dimensions inspected.',
				items: { type: 'string' },
			},
			candidates: {
				type: 'array',
				description: 'Inferred and uncertain explicit statements; not confirmed canon.',
				items: storyFactSchema,
			},
			analyzedDocuments: {
				type: 'number',
				description: 'Number of documents in the selected manuscript scope.',
			},
			analyzedAt: { type: 'string', description: 'Analysis timestamp.' },
			coverage: {
				type: 'string',
				description: 'Exact local analysis coverage and inference limitations.',
			},
		},
		required: [
			'issues',
			'counts',
			'checkTypes',
			'candidates',
			'analyzedDocuments',
			'analyzedAt',
			'coverage',
		],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const { continuity } = requireProject(context).getEditorialServices();
		if (args.checkTypes !== undefined && !Array.isArray(args.checkTypes))
			throw new Error('checkTypes must be an array');
		if (args.documentIds !== undefined && !Array.isArray(args.documentIds))
			throw new Error('documentIds must be an array');
		const report = await continuity.analyze({
			checkTypes: args.checkTypes as ContinuityCheck[] | undefined,
			documentIds: args.documentIds as string[] | undefined,
			seriesId: getOptionalStringArg(args, 'seriesId'),
		});
		return {
			content: [
				{
					type: 'text',
					text: `${report.counts.total} unresolved continuity finding(s). ${report.coverage}\n${compact(report)}`,
				},
			],
			structuredContent: { ...report },
		};
	},
};
