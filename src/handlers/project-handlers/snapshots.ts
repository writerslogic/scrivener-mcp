import { compact } from '../../core/response-formatter.js';
import type { HandlerResult, ToolDefinition } from '../types.js';
import { requireProject, getOptionalStringArg, getStringArg } from '../types.js';

export const listSnapshotsHandler: ToolDefinition = {
	name: 'list_snapshots',
	title: 'List Document Snapshots',
	description:
		"List the snapshots Scrivener has saved of a project's documents (from the .scriv " +
		"package's Snapshots/ directory). Pass documentId to list one document's snapshots, or " +
		'omit it to list snapshots for every document that has any. Each entry gives the owning ' +
		'document id and title, a snapshotId (pass it to read_snapshot to get the text), the ' +
		"snapshot's title, and its date. Read-only. Returns an empty list when nothing has been " +
		'snapshotted. Requires an open project (call open_project first).',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			documentId: {
				type: 'string',
				description:
					'UUID of a single document to list snapshots for. Omit to list all documents.',
			},
		},
	},
	outputSchema: {
		type: 'object',
		properties: {
			documents: {
				type: 'array',
				description: 'One entry per document that has snapshots.',
				items: {
					type: 'object',
					properties: {
						documentId: { type: 'string', description: 'Document UUID.' },
						documentTitle: {
							type: 'string',
							description: 'Document title, if the document is still in the binder.',
						},
						snapshots: {
							type: 'array',
							description: 'Snapshots recorded for this document.',
							items: {
								type: 'object',
								properties: {
									snapshotId: {
										type: 'string',
										description: 'Id to pass to read_snapshot.',
									},
									title: {
										type: 'string',
										description: 'Snapshot title ("" if none).',
									},
									date: { type: 'string', description: 'Snapshot date.' },
								},
							},
						},
					},
				},
			},
		},
		required: ['documents'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const documentId = getOptionalStringArg(args, 'documentId');
		const documents = await project.listSnapshots(documentId);
		return {
			content: [{ type: 'text', text: compact({ documents }) }],
			structuredContent: { documents },
		};
	},
};

export const readSnapshotHandler: ToolDefinition = {
	name: 'read_snapshot',
	title: 'Read Document Snapshot',
	description:
		'Return the text of a single document snapshot. Pass the documentId and the snapshotId from ' +
		"list_snapshots. The snapshot's RTF is converted to plain text. Read-only; does not alter the " +
		'document or restore the snapshot. Requires an open project (call open_project first).',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			documentId: { type: 'string', description: 'UUID of the document.' },
			snapshotId: {
				type: 'string',
				description: 'Snapshot id from list_snapshots.',
			},
		},
		required: ['documentId', 'snapshotId'],
	},
	outputSchema: {
		type: 'object',
		properties: {
			documentId: { type: 'string', description: 'UUID of the document.' },
			snapshotId: { type: 'string', description: 'Id of the snapshot that was read.' },
			title: { type: 'string', description: 'Snapshot title ("" if none).' },
			date: { type: 'string', description: 'Snapshot date.' },
			text: { type: 'string', description: 'Snapshot content as plain text.' },
			wordCount: { type: 'number', description: 'Word count of the snapshot text.' },
		},
		required: ['documentId', 'snapshotId', 'text', 'wordCount'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const documentId = getStringArg(args, 'documentId');
		const snapshotId = getStringArg(args, 'snapshotId');
		const snapshot = await project.readSnapshot(documentId, snapshotId);
		return {
			content: [{ type: 'text', text: compact(snapshot) }],
			structuredContent: snapshot as unknown as Record<string, unknown>,
		};
	},
};

export const compareSnapshotHandler: ToolDefinition = {
	name: 'compare_snapshot',
	title: 'Compare Snapshot',
	description:
		'Compare a document snapshot against the current document text, or against another snapshot ' +
		'(pass againstSnapshotId). Returns the paragraphs added and removed and the net word-count ' +
		'change — use this to see what changed since a snapshot was taken. Read-only. Requires an open ' +
		'project (call open_project first). Get snapshot ids from list_snapshots.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			documentId: { type: 'string', description: 'UUID of the document.' },
			snapshotId: {
				type: 'string',
				description: 'The baseline snapshot id (from list_snapshots).',
			},
			againstSnapshotId: {
				type: 'string',
				description:
					'Optional second snapshot id to compare against. Omit to compare against the ' +
					'current document text.',
			},
		},
		required: ['documentId', 'snapshotId'],
	},
	outputSchema: {
		type: 'object',
		properties: {
			documentId: { type: 'string', description: 'UUID of the compared document.' },
			from: {
				type: 'object',
				description: 'The baseline snapshot.',
				properties: {
					snapshotId: { type: 'string', description: 'Baseline snapshot id.' },
					title: { type: 'string', description: 'Baseline snapshot title ("" if none).' },
					date: { type: 'string', description: 'Baseline snapshot date.' },
					wordCount: { type: 'number', description: 'Baseline snapshot word count.' },
				},
			},
			to: {
				type: 'object',
				description: 'What it was compared against ("current" or a snapshot id).',
				properties: {
					snapshotId: {
						type: 'string',
						description: '"current" or the second snapshot id.',
					},
					wordCount: { type: 'number', description: 'Compared-to text word count.' },
				},
			},
			wordDelta: {
				type: 'number',
				description: 'to.wordCount minus from.wordCount (negative means text was cut).',
			},
			wordsAdded: {
				type: 'number',
				description:
					'Words present in the compared-to text but not the snapshot (word-level).',
			},
			wordsRemoved: {
				type: 'number',
				description:
					'Words present in the snapshot but not the compared-to text (word-level).',
			},
			addedParagraphs: {
				type: 'array',
				items: { type: 'string' },
				description: 'Paragraphs present in the compared-to text but not the snapshot.',
			},
			removedParagraphs: {
				type: 'array',
				items: { type: 'string' },
				description: 'Paragraphs present in the snapshot but not the compared-to text.',
			},
			unchangedParagraphs: {
				type: 'number',
				description: 'Count of paragraphs common to both.',
			},
		},
		required: ['documentId', 'from', 'to', 'wordDelta', 'addedParagraphs', 'removedParagraphs'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const documentId = getStringArg(args, 'documentId');
		const snapshotId = getStringArg(args, 'snapshotId');
		const againstSnapshotId = getOptionalStringArg(args, 'againstSnapshotId');
		const comparison = await project.compareSnapshot(documentId, snapshotId, againstSnapshotId);
		return {
			content: [{ type: 'text', text: compact(comparison) }],
			structuredContent: comparison as unknown as Record<string, unknown>,
		};
	},
};

export const createSnapshotHandler: ToolDefinition = {
	name: 'create_snapshot',
	title: 'Create Document Snapshot',
	description:
		"Take a Scrivener-native snapshot of a document's current content, restorable from Scrivener's " +
		'own Snapshots browser. Use this before rewriting a document to give the writer a native ' +
		"rollback point. Copies the live content into the project's Snapshots directory with a title " +
		'and timestamp; does not modify the document. Requires an open project and a document that has ' +
		'content.',
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			documentId: { type: 'string', description: 'UUID of the document to snapshot.' },
			title: {
				type: 'string',
				description: 'Snapshot title shown in Scrivener. Defaults to "Snapshot".',
			},
		},
		required: ['documentId'],
	},
	outputSchema: {
		type: 'object',
		properties: {
			documentId: { type: 'string', description: 'UUID of the snapshotted document.' },
			snapshotId: {
				type: 'string',
				description: 'Id of the new snapshot (for read_snapshot).',
			},
			title: { type: 'string', description: 'Snapshot title as recorded.' },
			date: { type: 'string', description: 'Timestamp recorded for the snapshot.' },
		},
		required: ['documentId', 'snapshotId', 'title', 'date'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const documentId = getStringArg(args, 'documentId');
		const title = getOptionalStringArg(args, 'title') || 'Snapshot';
		const snapshot = await project.takeSnapshot(documentId, title);
		return {
			content: [{ type: 'text', text: compact(snapshot) }],
			structuredContent: snapshot as unknown as Record<string, unknown>,
		};
	},
};
