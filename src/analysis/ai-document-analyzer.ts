/**
 * Document analyzer backed by the direct-SDK AIClient (Claude default).
 * Replaces the LangChain analytics pipeline for analyze_document. Produces a
 * qualitative critique (readability, pacing, issues) that the handler renders.
 */

import { AIClient } from '../services/ai/ai-client.js';
import { getLogger } from '../core/logger.js';
import { ErrorCode, createError } from '../utils/common.js';

const logger = getLogger('ai-document-analyzer');

export interface DocumentIssue {
	description: string;
	severity?: 'low' | 'medium' | 'high';
}

export interface DocumentAnalysis {
	readability: string;
	pacing: string;
	issues: DocumentIssue[];
}

const SYSTEM_PROMPT =
	'You are a developmental editor reviewing a fiction passage. Be specific and constructive. ' +
	'Respond with STRICT JSON only -- no prose, no markdown code fences.';

/** Extract the first JSON object from a model reply, tolerating code fences. */
function parseJsonObject(raw: string): unknown {
	const withoutFences = raw.replace(/```(?:json)?/gi, '').trim();
	const start = withoutFences.indexOf('{');
	const end = withoutFences.lastIndexOf('}');
	if (start === -1 || end === -1 || end <= start) {
		throw createError(ErrorCode.INVALID_FORMAT, null, 'Model reply contained no JSON object');
	}
	return JSON.parse(withoutFences.slice(start, end + 1));
}

function coerceIssues(value: unknown): DocumentIssue[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item): DocumentIssue | null => {
			if (typeof item === 'string') return { description: item };
			if (item && typeof item === 'object') {
				const obj = item as Record<string, unknown>;
				const description = typeof obj.description === 'string' ? obj.description : '';
				if (!description) return null;
				const severity =
					obj.severity === 'low' || obj.severity === 'medium' || obj.severity === 'high'
						? obj.severity
						: undefined;
				return { description, severity };
			}
			return null;
		})
		.filter((i): i is DocumentIssue => i !== null);
}

export class AIDocumentAnalyzer {
	private readonly ai: AIClient;

	constructor(ai: AIClient = new AIClient()) {
		this.ai = ai;
	}

	async analyzeDocument(content: string): Promise<DocumentAnalysis> {
		const passage = content.trim();
		if (!passage) {
			return { readability: 'n/a', pacing: 'n/a', issues: [] };
		}

		const prompt =
			'Analyze the passage for readability, pacing, and craft issues. Return JSON with exactly ' +
			'this shape: {"readability":"easy|moderate|complex - one-line reason","pacing":"slow|' +
			'steady|fast - one-line reason","issues":[{"description":"...","severity":"low|medium|' +
			`high"}]}\n\nPassage:\n${passage}`;

		const raw = await this.ai.chat(prompt, {
			system: SYSTEM_PROMPT,
			temperature: 0.2,
			maxTokens: 1500,
		});

		const parsed = parseJsonObject(raw) as Record<string, unknown>;
		const analysis: DocumentAnalysis = {
			readability: typeof parsed.readability === 'string' ? parsed.readability : 'unknown',
			pacing: typeof parsed.pacing === 'string' ? parsed.pacing : 'unknown',
			issues: coerceIssues(parsed.issues),
		};

		logger.debug('AI document analysis complete', {
			provider: this.ai.provider ?? 'none',
			issueCount: analysis.issues.length,
		});
		return analysis;
	}
}
