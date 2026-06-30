/**
 * Content analysis and AI enhancement handlers
 */

import { AIDocumentAnalyzer } from '../analysis/ai-document-analyzer.js';
import { createError, ErrorCode } from '../core/errors.js';
import type {
	CharacterProfile,
	MemoryManager,
	PlotThread,
	ProjectMemory,
	StyleGuide,
} from '../memory-manager.js';
import type { EnhancementType } from '../services/enhancements/content-enhancer.js';
import { AIContentEnhancer } from '../services/enhancements/ai-content-enhancer.js';
import { OpenAIService } from '../services/openai-service.js';
import type { ScrivenerDocument } from '../types/index.js';
import { validateInput } from '../utils/common.js';
import { LangChainContinuousLearningHandler } from './langchain-continuous-learning-handler.js';

// Cached singleton instances to avoid re-instantiation per request
let cachedContentEnhancer: AIContentEnhancer | null = null;
let cachedAnalysisLearningHandler: LangChainContinuousLearningHandler | null = null;

async function getContentEnhancer(): Promise<AIContentEnhancer> {
	if (!cachedContentEnhancer) {
		cachedContentEnhancer = new AIContentEnhancer();
	}
	return cachedContentEnhancer;
}

async function getAnalysisLearningHandler(): Promise<LangChainContinuousLearningHandler> {
	if (!cachedAnalysisLearningHandler) {
		cachedAnalysisLearningHandler = new LangChainContinuousLearningHandler();
		await cachedAnalysisLearningHandler.initialize();
	}
	return cachedAnalysisLearningHandler;
}
import { compact } from '../core/response-formatter.js';
import type { HandlerResult, ToolDefinition } from './types.js';
import {
	getObjectArg,
	getOptionalArrayArg,
	getOptionalNumberArg,
	getOptionalObjectArg,
	getStringArg,
	requireMemoryManager,
	requireProject,
} from './types.js';
import { SHARED_DEFS } from './shared-schemas.js';
import {
	analysisSchema,
	enhancementSchema,
	memorySchema,
	promptSchema,
} from './validation-schemas.js';

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
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		validateInput(args, analysisSchema);

		const documentId = getStringArg(args, 'documentId');
		const analysisTypes = (args.analysisTypes as string[]) || ['all'];

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
			};
		} catch (error) {
			// Fallback to basic analysis if LangChain fails
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
			// Initialize LangChain content enhancer
			const langChainEnhancer = await getContentEnhancer();

			// Initialize continuous learning for feedback collection
			const learningHandler = await getAnalysisLearningHandler();

			const sessionId = `enhance_${documentId}_${Date.now()}`;
			await learningHandler.startFeedbackSession(sessionId);

			// Perform enhanced content improvement using LangChain
			const enhanced = await langChainEnhancer.enhance({
				content: document.content || '',
				type: enhancementType,
				options: {
					...(options || {}),
					documentId,
					context: `Document: ${document.title} (Type: ${document.type})`,
				},
			});

			// Collect implicit feedback based on enhancement success
			await learningHandler.collectImplicitFeedback(sessionId, 'enhance_content', {
				timeSpent: enhanced.metrics?.processingTime || 0,
				userActions: ['enhance_content'],
				enhancementType,
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
							langChainProcessed: true,
							sessionId,
							qualityScore: enhanced.qualityValidation?.overallScore,
						}),
					},
				],
			};
		} catch (error) {
			// Fallback to basic enhancement if LangChain fails
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
							fallbackReason: (error as Error).message,
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
		'existing text instead, or analyze_document to critique it. Calls an external AI model and ' +
		'requires OPENAI_API_KEY; without it a placeholder is returned.',
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
	handler: async (args, _context): Promise<HandlerResult> => {
		validateInput(args, promptSchema);

		try {
			// Extract prompt first
			const prompt = getStringArg(args, 'prompt');

			// Get OpenAI API key from environment
			const apiKey = process.env.OPENAI_API_KEY;

			if (!apiKey) {
				// Return enhanced placeholder when no API key is available
				const length = getOptionalNumberArg(args, 'length') || 500;
				const context = getOptionalObjectArg(args, 'context');
				const generated = {
					content: `AI-Generated Content for: "${prompt}"\n\nThis is placeholder content. To enable actual AI content generation, please configure your OpenAI API key in the environment variables.\n\nThe generated content would be tailored to your specifications:\n- Length: ${length} words\n- Context: ${context ? JSON.stringify(context, null, 2) : 'None provided'}`,
					wordCount: Math.max(50, Math.floor(length * 0.3)),
					type: 'creative',
					suggestions: [
						'Configure OpenAI API key to enable AI content generation',
						'Consider expanding on character motivations',
						'Add more sensory details to enhance immersion',
					],
					alternativeVersions: [
						'Try a different narrative perspective',
						"Explore the scene from another character's viewpoint",
					],
				};

				return {
					content: [
						{
							type: 'text',
							text: compact(generated),
						},
					],
				};
			}

			// Initialize OpenAI service
			const openaiService = new OpenAIService({ apiKey });

			// Extract context information
			const length = getOptionalNumberArg(args, 'length');
			const contextData = (getOptionalObjectArg(args, 'context') || {}) as {
				style?: string;
				documentId?: string;
				characterIds?: string[];
			};
			const style = contextData.style || 'creative';
			const contextInfo = contextData.documentId
				? `Document context: ${contextData.documentId}\nCharacters: ${(contextData.characterIds || []).join(', ')}`
				: '';

			// Generate content using AI
			const generated = await openaiService.generateContent(prompt, {
				length,
				style: style as 'narrative' | 'dialogue' | 'descriptive' | 'academic' | 'creative',
				context: contextInfo,
			});

			return {
				content: [
					{
						type: 'text',
						text: compact(generated),
					},
				],
			};
		} catch {
			// Fallback to placeholder if AI generation fails
			const generated = {
				content: `Generated content based on prompt: "${args.prompt}"\n\nNote: AI content generation encountered an error. This is placeholder content. Please check your OpenAI API configuration.`,
				wordCount: args.length || 500,
				type: 'creative',
				suggestions: [
					'Check OpenAI API key configuration',
					'Verify network connectivity',
					'Consider expanding on character motivations',
				],
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
		}
	},
};

export const updateMemoryHandler: ToolDefinition = {
	name: 'remember',
	title: 'Remember Project Facts',
	description:
		"Store or update a fact in the project's persistent memory so later tools and sessions stay " +
		'consistent: a character profile, world-building detail, plot thread, or style-guide entry. ' +
		'Pass an id inside data to update an existing entry, or omit it to add a new one. Use recall ' +
		'to read memory back. Requires an open project.',
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			memoryType: {
				type: 'string',
				enum: ['characters', 'worldBuilding', 'plotThreads', 'styleGuide', 'all'],
				description:
					'Which memory store to write to: "characters", "worldBuilding", "plotThreads", ' +
					'"styleGuide", or "all" for arbitrary custom context.',
			},
			data: {
				type: 'object',
				description:
					'The entry to store. Include an "id" field to update an existing entry; omit it to ' +
					'create a new one.',
			},
		},
		required: ['memoryType', 'data'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const memoryManager = requireMemoryManager(context);
		validateInput(args, memorySchema);

		// Update memory based on type
		const memoryType = getStringArg(args, 'memoryType');
		const data = getObjectArg(args, 'data') as Record<string, unknown>;

		switch (memoryType) {
			case 'characters':
				if (data.id) {
					await memoryManager.updateCharacter(data.id as string, data);
				} else {
					await memoryManager.addCharacter(data as Omit<CharacterProfile, 'id'>);
				}
				break;
			case 'plotThreads':
				if (data.id) {
					await memoryManager.updatePlotThread(data.id as string, data);
				} else {
					await memoryManager.addPlotThread(data as Omit<PlotThread, 'id'>);
				}
				break;
			case 'styleGuide':
				await memoryManager.updateStyleGuide(data as Partial<StyleGuide>);
				break;
			case 'worldBuilding':
			case 'all':
				for (const [key, value] of Object.entries(data)) {
					await memoryManager.setCustomContext(key, value);
				}
				break;
			default:
				throw createError(ErrorCode.INVALID_INPUT, `Unknown memory type: ${memoryType}`);
		}

		return {
			content: [
				{
					type: 'text',
					text: `${memoryType} memory updated`,
				},
			],
		};
	},
};

export const getMemoryHandler: ToolDefinition = {
	name: 'recall',
	title: 'Recall Project Facts',
	description:
		"Read back the project's persistent memory: stored characters, world-building, plot threads, " +
		'and style guide. Returns the requested store, or the full memory when memoryType is omitted ' +
		'or "all". Use remember to write new facts. Requires an open project.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			memoryType: {
				type: 'string',
				enum: ['characters', 'worldBuilding', 'plotThreads', 'styleGuide', 'all'],
				description:
					'Which memory store to read. Omit or use "all" to return the full project memory.',
			},
		},
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const memoryManager = requireMemoryManager(context);

		let memory: ProjectMemory | CharacterProfile[] | PlotThread[] | StyleGuide | unknown;
		if (!args.memoryType || args.memoryType === 'all') {
			memory = memoryManager.getFullMemory();
		} else {
			switch (args.memoryType) {
				case 'characters':
					memory = await memoryManager.getAllCharacters();
					break;
				case 'plotThreads':
					memory = await memoryManager.getPlotThreads();
					break;
				case 'styleGuide':
					memory = await memoryManager.getStyleGuide();
					break;
				case 'worldBuilding':
					memory = await memoryManager.getCustomContext('worldBuilding');
					break;
				default:
					memory = null;
			}
		}

		return {
			content: [
				{
					type: 'text',
					text: compact(memory),
				},
			],
		};
	},
};

export const checkConsistencyHandler: ToolDefinition = {
	name: 'check_consistency',
	title: 'Check Project Consistency',
	description:
		'Scan the whole project for continuity problems and return the issues found: character ' +
		'contradictions, timeline conflicts, location mismatches, and dropped or inconsistent plot ' +
		'threads. This is the project-wide continuity checker; use analyze_document to critique a ' +
		"single document's prose instead. Narrow the scan with checkTypes. Requires an open project.",
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			checkTypes: {
				type: 'array',
				items: {
					type: 'string',
					enum: ['characters', 'timeline', 'locations', 'plotThreads', 'all'],
				},
				description:
					'Continuity dimensions to check. Omit or use ["all"] for every check; otherwise ' +
					'pick any of characters, timeline, locations, plotThreads.',
			},
		},
	},
	handler: async (args, _context): Promise<HandlerResult> => {
		const project = requireProject(_context);
		const memoryManager = requireMemoryManager(_context);

		const checkTypes = getOptionalArrayArg<string>(args, 'checkTypes') || ['all'];
		const issues: ConsistencyIssue[] = [];

		try {
			// Get all documents for analysis
			const documents = await project.getAllDocuments();
			const characters = await memoryManager.getAllCharacters();
			const plotThreads = await memoryManager.getPlotThreads();

			// Character consistency checks
			if (checkTypes.includes('all') || checkTypes.includes('characters')) {
				const characterIssues = await checkCharacterConsistency(documents, characters);
				issues.push(...characterIssues);
			}

			// Timeline consistency checks
			if (checkTypes.includes('all') || checkTypes.includes('timeline')) {
				const timelineIssues = await checkTimelineConsistency(documents);
				issues.push(...timelineIssues);
			}

			// Location consistency checks
			if (checkTypes.includes('all') || checkTypes.includes('locations')) {
				const locationIssues = await checkLocationConsistency(documents, memoryManager);
				issues.push(...locationIssues);
			}

			// Plot thread consistency checks
			if (checkTypes.includes('all') || checkTypes.includes('plotThreads')) {
				const plotIssues = await checkPlotThreadConsistency(documents, plotThreads);
				issues.push(...plotIssues);
			}

			// Sort issues by severity
			issues.sort((a, b) => {
				const severityOrder = { error: 0, warning: 1, info: 2 };
				return severityOrder[a.severity] - severityOrder[b.severity];
			});

			const summary = createConsistencySummary(issues);

			return {
				content: [
					{
						type: 'text',
						text: `${summary}\n\n${compact({
							issues,
							counts: {
								total: issues.length,
								errors: issues.filter((i) => i.severity === 'error').length,
								warnings: issues.filter((i) => i.severity === 'warning').length,
								info: issues.filter((i) => i.severity === 'info').length,
							},
							checkTypes,
						})}`,
					},
				],
			};
		} catch (error) {
			return {
				content: [
					{
						type: 'text',
						text: `Error performing consistency check: ${(error as Error).message}`,
					},
				],
			};
		}
	},
};

// Consistency checking helper functions
type ConsistencyIssue = {
	type: 'character' | 'timeline' | 'worldbuilding' | 'plot' | 'location';
	severity: 'error' | 'warning' | 'info';
	documentId?: string;
	description: string;
	suggestion?: string;
};
async function checkCharacterConsistency(
	documents: ScrivenerDocument[],
	characters: CharacterProfile[]
): Promise<ConsistencyIssue[]> {
	const issues: ConsistencyIssue[] = [];

	// Pre-build a map of name variation -> (docId -> count) in a single pass over documents
	const allVariations = new Set<string>();
	for (const character of characters) {
		allVariations.add(character.name.toLowerCase());
		const firstName = character.name.split(' ')[0]?.toLowerCase();
		if (firstName) allVariations.add(firstName);
	}

	const variationDocCounts = new Map<string, Map<string, number>>();
	for (const v of allVariations) {
		variationDocCounts.set(v, new Map());
	}

	for (const doc of documents) {
		if (!doc.content) continue;
		const content = doc.content.toLowerCase();
		for (const variation of allVariations) {
			const regex = new RegExp(`\\b${variation}\\b`, 'gi');
			const matches = content.match(regex);
			if (matches && matches.length > 0) {
				variationDocCounts.get(variation)!.set(doc.id, matches.length);
			}
		}
	}

	for (const character of characters) {
		const nameVariations = [
			character.name.toLowerCase(),
			character.name.split(' ')[0]?.toLowerCase(),
		].filter(Boolean) as string[];

		// Aggregate mentions from pre-built map
		const mentionsByDoc = new Map<string, number>();
		for (const variation of nameVariations) {
			const docCounts = variationDocCounts.get(variation);
			if (docCounts) {
				for (const [docId, count] of docCounts) {
					mentionsByDoc.set(docId, (mentionsByDoc.get(docId) || 0) + count);
				}
			}
		}

		const mentions = Array.from(mentionsByDoc.entries()).map(([docId, count]) => ({
			docId,
			count,
		}));

		// Check for character inconsistencies
		if (mentions.length === 0) {
			issues.push({
				type: 'character',
				severity: 'warning',
				description: `Character "${character.name}" is defined but never mentioned in any document`,
				suggestion: 'Remove unused character or add references to the story',
			});
		} else if (mentions.length === 1 && mentions[0].count < 3) {
			issues.push({
				type: 'character',
				severity: 'info',
				documentId: mentions[0].docId,
				description: `Character "${character.name}" only appears briefly in one document`,
				suggestion: "Consider expanding the character's role or removing if not essential",
			});
		}

		// Check for sudden disappearances
		const orderedMentions = mentions.sort((a, b) => a.docId.localeCompare(b.docId));

		if (orderedMentions.length > 2) {
			// Check if character disappears for extended periods
			// Create a map of all documents for easier lookup
			const docMap = new Map(documents.map((d) => [d.id, d]));

			// Get document indices for proper ordering
			const docIndices = new Map<string, number>();
			documents.forEach((doc, index) => {
				if (doc.id) docIndices.set(doc.id, index);
			});

			// Analyze gaps between character appearances
			for (let i = 0; i < orderedMentions.length - 1; i++) {
				const currentMention = orderedMentions[i];
				const nextMention = orderedMentions[i + 1];

				const currentIndex = docIndices.get(currentMention.docId) ?? 0;
				const nextIndex = docIndices.get(nextMention.docId) ?? 0;
				const gap = nextIndex - currentIndex;

				// Flag if character disappears for more than 3 consecutive chapters
				if (gap > 3) {
					const currentDoc = docMap.get(currentMention.docId);
					const nextDoc = docMap.get(nextMention.docId);

					issues.push({
						type: 'character',
						description: `${character.name} disappears for ${gap - 1} chapter(s) between "${currentDoc?.title}" and "${nextDoc?.title}"`,
						severity: gap > 5 ? 'error' : 'warning',
						documentId: currentMention.docId,
						suggestion:
							gap > 5
								? "Consider adding mentions or explaining the character's absence"
								: 'Verify if character absence is intentional',
					});
				}
			}

			// Check for abrupt final disappearance
			const lastMention = orderedMentions[orderedMentions.length - 1];
			const lastMentionIndex = docIndices.get(lastMention.docId) ?? 0;
			const remainingChapters = documents.length - lastMentionIndex - 1;

			if (remainingChapters > 3) {
				const lastDoc = docMap.get(lastMention.docId);
				issues.push({
					type: 'character',
					description: `${character.name} disappears after "${lastDoc?.title}" with ${remainingChapters} chapters remaining`,
					severity: remainingChapters > 5 ? 'error' : 'warning',
					documentId: lastMention.docId,
					suggestion:
						"Consider resolving the character's storyline or explaining their absence",
				});
			}
		}
	}

	return issues;
}

async function checkTimelineConsistency(
	documents: ScrivenerDocument[]
): Promise<ConsistencyIssue[]> {
	const issues: ConsistencyIssue[] = [];

	// Look for temporal inconsistencies in document content
	const timeKeywords = [
		'yesterday',
		'today',
		'tomorrow',
		'last week',
		'next week',
		'months ago',
		'years later',
	];

	for (const doc of documents) {
		if (!doc.content) continue;

		const content = doc.content.toLowerCase();
		const timeReferences: Array<{ keyword: string; match: string }> = [];

		for (const keyword of timeKeywords) {
			const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
			const matches = content.match(regex);
			if (matches) {
				timeReferences.push(...matches.map((m: string) => ({ keyword, match: m })));
			}
		}

		// Check for conflicting time references within the same document
		if (timeReferences.length > 3) {
			const hasConflicts = timeReferences.some((ref) =>
				timeReferences.some(
					(other) =>
						ref.keyword !== other.keyword &&
						['yesterday', 'today', 'tomorrow'].includes(ref.keyword) &&
						['yesterday', 'today', 'tomorrow'].includes(other.keyword)
				)
			);

			if (hasConflicts) {
				issues.push({
					type: 'timeline',
					severity: 'warning',
					documentId: doc.id,
					description: `Document "${doc.title}" contains potentially conflicting time references`,
					suggestion: 'Review temporal references for consistency within the scene',
				});
			}
		}
	}

	return issues;
}

async function checkLocationConsistency(
	documents: ScrivenerDocument[],
	memoryManager: MemoryManager
): Promise<ConsistencyIssue[]> {
	const issues: ConsistencyIssue[] = [];

	// Get world-building information if available
	let worldBuilding: Record<string, unknown> = {};
	try {
		const context = memoryManager.getCustomContext('worldBuilding');
		worldBuilding = (context as Record<string, unknown>) || {};
	} catch {
		// World building not available
	}

	const locations = (worldBuilding.locations as unknown[]) || [];
	const locationNames = locations
		.map((loc) => {
			const location = loc as Record<string, unknown>;
			return typeof location.name === 'string' ? location.name.toLowerCase() : '';
		})
		.filter(Boolean);

	// Check for undefined locations mentioned in documents
	for (const doc of documents) {
		if (!doc.content) continue;

		// TODO: Look for location patterns (this is simplified - could be more sophisticated)
		const locationPatterns = [
			/\bat (?:the )?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/g,
			/\bin (?:the )?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/g,
		];

		for (const pattern of locationPatterns) {
			let match;
			while ((match = pattern.exec(doc.content)) !== null) {
				const possibleLocation = match[1].toLowerCase();

				// Skip common words that aren't locations
				if (
					['the', 'a', 'an', 'his', 'her', 'their', 'morning', 'evening'].includes(
						possibleLocation
					)
				) {
					continue;
				}

				if (locationNames.length > 0 && !locationNames.includes(possibleLocation)) {
					// Only flag if we have a defined world-building system
					issues.push({
						type: 'location',
						severity: 'info',
						documentId: doc.id,
						description: `Possible undefined location "${match[1]}" mentioned in "${doc.title}"`,
						suggestion: 'Add to world-building notes if this is a significant location',
					});
				}
			}
		}
	}

	return issues;
}

async function checkPlotThreadConsistency(
	documents: ScrivenerDocument[],
	plotThreads: PlotThread[]
): Promise<ConsistencyIssue[]> {
	const issues: ConsistencyIssue[] = [];

	for (const thread of plotThreads) {
		if (!thread.documents || thread.documents.length === 0) {
			issues.push({
				type: 'plot',
				severity: 'warning',
				description: `Plot thread "${thread.name}" has no associated documents`,
				suggestion: 'Link relevant documents to this plot thread or remove if unused',
			});
			continue;
		}

		// Check if plot thread documents exist
		const missingDocs = [];
		for (const docId of thread.documents) {
			const docExists = documents.some((d) => d.id === docId);
			if (!docExists) {
				missingDocs.push(docId);
			}
		}

		if (missingDocs.length > 0) {
			issues.push({
				type: 'plot',
				severity: 'error',
				description: `Plot thread "${thread.name}" references ${missingDocs.length} missing document(s)`,
				suggestion: 'Update plot thread to remove references to deleted documents',
			});
		}

		// Check plot thread progression
		if (thread.status === 'setup' && thread.documents.length > 5) {
			issues.push({
				type: 'plot',
				severity: 'info',
				description: `Plot thread "${thread.name}" has been in setup phase across many documents`,
				suggestion: 'Consider advancing this plot thread to development phase',
			});
		}
	}

	return issues;
}

function createConsistencySummary(issues: ConsistencyIssue[]): string {
	const totalIssues = issues.length;
	const errors = issues.filter((i) => i.severity === 'error').length;
	const warnings = issues.filter((i) => i.severity === 'warning').length;
	const infos = issues.filter((i) => i.severity === 'info').length;

	if (totalIssues === 0) {
		return 'No consistency issues found. Your project appears to be well-structured!';
	}

	let summary = `Found ${totalIssues} consistency issue${totalIssues !== 1 ? 's' : ''}:\n`;

	if (errors > 0) {
		summary += `\n🔴 ${errors} error${errors !== 1 ? 's' : ''} (require immediate attention)`;
	}
	if (warnings > 0) {
		summary += `\n⚠️ ${warnings} warning${warnings !== 1 ? 's' : ''} (should be reviewed)`;
	}
	if (infos > 0) {
		summary += `\n💡 ${infos} suggestion${infos !== 1 ? 's' : ''} (optional improvements)`;
	}

	summary += '\n\nReview the detailed issues below for specific recommendations.';

	return summary;
}

// Advanced LangChain handlers
export const multiAgentAnalysisHandler: ToolDefinition = {
	name: 'multi_agent_analysis',
	description: 'Multi-agent analysis',
	inputSchema: {
		type: 'object',
		properties: {
			documentId: SHARED_DEFS.docId,
			agents: {
				type: 'array',
				items: {
					type: 'string',
					enum: ['editor', 'critic', 'researcher', 'stylist', 'plotter', 'all'],
				},
			},
			collaborationMode: { type: 'string', enum: ['collaborative', 'workshop', 'review'] },
		},
		required: ['documentId'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		const documentId = getStringArg(args, 'documentId');
		const agents = (args.agents as string[]) || ['all'];
		const collaborationMode = (args.collaborationMode as string) || 'collaborative';

		const document = await project.getDocument(documentId);
		if (!document) {
			throw createError(ErrorCode.NOT_FOUND, 'Document not found');
		}

		try {
			const { AICollaboration } = await import('../services/agents/ai-collaboration.js');

			const collaboration = new AICollaboration();
			const result = await collaboration.collaborateOnDocument(document, {
				enabledAgents: agents.includes('all')
					? ['Writer', 'Editor', 'Researcher', 'Critic', 'Coordinator']
					: agents,
				enableCritique: collaborationMode === 'workshop',
				enableSynthesis: true,
			});

			return {
				content: [
					{
						type: 'text',
						text: compact({
							...result,
							collaborationMode,
							agents,
							enhanced: true,
						}),
					},
				],
			};
		} catch (error) {
			return {
				content: [
					{
						type: 'text',
						text: `Multi-agent analysis failed: ${(error as Error).message}`,
					},
				],
			};
		}
	},
};

export const semanticSearchHandler: ToolDefinition = {
	name: 'semantic_search',
	title: 'Semantic Search',
	description:
		'Find passages by meaning rather than exact words, using embeddings over the project, and ' +
		'return the most relevant documents with similarity scores and related entities. Use this ' +
		'for conceptual "find passages about X" queries; use search for keyword/full-text matching ' +
		'and find_mentions to locate every occurrence of a specific name or term. Calls an external ' +
		'embedding model. Requires an open project with semantic indexing available.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	inputSchema: {
		type: 'object',
		properties: {
			query: SHARED_DEFS.query,
			maxResults: SHARED_DEFS.maxResults,
			threshold: {
				...SHARED_DEFS.threshold,
				description:
					'Minimum similarity score (0-1) a result must meet to be returned. Default 0.5; ' +
					'raise for stricter matches, lower for broader recall.',
			},
		},
		required: ['query'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const query = getStringArg(args, 'query');
		const maxResults = getOptionalNumberArg(args, 'maxResults') || 10;
		const threshold = getOptionalNumberArg(args, 'threshold') || 0.5;

		try {
			if (!context.databaseService) {
				throw createError(ErrorCode.INVALID_STATE, 'Database service not available');
			}

			const { SemanticDatabaseLayer } =
				await import('../handlers/database/semantic-database-layer.js');
			const semanticLayer = new SemanticDatabaseLayer(context.databaseService);
			await semanticLayer.initialize();

			const results = await semanticLayer.semanticQuery(query, {
				maxResults,
				threshold,
				includeEntities: true,
				includeRelationships: true,
			});

			const trimmedResults = (results.documents || []).map(
				(doc: Record<string, unknown>) => ({
					id: doc.id,
					title: doc.title || 'Untitled',
					snippet:
						typeof doc.content === 'string'
							? doc.content.length > 100
								? `${doc.content.slice(0, 100)}...`
								: doc.content
							: typeof doc.text === 'string'
								? doc.text.length > 100
									? `${doc.text.slice(0, 100)}...`
									: doc.text
								: '',
					score: doc.score ?? doc.relevance ?? null,
				})
			);

			return {
				content: [
					{
						type: 'text',
						text: `Found ${trimmedResults.length} semantic matches\n\n${compact({
							results: trimmedResults,
							searchType: 'semantic',
						})}`,
					},
				],
			};
		} catch (error) {
			return {
				content: [
					{
						type: 'text',
						text: `Semantic search failed: ${(error as Error).message}`,
					},
				],
			};
		}
	},
};

export const collectFeedbackHandler: ToolDefinition = {
	name: 'collect_feedback',
	description: 'Submit feedback',
	inputSchema: {
		type: 'object',
		properties: {
			sessionId: { type: 'string' },
			rating: { type: 'number', minimum: 1, maximum: 5 },
			comments: { type: 'string' },
			operation: { type: 'string' },
		},
		required: ['sessionId', 'rating', 'operation'],
	},
	handler: async (args): Promise<HandlerResult> => {
		const sessionId = getStringArg(args, 'sessionId');
		const rating = args.rating as number;
		const comments = args.comments as string | undefined;
		const operation = getStringArg(args, 'operation');

		try {
			const learningHandler = await getAnalysisLearningHandler();

			await learningHandler.collectFeedback({
				sessionId,
				operation,
				input: {},
				output: {},
				userRating: rating,
				userComments: comments,
				timestamp: new Date(),
				context: {
					operation,
					sessionId,
				},
			});

			return {
				content: [
					{
						type: 'text',
						text: compact({
							sessionId,
							rating,
							operation,
							learningEnabled: true,
						}),
					},
				],
			};
		} catch (error) {
			return {
				content: [
					{
						type: 'text',
						text: `Failed to collect feedback: ${(error as Error).message}`,
					},
				],
			};
		}
	},
};

export const analysisHandlers = [
	analyzeDocumentHandler,
	enhanceContentHandler,
	generateContentHandler,
	updateMemoryHandler,
	getMemoryHandler,
	checkConsistencyHandler,
	semanticSearchHandler,
	// Advanced LangChain handlers
	multiAgentAnalysisHandler,
	collectFeedbackHandler,
];
