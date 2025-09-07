/**
 * Database-specific type definitions
 */

import type { Integer, Node, Relationship, Record as Neo4jRecord } from 'neo4j-driver';

// Neo4j types
export interface Neo4jNode<T = any> extends Omit<Node, 'properties'> {
	properties: T;
}

export interface Neo4jRelationship<T = any> extends Omit<Relationship, 'properties'> {
	properties: T;
}

export interface Neo4jQueryResult {
	records: Neo4jRecord[];
	summary: {
		query: {
			text: string;
			parameters: Record<string, unknown>;
		};
		counters: {
			nodesCreated: number;
			nodesDeleted: number;
			relationshipsCreated: number;
			relationshipsDeleted: number;
			propertiesSet: number;
		};
		resultAvailableAfter: Integer;
		resultConsumedAfter: Integer;
	};
}

// Document node properties
export interface DocumentNode {
	id: string;
	title: string;
	type: 'Text' | 'Folder' | 'Other';
	synopsis?: string;
	notes?: string;
	wordCount?: number;
	updatedAt: string;
}

// Character node properties
export interface CharacterNode {
	id: string;
	name: string;
	role?: string;
	description?: string;
	traits?: string[];
	updatedAt: string;
}

// Theme node properties
export interface ThemeNode {
	id: string;
	name: string;
	description?: string;
	significance?: string;
	updatedAt: string;
}

// Relationship properties
export interface AppearsInRelation {
	context?: string;
	mentions?: number;
	sentiment?: number;
}

export interface FollowsRelation {
	order?: number;
	transition?: string;
}

export interface RelatesToRelation {
	relationship: string;
	strength?: number;
}

// SQLite types
export interface SQLiteRow {
	[column: string]: string | number | boolean | null | Buffer;
}

export interface DocumentRow extends SQLiteRow {
	id: string;
	title: string;
	type: string;
	path: string;
	synopsis: string | null;
	notes: string | null;
	label: string | null;
	status: string | null;
	word_count: number;
	character_count: number;
	created_at: string;
	modified_at: string;
	include_in_compile: number;
}

export interface CharacterRow extends SQLiteRow {
	id: string;
	name: string;
	role: string | null;
	description: string | null;
	traits: string | null; // JSON string
	character_arc: string | null;
	appearances: string | null; // JSON string
	relationships: string | null; // JSON string
	notes: string | null;
	created_at: string;
	modified_at: string;
}

export interface PlotThreadRow extends SQLiteRow {
	id: string;
	name: string;
	description: string | null;
	status: string;
	documents: string | null; // JSON string
	notes: string | null;
	created_at: string;
	modified_at: string;
}

// Query parameter types
export interface QueryParameters {
	[key: string]: string | number | boolean | null | string[] | number[];
}

export interface PaginationParams {
	page?: number;
	pageSize?: number;
	orderBy?: string;
	orderDirection?: 'ASC' | 'DESC';
}

export interface SearchParams extends PaginationParams {
	query: string;
	fields?: string[];
	caseSensitive?: boolean;
	regex?: boolean;
}

// Result types
export interface PaginatedResult<T> {
	items: T[];
	page: number;
	pageSize: number;
	totalItems: number;
	totalPages: number;
	hasNext: boolean;
	hasPrev: boolean;
}

export interface BatchResult {
	succeeded: number;
	failed: number;
	errors: Array<{
		index: number;
		error: string;
	}>;
}

// Connection types
export interface ConnectionConfig {
	host?: string;
	port?: number;
	database?: string;
	username?: string;
	password?: string;
	ssl?: boolean;
	timeout?: number;
}

export interface ConnectionStatus {
	connected: boolean;
	lastCheck?: Date;
	error?: string;
	stats?: {
		activeConnections?: number;
		totalQueries?: number;
		avgQueryTime?: number;
	};
}
