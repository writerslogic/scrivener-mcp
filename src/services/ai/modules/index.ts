/**
 * AI Service Modules
 * Provides a modular architecture for AI-powered operations
 */

import type { Document as LangchainDocument } from 'langchain/document';
import type { Embeddings } from '@langchain/core/embeddings';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { BufferMemory } from 'langchain/memory';
import { OpenAIEmbeddings, ChatOpenAI } from '@langchain/openai';
import { getLogger } from '../../../core/logger.js';

const logger = getLogger('ai-modules');

/**
 * Handles document chunking and preprocessing
 */
export class DocumentProcessor {
    private splitter: RecursiveCharacterTextSplitter;

    constructor(chunkSize = 2000, chunkOverlap = 200) {
        this.splitter = new RecursiveCharacterTextSplitter({
            chunkSize,
            chunkOverlap,
            separators: ['\n\n\n', '\n\n', '\n', '. ', ' ', '']
        });
    }

    async chunkDocument(content: string, metadata: Record<string, any> = {}): Promise<LangchainDocument[]> {
        return await this.splitter.createDocuments([content], [metadata]);
    }

    async processDocuments(contents: string[], metadatas: Record<string, any>[]): Promise<LangchainDocument[]> {
        return await this.splitter.createDocuments(contents, metadatas);
    }
}

/**
 * Manages conversation memory and context state
 */
export class ConversationManager {
    private memories: Map<string, BufferMemory> = new Map();

    async getMemory(sessionId: string): Promise<BufferMemory> {
        if (!this.memories.has(sessionId)) {
            this.memories.set(sessionId, new BufferMemory({
                memoryKey: 'chat_history',
                returnMessages: true
            }));
        }
        return this.memories.get(sessionId)!;
    }

    async clearMemory(sessionId: string): Promise<void> {
        this.memories.delete(sessionId);
    }
}

/**
 * Handles embedding generation and similarity calculations
 */
export class EmbeddingService {
    private model: Embeddings;

    constructor(apiKey?: string) {
        this.model = new OpenAIEmbeddings({
            openAIApiKey: apiKey || process.env.OPENAI_API_KEY,
            modelName: 'text-embedding-3-small'
        });
    }

    async generateEmbeddings(text: string): Promise<number[]> {
        return await this.model.embedQuery(text);
    }

    async generateBatchEmbeddings(texts: string[]): Promise<number[][]> {
        return await this.model.embedDocuments(texts);
    }
}

/**
 * Centralized manager for different AI model providers and configurations
 */
export class ModelManager {
    private models: Map<string, BaseChatModel> = new Map();

    getModel(name: string, temperature = 0.7): BaseChatModel {
        const key = `${name}-${temperature}`;
        if (!this.models.has(key)) {
            this.models.set(key, new ChatOpenAI({
                modelName: name,
                temperature,
                openAIApiKey: process.env.OPENAI_API_KEY
            }));
        }
        return this.models.get(key)!;
    }
}
