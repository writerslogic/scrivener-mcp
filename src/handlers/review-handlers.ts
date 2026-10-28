import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { requireProject } from './types.js';

const uuid = z.string().uuid();
const input = z
	.object({
		action: z.enum([
			'propose',
			'list',
			'preview',
			'reject',
			'apply',
			'batch',
			'undo',
			'recover',
		]),
		documentId: uuid.optional(),
		proposalId: uuid.optional(),
		proposalIds: z.array(uuid).min(1).max(100).optional(),
		editIds: z.array(uuid).min(1).max(1000).optional(),
		expectedRevision: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.optional(),
		edits: z
			.array(
				z
					.object({
						start: z.number().int().min(0),
						end: z.number().int().min(0),
						text: z.string().max(10 * 1024 * 1024),
					})
					.strict()
			)
			.min(1)
			.max(1000)
			.optional(),
		title: z.string().max(200).optional(),
		idempotencyKey: z.string().min(1).max(200).optional(),
		operationId: uuid.optional(),
		allowFormattingLoss: z.boolean().optional(),
		force: z.boolean().optional(),
	})
	.strict();

export const reviewChangesHandler: ToolDefinition = {
	name: 'review_changes',
	title: 'Review Proposed Manuscript Changes',
	description:
		'Persist revision-bound edits, preview before/after without changing the manuscript, apply selected edits or batches with native snapshots, reject edits, recover interrupted applications, and undo only when the saved document still matches the applied revision. Formatting loss requires explicit acknowledgment.',
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			action: {
				type: 'string',
				enum: ['propose', 'list', 'preview', 'reject', 'apply', 'batch', 'undo', 'recover'],
				description: 'Review operation. Propose and preview never modify the manuscript.',
			},
			documentId: { type: 'string', description: 'Source document UUID for a proposal.' },
			proposalId: {
				type: 'string',
				description: 'Persistent proposal UUID for preview, reject or apply.',
			},
			proposalIds: {
				type: 'array',
				items: { type: 'string' },
				description: 'Proposal UUIDs for a recoverable batch application (up to 100).',
			},
			editIds: {
				type: 'array',
				items: { type: 'string' },
				description: 'Selected proposal edit UUIDs; omitted means all pending edits.',
			},
			expectedRevision: {
				type: 'string',
				description:
					'SHA-256 saved document revision; stale proposals and writes are rejected.',
			},
			edits: {
				type: 'array',
				description:
					'Non-overlapping replacements using UTF-16 offsets in the source text.',
				items: {
					type: 'object',
					properties: {
						start: { type: 'integer', description: 'Inclusive source text offset.' },
						end: { type: 'integer', description: 'Exclusive source text offset.' },
						text: { type: 'string', description: 'Replacement text, empty to delete.' },
					},
					required: ['start', 'end', 'text'],
				},
			},
			title: { type: 'string', description: 'Optional human-readable proposal label.' },
			idempotencyKey: {
				type: 'string',
				description:
					'Stable caller key to avoid creating duplicate proposals after a retry.',
			},
			operationId: {
				type: 'string',
				description: 'Application UUID to undo or to identify a retried application.',
			},
			allowFormattingLoss: {
				type: 'boolean',
				description:
					'Explicitly acknowledge formatting risks disclosed by preview before applying.',
			},
			force: {
				type: 'boolean',
				description:
					'Explicitly override native-app open/ambiguous detection only; never overrides revisions or server-instance conflicts.',
			},
		},
		required: ['action'],
	},
	outputSchema: {
		type: 'object',
		properties: {
			result: {
				type: 'object',
				description:
					'Persistent proposal, before/after preview, guarded application, batch, recovery or undo result. List actions return proposals; recover returns applications.',
			},
		},
		required: ['result'],
	},
	handler: async (args, context) => {
		const request = input.parse(args);
		const review = requireProject(context).getEditorialServices().review;
		const required = (value: string | undefined, name: string): string => {
			if (!value) throw new Error(`${name} is required for ${request.action}`);
			return value;
		};
		let result: object;
		switch (request.action) {
			case 'list':
				result = {
					proposals: review.list().map(({ before, ...proposal }) => ({
						...proposal,
						beforeLength: before.length,
					})),
					applications: review.listApplications(),
					batches: review.listBatches(),
				};
				break;
			case 'propose':
				if (!request.edits) throw new Error('edits are required for a proposal');
				result = await review.propose({
					documentId: required(request.documentId, 'documentId'),
					expectedRevision: request.expectedRevision,
					edits: request.edits,
					title: request.title,
					idempotencyKey: request.idempotencyKey,
				});
				break;
			case 'preview':
				result = await review.preview(
					required(request.proposalId, 'proposalId'),
					request.editIds
				);
				break;
			case 'reject':
				result = await review.reject(
					required(request.proposalId, 'proposalId'),
					request.editIds
				);
				break;
			case 'apply':
				result = await review.apply(required(request.proposalId, 'proposalId'), {
					editIds: request.editIds,
					allowFormattingLoss: request.allowFormattingLoss,
					force: request.force,
					operationId: request.operationId,
				});
				break;
			case 'batch':
				if (!request.proposalIds) throw new Error('proposalIds are required for a batch');
				result = await review.applyBatch(request.proposalIds, {
					allowFormattingLoss: request.allowFormattingLoss,
					force: request.force,
					operationId: request.operationId,
				});
				break;
			case 'undo':
				result = await review.undo(required(request.operationId, 'operationId'), {
					force: request.force,
				});
				break;
			case 'recover':
				result = { applications: await review.recover() };
				break;
		}
		return {
			content: [{ type: 'text', text: JSON.stringify(result) }],
			structuredContent: { result },
		};
	},
};
