/**
 * Condition-based Waiting Utilities
 * Replaces static sleep calls with intelligent condition polling
 */

import { getLogger } from '../core/logger.js';
import { ApplicationError, ErrorCode } from '../core/errors.js';
import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);

const logger = getLogger('condition-waiter');

export interface WaitConditionOptions {
	condition: () => Promise<boolean>;
	description: string;
	timeout?: number;
	pollInterval?: number;
	exponentialBackoff?: boolean;
	maxPollInterval?: number;
}

export interface WaitResult {
	success: boolean;
	elapsedTime: number;
	attempts: number;
}

/**
 * Wait for a condition to be true instead of using static sleep
 */
export async function waitForCondition({
	condition,
	description,
	timeout = 30000,
	pollInterval = 100,
	exponentialBackoff = false,
	maxPollInterval = 2000,
}: WaitConditionOptions): Promise<WaitResult> {
	// Input validation to prevent edge cases
	if (timeout <= 0) {
		throw new ApplicationError('Timeout must be positive', ErrorCode.VALIDATION_ERROR, {
			timeout,
		});
	}
	if (pollInterval <= 0) {
		throw new ApplicationError('Poll interval must be positive', ErrorCode.VALIDATION_ERROR, {
			pollInterval,
		});
	}
	if (maxPollInterval <= 0) {
		throw new ApplicationError(
			'Max poll interval must be positive',
			ErrorCode.VALIDATION_ERROR,
			{ maxPollInterval }
		);
	}
	if (pollInterval > maxPollInterval) {
		throw new ApplicationError(
			'Poll interval cannot exceed max poll interval',
			ErrorCode.VALIDATION_ERROR,
			{
				pollInterval,
				maxPollInterval,
			}
		);
	}

	const startTime = Date.now();
	let attempts = 0;
	let currentInterval = pollInterval;
	const maxAttempts = Math.ceil(timeout / Math.min(pollInterval, 50)); // Prevent unbounded attempts

	logger.debug(`Starting condition wait: ${description}`, {
		timeout,
		initialPollInterval: pollInterval,
		exponentialBackoff,
	});

	while (Date.now() - startTime < timeout && attempts < maxAttempts) {
		attempts++;

		try {
			const result = await condition();
			if (result) {
				const elapsedTime = Date.now() - startTime;
				logger.debug(`Condition met: ${description}`, {
					elapsedTime,
					attempts,
				});
				return {
					success: true,
					elapsedTime,
					attempts,
				};
			}
		} catch (error) {
			logger.debug(`Condition check failed: ${description}`, {
				error: error instanceof Error ? error.message : 'Unknown error',
				attempt: attempts,
			});

			// If condition checking consistently fails, increase backoff more aggressively
			if (exponentialBackoff && attempts % 5 === 0) {
				currentInterval = Math.min(currentInterval * 2, maxPollInterval);
			}
		}

		// Wait before next check
		await sleep(currentInterval);

		// Exponential backoff if enabled
		if (exponentialBackoff) {
			currentInterval = Math.min(currentInterval * 1.5, maxPollInterval);
		}
	}

	const elapsedTime = Date.now() - startTime;
	logger.warn(`Condition timeout: ${description}`, {
		timeout,
		elapsedTime,
		attempts,
	});

	throw new ApplicationError(`Timeout waiting for condition: ${description}`, ErrorCode.TIMEOUT, {
		description,
		timeout,
		elapsedTime,
		attempts,
	});
}

/**
 * Wait for service to be ready on specific port
 */
export async function waitForServiceReady(
	host: string,
	port: number,
	timeout: number = 30000
): Promise<WaitResult> {
	return waitForCondition({
		condition: async () => {
			try {
				const net = await import('net');
				const socket = new net.Socket();

				return new Promise<boolean>((resolve) => {
					const connectTimeout = setTimeout(() => {
						socket.destroy();
						resolve(false);
					}, 2000);

					socket.connect(port, host, () => {
						clearTimeout(connectTimeout);
						socket.destroy();
						resolve(true);
					});

					socket.on('error', () => {
						clearTimeout(connectTimeout);
						resolve(false);
					});
				});
			} catch {
				return false;
			}
		},
		description: `Service ready on ${host}:${port}`,
		timeout,
		pollInterval: 500,
		exponentialBackoff: true,
	});
}

/**
 * Wait for HTTP endpoint to be ready
 */
export async function waitForHttpReady(
	url: string,
	timeout: number = 30000,
	expectedStatusCode: number = 200
): Promise<WaitResult> {
	return waitForCondition({
		condition: async () => {
			try {
				// Create manual timeout for broader compatibility
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), 5000);

				const response = await fetch(url, {
					method: 'HEAD',
					signal: controller.signal,
				});

				clearTimeout(timeoutId);
				return response.status === expectedStatusCode;
			} catch {
				return false;
			}
		},
		description: `HTTP endpoint ready: ${url}`,
		timeout,
		pollInterval: 1000,
		exponentialBackoff: true,
	});
}

/**
 * Wait for file system condition
 */
export async function waitForFileCondition(
	filePath: string,
	condition: 'exists' | 'readable' | 'writable',
	timeout: number = 10000
): Promise<WaitResult> {
	return waitForCondition({
		condition: async () => {
			try {
				const fs = await import('fs/promises');

				switch (condition) {
					case 'exists':
						await fs.access(filePath);
						return true;
					case 'readable':
						await fs.access(filePath, (await import('fs')).constants.R_OK);
						return true;
					case 'writable':
						await fs.access(filePath, (await import('fs')).constants.W_OK);
						return true;
					default:
						return false;
				}
			} catch {
				return false;
			}
		},
		description: `File ${condition}: ${filePath}`,
		timeout,
		pollInterval: 200,
	});
}

/**
 * Wait for process to be running
 */
export async function waitForProcess(
	processName: string,
	timeout: number = 30000
): Promise<WaitResult> {
	return waitForCondition({
		condition: async () => {
			try {
				const { exec } = await import('child_process');
				const { promisify } = await import('util');
				const execAsync = promisify(exec);

				await execAsync(`pgrep -f "${processName}"`, { timeout: 2000 });
				return true;
			} catch {
				return false;
			}
		},
		description: `Process running: ${processName}`,
		timeout,
		pollInterval: 500,
		exponentialBackoff: true,
	});
}

/**
 * Wait for Docker container to be ready
 */
export async function waitForDockerContainer(
	containerName: string,
	timeout: number = 60000
): Promise<WaitResult> {
	return waitForCondition({
		condition: async () => {
			try {
				const { exec } = await import('child_process');
				const { promisify } = await import('util');
				const execAsync = promisify(exec);

				const { stdout } = await execAsync(
					`docker inspect --format='{{.State.Health.Status}}' ${containerName}`,
					{ timeout: 5000 }
				);

				const healthStatus = stdout.trim();
				return healthStatus === 'healthy' || healthStatus === 'starting';
			} catch {
				// Try basic container running check if health check not available
				try {
					const { stdout } = await execAsync(
						`docker inspect --format='{{.State.Running}}' ${containerName}`,
						{ timeout: 5000 }
					);
					return stdout.trim() === 'true';
				} catch {
					return false;
				}
			}
		},
		description: `Docker container ready: ${containerName}`,
		timeout,
		pollInterval: 1000,
		exponentialBackoff: true,
	});
}

/**
 * Simple sleep function for cases where timed delay is actually needed
 */
export const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));
