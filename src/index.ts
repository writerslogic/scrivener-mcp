#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ScrivenerProject } from './scrivener-project.js';
import * as fs from 'fs/promises';
import * as path from 'path';

let currentProject: ScrivenerProject | null = null;

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

                // Basic analysis
                const analysis = analyzeWriting(content);

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
                const critique = generateCritique(content, focusAreas);

                return {
                    content: [
                        {
                            type: 'text',
                            text: critique,
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

            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    } catch (error) {
        throw new Error(`Tool execution failed: ${error}`);
    }
});

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

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Scrivener MCP server running on stdio');
}

main().catch((error) => {
    console.error('Server error:', error);
    process.exit(1);
});
