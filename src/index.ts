#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ScrivenerProject } from './scrivener-project.js';
import type { StyleGuide } from './memory-manager.js';
import { MemoryManager } from './memory-manager.js';
import { ContentAnalyzer } from './content-analyzer.js';
import { ContentEnhancer, type EnhancementType } from './content-enhancer.js';
import * as fs from 'fs/promises';
import * as path from 'path';

let currentProject: ScrivenerProject | null = null;
let memoryManager: MemoryManager | null = null;
const contentAnalyzer: ContentAnalyzer = new ContentAnalyzer();
const contentEnhancer: ContentEnhancer = new ContentEnhancer();

const server = new Server(
	{
		name: 'scrivener-mcp',
		version: '0.1.0',
	},
	{
		capabilities: {
			tools: {},
		},
	}
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
	return {
		tools: [
			{
				name: 'open_project',
				description: 'Open a Scrivener project file',
				inputSchema: {
					type: 'object',
					properties: {
						path: {
							type: 'string',
							description: 'Path to the .scriv project folder',
						},
					},
					required: ['path'],
				},
			},
			{
				name: 'get_structure',
				description: 'Get the hierarchical structure of the project',
				inputSchema: {
					type: 'object',
					properties: {},
				},
			},
			{
				name: 'read_document',
				description: 'Read the content of a specific document',
				inputSchema: {
					type: 'object',
					properties: {
						documentId: {
							type: 'string',
							description: 'UUID of the document to read',
						},
					},
					required: ['documentId'],
				},
			},
			{
				name: 'write_document',
				description: 'Write content to a specific document',
				inputSchema: {
					type: 'object',
					properties: {
						documentId: {
							type: 'string',
							description: 'UUID of the document to write',
						},
						content: {
							type: 'string',
							description: 'New content for the document',
						},
					},
					required: ['documentId', 'content'],
				},
			},
			{
				name: 'create_document',
				description: 'Create a new document or folder',
				inputSchema: {
					type: 'object',
					properties: {
						parentId: {
							type: 'string',
							description: 'UUID of parent folder (null for root)',
							nullable: true,
						},
						title: {
							type: 'string',
							description: 'Title of the new document',
						},
						type: {
							type: 'string',
							enum: ['Text', 'Folder'],
							description: 'Type of document to create',
							default: 'Text',
						},
					},
					required: ['title'],
				},
			},
			{
				name: 'delete_document',
				description: 'Delete a document or folder',
				inputSchema: {
					type: 'object',
					properties: {
						documentId: {
							type: 'string',
							description: 'UUID of the document to delete',
						},
					},
					required: ['documentId'],
				},
			},
			{
				name: 'rename_document',
				description: 'Rename a document or folder',
				inputSchema: {
					type: 'object',
					properties: {
						documentId: {
							type: 'string',
							description: 'UUID of the document to rename',
						},
						newTitle: {
							type: 'string',
							description: 'New title for the document',
						},
					},
					required: ['documentId', 'newTitle'],
				},
			},
			{
				name: 'refresh_project',
				description: 'Reload project from disk (discards unsaved changes)',
				inputSchema: {
					type: 'object',
					properties: {},
				},
			},
			{
				name: 'move_document',
				description: 'Move a document to a different location',
				inputSchema: {
					type: 'object',
					properties: {
						documentId: {
							type: 'string',
							description: 'UUID of the document to move',
						},
						newParentId: {
							type: 'string',
							description: 'UUID of new parent (null for root)',
							nullable: true,
						},
					},
					required: ['documentId'],
				},
			},
			{
				name: 'update_metadata',
				description: 'Update document metadata',
				inputSchema: {
					type: 'object',
					properties: {
						documentId: {
							type: 'string',
							description: 'UUID of the document',
						},
						metadata: {
							type: 'object',
							properties: {
								title: { type: 'string' },
								keywords: {
									type: 'array',
									items: { type: 'string' },
								},
								customFields: {
									type: 'object',
								},
							},
						},
					},
					required: ['documentId', 'metadata'],
				},
			},
			{
				name: 'search_content',
				description: 'Search for content across all documents',
				inputSchema: {
					type: 'object',
					properties: {
						query: {
							type: 'string',
							description: 'Search query',
						},
						caseSensitive: {
							type: 'boolean',
							default: false,
						},
						regex: {
							type: 'boolean',
							default: false,
						},
					},
					required: ['query'],
				},
			},
			{
				name: 'compile_documents',
				description: 'Compile multiple documents into a single text',
				inputSchema: {
					type: 'object',
					properties: {
						documentIds: {
							type: 'array',
							items: { type: 'string' },
							description: 'Array of document UUIDs to compile',
						},
						separator: {
							type: 'string',
							default: '\n\n',
							description: 'Separator between documents',
						},
						outputFormat: {
							type: 'string',
							enum: ['text', 'markdown', 'html', 'latex', 'json'],
							default: 'text',
							description: 'Output format for compilation',
						},
					},
					required: ['documentIds'],
				},
			},
			{
				name: 'read_document_formatted',
				description: 'Read document with preserved RTF formatting',
				inputSchema: {
					type: 'object',
					properties: {
						documentId: {
							type: 'string',
							description: 'UUID of the document to read',
						},
					},
					required: ['documentId'],
				},
			},
			{
				name: 'get_document_annotations',
				description: 'Get Scrivener annotations and comments from a document',
				inputSchema: {
					type: 'object',
					properties: {
						documentId: {
							type: 'string',
							description: 'UUID of the document',
						},
					},
					required: ['documentId'],
				},
			},
			{
				name: 'get_word_count',
				description: 'Get word and character count',
				inputSchema: {
					type: 'object',
					properties: {
						documentId: {
							type: 'string',
							description: 'UUID of specific document (omit for entire project)',
						},
					},
				},
			},
			{
				name: 'analyze_document',
				description: 'Analyze document for writing quality metrics',
				inputSchema: {
					type: 'object',
					properties: {
						documentId: {
							type: 'string',
							description: 'UUID of the document to analyze',
						},
					},
					required: ['documentId'],
				},
			},
			{
				name: 'critique_document',
				description: 'Provide constructive critique of document',
				inputSchema: {
					type: 'object',
					properties: {
						documentId: {
							type: 'string',
							description: 'UUID of the document to critique',
						},
						focusAreas: {
							type: 'array',
							items: {
								type: 'string',
								enum: [
									'structure',
									'flow',
									'clarity',
									'character',
									'dialogue',
									'pacing',
									'style',
								],
							},
							description: 'Areas to focus critique on',
						},
					},
					required: ['documentId'],
				},
			},
			{
				name: 'get_project_metadata',
				description: 'Get project-level metadata',
				inputSchema: {
					type: 'object',
					properties: {},
				},
			},
			{
				name: 'deep_analyze_content',
				description: 'Perform deep content analysis with AI insights',
				inputSchema: {
					type: 'object',
					properties: {
						documentId: {
							type: 'string',
							description: 'UUID of the document to analyze',
						},
					},
					required: ['documentId'],
				},
			},
			{
				name: 'enhance_content',
				description: 'Enhance content with AI-powered improvements',
				inputSchema: {
					type: 'object',
					properties: {
						documentId: {
							type: 'string',
							description: 'UUID of the document to enhance',
						},
						enhancementType: {
							type: 'string',
							enum: [
								'eliminate-filter-words',
								'strengthen-verbs',
								'vary-sentences',
								'add-sensory-details',
								'show-dont-tell',
								'improve-flow',
								'enhance-descriptions',
								'strengthen-dialogue',
								'fix-pacing',
								'expand',
								'condense',
								'rewrite',
							],
							description: 'Type of enhancement to apply',
						},
						options: {
							type: 'object',
							properties: {
								tone: {
									type: 'string',
									enum: [
										'maintain',
										'lighter',
										'darker',
										'more-serious',
										'more-humorous',
									],
								},
								length: {
									type: 'string',
									enum: ['maintain', 'shorter', 'longer'],
								},
								aggressiveness: {
									type: 'string',
									enum: ['light', 'moderate', 'heavy'],
								},
							},
						},
					},
					required: ['documentId', 'enhancementType'],
				},
			},
			{
				name: 'save_character_profile',
				description: 'Save or update a character profile in project memory',
				inputSchema: {
					type: 'object',
					properties: {
						name: {
							type: 'string',
							description: 'Character name',
						},
						role: {
							type: 'string',
							enum: ['protagonist', 'antagonist', 'supporting', 'minor'],
							description: 'Character role',
						},
						description: {
							type: 'string',
							description: 'Character description',
						},
						traits: {
							type: 'array',
							items: { type: 'string' },
							description: 'Character traits',
						},
						arc: {
							type: 'string',
							description: 'Character arc description',
						},
					},
					required: ['name', 'role'],
				},
			},
			{
				name: 'get_character_profiles',
				description: 'Get all character profiles from project memory',
				inputSchema: {
					type: 'object',
					properties: {},
				},
			},
			{
				name: 'update_style_guide',
				description: 'Update the project style guide',
				inputSchema: {
					type: 'object',
					properties: {
						tone: {
							type: 'array',
							items: { type: 'string' },
							description: 'Tone descriptors',
						},
						voice: {
							type: 'string',
							description: 'Narrative voice',
						},
						pov: {
							type: 'string',
							enum: ['first', 'second', 'third-limited', 'third-omniscient'],
							description: 'Point of view',
						},
						tense: {
							type: 'string',
							enum: ['past', 'present', 'future'],
							description: 'Narrative tense',
						},
					},
				},
			},
			{
				name: 'get_style_guide',
				description: 'Get the project style guide',
				inputSchema: {
					type: 'object',
					properties: {},
				},
			},
			{
				name: 'save_plot_thread',
				description: 'Save or update a plot thread',
				inputSchema: {
					type: 'object',
					properties: {
						name: {
							type: 'string',
							description: 'Thread name',
						},
						description: {
							type: 'string',
							description: 'Thread description',
						},
						status: {
							type: 'string',
							enum: ['setup', 'development', 'climax', 'resolution'],
							description: 'Thread status',
						},
						documents: {
							type: 'array',
							items: { type: 'string' },
							description: 'Related document IDs',
						},
					},
					required: ['name', 'description'],
				},
			},
			{
				name: 'get_plot_threads',
				description: 'Get all plot threads',
				inputSchema: {
					type: 'object',
					properties: {},
				},
			},
			{
				name: 'get_writing_stats',
				description: 'Get writing statistics for the project',
				inputSchema: {
					type: 'object',
					properties: {},
				},
			},
			{
				name: 'export_project_memory',
				description: 'Export the complete project memory',
				inputSchema: {
					type: 'object',
					properties: {},
				},
			},
			{
				name: 'advanced_readability_analysis',
				description:
					'Get comprehensive readability analysis using multiple algorithms (Flesch-Kincaid, SMOG, etc.)',
				inputSchema: {
					type: 'object',
					properties: {
						content: {
							type: 'string',
							description: 'Content to analyze for readability',
						},
					},
					required: ['content'],
				},
			},
			{
				name: 'compare_readability',
				description: 'Compare readability metrics between two texts',
				inputSchema: {
					type: 'object',
					properties: {
						text1: {
							type: 'string',
							description: 'First text to compare',
						},
						text2: {
							type: 'string',
							description: 'Second text to compare',
						},
					},
					required: ['text1', 'text2'],
				},
			},
			{
				name: 'analyze_readability_trends',
				description: 'Analyze how readability changes across sections of a document',
				inputSchema: {
					type: 'object',
					properties: {
						content: {
							type: 'string',
							description: 'Content to analyze for readability trends',
						},
						segments: {
							type: 'number',
							description: 'Number of segments to divide the text into (default: 10)',
						},
					},
					required: ['content'],
				},
			},
			{
				name: 'configure_openai',
				description: 'Configure OpenAI API for advanced AI-powered analysis',
				inputSchema: {
					type: 'object',
					properties: {
						apiKey: {
							type: 'string',
							description: 'OpenAI API key',
						},
						model: {
							type: 'string',
							description: 'OpenAI model to use (default: gpt-4o-mini)',
						},
						maxTokens: {
							type: 'number',
							description: 'Maximum tokens for responses (default: 2000)',
						},
						temperature: {
							type: 'number',
							description: 'Response creativity (0.0-1.0, default: 0.3)',
						},
					},
					required: ['apiKey'],
				},
			},
			{
				name: 'get_ai_suggestions',
				description: 'Get AI-powered writing suggestions using OpenAI',
				inputSchema: {
					type: 'object',
					properties: {
						content: {
							type: 'string',
							description: 'Content to analyze for suggestions',
						},
						genre: {
							type: 'string',
							description: 'Genre context for suggestions',
						},
						targetAudience: {
							type: 'string',
							description: 'Target audience for the content',
						},
						style: {
							type: 'string',
							description: 'Desired writing style',
						},
					},
					required: ['content'],
				},
			},
			{
				name: 'analyze_style_with_ai',
				description: 'Analyze writing style using AI',
				inputSchema: {
					type: 'object',
					properties: {
						content: {
							type: 'string',
							description: 'Content to analyze for style',
						},
					},
					required: ['content'],
				},
			},
			{
				name: 'analyze_characters_with_ai',
				description: 'Analyze character development and consistency using AI',
				inputSchema: {
					type: 'object',
					properties: {
						content: {
							type: 'string',
							description: 'Content to analyze for characters',
						},
						characterNames: {
							type: 'array',
							items: { type: 'string' },
							description: 'Specific character names to analyze',
						},
					},
					required: ['content'],
				},
			},
			{
				name: 'analyze_plot_with_ai',
				description: 'Analyze plot structure and pacing using AI',
				inputSchema: {
					type: 'object',
					properties: {
						content: {
							type: 'string',
							description: 'Content to analyze for plot structure',
						},
					},
					required: ['content'],
				},
			},
			{
				name: 'parse_web_content',
				description: 'Parse HTML content and extract structured text for research',
				inputSchema: {
					type: 'object',
					properties: {
						html: {
							type: 'string',
							description: 'HTML content to parse',
						},
						baseUrl: {
							type: 'string',
							description: 'Base URL for resolving relative links',
						},
						convertToMarkdown: {
							type: 'boolean',
							description: 'Convert output to Markdown format',
						},
						extractResearchData: {
							type: 'boolean',
							description: 'Extract facts, quotes, and statistics',
						},
						keywords: {
							type: 'array',
							items: { type: 'string' },
							description: 'Keywords to highlight in research extraction',
						},
					},
					required: ['html'],
				},
			},
			{
				name: 'convert_html_to_markdown',
				description: 'Convert HTML content to clean Markdown format',
				inputSchema: {
					type: 'object',
					properties: {
						html: {
							type: 'string',
							description: 'HTML content to convert',
						},
						preserveImages: {
							type: 'boolean',
							description: 'Keep image tags in output',
						},
						preserveLinks: {
							type: 'boolean',
							description: 'Keep link tags in output',
						},
					},
					required: ['html'],
				},
			},
			{
				name: 'generate_writing_prompts',
				description: 'Generate creative writing prompts using AI',
				inputSchema: {
					type: 'object',
					properties: {
						genre: {
							type: 'string',
							description: 'Genre for the writing prompts',
						},
						theme: {
							type: 'string',
							description: 'Theme or topic for the prompts',
						},
						count: {
							type: 'number',
							description: 'Number of prompts to generate (default: 5)',
						},
					},
				},
			},
		],
	};
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const { name, arguments: args } = request.params;

	try {
		switch (name) {
			case 'open_project': {
				const { path: projPath } = args as { path: string };

				// Verify the path exists and is a .scriv folder
				const stats = await fs.stat(projPath);
				if (!stats.isDirectory() || !projPath.endsWith('.scriv')) {
					throw new Error('Invalid Scrivener project path');
				}

				currentProject = new ScrivenerProject(projPath);
				await currentProject.loadProject();

				// Initialize memory manager for this project
				memoryManager = new MemoryManager(projPath);
				await memoryManager.initialize();

				return {
					content: [
						{
							type: 'text',
							text: `Successfully opened project: ${path.basename(projPath)}`,
						},
					],
				};
			}

			case 'get_structure': {
				if (!currentProject) {
					throw new Error('No project is currently open');
				}

				const structure = await currentProject.getProjectStructure();
				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify(structure, null, 2),
						},
					],
				};
			}

			case 'read_document': {
				if (!currentProject) {
					throw new Error('No project is currently open');
				}

				const { documentId } = args as { documentId: string };
				const content = await currentProject.readDocument(documentId);

				return {
					content: [
						{
							type: 'text',
							text: content,
						},
					],
				};
			}

			case 'write_document': {
				if (!currentProject) {
					throw new Error('No project is currently open');
				}

				const { documentId, content } = args as { documentId: string; content: string };
				await currentProject.writeDocument(documentId, content);

				return {
					content: [
						{
							type: 'text',
							text: `Document ${documentId} updated successfully`,
						},
					],
				};
			}

			case 'create_document': {
				if (!currentProject) {
					throw new Error('No project is currently open');
				}

				const {
					parentId,
					title,
					type = 'Text',
				} = args as {
					parentId?: string | null;
					title: string;
					type?: 'Text' | 'Folder';
				};

				const uuid = await currentProject.createDocument(parentId || null, title, type);

				return {
					content: [
						{
							type: 'text',
							text: `Created ${type.toLowerCase()} "${title}" with ID: ${uuid}`,
						},
					],
				};
			}

			case 'delete_document': {
				if (!currentProject) {
					throw new Error('No project is currently open');
				}

				const { documentId } = args as { documentId: string };
				await currentProject.deleteDocument(documentId);

				return {
					content: [
						{
							type: 'text',
							text: `Document ${documentId} deleted successfully`,
						},
					],
				};
			}

			case 'rename_document': {
				if (!currentProject) {
					throw new Error('No project is currently open');
				}

				const { documentId, newTitle } = args as { documentId: string; newTitle: string };
				await currentProject.renameDocument(documentId, newTitle);

				return {
					content: [
						{
							type: 'text',
							text: `Document ${documentId} renamed to "${newTitle}"`,
						},
					],
				};
			}

			case 'refresh_project': {
				if (!currentProject) {
					throw new Error('No project is currently open');
				}

				await currentProject.refreshProject();

				return {
					content: [
						{
							type: 'text',
							text: 'Project refreshed from disk',
						},
					],
				};
			}

			case 'move_document': {
				if (!currentProject) {
					throw new Error('No project is currently open');
				}

				const { documentId, newParentId } = args as {
					documentId: string;
					newParentId?: string | null;
				};

				await currentProject.moveDocument(documentId, newParentId || null);

				return {
					content: [
						{
							type: 'text',
							text: `Document ${documentId} moved successfully`,
						},
					],
				};
			}

			case 'update_metadata': {
				if (!currentProject) {
					throw new Error('No project is currently open');
				}

				const { documentId, metadata } = args as {
					documentId: string;
					metadata: Record<string, string | undefined>;
				};

				await currentProject.updateMetadata(documentId, metadata);

				return {
					content: [
						{
							type: 'text',
							text: `Metadata updated for document ${documentId}`,
						},
					],
				};
			}

			case 'search_content': {
				if (!currentProject) {
					throw new Error('No project is currently open');
				}

				const {
					query,
					caseSensitive = false,
					regex = false,
				} = args as {
					query: string;
					caseSensitive?: boolean;
					regex?: boolean;
				};

				const results = await currentProject.searchContent(query, { caseSensitive, regex });

				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify(results, null, 2),
						},
					],
				};
			}

			case 'compile_documents': {
				if (!currentProject) {
					throw new Error('No project is currently open');
				}

				const {
					documentIds,
					separator = '\n\n',
					outputFormat = 'text',
				} = args as {
					documentIds: string[];
					separator?: string;
					outputFormat?: 'text' | 'markdown' | 'html' | 'latex' | 'json';
				};

				const compiled = await currentProject.compileDocuments(
					documentIds,
					separator,
					outputFormat
				);

				return {
					content: [
						{
							type: 'text',
							text:
								typeof compiled === 'string'
									? compiled
									: JSON.stringify(compiled, null, 2),
						},
					],
				};
			}

			case 'read_document_formatted': {
				if (!currentProject) {
					throw new Error('No project is currently open');
				}

				const { documentId } = args as { documentId: string };
				const rtfContent = await currentProject.readDocumentFormatted(documentId);

				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify(rtfContent, null, 2),
						},
					],
				};
			}

			case 'get_document_annotations': {
				if (!currentProject) {
					throw new Error('No project is currently open');
				}

				const { documentId } = args as { documentId: string };
				const annotations = await currentProject.getDocumentAnnotations(documentId);

				const annotationObject: Record<string, string> = {};
				annotations.forEach((value: string, key: string) => {
					annotationObject[key] = value;
				});

				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify(annotationObject, null, 2),
						},
					],
				};
			}

			case 'get_word_count': {
				if (!currentProject) {
					throw new Error('No project is currently open');
				}

				const { documentId } = args as { documentId?: string };
				const count = await currentProject.getWordCount(documentId);

				return {
					content: [
						{
							type: 'text',
							text: `Words: ${count.words}\nCharacters: ${count.characters}`,
						},
					],
				};
			}

			case 'analyze_document': {
				if (!currentProject) {
					throw new Error('No project is currently open');
				}

				const { documentId } = args as { documentId: string };
				const content = await currentProject.readDocument(documentId);

				// Use new ContentAnalyzer for deep analysis
				const analysis = await contentAnalyzer.analyzeContent(content, documentId);

				// Save analysis to memory
				if (memoryManager) {
					memoryManager.setDocumentContext(documentId, {
						summary: analysis.suggestions[0]?.suggestion || '',
						themes: [],
						sentiment: 'neutral',
						pacing:
							analysis.pacing.overall === 'variable'
								? 'moderate'
								: analysis.pacing.overall,
						keyElements: analysis.quality.filterWords,
						suggestions: analysis.suggestions.map((s) => s.suggestion),
						continuityNotes: [],
					});
				}

				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify(analysis, null, 2),
						},
					],
				};
			}

			case 'critique_document': {
				if (!currentProject) {
					throw new Error('No project is currently open');
				}

				const { documentId, focusAreas = [] } = args as {
					documentId: string;
					focusAreas?: string[];
				};

				const content = await currentProject.readDocument(documentId);
				const analysis = await contentAnalyzer.analyzeContent(content, documentId);

				// Generate critique based on analysis
				const critiques: string[] = [];

				if (!focusAreas.length || focusAreas.includes('structure')) {
					critiques.push(
						`**Structure:** ${analysis.structure.openingStrength} opening, ${analysis.structure.endingStrength} ending, ${analysis.structure.sceneBreaks} scene breaks`
					);
				}

				if (!focusAreas.length || focusAreas.includes('style')) {
					critiques.push(
						`**Style:** ${analysis.style.sentenceVariety} sentence variety, ${analysis.style.vocabularyComplexity} vocabulary, ${analysis.style.adverbUsage} adverb usage`
					);
				}

				if (!focusAreas.length || focusAreas.includes('pacing')) {
					critiques.push(
						`**Pacing:** ${analysis.pacing.overall} overall pace, action/reflection ratio: ${analysis.pacing.actionVsReflection.toFixed(2)}`
					);
				}

				if (analysis.suggestions.length > 0) {
					critiques.push(
						`**Top Suggestions:**\n${analysis.suggestions
							.slice(0, 5)
							.map((s) => `- ${s.suggestion}`)
							.join('\n')}`
					);
				}

				return {
					content: [
						{
							type: 'text',
							text: critiques.join('\n\n'),
						},
					],
				};
			}

			case 'get_project_metadata': {
				if (!currentProject) {
					throw new Error('No project is currently open');
				}

				const metadata = await currentProject.getProjectMetadata();

				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify(metadata, null, 2),
						},
					],
				};
			}

			case 'deep_analyze_content': {
				if (!currentProject) {
					throw new Error('No project is currently open');
				}

				const { documentId } = args as { documentId: string };
				const content = await currentProject.readDocument(documentId);
				const analysis = await contentAnalyzer.analyzeContent(content, documentId);

				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify(analysis, null, 2),
						},
					],
				};
			}

			case 'enhance_content': {
				if (!currentProject) {
					throw new Error('No project is currently open');
				}

				const { documentId, enhancementType, options } = args as {
					documentId: string;
					enhancementType: EnhancementType;
					options?: Record<string, unknown>;
				};

				const content = await currentProject.readDocument(documentId);
				const styleGuide = memoryManager?.getStyleGuide();

				const result = await contentEnhancer.enhance({
					content,
					type: enhancementType,
					options,
					styleGuide,
				});

				// Save enhanced content back to document
				await currentProject.writeDocument(documentId, result.enhanced);

				return {
					content: [
						{
							type: 'text',
							text: `Enhanced document ${documentId}. Changes applied: ${result.changes.length}\n\nMetrics:\n${JSON.stringify(result.metrics, null, 2)}`,
						},
					],
				};
			}

			case 'save_character_profile': {
				if (!memoryManager) {
					throw new Error('Memory manager not initialized');
				}

				const { name, role, description, traits, arc } = args as {
					name: string;
					role: 'protagonist' | 'antagonist' | 'supporting' | 'minor';
					description?: string;
					traits?: string[];
					arc?: string;
				};
				const character = memoryManager.addCharacter({
					name,
					role,
					description: description || '',
					traits: traits || [],
					arc: arc || '',
					relationships: [],
					appearances: [],
					notes: '',
				});

				await memoryManager.saveMemory();

				return {
					content: [
						{
							type: 'text',
							text: `Saved character profile: ${character.name} (${character.role})`,
						},
					],
				};
			}

			case 'get_character_profiles': {
				if (!memoryManager) {
					throw new Error('Memory manager not initialized');
				}

				const characters = memoryManager.getAllCharacters();

				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify(characters, null, 2),
						},
					],
				};
			}

			case 'update_style_guide': {
				if (!memoryManager) {
					throw new Error('Memory manager not initialized');
				}

				const updates = args as Partial<StyleGuide>;
				memoryManager.updateStyleGuide(updates);
				await memoryManager.saveMemory();

				return {
					content: [
						{
							type: 'text',
							text: 'Style guide updated successfully',
						},
					],
				};
			}

			case 'get_style_guide': {
				if (!memoryManager) {
					throw new Error('Memory manager not initialized');
				}

				const styleGuide = memoryManager.getStyleGuide();

				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify(styleGuide, null, 2),
						},
					],
				};
			}

			case 'save_plot_thread': {
				if (!memoryManager) {
					throw new Error('Memory manager not initialized');
				}

				const { name, description, status, documents } = args as {
					name: string;
					description: string;
					status: 'setup' | 'development' | 'climax' | 'resolution';
					documents?: string[];
				};
				const thread = memoryManager.addPlotThread({
					name,
					description,
					status: status || 'setup',
					documents: documents || [],
					keyEvents: [],
				});

				await memoryManager.saveMemory();

				return {
					content: [
						{
							type: 'text',
							text: `Saved plot thread: ${thread.name}`,
						},
					],
				};
			}

			case 'get_plot_threads': {
				if (!memoryManager) {
					throw new Error('Memory manager not initialized');
				}

				const threads = memoryManager.getPlotThreads();

				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify(threads, null, 2),
						},
					],
				};
			}

			case 'get_writing_stats': {
				if (!memoryManager) {
					throw new Error('Memory manager not initialized');
				}

				const stats = memoryManager.getWritingStats();

				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify(stats, null, 2),
						},
					],
				};
			}

			case 'export_project_memory': {
				if (!memoryManager) {
					throw new Error('Memory manager not initialized');
				}

				const memory = memoryManager.getFullMemory();

				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify(memory, null, 2),
						},
					],
				};
			}

			case 'advanced_readability_analysis': {
				const { content } = args as { content: string };
				const analysis = await contentAnalyzer.getAdvancedReadabilityAnalysis(content);

				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify(analysis, null, 2),
						},
					],
				};
			}

			case 'compare_readability': {
				const { text1, text2 } = args as { text1: string; text2: string };
				const comparison = await contentAnalyzer.compareReadability(text1, text2);

				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify(comparison, null, 2),
						},
					],
				};
			}

			case 'analyze_readability_trends': {
				const { content, segments } = args as { content: string; segments?: number };
				const trends = await contentAnalyzer.analyzeReadabilityTrends(content, segments);

				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify(trends, null, 2),
						},
					],
				};
			}

			case 'configure_openai': {
				const { apiKey, model, maxTokens, temperature } = args as {
					apiKey: string;
					model?: string;
					maxTokens?: number;
					temperature?: number;
				};

				contentAnalyzer.configureOpenAI({ apiKey, model, maxTokens, temperature });

				return {
					content: [
						{
							type: 'text',
							text: 'OpenAI API configured successfully',
						},
					],
				};
			}

			case 'get_ai_suggestions': {
				const { content, genre, targetAudience, style } = args as {
					content: string;
					genre?: string;
					targetAudience?: string;
					style?: string;
				};

				if (!contentAnalyzer.isOpenAIConfigured()) {
					throw new Error('OpenAI API not configured. Use configure_openai tool first.');
				}

				const suggestions = await contentAnalyzer.getAISuggestions(content, {
					genre,
					targetAudience,
					style,
				});

				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify(suggestions, null, 2),
						},
					],
				};
			}

			case 'analyze_style_with_ai': {
				const { content } = args as { content: string };

				if (!contentAnalyzer.isOpenAIConfigured()) {
					throw new Error('OpenAI API not configured. Use configure_openai tool first.');
				}

				const styleAnalysis = await contentAnalyzer.analyzeStyleWithAI(content);

				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify(styleAnalysis, null, 2),
						},
					],
				};
			}

			case 'analyze_characters_with_ai': {
				const { content, characterNames } = args as {
					content: string;
					characterNames?: string[];
				};

				if (!contentAnalyzer.isOpenAIConfigured()) {
					throw new Error('OpenAI API not configured. Use configure_openai tool first.');
				}

				const characterAnalysis = await contentAnalyzer.analyzeCharactersWithAI(
					content,
					characterNames
				);

				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify(characterAnalysis, null, 2),
						},
					],
				};
			}

			case 'analyze_plot_with_ai': {
				const { content } = args as { content: string };

				if (!contentAnalyzer.isOpenAIConfigured()) {
					throw new Error('OpenAI API not configured. Use configure_openai tool first.');
				}

				const plotAnalysis = await contentAnalyzer.analyzePlotWithAI(content);

				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify(plotAnalysis, null, 2),
						},
					],
				};
			}

			case 'parse_web_content': {
				const { html, baseUrl, convertToMarkdown, extractResearchData, keywords } =
					args as {
						html: string;
						baseUrl?: string;
						convertToMarkdown?: boolean;
						extractResearchData?: boolean;
						keywords?: string[];
					};

				const parsed = contentAnalyzer.parseWebContent(html, baseUrl, {
					convertToMarkdown,
					extractResearchData,
				});

				const result = parsed;

				if (extractResearchData) {
					result.researchData = contentAnalyzer.extractResearchData(parsed, keywords);
				}

				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify(result, null, 2),
						},
					],
				};
			}

			case 'convert_html_to_markdown': {
				const { html, preserveImages, preserveLinks } = args as {
					html: string;
					preserveImages?: boolean;
					preserveLinks?: boolean;
				};

				const markdown = contentAnalyzer.convertHtmlToMarkdown(html, {
					preserveImages,
					preserveLinks,
				});

				return {
					content: [
						{
							type: 'text',
							text: markdown,
						},
					],
				};
			}

			case 'generate_writing_prompts': {
				const { genre, theme, count } = args as {
					genre?: string;
					theme?: string;
					count?: number;
				};

				if (!contentAnalyzer.isOpenAIConfigured()) {
					throw new Error('OpenAI API not configured. Use configure_openai tool first.');
				}

				const prompts = await contentAnalyzer.generateWritingPrompts(genre, theme, count);

				return {
					content: [
						{
							type: 'text',
							text: JSON.stringify(prompts, null, 2),
						},
					],
				};
			}

			default:
				throw new Error(`Unknown tool: ${name}`);
		}
	} catch (error) {
		throw new Error(`Tool execution failed: ${error}`);
	}
});

// Old analysis functions - kept for reference but replaced by ContentAnalyzer
/*
interface WritingAnalysis {
    wordCount: number;
    sentenceCount: number;
    averageWordsPerSentence: number;
    longSentences: string[];
    readingLevel: string;
    complexity: number;
    statistics?: {
        adjectives: number;
        adverbs: number;
        passiveVoice: number;
    };
}

function analyzeWriting(content: string): WritingAnalysis {
    const sentences = content.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    const words = content.split(/\s+/).filter((w) => w.length > 0);

    // Calculate readability metrics
    const avgWordsPerSentence = words.length / Math.max(sentences.length, 1);

    // Find long sentences
    const longSentences = sentences.filter((s) => s.split(/\s+/).length > 30);

    // Check for passive voice indicators
    const passiveIndicators = content.match(/\b(was|were|been|being|is|are|am)\s+\w+ed\b/gi) || [];

    // Count adjectives and adverbs
    const adjectives = (content.match(/\b\w+(ful|less|ous|ive|able|ible|al|ic)\b/gi) || []).length;
    const adverbs = (content.match(/\b\w+ly\b/gi) || []).length;

    // Calculate reading level (simple approximation)
    const fleschScore = calculateFleschReadingEase(content);
    let readingLevel: string;
    if (fleschScore >= 90) readingLevel = 'Very Easy';
    else if (fleschScore >= 70) readingLevel = 'Easy';
    else if (fleschScore >= 50) readingLevel = 'Average';
    else if (fleschScore >= 30) readingLevel = 'Difficult';
    else readingLevel = 'Very Difficult';

    // Calculate complexity based on sentence length
    const complexity = avgWordsPerSentence > 25 ? 3 : avgWordsPerSentence > 15 ? 2 : 1;

    return {
        wordCount: words.length,
        sentenceCount: sentences.length,
        averageWordsPerSentence: Math.round(avgWordsPerSentence * 10) / 10,
        longSentences: longSentences.map(
            (s) => s.substring(0, 100) + (s.length > 100 ? '...' : '')
        ),
        readingLevel,
        complexity,
        statistics: {
            adjectives,
            adverbs,
            passiveVoice: passiveIndicators.length,
        },
    };
}

function calculateFleschReadingEase(text: string): number {
    const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    const words = text.split(/\s+/).filter((w) => w.length > 0);
    const syllables = words.reduce((sum, word) => sum + countSyllables(word), 0);

    if (sentences.length === 0 || words.length === 0) return 0;

    const score =
        206.835 - 1.015 * (words.length / sentences.length) - 84.6 * (syllables / words.length);
    return Math.max(0, Math.min(100, Math.round(score)));
}

function countSyllables(word: string): number {
    word = word.toLowerCase().replace(/[^a-z]/g, '');
    if (word.length <= 3) return 1;

    const vowels = 'aeiouy';
    let count = 0;
    let previousWasVowel = false;

    for (let i = 0; i < word.length; i++) {
        const isVowel = vowels.includes(word[i]);
        if (isVowel && !previousWasVowel) {
            count++;
        }
        previousWasVowel = isVowel;
    }

    if (word.endsWith('e')) count--;
    if (word.endsWith('le') && word.length > 2 && !vowels.includes(word[word.length - 3])) count++;

    return Math.max(1, count);
}

function generateCritique(content: string, focusAreas: string[]): string {
    const areas = focusAreas.length > 0 ? focusAreas : ['structure', 'flow', 'clarity', 'style'];
    const critiques: string[] = [];

    const sentences = content.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    const paragraphs = content.split(/\n\n+/).filter((p) => p.trim().length > 0);

    if (areas.includes('structure')) {
        critiques.push('**Structure:**');
        if (paragraphs.length < 3) {
            critiques.push(
                '- Consider breaking the text into more paragraphs for better readability'
            );
        }
        if (paragraphs.some((p) => p.split(/[.!?]+/).length > 7)) {
            critiques.push(
                '- Some paragraphs are quite long. Consider splitting them for better pacing'
            );
        }
        critiques.push('');
    }

    if (areas.includes('flow')) {
        critiques.push('**Flow:**');
        const transitionWords = [
            'however',
            'therefore',
            'moreover',
            'furthermore',
            'consequently',
            'nevertheless',
        ];
        const hasTransitions = transitionWords.some((word) => content.toLowerCase().includes(word));

        if (!hasTransitions) {
            critiques.push('- Consider adding transition words to improve flow between ideas');
        }

        if (
            sentences.filter((s) => s.startsWith('I ') || s.startsWith('The ')).length >
            sentences.length * 0.3
        ) {
            critiques.push(
                '- Vary sentence beginnings to improve flow and maintain reader interest'
            );
        }
        critiques.push('');
    }

    if (areas.includes('clarity')) {
        critiques.push('**Clarity:**');
        const avgWordsPerSentence = content.split(/\s+/).length / Math.max(sentences.length, 1);

        if (avgWordsPerSentence > 25) {
            critiques.push(
                '- Sentences are quite long on average. Consider breaking them up for clarity'
            );
        }

        const passiveVoice = (content.match(/\b(was|were|been|being)\s+\w+ed\b/gi) || []).length;
        if (passiveVoice > sentences.length * 0.2) {
            critiques.push(
                '- High use of passive voice detected. Consider using active voice for more direct communication'
            );
        }
        critiques.push('');
    }

    if (areas.includes('style')) {
        critiques.push('**Style:**');

        const adverbs = (content.match(/\w+ly\b/gi) || []).length;
        if (adverbs > sentences.length * 0.3) {
            critiques.push(
                '- Consider reducing adverb usage. Strong verbs often work better than verb + adverb combinations'
            );
        }

        const saidBookisms =
            content.match(/\b(exclaimed|declared|announced|stated|remarked|uttered)\b/gi) || [];
        if (saidBookisms.length > 2) {
            critiques.push(
                '- Avoid overuse of "said bookisms". "Said" and "asked" are usually sufficient'
            );
        }
        critiques.push('');
    }

    if (areas.includes('dialogue') && content.includes('"')) {
        critiques.push('**Dialogue:**');
        const dialogueLines = content.match(/"[^"]+"/g) || [];

        if (dialogueLines.some((d) => d.length > 150)) {
            critiques.push(
                '- Some dialogue passages are quite long. Consider breaking them up with action or description'
            );
        }

        if (!content.includes('said') && dialogueLines.length > 3) {
            critiques.push('- Consider adding dialogue tags for clarity about who is speaking');
        }
        critiques.push('');
    }

    if (areas.includes('pacing')) {
        critiques.push('**Pacing:**');

        const shortSentences = sentences.filter((s) => s.split(/\s+/).length < 8).length;
        const longSentences = sentences.filter((s) => s.split(/\s+/).length > 25).length;

        if (shortSentences > sentences.length * 0.7) {
            critiques.push(
                '- Many short sentences detected. Consider combining some for better flow'
            );
        } else if (longSentences > sentences.length * 0.5) {
            critiques.push(
                '- Many long sentences detected. Mix in shorter sentences for better pacing'
            );
        }
        critiques.push('');
    }

    if (
        areas.includes('character') &&
        (content.includes('he ') || content.includes('she ') || content.includes('they '))
    ) {
        critiques.push('**Character:**');

        if (!content.match(/\b(felt|thought|wondered|realized|understood)\b/i)) {
            critiques.push('- Consider adding more internal character thoughts and feelings');
        }

        const dialogueRatio = (content.match(/"[^"]+"/g) || []).join('').length / content.length;
        if (dialogueRatio < 0.1) {
            critiques.push(
                '- Limited dialogue detected. Consider adding more character interaction'
            );
        }
        critiques.push('');
    }

    critiques.push(
        '**Overall:** Remember that these are suggestions. The best writing often breaks rules purposefully. Consider your intended style and audience when applying these critiques.'
    );

    return critiques.join('\n');
}
*/

async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error('Scrivener MCP server running on stdio');
}

main().catch((error) => {
	console.error('Server error:', error);
	process.exit(1);
});
