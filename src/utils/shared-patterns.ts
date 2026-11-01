/**
 * Shared Patterns and Common Utilities
 * Consolidates repeated patterns across utils files to eliminate duplication
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { getLogger } from '../core/logger.js';
import { promisify } from 'util';
import { exec, execFile } from 'child_process';
import { pathExists as fileExists, formatBytes } from './common.js';

export { fileExists, formatBytes };

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const logger = getLogger('shared-patterns');

export async function fileExistsWithContent(
	filePath: string,
	searchContent?: string
): Promise<boolean> {
	try {
		if (!searchContent) {
			return await fileExists(filePath);
		}

		const content = await fs.readFile(filePath, 'utf-8');
		return content.includes(searchContent);
	} catch {
		return false;
	}
}

export async function ensureDirectory(dirPath: string, mode: number = 0o755): Promise<void> {
	try {
		await fs.mkdir(dirPath, { recursive: true, mode });
	} catch (error) {
		try {
			const stats = await fs.stat(dirPath);
			if (!stats.isDirectory()) {
				throw new Error(`Path exists but is not a directory: ${dirPath}`, { cause: error });
			}
		} catch {
			throw error;
		}
	}
}

/**
 * Safe command execution with timeout (used across multiple files)
 */
export async function safeExec(
	command: string,
	options: { timeout?: number; env?: Record<string, string> } = {}
): Promise<{ stdout: string; stderr: string }> {
	const { timeout = 10000, env } = options;

	try {
		const result = await execAsync(command, {
			timeout,
			env: { ...process.env, ...env },
		});
		return result;
	} catch (error) {
		logger.debug(`Command failed: ${command}`, { error });
		throw error;
	}
}

export async function commandExists(command: string): Promise<boolean> {
	try {
		await execFileAsync('which', [command], { timeout: 2000 });
		return true;
	} catch {
		return false;
	}
}

export async function getProcessByName(processName: string): Promise<string[]> {
	try {
		const { stdout } = await execFileAsync('pgrep', ['-f', processName], { timeout: 2000 });
		return stdout
			.trim()
			.split('\n')
			.filter((pid) => pid.length > 0);
	} catch {
		return [];
	}
}

export function validatePath(inputPath: string): string {
	const resolved = path.resolve(inputPath);
	const normalized = path.normalize(resolved);

	if (resolved !== normalized || resolved.includes('..')) {
		throw new Error(`Invalid path: potential path traversal attack in ${inputPath}`);
	}

	// Ensure path doesn't contain null bytes
	if (resolved.includes('\0')) {
		throw new Error(`Invalid path: contains null bytes in ${inputPath}`);
	}

	return resolved;
}

export function buildPath(...segments: string[]): string {
	const joined = path.join(...segments);
	return validatePath(joined);
}

/**
 * Simple sleep with validation (used across multiple files)
 */
export function sleep(ms: number): Promise<void> {
	if (ms < 0 || !Number.isFinite(ms)) {
		throw new Error(`Invalid sleep duration: ${ms}`);
	}
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Timeout wrapper for promises (used in network-resilience, adaptive-timeout)
 */
export function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	errorMessage?: string
): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_, reject) =>
			setTimeout(
				() => reject(new Error(errorMessage || `Operation timed out after ${timeoutMs}ms`)),
				timeoutMs
			)
		),
	]);
}

/**
 * Retry with exponential backoff (consolidated from multiple implementations)
 */
export async function retryWithBackoff<T>(
	operation: () => Promise<T>,
	options: {
		maxAttempts?: number;
		initialDelay?: number;
		maxDelay?: number;
		factor?: number;
		jitter?: boolean;
	} = {}
): Promise<T> {
	const {
		maxAttempts = 3,
		initialDelay = 1000,
		maxDelay = 30000,
		factor = 2,
		jitter = true,
	} = options;

	let lastError: Error;
	let delay = initialDelay;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await operation();
		} catch (error) {
			lastError = error as Error;

			if (attempt === maxAttempts) {
				throw lastError;
			}

			const actualDelay = jitter ? delay * (0.5 + Math.random() * 0.5) : delay;
			await sleep(actualDelay);

			// Exponential backoff
			delay = Math.min(delay * factor, maxDelay);
		}
	}

	throw lastError!;
}

/**
 * UUID validation (consolidates various UUID checks)
 */
export function isValidUUID(value: string, options: { allowNumeric?: boolean } = {}): boolean {
	const { allowNumeric = false } = options;

	// Standard UUID format
	const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

	if (uuidRegex.test(value)) {
		return true;
	}

	// Allow numeric IDs if specified (for legacy Scrivener documents)
	if (allowNumeric && /^\d+$/.test(value)) {
		return true;
	}

	return false;
}

/**
 * URL validation (used in env-config)
 */
export function validateUrl(
	url: string,
	allowedProtocols: string[] = ['http:', 'https:']
): boolean {
	try {
		const parsed = new URL(url);
		return allowedProtocols.includes(parsed.protocol);
	} catch {
		return false;
	}
}

/**
 * Safe string truncation with ellipsis
 */
export function truncateString(str: string, maxLength: number, suffix: string = '...'): string {
	if (str.length <= maxLength) return str;
	return str.substring(0, maxLength - suffix.length) + suffix;
}

/**
 * Simple memory cache with TTL (consolidates caching patterns)
 */
export class MemoryCache<T> {
	private cache = new Map<string, { value: T; expires: number }>();

	constructor(private defaultTTL: number = 300000) {} // 5 minutes default

	set(key: string, value: T, ttl?: number): void {
		const expires = Date.now() + (ttl ?? this.defaultTTL);
		this.cache.set(key, { value, expires });
	}

	get(key: string): T | undefined {
		const item = this.cache.get(key);
		if (!item) return undefined;

		if (Date.now() > item.expires) {
			this.cache.delete(key);
			return undefined;
		}

		return item.value;
	}

	clear(): void {
		this.cache.clear();
	}

	cleanup(): void {
		const now = Date.now();
		for (const [key, item] of this.cache.entries()) {
			if (now > item.expires) {
				this.cache.delete(key);
			}
		}
	}
}

export const FileUtils = {
	exists: fileExists,
	existsWithContent: fileExistsWithContent,
	ensureDir: ensureDirectory,
};

export const ProcessUtils = {
	safeExec,
	commandExists,
	getProcessByName,
};

export const PathUtils = {
	validate: validatePath,
	build: buildPath,
};

export const AsyncUtils = {
	sleep,
	withTimeout,
	retryWithBackoff,
};

export const ValidationUtils = {
	isValidUUID,
	validateUrl,
};

export const StringUtils = {
	formatBytes,
	truncate: truncateString,
};
