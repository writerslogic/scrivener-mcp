/**
 * Enterprise Observability Layer - Distributed tracing, metrics, and monitoring
 * Production-ready observability with OpenTelemetry-compatible tracing
 */

import { EventEmitter } from 'events';
import { getLogger } from '../../core/logger.js';
import { generateHash, getEnv } from '../../utils/common.js';

const logger = getLogger('observability');

// Advanced Tracing Interfaces
export interface Span {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	operationName: string;
	startTime: number;
	endTime?: number;
	duration?: number;
	tags: Record<string, string | number | boolean | undefined>;
	logs: Array<{ timestamp: number; fields: Record<string, unknown> }>;
	baggage: Record<string, string>;
	status: 'ok' | 'error' | 'timeout';
}

export interface TraceContext {
	traceId: string;
	spanId: string;
	baggage: Record<string, string>;
}

export interface MetricPoint {
	name: string;
	value: number;
	timestamp: number;
	labels: Record<string, string>;
	type: 'counter' | 'gauge' | 'histogram' | 'summary';
}

export interface Alert {
	id: string;
	severity: 'low' | 'medium' | 'high' | 'critical';
	title: string;
	description: string;
	timestamp: number;
	tags: Record<string, string>;
	resolved: boolean;
}

// Distributed Tracer Implementation
export class DistributedTracer extends EventEmitter {
	private activeSpans = new Map<string, Span>();
	private completedSpans: Span[] = [];
	private samplingRate: number;
	private maxSpansInMemory: number;

	constructor(options: {
		serviceName: string;
		samplingRate?: number;
		maxSpansInMemory?: number;
	}) {
		super();
		this.samplingRate = options.samplingRate || 0.1;
		this.maxSpansInMemory = options.maxSpansInMemory || 10000;
	}

	createSpan(
		operationName: string,
		parentContext?: TraceContext,
		tags: Record<string, unknown> = {}
	): Span {
		// Sampling decision
		if (Math.random() > this.samplingRate && !parentContext) {
			// Return a no-op span for unsampled traces
			return this.createNoOpSpan(operationName);
		}

		const span: Span = {
			traceId: parentContext?.traceId || this.generateTraceId(),
			spanId: this.generateSpanId(),
			parentSpanId: parentContext?.spanId,
			operationName,
			startTime: Date.now(),
			tags: {
				'service.name': 'scrivener-mcp',
				'service.version': getEnv('SERVICE_VERSION', '1.0.0'),
				...tags,
			},
			logs: [],
			baggage: { ...parentContext?.baggage },
			status: 'ok',
		};

		this.activeSpans.set(span.spanId, span);
		this.emit('span-started', span);

		return span;
	}

	finishSpan(span: Span, tags: Record<string, unknown> = {}): void {
		if (!span.endTime) {
			span.endTime = Date.now();
			span.duration = span.endTime - span.startTime;
		}

		// Add final tags
		Object.assign(span.tags, tags);

		this.activeSpans.delete(span.spanId);
		this.completedSpans.push(span);

		// Limit memory usage
		if (this.completedSpans.length > this.maxSpansInMemory) {
			this.completedSpans = this.completedSpans.slice(-this.maxSpansInMemory / 2);
		}

		this.emit('span-finished', span);
	}

	addSpanLog(span: Span, fields: Record<string, unknown>): void {
		span.logs.push({
			timestamp: Date.now(),
			fields,
		});
	}

	setSpanTag(span: Span, key: string, value: unknown): void {
		// Only assign if value is string, number, boolean, or undefined
		if (
			typeof value === 'string' ||
			typeof value === 'number' ||
			typeof value === 'boolean' ||
			typeof value === 'undefined'
		) {
			span.tags[key] = value;
		} else {
			span.tags[key] = String(value);
		}
	}

	setSpanStatus(span: Span, status: 'ok' | 'error' | 'timeout', error?: Error): void {
		span.status = status;
		if (error) {
			span.tags['error'] = true;
			span.tags['error.message'] = error.message;
			span.tags['error.stack'] = error.stack;
		}
	}

	private createNoOpSpan(operationName: string): Span {
		return {
			traceId: '',
			spanId: '',
			operationName,
			startTime: Date.now(),
			tags: {},
			logs: [],
			baggage: {},
			status: 'ok',
		};
	}

	generateTraceId(): string {
		return generateHash(`trace-${Date.now()}-${Math.random()}-${process.pid}`);
	}

	generateSpanId(): string {
		return generateHash(`span-${Date.now()}-${Math.random()}`);
	}

	getActiveSpans(): Span[] {
		return Array.from(this.activeSpans.values());
	}

	getTraceById(traceId: string): Span[] {
		return this.completedSpans.filter((span) => span.traceId === traceId);
	}

	exportSpans(): Span[] {
		const spans = [...this.completedSpans];
		this.completedSpans = [];
		return spans;
	}
}

// Advanced Metrics Collector
export class MetricsCollector extends EventEmitter {
	private metrics = new Map<string, MetricPoint[]>();
	private counters = new Map<string, number>();
	private gauges = new Map<string, number>();
	private histograms = new Map<string, number[]>();

	private readonly maxMetricsPerName = 10000;

	increment(name: string, value: number = 1, labels: Record<string, string> = {}): void {
		const key = this.createMetricKey(name, labels);
		const current = this.counters.get(key) || 0;
		this.counters.set(key, current + value);

		this.recordMetric({
			name,
			value: current + value,
			timestamp: Date.now(),
			labels,
			type: 'counter',
		});
	}

	gauge(name: string, value: number, labels: Record<string, string> = {}): void {
		const key = this.createMetricKey(name, labels);
		this.gauges.set(key, value);

		this.recordMetric({
			name,
			value,
			timestamp: Date.now(),
			labels,
			type: 'gauge',
		});
	}

	histogram(name: string, value: number, labels: Record<string, string> = {}): void {
		const key = this.createMetricKey(name, labels);
		const values = this.histograms.get(key) || [];
		values.push(value);

		// Keep only recent values to prevent memory issues
		if (values.length > 1000) {
			values.splice(0, 500);
		}

		this.histograms.set(key, values);

		this.recordMetric({
			name,
			value,
			timestamp: Date.now(),
			labels,
			type: 'histogram',
		});
	}

	summary(name: string, values: number[], labels: Record<string, string> = {}): void {
		const sortedValues = values.slice().sort((a, b) => a - b);
		const count = values.length;
		const sum = values.reduce((a, b) => a + b, 0);
		const avg = sum / count;
		const p50 = sortedValues[Math.floor(count * 0.5)];
		const p90 = sortedValues[Math.floor(count * 0.9)];
		const p95 = sortedValues[Math.floor(count * 0.95)];
		const p99 = sortedValues[Math.floor(count * 0.99)];

		const summaryMetrics = [
			{ suffix: '_count', value: count },
			{ suffix: '_sum', value: sum },
			{ suffix: '_avg', value: avg },
			{ suffix: '_p50', value: p50 },
			{ suffix: '_p90', value: p90 },
			{ suffix: '_p95', value: p95 },
			{ suffix: '_p99', value: p99 },
		];

		summaryMetrics.forEach((metric) => {
			this.recordMetric({
				name: name + metric.suffix,
				value: metric.value,
				timestamp: Date.now(),
				labels,
				type: 'summary',
			});
		});
	}

	private recordMetric(metric: MetricPoint): void {
		const metrics = this.metrics.get(metric.name) || [];
		metrics.push(metric);

		// Limit memory usage
		if (metrics.length > this.maxMetricsPerName) {
			metrics.splice(0, metrics.length - this.maxMetricsPerName / 2);
		}

		this.metrics.set(metric.name, metrics);
		this.emit('metric-recorded', metric);
	}

	private createMetricKey(name: string, labels: Record<string, string>): string {
		const labelString = Object.entries(labels)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, v]) => `${k}=${v}`)
			.join(',');
		return `${name}{${labelString}}`;
	}

	getMetrics(name?: string): MetricPoint[] {
		if (name) {
			return this.metrics.get(name) || [];
		}
		return Array.from(this.metrics.values()).flat();
	}

	exportMetrics(): Map<string, MetricPoint[]> {
		const exported = new Map(this.metrics);
		this.metrics.clear();
		this.counters.clear();
		this.gauges.clear();
		this.histograms.clear();
		return exported;
	}
}

// Alert Manager
export class AlertManager extends EventEmitter {
	private alerts = new Map<string, Alert>();
	private rules: Array<{
		id: string;
		condition: (metrics: MetricPoint[]) => boolean;
		severity: Alert['severity'];
		title: string;
		description: string;
		cooldown: number;
		lastTriggered: number;
	}> = [];

	addRule(rule: {
		id: string;
		condition: (metrics: MetricPoint[]) => boolean;
		severity: Alert['severity'];
		title: string;
		description: string;
		cooldown?: number;
	}): void {
		this.rules.push({
			...rule,
			cooldown: rule.cooldown || 60000, // 1 minute default
			lastTriggered: 0,
		});
	}

	evaluateMetrics(metrics: MetricPoint[]): Alert[] {
		const triggeredAlerts: Alert[] = [];
		const now = Date.now();

		for (const rule of this.rules) {
			if (now - rule.lastTriggered < rule.cooldown) {
				continue; // Still in cooldown
			}

			if (rule.condition(metrics)) {
				const alert: Alert = {
					id: generateHash(`alert-${rule.id}-${now}`),
					severity: rule.severity,
					title: rule.title,
					description: rule.description,
					timestamp: now,
					tags: { ruleId: rule.id },
					resolved: false,
				};

				this.alerts.set(alert.id, alert);
				rule.lastTriggered = now;
				triggeredAlerts.push(alert);
				this.emit('alert-triggered', alert);
			}
		}

		return triggeredAlerts;
	}

	resolveAlert(alertId: string): void {
		const alert = this.alerts.get(alertId);
		if (alert) {
			alert.resolved = true;
			this.emit('alert-resolved', alert);
		}
	}

	getActiveAlerts(): Alert[] {
		return Array.from(this.alerts.values()).filter((alert) => !alert.resolved);
	}

	getAllAlerts(): Alert[] {
		return Array.from(this.alerts.values());
	}
}

// Unified Observability Manager
export class ObservabilityManager {
	private tracer: DistributedTracer;
	private metrics: MetricsCollector;
	private alerts: AlertManager;
	private healthChecks = new Map<string, () => Promise<boolean>>();

	constructor(options: { serviceName: string; samplingRate?: number }) {
		this.tracer = new DistributedTracer(options);
		this.metrics = new MetricsCollector();
		this.alerts = new AlertManager();

		this.setupDefaultAlerts();
		this.startMetricsEvaluation();
	}

	// Tracing methods
	startSpan(
		operationName: string,
		parentContext?: TraceContext,
		tags?: Record<string, unknown>
	): Span {
		return this.tracer.createSpan(operationName, parentContext, tags);
	}

	finishSpan(span: Span, tags?: Record<string, unknown>): void {
		this.tracer.finishSpan(span, tags);
	}

	// Metrics methods
	incrementCounter(name: string, value?: number, labels?: Record<string, string>): void {
		this.metrics.increment(name, value, labels);
	}

	setGauge(name: string, value: number, labels?: Record<string, string>): void {
		this.metrics.gauge(name, value, labels);
	}

	recordHistogram(name: string, value: number, labels?: Record<string, string>): void {
		this.metrics.histogram(name, value, labels);
	}

	// Health checks
	addHealthCheck(name: string, check: () => Promise<boolean>): void {
		this.healthChecks.set(name, check);
	}

	async runHealthChecks(): Promise<Record<string, boolean>> {
		const results: Record<string, boolean> = {};

		for (const [name, check] of this.healthChecks) {
			try {
				results[name] = await check();
			} catch (error) {
				results[name] = false;
				logger.error('Health check failed', { name, error: (error as Error).message });
			}
		}

		return results;
	}

	private setupDefaultAlerts(): void {
		// High error rate alert
		this.alerts.addRule({
			id: 'high-error-rate',
			condition: (metrics) => {
				const errorMetrics = metrics.filter((m) => m.name === 'errors_total');
				const recentErrors = errorMetrics.filter((m) => Date.now() - m.timestamp < 60000);
				return recentErrors.reduce((sum, m) => sum + m.value, 0) > 10;
			},
			severity: 'high',
			title: 'High Error Rate',
			description: 'Error rate exceeded threshold in the last minute',
			cooldown: 300000, // 5 minutes
		});

		// High response time alert
		this.alerts.addRule({
			id: 'high-response-time',
			condition: (metrics) => {
				const responseTimeMetrics = metrics.filter((m) => m.name === 'response_time_p95');
				const recent = responseTimeMetrics.filter((m) => Date.now() - m.timestamp < 60000);
				const avgP95 = recent.reduce((sum, m) => sum + m.value, 0) / recent.length;
				return avgP95 > 5000; // 5 seconds
			},
			severity: 'medium',
			title: 'High Response Time',
			description: 'P95 response time exceeded 5 seconds',
			cooldown: 180000, // 3 minutes
		});
	}

	private startMetricsEvaluation(): void {
		setInterval(() => {
			const metrics = this.metrics.getMetrics();
			this.alerts.evaluateMetrics(metrics);
		}, 30000); // Every 30 seconds
	}

	getObservabilityData(): {
		activeSpans: number;
		completedTraces: number;
		activeAlerts: number;
		healthStatus: Record<string, boolean>;
	} {
		return {
			activeSpans: this.tracer.getActiveSpans().length,
			completedTraces: this.tracer.exportSpans().length,
			activeAlerts: this.alerts.getActiveAlerts().length,
			healthStatus: {}, // Will be populated by runHealthChecks
		};
	}
}
