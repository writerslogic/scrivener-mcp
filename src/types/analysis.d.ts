// Type definitions for analysis modules

export type {
	ReadabilityMetrics,
	ComparativeAnalysis as ReadabilityComparison,
	ReadabilityTrends,
} from '../analysis/advanced-readability.js';

export interface WritingSuggestion {
	type: string;
	severity?: string;
	original?: string;
	suggestion?: string;
	text?: string;
	reason?: string;
	explanation?: string;
	confidence: number;
}

export interface StyleAnalysis {
	tone: string;
	voice: string;
	pacing: string;
	strengths: string[];
	improvements: string[];
}

export interface CharacterAnalysis {
	name: string;
	role: string;
	traits: string[];
	development: string;
	relationships: Array<{ character: string; type: string }>;
}

export interface PlotAnalysis {
	structure: string;
	pacing: string;
	conflict: string;
	resolution: string;
	suggestions: string[];
}

export interface ParsedWebContent {
	title?: string;
	content: string;
	author?: string;
	publishDate?: string;
	summary?: string;
	metadata: {
		wordCount?: number;
		paragraphCount?: number;
		imageCount?: number;
		linkCount?: number;
		headingCount?: number;
		[key: string]: string | number | boolean | undefined;
	};
	images: Array<{ url?: string; src?: string; alt?: string; caption?: string; title?: string }>;
	links: Array<{ url: string; text: string; type?: string }>;
	headings?: Array<{ level: number; text: string; id?: string }>;
	quotes?: string[];
	researchData?: ResearchData;
}

export interface ResearchData {
	quotes:
		| string[]
		| Array<{
				text: string;
				context?: string;
				index: number;
		  }>;
	facts: string[];
	statistics?: string[];
	sources:
		| Array<string>
		| Array<{
				url?: string;
				title?: string;
				author?: string;
				date?: string;
		  }>;
	keyTerms: string[];
	relevanceScore?: number;
	summary?: string;
}

export interface ContentExtractionOptions {
	convertToMarkdown?: boolean;
	extractResearchData?: boolean;
	preserveFormatting?: boolean;
	includeMetadata?: boolean;
	mainContentSelector?: string;
	includeLinks?: boolean;
	includeImages?: boolean;
	includeHeadings?: boolean;
	removeElements?: string[];
}

export interface WritingPrompt {
	prompt: string;
	genre: string;
	tone: string;
	targetLength: string;
	additionalContext?: string;
}
