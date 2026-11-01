import { createHash } from 'node:crypto';
import { AIClient } from '../ai/ai-client.js';
import { getLogger } from '../../core/logger.js';
import { parseModelJson } from '../../utils/json-parse.js';
import { untrustedBlock } from '../../utils/prompt-input.js';

const logger = getLogger('ai-collaboration');
export const COLLABORATION_ROLES = [
	'editor',
	'critic',
	'researcher',
	'stylist',
	'plotter',
] as const;
export const COLLABORATION_MODES = ['collaborative', 'workshop', 'review'] as const;
type CollaborationRole = (typeof COLLABORATION_ROLES)[number];
type CollaborationMode = (typeof COLLABORATION_MODES)[number];
const MAX_CONTEXT = 12000;
const MAX_SOURCE = 5_000_000;

export interface CollaborationOptions {
	enabledAgents?: string[];
	mode?: CollaborationMode;
}

export interface CollaborationResult {
	method: 'single-provider-perspectives';
	agents: CollaborationRole[];
	collaborationMode: CollaborationMode;
	perspectives: Array<{ role: CollaborationRole; feedback: string }>;
	synthesis: string | null;
	consensus: string | null;
	availability: {
		status: 'available' | 'partial' | 'unavailable';
		unavailableFields: Array<'perspectives' | 'synthesis' | 'consensus'>;
		unavailableRoles: CollaborationRole[];
		partialFields: Array<'perspectives'>;
		reason?: 'no_text' | 'invalid_response';
	};
	coverage: {
		start: 0;
		end: number;
		sourceCharacters: number;
		sourceRevision: string;
		truncated: boolean;
	};
}

export function collaborationRoles(value: unknown): CollaborationRole[] {
	if (value === undefined || (Array.isArray(value) && value.length === 1 && value[0] === 'all'))
		return [...COLLABORATION_ROLES];
	if (
		!Array.isArray(value) ||
		!value.length ||
		value.length > COLLABORATION_ROLES.length ||
		[...value].some((role) => !COLLABORATION_ROLES.includes(role)) ||
		new Set(value).size !== value.length
	)
		throw new Error('Choose 1–5 unique supported perspectives, or all by itself');
	return [...value];
}

export class AICollaboration {
	constructor(private readonly ai: AIClient = new AIClient()) {}

	async collaborateOnDocument(
		document: { content?: string; title?: string },
		options: CollaborationOptions = {}
	): Promise<CollaborationResult> {
		const content = document.content === undefined ? '' : document.content;
		if (typeof content !== 'string' || content.length > MAX_SOURCE)
			throw new Error('Critique source must contain at most 5000000 UTF-16 characters');
		const roles = collaborationRoles(options.enabledAgents);
		const mode = options.mode === undefined ? 'collaborative' : options.mode;
		if (!COLLABORATION_MODES.includes(mode)) throw new Error('Unsupported collaboration mode');
		let end = Math.min(content.length, MAX_CONTEXT);
		if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1])) end--;
		if (!content.trim()) end = 0;
		const result: CollaborationResult = {
			method: 'single-provider-perspectives',
			agents: roles,
			collaborationMode: mode,
			perspectives: [],
			synthesis: null,
			consensus: null,
			availability: {
				status: 'unavailable',
				unavailableFields: ['perspectives', 'synthesis', 'consensus'],
				unavailableRoles: [...roles],
				partialFields: [],
			},
			coverage: {
				start: 0,
				end,
				sourceCharacters: content.length,
				sourceRevision: createHash('sha256').update(content).digest('hex'),
				truncated: end < content.length,
			},
		};
		if (!end) {
			result.availability.reason = 'no_text';
			return result;
		}
		const instructions: Record<CollaborationMode, string> = {
			collaborative:
				'Compare where the perspectives agree or conflict and synthesize shared priorities.',
			workshop:
				'For each perspective, challenge the draft with specific evidence and propose a concrete revision exercise; synthesize a workshop plan.',
			review: 'For each perspective, review strengths and weaknesses against its criteria; synthesize a prioritized review without rewriting the passage.',
		};
		const raw = await this.ai.chat(
			`Critique the passage from each of these perspectives: ${roles.join(', ')}. ${instructions[mode]} ` +
				'State the consensus on what to change first. Return JSON: ' +
				'{"perspectives":[{"role":"editor","feedback":"..."}],"synthesis":"...","consensus":"..."}. ' +
				`Use only the requested role names.\n\nPassage:\n${untrustedBlock(content.slice(0, end))}`,
			{
				system: 'You are a writing workshop facilitator providing multiple perspectives in one response. Respond with STRICT JSON only.',
				temperature: 0.3,
				maxTokens: 3000,
			}
		);
		const parsed = parseModelJson(raw, logger);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
			throw new Error('Critique unavailable: provider returned no valid JSON object');
		const data = parsed as Record<string, unknown>;
		let invalidPerspectives = false;
		if (Array.isArray(data.perspectives)) {
			for (const item of data.perspectives) {
				const role =
					typeof item?.role === 'string' ? String(item.role).trim().toLowerCase() : '';
				const requested = roles.find((candidate) => candidate === role);
				if (requested && typeof item?.feedback === 'string' && item.feedback.trim())
					result.perspectives.push({ role: requested, feedback: item.feedback });
				else invalidPerspectives = true;
			}
		}
		for (const field of ['synthesis', 'consensus'] as const)
			if (typeof data[field] === 'string' && data[field].trim()) result[field] = data[field];
		result.availability.unavailableRoles = roles.filter(
			(role) => !result.perspectives.some((p) => p.role === role)
		);
		result.availability.unavailableFields = result.availability.unavailableFields.filter(
			(field) =>
				field === 'perspectives' ? !result.perspectives.length : result[field] === null
		);
		if (
			result.perspectives.length &&
			(invalidPerspectives || result.availability.unavailableRoles.length)
		)
			result.availability.partialFields.push('perspectives');
		result.availability.status =
			result.availability.unavailableFields.length === 3
				? 'unavailable'
				: result.availability.unavailableFields.length ||
					  result.availability.partialFields.length
					? 'partial'
					: 'available';
		if (result.availability.status === 'unavailable')
			result.availability.reason = 'invalid_response';
		return result;
	}
}
