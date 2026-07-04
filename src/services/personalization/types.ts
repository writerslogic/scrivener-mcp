/**
 * Types for the writing-personalization subsystem.
 *
 * Personalization is a single per-project author profile plus a persisted
 * feedback log. Preferences are set explicitly by the author and turned into a
 * directive that is injected into the AI system prompt (real, model-driven
 * adaptation). Feedback is aggregated into honest insights and conservative
 * suggestions -- it never silently mutates the profile.
 */

export type Tone = 'neutral' | 'formal' | 'casual' | 'creative';
export type Complexity = 'balanced' | 'simple' | 'advanced';
export type Length = 'balanced' | 'concise' | 'comprehensive';

export const TONES: readonly Tone[] = ['neutral', 'formal', 'casual', 'creative'];
export const COMPLEXITIES: readonly Complexity[] = ['balanced', 'simple', 'advanced'];
export const LENGTHS: readonly Length[] = ['balanced', 'concise', 'comprehensive'];

/** The author's persisted writing preferences (a single per-project profile). */
export interface WritingPreferences {
	/** Master switch. When false, buildDirective() returns ''. */
	enabled: boolean;
	tone: Tone;
	complexity: Complexity;
	length: Length;
	/** Narrative point of view, e.g. "third-person limited". Free text. */
	pointOfView?: string;
	/** Style guides to honour, e.g. ["Chicago", "AP"]. */
	styleGuides: string[];
	/** Free-form author instructions appended verbatim to the directive. */
	customInstructions?: string;
	/** ISO timestamp of the last update. */
	updatedAt?: string;
}

/** Fields an author may set; all optional so updates can be partial. */
export type WritingPreferencesInput = Partial<Omit<WritingPreferences, 'updatedAt'>>;

/** A single recorded feedback event for an AI operation. */
export interface FeedbackRecord {
	id: string;
	/** The tool/operation the feedback is about, e.g. "enhance_content". */
	operation: string;
	/** Explicit 1-5 satisfaction rating, when provided. */
	rating?: number;
	/** Implicit signal: did the author keep the AI output? */
	accepted?: boolean;
	/** Optional free-text comment. */
	comment?: string;
	createdAt: string;
}

/** Fields needed to record a feedback event. */
export interface FeedbackInput {
	operation: string;
	rating?: number;
	accepted?: boolean;
	comment?: string;
}

/** Per-operation aggregate of recorded feedback. */
export interface OperationInsight {
	operation: string;
	count: number;
	/** Mean of provided ratings, or null when none were rated. */
	averageRating: number | null;
	/** Fraction of events with accepted === true, or null when none recorded acceptance. */
	acceptanceRate: number | null;
}

/** Aggregated view of the feedback log plus derived, non-binding suggestions. */
export interface FeedbackInsights {
	totalFeedback: number;
	overallAverageRating: number | null;
	byOperation: OperationInsight[];
	/** Human-readable, actionable suggestions. Never auto-applied. */
	suggestions: string[];
}

export const DEFAULT_PREFERENCES: WritingPreferences = {
	enabled: true,
	tone: 'neutral',
	complexity: 'balanced',
	length: 'balanced',
	styleGuides: [],
};
