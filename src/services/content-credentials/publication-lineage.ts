import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const reviewedPublicationSchema = z
	.object({
		workflowId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
		reviewApplicationIds: z.array(z.string().uuid()).min(1).max(1000),
		machineAssistance: z.enum(['unknown', 'declared-assistance']).default('unknown'),
	})
	.strict();
export const publicationLineageSchema = z
	.object({
		version: z.literal(1),
		workflowId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
		exportSha256: digest,
		sourceRevisions: z
			.array(z.object({ documentId: z.string().uuid(), revision: digest }).strict())
			.min(1)
			.max(1000),
		reviews: z
			.array(
				z
					.object({
						applicationId: z.string().uuid(),
						documentId: z.string().uuid(),
						beforeRevision: digest,
						afterRevision: digest,
					})
					.strict()
			)
			.min(1)
			.max(1000),
		machineAssistance: z
			.object({
				localAnalysis: z.literal(true),
				manuscript: z.enum(['unknown', 'declared-assistance']),
			})
			.strict(),
	})
	.strict();
export type ReviewedPublication = z.infer<typeof reviewedPublicationSchema>;
export type PublicationLineage = z.infer<typeof publicationLineageSchema>;
