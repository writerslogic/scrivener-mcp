/**
 * Types for content enhancement modules
 */

import type { StyleGuide } from '../memory-manager.js';

export type EnhancementType =
	| 'rewrite'
	| 'expand'
	| 'condense'
	| 'improve-flow'
	| 'enhance-descriptions'
	| 'strengthen-dialogue'
	| 'fix-pacing'
	| 'add-sensory-details'
	| 'show-dont-tell'
	| 'eliminate-filter-words'
	| 'vary-sentences'
	| 'strengthen-verbs'
	| 'fix-continuity'
	| 'match-style';

export interface EnhancementOptions {
	tone?: 'maintain' | 'lighter' | 'darker' | 'more-serious' | 'more-humorous';
	length?: 'maintain' | 'shorter' | 'longer' | number;
	complexity?: 'simplify' | 'maintain' | 'elevate';
	perspective?: 'maintain' | 'first' | 'second' | 'third-limited' | 'third-omniscient';
	tense?: 'maintain' | 'past' | 'present' | 'future';
	preserveDialogue?: boolean;
	preserveNames?: boolean;
	aggressiveness?: 'light' | 'moderate' | 'heavy';
}

export interface EnhancementRequest {
	content: string;
	type: EnhancementType;
	options?: EnhancementOptions;
	styleGuide?: StyleGuide;
	context?: string;
}

export interface EnhancementResult {
	original: string;
	enhanced: string;
	changes: Change[];
	metrics: {
		originalWordCount: number;
		enhancedWordCount: number;
		readabilityChange: number;
		changesApplied: number;
	};
	suggestions: string[];
}

export interface Change {
	type: string;
	original: string;
	replacement: string;
	reason: string;
	location: { start: number; end: number };
}

export interface WritingPrompt {
	type: 'scene' | 'dialogue' | 'description' | 'action' | 'transition' | 'opening' | 'ending';
	context: string;
	constraints?: {
		wordCount?: { min?: number; max?: number };
		includeCharacters?: string[];
		setting?: string;
		mood?: string;
		conflict?: string;
		pointOfView?: string;
	};
	styleGuide?: StyleGuide;
}

export interface GeneratedContent {
	content: string;
	type: string;
	wordCount: number;
	suggestions: string[];
	alternativeVersions?: string[];
}

// Enhancement strategy interface
export interface EnhancementStrategy {
	enhance(
		content: string,
		options: EnhancementOptions
	): {
		enhanced: string;
		changes: Change[];
	};
}
