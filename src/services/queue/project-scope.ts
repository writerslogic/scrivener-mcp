import { createHash, randomUUID } from 'node:crypto';
import { UnrecoverableError } from 'bullmq';

export interface QueueScope {
	readonly id: string;
	readonly projectId: string;
	readonly prefix: string;
}

export interface ScopedJob {
	version: 1;
	scopeId: string;
	projectId: string;
	jobType: string;
	payload: Record<string, unknown>;
}

export const LEGACY_QUEUE_NOTICE =
	'Unscoped legacy Redis queues and embedded job records are excluded and remain unchanged. Their project ownership cannot be established; inspect them separately before any explicit migration. Project location is part of queue ownership, so moving a project also requires explicit queue-history migration.';

export function createQueueScope(projectId: string, projectPath?: string): QueueScope {
	const id = createHash('sha256')
		.update(JSON.stringify([1, projectPath ?? null, projectId]))
		.digest('hex');
	return { id, projectId, prefix: `scrivener-mcp-v1-${id}` };
}

export function scopedJobId(scope: QueueScope): string {
	return `${scope.id}-${randomUUID()}`;
}

export function ownsJobId(scope: QueueScope, id: unknown): id is string {
	return (
		typeof id === 'string' &&
		id.startsWith(`${scope.id}-`) &&
		/^[a-f0-9]{64}-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)
	);
}

export function scopeJob(
	scope: QueueScope,
	jobType: string,
	payload: Record<string, unknown>
): ScopedJob {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload))
		throw new Error('Queue payload must be an object');
	const serialized = JSON.stringify(payload);
	if (Buffer.byteLength(serialized) > 64 * 1024 * 1024)
		throw new Error('Queue payload exceeds 64 MiB');
	return { version: 1, scopeId: scope.id, projectId: scope.projectId, jobType, payload };
}

export function readScopedJob(
	scope: QueueScope,
	jobType: string,
	jobId: unknown,
	value: unknown
): Record<string, unknown> {
	const envelope = value as Partial<ScopedJob> | null;
	if (
		!ownsJobId(scope, jobId) ||
		!envelope ||
		typeof envelope !== 'object' ||
		Array.isArray(envelope) ||
		Object.keys(envelope).length !== 5 ||
		envelope.version !== 1 ||
		envelope.scopeId !== scope.id ||
		envelope.projectId !== scope.projectId ||
		envelope.jobType !== jobType ||
		!envelope.payload ||
		typeof envelope.payload !== 'object' ||
		Array.isArray(envelope.payload)
	)
		throw new UnrecoverableError(
			'Queue job has foreign, legacy or invalid ownership; it was not processed. Explicit migration requires verified project ownership.'
		);
	return envelope.payload;
}
