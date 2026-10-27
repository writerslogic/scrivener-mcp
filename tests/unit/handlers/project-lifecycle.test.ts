import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryManager } from '../../../src/memory-manager.js';
import { openProjectHandler, closeProjectHandler } from '../../../src/handlers/project-handlers/lifecycle.js';
import type { HandlerContext } from '../../../src/handlers/types.js';
import { ErrorCode } from '../../../src/utils/common.js';

jest.mock('../../../src/scrivener-project.js', () => {
	const fs = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
	const path = jest.requireActual<typeof import('node:path')>('node:path');
	const state = { projects: [] as ProjectResource[], failLoad: new Map<string, Error>(), failMetadata: new Map<string, Error>(), failClose: new Map<string, Error>() };
	class Project {
		closed = false;
		memoryAtClose?: { customContext: Record<string, unknown> };
		readonly database = {
			closed: false,
			failure: undefined as Error | undefined,
			isInitialized: () => !this.database.closed,
			getSQLite: () => {
				if (this.database.failure) throw this.database.failure;
				if (this.database.closed) throw new Error('Memory accessed a closed project database');
				return undefined;
			},
		};
		private readonly timer = setInterval(() => undefined, 60000);
		constructor(readonly projectPath: string) { this.timer.unref(); state.projects.push(this); }
		async loadProject(): Promise<void> { if (state.failLoad.has(this.projectPath)) throw state.failLoad.get(this.projectPath); }
		getDatabaseService() { return this.database; }
		async getProjectMetadata() {
			if (state.failMetadata.has(this.projectPath)) throw state.failMetadata.get(this.projectPath);
			return { title: path.basename(this.projectPath) };
		}
		async close(): Promise<void> {
			clearInterval(this.timer);
			try { this.memoryAtClose = JSON.parse(await fs.readFile(path.join(this.projectPath, '.ai-memory', 'project-memory.json'), 'utf8')); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
			this.database.closed = true;
			this.closed = true;
			if (state.failClose.has(this.projectPath)) throw state.failClose.get(this.projectPath);
		}
	}
	return { ScrivenerProject: Project, __state: state };
});

jest.mock('../../../src/handlers/database/database-service.js', () => ({
	DatabaseService: class { constructor() { throw new Error('A second project database must not be opened'); } },
}));

interface ProjectResource {
	projectPath: string;
	closed: boolean;
	database: { closed: boolean; failure?: Error };
	memoryAtClose?: { customContext: Record<string, unknown> };
	close(): Promise<void>;
}

describe('project scope resource lifecycle', () => {
	const state = jest.requireMock('../../../src/scrivener-project.js').__state as {
		projects: ProjectResource[];
		failLoad: Map<string, Error>;
		failMetadata: Map<string, Error>;
		failClose: Map<string, Error>;
	};
	let root: string;
	let context: HandlerContext;
	const memoryFile = (projectPath: string) => join(projectPath, '.ai-memory', 'project-memory.json');

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'scrivener-project-lifecycle-'));
		context = { project: null, memoryManager: null, contentAnalyzer: {} as HandlerContext['contentAnalyzer'], contentEnhancer: {} as HandlerContext['contentEnhancer'] };
	});

	afterEach(async () => {
		for (const project of state.projects) project.database.failure = undefined;
		await context.memoryManager?.stopAutoSave();
		for (const project of state.projects) if (!project.closed) await project.close().catch(() => undefined);
		state.projects.length = 0;
		state.failLoad.clear(); state.failMetadata.clear(); state.failClose.clear();
		jest.restoreAllMocks();
		await rm(root, { recursive: true, force: true });
	});

	async function sample(name: string): Promise<string> {
		const projectPath = join(root, `${name}.scriv`);
		await mkdir(projectPath);
		await writeFile(join(projectPath, `${name}.scrivx`), '<ScrivenerProject><Binder/></ScrivenerProject>');
		return projectPath;
	}

	it('persists the retiring scope before its shared database closes and keeps the next project isolated', async () => {
		const first = await sample('First');
		const second = await sample('Second');
		await openProjectHandler.handler({ path: first }, context);
		context.memoryManager!.setCustomContext('scope', 'first-only');
		const retired = state.projects[0];
		await openProjectHandler.handler({ path: second }, context);
		expect(retired.closed).toBe(true);
		expect(retired.memoryAtClose?.customContext.scope).toBe('first-only');
		expect(JSON.parse(await readFile(memoryFile(first), 'utf8')).customContext.scope).toBe('first-only');
		expect(context.memoryManager!.getCustomContext('scope')).toBeUndefined();
		expect(context.databaseService).toBe(state.projects[1].database);
		context.memoryManager!.setCustomContext('scope', 'second-only');
		await closeProjectHandler.handler({}, context);
		expect(state.projects[1].memoryAtClose?.customContext.scope).toBe('second-only');
		expect(context.project).toBeNull();
		expect(context.memoryManager).toBeNull();
		expect(context.databaseService).toBeUndefined();
		expect(context.personalization?.isAvailable).toBe(false);
	});

	it('retains unsaved memory and the active database when retirement fails, allowing an explicit retry', async () => {
		const first = await sample('Retry');
		await openProjectHandler.handler({ path: first }, context);
		context.memoryManager!.setCustomContext('pending', 'must-persist');
		const project = state.projects[0];
		project.database.failure = new Error('Synthetic storage failure');
		await expect(closeProjectHandler.handler({}, context)).rejects.toThrow('current project remains available');
		expect(context.project).not.toBeNull();
		expect(project.database.closed).toBe(false);
		project.database.failure = undefined;
		await closeProjectHandler.handler({}, context);
		expect(JSON.parse(await readFile(memoryFile(first), 'utf8')).customContext.pending).toBe('must-persist');
	});

	it('releases a failed load and preserves its primary cause alongside cleanup failure details', async () => {
		const candidate = await sample('BrokenLoad');
		const primary = new Error('Synthetic load failure');
		const cleanup = new Error('Synthetic close failure');
		state.failLoad.set(candidate, primary);
		state.failClose.set(candidate, cleanup);
		await expect(openProjectHandler.handler({ path: candidate }, context)).rejects.toMatchObject({ code: ErrorCode.PROJECT_NOT_FOUND, cause: primary, details: { cleanupFailures: [{ resource: 'project', cause: cleanup }] } });
		expect(state.projects[0].closed).toBe(true);
		expect(context.project).toBeNull();
		expect(context.databaseService).toBeUndefined();
	});

	it('closes a candidate whose memory initialization fails without publishing its partial scope', async () => {
		const candidate = await sample('BrokenMemory');
		const primary = new Error('Synthetic memory initialization failure');
		jest.spyOn(MemoryManager.prototype, 'initialize').mockRejectedValueOnce(primary);
		await expect(openProjectHandler.handler({ path: candidate }, context)).rejects.toMatchObject({ code: ErrorCode.INITIALIZATION_ERROR, cause: primary });
		expect(state.projects[0].closed).toBe(true);
		expect(context.project).toBeNull();
		expect(context.memoryManager).toBeNull();
	});

	it('stops initialized memory and retires its database if later metadata loading fails', async () => {
		const candidate = await sample('BrokenMetadata');
		state.failMetadata.set(candidate, new Error('Synthetic metadata failure'));
		await expect(openProjectHandler.handler({ path: candidate }, context)).rejects.toMatchObject({ code: ErrorCode.INITIALIZATION_ERROR });
		expect(state.projects[0].closed).toBe(true);
		expect(state.projects[0].memoryAtClose).toBeDefined();
		expect(context.project).toBeNull();
	});
});
