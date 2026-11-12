import { formatPayload } from '../../core/response-formatter.js';
import { analysisEnvelope } from '../../services/editorial/analysis-envelope.js';
import { storyText } from '../../services/editorial/provenance.js';
import {
	AIContentEnhancer,
	ENHANCEMENT_INSTRUCTIONS,
	ENHANCEMENT_OPTION_VALUES,
	EnhancementUnavailableError,
	MAX_ENHANCEMENT_SOURCE,
	MAX_ENHANCEMENT_RESULT,
	UNAVAILABLE_ENHANCEMENT_FIELDS,
	enhancementOptions,
} from '../../services/enhancements/ai-content-enhancer.js';
import { ANALYSIS_ENVELOPE_SCHEMA, RESULT_REFERENCE_SCHEMA } from '../shared-schemas.js';
import {
	getPersonalization,
	requireProject,
	type HandlerResult,
	type ToolDefinition,
} from '../types.js';

const optionsSchema = {
	type: 'object',
	description:
		'Optional rewrite preferences and background context, combined with saved author preferences.',
	additionalProperties: false,
	properties: {
		...Object.fromEntries(
			Object.entries(ENHANCEMENT_OPTION_VALUES).map(([key, values]) => [
				key,
				{ enum: [...values] },
			])
		),
		length: {
			oneOf: [
				{ enum: [...ENHANCEMENT_OPTION_VALUES.length] },
				{ type: 'integer', minimum: 1, maximum: 4000 },
			],
			description:
				'Relative length or target word count; provider output limits still apply.',
		},
		preserveDialogue: { type: 'boolean' },
		preserveNames: { type: 'boolean' },
		context: {
			type: 'string',
			maxLength: 2000,
			pattern: '^[^\\u0000]*$',
			description: 'Background data supplied separately from editing instructions.',
		},
	},
};

export const enhanceContentHandler: ToolDefinition = {
	name: 'enhance_content',
	title: 'Enhance Content',
	description:
		'Return a proposed rewrite of one complete saved document, with source revisions and exact input coverage. Supports grammar, style, clarity, expansion, summary and creative revision. Requires 1–12000 UTF-16 characters; longer documents must be split before rewriting. Applies explicit options and author preferences. Provider failure or incomplete output is unavailable. No document is changed; review the rewrite before applying it. Changed saved inputs reject the result; large results use read_result.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true,
	},
	inputSchema: {
		type: 'object',
		additionalProperties: false,
		properties: {
			documentId: {
				type: 'string',
				description:
					'Saved document UUID from get_structure; the complete text must fit the enhancement source limit.',
				minLength: 1,
				maxLength: 128,
				pattern: '^[^\\u0000]*[^\\s\\u0000][^\\u0000]*$',
			},
			enhancementType: {
				enum: Object.keys(ENHANCEMENT_INSTRUCTIONS),
				description:
					'Requested rewrite operation: grammar, style, clarity, expansion, summary or creative revision.',
			},
			options: optionsSchema,
		},
		required: ['documentId', 'enhancementType'],
	},
	outputSchema: {
		type: 'object',
		$defs: { AnalysisEnvelope: ANALYSIS_ENVELOPE_SCHEMA },
		oneOf: [
			{
				type: 'object',
				additionalProperties: false,
				properties: {
					documentId: {
						type: 'string',
						description:
							'Saved document UUID whose revision was checked before returning the rewrite.',
					},
					original: {
						type: 'string',
						minLength: 1,
						maxLength: MAX_ENHANCEMENT_SOURCE,
						description: 'Complete decoded saved text submitted for rewriting.',
					},
					enhanced: {
						type: 'string',
						minLength: 1,
						maxLength: MAX_ENHANCEMENT_RESULT,
						description:
							'Complete proposed rewrite returned by the provider; not applied to the document.',
					},
					changed: {
						type: 'boolean',
						description: 'Whether the proposed rewrite differs from the original text.',
					},
					changes: {
						type: 'null',
						description:
							'Unavailable: this operation does not produce a verified edit list.',
					},
					suggestions: {
						type: 'null',
						description:
							'Unavailable: the provider returns a rewrite without separate suggestions.',
					},
					qualityValidation: {
						type: 'null',
						description:
							'Unavailable: no independent quality validation of the rewrite is performed.',
					},
					metrics: {
						type: 'object',
						description:
							'Native measurements of original and revised prose; failed measurements remain null.',
						additionalProperties: false,
						properties: {
							originalWordCount: {
								type: ['integer', 'null'],
								minimum: 0,
								description:
									'Native word count of the original text, or null when unavailable.',
							},
							enhancedWordCount: {
								type: ['integer', 'null'],
								minimum: 0,
								description:
									'Native word count of the proposed rewrite, or null when unavailable.',
							},
							readabilityChange: {
								type: ['number', 'null'],
								description:
									'Native Flesch reading-ease difference, revised minus original; unavailable when either measurement fails.',
							},
							changesApplied: {
								type: 'null',
								description:
									'Unavailable: edits are not enumerated or applied by this operation.',
							},
						},
						required: [
							'originalWordCount',
							'enhancedWordCount',
							'readabilityChange',
							'changesApplied',
						],
					},
					availability: {
						type: 'object',
						description:
							'Explicitly identifies unmeasured metadata and failed native measurements.',
						additionalProperties: false,
						properties: {
							status: {
								const: 'partial',
								description:
									'A rewrite is available, but edit lists and independent quality validation are not.',
							},
							unavailableFields: {
								type: 'array',
								description:
									'Result field paths returned as null because no measurement or assessment is available.',
								uniqueItems: true,
								maxItems: 7,
								items: {
									enum: [
										...UNAVAILABLE_ENHANCEMENT_FIELDS,
										'metrics.originalWordCount',
										'metrics.enhancedWordCount',
										'metrics.readabilityChange',
									],
								},
							},
						},
						required: ['status', 'unavailableFields'],
					},
					coverage: {
						type: 'object',
						description:
							'Complete decoded source range and text digest used for this rewrite.',
						additionalProperties: false,
						properties: {
							start: {
								const: 0,
								description: 'Inclusive UTF-16 start offset of the source text.',
							},
							end: {
								type: 'integer',
								minimum: 1,
								maximum: MAX_ENHANCEMENT_SOURCE,
								description:
									'Exclusive UTF-16 end offset of the complete source text.',
							},
							sourceCharacters: {
								type: 'integer',
								minimum: 1,
								maximum: MAX_ENHANCEMENT_SOURCE,
								description:
									'UTF-16 length of the complete decoded saved document text.',
							},
							sourceRevision: {
								type: 'string',
								pattern: '^[a-f0-9]{64}$',
								description:
									'SHA-256 of complete decoded text; envelope revisions identify saved RTF.',
							},
							truncated: {
								const: false,
								description:
									'Always false because enhancement requires the complete source to fit its limit.',
							},
						},
						required: [
							'start',
							'end',
							'sourceCharacters',
							'sourceRevision',
							'truncated',
						],
					},
					envelope: {
						$ref: '#/$defs/AnalysisEnvelope',
						description: ANALYSIS_ENVELOPE_SCHEMA.description,
					},
				},
				required: [
					'documentId',
					'original',
					'enhanced',
					'changed',
					'changes',
					'suggestions',
					'qualityValidation',
					'metrics',
					'availability',
					'coverage',
					'envelope',
				],
			},
			{
				type: 'object',
				additionalProperties: false,
				properties: {
					documentId: {
						type: 'string',
						description: 'Saved document UUID whose rewrite was unavailable.',
					},
					enhanced: {
						type: 'null',
						description: 'No complete rewrite was returned by the provider.',
					},
					availability: {
						type: 'object',
						description: 'Explicit provider failure status for an unavailable rewrite.',
						additionalProperties: false,
						properties: {
							status: {
								const: 'unavailable',
								description: 'No usable complete rewrite is available.',
							},
							reason: {
								const: 'provider_failed',
								description:
									'The provider failed or returned empty, incomplete or oversized output.',
							},
						},
						required: ['status', 'reason'],
					},
					envelope: {
						$ref: '#/$defs/AnalysisEnvelope',
						description: ANALYSIS_ENVELOPE_SCHEMA.description,
					},
				},
				required: ['documentId', 'enhanced', 'availability', 'envelope'],
			},
			RESULT_REFERENCE_SCHEMA,
		],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		if (
			Object.keys(args).some(
				(key) => !['documentId', 'enhancementType', 'options'].includes(key)
			)
		)
			throw new Error('Unsupported enhancement argument');
		const documentId = storyText(args.documentId, 'Document identifier', 128);
		if (
			typeof args.enhancementType !== 'string' ||
			!Object.prototype.hasOwnProperty.call(ENHANCEMENT_INSTRUCTIONS, args.enhancementType)
		)
			throw new Error('Unsupported enhancement type');
		const type = args.enhancementType as keyof typeof ENHANCEMENT_INSTRUCTIONS;
		const options = enhancementOptions(args.options);
		const { source } = requireProject(context).getEditorialServices();
		const document = await source.read(documentId);
		const preferenceDirective = await getPersonalization(context).buildDirective();
		const envelope = analysisEnvelope(
			source.projectId,
			'document',
			[document],
			{},
			'provider',
			{
				operation: 'enhance_content',
				type,
				options,
				preferenceDirective,
			}
		);
		let result: Record<string, unknown>;
		let failed = false;
		try {
			result = await new AIContentEnhancer().enhance({
				content: document.text,
				type,
				options,
				preferenceDirective,
			});
		} catch (error) {
			if (!(error instanceof EnhancementUnavailableError)) throw error;
			failed = true;
			result = {
				enhanced: null,
				availability: { status: 'unavailable', reason: 'provider_failed' },
			};
		}
		if ((await source.read(documentId)).revision !== document.revision)
			throw new Error('Saved source changed during enhancement');
		envelope.policy.revisionChecked = true;
		const text = formatPayload({ documentId, ...result, envelope }, 'enhancement');
		return {
			...(failed ? { isError: true } : {}),
			content: [{ type: 'text', text }],
			structuredContent: JSON.parse(text),
		};
	},
};
