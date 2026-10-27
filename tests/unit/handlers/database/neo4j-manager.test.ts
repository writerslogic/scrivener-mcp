import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Driver, ManagedTransaction, QueryResult } from 'neo4j-driver';
import { Neo4jManager } from '../../../../src/handlers/database/neo4j-manager.js';
import { ErrorCode } from '../../../../src/core/errors.js';

interface QueryEvent { cypher: string; parameters?: Record<string, unknown> }
class FakeDriver {
	closed = false;
	closeError?: Error;
	connectError?: Error;
	sessions: Array<{ closed: boolean; database: string }> = [];
	queries: QueryEvent[] = [];
	outcomes: Array<QueryResult | Error> = [];
	result = { records: [] } as unknown as QueryResult;
	async verifyConnectivity(): Promise<void> { if (this.connectError) throw this.connectError; }
	async close(): Promise<void> { if (this.closeError) throw this.closeError; this.closed = true; }
	session(options: { database: string }) {
		const session = { closed: false, database: options.database };
		this.sessions.push(session);
		const run = async (cypher: string, parameters?: Record<string, unknown>): Promise<QueryResult> => {
			this.queries.push({ cypher, parameters });
			const outcome = this.outcomes.shift() ?? this.result;
			if (outcome instanceof Error) throw outcome;
			return outcome;
		};
		const transaction = { run } as unknown as ManagedTransaction;
		return {
			run,
			close: async () => { session.closed = true; },
			executeRead: async <T>(work: (tx: ManagedTransaction) => Promise<T>) => work(transaction),
			executeWrite: async <T>(work: (tx: ManagedTransaction) => Promise<T>) => work(transaction),
		};
	}
}
const mockDrivers: FakeDriver[] = [];
const mockCreateDriver = jest.fn<() => Driver>(() => mockDrivers.shift() as unknown as Driver);

jest.mock('neo4j-driver', () => ({
	__esModule: true,
	default: { driver: () => mockCreateDriver(), auth: { basic: (user: string, password: string) => ({ user, password }) } },
}));
jest.mock('../../../../src/utils/condition-waiter.js', () => ({ waitForServiceReady: async () => undefined }));
jest.mock('../../../../src/core/logger.js', () => ({ getLogger: () => ({ info: () => undefined, debug: () => undefined, warn: () => undefined, error: () => undefined }) }));

let driver: FakeDriver;
let manager: Neo4jManager;
beforeEach(() => {
	mockDrivers.length = 0;
	mockCreateDriver.mockClear();
	driver = new FakeDriver();
	mockDrivers.push(driver);
	manager = new Neo4jManager('bolt://localhost:7687', 'neo4j', 'fixture-only', 'test-story');
});

async function connected(): Promise<void> {
	await manager.initialize();
	driver.queries.length = 0;
	driver.sessions.length = 0;
}

describe('Neo4j lifecycle and recovery', () => {
	it('releases failed driver attempts before retrying and degrades explicitly when all connections fail', async () => {
		const attempts = [driver, new FakeDriver(), new FakeDriver()];
		mockDrivers.push(...attempts.slice(1));
		for (const attempt of attempts) attempt.connectError = Object.assign(new Error('Service unavailable'), { code: 'ServiceUnavailable' });
		await manager.initialize();
		expect(attempts.every((attempt) => attempt.closed)).toBe(true);
		expect(manager.isAvailable()).toBe(false);
		expect((await manager.checkHealth()).healthy).toBe(false);
		await expect(manager.query('RETURN 1')).rejects.toMatchObject({ code: ErrorCode.DATABASE_ERROR });
	});

	it('closes schema-failure sessions and abandoned drivers before a successful retry', async () => {
		const replacement = new FakeDriver();
		driver.outcomes.push(new Error('Schema rejected'));
		mockDrivers.push(replacement);
		await manager.initialize();
		expect(driver.closed).toBe(true);
		expect(driver.sessions.every((session) => session.closed)).toBe(true);
		expect(replacement.sessions.every((session) => session.closed)).toBe(true);
		expect(manager.isAvailable()).toBe(true);
		await manager.close();
		expect(replacement.closed).toBe(true);
		expect((await manager.checkHealth()).healthy).toBe(false);
	});

	it('retains the handle on failed closure so cleanup can be retried', async () => {
		await connected();
		driver.closeError = new Error('Close failed');
		await expect(manager.close()).rejects.toThrow('Close failed');
		driver.closeError = undefined;
		await manager.close();
		expect(driver.closed).toBe(true);
		expect(manager.isAvailable()).toBe(false);
		await manager.close();
	});
});

describe('Neo4j query and transaction ownership', () => {
	it('returns real results and closes the selected database session on success and wrapped failure', async () => {
		await connected();
		expect(await manager.query('RETURN $value', { value: 7 })).toBe(driver.result);
		expect(driver.sessions).toEqual([{ database: 'test-story', closed: true }]);
		driver.outcomes.push(Object.assign(new Error('Syntax error'), { code: 'Neo.ClientError.Statement.SyntaxError' }));
		await expect(manager.query('INVALID')).rejects.toMatchObject({ code: ErrorCode.INVALID_INPUT });
		expect(driver.sessions.every((session) => session.closed)).toBe(true);
	});

	it.each(['readTransaction', 'writeTransaction'] as const)('propagates %s callback outcomes and closes sessions', async (method) => {
		await connected();
		const value = await manager[method](async (tx) => {
			const result = await tx.run('RETURN 42');
			return { result, complete: true };
		});
		expect(value).toEqual({ result: driver.result, complete: true });
		const error = new Error('Work must roll back');
		await expect(manager[method](async () => { throw error; })).rejects.toBe(error);
		expect(driver.sessions).toHaveLength(2);
		expect(driver.sessions.every((session) => session.closed)).toBe(true);
	});

	it('retries transient timeouts with fresh sessions, then preserves the final failure', async () => {
		await connected();
		const timeout = Object.assign(new Error('Query timeout'), { code: 'Neo.TransientError.Transaction.Timeout' });
		driver.outcomes.push(timeout, driver.result);
		expect(await manager.queryWithRetry('RETURN 1', {}, 2)).toBe(driver.result);
		expect(driver.sessions).toHaveLength(2);
		expect(driver.sessions.every((session) => session.closed)).toBe(true);
		driver.outcomes.push(timeout, timeout);
		await expect(manager.queryWithRetry('RETURN 1', {}, 2)).rejects.toBe(timeout);
		expect(driver.sessions.every((session) => session.closed)).toBe(true);
	});

	it('does not replay non-transient query failures', async () => {
		await connected();
		const syntax = Object.assign(new Error('Syntax error'), { code: 'Neo.ClientError.Statement.SyntaxError' });
		driver.outcomes.push(syntax, driver.result);
		await expect(manager.queryWithRetry('INVALID', {}, 3)).rejects.toBe(syntax);
		expect(driver.sessions).toHaveLength(1);
		expect(driver.sessions[0].closed).toBe(true);
	});
});

describe('Neo4j parameter and identifier boundaries', () => {
	it('preserves relationship property maps and endpoint identities without interpolating user values', async () => {
		await connected();
		const properties = { fromId: 'attempted-override', description: "' OR true //" };
		await manager.createRelationship('mara', 'Character', 'chapter-1', 'Document', 'APPEARS_IN', properties);
		expect(driver.queries[0].parameters).toEqual({ fromId: 'mara', toId: 'chapter-1', properties });
		expect(driver.queries[0].cypher).not.toContain(properties.description);
		expect(driver.queries[0].cypher).toContain('SET r += $properties');
	});

	it.each(['Character) DETACH DELETE n //', '', 'Has Space'])('rejects interpolated identifiers %j before issuing a query', async (label) => {
		await connected();
		await expect(manager.upsertNode(label, 'mara', { name: 'Mara' })).rejects.toThrow(/identifier/);
		await expect(manager.createRelationship('mara', 'Character', 'chapter', 'Document', label)).rejects.toThrow(/identifier/);
		expect(driver.queries).toEqual([]);
	});

	it('rejects node identity replacement and emits valid timestamp-only updates for empty or invalid properties', async () => {
		await connected();
		await expect(manager.upsertNode('Character', 'mara', { id: 'another-character' })).rejects.toThrow(/identity/);
		await manager.upsertNode('Character', 'mara', {});
		await manager.upsertNode('Character', 'mara', { 'name) DELETE n': 'unsafe' });
		for (const query of driver.queries) {
			expect(query.cypher).toMatch(/SET n\.updatedAt = datetime\(\)/);
			expect(query.cypher).not.toContain('SET ,');
			expect(query.parameters).toEqual({ id: 'mara' });
		}
	});
});
