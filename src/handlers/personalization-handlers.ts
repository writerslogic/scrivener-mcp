/**
 * Writing-personalization MCP handlers.
 * Tools for setting author preferences (which shape AI writing output) and
 * recording feedback that surfaces honest insights. Requires an open project.
 */

import { compact } from '../core/response-formatter.js';
import { COMPLEXITIES, LENGTHS, TONES } from '../services/personalization/types.js';
import type { WritingPreferencesInput } from '../services/personalization/types.js';
import type { HandlerContext, HandlerResult, ToolDefinition } from './types.js';
import {
	getOptionalArrayArg,
	getOptionalBooleanArg,
	getOptionalNumberArg,
	getOptionalStringArg,
	getPersonalization,
	getStringArg,
} from './types.js';

export const setWritingPreferencesHandler: ToolDefinition = {
	name: 'set_writing_preferences',
	title: 'Set Writing Preferences',
	description:
		'Set the author writing preferences that shape AI writing output (enhance_content and other ' +
		'generative tools). Preferences are injected into the AI prompt, so changes take effect on the ' +
		'next enhancement. All fields are optional and merge into the existing profile. Use when the ' +
		'writer states a preferred tone, complexity, length, point of view, style guide, or a custom ' +
		'instruction. Requires an open project (preferences persist in the project database).',
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			enabled: {
				type: 'boolean',
				description:
					'Master switch. When false, preferences are kept but not applied to AI output.',
			},
			tone: {
				type: 'string',
				enum: [...TONES],
				description:
					'Desired tone: "neutral" (no steer), "formal", "casual", or "creative".',
			},
			complexity: {
				type: 'string',
				enum: [...COMPLEXITIES],
				description: 'Language complexity: "balanced" (no steer), "simple", or "advanced".',
			},
			length: {
				type: 'string',
				enum: [...LENGTHS],
				description: 'Verbosity: "balanced" (no steer), "concise", or "comprehensive".',
			},
			pointOfView: {
				type: 'string',
				description:
					'Narrative point of view to maintain, e.g. "third-person limited". Free text; ' +
					'pass an empty string to clear.',
			},
			styleGuides: {
				type: 'array',
				items: { type: 'string' },
				description:
					'Style guides to honour, e.g. ["Chicago"]. Replaces the existing list; pass [] to clear.',
			},
			customInstructions: {
				type: 'string',
				description:
					'Free-form instruction appended verbatim to the AI directive. Pass an empty string to clear.',
			},
		},
		required: [],
	},
	handler: async (args, context: HandlerContext): Promise<HandlerResult> => {
		const input: WritingPreferencesInput = {};
		const enabled = getOptionalBooleanArg(args, 'enabled');
		if (enabled !== undefined) input.enabled = enabled;
		const tone = getOptionalStringArg(args, 'tone');
		if (tone !== undefined) input.tone = tone as WritingPreferencesInput['tone'];
		const complexity = getOptionalStringArg(args, 'complexity');
		if (complexity !== undefined)
			input.complexity = complexity as WritingPreferencesInput['complexity'];
		const length = getOptionalStringArg(args, 'length');
		if (length !== undefined) input.length = length as WritingPreferencesInput['length'];
		const pointOfView = getOptionalStringArg(args, 'pointOfView');
		if (pointOfView !== undefined) input.pointOfView = pointOfView;
		const styleGuides = getOptionalArrayArg<string>(args, 'styleGuides');
		if (styleGuides !== undefined) input.styleGuides = styleGuides;
		const customInstructions = getOptionalStringArg(args, 'customInstructions');
		if (customInstructions !== undefined) input.customInstructions = customInstructions;

		const preferences = await getPersonalization(context).setPreferences(input);

		return {
			content: [{ type: 'text', text: `Writing preferences saved\n${compact(preferences)}` }],
		};
	},
};

export const getWritingPreferencesHandler: ToolDefinition = {
	name: 'get_writing_preferences',
	title: 'Get Writing Preferences',
	description:
		'Return the current author writing preferences plus feedback insights: how much feedback has ' +
		'been recorded, average satisfaction per operation, and non-binding suggestions for adjusting ' +
		'preferences. Use to review what is currently steering AI output, or to see whether recorded ' +
		'feedback points to a change. Related: set_writing_preferences, collect_feedback. Requires an ' +
		'open project.',
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {},
		required: [],
	},
	handler: async (_args, context: HandlerContext): Promise<HandlerResult> => {
		const personalization = getPersonalization(context);
		const preferences = await personalization.getPreferences();
		const insights = await personalization.getInsights();

		return {
			content: [
				{
					type: 'text',
					text: compact({ preferences, insights }),
				},
			],
		};
	},
};

export const collectFeedbackHandler: ToolDefinition = {
	name: 'collect_feedback',
	title: 'Collect Feedback',
	description:
		'Record feedback on an AI operation (e.g. "enhance_content") so it feeds the insights returned ' +
		'by get_writing_preferences. Provide a 1-5 rating, whether the output was kept (accepted), and/or ' +
		'a comment. Use after the writer reacts to AI output. Requires an open project.',
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: false,
	},
	inputSchema: {
		type: 'object',
		properties: {
			operation: {
				type: 'string',
				description:
					'The operation being rated, e.g. "enhance_content" or "compile_documents".',
			},
			rating: {
				type: 'number',
				minimum: 1,
				maximum: 5,
				description: 'Satisfaction rating from 1 (poor) to 5 (excellent). Optional.',
			},
			accepted: {
				type: 'boolean',
				description:
					'Whether the AI output was kept (true) or discarded (false). Optional.',
			},
			comment: {
				type: 'string',
				description: 'Optional free-text comment.',
			},
		},
		required: ['operation'],
	},
	handler: async (args, context: HandlerContext): Promise<HandlerResult> => {
		const operation = getStringArg(args, 'operation');
		const rating = getOptionalNumberArg(args, 'rating');
		const accepted = getOptionalBooleanArg(args, 'accepted');
		const comment = getOptionalStringArg(args, 'comment');

		const record = await getPersonalization(context).recordFeedback({
			operation,
			rating,
			accepted,
			comment,
		});

		return {
			content: [{ type: 'text', text: `Feedback recorded\n${compact(record)}` }],
		};
	},
};

export const personalizationHandlers: ToolDefinition[] = [
	setWritingPreferencesHandler,
	getWritingPreferencesHandler,
	collectFeedbackHandler,
];
