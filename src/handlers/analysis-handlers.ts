/**
 * Content analysis and AI enhancement handlers
 */

import { createError, ErrorCode } from '../core/errors.js';
import type {
	CharacterProfile,
	MemoryManager,
	PlotThread,
	ProjectMemory,
	StyleGuide,
} from '../memory-manager.js';
import type { EnhancementType } from '../services/enhancements/content-enhancer.js';
import { OpenAIService } from '../services/openai-service.js';
import type { ScrivenerDocument } from '../types/index.js';
import { validateInput } from '../utils/common.js';
import type { HandlerResult, ToolDefinition } from './types.js';
import {
	getObjectArg,
	getOptionalNumberArg,
	getOptionalObjectArg,
	getStringArg,
	requireMemoryManager,
	requireProject,
} from './types.js';
import {
	analysisSchema,
	enhancementSchema,
	memorySchema,
	promptSchema,
} from './validation-schemas.js';

export const analyzeDocumentHandler: ToolDefinition = {
	name: 'analyze_document',
	description: 'Analyze document content for style, themes, and improvements',
	inputSchema: {
		type: 'object',
		properties: {
			documentId: {
				type: 'string',
				description: 'UUID of the document to analyze',
			},
			analysisTypes: {
				type: 'array',
				items: {
					type: 'string',
					enum: ['readability', 'sentiment', 'themes', 'characters', 'pacing', 'all'],
				},
				description: 'Types of analysis to perform',
			},
		},
		required: ['documentId'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		const project = requireProject(context);
		validateInput(args, analysisSchema);

		const documentId = getStringArg(args, 'documentId');
		const content = await project.readDocument(documentId);
		if (!content) {
			throw createError(ErrorCode.NOT_FOUND, 'Document not found');
		}
		const analysis = await context.contentAnalyzer.analyzeContent(content, documentId);

		return {
			content: [
				{
					type: 'text',
					text: 'Document analysis complete',
					data: analysis,
				},
			],
		};
	},
};

export const enhanceContentHandler: ToolDefinition = {
	name: 'enhance_content',
	description: 'AI-powered content enhancement',
	inputSchema: {
		type: 'object',
		properties: {
			documentId: {
				type: 'string',
				description: 'Document to enhance',
			},
			enhancementType: {
				type: 'string',
				enum: ['grammar', 'style', 'clarity', 'expand', 'summarize', 'creative'],
				description: 'Type of enhancement',
			},
			options: {
				type: 'object',
				description: 'Enhancement-specific options',
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

		const content = await project.readDocument(documentId);
		if (!content) {
			throw createError(ErrorCode.NOT_FOUND, 'Document not found');
		}

		const enhanced = await context.contentEnhancer.enhance({
			content,
			type: enhancementType,
			options: options || {},
		});

		return {
			content: [
				{
					type: 'text',
					text: enhanced.enhanced,
					data: {
						original: enhanced.original,
						suggestions: enhanced.suggestions,
						changes: enhanced.changes,
						metrics: enhanced.metrics,
					},
				},
			],
		};
	},
};

export const generateContentHandler: ToolDefinition = {
	name: 'generate_content',
	description: 'Generate new content based on context',
	inputSchema: {
		type: 'object',
		properties: {
			prompt: {
				type: 'string',
				description: 'Generation prompt',
			},
			context: {
				type: 'object',
				properties: {
					documentId: { type: 'string' },
					characterIds: { type: 'array', items: { type: 'string' } },
					style: { type: 'string' },
				},
				description: 'Context for generation',
			},
			length: {
				type: 'number',
				description: 'Approximate word count',
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
							text: generated.content,
							data: generated,
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
						text: generated.content,
						data: generated,
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
						text: generated.content,
						data: generated,
					},
				],
			};
		}
	},
};

export const updateMemoryHandler: ToolDefinition = {
	name: 'update_memory',
	description: 'Update AI memory with project information',
	inputSchema: {
		type: 'object',
		properties: {
			memoryType: {
				type: 'string',
				enum: ['characters', 'worldBuilding', 'plotThreads', 'styleGuide', 'all'],
				description: 'Type of memory to update',
			},
			data: {
				type: 'object',
				description: 'Memory data to store',
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
	name: 'get_memory',
	description: 'Retrieve AI memory',
	inputSchema: {
		type: 'object',
		properties: {
			memoryType: {
				type: 'string',
				enum: ['characters', 'worldBuilding', 'plotThreads', 'styleGuide', 'all'],
				description: 'Type of memory to retrieve',
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
					text: 'Memory retrieved',
					data: memory,
				},
			],
		};
	},
};

export const checkConsistencyHandler: ToolDefinition = {
	name: 'check_consistency',
	description:
		'Check project for consistency issues across characters, timeline, locations, and plot threads',
	inputSchema: {
		type: 'object',
		properties: {
			checkTypes: {
				type: 'array',
				items: {
					type: 'string',
					enum: ['characters', 'timeline', 'locations', 'plotThreads', 'all'],
				},
				description: 'Types of consistency checks to perform',
			},
		},
	},
	handler: async (args, _context): Promise<HandlerResult> => {
		const project = requireProject(_context);
		const memoryManager = requireMemoryManager(_context);

		const checkTypes = (getOptionalObjectArg(args, 'checkTypes') as string[]) || ['all'];
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
						text: summary,
						data: {
							issues,
							counts: {
								total: issues.length,
								errors: issues.filter((i) => i.severity === 'error').length,
								warnings: issues.filter((i) => i.severity === 'warning').length,
								info: issues.filter((i) => i.severity === 'info').length,
							},
							checkTypes,
						},
					},
				],
			};
		} catch (error) {
			return {
				content: [
					{
						type: 'text',
						text: `Error performing consistency check: ${(error as Error).message}`,
						data: { error: true, issues: [] },
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

	for (const character of characters) {
		const mentions: { docId: string; count: number }[] = [];

		// Check character mentions across documents
		for (const doc of documents) {
			if (!doc.content) continue;

			const content = doc.content.toLowerCase();
			const nameVariations = [
				character.name.toLowerCase(),
				character.name.split(' ')[0]?.toLowerCase(), // First name
			].filter(Boolean);

			let totalMentions = 0;
			for (const variation of nameVariations) {
				const regex = new RegExp(`\\b${variation}\\b`, 'gi');
				const matches = content.match(regex);
				totalMentions += matches ? matches.length : 0;
			}

			if (totalMentions > 0) {
				mentions.push({ docId: doc.id, count: totalMentions });
			}
		}

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

export const analysisHandlers = [
	analyzeDocumentHandler,
	enhanceContentHandler,
	generateContentHandler,
	updateMemoryHandler,
	getMemoryHandler,
	checkConsistencyHandler,
];
