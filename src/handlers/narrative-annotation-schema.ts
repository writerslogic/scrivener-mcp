// Generated from Narrative Lens v0.2.0 standalone.schema.json (SHA-256 3d7e5eb4c47d645571d7146b133e75cb7cb1434f9fa2fd3338ccffab5e694b90).
// Regenerate with scripts/generate-narrative-annotation-schema.mjs; do not edit by hand.
import type { ToolDefinition } from './types.js';
export const annotationInputSchema: ToolDefinition['inputSchema'] = {
	type: 'object',
	additionalProperties: false,
	properties: {
		kind: {
			type: 'string',
			enum: [
				'causality',
				'knowledge',
				'epistemics',
				'reader',
				'promises',
				'subtext',
				'themes',
				'coreference',
				'uncertainty',
				'history',
			],
			description: 'Annotation analysis mode selecting the required nested input contract.',
		},
		input: {
			type: 'object',
			description:
				'Select the matching kind branch; all nested native contracts are defined below.',
		},
	},
	required: ['kind', 'input'],
	allOf: [
		{
			if: {
				properties: {
					kind: {
						const: 'causality',
					},
				},
				required: ['kind'],
			},
			then: {
				properties: {
					input: {
						type: 'object',
						additionalProperties: false,
						properties: {
							nodes: {
								items: {
									$ref: '#/$defs/AuthorCausalNode',
								},
								type: 'array',
								maxItems: 4096,
							},
							interventions: {
								items: {
									$ref: '#/$defs/AuthorIntervention',
								},
								type: 'array',
								maxItems: 4096,
							},
						},
						required: ['nodes', 'interventions'],
					},
				},
			},
		},
		{
			if: {
				properties: {
					kind: {
						const: 'knowledge',
					},
				},
				required: ['kind'],
			},
			then: {
				properties: {
					input: {
						type: 'object',
						additionalProperties: false,
						properties: {
							propositions: {
								items: {
									$ref: '#/$defs/AuthorProposition',
								},
								type: 'array',
								maxItems: 4096,
							},
							events: {
								items: {
									$ref: '#/$defs/AuthorKnowledgeEvent',
								},
								type: 'array',
								maxItems: 4096,
							},
						},
						required: ['propositions', 'events'],
					},
				},
			},
		},
		{
			if: {
				properties: {
					kind: {
						const: 'epistemics',
					},
				},
				required: ['kind'],
			},
			then: {
				properties: {
					input: {
						type: 'object',
						additionalProperties: false,
						properties: {
							propositions: {
								items: {
									$ref: '#/$defs/AuthorProposition',
								},
								type: 'array',
								maxItems: 4096,
							},
							events: {
								items: {
									$ref: '#/$defs/AuthorKnowledgeEvent',
								},
								type: 'array',
								maxItems: 4096,
							},
							queries: {
								items: {
									$ref: '#/$defs/AuthorEpistemicQuery',
								},
								type: 'array',
								maxItems: 4096,
							},
						},
						required: ['propositions', 'events', 'queries'],
					},
				},
			},
		},
		{
			if: {
				properties: {
					kind: {
						const: 'reader',
					},
				},
				required: ['kind'],
			},
			then: {
				properties: {
					input: {
						type: 'object',
						additionalProperties: false,
						properties: {
							propositions: {
								items: {
									$ref: '#/$defs/AuthorProposition',
								},
								type: 'array',
								maxItems: 4096,
							},
							events: {
								items: {
									$ref: '#/$defs/AuthorKnowledgeEvent',
								},
								type: 'array',
								maxItems: 4096,
							},
						},
						required: ['propositions', 'events'],
					},
				},
			},
		},
		{
			if: {
				properties: {
					kind: {
						const: 'promises',
					},
				},
				required: ['kind'],
			},
			then: {
				properties: {
					input: {
						type: 'object',
						additionalProperties: false,
						properties: {
							events: {
								items: {
									$ref: '#/$defs/AuthorPromiseEvent',
								},
								type: 'array',
								maxItems: 4096,
							},
						},
						required: ['events'],
					},
				},
			},
		},
		{
			if: {
				properties: {
					kind: {
						const: 'subtext',
					},
				},
				required: ['kind'],
			},
			then: {
				properties: {
					input: {
						type: 'object',
						additionalProperties: false,
						properties: {
							annotations: {
								items: {
									$ref: '#/$defs/AuthorSubtextAnnotation',
								},
								type: 'array',
								maxItems: 4096,
							},
						},
						required: ['annotations'],
					},
				},
			},
		},
		{
			if: {
				properties: {
					kind: {
						const: 'themes',
					},
				},
				required: ['kind'],
			},
			then: {
				properties: {
					input: {
						type: 'object',
						additionalProperties: false,
						properties: {
							theses: {
								items: {
									$ref: '#/$defs/AuthorThematicThesis',
								},
								type: 'array',
								maxItems: 4096,
							},
							annotations: {
								items: {
									$ref: '#/$defs/AuthorThematicAnnotation',
								},
								type: 'array',
								maxItems: 4096,
							},
						},
						required: ['theses', 'annotations'],
					},
				},
			},
		},
		{
			if: {
				properties: {
					kind: {
						const: 'coreference',
					},
				},
				required: ['kind'],
			},
			then: {
				properties: {
					input: {
						type: 'object',
						additionalProperties: false,
						properties: {
							links: {
								items: {
									$ref: '#/$defs/AuthorCoreferenceLink',
								},
								type: 'array',
								maxItems: 4096,
							},
						},
						required: ['links'],
					},
				},
			},
		},
		{
			if: {
				properties: {
					kind: {
						const: 'uncertainty',
					},
				},
				required: ['kind'],
			},
			then: {
				properties: {
					input: {
						type: 'object',
						additionalProperties: false,
						properties: {
							observations: {
								items: {
									$ref: '#/$defs/SuppliedUncertainty',
								},
								type: 'array',
								maxItems: 4096,
							},
						},
						required: ['observations'],
					},
				},
			},
		},
		{
			if: {
				properties: {
					kind: {
						const: 'history',
					},
				},
				required: ['kind'],
			},
			then: {
				properties: {
					input: {
						type: 'object',
						additionalProperties: false,
						properties: {
							catalogue: {
								items: {
									$ref: '#/$defs/HistoricalEntry',
								},
								type: 'array',
								maxItems: 4096,
							},
							usages: {
								items: {
									$ref: '#/$defs/HistoricalUsage',
								},
								type: 'array',
								maxItems: 4096,
							},
							targetYear: {
								type: 'integer',
								minimum: -2147483648,
								maximum: 2147483647,
								description: 'Signed year; BCE years are negative.',
							},
							toleranceYears: {
								type: 'integer',
								minimum: 0,
								maximum: 4294967295,
							},
						},
						required: ['catalogue', 'usages', 'targetYear', 'toleranceYears'],
					},
				},
			},
		},
	],
	$defs: {
		AuthorCausalMechanism: {
			oneOf: [
				{
					additionalProperties: false,
					properties: {
						kind: {
							const: 'fixed',
							type: 'string',
						},
						value: {
							type: 'boolean',
						},
					},
					required: ['kind', 'value'],
					type: 'object',
				},
				{
					additionalProperties: false,
					properties: {
						kind: {
							const: 'all',
							type: 'string',
						},
						parents: {
							items: {
								type: 'string',
							},
							type: 'array',
						},
					},
					required: ['kind', 'parents'],
					type: 'object',
				},
				{
					additionalProperties: false,
					properties: {
						kind: {
							const: 'any',
							type: 'string',
						},
						parents: {
							items: {
								type: 'string',
							},
							type: 'array',
						},
					},
					required: ['kind', 'parents'],
					type: 'object',
				},
				{
					additionalProperties: false,
					properties: {
						kind: {
							const: 'not',
							type: 'string',
						},
						parent: {
							type: 'string',
						},
					},
					required: ['kind', 'parent'],
					type: 'object',
				},
			],
		},
		AuthorCausalNode: {
			additionalProperties: false,
			properties: {
				evidence: {
					$ref: '#/$defs/AuthorSource',
				},
				id: {
					type: 'string',
				},
				mechanism: {
					$ref: '#/$defs/AuthorCausalMechanism',
				},
			},
			required: ['id', 'mechanism', 'evidence'],
			type: 'object',
		},
		AuthorSource: {
			additionalProperties: false,
			properties: {
				quote: {
					type: 'string',
				},
				sceneId: {
					type: 'string',
				},
				utf16End: {
					minimum: 0,
					type: 'integer',
					maximum: 4294967295,
				},
				utf16Start: {
					minimum: 0,
					type: 'integer',
					maximum: 4294967295,
				},
			},
			required: ['sceneId', 'utf16Start', 'utf16End', 'quote'],
			type: 'object',
		},
		AuthorIntervention: {
			additionalProperties: false,
			properties: {
				nodeId: {
					type: 'string',
				},
				value: {
					type: 'boolean',
				},
			},
			required: ['nodeId', 'value'],
			type: 'object',
		},
		AuthorProposition: {
			additionalProperties: false,
			properties: {
				description: {
					type: 'string',
				},
				evidence: {
					$ref: '#/$defs/AuthorSource',
				},
				id: {
					type: 'string',
				},
				truth: {
					$ref: '#/$defs/TruthValue',
				},
			},
			required: ['id', 'description', 'truth', 'evidence'],
			type: 'object',
		},
		TruthValue: {
			enum: ['true', 'false', 'unknown'],
			type: 'string',
		},
		AuthorAudience: {
			oneOf: [
				{
					additionalProperties: false,
					properties: {
						kind: {
							const: 'reader',
							type: 'string',
						},
					},
					required: ['kind'],
					type: 'object',
				},
				{
					additionalProperties: false,
					properties: {
						characterId: {
							type: 'string',
						},
						kind: {
							const: 'character',
							type: 'string',
						},
					},
					required: ['kind', 'characterId'],
					type: 'object',
				},
			],
		},
		AuthorKnowledgeAction: {
			oneOf: [
				{
					additionalProperties: false,
					properties: {
						kind: {
							const: 'truth',
							type: 'string',
						},
						value: {
							$ref: '#/$defs/TruthValue',
						},
					},
					required: ['kind', 'value'],
					type: 'object',
				},
				{
					additionalProperties: false,
					properties: {
						actor: {
							$ref: '#/$defs/AuthorAudience',
						},
						kind: {
							const: 'know',
							type: 'string',
						},
						value: {
							type: 'boolean',
						},
					},
					required: ['kind', 'actor', 'value'],
					type: 'object',
				},
				{
					additionalProperties: false,
					properties: {
						actor: {
							$ref: '#/$defs/AuthorAudience',
						},
						kind: {
							const: 'believe',
							type: 'string',
						},
						value: {
							type: 'boolean',
						},
					},
					required: ['kind', 'actor', 'value'],
					type: 'object',
				},
				{
					additionalProperties: false,
					properties: {
						actor: {
							$ref: '#/$defs/AuthorAudience',
						},
						kind: {
							const: 'uncertain',
							type: 'string',
						},
					},
					required: ['kind', 'actor'],
					type: 'object',
				},
				{
					additionalProperties: false,
					properties: {
						actor: {
							$ref: '#/$defs/AuthorAudience',
						},
						kind: {
							const: 'forget',
							type: 'string',
						},
					},
					required: ['kind', 'actor'],
					type: 'object',
				},
				{
					additionalProperties: false,
					properties: {
						kind: {
							const: 'communicate',
							type: 'string',
						},
						recipient: {
							$ref: '#/$defs/AuthorAudience',
						},
						sender: {
							$ref: '#/$defs/AuthorAudience',
						},
						uptake: {
							$ref: '#/$defs/AuthorUptake',
						},
						value: {
							type: 'boolean',
						},
					},
					required: ['kind', 'sender', 'recipient', 'value', 'uptake'],
					type: 'object',
				},
			],
		},
		AuthorKnowledgeEvent: {
			additionalProperties: false,
			properties: {
				action: {
					$ref: '#/$defs/AuthorKnowledgeAction',
				},
				evidence: {
					$ref: '#/$defs/AuthorSource',
				},
				id: {
					type: 'string',
				},
				propositionId: {
					type: 'string',
				},
				sequence: {
					minimum: 0,
					type: 'integer',
					maximum: 4294967295,
				},
			},
			required: ['id', 'sequence', 'propositionId', 'action', 'evidence'],
			type: 'object',
		},
		AuthorUptake: {
			enum: ['unchanged', 'belief', 'knowledge'],
			type: 'string',
		},
		AuthorEpistemicQuery: {
			additionalProperties: false,
			properties: {
				atSequence: {
					minimum: 0,
					type: ['integer', 'null'],
					maximum: 4294967295,
				},
				id: {
					type: 'string',
				},
				observer: {
					$ref: '#/$defs/AuthorAudience',
				},
				propositionId: {
					type: 'string',
				},
				subject: {
					$ref: '#/$defs/AuthorAudience',
				},
			},
			required: ['id', 'propositionId', 'observer', 'subject'],
			type: 'object',
		},
		AuthorPromiseEvent: {
			oneOf: [
				{
					additionalProperties: false,
					properties: {
						description: {
							type: 'string',
						},
						evidence: {
							$ref: '#/$defs/AuthorSource',
						},
						id: {
							type: 'string',
						},
						kind: {
							const: 'setup',
							type: 'string',
						},
					},
					required: ['kind', 'id', 'description', 'evidence'],
					type: 'object',
				},
				{
					additionalProperties: false,
					properties: {
						evidence: {
							$ref: '#/$defs/AuthorSource',
						},
						id: {
							type: 'string',
						},
						kind: {
							const: 'resolution',
							type: 'string',
						},
						outcome: {
							$ref: '#/$defs/AuthorResolution',
						},
						setupId: {
							type: 'string',
						},
					},
					required: ['kind', 'id', 'setupId', 'outcome', 'evidence'],
					type: 'object',
				},
			],
		},
		AuthorResolution: {
			enum: ['fulfilled', 'partial', 'subverted', 'abandoned'],
			type: 'string',
		},
		AuthorSubtextAnnotation: {
			additionalProperties: false,
			properties: {
				characters: {
					default: [],
					items: {
						type: 'string',
					},
					type: 'array',
				},
				id: {
					type: 'string',
				},
				implied: {
					type: 'string',
				},
				resolution: {
					anyOf: [
						{
							$ref: '#/$defs/AuthorSource',
						},
						{
							type: 'null',
						},
					],
					default: null,
				},
				subtextType: {
					$ref: '#/$defs/SubtextType',
				},
				surface: {
					$ref: '#/$defs/AuthorSource',
				},
			},
			required: ['id', 'surface', 'implied', 'subtextType'],
			type: 'object',
		},
		SubtextType: {
			enum: [
				'EmotionalDenial',
				'PowerPlay',
				'SelfDeception',
				'CodedCommunication',
				'DramaticIronySubtext',
				'Deflection',
				'VerbalIrony',
				'ActionContradiction',
			],
			type: 'string',
		},
		AuthorThematicThesis: {
			additionalProperties: false,
			properties: {
				id: {
					type: 'string',
				},
				opposes: {
					default: [],
					items: {
						type: 'string',
					},
					type: 'array',
				},
				statement: {
					type: 'string',
				},
			},
			required: ['id', 'statement'],
			type: 'object',
		},
		AuthorThematicAnnotation: {
			additionalProperties: false,
			properties: {
				delivery: {
					$ref: '#/$defs/EvidenceDelivery',
				},
				id: {
					type: 'string',
				},
				source: {
					$ref: '#/$defs/AuthorSource',
				},
				thesisId: {
					type: 'string',
				},
				valence: {
					$ref: '#/$defs/EvidenceValence',
				},
			},
			required: ['id', 'thesisId', 'source', 'valence', 'delivery'],
			type: 'object',
		},
		EvidenceDelivery: {
			oneOf: [
				{
					enum: ['Narration'],
					type: 'string',
				},
				{
					additionalProperties: false,
					properties: {
						CharacterAction: {
							properties: {
								character: {
									type: 'string',
								},
								decision: {
									type: 'string',
								},
							},
							required: ['character', 'decision'],
							type: 'object',
						},
					},
					required: ['CharacterAction'],
					type: 'object',
				},
				{
					additionalProperties: false,
					properties: {
						PlotConsequence: {
							properties: {
								cause: {
									type: 'string',
								},
							},
							required: ['cause'],
							type: 'object',
						},
					},
					required: ['PlotConsequence'],
					type: 'object',
				},
				{
					additionalProperties: false,
					properties: {
						Dialogue: {
							properties: {
								speaker: {
									type: 'string',
								},
							},
							required: ['speaker'],
							type: 'object',
						},
					},
					required: ['Dialogue'],
					type: 'object',
				},
				{
					additionalProperties: false,
					properties: {
						Symbolism: {
							properties: {
								symbol: {
									type: 'string',
								},
							},
							required: ['symbol'],
							type: 'object',
						},
					},
					required: ['Symbolism'],
					type: 'object',
				},
				{
					additionalProperties: false,
					properties: {
						StructuralParallel: {
							properties: {
								parallel_scene: {
									minimum: 0,
									type: 'integer',
									maximum: 9007199254740991,
								},
							},
							required: ['parallel_scene'],
							type: 'object',
						},
					},
					required: ['StructuralParallel'],
					type: 'object',
				},
				{
					additionalProperties: false,
					properties: {
						StructuralParallelById: {
							properties: {
								scene_id: {
									type: 'string',
								},
							},
							required: ['scene_id'],
							type: 'object',
						},
					},
					required: ['StructuralParallelById'],
					type: 'object',
				},
			],
		},
		EvidenceValence: {
			enum: ['Supporting', 'Contradicting', 'Complicating', 'Transcending'],
			type: 'string',
		},
		AuthorCoreferenceLink: {
			additionalProperties: false,
			properties: {
				antecedent: {
					$ref: '#/$defs/AuthorSource',
				},
				characterId: {
					type: 'string',
				},
				id: {
					type: 'string',
				},
				mention: {
					$ref: '#/$defs/AuthorSource',
				},
			},
			required: ['id', 'mention', 'antecedent', 'characterId'],
			type: 'object',
		},
		HypothesisProbability: {
			additionalProperties: false,
			properties: {
				id: {
					type: 'string',
				},
				probability: {
					type: 'number',
				},
			},
			required: ['id', 'probability'],
			type: 'object',
		},
		SuppliedUncertainty: {
			additionalProperties: false,
			properties: {
				outcomes: {
					items: {
						$ref: '#/$defs/HypothesisProbability',
					},
					type: 'array',
				},
				questionId: {
					type: 'string',
				},
				sceneId: {
					type: 'string',
				},
			},
			required: ['questionId', 'sceneId', 'outcomes'],
			type: 'object',
		},
		HistoricalBasis: {
			enum: ['first_attestation', 'availability', 'author_constraint'],
			type: 'string',
		},
		HistoricalEntry: {
			additionalProperties: false,
			properties: {
				basis: {
					$ref: '#/$defs/HistoricalBasis',
				},
				context: {
					type: 'string',
				},
				earliestYear: {
					type: 'integer',
					minimum: -2147483648,
					maximum: 2147483647,
				},
				id: {
					type: 'string',
				},
				reference: {
					type: 'string',
				},
				senseAmbiguous: {
					type: 'boolean',
				},
				term: {
					type: 'string',
				},
			},
			required: [
				'id',
				'term',
				'earliestYear',
				'basis',
				'reference',
				'context',
				'senseAmbiguous',
			],
			type: 'object',
		},
		HistoricalUsage: {
			additionalProperties: false,
			properties: {
				entryId: {
					type: 'string',
				},
				evidence: {
					$ref: '#/$defs/AuthorSource',
				},
				id: {
					type: 'string',
				},
			},
			required: ['id', 'entryId', 'evidence'],
			type: 'object',
		},
	},
};
