/**
 * OpenAI Service Modules
 * Modular components for direct OpenAI API interaction
 */

import OpenAI from 'openai';
import { getLogger } from '../../../core/logger.js';

const logger = getLogger('openai-modules');

/**
 * Direct text generation using OpenAI's latest models
 */
export class TextGenerator {
    private client: OpenAI;

    constructor(apiKey?: string) {
        this.client = new OpenAI({
            apiKey: apiKey || process.env.OPENAI_API_KEY
        });
    }

    async generate(prompt: string, systemMessage?: string, options: { model?: string, temperature?: number } = {}): Promise<string> {
        const response = await this.client.chat.completions.create({
            model: options.model || 'gpt-4-turbo-preview',
            messages: [
                { role: 'system', content: systemMessage || 'You are a helpful writing assistant.' },
                { role: 'user', content: prompt }
            ],
            temperature: options.temperature ?? 0.7,
        });

        return response.choices[0]?.message?.content || '';
    }
}

/**
 * Structured data extraction and analysis
 */
export class AnalysisModule {
    private client: OpenAI;

    constructor(apiKey?: string) {
        this.client = new OpenAI({
            apiKey: apiKey || process.env.OPENAI_API_KEY
        });
    }

    async analyze(text: string, task: string): Promise<Record<string, any>> {
        const response = await this.client.chat.completions.create({
            model: 'gpt-4-turbo-preview',
            messages: [
                { role: 'system', content: 'You are an expert literary analyst. Provide structured JSON responses.' },
                { role: 'user', content: `Task: ${task}\n\nText: ${text}` }
            ],
            response_format: { type: 'json_object' }
        });

        const content = response.choices[0]?.message?.content || '{}';
        return JSON.parse(content);
    }
}
