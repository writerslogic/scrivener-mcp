/**
 * Read-only project integrity verification.
 *
 * Walks the open project's binder and document set and reports structural
 * problems (missing/duplicate/malformed ids, missing type metadata, and text
 * documents whose backing content is missing or unreadable). Detection only:
 * this tool never repairs. Automated repair is intentionally out of scope and
 * tracked as a separate follow-up because it carries data-loss risk.
 */

import { compact } from '../core/response-formatter.js';
import { handleError, isValidUUID } from '../utils/common.js';
import { DOCUMENT_TYPES } from '../core/constants.js';
import type { ScrivenerDocument } from '../types/index.js';
import type { HandlerResult, ToolDefinition } from './types.js';
import { getOptionalBooleanArg, requireProject } from './types.js';

type IssueSeverity = 'error' | 'warning';

interface IntegrityIssue {
	severity: IssueSeverity;
	/** Stable machine-readable category for the problem. */
	kind: string;
	/** Scrivener UUID of the offending item, when one is known. */
	id?: string;
	/** Human-readable explanation including title/path context. */
	detail: string;
}

interface IntegrityReport {
	ok: boolean;
	checked: number;
	issues: IntegrityIssue[];
	summary: string;
}

/** Read content for at most this many documents concurrently. */
const CONTENT_PROBE_BATCH = 25;

function describe(doc: ScrivenerDocument): string {
	const title = doc.title?.trim() ? doc.title : 'Untitled';
	return doc.path?.trim() ? `"${title}" (${doc.path})` : `"${title}"`;
}

/**
 * Inspect binder-level structure that is verifiable from document metadata
 * alone: missing UUIDs, malformed UUIDs, missing type, and duplicate UUIDs.
 */
function checkStructure(documents: ScrivenerDocument[], issues: IntegrityIssue[]): void {
	const idCounts = new Map<string, number>();

	for (const doc of documents) {
		const id = doc.id;

		if (!id || !id.trim()) {
			issues.push({
				severity: 'error',
				kind: 'missing_id',
				detail: `Binder entry ${describe(doc)} has no UUID; it cannot be addressed or read.`,
			});
		} else {
			idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
			if (!isValidUUID(id, { allowNumeric: true })) {
				issues.push({
					severity: 'error',
					kind: 'invalid_id',
					id,
					detail: `Binder entry ${describe(doc)} has a malformed id "${id}".`,
				});
			}
		}

		if (!doc.type || !String(doc.type).trim()) {
			issues.push({
				severity: 'warning',
				kind: 'missing_type',
				id: id || undefined,
				detail: `Binder entry ${describe(doc)} is missing its Type metadata.`,
			});
		}
	}

	for (const [id, count] of idCounts) {
		if (count > 1) {
			issues.push({
				severity: 'error',
				kind: 'duplicate_id',
				id,
				detail: `UUID ${id} is used by ${count} binder entries; ids must be unique.`,
			});
		}
	}
}

/**
 * Probe the backing content of text documents. A read that throws indicates an
 * unreadable/corrupt file (error); an empty read indicates a missing or empty
 * backing content file (warning). The empty-vs-missing distinction is not
 * available through the project API, so both surface as one warning kind.
 */
async function checkContent(
	project: ReturnType<typeof requireProject>,
	documents: ScrivenerDocument[],
	issues: IntegrityIssue[]
): Promise<void> {
	const textDocs = documents.filter(
		(doc) =>
			doc.type === DOCUMENT_TYPES.TEXT &&
			doc.id &&
			isValidUUID(doc.id, { allowNumeric: true })
	);

	for (let i = 0; i < textDocs.length; i += CONTENT_PROBE_BATCH) {
		const batch = textDocs.slice(i, i + CONTENT_PROBE_BATCH);
		const results = await Promise.allSettled(batch.map((doc) => project.readDocument(doc.id)));

		for (let j = 0; j < batch.length; j++) {
			const doc = batch[j];
			const result = results[j];
			if (result.status === 'rejected') {
				const reason =
					result.reason instanceof Error ? result.reason.message : String(result.reason);
				issues.push({
					severity: 'error',
					kind: 'unreadable_content',
					id: doc.id,
					detail: `Text document ${describe(doc)} could not be read: ${reason}`,
				});
			} else if (!result.value || !result.value.trim()) {
				issues.push({
					severity: 'warning',
					kind: 'empty_content',
					id: doc.id,
					detail: `Text document ${describe(doc)} has no readable content; its backing content file may be missing or empty.`,
				});
			}
		}
	}
}

export const verifyProjectIntegrityHandler: ToolDefinition = {
	name: 'verify_project_integrity',
	title: 'Verify Project Integrity',
	description:
		'Scan the open project for structural problems and return a read-only report: binder entries ' +
		'with missing, malformed, or duplicate UUIDs, entries missing their type, and text documents ' +
		'whose backing content is unreadable or empty. Use when a project looks corrupted, after manual ' +
		'edits to the .scrivx file, or before a bulk operation; not when you just want the document tree ' +
		'(use get_structure) or a single document (use get_document_info). This tool only detects ' +
		'problems and never repairs them. related: get_structure, get_document_info. Requires an open project.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			includeTrash: {
				type: 'boolean',
				description:
					'Whether to also verify documents in the project trash. Defaults to true so the ' +
					'whole project is checked; set false to skip trashed items.',
			},
		},
		required: [],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		try {
			const project = requireProject(context);
			const includeTrash = getOptionalBooleanArg(args, 'includeTrash') ?? true;

			const documents = await project.getAllDocuments(includeTrash);
			const issues: IntegrityIssue[] = [];

			checkStructure(documents, issues);
			await checkContent(project, documents, issues);

			const errorCount = issues.filter((issue) => issue.severity === 'error').length;
			const warningCount = issues.length - errorCount;
			const report: IntegrityReport = {
				ok: errorCount === 0,
				checked: documents.length,
				issues,
				summary:
					issues.length === 0
						? `Checked ${documents.length} item(s); no integrity problems found.`
						: `Checked ${documents.length} item(s); found ${errorCount} error(s) and ${warningCount} warning(s).`,
			};

			return {
				content: [{ type: 'text', text: compact(report) }],
			};
		} catch (error) {
			throw handleError(error, 'verifyProjectIntegrity');
		}
	},
};

export const integrityHandlers = [verifyProjectIntegrityHandler];
