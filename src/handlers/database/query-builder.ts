/**
 * SQL and Cypher query builders
 */

import { createError, ErrorCode } from '../../core/errors.js';
import type { PaginationParams, QueryParameters } from '../../types/database.js';

/**
 * SQL Query Builder
 */
export class SQLQueryBuilder {
	private selectClause = '*';
	private fromClause = '';
	private joinClauses: string[] = [];
	private whereConditions: string[] = [];
	private groupByClause = '';
	private havingClause = '';
	private orderByClause = '';
	private limitClause = '';
	private params: unknown[] = [];

	select(columns: string | string[]): this {
		this.selectClause = Array.isArray(columns) ? columns.join(', ') : columns;
		return this;
	}

	from(table: string): this {
		this.fromClause = table;
		return this;
	}

	join(table: string, on: string): this {
		this.joinClauses.push(`JOIN ${table} ON ${on}`);
		return this;
	}

	leftJoin(table: string, on: string): this {
		this.joinClauses.push(`LEFT JOIN ${table} ON ${on}`);
		return this;
	}

	where(condition: string, value?: unknown): this {
		if (value !== undefined) {
			this.whereConditions.push(condition);
			this.params.push(value);
		} else {
			this.whereConditions.push(condition);
		}
		return this;
	}

	whereIn(column: string, values: unknown[]): this {
		if (values.length === 0) return this;
		const placeholders = values.map(() => '?').join(', ');
		this.whereConditions.push(`${column} IN (${placeholders})`);
		this.params.push(...values);
		return this;
	}

	whereNull(column: string): this {
		this.whereConditions.push(`${column} IS NULL`);
		return this;
	}

	whereNotNull(column: string): this {
		this.whereConditions.push(`${column} IS NOT NULL`);
		return this;
	}

	groupBy(columns: string | string[]): this {
		this.groupByClause = Array.isArray(columns) ? columns.join(', ') : columns;
		return this;
	}

	having(condition: string): this {
		this.havingClause = condition;
		return this;
	}

	orderBy(column: string, direction: 'ASC' | 'DESC' = 'ASC'): this {
		this.orderByClause = `${column} ${direction}`;
		return this;
	}

	limit(limit: number, offset?: number): this {
		this.limitClause = `LIMIT ${limit}`;
		if (offset !== undefined) {
			this.limitClause += ` OFFSET ${offset}`;
		}
		return this;
	}

	paginate(params: PaginationParams): this {
		if (params.orderBy) {
			this.orderBy(params.orderBy, params.orderDirection || 'ASC');
		}
		if (params.page && params.pageSize) {
			const offset = (params.page - 1) * params.pageSize;
			this.limit(params.pageSize, offset);
		}
		return this;
	}

	build(): { sql: string; params: unknown[] } {
		if (!this.fromClause) {
			throw createError(ErrorCode.INVALID_INPUT, null, 'FROM clause is required');
		}

		let sql = `SELECT ${this.selectClause} FROM ${this.fromClause}`;

		if (this.joinClauses.length > 0) {
			sql += ` ${this.joinClauses.join(' ')}`;
		}

		if (this.whereConditions.length > 0) {
			sql += ` WHERE ${this.whereConditions.join(' AND ')}`;
		}

		if (this.groupByClause) {
			sql += ` GROUP BY ${this.groupByClause}`;
		}

		if (this.havingClause) {
			sql += ` HAVING ${this.havingClause}`;
		}

		if (this.orderByClause) {
			sql += ` ORDER BY ${this.orderByClause}`;
		}

		if (this.limitClause) {
			sql += ` ${this.limitClause}`;
		}

		return { sql, params: this.params };
	}

	// Convenience methods
	static insert(
		table: string,
		data: Record<string, unknown>
	): { sql: string; params: unknown[] } {
		const columns = Object.keys(data);
		const values = Object.values(data);
		const placeholders = columns.map(() => '?').join(', ');

		const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;
		return { sql, params: values };
	}

	static update(
		table: string,
		data: Record<string, unknown>,
		where: Record<string, unknown>
	): { sql: string; params: unknown[] } {
		const setClauses = Object.keys(data).map((key) => `${key} = ?`);
		const whereClauses = Object.keys(where).map((key) => `${key} = ?`);

		const sql = `UPDATE ${table} SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')}`;
		const params = [...Object.values(data), ...Object.values(where)];

		return { sql, params };
	}

	static delete(
		table: string,
		where: Record<string, unknown>
	): { sql: string; params: unknown[] } {
		const whereClauses = Object.keys(where).map((key) => `${key} = ?`);
		const sql = `DELETE FROM ${table} WHERE ${whereClauses.join(' AND ')}`;
		const params = Object.values(where);

		return { sql, params };
	}
}

/**
 * Cypher Query Builder
 */
export class CypherQueryBuilder {
	private matchClauses: string[] = [];
	private whereClauses: string[] = [];
	private createClauses: string[] = [];
	private mergeClauses: string[] = [];
	private setClauses: string[] = [];
	private deleteClauses: string[] = [];
	private returnClause = '';
	private orderByClause = '';
	private limitClause = '';
	private queryParams: QueryParameters = {};

	match(pattern: string): this {
		this.matchClauses.push(`MATCH ${pattern}`);
		return this;
	}

	optionalMatch(pattern: string): this {
		this.matchClauses.push(`OPTIONAL MATCH ${pattern}`);
		return this;
	}

	where(condition: string): this {
		this.whereClauses.push(condition);
		return this;
	}

	create(pattern: string): this {
		this.createClauses.push(`CREATE ${pattern}`);
		return this;
	}

	merge(pattern: string): this {
		this.mergeClauses.push(`MERGE ${pattern}`);
		return this;
	}

	set(assignments: string | string[]): this {
		const items = Array.isArray(assignments) ? assignments : [assignments];
		this.setClauses.push(...items);
		return this;
	}

	delete(variables: string | string[]): this {
		const items = Array.isArray(variables) ? variables : [variables];
		this.deleteClauses.push(...items);
		return this;
	}

	return(expression: string): this {
		this.returnClause = expression;
		return this;
	}

	orderBy(expression: string, direction: 'ASC' | 'DESC' = 'ASC'): this {
		this.orderByClause = `${expression} ${direction}`;
		return this;
	}

	limit(limit: number, skip?: number): this {
		if (skip !== undefined) {
			this.limitClause = `SKIP ${skip} LIMIT ${limit}`;
		} else {
			this.limitClause = `LIMIT ${limit}`;
		}
		return this;
	}

	param(name: string, value: string | number | boolean | null | string[] | number[]): this {
		this.queryParams[name] = value;
		return this;
	}

	params(params: QueryParameters): this {
		Object.assign(this.queryParams, params);
		return this;
	}

	build(): { cypher: string; params: QueryParameters } {
		const clauses: string[] = [];

		if (this.matchClauses.length > 0) {
			clauses.push(...this.matchClauses);
		}

		if (this.whereClauses.length > 0) {
			clauses.push(`WHERE ${this.whereClauses.join(' AND ')}`);
		}

		if (this.createClauses.length > 0) {
			clauses.push(...this.createClauses);
		}

		if (this.mergeClauses.length > 0) {
			clauses.push(...this.mergeClauses);
		}

		if (this.setClauses.length > 0) {
			clauses.push(`SET ${this.setClauses.join(', ')}`);
		}

		if (this.deleteClauses.length > 0) {
			clauses.push(`DELETE ${this.deleteClauses.join(', ')}`);
		}

		if (this.returnClause) {
			clauses.push(`RETURN ${this.returnClause}`);

			if (this.orderByClause) {
				clauses.push(`ORDER BY ${this.orderByClause}`);
			}

			if (this.limitClause) {
				clauses.push(this.limitClause);
			}
		}

		const cypher = clauses.join('\n');
		return { cypher, params: this.queryParams };
	}

	// Convenience methods
	static findNode(
		label: string,
		props: QueryParameters
	): { cypher: string; params: QueryParameters } {
		const builder = new CypherQueryBuilder();
		const propString = Object.keys(props)
			.map((key) => `${key}: $${key}`)
			.join(', ');

		return builder.match(`(n:${label} {${propString}})`).return('n').params(props).build();
	}

	static createRelationship(
		fromLabel: string,
		fromId: string,
		toLabel: string,
		toId: string,
		relType: string,
		relProps?: Record<string, unknown>
	): { cypher: string; params: QueryParameters } {
		const builder = new CypherQueryBuilder();

		builder
			.match(`(from:${fromLabel} {id: $fromId})`)
			.match(`(to:${toLabel} {id: $toId})`)
			.param('fromId', fromId)
			.param('toId', toId);

		let relPattern = `(from)-[r:${relType}]->(to)`;
		if (relProps) {
			const propString = Object.keys(relProps)
				.map((key) => `${key}: $rel_${key}`)
				.join(', ');
			relPattern = `(from)-[r:${relType} {${propString}}]->(to)`;

			for (const [key, value] of Object.entries(relProps)) {
				builder.param(
					`rel_${key}`,
					value as string | number | boolean | string[] | number[] | null
				);
			}
		}

		return builder.merge(relPattern).return('r').build();
	}
}
