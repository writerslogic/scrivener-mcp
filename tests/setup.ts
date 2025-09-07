/**
 * Test setup and utilities
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Test data directory
export const TEST_DATA_DIR = path.join(__dirname, 'fixtures');
export const TEMP_DIR = path.join(os.tmpdir(), 'scrivener-mcp-tests');

// Setup before all tests
beforeAll(async () => {
	// Create temp directory
	await fs.mkdir(TEMP_DIR, { recursive: true });
});

// Cleanup after all tests
afterAll(async () => {
	// Clean temp directory
	try {
		await fs.rm(TEMP_DIR, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
});

// Mock console methods to reduce noise
global.console = {
	...console,
	log: jest.fn(),
	error: jest.fn(),
	warn: jest.fn(),
	info: jest.fn(),
	debug: jest.fn(),
};

// Test utilities
export async function createTempDir(): Promise<string> {
	const dir = path.join(TEMP_DIR, `test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await fs.mkdir(dir, { recursive: true });
	return dir;
}

export async function createTempFile(content: string, ext = '.txt'): Promise<string> {
	const dir = await createTempDir();
	const file = path.join(dir, `file${ext}`);
	await fs.writeFile(file, content);
	return file;
}

export async function cleanupTemp(path: string): Promise<void> {
	try {
		await fs.rm(path, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
}

// Mock factories
export function createMockProject() {
	return {
		load: jest.fn(),
		close: jest.fn(),
		refresh: jest.fn(),
		getStructure: jest.fn(),
		getProjectMetadata: jest.fn(),
		getProjectSummary: jest.fn(),
		readDocument: jest.fn(),
		writeDocument: jest.fn(),
		createDocument: jest.fn(),
		deleteDocument: jest.fn(),
		getDocumentInfo: jest.fn(),
	};
}

export function createMockMemoryManager() {
	return {
		initialize: jest.fn(),
		updateMemory: jest.fn(),
		getMemory: jest.fn(),
		getAllMemory: jest.fn(),
		saveMemory: jest.fn(),
		startAutoSave: jest.fn(),
		stopAutoSave: jest.fn(),
	};
}

export function createMockAnalyzer() {
	return {
		analyzeDocument: jest.fn(),
		checkConsistency: jest.fn(),
		analyzeReadability: jest.fn(),
		analyzeSentiment: jest.fn(),
		extractThemes: jest.fn(),
	};
}

export function createMockEnhancer() {
	return {
		enhance: jest.fn(),
		generate: jest.fn(),
		summarize: jest.fn(),
		expand: jest.fn(),
	};
}

// Assertion helpers
export function expectError(fn: () => void, code?: string) {
	expect(fn).toThrow();
	if (code) {
		try {
			fn();
		} catch (error: any) {
			expect(error.code).toBe(code);
		}
	}
}

export async function expectAsyncError(fn: () => Promise<void>, code?: string) {
	await expect(fn()).rejects.toThrow();
	if (code) {
		try {
			await fn();
		} catch (error: any) {
			expect(error.code).toBe(code);
		}
	}
}