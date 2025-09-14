/**
 * Advanced Work Scheduler with Priority-Based Task Management
 * Enterprise-grade task scheduling with dynamic priority adjustment,
 * resource allocation, load balancing, and intelligent queue management
 */

import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';
import { ApplicationError as AppError, ErrorCode } from '../core/errors.js';
import { AsyncUtils } from './shared-patterns.js';
import { globalProfiler } from './advanced-performance.js';

const logger = getLogger('advanced-scheduler');

export type TaskPriority = 'urgent' | 'high' | 'normal' | 'low' | 'background';
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'retrying';
export type ResourceType = 'cpu' | 'memory' | 'io' | 'network' | 'custom';

export interface TaskDefinition<T = unknown, R = unknown> {
	id: string;
	name: string;
	priority: TaskPriority;
	estimatedDuration?: number; // ms
	maxRetries?: number;
	retryDelay?: number; // ms
	timeout?: number; // ms
	dependencies?: string[]; // task IDs
	resources?: Partial<Record<ResourceType, number>>;
	tags?: string[];
	metadata?: Record<string, unknown>;
	execute: (input: T, context: TaskExecutionContext) => Promise<R> | R;
	onProgress?: (progress: number, message?: string) => void;
	onRetry?: (attempt: number, error: Error) => void;
	validate?: (input: T) => boolean | Promise<boolean>;
}

export interface TaskExecutionContext {
	taskId: string;
	attempt: number;
	startTime: number;
	signal: AbortSignal;
	updateProgress: (progress: number, message?: string) => void;
	setMetadata: (key: string, value: unknown) => void;
	getResource: <T>(type: ResourceType, id: string) => T | undefined;
}

export interface TaskInstance<T = unknown, R = unknown> {
	definition: TaskDefinition<T, R>;
	input: T;
	id: string;
	status: TaskStatus;
	priority: TaskPriority;
	scheduledAt: number;
	startedAt?: number;
	completedAt?: number;
	duration?: number;
	result?: R;
	error?: Error;
	attempts: number;
	maxRetries: number;
	progress: number;
	progressMessage?: string;
	metadata: Record<string, unknown>;
	abortController: AbortController;
	dependencies: string[];
	resourceAllocations: Partial<Record<ResourceType, number>>;
	estimatedCompletionTime?: number;
}

export interface WorkerConfig {
	id: string;
	maxConcurrentTasks: number;
	supportedPriorities: TaskPriority[];
	resourceCapacity: Partial<Record<ResourceType, number>>;
	specialization?: string[]; // task tags this worker specializes in
}

export interface SchedulerConfig {
	maxQueueSize: number;
	defaultTimeout: number;
	enableLoadBalancing: boolean;
	enablePriorityAging: boolean;
	priorityAgingInterval: number;
	enableResourceTracking: boolean;
	enableDeadlockDetection: boolean;
	deadlockCheckInterval: number;
	enablePerformanceOptimization: boolean;
	metricsRetentionPeriod: number;
}

export interface SchedulerMetrics {
	totalTasksScheduled: number;
	totalTasksCompleted: number;
	totalTasksFailed: number;
	averageExecutionTime: number;
	averageQueueTime: number;
	currentQueueSize: number;
	activeWorkers: number;
	resourceUtilization: Partial<Record<ResourceType, number>>;
	throughput: number; // tasks per second
	errorRate: number;
	priorityDistribution: Record<TaskPriority, number>;
}

interface QueuedTask<T = unknown, R = unknown> {
	task: TaskInstance<T, R>;
	queuedAt: number;
	priorityScore: number;
	resourceScore: number;
	dependencies: Set<string>;
	estimatedStartTime?: number;
}

interface Worker {
	config: WorkerConfig;
	currentTasks: Map<string, TaskInstance>;
	resourceUsage: Partial<Record<ResourceType, number>>;
	isIdle: boolean;
	totalTasksProcessed: number;
	averageTaskDuration: number;
	lastTaskCompletedAt: number;
	specializations: Set<string>;
}

export class AdvancedTaskScheduler extends EventEmitter {
	private config: SchedulerConfig;
	private taskQueue: QueuedTask[] = [];
	private runningTasks = new Map<string, TaskInstance>();
	private completedTasks = new Map<string, TaskInstance>();
	private workers = new Map<string, Worker>();
	private globalResourceUsage: Partial<Record<ResourceType, number>> = {};
	private globalResourceCapacity: Partial<Record<ResourceType, number>> = {};
	private taskDefinitions = new Map<string, TaskDefinition>();
	private dependencyGraph = new Map<string, Set<string>>();
	private metrics: SchedulerMetrics;
	private isRunning = false;
	private schedulingInterval: NodeJS.Timeout | null = null;
	private maintenanceInterval: NodeJS.Timeout | null = null;
	private priorityAgingInterval: NodeJS.Timeout | null = null;
	private deadlockCheckInterval: NodeJS.Timeout | null = null;
	private performanceHistory: Array<{ timestamp: number; metrics: SchedulerMetrics }> = [];

	constructor(config: Partial<SchedulerConfig> = {}) {
		super();

		this.config = {
			maxQueueSize: config.maxQueueSize ?? 10000,
			defaultTimeout: config.defaultTimeout ?? 300000, // 5 minutes
			enableLoadBalancing: config.enableLoadBalancing ?? true,
			enablePriorityAging: config.enablePriorityAging ?? true,
			priorityAgingInterval: config.priorityAgingInterval ?? 60000, // 1 minute
			enableResourceTracking: config.enableResourceTracking ?? true,
			enableDeadlockDetection: config.enableDeadlockDetection ?? true,
			deadlockCheckInterval: config.deadlockCheckInterval ?? 30000, // 30 seconds
			enablePerformanceOptimization: config.enablePerformanceOptimization ?? true,
			metricsRetentionPeriod: config.metricsRetentionPeriod ?? 3600000, // 1 hour
		};

		this.metrics = {
			totalTasksScheduled: 0,
			totalTasksCompleted: 0,
			totalTasksFailed: 0,
			averageExecutionTime: 0,
			averageQueueTime: 0,
			currentQueueSize: 0,
			activeWorkers: 0,
			resourceUtilization: {},
			throughput: 0,
			errorRate: 0,
			priorityDistribution: {
				urgent: 0,
				high: 0,
				normal: 0,
				low: 0,
				background: 0,
			},
		};

		this.initializeResourceCapacity();
		this.setupPerformanceMonitoring();
	}

	/**
	 * Start the scheduler
	 */
	async start(): Promise<void> {
		if (this.isRunning) {
			return;
		}

		this.isRunning = true;

		// Start main scheduling loop
		this.schedulingInterval = setInterval(() => {
			this.scheduleNextTasks();
		}, 100); // Check every 100ms for responsive scheduling

		// Start maintenance tasks
		this.maintenanceInterval = setInterval(() => {
			this.performMaintenance();
		}, 10000); // Every 10 seconds

		if (this.config.enablePriorityAging) {
			this.priorityAgingInterval = setInterval(() => {
				this.performPriorityAging();
			}, this.config.priorityAgingInterval);
		}

		if (this.config.enableDeadlockDetection) {
			this.deadlockCheckInterval = setInterval(() => {
				this.detectAndResolveDeadlocks();
			}, this.config.deadlockCheckInterval);
		}

		logger.info('Advanced task scheduler started', { config: this.config });
		this.emit('schedulerStarted');
	}

	/**
	 * Stop the scheduler gracefully
	 */
	async stop(gracefulShutdownTimeout = 30000): Promise<void> {
		if (!this.isRunning) {
			return;
		}

		this.isRunning = false;

		// Clear intervals
		if (this.schedulingInterval) clearInterval(this.schedulingInterval);
		if (this.maintenanceInterval) clearInterval(this.maintenanceInterval);
		if (this.priorityAgingInterval) clearInterval(this.priorityAgingInterval);
		if (this.deadlockCheckInterval) clearInterval(this.deadlockCheckInterval);

		// Cancel all pending tasks
		for (const queuedTask of this.taskQueue) {
			queuedTask.task.abortController.abort();
			queuedTask.task.status = 'cancelled';
		}
		this.taskQueue = [];

		// Wait for running tasks to complete or timeout
		const startTime = Date.now();
		while (this.runningTasks.size > 0 && Date.now() - startTime < gracefulShutdownTimeout) {
			await AsyncUtils.sleep(100);
		}

		// Force cancel any remaining tasks
		for (const task of this.runningTasks.values()) {
			task.abortController.abort();
			task.status = 'cancelled';
		}

		logger.info('Advanced task scheduler stopped');
		this.emit('schedulerStopped');
	}

	/**
	 * Register a worker with the scheduler
	 */
	registerWorker(config: WorkerConfig): void {
		if (this.workers.has(config.id)) {
			throw new AppError(`Worker ${config.id} already registered`, ErrorCode.INVALID_INPUT);
		}

		const worker: Worker = {
			config,
			currentTasks: new Map(),
			resourceUsage: {},
			isIdle: true,
			totalTasksProcessed: 0,
			averageTaskDuration: 0,
			lastTaskCompletedAt: 0,
			specializations: new Set(config.specialization || []),
		};

		this.workers.set(config.id, worker);

		// Update global resource capacity
		if (this.config.enableResourceTracking) {
			for (const [type, capacity] of Object.entries(config.resourceCapacity)) {
				this.globalResourceCapacity[type as ResourceType] =
					(this.globalResourceCapacity[type as ResourceType] || 0) + capacity;
			}
		}

		logger.info(`Worker ${config.id} registered`, {
			maxConcurrentTasks: config.maxConcurrentTasks,
			specializations: config.specialization,
		});

		this.emit('workerRegistered', { workerId: config.id });
	}

	/**
	 * Unregister a worker
	 */
	async unregisterWorker(workerId: string, gracefulTimeout = 10000): Promise<void> {
		const worker = this.workers.get(workerId);
		if (!worker) {
			return;
		}

		// Wait for current tasks to complete
		const startTime = Date.now();
		while (worker.currentTasks.size > 0 && Date.now() - startTime < gracefulTimeout) {
			await AsyncUtils.sleep(100);
		}

		// Cancel any remaining tasks
		for (const task of worker.currentTasks.values()) {
			task.abortController.abort();
			task.status = 'cancelled';
			this.runningTasks.delete(task.id);
		}

		// Update global resource capacity
		if (this.config.enableResourceTracking) {
			for (const [type, capacity] of Object.entries(worker.config.resourceCapacity)) {
				this.globalResourceCapacity[type as ResourceType] = Math.max(
					0,
					(this.globalResourceCapacity[type as ResourceType] || 0) - capacity
				);
			}
		}

		this.workers.delete(workerId);
		logger.info(`Worker ${workerId} unregistered`);
		this.emit('workerUnregistered', { workerId });
	}

	/**
	 * Submit a task for execution
	 */
	async submitTask<T, R>(
		definition: TaskDefinition<T, R>,
		input: T,
		options: {
			priority?: TaskPriority;
			dependencies?: string[];
			estimatedDuration?: number;
			metadata?: Record<string, unknown>;
		} = {}
	): Promise<string> {
		return globalProfiler.profileOperation('scheduler_submit_task', async () => {
			if (this.taskQueue.length >= this.config.maxQueueSize) {
				throw new AppError('Task queue is full', ErrorCode.RESOURCE_EXHAUSTED, {
					queueSize: this.taskQueue.length,
					maxSize: this.config.maxQueueSize,
				});
			}

			// Validate input if validator is provided
			if (definition.validate) {
				const isValid = await definition.validate(input);
				if (!isValid) {
					throw new AppError('Task input validation failed', ErrorCode.INVALID_INPUT);
				}
			}

			const taskId = this.generateTaskId();
			const priority = options.priority || definition.priority;
			const dependencies = [
				...(options.dependencies || []),
				...(definition.dependencies || []),
			];

			// Check for circular dependencies
			this.validateDependencies(taskId, dependencies);

			const task: TaskInstance<T, R> = {
				definition,
				input,
				id: taskId,
				status: 'pending',
				priority,
				scheduledAt: Date.now(),
				attempts: 0,
				maxRetries: definition.maxRetries || 3,
				progress: 0,
				metadata: { ...definition.metadata, ...options.metadata },
				abortController: new AbortController(),
				dependencies,
				resourceAllocations: definition.resources || {},
			};

			// Calculate priority and resource scores
			const priorityScore = this.calculatePriorityScore(
				task as TaskInstance<unknown, unknown>
			);
			const resourceScore = this.calculateResourceScore(
				task as TaskInstance<unknown, unknown>
			);

			const queuedTask: QueuedTask<T, R> = {
				task,
				queuedAt: Date.now(),
				priorityScore,
				resourceScore,
				dependencies: new Set(dependencies),
			};

			this.taskQueue.push(queuedTask as QueuedTask<unknown, unknown>);
			this.taskDefinitions.set(taskId, definition as TaskDefinition<unknown, unknown>);
			this.updateDependencyGraph(taskId, dependencies);

			// Sort queue by priority and resource scores
			this.sortTaskQueue();

			this.metrics.totalTasksScheduled++;
			this.metrics.currentQueueSize = this.taskQueue.length;
			this.metrics.priorityDistribution[priority]++;

			logger.debug(`Task ${taskId} submitted`, {
				name: definition.name,
				priority,
				dependencies: dependencies.length,
				queuePosition: this.taskQueue.findIndex((qt) => qt.task.id === taskId),
			});

			this.emit('taskSubmitted', {
				taskId,
				name: definition.name,
				priority,
				queueSize: this.taskQueue.length,
			});

			return taskId;
		});
	}

	/**
	 * Cancel a task
	 */
	async cancelTask(taskId: string, reason = 'User requested'): Promise<boolean> {
		// Check if task is in queue
		const queueIndex = this.taskQueue.findIndex((qt) => qt.task.id === taskId);
		if (queueIndex !== -1) {
			const queuedTask = this.taskQueue.splice(queueIndex, 1)[0];
			queuedTask.task.status = 'cancelled';
			queuedTask.task.abortController.abort();
			this.metrics.currentQueueSize = this.taskQueue.length;

			logger.info(`Task ${taskId} cancelled from queue`, { reason });
			this.emit('taskCancelled', { taskId, reason, wasRunning: false });
			return true;
		}

		// Check if task is running
		const runningTask = this.runningTasks.get(taskId);
		if (runningTask) {
			runningTask.abortController.abort();
			runningTask.status = 'cancelled';
			runningTask.completedAt = Date.now();
			runningTask.duration =
				runningTask.completedAt - (runningTask.startedAt || runningTask.scheduledAt);

			this.runningTasks.delete(taskId);
			this.completedTasks.set(taskId, runningTask);

			// Free up worker resources
			this.freeWorkerResources(runningTask);

			logger.info(`Running task ${taskId} cancelled`, { reason });
			this.emit('taskCancelled', { taskId, reason, wasRunning: true });
			return true;
		}

		return false;
	}

	/**
	 * Get task status and details
	 */
	getTaskStatus(taskId: string): TaskInstance | null {
		// Check running tasks
		const runningTask = this.runningTasks.get(taskId);
		if (runningTask) {
			return { ...runningTask };
		}

		// Check completed tasks
		const completedTask = this.completedTasks.get(taskId);
		if (completedTask) {
			return { ...completedTask };
		}

		// Check queue
		const queuedTask = this.taskQueue.find((qt) => qt.task.id === taskId);
		if (queuedTask) {
			return { ...queuedTask.task };
		}

		return null;
	}

	/**
	 * Get scheduler metrics
	 */
	getMetrics(): SchedulerMetrics {
		this.updateMetrics();
		return { ...this.metrics };
	}

	/**
	 * Get detailed performance report
	 */
	getPerformanceReport(): {
		metrics: SchedulerMetrics;
		workers: Array<{
			id: string;
			currentLoad: number;
			totalProcessed: number;
			averageDuration: number;
			resourceUtilization: Partial<Record<ResourceType, number>>;
		}>;
		queueAnalysis: {
			totalPending: number;
			priorityBreakdown: Record<TaskPriority, number>;
			averageWaitTime: number;
			oldestTaskAge: number;
		};
		resourceAnalysis: {
			globalUtilization: Partial<Record<ResourceType, number>>;
			globalCapacity: Partial<Record<ResourceType, number>>;
			bottlenecks: string[];
		};
		performanceTrends: Array<{ timestamp: number; throughput: number; errorRate: number }>;
	} {
		const workerStats = Array.from(this.workers.values()).map((worker) => ({
			id: worker.config.id,
			currentLoad: worker.currentTasks.size / worker.config.maxConcurrentTasks,
			totalProcessed: worker.totalTasksProcessed,
			averageDuration: worker.averageTaskDuration,
			resourceUtilization: { ...worker.resourceUsage },
		}));

		const priorityBreakdown: Record<TaskPriority, number> = {
			urgent: 0,
			high: 0,
			normal: 0,
			low: 0,
			background: 0,
		};

		let totalWaitTime = 0;
		let oldestTaskAge = 0;
		const now = Date.now();

		for (const queuedTask of this.taskQueue) {
			priorityBreakdown[queuedTask.task.priority]++;
			const waitTime = now - queuedTask.queuedAt;
			totalWaitTime += waitTime;
			oldestTaskAge = Math.max(oldestTaskAge, waitTime);
		}

		const averageWaitTime =
			this.taskQueue.length > 0 ? totalWaitTime / this.taskQueue.length : 0;

		const resourceBottlenecks: string[] = [];
		for (const [type, usage] of Object.entries(this.globalResourceUsage)) {
			const capacity = this.globalResourceCapacity[type as ResourceType] || 0;
			if (capacity > 0 && usage / capacity > 0.9) {
				resourceBottlenecks.push(`${type}: ${((usage / capacity) * 100).toFixed(1)}%`);
			}
		}

		const performanceTrends = this.performanceHistory.slice(-50).map((entry) => ({
			timestamp: entry.timestamp,
			throughput: entry.metrics.throughput,
			errorRate: entry.metrics.errorRate,
		}));

		return {
			metrics: this.getMetrics(),
			workers: workerStats,
			queueAnalysis: {
				totalPending: this.taskQueue.length,
				priorityBreakdown,
				averageWaitTime,
				oldestTaskAge,
			},
			resourceAnalysis: {
				globalUtilization: { ...this.globalResourceUsage },
				globalCapacity: { ...this.globalResourceCapacity },
				bottlenecks: resourceBottlenecks,
			},
			performanceTrends,
		};
	}

	// Private methods

	private async scheduleNextTasks(): Promise<void> {
		if (!this.isRunning || this.taskQueue.length === 0) {
			return;
		}

		// Find available workers and ready tasks
		const availableWorkers = Array.from(this.workers.values()).filter(
			(worker) => worker.currentTasks.size < worker.config.maxConcurrentTasks
		);

		if (availableWorkers.length === 0) {
			return;
		}

		// Get ready tasks (no pending dependencies)
		const readyTasks = this.taskQueue.filter((qt) =>
			this.areAllDependenciesComplete(qt.task.id)
		);

		if (readyTasks.length === 0) {
			return;
		}

		// Match tasks to workers using intelligent assignment
		const assignments = this.assignTasksToWorkers(readyTasks, availableWorkers);

		// Execute assignments
		for (const { task: queuedTask, worker } of assignments) {
			// Remove from queue
			const queueIndex = this.taskQueue.findIndex((qt) => qt.task.id === queuedTask.task.id);
			if (queueIndex !== -1) {
				this.taskQueue.splice(queueIndex, 1);
			}

			// Start execution
			await this.executeTask(queuedTask.task, worker);
		}

		this.metrics.currentQueueSize = this.taskQueue.length;
	}

	private assignTasksToWorkers(
		readyTasks: QueuedTask[],
		availableWorkers: Worker[]
	): Array<{ task: QueuedTask; worker: Worker }> {
		const assignments: Array<{ task: QueuedTask; worker: Worker }> = [];

		// Sort tasks by combined priority and resource score
		const sortedTasks = [...readyTasks].sort((a, b) => {
			const scoreA = a.priorityScore + a.resourceScore;
			const scoreB = b.priorityScore + b.resourceScore;
			return scoreB - scoreA;
		});

		for (const queuedTask of sortedTasks) {
			// Find best worker for this task
			const bestWorker = this.findBestWorkerForTask(queuedTask.task, availableWorkers);

			if (bestWorker && this.canWorkerHandleTask(bestWorker, queuedTask.task)) {
				assignments.push({ task: queuedTask, worker: bestWorker });

				// Update worker availability
				const workerIndex = availableWorkers.indexOf(bestWorker);
				if (bestWorker.currentTasks.size + 1 >= bestWorker.config.maxConcurrentTasks) {
					availableWorkers.splice(workerIndex, 1);
				}
			}
		}

		return assignments;
	}

	private findBestWorkerForTask(task: TaskInstance, workers: Worker[]): Worker | null {
		let bestWorker: Worker | null = null;
		let bestScore = -1;

		for (const worker of workers) {
			if (!this.canWorkerHandleTask(worker, task)) {
				continue;
			}

			let score = 0;

			// Priority compatibility
			if (worker.config.supportedPriorities.includes(task.priority)) {
				score += 10;
			}

			// Specialization match
			if (task.definition.tags) {
				const matchingSpecs = task.definition.tags.filter((tag) =>
					worker.specializations.has(tag)
				).length;
				score += matchingSpecs * 5;
			}

			// Resource efficiency
			const resourceScore = this.calculateWorkerResourceScore(worker, task);
			score += resourceScore;

			// Load balancing - prefer less loaded workers
			const loadFactor = worker.currentTasks.size / worker.config.maxConcurrentTasks;
			score += (1 - loadFactor) * 3;

			if (score > bestScore) {
				bestScore = score;
				bestWorker = worker;
			}
		}

		return bestWorker;
	}

	private canWorkerHandleTask(worker: Worker, task: TaskInstance): boolean {
		// Check concurrent task limit
		if (worker.currentTasks.size >= worker.config.maxConcurrentTasks) {
			return false;
		}

		// Check priority support
		if (!worker.config.supportedPriorities.includes(task.priority)) {
			return false;
		}

		// Check resource availability
		if (this.config.enableResourceTracking) {
			for (const [type, required] of Object.entries(task.resourceAllocations)) {
				const available =
					(worker.config.resourceCapacity[type as ResourceType] || 0) -
					(worker.resourceUsage[type as ResourceType] || 0);
				if (available < required) {
					return false;
				}
			}
		}

		return true;
	}

	private calculateWorkerResourceScore(worker: Worker, task: TaskInstance): number {
		let score = 0;

		if (this.config.enableResourceTracking) {
			for (const [type, required] of Object.entries(task.resourceAllocations)) {
				const capacity = worker.config.resourceCapacity[type as ResourceType] || 0;
				const used = worker.resourceUsage[type as ResourceType] || 0;
				const available = capacity - used;

				if (capacity > 0) {
					const efficiency =
						available >= required ? (available - required) / capacity : -1;
					score += efficiency;
				}
			}
		}

		return score;
	}

	private async executeTask(task: TaskInstance, worker: Worker): Promise<void> {
		task.status = 'running';
		task.startedAt = Date.now();
		task.attempts++;

		// Add to running tasks and worker
		this.runningTasks.set(task.id, task);
		worker.currentTasks.set(task.id, task);
		worker.isIdle = false;

		// Allocate resources
		this.allocateWorkerResources(worker, task);

		logger.debug(`Task ${task.id} started on worker ${worker.config.id}`, {
			name: task.definition.name,
			attempt: task.attempts,
			priority: task.priority,
		});

		this.emit('taskStarted', {
			taskId: task.id,
			workerId: worker.config.id,
			name: task.definition.name,
			attempt: task.attempts,
		});

		// Create execution context
		const context: TaskExecutionContext = {
			taskId: task.id,
			attempt: task.attempts,
			startTime: task.startedAt,
			signal: task.abortController.signal,
			updateProgress: (progress: number, message?: string) => {
				task.progress = Math.max(0, Math.min(100, progress));
				task.progressMessage = message;
				this.emit('taskProgress', {
					taskId: task.id,
					progress: task.progress,
					message,
				});
				task.definition.onProgress?.(progress, message);
			},
			setMetadata: (key: string, value: unknown) => {
				task.metadata[key] = value;
			},
			getResource: <T>(_type: ResourceType, _id: string): T | undefined => {
				// Implementation for resource retrieval would go here
				return undefined;
			},
		};

		try {
			// Execute with timeout
			const timeout = task.definition.timeout || this.config.defaultTimeout;
			const result = await AsyncUtils.withTimeout(
				Promise.resolve(task.definition.execute(task.input, context)),
				timeout,
				`Task ${task.id} timed out after ${timeout}ms`
			);

			// Task completed successfully
			task.status = 'completed';
			task.result = result;
			task.completedAt = Date.now();
			task.duration = task.completedAt - task.startedAt;
			task.progress = 100;

			this.completeTask(task, worker, true);

			logger.info(`Task ${task.id} completed successfully`, {
				name: task.definition.name,
				duration: task.duration,
				attempts: task.attempts,
			});
		} catch (error) {
			const err = error as Error;
			task.error = err;

			// Check if we should retry
			if (task.attempts < task.maxRetries && !task.abortController.signal.aborted) {
				task.status = 'retrying';

				logger.warn(`Task ${task.id} failed, retrying`, {
					name: task.definition.name,
					attempt: task.attempts,
					error: err.message,
				});

				this.emit('taskRetrying', {
					taskId: task.id,
					attempt: task.attempts,
					error: err.message,
					nextAttemptIn: task.definition.retryDelay || 1000,
				});

				task.definition.onRetry?.(task.attempts, err);

				// Remove from current execution and re-queue
				this.freeWorkerResources(task);
				worker.currentTasks.delete(task.id);
				this.runningTasks.delete(task.id);

				// Re-queue after delay
				const retryDelay = task.definition.retryDelay || 1000;
				setTimeout(() => {
					if (this.isRunning) {
						task.status = 'pending';
						task.abortController = new AbortController(); // New abort controller
						const queuedTask: QueuedTask = {
							task,
							queuedAt: Date.now(),
							priorityScore: this.calculatePriorityScore(task),
							resourceScore: this.calculateResourceScore(task),
							dependencies: new Set(task.dependencies),
						};
						this.taskQueue.push(queuedTask);
						this.sortTaskQueue();
					}
				}, retryDelay);
			} else {
				// Task failed permanently
				task.status = 'failed';
				task.completedAt = Date.now();
				task.duration = task.completedAt - task.startedAt;

				this.completeTask(task, worker, false);

				logger.error(`Task ${task.id} failed permanently`, {
					name: task.definition.name,
					attempts: task.attempts,
					error: err.message,
				});
			}
		}
	}

	private completeTask(task: TaskInstance, worker: Worker, success: boolean): void {
		// Remove from running tasks and worker
		this.runningTasks.delete(task.id);
		worker.currentTasks.delete(task.id);
		worker.isIdle = worker.currentTasks.size === 0;

		// Free resources
		this.freeWorkerResources(task);

		// Update worker statistics
		worker.totalTasksProcessed++;
		worker.lastTaskCompletedAt = Date.now();
		if (task.duration) {
			worker.averageTaskDuration = (worker.averageTaskDuration + task.duration) / 2;
		}

		// Store completed task
		this.completedTasks.set(task.id, task);

		// Update metrics
		if (success) {
			this.metrics.totalTasksCompleted++;
		} else {
			this.metrics.totalTasksFailed++;
		}

		// Clean up old completed tasks
		if (this.completedTasks.size > 1000) {
			const oldestTasks = Array.from(this.completedTasks.entries())
				.sort(([, a], [, b]) => (a.completedAt || 0) - (b.completedAt || 0))
				.slice(0, 500);

			for (const [taskId] of oldestTasks) {
				this.completedTasks.delete(taskId);
			}
		}

		this.emit('taskCompleted', {
			taskId: task.id,
			success,
			duration: task.duration,
			result: success ? task.result : undefined,
			error: success ? undefined : task.error?.message,
		});
	}

	private allocateWorkerResources(worker: Worker, task: TaskInstance): void {
		if (!this.config.enableResourceTracking) return;

		for (const [type, amount] of Object.entries(task.resourceAllocations)) {
			const resourceType = type as ResourceType;
			worker.resourceUsage[resourceType] = (worker.resourceUsage[resourceType] || 0) + amount;
			this.globalResourceUsage[resourceType] =
				(this.globalResourceUsage[resourceType] || 0) + amount;
		}
	}

	private freeWorkerResources(task: TaskInstance): void {
		if (!this.config.enableResourceTracking) return;

		// Find worker that was executing this task
		const worker = Array.from(this.workers.values()).find((w) => w.currentTasks.has(task.id));

		if (!worker) return;

		for (const [type, amount] of Object.entries(task.resourceAllocations)) {
			const resourceType = type as ResourceType;
			worker.resourceUsage[resourceType] = Math.max(
				0,
				(worker.resourceUsage[resourceType] || 0) - amount
			);
			this.globalResourceUsage[resourceType] = Math.max(
				0,
				(this.globalResourceUsage[resourceType] || 0) - amount
			);
		}
	}

	private calculatePriorityScore(task: TaskInstance): number {
		const priorityWeights: Record<TaskPriority, number> = {
			urgent: 1000,
			high: 750,
			normal: 500,
			low: 250,
			background: 100,
		};

		let score = priorityWeights[task.priority];

		// Age factor - older tasks get higher priority
		const age = Date.now() - task.scheduledAt;
		const ageFactor = Math.min(100, age / 60000); // Max 100 points for 1 minute age
		score += ageFactor;

		// Retry penalty
		score -= task.attempts * 50;

		return score;
	}

	private calculateResourceScore(task: TaskInstance): number {
		if (!this.config.enableResourceTracking) return 0;

		let score = 0;
		let totalRequired = 0;
		let totalAvailable = 0;

		for (const [type, required] of Object.entries(task.resourceAllocations)) {
			const resourceType = type as ResourceType;
			const capacity = this.globalResourceCapacity[resourceType] || 0;
			const used = this.globalResourceUsage[resourceType] || 0;
			const available = capacity - used;

			totalRequired += required;
			totalAvailable += available;

			if (available >= required) {
				score += 10; // Task can be satisfied
			} else {
				score -= 20; // Resource constraint
			}
		}

		// Efficiency bonus for tasks that use resources efficiently
		if (totalRequired > 0 && totalAvailable > 0) {
			const efficiency = Math.min(1, totalAvailable / totalRequired);
			score += efficiency * 10;
		}

		return score;
	}

	private sortTaskQueue(): void {
		this.taskQueue.sort((a, b) => {
			const scoreA = a.priorityScore + a.resourceScore;
			const scoreB = b.priorityScore + b.resourceScore;
			return scoreB - scoreA;
		});
	}

	private areAllDependenciesComplete(taskId: string): boolean {
		const dependencies = this.dependencyGraph.get(taskId);
		if (!dependencies || dependencies.size === 0) {
			return true;
		}

		for (const depId of dependencies) {
			const depTask = this.completedTasks.get(depId);
			if (!depTask || depTask.status !== 'completed') {
				return false;
			}
		}

		return true;
	}

	private updateDependencyGraph(taskId: string, dependencies: string[]): void {
		this.dependencyGraph.set(taskId, new Set(dependencies));
	}

	private validateDependencies(taskId: string, dependencies: string[]): void {
		// Simple cycle detection using DFS
		const visited = new Set<string>();
		const recursionStack = new Set<string>();

		const hasCycle = (nodeId: string): boolean => {
			if (recursionStack.has(nodeId)) {
				return true; // Cycle detected
			}
			if (visited.has(nodeId)) {
				return false;
			}

			visited.add(nodeId);
			recursionStack.add(nodeId);

			const nodeDeps =
				nodeId === taskId
					? dependencies
					: Array.from(this.dependencyGraph.get(nodeId) || []);
			for (const dep of nodeDeps) {
				if (hasCycle(dep)) {
					return true;
				}
			}

			recursionStack.delete(nodeId);
			return false;
		};

		if (hasCycle(taskId)) {
			throw new AppError('Circular dependency detected', ErrorCode.INVALID_INPUT, {
				taskId,
				dependencies,
			});
		}
	}

	private performMaintenance(): void {
		this.updateMetrics();
		this.recordPerformanceHistory();
		this.cleanupCompletedTasks();
	}

	private performPriorityAging(): void {
		if (!this.config.enablePriorityAging) return;

		for (const queuedTask of this.taskQueue) {
			// Increase priority score for waiting tasks
			const waitTime = Date.now() - queuedTask.queuedAt;
			const ageBonus = Math.min(200, waitTime / 30000); // Max 200 points for 30 seconds wait
			queuedTask.priorityScore += ageBonus / 10; // Small incremental increase
		}

		// Re-sort queue after aging
		this.sortTaskQueue();
	}

	private detectAndResolveDeadlocks(): void {
		if (!this.config.enableDeadlockDetection) return;

		// Simple deadlock detection: find circular waits in dependency graph
		const waitingTasks = new Map<string, Set<string>>();

		// Build wait graph
		for (const queuedTask of this.taskQueue) {
			const taskId = queuedTask.task.id;
			const blockedBy = new Set<string>();

			for (const depId of queuedTask.dependencies) {
				const depTask = this.completedTasks.get(depId) || this.runningTasks.get(depId);
				if (!depTask || depTask.status !== 'completed') {
					blockedBy.add(depId);
				}
			}

			if (blockedBy.size > 0) {
				waitingTasks.set(taskId, blockedBy);
			}
		}

		// Detect cycles in wait graph
		const cycles = this.findCyclesInWaitGraph(waitingTasks);

		if (cycles.length > 0) {
			logger.warn('Deadlock detected', { cycles });

			// Resolve by cancelling lowest priority tasks in cycles
			for (const cycle of cycles) {
				const tasksInCycle = cycle
					.map((id) => this.taskQueue.find((qt) => qt.task.id === id)?.task)
					.filter(Boolean);

				if (tasksInCycle.length > 0) {
					// Cancel the lowest priority task
					const lowestPriorityTask = tasksInCycle.reduce((lowest, current) => {
						const priorityOrder = {
							background: 0,
							low: 1,
							normal: 2,
							high: 3,
							urgent: 4,
						};
						return priorityOrder[current!.priority] < priorityOrder[lowest!.priority]
							? current
							: lowest;
					});

					if (lowestPriorityTask) {
						this.cancelTask(lowestPriorityTask.id, 'Deadlock resolution');
					}
				}
			}
		}
	}

	private findCyclesInWaitGraph(waitGraph: Map<string, Set<string>>): string[][] {
		const cycles: string[][] = [];
		const visited = new Set<string>();
		const recursionStack = new Set<string>();
		const path: string[] = [];

		const dfs = (nodeId: string): void => {
			if (recursionStack.has(nodeId)) {
				// Cycle found
				const cycleStart = path.indexOf(nodeId);
				if (cycleStart !== -1) {
					cycles.push(path.slice(cycleStart));
				}
				return;
			}

			if (visited.has(nodeId)) {
				return;
			}

			visited.add(nodeId);
			recursionStack.add(nodeId);
			path.push(nodeId);

			const dependencies = waitGraph.get(nodeId) || new Set();
			for (const dep of dependencies) {
				dfs(dep);
			}

			recursionStack.delete(nodeId);
			path.pop();
		};

		for (const nodeId of waitGraph.keys()) {
			if (!visited.has(nodeId)) {
				dfs(nodeId);
			}
		}

		return cycles;
	}

	private updateMetrics(): void {
		this.metrics.currentQueueSize = this.taskQueue.length;
		this.metrics.activeWorkers = Array.from(this.workers.values()).filter(
			(worker) => !worker.isIdle
		).length;

		// Calculate averages
		const completedTasks = Array.from(this.completedTasks.values());
		if (completedTasks.length > 0) {
			const totalExecutionTime = completedTasks.reduce(
				(sum, task) => sum + (task.duration || 0),
				0
			);
			this.metrics.averageExecutionTime = totalExecutionTime / completedTasks.length;

			const recentTasks = completedTasks.filter(
				(task) => (task.completedAt || 0) > Date.now() - 300000 // Last 5 minutes
			);

			if (recentTasks.length > 0) {
				this.metrics.throughput = recentTasks.length / 300; // Tasks per second
			}
		}

		// Calculate error rate
		const totalTasks = this.metrics.totalTasksCompleted + this.metrics.totalTasksFailed;
		this.metrics.errorRate = totalTasks > 0 ? this.metrics.totalTasksFailed / totalTasks : 0;

		// Update resource utilization
		this.metrics.resourceUtilization = { ...this.globalResourceUsage };
	}

	private recordPerformanceHistory(): void {
		this.performanceHistory.push({
			timestamp: Date.now(),
			metrics: { ...this.metrics },
		});

		// Keep only recent history
		const cutoff = Date.now() - this.config.metricsRetentionPeriod;
		this.performanceHistory = this.performanceHistory.filter(
			(entry) => entry.timestamp > cutoff
		);
	}

	private cleanupCompletedTasks(): void {
		const cutoff = Date.now() - this.config.metricsRetentionPeriod;
		const tasksToRemove: string[] = [];

		for (const [taskId, task] of this.completedTasks.entries()) {
			if ((task.completedAt || 0) < cutoff) {
				tasksToRemove.push(taskId);
			}
		}

		for (const taskId of tasksToRemove) {
			this.completedTasks.delete(taskId);
			this.taskDefinitions.delete(taskId);
			this.dependencyGraph.delete(taskId);
		}
	}

	private initializeResourceCapacity(): void {
		// Initialize with system defaults
		this.globalResourceCapacity = {
			cpu: 100, // 100% CPU
			memory: 1000, // 1000 MB
			io: 100, // 100 IOPS
			network: 100, // 100 Mbps
		};
	}

	private setupPerformanceMonitoring(): void {
		// Monitor memory pressure and adjust scheduling
		globalProfiler.on('memoryPressure', (pressure) => {
			if (pressure.level === 'high' || pressure.level === 'critical') {
				// Reduce queue size temporarily
				const targetSize = Math.floor(this.config.maxQueueSize * 0.5);
				while (this.taskQueue.length > targetSize) {
					const cancelledTask = this.taskQueue.pop();
					if (cancelledTask) {
						this.cancelTask(cancelledTask.task.id, 'Memory pressure');
					}
				}
			}
		});
	}

	private generateTaskId(): string {
		return `task-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
	}
}

// Global scheduler instance
export const globalScheduler = new AdvancedTaskScheduler();
