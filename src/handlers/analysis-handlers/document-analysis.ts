import { AIDocumentAnalyzer } from '../../analysis/ai-document-analyzer.js';
import { createError, ErrorCode } from '../../core/errors.js';
import type { EnhancementType } from '../../services/enhancements/content-enhancer.js';
import { AIContentEnhancer } from '../../services/enhancements/ai-content-enhancer.js';
import { AIClient } from '../../services/ai/ai-client.js';
import { validateInput } from '../../utils/common.js';
import { getAccurateWordCount } from '../../utils/text-metrics.js';
import { compact, formatError } from '../../core/response-formatter.js';
import type { HandlerResult, ToolDefinition } from '../types.js';
import {
	getOptionalNumberArg,
	getOptionalObjectArg,
	getPersonalization,
	getStringArg,
	requireProject,
} from '../types.js';
import { SHARED_DEFS } from '../shared-schemas.js';
import { analysisSchema, enhancementSchema, promptSchema } from '../validation-schemas.js';

// Cached singleton instances to avoid re-instantiation per request
let cachedContentEnhancer: AIContentEnhancer | null = null;

async function getContentEnhancer(): Promise<AIContentEnhancer> {
	if (!cachedContentEnhancer) {
		cachedContentEnhancer = new AIContentEnhancer();
	}
	return cachedContentEnhancer;
}

export const analyzeDocumentHandler: ToolDefinition = {
	name: 'analyze_document',
	title: 'Analyze Document',
	description:
		'Analyze the writing quality of a single document and return a summary of readability, pacing, ' +
		'and the top issues found. This is the general-purpose prose analyzer: narrow it with ' +
		'analysisTypes to focus on style, structure, themes, characters, sentiment, or pacing. Use ' +
		'check_consistency for project-wide continuity instead, or enhance_content to get rewritten ' +
		'prose rather than a critique. Calls an external AI model. Requires an open project and a ' +
		'valid document id.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	inputSchema: {
		type: 'object',
		properties: {
			documentId: SHARED_DEFS.docId,
			analysisTypes: {
				type: 'array',
				items: {
					type: 'string',
					enum: [
						'readability',
						'sentiment',
						'themes',
						'characters',
						'pacing',
						'style',
						'structure',
						'all',
					],
				},
				description:
					'Aspects to focus the analysis on. Omit or use ["all"] for a broad analysis; ' +
					'otherwise pick any of readability, sentiment, themes, characters, pacing, style, ' +
					'structure.',
			},
		},
		required: ['documentId'],
	},
	outputSchema: {
		type: 'object',
		properties: {
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
							type: 'string',
							description: 'Issue severity when known (low/medium/high).',
						},
					},
					required: ['description'],
				},
			},
		},
		required: ['readability', 'pacing', 'issues'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		validateInput(args, analysisSchema);

		const documentId = getStringArg(args, 'documentId');

		const document = await project.getDocument(documentId);
		if (!document) {
			throw createError(ErrorCode.NOT_FOUND, 'Document not found');
		}

		try {
			// Perform qualitative analysis with Claude (direct SDK)
			const analyzer = new AIDocumentAnalyzer();
			const analysis = await analyzer.analyzeDocument(document.content || '');

			const { readability, pacing, issues } = analysis;
			const topIssues = issues.slice(0, 3).map((i) => i.description);

			const summary = `Summary: readability=${readability}, pacing=${pacing}, issues=${issues.length}\n${
				topIssues.length > 0
					? `Top issues:\n${topIssues.map((t) => `- ${t}`).join('\n')}\n`
					: ''
			}[Full analysis available via deep_analyze_content]`;

			return {
				content: [
					{
						type: 'text',
						text: summary,
					},
				],
				structuredContent: { readability, pacing, issues },
			};
		} catch {
			// Fallback to basic analysis if AI enhancement fails
			const fallbackAnalysis = await context.contentAnalyzer.analyzeContent(
				document.content || '',
				documentId
			);
			const fb = fallbackAnalysis as unknown as Record<string, unknown>;
			const readability = fb.readability ?? fb.readabilityScore ?? '?';
			const pacing = fb.pacing ?? '?';
			const issues = Array.isArray(fb.issues) ? fb.issues : [];
			const topIssues = issues
				.slice(0, 3)
				.map((i: unknown) =>
					typeof i === 'string'
						? i
						: ((i as Record<string, unknown>).description ?? JSON.stringify(i))
				);

			const summary = `Summary: readability=${readability}, pacing=${pacing}, issues=${issues.length}\n${
				topIssues.length > 0
					? `Top issues:\n${topIssues.map((t: unknown) => `- ${t}`).join('\n')}\n`
					: ''
			}[Full analysis available via deep_analyze_content]`;

			return {
				content: [
					{
						type: 'text',
						text: summary,
					},
				],
				structuredContent: {
					readability: String(readability),
					pacing: String(pacing),
					issues: issues.map((i: unknown) =>
						typeof i === 'string'
							? { description: i }
							: {
									description: String(
										(i as Record<string, unknown>).description ??
											JSON.stringify(i)
									),
								}
					),
				},
			};
		}
	},
};

export const enhanceContentHandler: ToolDefinition = {
	name: 'enhance_content',
	title: 'Enhance Content',
	description:
		"Produce an AI-improved version of a document's text for a chosen goal (fix grammar, refine " +
		'style, improve clarity, expand, summarize, or rework creatively) and return the suggested ' +
		'rewrite. This does NOT modify the document; review the result and call write_document to ' +
		'save it. Use analyze_document for a critique instead of a rewrite, or generate_content to ' +
		'create new text from a prompt. Calls an external AI model. Requires an open project.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true,
	},
	inputSchema: {
		type: 'object',
		properties: {
			documentId: SHARED_DEFS.docId,
			enhancementType: {
				type: 'string',
				enum: ['grammar', 'style', 'clarity', 'expand', 'summarize', 'creative'],
				description:
					'The improvement goal: "grammar" fixes errors, "style" refines voice, "clarity" ' +
					'simplifies, "expand" lengthens, "summarize" condenses, "creative" reworks freely.',
			},
			options: {
				type: 'object',
				description: 'Optional enhancement parameters passed through to the enhancer.',
			},
		},
		required: ['documentId', 'enhancementType'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		validateInput(args, enhancementSchema);

		const documentId = getStringArg(args, 'documentId');
		const enhancementType = getStringArg(args, 'enhancementType') as EnhancementType;
		const options = getOptionalObjectArg(args, 'options');

		const document = await project.getDocument(documentId);
		if (!document) {
			throw createError(ErrorCode.NOT_FOUND, 'Document not found');
		}

		try {
			// Initialize AI content enhancer
			const enhancer = await getContentEnhancer();

			// Apply author writing preferences to the AI prompt
			const personalization = getPersonalization(context);
			const preferenceDirective = await personalization.buildDirective();

			// Perform enhanced content improvement
			const enhanced = await enhancer.enhance({
				content: document.content || '',
				type: enhancementType,
				preferenceDirective,
				options: {
					...(options || {}),
					documentId,
					context: `Document: ${document.title} (Type: ${document.type})`,
				},
			});

			const originalContent = document.content || '';
			if (enhanced.enhanced === originalContent) {
				return {
					content: [{ type: 'text', text: 'No changes suggested.' }],
				};
			}

			return {
				content: [
					{
						type: 'text',
						text: compact({
							...enhanced,
							enhanced: true,
							qualityScore: enhanced.qualityValidation?.overallScore,
						}),
					},
				],
			};
		} catch (error) {
			// Fallback to basic enhancement if AI enhancement fails
			const enhanced = await context.contentEnhancer.enhance({
				content: document.content || '',
				type: enhancementType,
				options: options || {},
			});

			const originalContent = document.content || '';
			if (enhanced.enhanced === originalContent) {
				return {
					content: [{ type: 'text', text: 'No changes suggested.' }],
				};
			}

			return {
				content: [
					{
						type: 'text',
						text: compact({
							...enhanced,
							enhanced: false,
							fallbackReason: formatError(error),
						}),
					},
				],
			};
		}
	},
};

export const generateContentHandler: ToolDefinition = {
	name: 'generate_content',
	title: 'Generate Content',
	description:
		'Generate new prose from a natural-language prompt and return the generated text, optionally ' +
		'steered by project context (a document, characters, or a target style) and a desired length. ' +
		'This creates fresh text and does not modify any document. Use enhance_content to improve ' +
		'existing text instead, or analyze_document to critique it. Uses a configured AI provider ' +
		'or client-side MCP sampling when available. Unavailable or failed generation returns ' +
		'an error; local-only privacy settings remain enforced.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true,
	},
	inputSchema: {
		type: 'object',
		properties: {
			prompt: {
				type: 'string',
				description: 'Natural-language instruction describing the content to generate.',
			},
			context: {
				type: 'object',
				description: 'Optional project context to steer generation.',
				properties: {
					documentId: {
						type: 'string',
						description: 'Id of a document to use as surrounding context.',
					},
					characterIds: {
						type: 'array',
						items: { type: 'string' },
						description:
							'Ids of characters the generated content should be consistent with.',
					},
					style: { type: 'string', description: 'Target writing style or voice.' },
				},
			},
			length: {
				type: 'number',
				description: 'Approximate target length in words. Default 500.',
			},
		},
		required: ['prompt'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		validateInput(args, promptSchema);

		try {
			const prompt = getStringArg(args, 'prompt');

			const ai = new AIClient();

			if (!ai.isAvailable) {
				return {
					isError: true,
					content: [
						{
							type: 'text',
							text:
								process.env.SCRIVENER_LOCAL_ONLY === 'true'
									? 'Content generation is disabled in local-only mode. Local analysis and review remain available. To enable generation, explicitly change your privacy and provider settings.'
									: 'Content generation is unavailable. Configure ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY in the server environment, or connect an MCP client with sampling enabled. No prose was generated.',
						},
					],
				};
			}

			const length = getOptionalNumberArg(args, 'length') || 500;
			const contextData = (getOptionalObjectArg(args, 'context') || {}) as {
				style?: string;
				documentId?: string;
				characterIds?: string[];
			};
			const style = contextData.style || 'creative';
			const contextInfo = contextData.documentId
				? `\n\nMaintain consistency with document ${contextData.documentId}${
						contextData.characterIds?.length
							? ` and characters: ${contextData.characterIds.join(', ')}`
							: ''
					}`
				: '';

			const directive = await getPersonalization(context).buildDirective();
			const directiveSuffix = directive ? `\n\n${directive}` : '';
			const system =
				`You are a creative writing assistant. Write ${style} prose of approximately ` +
				`${length} words in response to the request. Return only the prose, no preamble.${contextInfo}${directiveSuffix}`;
			const content = await ai.chat(prompt, {
				system,
				temperature: 0.8,
				maxTokens: Math.min(4096, Math.max(256, Math.round(length * 2))),
			});
			if (!content.trim())
				return {
					isError: true,
					content: [
						{
							type: 'text',
							text: 'The selected AI provider or MCP client returned no prose. Check its model settings and the generation request before trying again. No manuscript changes were made.',
						},
					],
				};
			const generated = {
				content,
				wordCount: getAccurateWordCount(content),
				type: 'creative',
				suggestions: [],
				alternativeVersions: [],
			};

			return {
				content: [
					{
						type: 'text',
						text: compact(generated),
					},
				],
			};
		} catch {
			return {
				isError: true,
				content: [
					{
						type: 'text',
						text: 'Content generation failed. Check the selected provider or MCP client, model access, account quota and connection. No prose was returned and no manuscript changes were made.',
					},
				],
			};
		}
	},
};
