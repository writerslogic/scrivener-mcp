import type { HandlerResult, ToolDefinition } from './types.js';
import {
	getOptionalStringArg,
	getStringArg,
	requireMemoryManager,
	requireProject,
} from './types.js';
import type {
	CurateFactInput,
	FactCorrection,
	StoryScope,
} from '../services/editorial/series-bible.js';

export const sourcePassageSchema = {
	type: 'object',
	properties: {
		projectId: { type: 'string', description: 'Stable source project identity.' },
		documentId: { type: 'string', description: 'Stable binder document identity.' },
		revision: { type: 'string', description: 'SHA-256 of saved raw source RTF.' },
		title: { type: 'string', description: 'Source document title at capture.' },
		path: { type: 'string', description: 'Binder path of the source document.' },
		start: {
			type: 'integer',
			description: 'Inclusive UTF-16 offset in source text.',
			minimum: 0,
		},
		end: {
			type: 'integer',
			description: 'Exclusive UTF-16 offset in source text.',
			minimum: 1,
		},
		line: { type: 'integer', description: 'One-based source text line.', minimum: 1 },
		quote: { type: 'string', description: 'Verbatim source passage at the specified range.' },
	},
	required: [
		'projectId',
		'documentId',
		'revision',
		'title',
		'path',
		'start',
		'end',
		'line',
		'quote',
	],
};

const scopeSchema = {
	type: 'object',
	description: 'Explicit project or series scope; project scope must name the open project.',
	properties: {
		kind: {
			type: 'string',
			enum: ['project', 'series'],
			description: 'Whether this fact belongs to one project or a selected series.',
		},
		id: { type: 'string', description: 'Exact project or series identifier.' },
	},
	required: ['kind', 'id'],
};

export const storyFactSchema = {
	type: 'object',
	properties: {
		id: { type: 'string', description: 'Stable fact identifier.' },
		scope: scopeSchema,
		kind: {
			type: 'string',
			description: 'character, alias, location, world-rule or chronology.',
		},
		subject: {
			type: 'string',
			description: 'Canonical entity name; alias facts name the canonical entity.',
		},
		predicate: {
			type: 'string',
			description:
				'Attribute name; use alias for alias facts and consistent names for comparable attributes.',
		},
		value: {
			type: 'string',
			description: 'Attribute value, or alternate name for an alias fact.',
		},
		confidence: {
			type: 'string',
			description: 'Author-confirmed canon, inferred candidate or uncertain interpretation.',
		},
		sources: {
			type: 'array',
			description: 'Verified quoted passages supporting this fact.',
			items: sourcePassageSchema,
		},
		storyTime: {
			type: 'string',
			description: 'Explicit story-time key; binder order is not story chronology.',
		},
		intentional: {
			type: 'boolean',
			description:
				'Author-marked intentional variation, excluded from contradiction findings.',
		},
		supersedes: { type: 'string', description: 'Previous fact replaced by this correction.' },
		updatedAt: { type: 'string', description: 'Time the fact was curated or corrected.' },
		stale: {
			type: 'boolean',
			description: 'A supporting source changed or is unavailable when rechecked.',
		},
		sourceStates: {
			type: 'array',
			description: 'Per-passage saved source revision check.',
			items: {
				type: 'object',
				properties: {
					source: {
						...sourcePassageSchema,
						description: 'Originally captured supporting passage.',
					},
					state: { type: 'string', description: 'current, stale or unavailable.' },
				},
				required: ['source', 'state'],
			},
		},
	},
	required: [
		'id',
		'scope',
		'kind',
		'subject',
		'predicate',
		'value',
		'confidence',
		'sources',
		'updatedAt',
	],
};

export const continuityFindingSchema = {
	type: 'object',
	properties: {
		id: {
			type: 'string',
			description: 'Persistent finding identity tied to the source revisions.',
		},
		type: { type: 'string', description: 'Continuity category.' },
		severity: { type: 'string', description: 'error, warning or info.' },
		documentId: {
			type: 'string',
			description: 'Primary document identity in the open manuscript.',
		},
		description: {
			type: 'string',
			description: 'Competing statements and why they need review.',
		},
		suggestion: { type: 'string', description: 'Suggested author review action.' },
		confidence: {
			type: 'string',
			description: 'Confirmed canon conflict or inferred candidate mismatch.',
		},
		status: { type: 'string', description: 'open, confirmed, dismissed or resolved.' },
		evidence: {
			type: 'array',
			description: 'Quoted revision-bound passages supporting this finding.',
			items: sourcePassageSchema,
		},
		factIds: {
			type: 'array',
			description: 'Compared fact or inferred candidate identifiers.',
			items: { type: 'string' },
		},
		order: {
			type: 'number',
			description:
				'Binder order of the primary document, never assumed to be story chronology.',
		},
		stale: {
			type: 'boolean',
			description: 'Sources changed or became unavailable since capture.',
		},
		basis: { type: 'string', description: 'canon-conflict or candidate-mismatch.' },
		createdAt: { type: 'string', description: 'When this finding was first persisted.' },
		updatedAt: {
			type: 'string',
			description: 'When the author last changed its review state.',
		},
		checkedAt: { type: 'string', description: 'When source revisions were last checked.' },
		note: { type: 'string', description: 'Optional author review note.' },
		resolution: { type: 'string', description: 'Author decision or later recheck resolution.' },
		seriesId: {
			type: 'string',
			description:
				'Explicitly selected series context used for this finding, when applicable.',
		},
	},
	required: [
		'id',
		'type',
		'severity',
		'documentId',
		'description',
		'suggestion',
		'confidence',
		'status',
		'evidence',
		'factIds',
		'order',
		'stale',
		'basis',
		'createdAt',
		'updatedAt',
		'checkedAt',
	],
};

function result(data: Record<string, unknown>): HandlerResult {
	return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

function scopeArg(args: Record<string, unknown>): StoryScope {
	const value = args.scope;
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('An explicit scope object is required');
	const scope = value as Record<string, unknown>;
	if (!['project', 'series'].includes(String(scope.kind)) || typeof scope.id !== 'string')
		throw new Error('Scope requires kind project or series and a string id');
	return { kind: scope.kind as StoryScope['kind'], id: scope.id };
}

const seriesSchema = {
	type: 'object',
	properties: {
		id: {
			type: 'string',
			description: 'Series id shared when explicitly joining another project.',
		},
		name: { type: 'string', description: 'Curated series name.' },
		projects: {
			type: 'array',
			description: 'Projects explicitly selected as members.',
			items: {
				type: 'object',
				properties: {
					projectId: { type: 'string', description: 'Stable project identity.' },
					projectPath: { type: 'string', description: 'Registered local project path.' },
				},
				required: ['projectId', 'projectPath'],
			},
		},
		createdAt: { type: 'string', description: 'Creation timestamp.' },
		updatedAt: { type: 'string', description: 'Membership change timestamp.' },
	},
	required: ['id', 'name', 'projects', 'createdAt', 'updatedAt'],
};

export const manageSeriesHandler: ToolDefinition = {
	name: 'manage_series',
	title: 'Select Story Series Projects',
	description:
		'Create a persistent shared story bible series, explicitly join or leave it with the open project, or list series containing this project. Joining is opt-in and does not import unrelated manuscripts or promote memory to canon.',
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true,
	},
	inputSchema: {
		type: 'object',
		properties: {
			action: {
				type: 'string',
				enum: ['create', 'join', 'leave', 'list'],
				description: 'Membership operation; create includes the current project.',
			},
			name: {
				type: 'string',
				description: 'Series name required for create, at most 200 characters.',
			},
			seriesId: {
				type: 'string',
				description: 'Exact existing series id required for join or leave.',
			},
		},
		required: ['action'],
	},
	outputSchema: {
		type: 'object',
		properties: {
			series: {
				type: 'array',
				description: 'Series records affected by the operation.',
				items: seriesSchema,
			},
			projectId: { type: 'string', description: 'Stable identity of the open project.' },
		},
		required: ['series', 'projectId'],
	},
	handler: async (args, context) => {
		const { bible, source } = requireProject(context).getEditorialServices();
		const action = getStringArg(args, 'action');
		if (action === 'list')
			return result({ series: bible.listSeries(), projectId: source.projectId });
		if (action === 'create')
			return result({
				series: [bible.createSeries(getStringArg(args, 'name'))],
				projectId: source.projectId,
			});
		if (action === 'join')
			return result({
				series: [bible.joinSeries(getStringArg(args, 'seriesId'))],
				projectId: source.projectId,
			});
		if (action === 'leave')
			return result({
				series: [bible.leaveSeries(getStringArg(args, 'seriesId'))],
				projectId: source.projectId,
			});
		throw new Error('Unknown series membership action');
	},
};

export const storyBibleHandler: ToolDefinition = {
	name: 'story_bible',
	title: 'Curate Scoped Story Bible',
	description:
		'Read, curate, correct and recheck characters, aliases, locations, world rules and chronology within an explicit project or selected series scope. Canon requires verified manuscript quotations. Corrections preserve prior facts and provenance; legacy memory imports remain inferred candidates.',
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
				enum: ['list', 'curate', 'correct', 'recheck', 'import_memory'],
				description:
					'Bible operation; legacy memory imports support only current project scope.',
			},
			scope: scopeSchema,
			fact: {
				type: 'object',
				description: 'Fact to curate; scope comes from the top-level scope argument.',
				properties: {
					id: {
						type: 'string',
						description: 'Optional caller-supplied stable id for idempotent creation.',
					},
					kind: {
						type: 'string',
						enum: ['character', 'alias', 'location', 'world-rule', 'chronology'],
						description: 'Story entity or rule category.',
					},
					subject: {
						type: 'string',
						description: 'Canonical subject name, at most 200 characters.',
					},
					predicate: {
						type: 'string',
						description:
							'Comparable attribute name; use alias for aliases, at most 200 characters.',
					},
					value: {
						type: 'string',
						description: 'Attribute value or alternate name, at most 2000 characters.',
					},
					confidence: {
						type: 'string',
						enum: ['confirmed', 'inferred', 'uncertain'],
						description:
							'Author confirmation or candidate confidence; defaults to inferred.',
					},
					sources: {
						type: 'array',
						description:
							'At most 32 verified quotations; confirmed canon requires at least one.',
						items: sourcePassageSchema,
					},
					storyTime: {
						type: 'string',
						description: 'Explicit story-time key for comparable states.',
					},
					intentional: {
						type: 'boolean',
						description:
							'Mark an intentional variation to exclude it from contradiction findings.',
					},
				},
				required: ['kind', 'subject', 'predicate', 'value', 'sources'],
			},
			factId: { type: 'string', description: 'Existing fact id required for correction.' },
			patch: {
				type: 'object',
				description:
					'Correction fields: subject, predicate, value, confidence, sources, storyTime or intentional. Unspecified fields keep their current value.',
			},
			includeSuperseded: {
				type: 'boolean',
				description: 'Include historical corrected facts when listing; defaults to false.',
			},
		},
		required: ['action', 'scope'],
	},
	outputSchema: {
		type: 'object',
		properties: {
			facts: {
				type: 'array',
				description:
					'Curated or inspected facts with provenance and source checks when available.',
				items: storyFactSchema,
			},
			current: {
				type: 'number',
				description: 'Facts with current sources, when rechecking.',
			},
			stale: {
				type: 'number',
				description: 'Facts with changed source revisions, when rechecking.',
			},
			unavailable: {
				type: 'number',
				description: 'Facts with unavailable source documents, when rechecking.',
			},
		},
		required: ['facts'],
	},
	handler: async (args, context) => {
		const { bible, source } = requireProject(context).getEditorialServices();
		const scope = scopeArg(args);
		const action = getStringArg(args, 'action');
		if (action === 'list') {
			if (args.includeSuperseded !== undefined && typeof args.includeSuperseded !== 'boolean')
				throw new Error('includeSuperseded must be a boolean');
			return result({
				facts: await bible.listFacts(scope, {
					includeSuperseded: args.includeSuperseded === true,
				}),
			});
		}
		if (action === 'recheck') return result(await bible.recheck(scope));
		if (action === 'curate') {
			if (!args.fact || typeof args.fact !== 'object' || Array.isArray(args.fact))
				throw new Error('A fact object is required');
			return result({
				facts: [
					await bible.curate({ ...(args.fact as Omit<CurateFactInput, 'scope'>), scope }),
				],
			});
		}
		if (action === 'correct') {
			if (!args.patch || typeof args.patch !== 'object' || Array.isArray(args.patch))
				throw new Error('A correction patch is required');
			return result({
				facts: [
					await bible.correct(
						scope,
						getStringArg(args, 'factId'),
						args.patch as FactCorrection
					),
				],
			});
		}
		if (action === 'import_memory') {
			if (scope.kind !== 'project' || scope.id !== source.projectId)
				throw new Error(
					'Legacy memory imports require current project scope; curate selected facts explicitly into a series'
				);
			return result({ facts: await bible.importMemory(requireMemoryManager(context)) });
		}
		throw new Error('Unknown story bible action');
	},
};

export const continuityFindingsHandler: ToolDefinition = {
	name: 'continuity_findings',
	title: 'Review Evidence-Based Continuity Findings',
	description:
		'List persistent continuity findings with quoted source passages, confirm a concern, dismiss an intentional variation, resolve it, or rerun local analysis and recheck saved source revisions. Finding confirmation records the author review decision; it does not promote inferred narrative statements to confirmed story facts.',
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			action: {
				type: 'string',
				enum: ['list', 'confirm', 'dismiss', 'resolve', 'recheck'],
				description: 'Finding review or source revision recheck operation.',
			},
			findingId: {
				type: 'string',
				description:
					'Required for confirm, dismiss or resolve; optional for rechecking one finding.',
			},
			note: { type: 'string', description: 'Author decision note, at most 2000 characters.' },
			includeResolved: {
				type: 'boolean',
				description: 'Include dismissed and resolved findings when listing.',
			},
		},
		required: ['action'],
	},
	outputSchema: {
		type: 'object',
		properties: {
			findings: {
				type: 'array',
				description: 'Findings in binder order with evidence and review state.',
				items: continuityFindingSchema,
			},
		},
		required: ['findings'],
	},
	handler: async (args, context) => {
		const { continuity } = requireProject(context).getEditorialServices();
		const action = getStringArg(args, 'action');
		if (action === 'list') {
			if (args.includeResolved !== undefined && typeof args.includeResolved !== 'boolean')
				throw new Error('includeResolved must be a boolean');
			return result({
				findings: continuity.list({ includeResolved: args.includeResolved === true }),
			});
		}
		if (action === 'recheck')
			return result({
				findings: await continuity.recheck(getOptionalStringArg(args, 'findingId')),
			});
		if (action === 'confirm' || action === 'dismiss' || action === 'resolve') {
			const id = getStringArg(args, 'findingId');
			if (action === 'confirm') await continuity.recheck(id);
			return result({
				findings: [continuity.transition(id, action, getOptionalStringArg(args, 'note'))],
			});
		}
		throw new Error('Unknown continuity finding action');
	},
};

export const storyHandlers = [manageSeriesHandler, storyBibleHandler];
export const continuityHandlers = [continuityFindingsHandler];
