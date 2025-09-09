/**
 * KeyDB/Redis connection detector and manager
 */

import { Redis } from 'ioredis';
import { getLogger } from '../../core/logger.js';
import { NetworkResilience, NetworkHealthMonitor } from '../../utils/network-resilience.js';

const logger = getLogger('keydb-detector');
const networkMonitor = new NetworkHealthMonitor();

export interface ConnectionInfo {
	type: 'keydb' | 'redis' | 'none';
	url: string | null;
	isAvailable: boolean;
	version?: string;
}

/**
 * Detect available KeyDB/Redis connection
 */
export async function detectConnection(): Promise<ConnectionInfo> {
	// Priority order: KEYDB_URL > REDIS_URL > localhost:6379
	const urls = [process.env.KEYDB_URL, process.env.REDIS_URL, 'redis://localhost:6379'].filter(
		Boolean
	);

	// Test network connectivity first for better error handling
	const connectionCandidates = urls
		.map((url) => {
			try {
				const parsed = new URL(url as string);
				return {
					url: url as string,
					host: parsed.hostname,
					port: parseInt(parsed.port) || 6379,
					priority:
						url === process.env.KEYDB_URL ? 3 : url === process.env.REDIS_URL ? 2 : 1,
				};
			} catch {
				return null;
			}
		})
		.filter(Boolean) as Array<{ url: string; host: string; port: number; priority: number }>;

	// Find the best connection using network resilience
	const bestConnection = await NetworkResilience.findBestConnection(connectionCandidates, {
		timeout: 3000,
		retries: 1,
		backoff: 'linear',
		jitter: false,
	});

	if (bestConnection) {
		// Record the latency for adaptive timeouts
		networkMonitor.recordLatency(bestConnection.latency);
		logger.debug('Best connection found', {
			host: bestConnection.host,
			port: bestConnection.port,
			latency: bestConnection.latency,
		});
	}

	for (const url of urls) {
		try {
			const startTime = Date.now();

			// Use adaptive timeout based on network conditions
			const adaptiveTimeout = bestConnection
				? Math.max(3000, bestConnection.latency * 3) // 3x latency or min 3s
				: 5000; // fallback to 5s

			const client = new Redis(url as string, {
				connectTimeout: adaptiveTimeout,
				retryStrategy: () => null, // Don't retry (we handle retries at higher level)
				lazyConnect: true,
			});

			await client.connect();

			// Check if it's KeyDB or Redis
			const info = await client.info('server');
			const isKeyDB = info.includes('keydb_version');
			const version = extractVersion(info, isKeyDB);

			await client.quit();

			// Record successful connection latency
			const connectionLatency = Date.now() - startTime;
			networkMonitor.recordLatency(connectionLatency);

			logger.info(`Detected ${isKeyDB ? 'KeyDB' : 'Redis'}`, {
				version,
				url: url?.includes('localhost') ? 'localhost:6379' : url,
				latency: connectionLatency,
				adaptiveTimeout,
				networkHealth: networkMonitor.getHealthScore(),
			});

			return {
				type: isKeyDB ? 'keydb' : 'redis',
				url: url as string,
				isAvailable: true,
				version,
			};
		} catch (error) {
			// Continue to next URL
			logger.debug(`Failed to connect to ${url}`, {
				error: (error as Error).message,
				networkHealth: networkMonitor.getHealthScore(),
			});
		}
	}

	logger.info('No KeyDB/Redis available, will use embedded queue');
	return {
		type: 'none',
		url: null,
		isAvailable: false,
	};
}

/**
 * Extract version from INFO output
 */
function extractVersion(info: string, isKeyDB: boolean): string {
	const pattern = isKeyDB ? /keydb_version:([^\r\n]+)/ : /redis_version:([^\r\n]+)/;

	const match = info.match(pattern);
	return match ? match[1] : 'unknown';
}

/**
 * Create optimized connection for BullMQ
 */
export function createBullMQConnection(url: string): Redis {
	const client = new Redis(url, {
		maxRetriesPerRequest: null, // Required for BullMQ
		enableReadyCheck: false,
		// KeyDB optimizations
		enableOfflineQueue: true,
		connectTimeout: 5000,
		disconnectTimeout: 2000,
		commandTimeout: 5000,
		keepAlive: 30000,
	});

	client.on('connect', () => {
		logger.debug('Connected to KeyDB/Redis for job queue');
	});

	client.on('error', (error: any) => {
		logger.error('KeyDB/Redis connection error', { error });
	});

	return client;
}
