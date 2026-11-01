import { setImmediate, setTimeout } from 'node:timers/promises';
import type { ToolDefinition } from './types.js';
import { getStringArg, getOptionalStringArg, requireProject } from './types.js';
import type { NarrativeControls } from '../services/editorial/narrative-analysis.js';
import type { NARRATIVE_ANNOTATIONS } from '../services/editorial/narrative-analysis.js';

import { reportPageOptions } from '../services/editorial/report-transport.js';
import { NARRATIVE_RESULT_SCHEMA } from './shared-schemas.js';
import { annotationInputSchema } from './narrative-annotation-schema.js';

export const manuscriptAnalysisHandlers: ToolDefinition[] = [
	{
		name: 'analyze_manuscript_local',
		title: 'Analyze Manuscript with Narrative Lens',
		description:
			'Analyze the saved manuscript locally with Narrative Lens: evidence-located findings, coverage, author intentions, chronology and revision comparisons. Use capabilities to discover supported rules, configure to replace project author controls, and analyze with saveAs to retain a baseline or baseline to compare revisions. Use accept_finding or dismiss_finding with baseline and findingId to record a disposition; recheck_finding compares it with a current baseline. read_report continues immutable paginated results. This tool never edits manuscript text. Models are not downloaded.',
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				action: {
					type: 'string',
					enum: [
						'capabilities',
						'controls',
						'configure',
						'analyze',
						'read_baseline',
						'delete_baseline',
						'read_report',
						'accept_finding',
						'dismiss_finding',
						'recheck_finding',
					],
					description: 'Operation to perform; analyze is the default.',
				},
				controls: {
					type: 'object',
					additionalProperties: false,
					description:
						'Replacement project author controls, validated by Narrative Lens.',
					properties: {
						configuration: {
							type: 'object',
							description:
								'Narrative Lens configuration: genre, thresholds, limits, dictionary, lexicon, rules, suppressions, entityCorrections, minimumSeverity, structureTemplate, chronology, nli and modelRevision. Use capabilities for rule IDs. Unknown fields are rejected.',
						},
						scenes: {
							type: 'object',
							description:
								'Binder UUID to scene controls: purpose, intentions, chronology {key,lane}, chronologyLane. Scene text and identity come from saved project files.',
						},
						knownCharacters: {
							type: 'array',
							maxItems: 256,
							items: { type: 'string', maxLength: 128 },
							description:
								'Explicit cast names for continuity. Names are validated by Narrative Lens.',
						},
					},
				},
				reportId: {
					type: 'string',
					pattern: '^[a-f0-9]{64}$',
					description:
						'Immutable report identity returned by a prior page; use read_report to continue without reanalysis.',
				},
				findingId: {
					type: 'string',
					description: 'Finding ID returned with a manuscript report.',
				},
				note: {
					type: 'string',
					maxLength: 4096,
					description:
						'Optional author note saved when accepting or dismissing a finding.',
				},
				pageCursor: {
					type: 'string',
					description:
						'Opaque continuation cursor. Concatenate json-fragment data in page order, then JSON.parse once to recover the complete report.',
				},
				pageByteLimit: {
					type: 'integer',
					minimum: 16384,
					maximum: 4194304,
					description:
						'Serialized MCP result byte limit for report pages, 16384 to 4194304. Default 1048576.',
				},
				baseline: {
					type: 'string',
					maxLength: 128,
					description: 'Project-local baseline name to compare, read or delete.',
				},
				saveAs: {
					type: 'string',
					maxLength: 128,
					description:
						'Save the current analysis as this named baseline; explicitly replaces an existing name.',
				},
			},
		},
		outputSchema: NARRATIVE_RESULT_SCHEMA,
		handler: async (args, context, options) => {
			const service = requireProject(context).getEditorialServices().narrative;
			const action = getOptionalStringArg(args, 'action') ?? 'analyze';
			const page = reportPageOptions(args);
			if (action !== 'read_report' && (page.start !== 0 || args.reportId !== undefined))
				throw new Error(
					'Use read_report with reportId and pageCursor to continue a report'
				);
			let result: object;
			switch (action) {
				case 'capabilities':
					result = await service.capabilities(options);
					break;
				case 'controls':
					result = service.controls();
					break;
				case 'configure': {
					if (
						!args.controls ||
						typeof args.controls !== 'object' ||
						Array.isArray(args.controls)
					)
						throw new Error('controls must be an object');
					result = await service.setControls(args.controls as NarrativeControls, options);
					break;
				}
				case 'read_report':
					// Back-to-back continuation requests must allow cancellation and I/O to run.
					await setImmediate(undefined, { signal: options?.signal });
					return service.transport.page(action, args);
				case 'analyze': {
					const serialized = await service.serializedAnalysis({
						baseline: getOptionalStringArg(args, 'baseline'),
						saveAs: getOptionalStringArg(args, 'saveAs'),
						signal: options?.signal,
					});
					// Separate report serialization and page indexing into distinct event-loop turns.
					await setTimeout(0, undefined, { signal: options?.signal });
					return service.transport.pageSerialized(action, args, serialized);
				}
				case 'read_baseline':
					result = service.baseline(getStringArg(args, 'baseline'));
					break;
				case 'accept_finding':
				case 'dismiss_finding':
					result = await service.recordFindingDecision(
						action === 'accept_finding' ? 'accept' : 'dismiss',
						getStringArg(args, 'baseline'),
						getStringArg(args, 'findingId'),
						getOptionalStringArg(args, 'note'),
						options
					);
					break;
				case 'recheck_finding':
					result = await service.recheckFinding(
						getStringArg(args, 'findingId'),
						getStringArg(args, 'baseline'),
						options
					);
					break;
				case 'delete_baseline':
					service.deleteBaseline(getStringArg(args, 'baseline'));
					result = { deleted: true };
					break;
				default:
					throw new Error('Unknown narrative analysis action');
			}
			return service.transport.page(action, args, result);
		},
	},
	{
		name: 'analyze_narrative_annotations',
		title: 'Analyze Author Narrative Evidence',
		description:
			'Evaluate explicit author-supplied causal mechanisms, character/reader knowledge, promises, subtext, thematic evidence, coreference, uncertainty or historical catalogue usages against exact saved manuscript quotations using Narrative Lens. This is not automatic inference of author intent. Source references use sceneId (binder UUID), utf16Start, utf16End and quote. Native validation rejects invalid evidence. No provider or manuscript mutation.',
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		inputSchema: annotationInputSchema,
		outputSchema: NARRATIVE_RESULT_SCHEMA,
		handler: async (args, context, options) => {
			const kind = getStringArg(args, 'kind') as keyof typeof NARRATIVE_ANNOTATIONS;
			const result = await requireProject(context)
				.getEditorialServices()
				.narrative.annotations(kind, args.input as Record<string, unknown>, options);
			return requireProject(context)
				.getEditorialServices()
				.narrative.transport.page('annotations', {}, result);
		},
	},
];
