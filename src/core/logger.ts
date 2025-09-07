/**
 * Centralized logging system
 */

export enum LogLevel {
	DEBUG = 0,
	INFO = 1,
	WARN = 2,
	ERROR = 3,
	FATAL = 4,
}

export interface LogContext {
	[key: string]: unknown;
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
					if (process.env.NODE_ENV === 'development') {
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

	debug(message: string, context?: LogContext): void {
		this.log(LogLevel.DEBUG, message, context);
	}

	info(message: string, context?: LogContext): void {
		this.log(LogLevel.INFO, message, context);
	}

	warn(message: string, context?: LogContext): void {
		this.log(LogLevel.WARN, message, context);
	}

	error(message: string, context?: LogContext): void {
		this.log(LogLevel.ERROR, message, context);
	}

	fatal(message: string, context?: LogContext): void {
		this.log(LogLevel.FATAL, message, context);
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
		// Set level from environment
		const envLevel = process.env.LOG_LEVEL?.toUpperCase();
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
