import type { ToolDefinition, ToolSchema } from './types.js';
import { getStringArg, requireProject } from './types.js';
import type { EditorialWorkflow, WorkflowKind } from '../services/editorial/workflow-service.js';

const workflowOutputSchema: ToolSchema = {
	type: 'object',
	properties: {
		nextCursor: {
			type: ['string', 'null'],
			description: 'Next workflow list cursor, or null after the final summary page.',
		},
		workflows: {
			type: 'array',
			description:
				'Durable editorial workflows in the current project or the selected workflow.',
			items: {
				type: 'object',
				properties: {
					id: {
						type: 'string',
						description:
							'Durable workflow identifier used for status, cancel, or resume.',
					},
					projectId: {
						type: 'string',
						description: 'Project identity to which the workflow is explicitly scoped.',
					},
					kind: {
						type: 'string',
						description:
							'Review-chapter, audit-continuity, or beta-reader-draft workflow.',
					},
					state: {
						type: 'string',
						description:
							'Ready, running, cancelled, failed, completed, or interrupted state.',
					},
					progress: {
						type: 'integer',
						description: 'Percentage of durable completed steps, from 0 to 100.',
					},
					createdAt: {
						type: 'string',
						description: 'ISO timestamp when this workflow was created.',
					},
					updatedAt: {
						type: 'string',
						description: 'ISO timestamp of the latest persisted transition.',
					},
					scope: {
						type: 'array',
						description:
							'Ordered document scope and saved revisions bound to this run.',
						items: {
							type: 'object',
							properties: {
								documentId: {
									type: 'string',
									description:
										'Stable binder UUID of the scoped manuscript document.',
								},
								title: {
									type: 'string',
									description: 'Document title when the workflow started.',
								},
								revision: {
									type: 'string',
									description:
										'Saved RTF revision required when resuming pending steps.',
								},
								characters: {
									type: 'integer',
									description:
										'UTF-16 source text size when the workflow started.',
								},
							},
							required: ['documentId', 'title', 'revision', 'characters'],
						},
					},
					steps: {
						type: 'array',
						description:
							'Persistent step checkpoints; completed results are retained across restart and resume.',
						items: {
							type: 'object',
							properties: {
								id: {
									type: 'string',
									description: 'Stable identifier for the workflow step.',
								},
								kind: {
									type: 'string',
									description:
										'Index, analyze, propose, continuity, or export operation.',
								},
								documentId: {
									type: 'string',
									description: 'Source document UUID for a document-scoped step.',
								},
								state: {
									type: 'string',
									description:
										'Pending, running, completed, or failed checkpoint.',
								},
								result: {
									description:
										'The actual analysis, proposal, continuity, index, or export result from the completed domain operation.',
								},
								error: {
									type: 'string',
									description: 'Failure detail for this step, when it failed.',
								},
							},
							required: ['id', 'kind', 'state'],
						},
					},
					usage: {
						type: 'object',
						description: 'Measured local work and provider usage for completed steps.',
						properties: {
							localSteps: {
								type: 'integer',
								description:
									'Number of successfully checkpointed local operations.',
							},
							analyzedCharacters: {
								type: 'integer',
								description:
									'Total source UTF-16 code units passed to completed analyses.',
							},
							providerRequests: {
								type: 'integer',
								description:
									'Provider requests made by this local workflow; currently zero.',
							},
							providerTokens: {
								type: 'integer',
								description:
									'Provider tokens billed by this local workflow; currently zero.',
							},
						},
						required: [
							'localSteps',
							'analyzedCharacters',
							'providerRequests',
							'providerTokens',
						],
					},
					cost: {
						type: 'object',
						description:
							'Server-side cost estimate and actual charge with the disclosed basis.',
						properties: {
							currency: {
								type: 'string',
								description: 'Currency code for the estimate, USD.',
							},
							estimated: {
								type: 'number',
								description:
									'Estimated provider charge for this local workflow, zero.',
							},
							actual: {
								type: 'number',
								description:
									'Measured provider charge for this local workflow, zero.',
							},
							basis: {
								type: 'string',
								description:
									'What the estimate covers and which client costs are outside the server.',
							},
						},
						required: ['currency', 'estimated', 'actual', 'basis'],
					},
					allowExportWarnings: {
						type: 'boolean',
						description:
							'Persisted author acknowledgment of disclosed beta-reader export warnings; omitted for other workflows.',
					},
					error: {
						type: 'string',
						description: 'Workflow failure or interruption detail requiring attention.',
					},
				},
				required: [
					'id',
					'projectId',
					'kind',
					'state',
					'progress',
					'createdAt',
					'updatedAt',
					'usage',
					'cost',
				],
			},
		},
	},
	required: ['workflows'],
};

export const workflowHandlers: ToolDefinition[] = [
	{
		name: 'editorial_workflow',
		title: 'Run Guided Editorial Workflow',
		description:
			'Start, inspect, cancel, or durably resume Review this chapter, Audit continuity, or Prepare a beta-reader draft. Shows explicit manuscript scope, saved source revisions, progress, actual step results, local usage and zero provider cost. Completed steps are retained; stale sources stop resuming. Chapter edits become review proposals and are applied only through review controls.',
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			type: 'object',
			properties: {
				after: {
					type: 'string',
					minLength: 1,
					maxLength: 160,
					description: 'Cursor returned by a previous workflow list page.',
				},
				limit: {
					type: 'integer',
					minimum: 1,
					maximum: 100,
					description:
						'Workflow summary page size, default20; use get for full scope and results.',
				},
				action: {
					type: 'string',
					enum: ['start', 'get', 'list', 'cancel', 'resume'],
					description:
						'Start a new workflow, inspect one/all, cancel remaining steps, or resume an interrupted/cancelled run.',
				},
				kind: {
					type: 'string',
					enum: ['review-chapter', 'audit-continuity', 'beta-reader-draft'],
					description:
						'Required for start: the guided editorial workflow to run locally.',
				},
				workflowId: {
					type: 'string',
					maxLength: 128,
					description:
						'Required for get, cancel, or resume; a workflow identifier returned by start.',
				},
				documentIds: {
					type: 'array',
					minItems: 1,
					maxItems: 10000,
					items: { type: 'string', minLength: 1, maxLength: 128 },
					description:
						'Explicit manuscript document UUIDs; required for chapter review unless rootFolderId is given. Other workflows default to the active manuscript.',
				},
				rootFolderId: {
					type: 'string',
					maxLength: 128,
					description:
						'Select the manuscript descendants of this binder folder, mutually exclusive with documentIds.',
				},
				idempotencyKey: {
					type: 'string',
					minLength: 1,
					maxLength: 200,
					description:
						'Optional stable start request key; retries return the same durable workflow.',
				},
				allowExportWarnings: {
					type: 'boolean',
					description:
						'For beta-reader start or resume only: explicitly acknowledge disclosed export warnings. Omit on resume to retain the prior decision; completed exports never rerun.',
				},
			},
			required: ['action'],
		},
		outputSchema: workflowOutputSchema,
		handler: async (args, context) => {
			const project = requireProject(context);
			const { workflows } = await project.getEditorialServices();
			const action = getStringArg(args, 'action');
			if (
				args.allowExportWarnings !== undefined &&
				typeof args.allowExportWarnings !== 'boolean'
			)
				throw new Error('allowExportWarnings must be a boolean');
			if (args.allowExportWarnings !== undefined && action !== 'start' && action !== 'resume')
				throw new Error(
					'Export warning acknowledgment is valid only when starting or resuming a beta-reader workflow'
				);
			let values: EditorialWorkflow[];
			if (action === 'list') {
				const page = workflows.listPage({
					after: args.after as string | undefined,
					limit: args.limit as number | undefined,
				});
				const result = { workflows: page.items, nextCursor: page.nextCursor };
				return {
					content: [{ type: 'text', text: JSON.stringify(result) }],
					structuredContent: result,
				};
			} else if (action === 'get') values = [workflows.get(getStringArg(args, 'workflowId'))];
			else if (action === 'cancel')
				values = [workflows.cancel(getStringArg(args, 'workflowId'))];
			else if (action === 'resume')
				values = [
					await workflows.resume(getStringArg(args, 'workflowId'), {
						allowExportWarnings: args.allowExportWarnings as boolean | undefined,
					}),
				];
			else if (action === 'start') {
				if (args.rootFolderId && args.documentIds)
					throw new Error('Choose rootFolderId or documentIds, not both');
				const documentIds = args.rootFolderId
					? (await project.getDocumentsUnderFolder(getStringArg(args, 'rootFolderId')))
							.filter((doc) => doc.type === 'Text')
							.map((doc) => doc.id)
					: (args.documentIds as string[] | undefined);
				values = [
					await workflows.start({
						kind: getStringArg(args, 'kind') as WorkflowKind,
						documentIds,
						idempotencyKey: args.idempotencyKey as string | undefined,
						allowExportWarnings: args.allowExportWarnings as boolean | undefined,
					}),
				];
			} else throw new Error('Unknown editorial workflow action');
			return {
				content: [{ type: 'text', text: JSON.stringify({ workflows: values }) }],
				structuredContent: { workflows: values },
			};
		},
	},
];
