/**
 * Core type definitions
 */

// Database types
export interface DatabaseRecord {
	[key: string]: string | number | boolean | null | undefined;
}

export interface QueryParameters {
	[key: string]: string | number | boolean | string[] | number[] | null;
}

export interface QueryResult<T = DatabaseRecord> {
	records: T[];
	summary?: {
		counters?: Record<string, number>;
		timers?: Record<string, number>;
	};
}

// Document types
export interface ScrivenerDocument {
	id: string;
	title: string;
	type: 'Text' | 'Folder' | 'Other';
	path: string;
	content?: string;
	synopsis?: string;
	notes?: string;
	label?: string;
	status?: string;
	includeInCompile?: boolean;
	children?: ScrivenerDocument[];
	customMetadata?: Record<string, string>;
	keywords?: string[];
}

export interface ScrivenerMetadata {
	title?: string;
	author?: string;
	keywords?: string[];
	projectTargets?: {
		draft?: number;
		session?: number;
		deadline?: string;
	};
	customFields?: Record<string, string>;
}

export interface DocumentContent {
	content: string;
	format?: 'text' | 'rtf' | 'markdown' | 'html';
	encoding?: string;
}

export interface DocumentMetadata {
	id: string;
	title: string;
	type: 'Text' | 'Folder' | 'Other';
	synopsis?: string;
	notes?: string;
	label?: string;
	status?: string;
	wordCount?: number;
	characterCount?: number;
	created?: Date;
	modified?: Date;
	includeInCompile?: boolean;
	customMetadata?: Record<string, string>;
}

export interface DocumentInfo extends DocumentMetadata {
	path: string[];
	children?: DocumentInfo[];
	content?: string;
}

export interface DocumentSearchResult {
	documentId: string;
	title: string;
	matches: Array<{
		field: string;
		context: string;
		position: number;
	}>;
	score?: number;
}

// Style and formatting types
export interface TextStyle {
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	fontSize?: number;
	fontFamily?: string;
	color?: string;
	backgroundColor?: string;
}

export interface FormattedContent {
	content: string;
	styles: Array<{
		start: number;
		end: number;
		style: TextStyle;
	}>;
	metadata?: DocumentMetadata;
}

// Analysis types
export interface AnalysisResult {
	readability?: {
		score: number;
		gradeLevel: number;
		readingTime: number;
		difficulty: 'easy' | 'moderate' | 'difficult';
	};
	sentiment?: {
		score: number;
		label: 'positive' | 'negative' | 'neutral' | 'mixed';
		emotions?: Record<string, number>;
	};
	themes?: Array<{
		theme: string;
		confidence: number;
		mentions: number;
	}>;
	characters?: Array<{
		name: string;
		mentions: number;
		sentiment: number;
		relationships: Array<{
			character: string;
			type: string;
		}>;
	}>;
	pacing?: {
		score: number;
		label: 'slow' | 'moderate' | 'fast';
		variations: number[];
	};
	suggestions?: string[];
}

// Enhancement types
export interface EnhancementOptions {
	style?: 'formal' | 'casual' | 'creative' | 'academic';
	tone?: 'friendly' | 'professional' | 'neutral' | 'assertive';
	targetLength?: number;
	preserveVoice?: boolean;
	focusAreas?: string[];
}

export interface EnhancementResult {
	content: string;
	changes: Array<{
		type: string;
		original: string;
		suggested: string;
		reason: string;
	}>;
	suggestions: string[];
	metadata: {
		wordCountBefore: number;
		wordCountAfter: number;
		readabilityBefore: number;
		readabilityAfter: number;
	};
}

// Memory types
export interface CharacterData {
	id: string;
	name: string;
	role: 'protagonist' | 'antagonist' | 'supporting' | 'minor';
	description: string;
	traits: string[];
	arc: string;
	relationships: Array<{
		characterId: string;
		relationship: string;
	}>;
	appearances: Array<{
		documentId: string;
		context: string;
	}>;
	notes?: string;
}

export interface PlotThreadData {
	id: string;
	name: string;
	description: string;
	status: 'setup' | 'development' | 'climax' | 'resolution';
	documents: string[];
	keyEvents: Array<{
		documentId: string;
		event: string;
	}>;
}

export interface WorldElementData {
	id: string;
	name: string;
	type: 'location' | 'object' | 'concept' | 'organization';
	description: string;
	significance: string;
	appearances: Array<{
		documentId: string;
		context: string;
	}>;
}

// Compilation types
export interface CompilationOptions {
	format: 'text' | 'markdown' | 'html';
	rootFolderId?: string;
	includeSynopsis?: boolean;
	includeNotes?: boolean;
	separator?: string;
	hierarchical?: boolean;
	template?: string;
}

export interface ExportOptions {
	format: 'markdown' | 'html' | 'json' | 'epub';
	outputPath?: string;
	includeMetadata?: boolean;
	includeStyles?: boolean;
	customCSS?: string;
	template?: string;
}

// Project types
export interface ProjectMetadata {
	title?: string;
	author?: string;
	description?: string;
	keywords?: string[];
	created?: Date;
	modified?: Date;
	version?: string;
	settings?: Record<string, unknown>;
}

export interface ProjectStructure {
	root: DocumentInfo;
	draft?: DocumentInfo;
	research?: DocumentInfo;
	trash?: DocumentInfo;
	templates?: DocumentInfo[];
}

export interface ProjectSummary {
	totalDocuments: number;
	totalFolders: number;
	totalWords: number;
	totalCharacters: number;
	draftDocuments: number;
	researchDocuments: number;
	trashedDocuments: number;
	metadata: ProjectMetadata;
}

export interface ProjectStatistics extends ProjectSummary {
	documentsByType: Record<string, number>;
	documentsByStatus: Record<string, number>;
	documentsByLabel: Record<string, number>;
	averageDocumentLength: number;
	longestDocument: DocumentInfo | null;
	shortestDocument: DocumentInfo | null;
	recentlyModified: DocumentInfo[];
}

// Consistency check types
export interface ConsistencyIssue {
	type: 'character' | 'timeline' | 'location' | 'plot';
	severity: 'error' | 'warning' | 'info';
	documentId?: string;
	description: string;
	suggestion?: string;
}

// Cache types
export interface CacheEntry<T> {
	data: T;
	timestamp: number;
	ttl: number;
	size?: number;
}

export interface CacheOptions {
	ttl?: number;
	maxSize?: number;
	maxEntries?: number;
	onEvict?: (key: string, value: unknown) => void;
}

// Error types
export interface ErrorDetails {
	code: string;
	message: string;
	details?: unknown;
	stack?: string;
	timestamp: Date;
}

// Validation types
export interface ValidationRule {
	type: 'string' | 'number' | 'boolean' | 'array' | 'object';
	required?: boolean;
	minLength?: number;
	maxLength?: number;
	min?: number;
	max?: number;
	pattern?: RegExp;
	enum?: readonly unknown[];
	custom?: (value: unknown) => boolean | string;
}

export interface ValidationSchema {
	[field: string]: ValidationRule;
}

// Neo4j specific types
export interface Neo4jNode {
	identity: { low: number; high: number };
	labels: string[];
	properties: Record<string, unknown>;
}

export interface Neo4jRelationship {
	identity: { low: number; high: number };
	start: { low: number; high: number };
	end: { low: number; high: number };
	type: string;
	properties: Record<string, unknown>;
}

export interface Neo4jInteger {
	low: number;
	high: number;
	toNumber(): number;
}
