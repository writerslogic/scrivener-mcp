/**
 * Writing goal MCP handlers.
 * Tools for setting word-count goals and tracking progress against the open project.
 */

import { compact } from '../core/response-formatter.js';
import { createError, ErrorCode } from '../core/errors.js';
import type { WritingGoalRecord } from './database/database-service.js';
import type { HandlerContext, HandlerResult, ToolDefinition } from './types.js';
import { getNumberArg, getOptionalStringArg, getStringArg, requireProject } from './types.js';

const GOAL_TYPES = ['daily', 'weekly', 'project'] as const;
type GoalType = (typeof GOAL_TYPES)[number];

/** Progress view of a goal, derived from its target and achieved word count. */
export interface GoalProgress {
	id: string;
	type: string;
	targetWords: number;
	targetDate: string | null;
	status: string;
	achievedWords: number;
	progressPercent: number;
	wordsRemaining: number;
	onTrack: boolean;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

/**
 * Compute progress for a single goal. Pure and deterministic so callers (and tests)
 * can reason about the math without a database.
 *
 * - `project` goals measure against the live project word count; `daily`/`weekly`
 *   goals measure against the words recorded on the goal itself.
 * - `progressPercent` is clamped to 0-100; `wordsRemaining` never goes negative.
 * - `onTrack` is pace-based when a target date exists: achieved words must meet the
 *   share of the target proportional to elapsed time. With no date, only a met goal
 *   counts as on track once there is a positive target.
 */
export function computeGoalProgress(
	goal: WritingGoalRecord,
	currentProjectWords: number,
	now: number = Date.now()
): GoalProgress {
	const achievedWords = goal.type === 'project' ? currentProjectWords : goal.actualWords;
	const target = goal.targetWords;

	const progressPercent =
		target > 0 ? clamp(Math.round((achievedWords / target) * 100), 0, 100) : 0;
	const wordsRemaining = Math.max(0, target - achievedWords);

	let onTrack: boolean;
	if (target <= 0) {
		onTrack = false;
	} else if (wordsRemaining === 0) {
		onTrack = true;
	} else if (goal.targetDate) {
		const start = Date.parse(goal.createdAt);
		const end = Date.parse(goal.targetDate);
		if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
			onTrack = false;
		} else {
			const elapsedFraction = clamp((now - start) / (end - start), 0, 1);
			onTrack = achievedWords >= target * elapsedFraction;
		}
	} else {
		onTrack = false;
	}

	return {
		id: goal.id,
		type: goal.type,
		targetWords: target,
		targetDate: goal.targetDate,
		status: goal.status,
		achievedWords,
		progressPercent,
		wordsRemaining,
		onTrack,
	};
}

function databaseUnavailable(): HandlerResult {
	return {
		content: [
			{
				type: 'text',
				text:
					'Writing goals require the project database, which is not available. ' +
					'Open a project so its database initializes, then retry.',
			},
		],
		isError: true,
	};
}

function assertGoalType(value: string): GoalType {
	if (!(GOAL_TYPES as readonly string[]).includes(value)) {
		throw createError(
			ErrorCode.INVALID_INPUT,
			{ type: value, allowed: GOAL_TYPES },
			`Unknown goal type "${value}". Use one of: ${GOAL_TYPES.join(', ')}.`
		);
	}
	return value as GoalType;
}

function assertTargetWords(value: number): number {
	if (!Number.isInteger(value) || value <= 0) {
		throw createError(
			ErrorCode.INVALID_INPUT,
			{ targetWords: value },
			'targetWords must be a positive whole number of words (e.g. 1000).'
		);
	}
	return value;
}

function assertTargetDate(value: string | undefined): string | null {
	if (value === undefined) return null;
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) {
		throw createError(
			ErrorCode.INVALID_INPUT,
			{ targetDate: value },
			'targetDate must be an ISO date such as "2026-12-31".'
		);
	}
	return value;
}

export const setWritingGoalHandler: ToolDefinition = {
	name: 'set_writing_goal',
	title: 'Set Writing Goal',
	description:
		'Create or replace the active word-count goal for a cadence (daily, weekly, or whole project), ' +
		'optionally with a target date. Setting a goal of a type that already has an active goal updates ' +
		'that goal in place rather than stacking duplicates. Use when the writer commits to a target ' +
		'("write 1000 words a day", "finish an 80k novel by December"); not when you only want to read ' +
		'current progress (use get_writing_goals) or log a finished session. Related: get_writing_goals, ' +
		'predict_completion. Requires the project database.',
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			type: {
				type: 'string',
				enum: [...GOAL_TYPES],
				description:
					'Goal cadence: "daily" or "weekly" track words written in that window; ' +
					'"project" tracks the whole manuscript toward a final length.',
			},
			targetWords: {
				type: 'number',
				minimum: 1,
				description:
					'Target word count for this goal, a positive whole number (e.g. 1000 for a daily ' +
					'goal, 80000 for a novel-length project goal).',
			},
			targetDate: {
				type: 'string',
				description:
					'Optional deadline as an ISO date, e.g. "2026-12-31". Used to judge whether progress ' +
					'is on pace. Omit for an open-ended goal.',
			},
		},
		required: ['type', 'targetWords'],
	},
	handler: async (args, context): Promise<HandlerResult> => {
		if (!context.databaseService) {
			return databaseUnavailable();
		}

		const type = assertGoalType(getStringArg(args, 'type'));
		const targetWords = assertTargetWords(getNumberArg(args, 'targetWords'));
		const targetDate = assertTargetDate(getOptionalStringArg(args, 'targetDate'));

		const goal = await context.databaseService.setWritingGoal({
			type,
			targetWords,
			targetDate,
		});

		return {
			content: [
				{
					type: 'text',
					text: `Goal saved\n${compact(goal)}`,
				},
			],
		};
	},
};

export const getWritingGoalsHandler: ToolDefinition = {
	name: 'get_writing_goals',
	title: 'Get Writing Goals',
	description:
		'List writing goals with computed progress: percent complete, words remaining, and whether each ' +
		'goal is on pace given its target date and the current project word count. Use when the writer ' +
		'asks how close they are to a goal or for a progress dashboard; not when defining a new goal ' +
		'(use set_writing_goal) or forecasting a finish date from writing velocity (use predict_completion). ' +
		'Related: set_writing_goal. Requires an open project and the project database.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			status: {
				type: 'string',
				enum: ['active', 'completed', 'missed'],
				description:
					'Optional filter by goal status. Omit to list goals of every status; use "active" ' +
					'to see only goals still in progress.',
			},
		},
		required: [],
	},
	outputSchema: {
		type: 'object',
		properties: {
			goals: {
				type: 'array',
				description: 'Goals with computed progress; empty when none match the filter.',
				items: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'Goal identifier.' },
						type: {
							type: 'string',
							description: 'Goal cadence: "daily", "weekly", or "project".',
						},
						targetWords: {
							type: 'number',
							description: 'Target word count for the goal.',
						},
						targetDate: {
							type: ['string', 'null'],
							description: 'ISO deadline, or null for an open-ended goal.',
						},
						status: {
							type: 'string',
							description: 'Goal status, e.g. "active", "completed", "missed".',
						},
						achievedWords: {
							type: 'number',
							description:
								'Words counted toward the goal (live project words for ' +
								'"project" goals, recorded words otherwise).',
						},
						progressPercent: {
							type: 'number',
							description: 'Percent complete, clamped to 0-100.',
						},
						wordsRemaining: {
							type: 'number',
							description: 'Words left to reach the target, never negative.',
						},
						onTrack: {
							type: 'boolean',
							description:
								'Whether achieved words meet the pace implied by the target date.',
						},
					},
					required: [
						'id',
						'type',
						'targetWords',
						'targetDate',
						'status',
						'achievedWords',
						'progressPercent',
						'wordsRemaining',
						'onTrack',
					],
				},
			},
			projectWords: {
				type: 'number',
				description: 'Current total word count of the open project.',
			},
		},
		required: ['goals', 'projectWords'],
	},
	handler: async (args, context: HandlerContext): Promise<HandlerResult> => {
		if (!context.databaseService) {
			return databaseUnavailable();
		}

		const project = requireProject(context);
		const status = getOptionalStringArg(args, 'status');

		const currentWords = await project.getTotalWordCount();
		const goals = await context.databaseService.getWritingGoals(status);
		const progress = goals.map((goal) => computeGoalProgress(goal, currentWords));

		return {
			content: [
				{
					type: 'text',
					text: `${progress.length} goal(s), project at ${currentWords} words\n${compact(progress)}`,
				},
			],
			structuredContent: { goals: progress, projectWords: currentWords },
		};
	},
};

export const goalsHandlers = [setWritingGoalHandler, getWritingGoalsHandler];
