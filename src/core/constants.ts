/**
 * Centralized constants for the application
 */

// Error Messages
export const ERROR_MESSAGES = {
	NO_PROJECT: 'No project is currently open',
	NO_MEMORY_MANAGER: 'Memory manager not initialized',
	INVALID_INPUT: 'Invalid input provided',
	DATABASE_ERROR: 'Database operation failed',
	FILE_NOT_FOUND: 'File not found',
	ACCESS_DENIED: 'Access denied',
	NETWORK_ERROR: 'Network error occurred',
	TIMEOUT: 'Operation timed out',
	NOT_IMPLEMENTED: 'Feature not implemented',
	UNKNOWN_ERROR: 'An unknown error occurred',
	INVALID_DOCUMENT_ID: 'Invalid document ID',
	DOCUMENT_NOT_FOUND: 'Document not found',
	INVALID_PROJECT_PATH: 'Invalid Scrivener project path',
	PROJECT_LOAD_FAILED: 'Failed to load Scrivener project',
	TRANSACTION_FAILED: 'Transaction failed',
	CONNECTION_FAILED: 'Database connection failed',
	CONSTRAINT_VIOLATION: 'Database constraint violation',
	PROJECT_ALREADY_OPEN: 'A project is already open',
	MISSING_REQUIRED: 'Required field missing',
} as const;

// Success Messages
export const SUCCESS_MESSAGES = {
	PROJECT_LOADED: 'Project loaded successfully',
	PROJECT_CLOSED: 'Project closed',
	DOCUMENT_CREATED: 'Document created successfully',
	DOCUMENT_UPDATED: 'Document updated successfully',
	DOCUMENT_DELETED: 'Document deleted successfully',
	SAVED: 'Changes saved',
	DB_CONNECTED: 'Database connected',
	DB_DISCONNECTED: 'Database disconnected',
	SUCCESS: 'Operation completed successfully',
} as const;

// File Extensions
export const FILE_EXTENSIONS = {
	SCRIVENER: '.scriv',
	SCRIVENER_PROJECT: '.scrivx',
	RTF: '.rtf',
	TXT: '.txt',
	MD: '.md',
	HTML: '.html',
	PDF: '.pdf',
	DOCX: '.docx',
	SQLITE: '.db',
	JSON: '.json',
	XML: '.xml',
} as const;

// Database Constants
export const DATABASE = {
	SQLITE_DEFAULT_PATH: 'scrivener.db',
	NEO4J_DEFAULT_URI: 'bolt://localhost:7687',
	NEO4J_DEFAULT_USER: 'neo4j',
	NEO4J_DEFAULT_DATABASE: 'scrivener',
	MAX_POOL_SIZE: 50,
	CONNECTION_TIMEOUT: 30000,
	QUERY_TIMEOUT: 10000,
	RETRY_COUNT: 3,
	RETRY_DELAY: 1000,
	BATCH_SIZE: 100,
} as const;

// Document Types
export const DOCUMENT_TYPES = {
	TEXT: 'Text',
	FOLDER: 'Folder',
	RESEARCH: 'Research',
	TRASH: 'Trash',
	OTHER: 'Other',
} as const;

// Compilation Formats
export const COMPILATION_FORMATS = {
	PLAIN_TEXT: 'txt',
	MARKDOWN: 'md',
	HTML: 'html',
	RTF: 'rtf',
	DOCX: 'docx',
} as const;

// Analysis Types
export const ANALYSIS_TYPES = {
	SCENE: 'scene',
	CHARACTER: 'character',
	THEME: 'theme',
	PLOT: 'plot',
	STYLE: 'style',
	READABILITY: 'readability',
	SENTIMENT: 'sentiment',
	CONSISTENCY: 'consistency',
} as const;

// Size and Performance Limits
export const LIMITS = {
	MAX_CACHE_SIZE: 100 * 1024 * 1024, // 100MB
	MAX_FILE_SIZE: 50 * 1024 * 1024, // 50MB
	MAX_BATCH_SIZE: 1000,
	MAX_RETRY_ATTEMPTS: 3,
	DEFAULT_TIMEOUT: 30000, // 30 seconds
	MAX_SEARCH_RESULTS: 100,
	MAX_CONTENT_LENGTH: 1000000, // 1MB text
	MAX_SYNOPSIS_LENGTH: 5000,
	MAX_NOTES_LENGTH: 100000,
	MAX_TITLE_LENGTH: 255,
	DATABASE_TIMEOUT: 10000,
	AI_SERVICE_TIMEOUT: 60000,
	CACHE_TTL: 300000, // 5 minutes
} as const;

// Regex Patterns
export const PATTERNS = {
	SCRIVENER_UUID: /^[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/i,
	EMAIL: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
	URL: /^https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)$/,
	ISBN: /^(?:ISBN(?:-1[03])?:? )?(?=[0-9X]{10}$|(?=(?:[0-9]+[- ]){3})[- 0-9X]{13}$|97[89][0-9]{10}$|(?=(?:[0-9]+[- ]){4})[- 0-9]{17}$)(?:97[89][- ]?)?[0-9]{1,5}[- ]?[0-9]+[- ]?[0-9]+[- ]?[0-9X]$/,
	SAFE_PATH: /^[^<>:"|?*]+$/,
} as const;

// Default Values
export const DEFAULTS = {
	SYNOPSIS: 'No synopsis available',
	AUTHOR: 'Unknown Author',
	TITLE: 'Untitled',
	LABEL: 'No Label',
	STATUS: 'No Status',
	CATEGORY: 'General',
	LANGUAGE: 'en',
	ENCODING: 'utf-8',
} as const;

// API Endpoints
export const API_ENDPOINTS = {
	OPENAI: 'https://api.openai.com/v1',
	ANTHROPIC: 'https://api.anthropic.com/v1',
} as const;

// Cache Keys
export const CACHE_KEYS = {
	DOCUMENT_PREFIX: 'doc:',
	ANALYSIS_PREFIX: 'analysis:',
	METADATA_PREFIX: 'meta:',
	SEARCH_PREFIX: 'search:',
	COMPILATION_PREFIX: 'compile:',
} as const;

// MIME Types
export const MIME_TYPES = {
	RTF: 'application/rtf',
	TEXT: 'text/plain',
	HTML: 'text/html',
	XML: 'application/xml',
	JSON: 'application/json',
	PDF: 'application/pdf',
	DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
} as const;

// Neo4j Node Labels
export const NODE_LABELS = {
	DOCUMENT: 'Document',
	CHARACTER: 'Character',
	THEME: 'Theme',
	PLOT_THREAD: 'PlotThread',
	ENTITY: 'Entity',
} as const;

// Neo4j Relationship Types
export const RELATIONSHIP_TYPES = {
	FOLLOWS: 'FOLLOWS',
	APPEARS_IN: 'APPEARS_IN',
	RELATES_TO: 'RELATES_TO',
	PRESENT_IN: 'PRESENT_IN',
	CONTAINS: 'CONTAINS',
} as const;

// Backwards compatibility exports
export const Messages = ERROR_MESSAGES;
export const Limits = LIMITS;
export const Timeouts = {
	DEFAULT: LIMITS.DEFAULT_TIMEOUT,
	DATABASE: LIMITS.DATABASE_TIMEOUT,
	AI_SERVICE: LIMITS.AI_SERVICE_TIMEOUT,
	CACHE_TTL: LIMITS.CACHE_TTL,
};
export const Patterns = PATTERNS;
export const Extensions = FILE_EXTENSIONS;
export const MimeTypes = MIME_TYPES;
