/**
 * Multi-perspective document critique backed by the direct-SDK AIClient.
 * Replaces the LangChain multi-agent orchestrator: instead of simulating several
 * agents discussing over rounds, one Claude call critiques the passage from each
 * requested expert role and synthesizes a consensus.
 */

import { AIClient } from '../ai/ai-client.js';
import { getLogger } from '../../core/logger.js';
import { ErrorCode, createError } from '../../utils/common.js';
import { clip, untrustedBlock } from '../../utils/prompt-input.js';

const logger = getLogger('ai-collaboration');

export interface CollaborationDocument {
	content?: string;
	title?: string;
	type?: string;
}

export interface CollaborationOptions {
	enabledAgents?: string[];
	enableCritique?: boolean;
	enableSynthesis?: boolean;
}

export interface PerspectiveFeedback {
	role: string;
	feedback: string;
}

export interface CollaborationResult {
	perspectives: PerspectiveFeedback[];
	synthesis: string;
	consensus: string;
}

const SYSTEM_PROMPT =
	'You are a writing workshop facilitator. Critique the passage from each requested expert ' +
	'perspective, then synthesize. Be specific and constructive. Respond with STRICT JSON only -- ' +
	'no prose, no markdown code fences.';

function parseJsonObject(raw: string): Record<string, unknown> {
	const withoutFences = raw.replace(/```(?:json)?/gi, '').trim();
	const start = withoutFences.indexOf('{');
	const end = withoutFences.lastIndexOf('}');
	if (start === -1 || end === -1 || end <= start) {
		throw createError(ErrorCode.INVALID_FORMAT, null, 'Model reply contained no JSON object');
	}
	return JSON.parse(withoutFences.slice(start, end + 1)) as Record<string, unknown>;
}

function coercePerspectives(value: unknown): PerspectiveFeedback[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item): PerspectiveFeedback | null => {
			if (item && typeof item === 'object') {
				const obj = item as Record<string, unknown>;
				const role = typeof obj.role === 'string' ? obj.role : '';
				const feedback = typeof obj.feedback === 'string' ? obj.feedback : '';
				if (role && feedback) return { role, feedback };
			}
			return null;
		})
		.filter((p): p is PerspectiveFeedback => p !== null);
}

export class AICollaboration {
	private readonly ai: AIClient;

	constructor(ai: AIClient = new AIClient()) {
		this.ai = ai;
	}

	async collaborateOnDocument(
		document: CollaborationDocument,
		options: CollaborationOptions = {}
	): Promise<CollaborationResult> {
		const passage = clip((document.content ?? '').trim(), 12000, logger, 'multi_agent');
		if (!passage) {
			return { perspectives: [], synthesis: '', consensus: '' };
		}
		const roles =
			options.enabledAgents && options.enabledAgents.length > 0
				? options.enabledAgents
				: ['Writer', 'Editor', 'Researcher', 'Critic'];

		const prompt =
			`Critique the passage from each of these perspectives: ${roles.join(', ')}. ` +
			'Then synthesize the feedback and state the consensus on what to change first. ' +
			'Return JSON with exactly this shape: {"perspectives":[{"role":"Editor",' +
			'"feedback":"..."}],"synthesis":"...","consensus":"..."}\n\n' +
			`Passage:\n${untrustedBlock(passage)}`;

		const raw = await this.ai.chat(prompt, {
			system: SYSTEM_PROMPT,
			temperature: 0.3,
			maxTokens: 2000,
		});
		const parsed = parseJsonObject(raw);
		const result: CollaborationResult = {
			perspectives: coercePerspectives(parsed.perspectives),
			synthesis: typeof parsed.synthesis === 'string' ? parsed.synthesis : '',
			consensus: typeof parsed.consensus === 'string' ? parsed.consensus : '',
		};

		logger.debug('AI collaboration complete', {
			provider: this.ai.provider ?? 'none',
			roles: roles.length,
			perspectives: result.perspectives.length,
		});
		return result;
	}
}
