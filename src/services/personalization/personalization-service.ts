/**
 * PersonalizationService -- the single entry point for writing personalization.
 *
 * Consolidates what were three overlapping services (feedback collection,
 * continuous-learning, personalization-engine) into one:
 *   - explicit author preferences, persisted per project;
 *   - a directive derived from those preferences and injected into AI system
 *     prompts (real, model-driven adaptation -- no output string-munging);
 *   - a persisted feedback log aggregated into honest insights and
 *     non-binding suggestions.
 *
 * All state lives in the project's SQLite database. With no database (no project
 * open) the service degrades cleanly: buildDirective() returns '' and writes
 * throw an actionable error.
 */

import { AppError, ErrorCode } from '../../utils/common.js';
import { getLogger } from '../../core/logger.js';
import type { DatabaseService } from '../../handlers/database/database-service.js';
import {
	COMPLEXITIES,
	DEFAULT_PREFERENCES,
	LENGTHS,
	TONES,
	type FeedbackInput,
	type FeedbackInsights,
	type FeedbackRecord,
	type OperationInsight,
	type WritingPreferences,
	type WritingPreferencesInput,
} from './types.js';

const logger = getLogger('personalization');

/** Minimum feedback events for an operation before we offer a suggestion. */
const SUGGESTION_MIN_SAMPLES = 3;
const LOW_RATING_THRESHOLD = 3;
const LOW_ACCEPTANCE_THRESHOLD = 0.4;

export class PersonalizationService {
	private readonly db: DatabaseService | null;

	constructor(db: DatabaseService | null) {
		this.db = db;
	}

	/** True when preferences and feedback can be persisted. */
	get isAvailable(): boolean {
		return this.db !== null;
	}

	/** Current preferences, or defaults when unavailable / unset. */
	async getPreferences(): Promise<WritingPreferences> {
		if (!this.db) {
			return { ...DEFAULT_PREFERENCES };
		}
		return this.db.getWritingPreferences();
	}

	/**
	 * Merge a partial update into the current profile, validate it, and persist.
	 * @throws when no project/database is available or a value is invalid.
	 */
	async setPreferences(input: WritingPreferencesInput): Promise<WritingPreferences> {
		if (!this.db) {
			throw new AppError(
				'No project is open. Open a project before setting writing preferences.',
				ErrorCode.SERVICE_UNAVAILABLE
			);
		}
		const current = await this.db.getWritingPreferences();
		const merged = this.validate({ ...current, ...input });
		const saved = await this.db.saveWritingPreferences(merged);
		logger.info('Writing preferences updated', {
			enabled: saved.enabled,
			tone: saved.tone,
			complexity: saved.complexity,
			length: saved.length,
		});
		return saved;
	}

	/**
	 * Build the preference directive to append to an AI system prompt. Returns
	 * '' when personalization is unavailable, disabled, or has no active
	 * preferences -- so callers can concatenate unconditionally.
	 */
	async buildDirective(): Promise<string> {
		if (!this.db) {
			return '';
		}
		const prefs = await this.db.getWritingPreferences();
		return PersonalizationService.directiveFor(prefs);
	}

	/** Pure preferences -> directive mapping (exposed for testing). */
	static directiveFor(prefs: WritingPreferences): string {
		if (!prefs.enabled) {
			return '';
		}
		const parts: string[] = [];

		switch (prefs.tone) {
			case 'formal':
				parts.push('Write in a formal, polished tone.');
				break;
			case 'casual':
				parts.push('Write in a casual, conversational tone.');
				break;
			case 'creative':
				parts.push('Write with vivid, expressive, creative language.');
				break;
			case 'neutral':
				break;
		}

		switch (prefs.complexity) {
			case 'simple':
				parts.push('Use clear, direct language and simple sentence structures.');
				break;
			case 'advanced':
				parts.push(
					'Use sophisticated vocabulary and nuanced sentence structures suited to an advanced reader.'
				);
				break;
			case 'balanced':
				break;
		}

		switch (prefs.length) {
			case 'concise':
				parts.push('Favor concision; keep the writing economical.');
				break;
			case 'comprehensive':
				parts.push('Be thorough; develop ideas fully and completely.');
				break;
			case 'balanced':
				break;
		}

		if (prefs.pointOfView && prefs.pointOfView.trim()) {
			parts.push(`Maintain a ${prefs.pointOfView.trim()} narrative point of view.`);
		}
		if (prefs.styleGuides.length > 0) {
			parts.push(`Follow the ${prefs.styleGuides.join(' and ')} style guide(s).`);
		}
		if (prefs.customInstructions && prefs.customInstructions.trim()) {
			parts.push(prefs.customInstructions.trim());
		}

		if (parts.length === 0) {
			return '';
		}
		return `Author preferences to honour:\n- ${parts.join('\n- ')}`;
	}

	/** Record one feedback event. @throws when no project/database is available. */
	async recordFeedback(input: FeedbackInput): Promise<FeedbackRecord> {
		if (!this.db) {
			throw new AppError(
				'No project is open. Open a project before recording feedback.',
				ErrorCode.SERVICE_UNAVAILABLE
			);
		}
		if (!input.operation || !input.operation.trim()) {
			throw new AppError('Feedback requires an operation name.', ErrorCode.INVALID_INPUT);
		}
		if (input.rating !== undefined) {
			if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
				throw new AppError(
					'rating must be an integer from 1 to 5.',
					ErrorCode.INVALID_INPUT
				);
			}
		}
		return this.db.recordFeedback(input);
	}

	/** Aggregate the feedback log into insights and non-binding suggestions. */
	async getInsights(): Promise<FeedbackInsights> {
		const empty: FeedbackInsights = {
			totalFeedback: 0,
			overallAverageRating: null,
			byOperation: [],
			suggestions: [],
		};
		if (!this.db) {
			return empty;
		}
		const records = await this.db.getFeedbackRecords();
		if (records.length === 0) {
			return empty;
		}

		const groups = new Map<string, FeedbackRecord[]>();
		for (const record of records) {
			const list = groups.get(record.operation) ?? [];
			list.push(record);
			groups.set(record.operation, list);
		}

		const byOperation: OperationInsight[] = [];
		for (const [operation, list] of groups) {
			byOperation.push({
				operation,
				count: list.length,
				averageRating: mean(list.map((r) => r.rating).filter(isNumber)),
				acceptanceRate: rate(list.map((r) => r.accepted).filter(isBoolean)),
			});
		}
		byOperation.sort((a, b) => b.count - a.count);

		const prefs = await this.db.getWritingPreferences();
		return {
			totalFeedback: records.length,
			overallAverageRating: mean(records.map((r) => r.rating).filter(isNumber)),
			byOperation,
			suggestions: buildSuggestions(byOperation, prefs),
		};
	}

	private validate(prefs: WritingPreferences): WritingPreferences {
		if (!TONES.includes(prefs.tone)) {
			throw new AppError(
				`Invalid tone "${prefs.tone}". Expected one of: ${TONES.join(', ')}.`,
				ErrorCode.INVALID_INPUT
			);
		}
		if (!COMPLEXITIES.includes(prefs.complexity)) {
			throw new AppError(
				`Invalid complexity "${prefs.complexity}". Expected one of: ${COMPLEXITIES.join(', ')}.`,
				ErrorCode.INVALID_INPUT
			);
		}
		if (!LENGTHS.includes(prefs.length)) {
			throw new AppError(
				`Invalid length "${prefs.length}". Expected one of: ${LENGTHS.join(', ')}.`,
				ErrorCode.INVALID_INPUT
			);
		}
		if (!Array.isArray(prefs.styleGuides)) {
			throw new AppError('styleGuides must be an array of strings.', ErrorCode.INVALID_INPUT);
		}
		const styleGuides = prefs.styleGuides
			.filter((g): g is string => typeof g === 'string')
			.map((g) => g.trim())
			.filter((g) => g.length > 0);
		return { ...prefs, styleGuides };
	}
}

function isNumber(value: number | undefined): value is number {
	return typeof value === 'number';
}
function isBoolean(value: boolean | undefined): value is boolean {
	return typeof value === 'boolean';
}
function mean(values: number[]): number | null {
	if (values.length === 0) {
		return null;
	}
	return values.reduce((sum, v) => sum + v, 0) / values.length;
}
function rate(values: boolean[]): number | null {
	if (values.length === 0) {
		return null;
	}
	return values.filter(Boolean).length / values.length;
}

function buildSuggestions(byOperation: OperationInsight[], prefs: WritingPreferences): string[] {
	const suggestions: string[] = [];
	for (const op of byOperation) {
		if (op.count < SUGGESTION_MIN_SAMPLES) {
			continue;
		}
		if (op.averageRating !== null && op.averageRating < LOW_RATING_THRESHOLD) {
			suggestions.push(
				`Satisfaction for ${op.operation} is low (avg ${op.averageRating.toFixed(1)} over ${op.count}). Consider adjusting your writing preferences or adding custom instructions.`
			);
		}
		if (op.acceptanceRate !== null && op.acceptanceRate < LOW_ACCEPTANCE_THRESHOLD) {
			suggestions.push(
				`You keep ${Math.round(op.acceptanceRate * 100)}% of ${op.operation} output. Refining preferences may improve fit.`
			);
		}
	}
	if (!prefs.enabled && byOperation.length > 0) {
		suggestions.push(
			'Personalization is currently disabled; enable it to tailor AI output to your preferences.'
		);
	}
	return suggestions;
}
