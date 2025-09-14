/**
 * Core type definitions
 */

// Re-export ScrivenerProject as Project for compatibility
export { ScrivenerProject as Project } from '../scrivener-project.js';

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
	wordCount?: number;
	includeInCompile?: boolean;
	children?: ScrivenerDocument[];
	customMetadata?: Record<string, string>;
	keywords?: string[];
	metadata?: Record<string, string>;
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
	draftFolder?: string;
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
	documentId?: string;
	context?: EnhancementContext;
}

export interface EnhancementContext {
	projectId?: string;
	documentType?: 'chapter' | 'scene' | 'outline' | 'research';
	genre?: string;
	targetAudience?: string;
	writingStyle?: string;
	characterNames?: string[];
	locationNames?: string[];
	plotElements?: string[];
	customFields?: Record<string, string | number | boolean>;
}

export interface EnhancementResult {
	content: string;
	enhanced?: string;
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
	metrics?: {
		originalWordCount: number;
		enhancedWordCount: number;
		readabilityChange: number;
		changesApplied: number;
		processingTime?: number;
	};
	qualityValidation?: {
		overallScore: number;
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
	settings?: ProjectSettings;
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

// Legacy error types (replaced by enhanced version below)
interface LegacyErrorDetails {
	code: string;
	message: string;
	details?: Record<string, JSONValue> | string | number | Error;
	stack?: string;
	timestamp: Date;
}

// Legacy validation types (replaced by enhanced version below)
interface LegacyValidationRule {
	type: 'string' | 'number' | 'boolean' | 'array' | 'object';
	required?: boolean;
	minLength?: number;
	maxLength?: number;
	min?: number;
	max?: number;
	pattern?: RegExp;
	enum?: readonly (string | number | boolean)[];
	custom?: (value: unknown) => boolean | string;
}

export interface ValidationSchema {
	[field: string]: LegacyValidationRule;
}

// Neo4j specific types
export interface Neo4jNode {
	identity: { low: number; high: number };
	labels: string[];
	properties: Neo4jProperties;
}

export interface Neo4jRelationship {
	identity: { low: number; high: number };
	start: { low: number; high: number };
	end: { low: number; high: number };
	type: string;
	properties: Neo4jProperties;
}

export interface Neo4jInteger {
	low: number;
	high: number;
	toNumber(): number;
}

// Advanced type definitions for better type safety

// Generic types for common patterns
export type StringOrNumber = string | number;
export type Primitive = string | number | boolean | null | undefined;
export type JSONValue = Primitive | JSONObject | JSONArray;
export interface JSONObject {
	[key: string]: JSONValue;
}
export type JSONArray = JSONValue[];

// Neo4j specific enhanced types
export interface Neo4jProperties {
	[key: string]: string | number | boolean | Date | null | undefined;
}

// Logger context type
export interface LogContext {
	[key: string]: Primitive | JSONObject | JSONArray | Error;
}

// Utility function to safely convert objects to LogContext
export function toLogContext(obj: Record<string, unknown>): LogContext {
	const result: LogContext = {};
	for (const [key, value] of Object.entries(obj)) {
		if (
			value === null || 
			value === undefined || 
			typeof value === 'string' || 
			typeof value === 'number' || 
			typeof value === 'boolean'
		) {
			result[key] = value as Primitive;
		} else if (value instanceof Error) {
			result[key] = value;
		} else if (Array.isArray(value)) {
			try {
				result[key] = value as JSONArray;
			} catch {
				result[key] = '[Complex Array]';
			}
		} else if (typeof value === 'object') {
			try {
				result[key] = value as JSONObject;
			} catch {
				result[key] = '[Complex Object]';
			}
		} else {
			result[key] = String(value);
		}
	}
	return result;
}

// Enhanced cache options
export interface CacheOptions {
	ttl?: number;
	maxSize?: number;
	maxEntries?: number;
	onEvict?: <T>(key: string, value: T) => void;
}

// Project settings type
export interface ProjectSettings {
	autoSave?: boolean;
	backupSettings?: {
		enabled: boolean;
		frequency: number;
		maxBackups: number;
	};
	compilationDefaults?: CompilationOptions;
	exportDefaults?: ExportOptions;
	displaySettings?: {
		theme: 'light' | 'dark' | 'auto';
		fontSize: number;
		fontFamily: string;
	};
	customFields?: Record<string, string | number | boolean>;
}

// Enhanced error details
export interface ErrorDetails {
	code: string;
	message: string;
	details?: Record<string, JSONValue> | string | number | Error;
	stack?: string;
	timestamp: Date;
}

// Enhanced validation rule
export interface ValidationRule {
	type: 'string' | 'number' | 'boolean' | 'array' | 'object';
	required?: boolean;
	minLength?: number;
	maxLength?: number;
	min?: number;
	max?: number;
	pattern?: RegExp;
	enum?: readonly (string | number | boolean)[];
	custom?: (value: unknown) => boolean | string;
}

// Handler types
export interface HandlerRequest<T = JSONObject> {
	method: string;
	params: T;
	context?: RequestContext;
}

export interface HandlerResponse<T = JSONValue> {
	result?: T;
	error?: ErrorDetails;
	metadata?: ResponseMetadata;
}

export interface RequestContext {
	userId?: string;
	sessionId?: string;
	timestamp: Date;
	source: string;
	traceId?: string;
}

export interface ResponseMetadata {
	processingTime?: number;
	cacheHit?: boolean;
	warnings?: string[];
	deprecation?: string;
}

// Service types
export interface ServiceConfig {
	enabled: boolean;
	priority?: number;
	timeout?: number;
	retries?: number;
	dependencies?: string[];
	settings?: Record<string, JSONValue>;
}

export interface ServiceHealth {
	status: 'healthy' | 'degraded' | 'unhealthy';
	uptime: number;
	lastCheck: Date;
	dependencies: Array<{
		name: string;
		status: 'healthy' | 'unhealthy';
		latency?: number;
	}>;
	metrics?: Record<string, number>;
}

// Database operation types
export interface DatabaseOperation {
	type: 'read' | 'write' | 'transaction';
	query: string;
	parameters?: Record<string, Primitive>;
	timeout?: number;
	retries?: number;
}

export interface DatabaseResult<T = DatabaseRecord> {
	records: T[];
	summary?: {
		counters?: Record<string, number>;
		timers?: Record<string, number>;
		plan?: ExecutionPlan;
	};
	metadata?: {
		query: string;
		parameters?: Record<string, Primitive>;
		duration: number;
		cached?: boolean;
	};
}

export interface ExecutionPlan {
	operatorType: string;
	identifiers: string[];
	arguments: Record<string, JSONValue>;
	children: ExecutionPlan[];
}

// Memory and analysis types
export interface MemoryFragment {
	id: string;
	content: string;
	type: 'character' | 'plot' | 'setting' | 'theme' | 'dialogue';
	documentId: string;
	position: {
		start: number;
		end: number;
	};
	relationships: Array<{
		targetId: string;
		type: 'references' | 'contradicts' | 'develops' | 'resolves';
		strength: number;
	}>;
	metadata?: {
		confidence: number;
		lastUpdated: Date;
		sourceAnalyzer: string;
	};
}

export interface AnalysisOptions {
	includeReadability?: boolean;
	includeSentiment?: boolean;
	includeCharacters?: boolean;
	includeThemes?: boolean;
	includePacing?: boolean;
	customAnalyzers?: string[];
	documentContext?: {
		projectId: string;
		documentType: string;
		genre?: string;
	};
}

// Compilation and export types
export interface CompilationResult {
	success: boolean;
	output?: string;
	format: string;
	metadata: {
		documentCount: number;
		wordCount: number;
		characterCount: number;
		processingTime: number;
		warnings: string[];
		errors: string[];
	};
	sections?: Array<{
		title: string;
		content: string;
		metadata: DocumentMetadata;
	}>;
}

export interface ExportResult {
	success: boolean;
	outputPath?: string;
	format: string;
	size?: number;
	metadata: {
		includeMetadata: boolean;
		includeStyles: boolean;
		processingTime: number;
		warnings: string[];
		errors: string[];
	};
}

// AI and LangChain types
export interface LangChainConfig {
	provider: 'openai' | 'anthropic' | 'local' | 'azure';
	model: string;
	temperature?: number;
	maxTokens?: number;
	apiKey?: string;
	endpoint?: string;
	timeout?: number;
	retries?: number;
}

export interface LangChainRequest {
	prompt: string;
	systemMessage?: string;
	context?: string[];
	parameters?: LangChainConfig;
	streaming?: boolean;
}

export interface LangChainResponse {
	content: string;
	usage?: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
	};
	metadata?: {
		model: string;
		finishReason: string;
		processingTime: number;
	};
}

// Queue and job types
export interface JobDefinition {
	id: string;
	type: string;
	priority: number;
	data: JSONObject;
	options?: {
		attempts?: number;
		delay?: number;
		timeout?: number;
		retry?: {
			attempts: number;
			delay: number;
			backoff?: 'exponential' | 'linear';
		};
	};
}

export interface JobResult {
	success: boolean;
	result?: JSONValue;
	error?: ErrorDetails;
	metadata: {
		startTime: Date;
		endTime: Date;
		duration: number;
		attempts: number;
	};
}

// Search and indexing types
export interface SearchQuery {
	query: string;
	filters?: {
		documentTypes?: string[];
		labels?: string[];
		status?: string[];
		dateRange?: {
			start: Date;
			end: Date;
		};
	};
	options?: {
		fuzzy?: boolean;
		caseSensitive?: boolean;
		wholeWords?: boolean;
		regex?: boolean;
		maxResults?: number;
		offset?: number;
	};
}

export interface SearchResult {
	results: DocumentSearchResult[];
	totalCount: number;
	query: SearchQuery;
	metadata: {
		searchTime: number;
		indexVersion: string;
		suggestions?: string[];
	};
}
