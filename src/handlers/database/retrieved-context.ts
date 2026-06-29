/**
 * Pure formatting of vector-store hits into a grounding context block. Kept in its
 * own module (with only a minimal structural type, no HMS imports) so it can be unit
 * tested without pulling in the heavy holographic-memory chain.
 */

/** Minimal structural shape of a vector hit — compatible with HMSDocument. */
export interface RetrievedDoc {
	pageContent: string;
	metadata?: Record<string, unknown>;
}

export function formatRetrievedContext(
	hits: Array<[RetrievedDoc, number]>,
	perDocChars = 600
): string {
	return hits
		.map(([doc]) => {
			const title = (doc.metadata?.title as string) || 'Document';
			const content = (doc.pageContent || '').slice(0, perDocChars);
			return content ? `[${title}]: ${content}` : '';
		})
		.filter((block) => block.length > 0)
		.join('\n\n---\n\n');
}
