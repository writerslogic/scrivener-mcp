/**
 * Enterprise-grade Observability Infrastructure
 * Comprehensive telemetry, metrics, tracing, and alerting
 */

import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';

export interface MetricValue {
	value: number;
	timestamp: number;
	tags?: Record<string, string>;
	unit?: string;
}

export interface TraceSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	operationName: string;
	startTime: number;
	endTime?: number;
	duration?: number;
	tags: Record<string, unknown>;
	status: 'ok' | 'error' | 'timeout';
	error?: Error;
	logs: LogEntry[];
}

export interface LogEntry {
	timestamp: number;
	level: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
	message: string;
	metadata?: Record<string, unknown>;
	correlationId?: string;
	spanId?: string;
	source: string;
}

export interface AlertRule {
	id: string;
	name: string;
	description: string;
	query: string;
	threshold: number;
	operator: '>' | '<' | '>=' | '<=' | '==' | '!=';
	severity: 'low' | 'medium' | 'high' | 'critical';
	enabled: boolean;
	cooldownPeriod: number;
	lastTriggered?: number;
	actions: AlertAction[];
}

export interface AlertAction {
	type: 'log' | 'email' | 'webhook' | 'auto-remediate';
	config: Record<string, unknown>;
}

export interface Alert {
	id: string;
	ruleId: string;
	severity: 'low' | 'medium' | 'high' | 'critical';
	message: string;
	triggeredAt: number;
	resolvedAt?: number;
	status: 'active' | 'resolved' | 'acknowledged';
	metadata: Record<string, unknown>;
}

export interface DashboardWidget {
	id: string;
	type: 'metric' | 'chart' | 'table' | 'gauge' | 'heatmap';
	title: string;
	query: string;
	position: { x: number; y: number; width: number; height: number };
	config: Record<string, unknown>;
}

export interface Dashboard {
	id: string;
	name: string;
	description: string;
	widgets: DashboardWidget[];
	tags: string[];
	isPublic: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface ObservabilityConfig {
	metrics: {
		enabled: boolean;
		retentionDays: number;
		aggregationIntervals: number[];
		exportEnabled: boolean;
		exportFormat: 'prometheus' | 'json' | 'csv';
	};
	tracing: {
		enabled: boolean;
		samplingRate: number;
		maxSpansPerTrace: number;
		retentionDays: number;
	};
	logging: {
		level: 'debug' | 'info' | 'warn' | 'error';
		structured: boolean;
		async: boolean;
		bufferSize: number;
		flushInterval: number;
	};
	alerting: {
		enabled: boolean;
		evaluationInterval: number;
		maxConcurrentAlerts: number;
	};
	storage: {
		type: 'memory' | 'file' | 'database';
		path?: string;
		maxSizeGB: number;
		compressionEnabled: boolean;
	};
}

interface MetricSeries {
	name: string;
	points: MetricValue[];
	aggregated?: {
		interval: number;
		values: Array<{
			timestamp: number;
			min: number;
			max: number;
			avg: number;
			count: number;
			sum: number;
		}>;
	};
}

interface TraceData {
	traceId: string;
	spans: Map<string, TraceSpan>;
	rootSpan?: TraceSpan;
	duration?: number;
	status: 'ok' | 'error' | 'timeout';
	tags: Record<string, unknown>;
}

export class ObservabilityInfrastructure extends EventEmitter {
	private config: ObservabilityConfig;
	private metrics = new Map<string, MetricSeries>();
	private traces = new Map<string, TraceData>();
	private activeSpans = new Map<string, TraceSpan>();
	private logs: LogEntry[] = [];
	private alertRules = new Map<string, AlertRule>();
	private activeAlerts = new Map<string, Alert>();
	private dashboards = new Map<string, Dashboard>();

	private metricsBuffer: MetricValue[] = [];
	private logsBuffer: LogEntry[] = [];
	private isShuttingDown = false;
	private flushTimer?: NodeJS.Timeout;
	private cleanupTimer?: NodeJS.Timeout;
	private alertEvaluationTimer?: NodeJS.Timeout;

	constructor(config: Partial<ObservabilityConfig> = {}) {
		super();

		this.config = {
			metrics: {
				enabled: true,
				retentionDays: 30,
				aggregationIntervals: [60, 300, 3600, 86400], // 1min, 5min, 1hr, 1day
				exportEnabled: false,
				exportFormat: 'json',
				...config.metrics,
			},
			tracing: {
				enabled: true,
				samplingRate: 0.1, // 10% sampling
				maxSpansPerTrace: 1000,
				retentionDays: 7,
				...config.tracing,
			},
			logging: {
				level: 'info',
				structured: true,
				async: true,
				bufferSize: 1000,
				flushInterval: 5000,
				...config.logging,
			},
			alerting: {
				enabled: true,
				evaluationInterval: 30000, // 30 seconds
				maxConcurrentAlerts: 100,
				...config.alerting,
			},
			storage: {
				type: 'memory',
				maxSizeGB: 1,
				compressionEnabled: true,
				...config.storage,
			},
		};

		this.setupPeriodicTasks();
		this.setupGracefulShutdown();
	}

	// Metrics Collection
	recordMetric(name: string, value: number, tags?: Record<string, string>, unit?: string): void {
		if (!this.config.metrics.enabled) return;

		const metric: MetricValue = {
			value,
			timestamp: Date.now(),
			tags,
			unit,
		};

		if (this.config.logging.async) {
			this.metricsBuffer.push(metric);
		} else {
			this.processMetric(name, metric);
		}

		this.emit('metric', { name, metric });
	}

	private processMetric(name: string, metric: MetricValue): void {
		let series = this.metrics.get(name);
		if (!series) {
			series = { name, points: [] };
			this.metrics.set(name, series);
		}

		series.points.push(metric);
		this.aggregateMetrics(series);
		this.enforceRetention(series);
	}

	private aggregateMetrics(series: MetricSeries): void {
		for (const interval of this.config.metrics.aggregationIntervals) {
			const intervalMs = interval * 1000;
			const now = Date.now();
			const windowStart = Math.floor(now / intervalMs) * intervalMs;

			const windowPoints = series.points.filter(
				(p) => p.timestamp >= windowStart && p.timestamp < windowStart + intervalMs
			);

			if (windowPoints.length === 0) continue;

			const values = windowPoints.map((p) => p.value);
			const aggregation = {
				timestamp: windowStart,
				min: Math.min(...values),
				max: Math.max(...values),
				avg: values.reduce((a, b) => a + b, 0) / values.length,
				count: values.length,
				sum: values.reduce((a, b) => a + b, 0),
			};

			if (!series.aggregated) {
				series.aggregated = { interval, values: [] };
			}

			// Update or add aggregation
			const existing = series.aggregated.values.findIndex((v) => v.timestamp === windowStart);
			if (existing >= 0) {
				series.aggregated.values[existing] = aggregation;
			} else {
				series.aggregated.values.push(aggregation);
			}
		}
	}

	// Distributed Tracing
	startTrace(operationName: string, tags?: Record<string, unknown>): string {
		if (!this.config.tracing.enabled) return '';

		if (Math.random() > this.config.tracing.samplingRate) {
			return ''; // Not sampled
		}

		const traceId = this.generateId();
		const spanId = this.generateId();

		const span: TraceSpan = {
			traceId,
			spanId,
			operationName,
			startTime: performance.now(),
			tags: tags || {},
			status: 'ok',
			logs: [],
		};

		this.activeSpans.set(spanId, span);

		let trace = this.traces.get(traceId);
		if (!trace) {
			trace = {
				traceId,
				spans: new Map(),
				status: 'ok',
				tags: {},
			};
			this.traces.set(traceId, trace);
		}

		trace.spans.set(spanId, span);
		if (!trace.rootSpan) {
			trace.rootSpan = span;
		}

		this.emit('trace-started', { traceId, spanId, operationName });
		return spanId;
	}

	finishSpan(spanId: string, status: 'ok' | 'error' | 'timeout' = 'ok', error?: Error): void {
		const span = this.activeSpans.get(spanId);
		if (!span) return;

		span.endTime = performance.now();
		span.duration = span.endTime - span.startTime;
		span.status = status;
		if (error) span.error = error;

		this.activeSpans.delete(spanId);

		const trace = this.traces.get(span.traceId);
		if (trace) {
			trace.spans.set(spanId, span);

			// Update trace status
			if (status === 'error') trace.status = 'error';

			// Calculate total duration if this was the root span
			if (trace.rootSpan?.spanId === spanId) {
				trace.duration = span.duration;
			}
		}

		this.emit('span-finished', {
			spanId,
			traceId: span.traceId,
			duration: span.duration,
			status,
		});
	}

	addSpanLog(
		spanId: string,
		level: LogEntry['level'],
		message: string,
		metadata?: Record<string, unknown>
	): void {
		const span = this.activeSpans.get(spanId);
		if (!span) return;

		span.logs.push({
			timestamp: Date.now(),
			level,
			message,
			metadata,
			spanId,
			source: 'span',
		});
	}

	// Structured Logging
	log(
		level: LogEntry['level'],
		message: string,
		metadata?: Record<string, unknown>,
		correlationId?: string
	): void {
		if (this.getLevelPriority(level) < this.getLevelPriority(this.config.logging.level)) {
			return;
		}

		const entry: LogEntry = {
			timestamp: Date.now(),
			level,
			message,
			metadata,
			correlationId,
			source: 'application',
		};

		if (this.config.logging.async) {
			this.logsBuffer.push(entry);
		} else {
			this.processLog(entry);
		}

		this.emit('log', entry);
	}

	private processLog(entry: LogEntry): void {
		this.logs.push(entry);
		this.enforceLogRetention();
	}

	private getLevelPriority(level: LogEntry['level']): number {
		const priorities = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 };
		return priorities[level] || 0;
	}

	// Alert Management
	addAlertRule(rule: Omit<AlertRule, 'id'>): string {
		const id = this.generateId();
		const alertRule: AlertRule = { ...rule, id };
		this.alertRules.set(id, alertRule);
		this.emit('alert-rule-added', alertRule);
		return id;
	}

	removeAlertRule(id: string): boolean {
		const removed = this.alertRules.delete(id);
		if (removed) {
			this.emit('alert-rule-removed', { id });
		}
		return removed;
	}

	private evaluateAlerts(): void {
		if (!this.config.alerting.enabled) return;

		for (const rule of this.alertRules.values()) {
			if (!rule.enabled) continue;

			// Check cooldown
			if (rule.lastTriggered && Date.now() - rule.lastTriggered < rule.cooldownPeriod) {
				continue;
			}

			try {
				const result = this.executeQuery(rule.query);
				const triggered = this.evaluateCondition(result, rule.threshold, rule.operator);

				if (triggered) {
					this.triggerAlert(rule, result);
				}
			} catch (error) {
				this.log('error', `Failed to evaluate alert rule ${rule.id}`, {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	private evaluateCondition(
		value: number,
		threshold: number,
		operator: AlertRule['operator']
	): boolean {
		switch (operator) {
			case '>':
				return value > threshold;
			case '<':
				return value < threshold;
			case '>=':
				return value >= threshold;
			case '<=':
				return value <= threshold;
			case '==':
				return value === threshold;
			case '!=':
				return value !== threshold;
			default:
				return false;
		}
	}

	private triggerAlert(rule: AlertRule, value: number): void {
		if (this.activeAlerts.size >= this.config.alerting.maxConcurrentAlerts) {
			this.log('warn', 'Maximum concurrent alerts reached, skipping new alert');
			return;
		}

		const alert: Alert = {
			id: this.generateId(),
			ruleId: rule.id,
			severity: rule.severity,
			message: `${rule.name}: ${rule.description} (value: ${value}, threshold: ${rule.threshold})`,
			triggeredAt: Date.now(),
			status: 'active',
			metadata: { value, threshold: rule.threshold, operator: rule.operator },
		};

		this.activeAlerts.set(alert.id, alert);
		rule.lastTriggered = Date.now();

		// Execute alert actions
		for (const action of rule.actions) {
			this.executeAlertAction(action, alert);
		}

		this.emit('alert-triggered', alert);
	}

	private executeAlertAction(action: AlertAction, alert: Alert): void {
		switch (action.type) {
			case 'log':
				this.log('error', `ALERT: ${alert.message}`, {
					alertId: alert.id,
					severity: alert.severity,
				});
				break;
			case 'auto-remediate':
				this.emit('auto-remediate', { alert, config: action.config });
				break;
			// Email and webhook actions would be implemented based on specific requirements
		}
	}

	// Query Engine (simplified implementation)
	private executeQuery(query: string): number {
		// This is a simplified query engine. In a real implementation,
		// you'd have a more sophisticated query language and parser.

		if (query.startsWith('metric:')) {
			const metricName = query.substring(7);
			const series = this.metrics.get(metricName);
			if (!series || series.points.length === 0) return 0;

			const recent = series.points.slice(-10);
			return recent.reduce((sum, p) => sum + p.value, 0) / recent.length;
		}

		if (query.startsWith('trace_errors:')) {
			const recentTraces = Array.from(this.traces.values()).filter(
				(t) => Date.now() - (t.rootSpan?.startTime || 0) < 300000
			); // 5 minutes
			return recentTraces.filter((t) => t.status === 'error').length;
		}

		return 0;
	}

	// Dashboard Management
	createDashboard(dashboard: Omit<Dashboard, 'id' | 'createdAt' | 'updatedAt'>): string {
		const id = this.generateId();
		const newDashboard: Dashboard = {
			...dashboard,
			id,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};

		this.dashboards.set(id, newDashboard);
		this.emit('dashboard-created', newDashboard);
		return id;
	}

	updateDashboard(id: string, updates: Partial<Dashboard>): boolean {
		const dashboard = this.dashboards.get(id);
		if (!dashboard) return false;

		Object.assign(dashboard, updates, { updatedAt: Date.now() });
		this.emit('dashboard-updated', dashboard);
		return true;
	}

	// Data Export
	async exportMetrics(format: 'json' | 'csv' | 'prometheus' = 'json'): Promise<string> {
		const data = Array.from(this.metrics.entries()).map(([name, series]) => ({
			name,
			points: series.points,
			aggregated: series.aggregated,
		}));

		switch (format) {
			case 'json':
				return JSON.stringify(data, null, 2);
			case 'csv':
				return this.convertToCsv(data);
			case 'prometheus':
				return this.convertToPrometheus(data);
			default:
				throw new Error(`Unsupported export format: ${format}`);
		}
	}

	private convertToCsv(data: Array<{ name: string; points: MetricValue[] }>): string {
		const headers = ['metric_name', 'timestamp', 'value', 'tags', 'unit'];
		const rows = [headers.join(',')];

		for (const metric of data) {
			for (const point of metric.points) {
				const row = [
					metric.name,
					point.timestamp.toString(),
					point.value.toString(),
					JSON.stringify(point.tags || {}),
					point.unit || '',
				];
				rows.push(row.join(','));
			}
		}

		return rows.join('\n');
	}

	private convertToPrometheus(data: Array<{ name: string; points: MetricValue[] }>): string {
		const lines: string[] = [];

		for (const metric of data) {
			const latest = metric.points[metric.points.length - 1];
			if (!latest) continue;

			let tags = '';
			if (latest.tags && Object.keys(latest.tags).length > 0) {
				const tagPairs = Object.entries(latest.tags).map(([k, v]) => `${k}="${v}"`);
				tags = `{${tagPairs.join(',')}}`;
			}

			lines.push(`${metric.name}${tags} ${latest.value} ${latest.timestamp}`);
		}

		return lines.join('\n');
	}

	// Maintenance and Cleanup
	private setupPeriodicTasks(): void {
		// Flush buffers periodically
		this.flushTimer = setInterval(() => {
			this.flushBuffers();
		}, this.config.logging.flushInterval);

		// Clean up old data
		this.cleanupTimer = setInterval(() => {
			this.performCleanup();
		}, 300000); // 5 minutes

		// Evaluate alerts
		if (this.config.alerting.enabled) {
			this.alertEvaluationTimer = setInterval(() => {
				this.evaluateAlerts();
			}, this.config.alerting.evaluationInterval);
		}
	}

	private flushBuffers(): void {
		// Process buffered metrics
		for (const _metric of this.metricsBuffer) {
			// Find the metric name from the buffer context (simplified)
			// In real implementation, you'd store the name with the metric
		}
		this.metricsBuffer.length = 0;

		// Process buffered logs
		for (const log of this.logsBuffer) {
			this.processLog(log);
		}
		this.logsBuffer.length = 0;
	}

	private performCleanup(): void {
		const now = Date.now();

		// Clean up old metrics
		for (const [name, series] of this.metrics) {
			const cutoff = now - this.config.metrics.retentionDays * 24 * 60 * 60 * 1000;
			series.points = series.points.filter((p) => p.timestamp > cutoff);

			if (series.points.length === 0) {
				this.metrics.delete(name);
			}
		}

		// Clean up old traces
		const traceCutoff = now - this.config.tracing.retentionDays * 24 * 60 * 60 * 1000;
		for (const [id, trace] of this.traces) {
			if ((trace.rootSpan?.startTime || 0) < traceCutoff) {
				this.traces.delete(id);
			}
		}

		// Clean up old logs
		this.enforceLogRetention();
	}

	private enforceLogRetention(): void {
		const maxLogs = 100000; // Keep last 100k logs
		if (this.logs.length > maxLogs) {
			this.logs = this.logs.slice(-maxLogs);
		}
	}

	private enforceRetention(series: MetricSeries): void {
		const maxPoints = 100000; // Keep last 100k points per series
		if (series.points.length > maxPoints) {
			series.points = series.points.slice(-maxPoints);
		}
	}

	private setupGracefulShutdown(): void {
		process.on('SIGTERM', () => this.shutdown());
		process.on('SIGINT', () => this.shutdown());
	}

	async shutdown(): Promise<void> {
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;

		this.log('info', 'Shutting down observability infrastructure');

		// Clear timers
		if (this.flushTimer) clearInterval(this.flushTimer);
		if (this.cleanupTimer) clearInterval(this.cleanupTimer);
		if (this.alertEvaluationTimer) clearInterval(this.alertEvaluationTimer);

		// Final flush
		this.flushBuffers();

		// Finish active spans
		for (const [spanId, _span] of this.activeSpans) {
			this.finishSpan(spanId, 'timeout');
		}

		this.emit('shutdown');
	}

	private generateId(): string {
		return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
	}

	// Public API for querying data
	getMetrics(name?: string): MetricSeries[] {
		if (name) {
			const series = this.metrics.get(name);
			return series ? [series] : [];
		}
		return Array.from(this.metrics.values());
	}

	getTraces(limit = 100): TraceData[] {
		return Array.from(this.traces.values()).slice(-limit);
	}

	getLogs(limit = 1000, level?: LogEntry['level']): LogEntry[] {
		let filtered = this.logs;
		if (level) {
			const minPriority = this.getLevelPriority(level);
			filtered = this.logs.filter((log) => this.getLevelPriority(log.level) >= minPriority);
		}
		return filtered.slice(-limit);
	}

	getActiveAlerts(): Alert[] {
		return Array.from(this.activeAlerts.values());
	}

	getDashboards(): Dashboard[] {
		return Array.from(this.dashboards.values());
	}

	getHealthStatus(): {
		status: 'healthy' | 'degraded' | 'unhealthy';
		checks: Record<string, { status: 'ok' | 'warn' | 'error'; message: string }>;
	} {
		const checks: Record<string, { status: 'ok' | 'warn' | 'error'; message: string }> = {};

		// Check memory usage
		const memUsage = process.memoryUsage();
		const memUsageMB = memUsage.heapUsed / 1024 / 1024;
		checks.memory =
			memUsageMB > 512
				? { status: 'warn', message: `High memory usage: ${memUsageMB.toFixed(1)}MB` }
				: { status: 'ok', message: `Memory usage: ${memUsageMB.toFixed(1)}MB` };

		// Check active alerts
		const criticalAlerts = Array.from(this.activeAlerts.values()).filter(
			(a) => a.severity === 'critical'
		).length;
		checks.alerts =
			criticalAlerts > 0
				? { status: 'error', message: `${criticalAlerts} critical alerts active` }
				: { status: 'ok', message: 'No critical alerts' };

		// Check data sizes
		const totalMetrics = Array.from(this.metrics.values()).reduce(
			(sum, s) => sum + s.points.length,
			0
		);
		checks.data =
			totalMetrics > 1000000
				? { status: 'warn', message: `Large metric dataset: ${totalMetrics} points` }
				: { status: 'ok', message: `Metric points: ${totalMetrics}` };

		const hasErrors = Object.values(checks).some((c) => c.status === 'error');
		const hasWarnings = Object.values(checks).some((c) => c.status === 'warn');

		const status = hasErrors ? 'unhealthy' : hasWarnings ? 'degraded' : 'healthy';

		return { status, checks };
	}
}
