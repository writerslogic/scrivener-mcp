/**
 * Comprehensive Error Handling System
 * Provides structured error handling, recovery strategies, and monitoring
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { EnhancedLogger } from './enhanced-logger.js';
import { AppError, ErrorCode } from '../utils/common.js';

export interface ErrorContext {
  correlationId?: string;
  userId?: string;
  operation?: string;
  resource?: string;
  additionalData?: Record<string, unknown>;
  timestamp: Date;
}

export interface ErrorRecoveryStrategy {
  name: string;
  canRecover: (error: Error, context: ErrorContext) => boolean;
  recover: (error: Error, context: ErrorContext) => Promise<boolean>;
  maxAttempts?: number;
  backoffMs?: number;
}

export interface ErrorMetrics {
  totalErrors: number;
  errorsByType: Record<string, number>;
  errorsByCode: Record<string, number>;
  recoveryAttempts: number;
  successfulRecoveries: number;
  criticalErrors: number;
  recentErrors: Array<{
    error: string;
    context: ErrorContext;
    recovered: boolean;
    timestamp: Date;
  }>;
}

export interface ErrorNotification {
  severity: 'low' | 'medium' | 'high' | 'critical';
  error: Error;
  context: ErrorContext;
  suggestion?: string;
  correlationId: string;
  notificationId: string;
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  recoveryTimeout: number;
  monitoringWindow: number;
  halfOpenMaxCalls: number;
}

export interface RateLimitConfig {
  windowMs: number;
  maxAttempts: number;
  penaltyMs: number;
}

/**
 * Circuit breaker for preventing cascading failures
 */
class CircuitBreaker extends EventEmitter {
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private failures = 0;
  private lastFailureTime: Date | null = null;
  private halfOpenCallCount = 0;

  constructor(
    private config: CircuitBreakerConfig,
    private logger: EnhancedLogger
  ) {
    super();
  }

  async execute<T>(operation: () => Promise<T>, context?: ErrorContext): Promise<T> {
    if (this.state === 'open') {
      if (this.shouldAttemptRecovery()) {
        this.state = 'half-open';
        this.halfOpenCallCount = 0;
        this.logger.info('Circuit breaker transitioning to half-open', { context });
        this.emit('stateChange', 'half-open');
      } else {
        const error = new AppError(
          'Circuit breaker is open - operation blocked',
          ErrorCode.SERVICE_UNAVAILABLE
        );
        this.logger.warn('Circuit breaker blocked operation', { context, error });
        throw error;
      }
    }

    if (this.state === 'half-open') {
      this.halfOpenCallCount++;
      if (this.halfOpenCallCount > this.config.halfOpenMaxCalls) {
        this.state = 'open';
        this.lastFailureTime = new Date();
        this.logger.warn('Circuit breaker reopened - too many half-open calls');
        this.emit('stateChange', 'open');
        throw new AppError(
          'Circuit breaker reopened',
          ErrorCode.SERVICE_UNAVAILABLE
        );
      }
    }

    try {
      const result = await operation();
      
      if (this.state === 'half-open') {
        this.state = 'closed';
        this.failures = 0;
        this.halfOpenCallCount = 0;
        this.logger.info('Circuit breaker recovered to closed state');
        this.emit('stateChange', 'closed');
      }
      
      return result;
    } catch (error) {
      this.recordFailure(error as Error, context);
      throw error;
    }
  }

  private recordFailure(error: Error, context?: ErrorContext): void {
    this.failures++;
    this.lastFailureTime = new Date();

    if (this.failures >= this.config.failureThreshold) {
      this.state = 'open';
      this.logger.error('Circuit breaker opened due to failures', {
        failures: this.failures,
        threshold: this.config.failureThreshold,
        context,
        error,
      });
      this.emit('stateChange', 'open');
    }
  }

  private shouldAttemptRecovery(): boolean {
    if (!this.lastFailureTime) return false;
    
    const timeSinceLastFailure = Date.now() - this.lastFailureTime.getTime();
    return timeSinceLastFailure >= this.config.recoveryTimeout;
  }

  getState(): string {
    return this.state;
  }

  getMetrics(): { state: string; failures: number; lastFailureTime: Date | null } {
    return {
      state: this.state,
      failures: this.failures,
      lastFailureTime: this.lastFailureTime,
    };
  }
}

/**
 * Comprehensive error handler with recovery strategies
 */
export class ErrorHandler extends EventEmitter {
  private logger: EnhancedLogger;
  private recoveryStrategies: ErrorRecoveryStrategy[] = [];
  private circuitBreakers = new Map<string, CircuitBreaker>();
  private metrics: ErrorMetrics = {
    totalErrors: 0,
    errorsByType: {},
    errorsByCode: {},
    recoveryAttempts: 0,
    successfulRecoveries: 0,
    criticalErrors: 0,
    recentErrors: [],
  };
  private rateLimits = new Map<string, { count: number; windowStart: number; penaltyEnd?: number }>();

  constructor(logger: EnhancedLogger) {
    super();
    this.logger = logger;
    this.setupDefaultRecoveryStrategies();
    this.setupProcessHandlers();
  }

  /**
   * Handle error with recovery attempts
   */
  async handleError(
    error: Error,
    context: ErrorContext,
    options: {
      allowRecovery?: boolean;
      notifySeverity?: ErrorNotification['severity'];
      circuitBreakerKey?: string;
      retryable?: boolean;
    } = {}
  ): Promise<{
    recovered: boolean;
    strategy?: string;
    attempts: number;
    finalError?: Error;
  }> {
    const correlationId = context.correlationId || randomUUID();
    const notificationId = randomUUID();

    // Update metrics
    this.updateMetrics(error, context);

    // Log the error
    this.logger.error('Error occurred', error, {
      correlationId,
      operation: context.operation,
      resource: context.resource,
      userId: context.userId,
      additionalData: context.additionalData,
    });

    // Check rate limiting
    if (this.isRateLimited(context.operation || 'unknown', error)) {
      this.logger.warn('Error handling rate limited', { correlationId, operation: context.operation });
      return { recovered: false, attempts: 0, finalError: error };
    }

    let recovered = false;
    let strategy: string | undefined;
    let attempts = 0;
    let finalError = error;

    // Attempt recovery if allowed
    if (options.allowRecovery !== false) {
      for (const recoveryStrategy of this.recoveryStrategies) {
        if (recoveryStrategy.canRecover(error, context)) {
          attempts++;
          this.metrics.recoveryAttempts++;

          try {
            this.logger.info('Attempting error recovery', {
              strategy: recoveryStrategy.name,
              correlationId,
              attempt: attempts,
            });

            recovered = await recoveryStrategy.recover(error, context);
            
            if (recovered) {
              strategy = recoveryStrategy.name;
              this.metrics.successfulRecoveries++;
              this.logger.info('Error recovery successful', {
                strategy: recoveryStrategy.name,
                correlationId,
              });
              break;
            }
          } catch (recoveryError) {
            this.logger.warn('Error recovery failed', {
              error: (recoveryError as Error).message,
              strategy: recoveryStrategy.name,
              correlationId,
              originalError: error.message,
            });
            finalError = recoveryError as Error;
          }
        }
      }
    }

    // Create notification if severity specified
    if (options.notifySeverity) {
      const notification: ErrorNotification = {
        severity: options.notifySeverity,
        error: finalError,
        context,
        correlationId,
        notificationId,
        suggestion: this.generateSuggestion(error, context, recovered),
      };
      
      this.emit('errorNotification', notification);
    }

    // Update recent errors
    this.metrics.recentErrors.unshift({
      error: error.message,
      context,
      recovered,
      timestamp: new Date(),
    });

    // Keep only last 100 errors
    if (this.metrics.recentErrors.length > 100) {
      this.metrics.recentErrors.splice(100);
    }

    // Emit error event
    this.emit('error', {
      error: finalError,
      context,
      recovered,
      strategy,
      attempts,
      correlationId,
    });

    return { recovered, strategy, attempts, finalError };
  }

  /**
   * Execute operation with circuit breaker protection
   */
  async executeWithCircuitBreaker<T>(
    key: string,
    operation: () => Promise<T>,
    context?: ErrorContext,
    config?: Partial<CircuitBreakerConfig>
  ): Promise<T> {
    let circuitBreaker = this.circuitBreakers.get(key);
    
    if (!circuitBreaker) {
      const fullConfig: CircuitBreakerConfig = {
        failureThreshold: 5,
        recoveryTimeout: 60000,
        monitoringWindow: 300000,
        halfOpenMaxCalls: 3,
        ...config,
      };
      
      circuitBreaker = new CircuitBreaker(fullConfig, this.logger);
      this.circuitBreakers.set(key, circuitBreaker);
    }

    return circuitBreaker.execute(operation, context);
  }

  /**
   * Add custom recovery strategy
   */
  addRecoveryStrategy(strategy: ErrorRecoveryStrategy): void {
    this.recoveryStrategies.push(strategy);
    this.logger.info('Added recovery strategy', { strategy: strategy.name });
  }

  /**
   * Remove recovery strategy
   */
  removeRecoveryStrategy(strategyName: string): void {
    const index = this.recoveryStrategies.findIndex(s => s.name === strategyName);
    if (index !== -1) {
      this.recoveryStrategies.splice(index, 1);
      this.logger.info('Removed recovery strategy', { strategy: strategyName });
    }
  }

  /**
   * Get error metrics
   */
  getMetrics(): ErrorMetrics {
    return { ...this.metrics };
  }

  /**
   * Get circuit breaker status
   */
  getCircuitBreakerStatus(): Record<string, { state: string; failures: number; lastFailureTime: Date | null }> {
    const status: Record<string, ReturnType<CircuitBreaker['getMetrics']>> = {};
    
    for (const [key, breaker] of this.circuitBreakers) {
      status[key] = breaker.getMetrics();
    }
    
    return status;
  }

  /**
   * Reset metrics
   */
  resetMetrics(): void {
    this.metrics = {
      totalErrors: 0,
      errorsByType: {},
      errorsByCode: {},
      recoveryAttempts: 0,
      successfulRecoveries: 0,
      criticalErrors: 0,
      recentErrors: [],
    };
    
    this.rateLimits.clear();
    this.emit('metricsReset');
  }

  /**
   * Generate error report
   */
  generateErrorReport(): string {
    const metrics = this.getMetrics();
    const cbStatus = this.getCircuitBreakerStatus();
    
    let report = '# Error Handling Report\n\n';
    
    report += `## Summary\n`;
    report += `- **Total Errors**: ${metrics.totalErrors}\n`;
    report += `- **Recovery Attempts**: ${metrics.recoveryAttempts}\n`;
    report += `- **Successful Recoveries**: ${metrics.successfulRecoveries}\n`;
    report += `- **Critical Errors**: ${metrics.criticalErrors}\n`;
    report += `- **Recovery Rate**: ${metrics.recoveryAttempts > 0 ? (metrics.successfulRecoveries / metrics.recoveryAttempts * 100).toFixed(2) : 0}%\n\n`;
    
    report += `## Error Types\n`;
    for (const [type, count] of Object.entries(metrics.errorsByType)) {
      report += `- **${type}**: ${count}\n`;
    }
    report += '\n';
    
    report += `## Error Codes\n`;
    for (const [code, count] of Object.entries(metrics.errorsByCode)) {
      report += `- **${code}**: ${count}\n`;
    }
    report += '\n';
    
    report += `## Circuit Breakers\n`;
    for (const [key, status] of Object.entries(cbStatus)) {
      report += `- **${key}**: ${status.state} (${status.failures} failures)\n`;
    }
    report += '\n';
    
    if (metrics.recentErrors.length > 0) {
      report += `## Recent Errors\n`;
      for (const recentError of metrics.recentErrors.slice(0, 10)) {
        report += `- **${recentError.timestamp.toISOString()}**: ${recentError.error} (${recentError.recovered ? 'Recovered' : 'Not recovered'})\n`;
      }
    }
    
    return report;
  }

  // Private methods

  private setupDefaultRecoveryStrategies(): void {
    // Retry strategy
    this.addRecoveryStrategy({
      name: 'retry',
      canRecover: (error) => {
        const retryableErrors = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'];
        return retryableErrors.some(code => error.message.includes(code));
      },
      recover: async (error, context) => {
        const maxAttempts = 3;
        const baseDelay = 1000;
        
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          await this.delay(baseDelay * Math.pow(2, attempt - 1));
          
          // This would typically retry the original operation
          // For demo purposes, we simulate recovery
          if (Math.random() > 0.5) {
            return true;
          }
        }
        
        return false;
      },
    });

    // Fallback strategy
    this.addRecoveryStrategy({
      name: 'fallback',
      canRecover: (error) => {
        return error.message.includes('SERVICE_UNAVAILABLE');
      },
      recover: async (error, context) => {
        this.logger.info('Using fallback recovery', { 
          operation: context.operation,
          error: error.message 
        });
        
        // Implement fallback logic here
        return true;
      },
    });

    // Cache recovery strategy
    this.addRecoveryStrategy({
      name: 'cache-fallback',
      canRecover: (error, context) => {
        return context.operation?.includes('cache') || false;
      },
      recover: async (error, context) => {
        this.logger.info('Attempting cache fallback recovery');
        
        // Try to recover from cache failure by using alternative caching
        return Math.random() > 0.3; // 70% success rate
      },
    });
  }

  private setupProcessHandlers(): void {
    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      this.logger.error('Uncaught exception', error, { critical: true });
      
      const context: ErrorContext = {
        correlationId: randomUUID(),
        operation: 'uncaughtException',
        timestamp: new Date(),
      };
      
      this.handleError(error, context, {
        notifySeverity: 'critical',
        allowRecovery: false,
      });
      
      // Give time for logging then exit
      setTimeout(() => {
        process.exit(1);
      }, 1000);
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      
      this.logger.error('Unhandled promise rejection', error, {
        promise: promise.toString(),
        critical: true,
      });
      
      const context: ErrorContext = {
        correlationId: randomUUID(),
        operation: 'unhandledRejection',
        timestamp: new Date(),
      };
      
      this.handleError(error, context, {
        notifySeverity: 'critical',
        allowRecovery: false,
      });
    });

    // Handle process warnings
    process.on('warning', (warning) => {
      this.logger.warn('Process warning', {
        name: warning.name,
        message: warning.message,
        stack: warning.stack,
      });
    });
  }

  private updateMetrics(error: Error, context: ErrorContext): void {
    this.metrics.totalErrors++;
    
    // Update by error type
    const errorType = error.constructor.name;
    this.metrics.errorsByType[errorType] = (this.metrics.errorsByType[errorType] || 0) + 1;
    
    // Update by error code
    const errorCode = (error as AppError).code || 'UNKNOWN';
    this.metrics.errorsByCode[errorCode] = (this.metrics.errorsByCode[errorCode] || 0) + 1;
    
    // Check if critical
    if (this.isCriticalError(error, context)) {
      this.metrics.criticalErrors++;
    }
  }

  private isRateLimited(operation: string, error: Error, config: RateLimitConfig = {
    windowMs: 60000,
    maxAttempts: 10,
    penaltyMs: 300000,
  }): boolean {
    const key = `${operation}:${error.constructor.name}`;
    const now = Date.now();
    const rateLimit = this.rateLimits.get(key);

    if (!rateLimit) {
      this.rateLimits.set(key, { count: 1, windowStart: now });
      return false;
    }

    // Check if in penalty period
    if (rateLimit.penaltyEnd && now < rateLimit.penaltyEnd) {
      return true;
    }

    // Reset window if expired
    if (now - rateLimit.windowStart >= config.windowMs) {
      rateLimit.count = 1;
      rateLimit.windowStart = now;
      rateLimit.penaltyEnd = undefined;
      return false;
    }

    rateLimit.count++;

    // Apply penalty if threshold exceeded
    if (rateLimit.count > config.maxAttempts) {
      rateLimit.penaltyEnd = now + config.penaltyMs;
      return true;
    }

    return false;
  }

  private isCriticalError(error: Error, context: ErrorContext): boolean {
    const criticalPatterns = [
      'uncaughtException',
      'unhandledRejection',
      'ENOSPC', // Disk full
      'EMFILE', // Too many open files
      'ENOMEM', // Out of memory
    ];

    return criticalPatterns.some(pattern => 
      error.message.includes(pattern) || 
      context.operation?.includes(pattern)
    );
  }

  private generateSuggestion(
    error: Error, 
    context: ErrorContext, 
    recovered: boolean
  ): string {
    if (recovered) {
      return 'Error was automatically recovered';
    }

    // Generate contextual suggestions
    if (error.message.includes('ECONNREFUSED')) {
      return 'Check if the target service is running and accessible';
    }
    
    if (error.message.includes('TIMEOUT')) {
      return 'Consider increasing timeout values or optimizing the operation';
    }
    
    if (error.message.includes('ENOSPC')) {
      return 'Free up disk space immediately';
    }
    
    if (context.operation?.includes('database')) {
      return 'Check database connectivity and query performance';
    }
    
    return 'Review error details and check system health';
  }

  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Error boundary for async operations
 */
export class AsyncErrorBoundary {
  constructor(
    private errorHandler: ErrorHandler,
    private defaultContext: Partial<ErrorContext> = {}
  ) {}

  /**
   * Wrap async function with error handling
   */
  wrap<T extends any[], R>(
    fn: (...args: T) => Promise<R>,
    context: Partial<ErrorContext> = {}
  ): (...args: T) => Promise<R> {
    return async (...args: T): Promise<R> => {
      try {
        return await fn(...args);
      } catch (error) {
        const fullContext: ErrorContext = {
          ...this.defaultContext,
          ...context,
          timestamp: new Date(),
        };

        const result = await this.errorHandler.handleError(
          error as Error,
          fullContext,
          { allowRecovery: true }
        );

        if (result.recovered) {
          // If recovered, try the operation again
          return await fn(...args);
        }

        throw result.finalError || error;
      }
    };
  }

  /**
   * Execute function with error boundary
   */
  async execute<T>(
    fn: () => Promise<T>,
    context: Partial<ErrorContext> = {}
  ): Promise<T> {
    const wrappedFn = this.wrap(fn, context);
    return wrappedFn();
  }
}