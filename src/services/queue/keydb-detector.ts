import { Redis } from 'ioredis';
import { getLogger } from '../../core/logger.js';
import { NetworkResilience, NetworkHealthMonitor } from '../../utils/network-resilience.js';

const logger = getLogger('keydb-detector');
const networkMonitor = new NetworkHealthMonitor();
// Existing Redis/KeyDB proxies may deny HELLO even when ordinary commands are permitted.
const REDIS_PROTOCOL = 2;

export interface ConnectionInfo {
	type: 'keydb' | 'redis' | 'none';
	url: string | null;
	isAvailable: boolean;
	version?: string;
}

export async function detectConnection(candidateUrls?: readonly string[]): Promise<ConnectionInfo> {
	if (candidateUrls === undefined && process.env.SCRIVENER_LOCAL_ONLY === 'true')
		return { type: 'none', url: null, isAvailable: false };
	if (candidateUrls !== undefined) {
		if (!Array.isArray(candidateUrls) || candidateUrls.length > 16)
			throw new Error('Explicit Redis candidates must be an array of at most 16 URLs');
		for (const candidate of candidateUrls) {
			if (
				typeof candidate !== 'string' ||
				Buffer.byteLength(candidate) > 4096 ||
				/[\s\p{Cc}]/u.test(candidate)
			)
				throw new Error('Each explicit Redis URL must be a string of at most 4096 bytes');
			let parsed: URL;
			try {
				parsed = new URL(candidate);
			} catch {
				throw new Error('Each explicit Redis candidate must be a valid Redis URL');
			}
			if (
				!['redis:', 'rediss:'].includes(parsed.protocol) ||
				!parsed.hostname ||
				parsed.port === '0'
			)
				throw new Error(
					'Explicit Redis URLs require redis/rediss, a host and a valid port'
				);
		}
	}
	const urls = candidateUrls
		? [...candidateUrls]
		: [process.env.KEYDB_URL, process.env.REDIS_URL, 'redis://localhost:6379'].filter(Boolean);
	if (urls.length === 0) return { type: 'none', url: null, isAvailable: false };

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

	const bestConnection = await NetworkResilience.findBestConnection(connectionCandidates, {
		timeout: 3000,
		retries: 1,
		backoff: 'linear',
		jitter: false,
	});

	if (bestConnection) {
		networkMonitor.recordLatency(bestConnection.latency);
		logger.debug('Best connection found', {
			host: bestConnection.host,
			port: bestConnection.port,
			latency: bestConnection.latency,
		});
	}

	for (const url of urls) {
		const target = connectionCandidates.find((candidate) => candidate.url === url);
		let client: Redis | undefined;
		try {
			const startTime = Date.now();

			const adaptiveTimeout = bestConnection
				? Math.max(3000, bestConnection.latency * 3)
				: 5000;

			client = new Redis(url as string, {
				protocol: REDIS_PROTOCOL,
				connectTimeout: adaptiveTimeout,
				retryStrategy: () => null,
				lazyConnect: true,
			});
			// Missing optional servers are expected; suppress ioredis's unhandled-error output.
			client.on('error', () => undefined);

			await client.connect();

			const info = await client.info('server');
			const isKeyDB = info.includes('keydb_version');
			const version = extractVersion(info, isKeyDB);

			await client.quit();

			const connectionLatency = Date.now() - startTime;
			networkMonitor.recordLatency(connectionLatency);

			logger.info(`Detected ${isKeyDB ? 'KeyDB' : 'Redis'}`, {
				version,
				host: target?.host ?? 'local socket',
				port: target?.port,
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
			client?.disconnect();
			logger.debug('Failed to connect to Redis', {
				host: target?.host ?? 'local socket',
				port: target?.port,
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

function extractVersion(info: string, isKeyDB: boolean): string {
	const pattern = isKeyDB ? /keydb_version:([^\r\n]+)/ : /redis_version:([^\r\n]+)/;

	const match = info.match(pattern);
	return match ? match[1] : 'unknown';
}

export function createBullMQConnection(url: string): Redis {
	const client = new Redis(url, {
		protocol: REDIS_PROTOCOL,
		maxRetriesPerRequest: null, // Required for BullMQ
		enableReadyCheck: false,
		enableOfflineQueue: true,
		connectTimeout: 5000,
		disconnectTimeout: 2000,
		keepAlive: 30000,
	});

	client.on('connect', () => {
		logger.debug('Connected to KeyDB/Redis for job queue');
	});

	client.on('error', (error: Error) => {
		logger.error('KeyDB/Redis connection error', { error });
	});

	return client;
}
