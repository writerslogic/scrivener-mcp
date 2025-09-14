/**
 * Adaptive Timeout and Progress Monitoring Utilities
 * Consolidated implementation with proper state management and error handling
 */

import { EventEmitter } from 'events';
import { ApplicationError } from '../core/errors.js';
import { getLogger } from '../core/logger.js';
import { ErrorCode } from '../utils/common.js';

const logger = getLogger('adaptive-timeout');

/**
 * Ring buffer for efficient memory management
 */
export class RingBuffer<T> {
	private buffer: (T | undefined)[];
	private writeIndex = 0;
	private size: number;

	constructor(size: number) {
		this.size = size;
		this.buffer = new Array(size);
	}

	push(item: T): void {
		this.buffer[this.writeIndex % this.size] = item;
		this.writeIndex++;
	}

	getAll(): T[] {
		return this.buffer.filter((item) => item !== undefined) as T[];
	}

	clear(): void {
		this.buffer = new Array(this.size);
		this.writeIndex = 0;
	}

	getLatest(count: number): T[] {
		const result: T[] = [];
		const start = Math.max(0, this.writeIndex - count);
		for (let i = start; i < this.writeIndex; i++) {
			const item = this.buffer[i % this.size];
			if (item !== undefined) {
				result.push(item);
			}
		}
		return result;
	}

	get length(): number {
		return Math.min(this.writeIndex, this.size);
	}

	slice(start?: number, end?: number): T[] {
		const all = this.getAll();
		return all.slice(start, end);
	}

	get(index: number): T | undefined {
		return this.buffer[index % this.size];
	}
}

/**
 * Metrics collector for learning from past operations
 */
export class MetricsCollector {
	private metrics = new Map<string, OperationMetrics>();

	recordOperation(
		operation: string,
		duration: number,
		success: boolean,
		progressIntervals: number[]
	): void {
		const existing = this.metrics.get(operation) || {
			operation,
			totalCount: 0,
			successCount: 0,
			totalDuration: 0,
			totalProgressIntervals: 0,
			averageDuration: 0,
			successRate: 0,
			averageProgressInterval: 0,
		};

		// Update rolling averages
		existing.totalCount++;
		if (success) existing.successCount++;
		existing.totalDuration += duration;
		existing.totalProgressIntervals +=
			progressIntervals.reduce((sum, interval) => sum + interval, 0) /
			Math.max(progressIntervals.length, 1);

		existing.averageDuration = existing.totalDuration / existing.totalCount;
		existing.successRate = existing.successCount / existing.totalCount;
		existing.averageProgressInterval = existing.totalProgressIntervals / existing.totalCount;

		this.metrics.set(operation, existing);
	}

	suggestTimeout(operation: string): { base: number; max: number; stall: number } {
		const metrics = this.metrics.get(operation);
		if (!metrics) {
			return { base: 30000, max: 300000, stall: 30000 }; // Defaults
		}

		// Calculate suggested timeouts based on historical data
		const base = Math.max(metrics.averageProgressInterval * 2, 5000);
		const max = Math.max(metrics.averageDuration * 1.5, base * 10);
		const stall = Math.max(metrics.averageProgressInterval * 3, 10000);

		return { base, max, stall };
	}
}

interface OperationMetrics {
	operation: string;
	totalCount: number;
	successCount: number;
	totalDuration: number;
	totalProgressIntervals: number;
	averageDuration: number;
	successRate: number;
	averageProgressInterval: number;
}

export interface ProgressIndicator {
	type: 'output' | 'file_size' | 'network' | 'heartbeat' | 'completion_check';
	check: () => Promise<boolean | number>;
	description: string;
}

export interface AdaptiveTimeoutOptions {
	operation: string;
	baseTimeout: number;
	maxTimeout: number;
	progressIndicators?: ProgressIndicator[];
	stallTimeout?: number;
	completionCheck?: () => Promise<boolean>;
	onProgress?: (progress: ProgressUpdate) => void;
	useExponentialBackoff?: boolean;
	metricsCollector?: MetricsCollector;
}

export interface ProgressUpdate {
	timestamp: number;
	operation: string;
	progress?: number;
	message?: string;
	phase?: string;
	[key: string]: unknown;
}

export class AdaptiveTimeout extends EventEmitter {
	private startTime: number;
	private lastProgressTime: number;
	private progressHistory: RingBuffer<ProgressUpdate>;
	private timeoutHandle: NodeJS.Timeout | null = null;
	private progressCheckHandle: NodeJS.Timeout | null = null;
	private isCompleted = false;
	private isCancelled = false;

	constructor(private options: AdaptiveTimeoutOptions) {
		super();
		this.startTime = Date.now();
		this.lastProgressTime = this.startTime;
		this.progressHistory = new RingBuffer(100);
	}

	/**
	 * Wait for operation completion with adaptive timeout
	 */
	async wait<T>(operationPromise: Promise<T>): Promise<T> {
		return new Promise((resolve, reject) => {
			// Set up progress monitoring first
			this.startProgressMonitoring();

			// Set up base timeout
			this.timeoutHandle = setTimeout(() => {
				if (!this.isCompleted && !this.isCancelled) {
					this.handleTimeout(reject);
				}
			}, this.options.baseTimeout);

			// Handle operation completion
			operationPromise
				.then((result) => {
					if (!this.isCompleted && !this.isCancelled) {
						this.isCompleted = true;
						this.cleanup();
						resolve(result);
					}
				})
				.catch((error) => {
					if (!this.isCompleted && !this.isCancelled) {
						this.isCompleted = true;
						this.cleanup();
						reject(error);
					}
				});

			// Handle cancellation
			this.once('cancelled', () => {
				if (!this.isCompleted) {
					this.isCancelled = true;
					this.cleanup();
					reject(
						new ApplicationError(
							`Operation ${this.options.operation} was cancelled`,
							ErrorCode.OPERATION_CANCELLED
						)
					);
				}
			});
		});
	}

	/**
	 * Start progress monitoring with multiple indicators
	 */
	private startProgressMonitoring(): void {
		if (!this.options.progressIndicators?.length) return;

		this.progressCheckHandle = setInterval(async () => {
			if (this.isCompleted || this.isCancelled) return;

			try {
				await this.checkProgress();
			} catch (error) {
				logger.warn('Progress check failed', {
					operation: this.options.operation,
					error: (error as Error).message,
				});
			}
		}, 2000); // Check every 2 seconds
	}

	/**
	 * Check progress using all available indicators
	 */
	private async checkProgress(): Promise<void> {
		const now = Date.now();
		let hasProgress = false;

		for (const indicator of this.options.progressIndicators || []) {
			try {
				const result = await indicator.check();

				if (typeof result === 'boolean' && result) {
					// Boolean progress (something happened)
					hasProgress = true;
					this.recordProgress(now, {
						message: `${indicator.description} detected`,
						phase: indicator.type,
					});
				} else if (typeof result === 'number' && result > 0) {
					// Numeric progress
					hasProgress = true;
					this.recordProgress(now, {
						progress: result,
						message: `${indicator.description}: ${result}%`,
						phase: indicator.type,
					});
				}
			} catch (error) {
				logger.debug(`Progress indicator ${indicator.type} failed`, { error });
			}
		}

		// Check for completion
		if (this.options.completionCheck && !this.isCompleted) {
			try {
				const isComplete = await this.options.completionCheck();
				if (isComplete) {
					this.isCompleted = true;
					this.recordProgress(now, { message: 'Operation completed' });
					this.emit('completed');
					this.cleanup();
					return;
				}
			} catch (error) {
				logger.debug('Completion check failed', { error });
			}
		}

		// Update progress tracking
		if (hasProgress) {
			this.lastProgressTime = now;
			this.extendTimeout();
		} else {
			// Check for stall
			const timeSinceProgress = now - this.lastProgressTime;
			const stallTimeout = this.options.stallTimeout || 30000; // Default 30 seconds

			if (timeSinceProgress > stallTimeout) {
				logger.warn('Operation appears stalled', {
					operation: this.options.operation,
					timeSinceProgress,
					stallTimeout,
				});
				this.emit('stalled', { timeSinceProgress });
			}
		}
	}

	/**
	 * Record progress update
	 */
	private recordProgress(timestamp: number, update: Partial<ProgressUpdate>): void {
		const progressUpdate: ProgressUpdate = {
			timestamp,
			operation: this.options.operation,
			...update,
		};

		this.progressHistory.push(progressUpdate);

		// Keep history reasonable - RingBuffer automatically manages size
		// No need to manually truncate as RingBuffer has a fixed size

		// Emit progress event
		this.emit('progress', progressUpdate);

		// Call progress callback
		this.options.onProgress?.(progressUpdate);

		logger.debug('Progress recorded', progressUpdate);
	}

	/**
	 * Extend timeout when progress is detected
	 */
	private extendTimeout(): void {
		if (this.timeoutHandle) {
			clearTimeout(this.timeoutHandle);
		}

		const elapsed = Date.now() - this.startTime;
		const remaining = this.options.maxTimeout - elapsed;
		const extension = Math.min(remaining, this.options.baseTimeout);

		if (extension > 0) {
			this.timeoutHandle = setTimeout(() => {
				this.handleTimeout();
			}, extension);

			logger.debug('Timeout extended', {
				operation: this.options.operation,
				extension,
				remaining,
			});
		}
	}

	/**
	 * Handle timeout scenario
	 */
	private handleTimeout(reject?: (error: Error) => void): void {
		const elapsed = Date.now() - this.startTime;
		const timeSinceProgress = Date.now() - this.lastProgressTime;

		logger.warn('Operation timed out', {
			operation: this.options.operation,
			elapsed,
			timeSinceProgress,
			progressHistory: this.progressHistory.slice(-5),
		});

		this.cleanup();

		const error = new ApplicationError(
			`Operation ${this.options.operation} timed out after ${Math.round(elapsed / 1000)}s`,
			ErrorCode.TIMEOUT,
			{
				elapsed,
				timeSinceProgress,
				baseTimeout: this.options.baseTimeout,
				maxTimeout: this.options.maxTimeout,
				progressHistory: this.progressHistory.slice(-5),
			}
		);

		if (reject) {
			reject(error);
		} else {
			this.emit('timeout', error);
		}
	}

	/**
	 * Cancel the operation
	 */
	cancel(): void {
		this.isCancelled = true;
		this.emit('cancelled');
	}

	/**
	 * Cleanup resources
	 */
	private cleanup(): void {
		if (this.timeoutHandle) {
			clearTimeout(this.timeoutHandle);
			this.timeoutHandle = null;
		}
		if (this.progressCheckHandle) {
			clearInterval(this.progressCheckHandle);
			this.progressCheckHandle = null;
		}
	}

	/**
	 * Get progress statistics
	 */
	getProgressStats(): {
		elapsed: number;
		timeSinceProgress: number;
		progressEvents: number;
		averageProgressInterval: number;
	} {
		const now = Date.now();
		const elapsed = now - this.startTime;
		const timeSinceProgress = now - this.lastProgressTime;
		const progressHistory = this.progressHistory.getAll();
		const progressEvents = progressHistory.length;

		let averageProgressInterval = 0;
		if (progressEvents > 1) {
			const intervals = [];
			for (let i = 1; i < progressHistory.length; i++) {
				intervals.push(progressHistory[i].timestamp - progressHistory[i - 1].timestamp);
			}
			averageProgressInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
		}

		return {
			elapsed,
			timeSinceProgress,
			progressEvents,
			averageProgressInterval,
		};
	}
}

/**
 * Common progress indicators for different operation types
 */
export class ProgressIndicators {
	/**
	 * Monitor command output for activity
	 */
	static outputProgress(lastOutput: { value: string }): ProgressIndicator {
		let lastLength = 0;

		return {
			type: 'output',
			description: 'Command output activity',
			check: async () => {
				const currentLength = lastOutput.value.length;
				if (currentLength > lastLength) {
					lastLength = currentLength;
					return true;
				}
				return false;
			},
		};
	}

	/**
	 * Monitor file size changes
	 */
	static fileSizeProgress(filePath: string): ProgressIndicator {
		let lastSize = 0;

		return {
			type: 'file_size',
			description: `File size changes: ${filePath}`,
			check: async () => {
				try {
					const fs = await import('fs/promises');
					const stats = await fs.stat(filePath);
					const currentSize = stats.size;

					if (currentSize > lastSize) {
						const progress = Math.min(100, (currentSize / (1024 * 1024)) * 10); // Rough progress
						lastSize = currentSize;
						return progress;
					}
				} catch {
					// File might not exist yet
				}
				return false;
			},
		};
	}

	/**
	 * Monitor network connectivity
	 */
	static networkProgress(host: string, port: number): ProgressIndicator {
		return {
			type: 'network',
			description: `Network connectivity to ${host}:${port}`,
			check: async () => {
				try {
					const net = await import('net');
					const socket = new net.Socket();

					return new Promise<boolean>((resolve) => {
						const timeout = setTimeout(() => {
							socket.destroy();
							resolve(false);
						}, 2000);

						socket.once('connect', () => {
							clearTimeout(timeout);
							socket.removeAllListeners();
							socket.destroy();
							resolve(true);
						});

						socket.once('error', () => {
							clearTimeout(timeout);
							socket.removeAllListeners();
							resolve(false);
						});
					});
				} catch {
					return false;
				}
			},
		};
	}

	/**
	 * Monitor process existence
	 */
	static processHeartbeat(processName: string): ProgressIndicator {
		return {
			type: 'heartbeat',
			description: `Process heartbeat: ${processName}`,
			check: async () => {
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
		};
	}
}
