import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { getDocumentInfoHandler, readDocumentHandler } from '../../src/handlers/document-handlers.js';
import { openProjectHandler } from '../../src/handlers/project-handlers.js';
import type { HandlerContext } from '../../src/handlers/types.js';
import { DatabaseService } from '../../src/handlers/database/database-service.js';
import { MemoryManager } from '../../src/memory-manager.js';
import { ScrivenerProject } from '../../src/scrivener-project.js';
import { ErrorCode } from '../../src/utils/common.js';

jest.mock('../../src/scrivener-project.js', () => ({
	ScrivenerProject: jest.fn(),
}));

jest.mock('../../src/handlers/database/database-service.js', () => ({
	DatabaseService: jest.fn(),
}));

jest.mock('../../src/memory-manager.js', () => ({
	MemoryManager: jest.fn(),
}));

jest.mock('../../src/handlers/memory-handlers.js', () => ({
	getHHMSystem: jest.fn(() => ({
		memorizeDocument: jest.fn().mockResolvedValue(undefined),
	})),
}));

jest.mock('../../src/core/logger.js', () => ({
	getLogger: jest.fn(() => ({
		debug: jest.fn(),
		info: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
	})),
}));

const validDocumentId = '123e4567-e89b-42d3-a456-426614174000';

function createContext(project: HandlerContext['project']): HandlerContext {
	return {
		project,
		memoryManager: null,
		contentAnalyzer: {} as HandlerContext['contentAnalyzer'],
		contentEnhancer: {} as HandlerContext['contentEnhancer'],
	};
}

describe('handler error messages', () => {
	beforeEach(() => {
		jest.clearAllMocks();

		(ScrivenerProject as unknown as jest.Mock).mockImplementation(() => ({
			loadProject: jest.fn().mockResolvedValue(undefined),
			getProjectMetadata: jest.fn().mockResolvedValue({ title: 'Novel' }),
			close: jest.fn().mockResolvedValue(undefined),
		}));

		(DatabaseService as unknown as jest.Mock).mockImplementation(() => ({
			initialize: jest.fn().mockResolvedValue(undefined),
		}));

		(MemoryManager as unknown as jest.Mock).mockImplementation(() => ({
			initialize: jest.fn().mockResolvedValue(undefined),
		}));
	});

	it('accepts a direct .scrivx path for open_project', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scrivener-mcp-'));
		const projectDir = path.join(tempRoot, 'Novel.scriv');
		const scrivxPath = path.join(projectDir, 'Novel.scrivx');

		await fs.mkdir(projectDir, { recursive: true });
		await fs.writeFile(scrivxPath, '<ScrivenerProject><Binder /></ScrivenerProject>');

		await openProjectHandler.handler(
			{ path: scrivxPath },
			createContext(null)
		);

		expect(ScrivenerProject).toHaveBeenCalledWith(
			projectDir,
			expect.objectContaining({ hhmSystem: undefined })
		);
	});

	it('explains when open_project receives a parent folder instead of the project path', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scrivener-mcp-parent-'));
		await fs.writeFile(
			path.join(tempRoot, 'Novel.scrivx'),
			'<ScrivenerProject><Binder /></ScrivenerProject>'
		);

		await expect(
			openProjectHandler.handler({ path: tempRoot }, createContext(null))
		).rejects.toMatchObject({
			code: ErrorCode.INVALID_INPUT,
			message: expect.stringContaining('looks like a parent folder'),
		});
	});

	it('surfaces actionable invalid UUID guidance for read_document', async () => {
		const context = createContext({
			getDocumentInfo: jest.fn(),
			readDocument: jest.fn(),
		} as unknown as HandlerContext['project']);

		await expect(
			readDocumentHandler.handler({ documentId: 'not-a-uuid' }, context)
		).rejects.toMatchObject({
			code: ErrorCode.INVALID_INPUT,
			message: expect.stringContaining('get_structure or get_all_documents'),
		});
	});

	it('throws a document-not-found error instead of returning null metadata', async () => {
		const context = createContext({
			getDocumentInfo: jest.fn().mockResolvedValue({
				document: null,
				path: [],
				metadata: {},
				location: 'unknown',
			}),
		} as unknown as HandlerContext['project']);

		await expect(
			getDocumentInfoHandler.handler({ documentId: validDocumentId }, context)
		).rejects.toMatchObject({
			code: ErrorCode.DOCUMENT_NOT_FOUND,
			message: expect.stringContaining('Use get_structure or get_all_documents'),
		});
	});

	it('blocks read_document when the document does not exist in the open project', async () => {
		const project = {
			getDocumentInfo: jest.fn().mockResolvedValue({
				document: null,
				path: [],
				metadata: {},
				location: 'unknown',
			}),
			readDocument: jest.fn(),
		};
		const context = createContext(project as unknown as HandlerContext['project']);

		await expect(
			readDocumentHandler.handler({ documentId: validDocumentId }, context)
		).rejects.toMatchObject({
			code: ErrorCode.DOCUMENT_NOT_FOUND,
			message: expect.stringContaining('was not found in the open project'),
		});
		expect(project.readDocument).not.toHaveBeenCalled();
	});
});
