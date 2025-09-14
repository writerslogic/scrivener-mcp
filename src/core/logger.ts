/* eslint-disable no-console */
/**
 * Centralized logging system - utilizes common utilities
 */

import { getEnv, isDevelopment } from '../utils/common.js';
import type { LogContext } from '../types/index.js';
import { toLogContext } from '../types/index.js';

// Re-export LogContext for backward compatibility
export type { LogContext } from '../types/index.js';

export enum LogLevel {
	DEBUG = 0,
	INFO = 1,
	WARN = 2,
	ERROR = 3,
	FATAL = 4,
}

class Logger {
	private level: LogLevel;
	private readonly name: string;
	private readonly outputs: Array<
		(level: LogLevel, message: string, context?: LogContext) => void
	> = [];

	constructor(name: string, level: LogLevel = LogLevel.INFO) {
		this.name = name;
		this.level = level;

		// Default console output
		this.addOutput((level, message, context) => {
			const timestamp = new Date().toISOString();
			const prefix = `[${timestamp}] [${LogLevel[level]}] [${this.name}]`;

			switch (level) {
				case LogLevel.DEBUG:
					if (isDevelopment()) {
						console.debug(prefix, message, context || '');
					}
					break;
				case LogLevel.INFO:
					console.info(prefix, message, context || '');
					break;
				case LogLevel.WARN:
					console.warn(prefix, message, context || '');
					break;
				case LogLevel.ERROR:
				case LogLevel.FATAL:
					console.error(prefix, message, context || '');
					break;
			}
		});
	}

	setLevel(level: LogLevel): void {
		this.level = level;
	}

	addOutput(output: (level: LogLevel, message: string, context?: LogContext) => void): void {
		this.outputs.push(output);
	}

	private log(level: LogLevel, message: string, context?: LogContext): void {
		if (level >= this.level) {
			for (const output of this.outputs) {
				output(level, message, context);
			}
		}
	}

	debug(message: string, context?: LogContext | Record<string, unknown>): void {
		const safeContext = context && typeof context === 'object' && !Array.isArray(context) 
			? ('timestamp' in context || 'code' in context || 'source' in context ? context as LogContext : toLogContext(context))
			: context as LogContext;
		this.log(LogLevel.DEBUG, message, safeContext);
	}

	info(message: string, context?: LogContext | Record<string, unknown>): void {
		const safeContext = context && typeof context === 'object' && !Array.isArray(context) 
			? ('timestamp' in context || 'code' in context || 'source' in context ? context as LogContext : toLogContext(context))
			: context as LogContext;
		this.log(LogLevel.INFO, message, safeContext);
	}

	warn(message: string, context?: LogContext | Record<string, unknown>): void {
		const safeContext = context && typeof context === 'object' && !Array.isArray(context) 
			? ('timestamp' in context || 'code' in context || 'source' in context ? context as LogContext : toLogContext(context))
			: context as LogContext;
		this.log(LogLevel.WARN, message, safeContext);
	}

	error(message: string, context?: LogContext | Record<string, unknown>): void {
		const safeContext = context && typeof context === 'object' && !Array.isArray(context) 
			? ('timestamp' in context || 'code' in context || 'source' in context ? context as LogContext : toLogContext(context))
			: context as LogContext;
		this.log(LogLevel.ERROR, message, safeContext);
	}

	fatal(message: string, context?: LogContext | Record<string, unknown>): void {
		const safeContext = context && typeof context === 'object' && !Array.isArray(context) 
			? ('timestamp' in context || 'code' in context || 'source' in context ? context as LogContext : toLogContext(context))
			: context as LogContext;
		this.log(LogLevel.FATAL, message, safeContext);
	}

	child(name: string): Logger {
		return new Logger(`${this.name}:${name}`, this.level);
	}
}

// Logger factory
class LoggerFactory {
	private loggers = new Map<string, Logger>();
	private defaultLevel = LogLevel.INFO;

	constructor() {
		// Set level from environment using utility
		const envLevel = getEnv('LOG_LEVEL')?.toUpperCase();
		if (envLevel && envLevel in LogLevel) {
			this.defaultLevel = LogLevel[envLevel as keyof typeof LogLevel] as unknown as LogLevel;
		}
	}

	getLogger(name: string): Logger {
		if (!this.loggers.has(name)) {
			this.loggers.set(name, new Logger(name, this.defaultLevel));
		}
		return this.loggers.get(name)!;
	}

	setGlobalLevel(level: LogLevel): void {
		this.defaultLevel = level;
		for (const logger of this.loggers.values()) {
			logger.setLevel(level);
		}
	}
}

// Global factory instance
const factory = new LoggerFactory();

// Export convenience functions
export function getLogger(name: string): Logger {
	return factory.getLogger(name);
}

export function setGlobalLogLevel(level: LogLevel): void {
	factory.setGlobalLevel(level);
}

// Pre-configured loggers
export const Loggers = {
	main: getLogger('main'),
	database: getLogger('database'),
	cache: getLogger('cache'),
	handlers: getLogger('handlers'),
	analysis: getLogger('analysis'),
	enhancement: getLogger('enhancement'),
} as const;
