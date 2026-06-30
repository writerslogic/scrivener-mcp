import { verifyProjectIntegrityHandler } from '../../../src/handlers/integrity-handlers.js';
import type { HandlerContext } from '../../../src/handlers/types.js';
import type { ScrivenerDocument } from '../../../src/types/index.js';

const idA = '123e4567-e89b-42d3-a456-426614174000';
const idB = '223e4567-e89b-42d3-a456-426614174001';
const idC = '323e4567-e89b-42d3-a456-426614174002';

interface StubProject {
	getAllDocuments: (includeTrash?: boolean) => Promise<ScrivenerDocument[]>;
	readDocument: (id: string) => Promise<string>;
}

function createContext(project: StubProject): HandlerContext {
	return {
		project: project as unknown as HandlerContext['project'],
		memoryManager: null,
		contentAnalyzer: {} as HandlerContext['contentAnalyzer'],
		contentEnhancer: {} as HandlerContext['contentEnhancer'],
	};
}

function doc(partial: Partial<ScrivenerDocument> & { id: string }): ScrivenerDocument {
	return {
		title: 'Untitled',
		type: 'Text',
		path: '',
		...partial,
	};
}

async function runReport(project: StubProject, args: Record<string, unknown> = {}) {
	const result = await verifyProjectIntegrityHandler.handler(args, createContext(project));
	const text = result.content[0]?.text;
	if (typeof text !== 'string') {
		throw new Error('Expected a text payload in the handler result');
	}
	return JSON.parse(text) as {
		ok: boolean;
		checked: number;
		issues: Array<{ severity: string; kind: string; id?: string; detail: string }>;
		summary: string;
	};
}

describe('verify_project_integrity', () => {
	it('declares the read-only, non-destructive annotations', () => {
		expect(verifyProjectIntegrityHandler.name).toBe('verify_project_integrity');
		expect(verifyProjectIntegrityHandler.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
	});

	it('reports a clean bill of health for a structurally sound project', async () => {
		const documents = [
			doc({ id: idA, title: 'Chapter 1', type: 'Text', path: 'Manuscript/Chapter 1' }),
			doc({ id: idB, title: 'Notes', type: 'Folder', path: 'Research' }),
		];
		const project: StubProject = {
			getAllDocuments: async () => documents,
			readDocument: async () => 'Some prose content.',
		};

		const report = await runReport(project);

		expect(report.ok).toBe(true);
		expect(report.checked).toBe(2);
		expect(report.issues).toEqual([]);
		expect(report.summary).toContain('no integrity problems');
	});

	it('flags a binder entry whose backing content is missing', async () => {
		const documents = [
			doc({ id: idA, title: 'Chapter 1', type: 'Text', path: 'Manuscript/Chapter 1' }),
			doc({ id: idB, title: 'Ghost', type: 'Text', path: 'Manuscript/Ghost' }),
		];
		const project: StubProject = {
			getAllDocuments: async () => documents,
			readDocument: async (id: string) => (id === idB ? '' : 'Real content.'),
		};

		const report = await runReport(project);

		expect(report.ok).toBe(true); // empty content is a warning, not an error
		expect(report.checked).toBe(2);
		const empty = report.issues.find((i) => i.kind === 'empty_content');
		expect(empty).toBeDefined();
		expect(empty?.severity).toBe('warning');
		expect(empty?.id).toBe(idB);
	});

	it('flags duplicate, missing, and malformed ids and unreadable content as errors', async () => {
		const documents = [
			doc({ id: idA, title: 'One', type: 'Text', path: 'M/One' }),
			doc({ id: idA, title: 'Dup', type: 'Text', path: 'M/Dup' }),
			doc({ id: '', title: 'No Id', type: 'Folder', path: 'M/NoId' }),
			doc({ id: 'not-a-uuid', title: 'Bad Id', type: 'Text', path: 'M/BadId' }),
			doc({ id: idC, title: 'Broken', type: 'Text', path: 'M/Broken' }),
		];
		const project: StubProject = {
			getAllDocuments: async () => documents,
			readDocument: async (id: string) => {
				if (id === idC) {
					throw new Error('ENOENT: corrupt rtf');
				}
				return 'content';
			},
		};

		const report = await runReport(project);

		expect(report.checked).toBe(5);
		expect(report.ok).toBe(false);

		const kinds = report.issues.map((i) => i.kind);
		expect(kinds).toContain('duplicate_id');
		expect(kinds).toContain('missing_id');
		expect(kinds).toContain('invalid_id');
		expect(kinds).toContain('unreadable_content');

		const unreadable = report.issues.find((i) => i.kind === 'unreadable_content');
		expect(unreadable?.severity).toBe('error');
		expect(unreadable?.id).toBe(idC);
		expect(unreadable?.detail).toContain('corrupt rtf');

		expect(report.summary).toMatch(/\d+ error\(s\)/);
	});

	it('honours includeTrash=false by passing it through to the project', async () => {
		const getAllDocuments = jest.fn(async () => [] as ScrivenerDocument[]);
		const project: StubProject = {
			getAllDocuments,
			readDocument: async () => '',
		};

		const report = await runReport(project, { includeTrash: false });

		expect(getAllDocuments).toHaveBeenCalledWith(false);
		expect(report.ok).toBe(true);
		expect(report.checked).toBe(0);
	});

	it('throws when no project is open', async () => {
		const context = createContext({
			getAllDocuments: async () => [],
			readDocument: async () => '',
		});
		context.project = null;

		await expect(verifyProjectIntegrityHandler.handler({}, context)).rejects.toThrow();
	});
});
