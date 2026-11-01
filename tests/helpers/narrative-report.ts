import { manuscriptAnalysisHandlers } from '../../src/handlers/manuscript-analysis-handlers.js';
import type { HandlerContext, HandlerResult } from '../../src/handlers/types.js';
import type { NarrativeAnalysis } from '../../src/services/editorial/narrative-analysis.js';
type Report = Awaited<ReturnType<NarrativeAnalysis['analyze']>>;
type Page = {
	reportId: string;
	encoding?: 'json-fragment';
	data: string;
	pagination: { start: number; end: number; nextCursor: string | null };
};
export async function collectNarrativeReport(
	context: HandlerContext | ((args: Record<string, unknown>) => Promise<HandlerResult>),
	args: Record<string, unknown>,
	pageBytes = 32768,
	observe?: (phase: 'first-page' | 'before-reconstruction' | 'reconstructed') => void
) {
	const handler =
		typeof context === 'function'
			? context
			: (args: Record<string, unknown>) =>
					manuscriptAnalysisHandlers[0].handler(args, context);
	let response = await handler({ action: 'analyze', ...args, pageByteLimit: pageBytes });
	observe?.('first-page');
	let serialized = '',
		pages = 0,
		outputBytes = 0,
		maxPageBytes = 0,
		end = 0;
	let report: Report;
	for (;;) {
		if (response.isError || !response.structuredContent)
			throw new Error('Narrative report request failed');
		const bytes = Buffer.byteLength(JSON.stringify(response));
		if (bytes > pageBytes) throw new Error('MCP page exceeded its byte budget');
		maxPageBytes = Math.max(maxPageBytes, bytes);
		outputBytes += bytes;
		pages++;
		const part = response.structuredContent!.result as Page;
		if (part.encoding !== 'json-fragment') {
			report = response.structuredContent!.result as Report;
			break;
		}
		if (part.pagination.start !== end || part.pagination.end <= end)
			throw new Error('Report continuation skipped or duplicated content');
		serialized += part.data;
		end = part.pagination.end;
		if (part.pagination.nextCursor === null) {
			observe?.('before-reconstruction');
			report = JSON.parse(serialized) as Report;
			observe?.('reconstructed');
			break;
		}
		response = await handler({
			action: 'read_report',
			reportId: part.reportId,
			pageCursor: part.pagination.nextCursor,
			pageByteLimit: pageBytes,
		});
	}
	return { report, pages, outputBytes, maxPageBytes };
}
