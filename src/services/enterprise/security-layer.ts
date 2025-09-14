/**
 * Enterprise Security Layer - Advanced security patterns for production systems
 * Implements comprehensive input validation, sanitization, authentication, and threat detection
 */

import { EventEmitter } from 'events';
import { generateHash, handleError, AppError, ErrorCode } from '../../utils/common.js';
import { getLogger } from '../../core/logger.js';
import type { TraceContext } from './observability.js';
import type { RateLimitConfig } from './service-foundation.js';

const logger = getLogger('security-layer');

// Security Types and Interfaces
export interface SecurityContext extends Record<string, unknown> {
	userId?: string;
	sessionId?: string;
	ipAddress: string;
	userAgent: string;
	timestamp: number;
	permissions: string[];
	riskScore: number;
}

export interface ThreatEvent {
	id: string;
	type:
		| 'sql_injection'
		| 'xss'
		| 'brute_force'
		| 'anomalous_access'
		| 'rate_limit_exceeded'
		| 'suspicious_payload';
	severity: 'low' | 'medium' | 'high' | 'critical';
	source: string;
	description: string;
	timestamp: number;
	context: SecurityContext;
	blocked: boolean;
	evidence: Record<string, unknown>;
}

export interface ValidationRule {
	field: string;
	type: 'string' | 'number' | 'email' | 'uuid' | 'custom';
	required: boolean;
	minLength?: number;
	maxLength?: number;
	pattern?: RegExp;
	sanitize?: boolean;
	customValidator?: (value: unknown) => { valid: boolean; error?: string };
}

export interface SecurityPolicy {
	name: string;
	description: string;
	rules: ValidationRule[];
	rateLimits: RateLimitConfig[];
	allowedOrigins: string[];
	blockedIPs: string[];
	requireAuthentication: boolean;
	maxRequestSize: number;
	allowedFileTypes: string[];
}

// Advanced Input Validator with Security Focus
export class SecurityValidator {
	private threatPatterns = new Map<string, RegExp[]>();
	private blockedIPs = new Set<string>();
	private suspiciousPatterns: RegExp[] = [];

	constructor() {
		this.initializeThreatPatterns();
		this.initializeSuspiciousPatterns();
	}

	async validate(
		data: Record<string, unknown>,
		rules: ValidationRule[],
		context: SecurityContext
	): Promise<{ valid: boolean; sanitized?: Record<string, unknown>; threats?: ThreatEvent[] }> {
		const threats: ThreatEvent[] = [];
		const sanitized: Record<string, unknown> = {};

		try {
			// Check IP blocklist
			if (this.blockedIPs.has(context.ipAddress)) {
				threats.push(
					this.createThreatEvent('anomalous_access', 'high', context, {
						reason: 'IP address is blocked',
						ip: context.ipAddress,
					})
				);
				return { valid: false, threats };
			}

			// Validate each field according to rules
			for (const rule of rules) {
				const value = data[rule.field];
				const fieldResult = await this.validateField(value, rule, context);

				if (!fieldResult.valid) {
					return { valid: false, threats: fieldResult.threats || [] };
				}

				sanitized[rule.field] = fieldResult.sanitized || value;
				if (fieldResult.threats) {
					threats.push(...fieldResult.threats);
				}
			}

			// Check for injection attacks across all string values
			const injectionThreats = this.detectInjectionAttacks(data, context);
			threats.push(...injectionThreats);

			// Anomaly detection based on request patterns
			const anomalyThreats = await this.detectAnomalies(data, context);
			threats.push(...anomalyThreats);

			const criticalThreats = threats.filter(
				(t) => t.severity === 'critical' || t.severity === 'high'
			);

			return {
				valid: criticalThreats.length === 0,
				sanitized,
				threats: threats.length > 0 ? threats : undefined,
			};
		} catch (error) {
			throw handleError(error, 'security-validation');
		}
	}

	private async validateField(
		value: unknown,
		rule: ValidationRule,
		context: SecurityContext
	): Promise<{ valid: boolean; sanitized?: unknown; threats?: ThreatEvent[] }> {
		const threats: ThreatEvent[] = [];

		// Required field check
		if (rule.required && (value === undefined || value === null || value === '')) {
			return { valid: false };
		}

		if (value === undefined || value === null) {
			return { valid: true };
		}

		// Type validation
		const typeResult = this.validateType(value, rule.type);
		if (!typeResult.valid) {
			return { valid: false };
		}

		let sanitized = value;

		// String-specific validations
		if (typeof value === 'string') {
			// Length validation
			if (rule.minLength && value.length < rule.minLength) {
				return { valid: false };
			}
			if (rule.maxLength && value.length > rule.maxLength) {
				return { valid: false };
			}

			// Pattern validation
			if (rule.pattern && !rule.pattern.test(value)) {
				return { valid: false };
			}

			// Threat detection
			const threatDetection = this.detectStringThreats(value, context);
			threats.push(...threatDetection);

			// Sanitization
			if (rule.sanitize) {
				sanitized = this.sanitizeString(value);
			}
		}

		// Custom validation
		if (rule.customValidator) {
			const customResult = rule.customValidator(sanitized);
			if (!customResult.valid) {
				return { valid: false };
			}
		}

		return {
			valid: true,
			sanitized,
			threats: threats.length > 0 ? threats : undefined,
		};
	}

	private validateType(value: unknown, type: string): { valid: boolean } {
		switch (type) {
			case 'string':
				return { valid: typeof value === 'string' };
			case 'number':
				return { valid: typeof value === 'number' && !isNaN(value) };
			case 'email':
				return {
					valid: typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
				};
			case 'uuid':
				return {
					valid:
						typeof value === 'string' &&
						/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
							value
						),
				};
			default:
				return { valid: true };
		}
	}

	private detectStringThreats(value: string, context: SecurityContext): ThreatEvent[] {
		const threats: ThreatEvent[] = [];

		// SQL Injection Detection
		const sqlPatterns = this.threatPatterns.get('sql_injection') || [];
		for (const pattern of sqlPatterns) {
			if (pattern.test(value.toLowerCase())) {
				threats.push(
					this.createThreatEvent('sql_injection', 'high', context, {
						pattern: pattern.source,
						value: value.substring(0, 100), // Truncate for logging
					})
				);
				break; // One detection per type is enough
			}
		}

		// XSS Detection
		const xssPatterns = this.threatPatterns.get('xss') || [];
		for (const pattern of xssPatterns) {
			if (pattern.test(value.toLowerCase())) {
				threats.push(
					this.createThreatEvent('xss', 'high', context, {
						pattern: pattern.source,
						value: value.substring(0, 100),
					})
				);
				break;
			}
		}

		// Suspicious payload detection
		for (const pattern of this.suspiciousPatterns) {
			if (pattern.test(value)) {
				threats.push(
					this.createThreatEvent('suspicious_payload', 'medium', context, {
						pattern: pattern.source,
						suspiciousContent: value.substring(0, 50),
					})
				);
				break;
			}
		}

		return threats;
	}

	private detectInjectionAttacks(
		data: Record<string, unknown>,
		context: SecurityContext
	): ThreatEvent[] {
		const threats: ThreatEvent[] = [];
		const serialized = JSON.stringify(data).toLowerCase();

		// Advanced SQL injection patterns
		const advancedSqlPatterns = [
			/union\s+select/i,
			/or\s+1\s*=\s*1/i,
			/and\s+1\s*=\s*1/i,
			/'\s*or\s*'.*'=/i,
			/exec\s*\(/i,
			/drop\s+table/i,
			/insert\s+into/i,
			/delete\s+from/i,
		];

		for (const pattern of advancedSqlPatterns) {
			if (pattern.test(serialized)) {
				threats.push(
					this.createThreatEvent('sql_injection', 'critical', context, {
						pattern: pattern.source,
						detectionMethod: 'advanced_pattern_matching',
					})
				);
				break;
			}
		}

		return threats;
	}

	private async detectAnomalies(
		data: Record<string, unknown>,
		context: SecurityContext
	): Promise<ThreatEvent[]> {
		const threats: ThreatEvent[] = [];

		// Detect unusually large payloads
		const dataSize = JSON.stringify(data).length;
		if (dataSize > 1000000) {
			// 1MB
			threats.push(
				this.createThreatEvent('anomalous_access', 'medium', context, {
					reason: 'Unusually large payload',
					size: dataSize,
				})
			);
		}

		// Detect unusual number of fields
		const fieldCount = Object.keys(data).length;
		if (fieldCount > 100) {
			threats.push(
				this.createThreatEvent('anomalous_access', 'medium', context, {
					reason: 'Unusual number of fields',
					count: fieldCount,
				})
			);
		}

		// Risk score based detection
		if (context.riskScore > 0.8) {
			threats.push(
				this.createThreatEvent('anomalous_access', 'high', context, {
					reason: 'High risk score',
					riskScore: context.riskScore,
				})
			);
		}

		return threats;
	}

	private sanitizeString(value: string): string {
		return value
			.replace(/[<>]/g, '') // Remove angle brackets
			.replace(/['";]/g, '') // Remove quotes and semicolons
			.replace(/--/g, '') // Remove SQL comment markers
			.replace(/\/\*/g, '') // Remove CSS/SQL comment start
			.replace(/\*\//g, '') // Remove CSS/SQL comment end
			.trim();
	}

	private createThreatEvent(
		type: ThreatEvent['type'],
		severity: ThreatEvent['severity'],
		context: SecurityContext,
		evidence: Record<string, unknown>
	): ThreatEvent {
		return {
			id: generateHash(`threat-${Date.now()}-${Math.random()}`),
			type,
			severity,
			source: context.ipAddress,
			description: this.getThreatDescription(type),
			timestamp: Date.now(),
			context,
			blocked: severity === 'critical' || severity === 'high',
			evidence,
		};
	}

	private getThreatDescription(type: ThreatEvent['type']): string {
		const descriptions = {
			sql_injection: 'Potential SQL injection attack detected',
			xss: 'Potential cross-site scripting attack detected',
			brute_force: 'Brute force attack pattern detected',
			anomalous_access: 'Anomalous access pattern detected',
			rate_limit_exceeded: 'Rate limit exceeded',
			suspicious_payload: 'Suspicious payload content detected',
		};
		return descriptions[type];
	}

	private initializeThreatPatterns(): void {
		// SQL Injection patterns
		this.threatPatterns.set('sql_injection', [
			/(\b(select|insert|update|delete|drop|create|alter|exec|execute)\b)/i,
			/(union.*select)/i,
			/(or\s+1\s*=\s*1)/i,
			/(and\s+1\s*=\s*1)/i,
			/('.*or.*'.*=.*')/i,
			/(--)/,
			/(\|\|.*concat)/i,
		]);

		// XSS patterns
		this.threatPatterns.set('xss', [
			/(<script[^>]*>.*?<\/script>)/i,
			/(<iframe[^>]*>)/i,
			/(javascript:)/i,
			/(on\w+\s*=)/i,
			/(<object[^>]*>)/i,
			/(<embed[^>]*>)/i,
			/(eval\s*\()/i,
			/(expression\s*\()/i,
		]);
	}

	private initializeSuspiciousPatterns(): void {
		this.suspiciousPatterns = [
			/\b(password|pwd|secret|token|key|auth)\b.*[:=]/i,
			/\b(admin|root|administrator)\b/i,
			/(\.\.\/|\.\.\\)/,
			/\b(exec|eval|system|shell_exec)\b/i,
			/\b(base64_decode|hex2bin)\b/i,
			/\$\{.*\}/,
			/<\?php/i,
			/<%.*%>/,
		];
	}

	blockIP(ip: string): void {
		this.blockedIPs.add(ip);
		logger.info('IP address blocked', { ip });
	}

	unblockIP(ip: string): void {
		this.blockedIPs.delete(ip);
		logger.info('IP address unblocked', { ip });
	}

	isIPBlocked(ip: string): boolean {
		return this.blockedIPs.has(ip);
	}
}

// Advanced Rate Limiter with Security Features
export class SecurityRateLimiter extends EventEmitter {
	private windows = new Map<
		string,
		{
			count: number;
			resetTime: number;
			requests: Array<{ timestamp: number; blocked: boolean }>;
			consecutiveFailures: number;
		}
	>();

	private policies = new Map<string, RateLimitConfig>();
	private tempBlocks = new Map<string, number>(); // IP -> unblock time

	constructor() {
		super();
		this.setupCleanup();
	}

	addPolicy(name: string, config: RateLimitConfig): void {
		this.policies.set(name, config);
	}

	async checkLimit(
		policyName: string,
		context: SecurityContext,
		_traceContext?: TraceContext
	): Promise<{
		allowed: boolean;
		resetTime?: number;
		remaining?: number;
		threats?: ThreatEvent[];
	}> {
		const policy = this.policies.get(policyName);
		if (!policy) {
			throw new AppError('Rate limit policy not found', ErrorCode.INVALID_INPUT, {
				policyName,
			});
		}

		const threats: ThreatEvent[] = [];
		const key = policy.keyGenerator(context);
		const now = Date.now();

		// Check temporary blocks
		const blockUntil = this.tempBlocks.get(context.ipAddress);
		if (blockUntil && now < blockUntil) {
			threats.push({
				id: generateHash(`threat-${now}`),
				type: 'rate_limit_exceeded',
				severity: 'high',
				source: context.ipAddress,
				description: 'IP temporarily blocked due to excessive requests',
				timestamp: now,
				context,
				blocked: true,
				evidence: { blockUntil, remaining: blockUntil - now },
			});

			return { allowed: false, threats };
		}

		// Get or create window
		const window = this.windows.get(key) || {
			count: 0,
			resetTime: now + policy.windowMs,
			requests: [],
			consecutiveFailures: 0,
		};

		// Reset window if expired
		if (now > window.resetTime) {
			window.count = 0;
			window.resetTime = now + policy.windowMs;
			window.requests = [];
			window.consecutiveFailures = 0;
		}

		// Check if limit exceeded
		if (window.count >= policy.maxRequests) {
			window.consecutiveFailures++;
			window.requests.push({ timestamp: now, blocked: true });

			// Implement progressive penalties
			if (window.consecutiveFailures > 5) {
				const blockDuration = Math.min(window.consecutiveFailures * 60000, 600000); // Max 10 min
				this.tempBlocks.set(context.ipAddress, now + blockDuration);

				threats.push({
					id: generateHash(`threat-${now}`),
					type: 'brute_force',
					severity: 'critical',
					source: context.ipAddress,
					description: 'Brute force pattern detected - IP temporarily blocked',
					timestamp: now,
					context,
					blocked: true,
					evidence: { consecutiveFailures: window.consecutiveFailures, blockDuration },
				});

				this.emit('ip-blocked', { ip: context.ipAddress, duration: blockDuration });
			} else {
				threats.push({
					id: generateHash(`threat-${now}`),
					type: 'rate_limit_exceeded',
					severity: 'medium',
					source: context.ipAddress,
					description: 'Rate limit exceeded',
					timestamp: now,
					context,
					blocked: true,
					evidence: { consecutiveFailures: window.consecutiveFailures },
				});
			}

			this.windows.set(key, window);
			this.emit('rate-limit-exceeded', { key, context, window });

			return {
				allowed: false,
				resetTime: window.resetTime,
				remaining: 0,
				threats,
			};
		}

		// Allow request
		window.count++;
		window.requests.push({ timestamp: now, blocked: false });
		window.consecutiveFailures = 0; // Reset on successful request
		this.windows.set(key, window);

		return {
			allowed: true,
			remaining: policy.maxRequests - window.count,
			resetTime: window.resetTime,
		};
	}

	private setupCleanup(): void {
		setInterval(() => {
			const now = Date.now();

			// Clean expired windows
			for (const [key, window] of this.windows) {
				if (now > window.resetTime + 60000) {
					// 1 minute grace period
					this.windows.delete(key);
				}
			}

			// Clean expired temp blocks
			for (const [ip, blockUntil] of this.tempBlocks) {
				if (now > blockUntil) {
					this.tempBlocks.delete(ip);
					this.emit('ip-unblocked', { ip });
				}
			}
		}, 60000); // Every minute
	}

	getStats(): {
		activeWindows: number;
		tempBlocks: number;
		policies: number;
	} {
		return {
			activeWindows: this.windows.size,
			tempBlocks: this.tempBlocks.size,
			policies: this.policies.size,
		};
	}
}

// Security Context Manager
export class SecurityContextManager {
	private sessions = new Map<
		string,
		{
			userId: string;
			createdAt: number;
			lastActivity: number;
			permissions: string[];
			riskScore: number;
		}
	>();

	createSecurityContext(request: {
		sessionId?: string;
		userId?: string;
		ipAddress: string;
		userAgent: string;
	}): SecurityContext {
		const session = request.sessionId ? this.sessions.get(request.sessionId) : undefined;

		return {
			userId: request.userId || session?.userId,
			sessionId: request.sessionId,
			ipAddress: request.ipAddress,
			userAgent: request.userAgent,
			timestamp: Date.now(),
			permissions: session?.permissions || [],
			riskScore: this.calculateRiskScore(request, session),
		};
	}

	private calculateRiskScore(
		request: { ipAddress: string; userAgent: string },
		session?: { lastActivity: number; riskScore: number }
	): number {
		let score = 0;

		// Geographic risk (simplified)
		if (this.isHighRiskIP(request.ipAddress)) {
			score += 0.3;
		}

		// User agent analysis
		if (this.isSuspiciousUserAgent(request.userAgent)) {
			score += 0.2;
		}

		// Session-based risk
		if (session) {
			const timeSinceLastActivity = Date.now() - session.lastActivity;
			if (timeSinceLastActivity > 24 * 60 * 60 * 1000) {
				// 24 hours
				score += 0.1;
			}
			score = Math.max(score, session.riskScore * 0.8); // Decay previous risk
		}

		return Math.min(score, 1.0);
	}

	private isHighRiskIP(ip: string): boolean {
		// Simplified implementation - in production, use threat intelligence feeds
		const highRiskPatterns = [
			/^10\./, // Private networks can be suspicious in some contexts
			/^192\.168\./, // Private networks
			/^172\.(1[6-9]|2[0-9]|3[0-1])\./, // Private networks
		];

		return highRiskPatterns.some((pattern) => pattern.test(ip));
	}

	private isSuspiciousUserAgent(userAgent: string): boolean {
		const suspiciousPatterns = [
			/curl/i,
			/wget/i,
			/python/i,
			/bot/i,
			/crawler/i,
			/spider/i,
			/scraper/i,
		];

		return suspiciousPatterns.some((pattern) => pattern.test(userAgent));
	}

	updateSession(
		sessionId: string,
		updates: Partial<{ riskScore: number; permissions: string[] }>
	): void {
		const session = this.sessions.get(sessionId);
		if (session) {
			Object.assign(session, updates, { lastActivity: Date.now() });
		}
	}

	cleanupExpiredSessions(): number {
		const now = Date.now();
		const expiredThreshold = 24 * 60 * 60 * 1000; // 24 hours
		let cleaned = 0;

		for (const [sessionId, session] of this.sessions) {
			if (now - session.lastActivity > expiredThreshold) {
				this.sessions.delete(sessionId);
				cleaned++;
			}
		}

		return cleaned;
	}
}
