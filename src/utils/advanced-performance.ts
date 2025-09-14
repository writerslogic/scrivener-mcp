/**
 * Advanced Performance Profiler and Memory Management
 * Enterprise-grade performance monitoring with memory pressure detection,
 * automatic optimization, and predictive resource management
 */

import * as v8 from 'v8';
import { EventEmitter } from 'events';
import { getLogger } from '../core/logger.js';
import { StringUtils } from './shared-patterns.js';

const logger = getLogger('advanced-performance');

export interface PerformanceMetrics {
	timestamp: number;
	operation: string;
	duration: number;
	memoryUsage: NodeJS.MemoryUsage;
	heapSnapshot?: v8.HeapSpaceStatistics[];
	cpuUsage: NodeJS.CpuUsage;
	correlationId?: string;
	metadata?: Record<string, unknown>;
}

export interface MemoryPressureLevel {
	level: 'low' | 'medium' | 'high' | 'critical';
	heapUsedPercent: number;
	heapAvailablePercent: number;
	recommendation: 'continue' | 'throttle' | 'cleanup' | 'emergency_cleanup';
}

export interface ProfilerConfig {
	enableHeapProfiling: boolean;
	enableCpuProfiling: boolean;
	memoryThresholds: {
		medium: number; // 70%
		high: number; // 85%
		critical: number; // 95%
	};
	gcThresholds: {
		frequency: number; // ms between forced GC
		memoryPressure: number; // heap % to trigger GC
	};
	metricsRetention: number; // number of metrics to keep
	aggregationWindow: number; // ms for metric aggregation
}

export interface OperationProfile {
	name: string;
	totalCalls: number;
	totalDuration: number;
	avgDuration: number;
	minDuration: number;
	maxDuration: number;
	p50Duration: number;
	p95Duration: number;
	p99Duration: number;
	errorRate: number;
	throughput: number; // ops per second
	memoryImpact: number; // average memory delta
	lastExecuted: number;
	trending: 'improving' | 'stable' | 'degrading';
}

export interface PredictiveInsights {
	memoryPressureTrend: 'decreasing' | 'stable' | 'increasing';
	nextGcPrediction: number; // timestamp
	operationBottlenecks: string[];
	resourceRecommendations: string[];
	performanceScore: number; // 0-100
}

export class AdvancedPerformanceProfiler extends EventEmitter {
	private config: ProfilerConfig;
	private metrics: PerformanceMetrics[] = [];
	private operationProfiles = new Map<string, OperationProfile>();
	private correlationTracker = new Map<string, PerformanceMetrics[]>();
	private memoryBaseline: NodeJS.MemoryUsage;
	private lastGc: number = Date.now();
	private gcStats: Array<{ timestamp: number; type: string; duration: number }> = [];
	private cpuBaseline: NodeJS.CpuUsage = process.cpuUsage();
	private isProfilingActive = false;
	private cleanupInterval: NodeJS.Timeout | null = null;
	private monitoringInterval: NodeJS.Timeout | null = null;

	constructor(config: Partial<ProfilerConfig> = {}) {
		super();

		this.config = {
			enableHeapProfiling: config.enableHeapProfiling ?? true,
			enableCpuProfiling: config.enableCpuProfiling ?? true,
			memoryThresholds: {
				medium: config.memoryThresholds?.medium ?? 0.7,
				high: config.memoryThresholds?.high ?? 0.85,
				critical: config.memoryThresholds?.critical ?? 0.95,
			},
			gcThresholds: {
				frequency: config.gcThresholds?.frequency ?? 30000,
				memoryPressure: config.gcThresholds?.memoryPressure ?? 0.8,
			},
			metricsRetention: config.metricsRetention ?? 10000,
			aggregationWindow: config.aggregationWindow ?? 60000,
		};

		this.memoryBaseline = process.memoryUsage();
		this.setupGcMonitoring();
		this.startBackgroundMonitoring();
	}

	/**
	 * Start advanced performance profiling
	 */
	async startProfiling(): Promise<void> {
		if (this.isProfilingActive) {
			return;
		}

		this.isProfilingActive = true;
		this.memoryBaseline = process.memoryUsage();
		this.cpuBaseline = process.cpuUsage();

		// Start memory pressure monitoring
		this.monitoringInterval = setInterval(() => {
			this.checkMemoryPressure();
			this.updateOperationProfiles();
			this.performPredictiveAnalysis();
		}, 5000);

		// Start periodic cleanup
		this.cleanupInterval = setInterval(() => {
			this.performMaintenance();
		}, this.config.aggregationWindow);

		logger.info('Advanced performance profiling started', {
			memoryBaseline: StringUtils.formatBytes(this.memoryBaseline.heapUsed),
			config: this.config,
		});
	}

	/**
	 * Stop profiling and cleanup
	 */
	async stopProfiling(): Promise<void> {
		this.isProfilingActive = false;

		if (this.monitoringInterval) {
			clearInterval(this.monitoringInterval);
			this.monitoringInterval = null;
		}

		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
		}

		logger.info('Performance profiling stopped');
	}

	/**
	 * Profile an operation with advanced metrics
	 */
	async profileOperation<T>(
		operationName: string,
		operation: () => Promise<T> | T,
		metadata?: Record<string, unknown>
	): Promise<T> {
		const correlationId = this.generateCorrelationId();
		const startTime = Date.now();
		const startMemory = process.memoryUsage();
		const startCpu = process.cpuUsage();

		let heapSnapshot: v8.HeapSpaceStatistics[] | undefined;
		if (this.config.enableHeapProfiling) {
			heapSnapshot = v8.getHeapSpaceStatistics() as unknown as v8.HeapSpaceStatistics[];
		}

		try {
			const result = await operation();

			const endTime = Date.now();
			const duration = endTime - startTime;
			const endMemory = process.memoryUsage();
			const cpuUsage = process.cpuUsage(startCpu);

			const metric: PerformanceMetrics = {
				timestamp: startTime,
				operation: operationName,
				duration,
				memoryUsage: {
					rss: endMemory.rss - startMemory.rss,
					heapTotal: endMemory.heapTotal - startMemory.heapTotal,
					heapUsed: endMemory.heapUsed - startMemory.heapUsed,
					external: endMemory.external - startMemory.external,
					arrayBuffers: endMemory.arrayBuffers - startMemory.arrayBuffers,
				},
				heapSnapshot,
				cpuUsage,
				correlationId,
				metadata,
			};

			this.recordMetric(metric);
			this.updateOperationProfile(operationName, metric, true);

			// Emit performance events for real-time monitoring
			this.emit('operationComplete', {
				operation: operationName,
				duration,
				success: true,
				memoryDelta: metric.memoryUsage.heapUsed,
			});

			return result;
		} catch (error) {
			const endTime = Date.now();
			const duration = endTime - startTime;
			const endMemory = process.memoryUsage();
			const cpuUsage = process.cpuUsage(startCpu);

			const metric: PerformanceMetrics = {
				timestamp: startTime,
				operation: operationName,
				duration,
				memoryUsage: {
					rss: endMemory.rss - startMemory.rss,
					heapTotal: endMemory.heapTotal - startMemory.heapTotal,
					heapUsed: endMemory.heapUsed - startMemory.heapUsed,
					external: endMemory.external - startMemory.external,
					arrayBuffers: endMemory.arrayBuffers - startMemory.arrayBuffers,
				},
				heapSnapshot,
				cpuUsage,
				correlationId,
				metadata: { ...metadata, error: (error as Error).message },
			};

			this.recordMetric(metric);
			this.updateOperationProfile(operationName, metric, false);

			this.emit('operationError', {
				operation: operationName,
				duration,
				error: (error as Error).message,
				memoryDelta: metric.memoryUsage.heapUsed,
			});

			throw error;
		}
	}

	/**
	 * Get current memory pressure level
	 */
	getMemoryPressure(): MemoryPressureLevel {
		const _memory = process.memoryUsage();
		const heapStats = v8.getHeapStatistics();
		const _totalHeap = heapStats.total_heap_size;
		const usedHeap = heapStats.used_heap_size;
		const availableHeap = heapStats.heap_size_limit - usedHeap;

		const heapUsedPercent = usedHeap / heapStats.heap_size_limit;
		const heapAvailablePercent = availableHeap / heapStats.heap_size_limit;

		let level: MemoryPressureLevel['level'];
		let recommendation: MemoryPressureLevel['recommendation'];

		if (heapUsedPercent >= this.config.memoryThresholds.critical) {
			level = 'critical';
			recommendation = 'emergency_cleanup';
		} else if (heapUsedPercent >= this.config.memoryThresholds.high) {
			level = 'high';
			recommendation = 'cleanup';
		} else if (heapUsedPercent >= this.config.memoryThresholds.medium) {
			level = 'medium';
			recommendation = 'throttle';
		} else {
			level = 'low';
			recommendation = 'continue';
		}

		return {
			level,
			heapUsedPercent,
			heapAvailablePercent,
			recommendation,
		};
	}

	/**
	 * Get comprehensive operation profiles
	 */
	getOperationProfiles(): Map<string, OperationProfile> {
		return new Map(this.operationProfiles);
	}

	/**
	 * Get predictive insights based on collected metrics
	 */
	getPredictiveInsights(): PredictiveInsights {
		const recentMetrics = this.metrics.slice(-100);
		const memoryTrend = this.analyzeMemoryTrend(recentMetrics);
		const bottlenecks = this.identifyBottlenecks();
		const recommendations = this.generateRecommendations();
		const performanceScore = this.calculatePerformanceScore();
		const nextGc = this.predictNextGc();

		return {
			memoryPressureTrend: memoryTrend,
			nextGcPrediction: nextGc,
			operationBottlenecks: bottlenecks,
			resourceRecommendations: recommendations,
			performanceScore,
		};
	}

	/**
	 * Force garbage collection if conditions are met
	 */
	async forceGarbageCollection(reason: string = 'manual'): Promise<boolean> {
		const memoryPressure = this.getMemoryPressure();

		if (memoryPressure.level === 'high' || memoryPressure.level === 'critical') {
			const startTime = Date.now();

			if (global.gc) {
				global.gc();
				const duration = Date.now() - startTime;

				this.gcStats.push({
					timestamp: startTime,
					type: `forced_${reason}`,
					duration,
				});

				// Keep only recent GC stats
				if (this.gcStats.length > 100) {
					this.gcStats = this.gcStats.slice(-50);
				}

				logger.info(`Forced garbage collection completed`, {
					reason,
					duration,
					memoryBefore: memoryPressure.heapUsedPercent,
					memoryAfter: this.getMemoryPressure().heapUsedPercent,
				});

				this.emit('garbageCollectionForced', { reason, duration });
				return true;
			}
		}

		return false;
	}

	/**
	 * Get detailed performance report
	 */
	getPerformanceReport(): {
		summary: {
			totalOperations: number;
			averageResponseTime: number;
			memoryEfficiency: number;
			errorRate: number;
			uptime: number;
		};
		operationProfiles: OperationProfile[];
		memoryAnalysis: {
			current: MemoryPressureLevel;
			trend: string;
			gcFrequency: number;
			recommendations: string[];
		};
		insights: PredictiveInsights;
	} {
		const totalOps = Array.from(this.operationProfiles.values()).reduce(
			(sum, profile) => sum + profile.totalCalls,
			0
		);

		const avgResponseTime =
			Array.from(this.operationProfiles.values()).reduce(
				(sum, profile) => sum + profile.avgDuration,
				0
			) / this.operationProfiles.size;

		const errorRate =
			Array.from(this.operationProfiles.values()).reduce(
				(sum, profile) => sum + profile.errorRate,
				0
			) / this.operationProfiles.size;

		const memoryEfficiency = this.calculateMemoryEfficiency();
		const gcFrequency = this.calculateGcFrequency();

		return {
			summary: {
				totalOperations: totalOps,
				averageResponseTime: avgResponseTime || 0,
				memoryEfficiency,
				errorRate: errorRate || 0,
				uptime: Date.now() - this.memoryBaseline.heapUsed, // approximation
			},
			operationProfiles: Array.from(this.operationProfiles.values()),
			memoryAnalysis: {
				current: this.getMemoryPressure(),
				trend: this.analyzeMemoryTrend(this.metrics.slice(-50)),
				gcFrequency,
				recommendations: this.generateRecommendations(),
			},
			insights: this.getPredictiveInsights(),
		};
	}

	// Private methods

	private recordMetric(metric: PerformanceMetrics): void {
		this.metrics.push(metric);

		// Maintain metrics retention limit
		if (this.metrics.length > this.config.metricsRetention) {
			this.metrics = this.metrics.slice(-Math.floor(this.config.metricsRetention * 0.8));
		}

		// Track by correlation ID
		if (metric.correlationId) {
			if (!this.correlationTracker.has(metric.correlationId)) {
				this.correlationTracker.set(metric.correlationId, []);
			}
			this.correlationTracker.get(metric.correlationId)!.push(metric);
		}
	}

	private updateOperationProfile(
		operationName: string,
		metric: PerformanceMetrics,
		success: boolean
	): void {
		let profile = this.operationProfiles.get(operationName);

		if (!profile) {
			profile = {
				name: operationName,
				totalCalls: 0,
				totalDuration: 0,
				avgDuration: 0,
				minDuration: Infinity,
				maxDuration: 0,
				p50Duration: 0,
				p95Duration: 0,
				p99Duration: 0,
				errorRate: 0,
				throughput: 0,
				memoryImpact: 0,
				lastExecuted: 0,
				trending: 'stable',
			};
		}

		profile.totalCalls += 1;
		profile.totalDuration += metric.duration;
		profile.avgDuration = profile.totalDuration / profile.totalCalls;
		profile.minDuration = Math.min(profile.minDuration, metric.duration);
		profile.maxDuration = Math.max(profile.maxDuration, metric.duration);
		profile.lastExecuted = metric.timestamp;
		profile.memoryImpact = (profile.memoryImpact + metric.memoryUsage.heapUsed) / 2;

		if (!success) {
			const errorCount = profile.totalCalls * profile.errorRate + 1;
			profile.errorRate = errorCount / profile.totalCalls;
		}

		// Calculate percentiles from recent calls
		const recentDurations = this.metrics
			.filter((m) => m.operation === operationName)
			.slice(-100)
			.map((m) => m.duration)
			.sort((a, b) => a - b);

		if (recentDurations.length > 0) {
			profile.p50Duration = this.getPercentile(recentDurations, 0.5);
			profile.p95Duration = this.getPercentile(recentDurations, 0.95);
			profile.p99Duration = this.getPercentile(recentDurations, 0.99);
		}

		// Calculate throughput (ops per second in last minute)
		const oneMinuteAgo = Date.now() - 60000;
		const recentOps = this.metrics.filter(
			(m) => m.operation === operationName && m.timestamp > oneMinuteAgo
		).length;
		profile.throughput = recentOps / 60;

		this.operationProfiles.set(operationName, profile);
	}

	private updateOperationProfiles(): void {
		// Update trending analysis for all operations
		for (const [operationName, profile] of this.operationProfiles.entries()) {
			const recentMetrics = this.metrics
				.filter((m) => m.operation === operationName)
				.slice(-20);

			if (recentMetrics.length >= 10) {
				const firstHalf = recentMetrics.slice(0, 10);
				const secondHalf = recentMetrics.slice(10);

				const firstAvg =
					firstHalf.reduce((sum, m) => sum + m.duration, 0) / firstHalf.length;
				const secondAvg =
					secondHalf.reduce((sum, m) => sum + m.duration, 0) / secondHalf.length;

				const change = (secondAvg - firstAvg) / firstAvg;

				if (change < -0.1) {
					profile.trending = 'improving';
				} else if (change > 0.1) {
					profile.trending = 'degrading';
				} else {
					profile.trending = 'stable';
				}
			}
		}
	}

	private checkMemoryPressure(): void {
		const pressure = this.getMemoryPressure();

		if (pressure.level !== 'low') {
			this.emit('memoryPressure', pressure);

			if (pressure.recommendation === 'emergency_cleanup') {
				logger.warn('Critical memory pressure detected', { pressure });
				this.performEmergencyCleanup();
			} else if (pressure.recommendation === 'cleanup') {
				logger.warn('High memory pressure detected', { pressure });
				this.forceGarbageCollection('memory_pressure');
			}
		}
	}

	private performMaintenance(): void {
		// Clean old correlation tracking
		const cutoff = Date.now() - this.config.aggregationWindow * 2;
		for (const [id, metrics] of this.correlationTracker.entries()) {
			if (metrics[metrics.length - 1]?.timestamp < cutoff) {
				this.correlationTracker.delete(id);
			}
		}

		// Trim old metrics
		const retentionCutoff = Date.now() - this.config.aggregationWindow * 10;
		this.metrics = this.metrics.filter((m) => m.timestamp > retentionCutoff);

		// Update operation profiles
		this.updateOperationProfiles();
	}

	private performEmergencyCleanup(): void {
		// Clear old metrics aggressively
		this.metrics = this.metrics.slice(-100);

		// Clear correlation tracking
		this.correlationTracker.clear();

		// Force GC
		this.forceGarbageCollection('emergency');

		logger.warn('Emergency cleanup performed');
	}

	private setupGcMonitoring(): void {
		// Monitor garbage collection events
		if (process.env.NODE_ENV === 'development' && global.gc) {
			const originalGc = global.gc;
			global.gc = (() => {
				const startTime = Date.now();
				originalGc();
				const duration = Date.now() - startTime;

				this.gcStats.push({
					timestamp: startTime,
					type: 'manual',
					duration,
				});
			}) as typeof global.gc;
		}
	}

	private startBackgroundMonitoring(): void {
		// Additional background monitoring can be added here
	}

	private generateCorrelationId(): string {
		return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
	}

	private getPercentile(sortedArray: number[], percentile: number): number {
		const index = Math.floor(sortedArray.length * percentile);
		return sortedArray[index] || 0;
	}

	private analyzeMemoryTrend(
		metrics: PerformanceMetrics[]
	): 'decreasing' | 'stable' | 'increasing' {
		if (metrics.length < 10) return 'stable';

		const memoryUsages = metrics.map((_m) => process.memoryUsage().heapUsed);
		const firstHalf = memoryUsages.slice(0, Math.floor(memoryUsages.length / 2));
		const secondHalf = memoryUsages.slice(Math.floor(memoryUsages.length / 2));

		const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
		const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

		const change = (secondAvg - firstAvg) / firstAvg;

		if (change > 0.05) return 'increasing';
		if (change < -0.05) return 'decreasing';
		return 'stable';
	}

	private identifyBottlenecks(): string[] {
		const bottlenecks: string[] = [];

		for (const profile of this.operationProfiles.values()) {
			if (profile.avgDuration > 1000) {
				bottlenecks.push(
					`${profile.name}: high latency (${Math.round(profile.avgDuration)}ms)`
				);
			}
			if (profile.errorRate > 0.05) {
				bottlenecks.push(
					`${profile.name}: high error rate (${(profile.errorRate * 100).toFixed(1)}%)`
				);
			}
			if (profile.trending === 'degrading') {
				bottlenecks.push(`${profile.name}: performance degrading`);
			}
		}

		return bottlenecks;
	}

	private generateRecommendations(): string[] {
		const recommendations: string[] = [];
		const pressure = this.getMemoryPressure();

		if (pressure.level === 'high' || pressure.level === 'critical') {
			recommendations.push(
				'Consider implementing object pooling for frequently allocated objects'
			);
			recommendations.push('Review memory usage patterns and implement caching strategies');
		}

		const slowOperations = Array.from(this.operationProfiles.values()).filter(
			(p) => p.avgDuration > 1000
		);

		if (slowOperations.length > 0) {
			recommendations.push(
				`Optimize slow operations: ${slowOperations.map((p) => p.name).join(', ')}`
			);
		}

		const highErrorRateOps = Array.from(this.operationProfiles.values()).filter(
			(p) => p.errorRate > 0.05
		);

		if (highErrorRateOps.length > 0) {
			recommendations.push(
				`Improve error handling for: ${highErrorRateOps.map((p) => p.name).join(', ')}`
			);
		}

		return recommendations;
	}

	private calculatePerformanceScore(): number {
		const memoryPressure = this.getMemoryPressure();
		const avgLatency =
			Array.from(this.operationProfiles.values()).reduce((sum, p) => sum + p.avgDuration, 0) /
				this.operationProfiles.size || 0;
		const avgErrorRate =
			Array.from(this.operationProfiles.values()).reduce((sum, p) => sum + p.errorRate, 0) /
				this.operationProfiles.size || 0;

		let score = 100;

		// Memory pressure penalty
		if (memoryPressure.level === 'critical') score -= 40;
		else if (memoryPressure.level === 'high') score -= 25;
		else if (memoryPressure.level === 'medium') score -= 10;

		// Latency penalty
		if (avgLatency > 2000) score -= 30;
		else if (avgLatency > 1000) score -= 15;
		else if (avgLatency > 500) score -= 5;

		// Error rate penalty
		score -= avgErrorRate * 100;

		return Math.max(0, Math.min(100, score));
	}

	private predictNextGc(): number {
		if (this.gcStats.length < 3) {
			return Date.now() + 30000; // Default 30 seconds
		}

		const intervals = [];
		for (let i = 1; i < this.gcStats.length; i++) {
			intervals.push(this.gcStats[i].timestamp - this.gcStats[i - 1].timestamp);
		}

		const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
		return this.gcStats[this.gcStats.length - 1].timestamp + avgInterval;
	}

	private calculateMemoryEfficiency(): number {
		const current = process.memoryUsage();
		const heapEfficiency = (current.heapUsed / current.heapTotal) * 100;
		return Math.min(100, heapEfficiency);
	}

	private calculateGcFrequency(): number {
		if (this.gcStats.length < 2) return 0;

		const timespan =
			this.gcStats[this.gcStats.length - 1].timestamp - this.gcStats[0].timestamp;
		const frequency = (this.gcStats.length - 1) / (timespan / 60000); // GCs per minute

		return frequency;
	}

	private performPredictiveAnalysis(): void {
		try {
			// Predict potential memory pressure
			const memoryPressure = this.getMemoryPressure();
			const _currentMemory = process.memoryUsage();

			// Predict when next GC might occur
			const nextGcTime = this.predictNextGc();
			const timeToGc = nextGcTime - Date.now();

			// Analyze trends and predict issues
			const degradingOps = Array.from(this.operationProfiles.values()).filter(
				(profile) => profile.trending === 'degrading'
			);

			if (degradingOps.length > 0) {
				logger.warn('Performance degradation detected in operations', {
					operations: degradingOps.map((op) => op.name),
				});
			}

			// Predict memory exhaustion
			if (memoryPressure.level === 'high' && timeToGc > 30000) {
				logger.warn('Memory pressure detected with delayed GC', {
					memoryLevel: memoryPressure.level,
					timeToGc: Math.round(timeToGc / 1000),
				});
			}

			// Log predictive insights
			this.emit('predictive-analysis', {
				memoryPressure: memoryPressure.level,
				nextGcIn: Math.round(timeToGc / 1000),
				degradingOperations: degradingOps.length,
				performanceScore: this.calculatePerformanceScore(),
			});
		} catch (error) {
			logger.error('Predictive analysis failed', { error: (error as Error).message });
		}
	}
}

// Global singleton instance for convenience
export const globalProfiler = new AdvancedPerformanceProfiler();
