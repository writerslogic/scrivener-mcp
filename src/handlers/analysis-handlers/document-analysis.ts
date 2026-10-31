import { analysisEnvelope } from '../../services/editorial/analysis-envelope.js';
import { checkGrammar } from 'narrative-lens';
import type { DocumentAnalysis } from '../../analysis/ai-document-analyzer.js';
import {
	AIDocumentAnalyzer,
	DOCUMENT_ANALYSIS_TYPES,
	documentAnalysisTypes,
	MAX_DOCUMENT_ANALYSIS_SOURCE,
} from '../../analysis/ai-document-analyzer.js';
import { storyText } from '../../services/editorial/provenance.js';
import { formatPayload } from '../../core/response-formatter.js';
import type { HandlerResult, ToolDefinition } from '../types.js';
import { requireProject } from '../types.js';
import { ANALYSIS_ENVELOPE_SCHEMA, RESULT_REFERENCE_SCHEMA } from '../shared-schemas.js';
export { enhanceContentHandler } from './content-enhancement.js';
export { generateContentHandler } from './content-generation.js';

export const analyzeDocumentHandler: ToolDefinition = {
	name: 'analyze_document',
	title: 'Analyze Document',
	description:
		'Analyze complete saved document text with revision checks. Readability and pacing are always assessed; analysisTypes steers provider craft issues. Provider input is limited to 12000 UTF-16 characters. Empty or longer text, unavailable providers and malformed responses use broad local analysis with explicit availability and focus scope. Raw local results do not apply saved manuscript intentions or suppressions. Independent grammar findings survive local analyzer failure. Large results use read_result. Requires an open project; no document is changed.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	inputSchema: {
		type: 'object',
		additionalProperties: false,
		properties: {
			documentId: {
				type: 'string',
				description:
					'Saved document UUID from get_structure; its complete decoded text is analyzed.',
				minLength: 1,
				maxLength: 128,
				pattern: '^[^\\u0000]*[^\\s\\u0000][^\\u0000]*$',
			},
			analysisTypes: {
				type: 'array',
				minItems: 1,
				maxItems: DOCUMENT_ANALYSIS_TYPES.length,
				uniqueItems: true,
				items: {
					type: 'string',
					enum: [...DOCUMENT_ANALYSIS_TYPES],
				},
				description:
					'Provider issue focus. Omit or include all for a broad critique. Local fallback preserves its broad findings and explicitly reports that scope.',
			},
		},
		required: ['documentId'],
	},
	outputSchema: {
		type: 'object',
		oneOf: [
			{
				type: 'object',
				properties: {
					envelope: ANALYSIS_ENVELOPE_SCHEMA,
					focus: {
						type: 'object',
						description:
							'Requested critique topics and whether they guided a provider or broad local analysis.',
						additionalProperties: false,
						properties: {
							requested: {
								type: 'array',
								description:
									'Normalized requested topics; all subsumes other topics and is the default.',
								minItems: 1,
								maxItems: DOCUMENT_ANALYSIS_TYPES.length,
								uniqueItems: true,
								items: { enum: [...DOCUMENT_ANALYSIS_TYPES] },
							},
							scope: {
								enum: ['provider-instructions', 'broad-local'],
								description:
									'Provider instructions apply the requested focus; broad-local preserves all available fallback findings.',
							},
						},
						required: ['requested', 'scope'],
					},
					coverage: {
						type: 'object',
						description:
							'Complete saved-text range analyzed; source text is never silently truncated.',
						additionalProperties: false,
						properties: {
							start: {
								const: 0,
								description: 'Inclusive UTF-16 start offset of the analyzed text.',
							},
							end: {
								type: 'integer',
								minimum: 0,
								description: 'Exclusive UTF-16 end offset of the analyzed text.',
							},
							sourceCharacters: {
								type: 'integer',
								minimum: 0,
								description: 'UTF-16 length of the complete saved document text.',
							},
							truncated: {
								const: false,
								description:
									'Always false because provider and fallback paths assess the complete source.',
							},
						},
						required: ['start', 'end', 'sourceCharacters', 'truncated'],
					},
					availability: {
						type: 'object',
						description:
							'Independent provider, local analysis and grammar availability, including missing metrics.',
						additionalProperties: false,
						properties: {
							provider: {
								enum: ['available', 'unavailable'],
								description:
									'Whether a complete, validated provider critique was returned.',
							},
							providerReason: {
								enum: [null, 'empty_source', 'source_limit', 'provider_failed'],
								description:
									'Null on provider success; otherwise identifies empty input, input over the provider limit, or provider failure.',
							},
							local: {
								enum: ['available', 'unavailable', 'not_requested'],
								description:
									'Whether broad local fallback completed; not_requested when the provider succeeded.',
							},
							grammar: {
								enum: ['available', 'unavailable', 'not_requested'],
								description:
									'Whether the independent native grammar fallback completed; not_requested when the provider succeeded.',
							},
							unavailable: {
								type: 'array',
								description:
									'Unavailable analysis components or metrics, with local metric paths prefixed by local.',
								uniqueItems: true,
								items: { type: 'string' },
							},
						},
						required: ['provider', 'providerReason', 'local', 'grammar', 'unavailable'],
					},
					readability: {
						type: 'string',
						description:
							'Readability assessment of the passage (e.g. easy/moderate/complex with a brief reason).',
					},
					pacing: {
						type: 'string',
						description:
							'Pacing assessment of the passage (e.g. slow/steady/fast with a brief reason).',
					},
					issues: {
						type: 'array',
						description: 'Craft issues found in the document.',
						items: {
							type: 'object',
							properties: {
								description: { type: 'string', description: 'What the issue is.' },
								severity: {
									enum: ['low', 'medium', 'high'],
									description: 'Issue severity when known (low/medium/high).',
								},
							},
							required: ['description'],
						},
					},
				},
				required: [
					'readability',
					'pacing',
					'issues',
					'envelope',
					'focus',
					'coverage',
					'availability',
				],
			},
			RESULT_REFERENCE_SCHEMA,
		],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		if (Object.keys(args).some((key) => !['documentId', 'analysisTypes'].includes(key)))
			throw new Error('Unsupported analysis argument');
		const documentId = storyText(args.documentId, 'Document identifier', 128);
		const analysisTypes = documentAnalysisTypes(args.analysisTypes);
		const project = requireProject(context);

		const source = project.getEditorialServices().source;
		const document = await source.read(documentId);
		if (context.project !== project)
			throw new Error('Selected project changed during document analysis');
		let analysis: DocumentAnalysis;
		let mode: 'provider' | 'raw' = 'provider';
		let local: Awaited<ReturnType<typeof context.contentAnalyzer.analyzeContent>> | undefined;
		let nativeFindings: ReturnType<typeof checkGrammar> | undefined;
		const unavailable: string[] = [];
		let localStatus: 'available' | 'unavailable' | 'not_requested' = 'not_requested';
		let grammarStatus: 'available' | 'unavailable' | 'not_requested' = 'not_requested';
		try {
			analysis = await new AIDocumentAnalyzer().analyzeDocument(document.text, analysisTypes);
		} catch {
			mode = 'raw';
			unavailable.push('provider');
			analysis = { readability: 'unavailable', pacing: 'unavailable', issues: [] };
			try {
				local = await context.contentAnalyzer.analyzeContent(document.text, documentId);
				localStatus = 'available';
				unavailable.push(...(local.unavailable ?? []).map((field) => `local.${field}`));
				const { fleschReadingEase: ease, fleschKincaidGrade: grade } = local.metrics;
				const measured = (value: number | null): value is number =>
					typeof value === 'number' && Number.isFinite(value);
				const readability =
					[
						measured(ease) ? `Flesch ${ease.toFixed(1)}` : '',
						measured(grade) ? `grade ${grade.toFixed(1)}` : '',
					]
						.filter(Boolean)
						.join(', ') || 'unavailable';
				const issues: DocumentAnalysis['issues'] = local.suggestions.map((item) => ({
					description: [item.issue, item.suggestion].filter(Boolean).join(': '),
					severity:
						item.severity === 'major'
							? 'high'
							: item.severity === 'moderate'
								? 'medium'
								: 'low',
				}));
				analysis = { readability, pacing: local.pacing.overall, issues };
			} catch {
				localStatus = 'unavailable';
				unavailable.push('local');
			}
			try {
				nativeFindings = checkGrammar(document.text);
				grammarStatus = 'available';
				analysis.issues = analysis.issues.concat(
					nativeFindings.map((finding) => ({ description: finding.message }))
				);
			} catch {
				grammarStatus = 'unavailable';
				unavailable.push('grammar');
			}
			if (analysis.readability === 'unavailable') unavailable.push('readability');
			if (analysis.pacing === 'unavailable') unavailable.push('pacing');
		}
		if ((await source.read(documentId)).revision !== document.revision)
			throw new Error('Saved source changed during document analysis');
		if (context.project !== project)
			throw new Error('Selected project changed during document analysis');
		const envelope = analysisEnvelope(source.projectId, 'document', [document], {}, mode, {
			analysisTypes,
		});
		envelope.policy.revisionChecked = true;
		envelope.policy.providerAccess =
			Boolean(document.text.trim()) && document.text.length <= MAX_DOCUMENT_ANALYSIS_SOURCE;
		const { readability, pacing, issues } = analysis;
		const text = `Summary: readability=${readability}, pacing=${pacing}, issues=${issues.length}\n${issues
			.slice(0, 3)
			.map((issue) => `- ${issue.description}`)
			.join('\n')}`;
		const data = {
			...analysis,
			envelope,
			focus: {
				requested: analysisTypes,
				scope: mode === 'provider' ? 'provider-instructions' : 'broad-local',
			},
			coverage: {
				start: 0,
				end: document.text.length,
				sourceCharacters: document.text.length,
				truncated: false,
			},
			availability: {
				provider: mode === 'provider' ? 'available' : 'unavailable',
				providerReason:
					mode === 'provider'
						? null
						: !document.text.trim()
							? 'empty_source'
							: document.text.length > MAX_DOCUMENT_ANALYSIS_SOURCE
								? 'source_limit'
								: 'provider_failed',
				local: localStatus,
				grammar: grammarStatus,
				unavailable,
			},
			...(local ? { local } : {}),
			...(nativeFindings ? { nativeFindings } : {}),
		};
		const formatted = formatPayload(data, 'analysis');
		const structuredContent = JSON.parse(formatted) as Record<string, unknown>;
		return {
			content: [{ type: 'text', text: structuredContent._ref ? formatted : text }],
			structuredContent,
		};
	},
};
