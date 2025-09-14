/**
 * Predictive Caching with ML-Based Prefetching
 * Uses machine learning to predict access patterns and proactively cache content
 */

import { getLogger } from '../core/logger.js';
import { LockFreeHashMap, LockFreeQueue } from './lockfree-structures.js';

const logger = getLogger('predictive-cache');

interface AccessPattern {
	key: string;
	timestamp: number;
	frequency: number;
	context: string[];
	userSession: string;
	contentSize: number;
	accessDuration: number;
}

interface PredictionModel {
	weights: number[];
	bias: number;
	accuracy: number;
	trainingSize: number;
	lastUpdate: number;
}

interface CacheEntry<T> {
	value: T;
	timestamp: number;
	accessCount: number;
	lastAccess: number;
	predictedAccess: number;
	confidence: number;
	size: number;
	contextTags: string[];
}

interface PrefetchCandidate {
	key: string;
	priority: number;
	confidence: number;
	estimatedSize: number;
	contextMatch: number;
}

/**
 * Advanced predictive cache with ML-based prefetching
 * Learns from access patterns to predict future cache needs
 */
export class PredictiveCache<T> {
	private cache = new LockFreeHashMap<string, CacheEntry<T>>(512);
	private accessHistory = new LockFreeQueue<AccessPattern>();
	private prefetchQueue = new LockFreeQueue<PrefetchCandidate>();

	private readonly maxCacheSize: number;
	private readonly maxHistorySize = 10000;
	private readonly prefetchThreshold = 0.7;
	private readonly modelUpdateInterval = 1000; // Update model every 1000 accesses

	private currentCacheSize = 0;
	private totalAccesses = 0;
	private cacheHits = 0;
	private prefetchHits = 0;
	private model: PredictionModel;

	// Feature extractors for ML model
	private readonly featureExtractors = {
		timeOfDay: () => new Date().getHours() / 23,
		dayOfWeek: () => new Date().getDay() / 6,
		accessFrequency: (pattern: AccessPattern) => Math.log(pattern.frequency + 1) / 10,
		timeSinceLastAccess: (lastAccess: number) =>
			Math.min((Date.now() - lastAccess) / (60000 * 60), 1), // Hours, capped at 1
		contentSize: (size: number) => Math.log(size + 1) / 20,
		sessionLength: (pattern: AccessPattern) =>
			Math.min(pattern.accessDuration / (60000 * 30), 1), // 30 minutes max
		contextSimilarity: (context1: string[], context2: string[]) => {
			const intersection = context1.filter((x) => context2.includes(x));
			const union = [...new Set([...context1, ...context2])];
			return union.length > 0 ? intersection.length / union.length : 0;
		},
	};

	constructor(
		maxCacheSize: number = 100 * 1024 * 1024, // 100MB default
		private readonly dataLoader?: (key: string) => Promise<T>
	) {
		this.maxCacheSize = maxCacheSize;
		this.model = this.initializeModel();

		// Start background processes
		this.startPrefetchingLoop();
		this.startModelUpdateLoop();
		this.startCacheMaintenanceLoop();

		logger.info('Predictive cache initialized', {
			maxSize: this.formatBytes(maxCacheSize),
			prefetchThreshold: this.prefetchThreshold,
			modelFeatures: Object.keys(this.featureExtractors).length,
		});
	}

	/**
	 * Get value from cache with access pattern learning
	 */
	async get(
		key: string,
		context: string[] = [],
		userSession = 'default'
	): Promise<T | undefined> {
		const startTime = performance.now();
		this.totalAccesses++;

		const cacheEntry = this.cache.get(key);

		if (cacheEntry) {
			// Cache hit - update access patterns
			cacheEntry.accessCount++;
			cacheEntry.lastAccess = Date.now();
			this.cacheHits++;

			// Record successful access pattern
			this.recordAccessPattern({
				key,
				timestamp: Date.now(),
				frequency: cacheEntry.accessCount,
				context,
				userSession,
				contentSize: cacheEntry.size,
				accessDuration: performance.now() - startTime,
			});

			// Update prediction confidence
			if (cacheEntry.predictedAccess > 0) {
				this.prefetchHits++;
				cacheEntry.confidence = Math.min(cacheEntry.confidence * 1.1, 1.0);
			}

			logger.debug('Cache hit', {
				key: this.truncateKey(key),
				accessCount: cacheEntry.accessCount,
				confidence: cacheEntry.confidence.toFixed(3),
			});

			return cacheEntry.value;
		}

		// Cache miss - try to load data
		if (this.dataLoader) {
			try {
				const value = await this.dataLoader(key);
				await this.set(key, value, context, userSession);

				// Record access pattern for learning
				this.recordAccessPattern({
					key,
					timestamp: Date.now(),
					frequency: 1,
					context,
					userSession,
					contentSize: this.estimateSize(value),
					accessDuration: performance.now() - startTime,
				});

				logger.debug('Cache miss - loaded data', {
					key: this.truncateKey(key),
					size: this.formatBytes(this.estimateSize(value)),
				});

				return value;
			} catch (error) {
				logger.warn('Failed to load data for cache miss', {
					key: this.truncateKey(key),
					error,
				});
			}
		}

		return undefined;
	}

	/**
	 * Set value in cache with intelligent placement
	 */
	async set(
		key: string,
		value: T,
		context: string[] = [],
		userSession = 'default'
	): Promise<void> {
		const size = this.estimateSize(value);

		// Ensure we have space
		await this.ensureSpace(size);

		const entry: CacheEntry<T> = {
			value,
			timestamp: Date.now(),
			accessCount: 1,
			lastAccess: Date.now(),
			predictedAccess: this.predictNextAccess(key, context, userSession),
			confidence: 0.5,
			size,
			contextTags: [...context],
		};

		this.cache.set(key, entry);
		this.currentCacheSize += size;

		logger.debug('Cached item', {
			key: this.truncateKey(key),
			size: this.formatBytes(size),
			predicted: entry.predictedAccess.toFixed(3),
		});

		// Queue potential prefetch candidates based on this access
		this.queuePrefetchCandidates(key, context, userSession);
	}

	/**
	 * Delete item from cache
	 */
	delete(key: string): boolean {
		const entry = this.cache.get(key);
		if (entry) {
			this.currentCacheSize -= entry.size;
			this.cache.delete(key);
			logger.debug('Deleted cache entry', { key: this.truncateKey(key) });
			return true;
		}
		return false;
	}

	/**
	 * Clear entire cache
	 */
	clear(): void {
		this.cache = new LockFreeHashMap<string, CacheEntry<T>>(512);
		this.currentCacheSize = 0;
		logger.info('Cache cleared');
	}

	/**
	 * Get cache statistics
	 */
	getStats(): {
		hitRate: number;
		prefetchHitRate: number;
		size: number;
		maxSize: number;
		entryCount: number;
		modelAccuracy: number;
		predictions: number;
		totalAccesses: number;
	} {
		const hitRate = this.totalAccesses > 0 ? this.cacheHits / this.totalAccesses : 0;
		const prefetchHitRate = this.cacheHits > 0 ? this.prefetchHits / this.cacheHits : 0;

		return {
			hitRate,
			prefetchHitRate,
			size: this.currentCacheSize,
			maxSize: this.maxCacheSize,
			entryCount: this.cache.getSize(),
			modelAccuracy: this.model.accuracy,
			predictions: this.model.trainingSize,
			totalAccesses: this.totalAccesses,
		};
	}

	/**
	 * Force model retraining
	 */
	async retrainModel(): Promise<void> {
		await this.updateModel();
		logger.info('Model retrained', {
			accuracy: this.model.accuracy.toFixed(3),
			trainingSize: this.model.trainingSize,
		});
	}

	/**
	 * Get prefetch recommendations
	 */
	getPrefetchRecommendations(limit = 10): PrefetchCandidate[] {
		const candidates: PrefetchCandidate[] = [];
		const processed = new Set<string>();

		// Drain prefetch queue up to limit
		for (let i = 0; i < limit; i++) {
			const candidate = this.prefetchQueue.dequeue();
			if (!candidate || processed.has(candidate.key)) continue;

			processed.add(candidate.key);
			candidates.push(candidate);
		}

		// Sort by priority
		return candidates.sort((a, b) => b.priority - a.priority);
	}

	// Private methods

	private initializeModel(): PredictionModel {
		return {
			weights: new Array(7).fill(0).map(() => (Math.random() - 0.5) * 0.1),
			bias: 0,
			accuracy: 0.5,
			trainingSize: 0,
			lastUpdate: Date.now(),
		};
	}

	private recordAccessPattern(pattern: AccessPattern): void {
		this.accessHistory.enqueue(pattern);

		// Limit history size
		while (this.accessHistory.getSize() > this.maxHistorySize) {
			this.accessHistory.dequeue();
		}
	}

	private predictNextAccess(key: string, context: string[], userSession: string): number {
		// Extract features for prediction
		const features = [
			this.featureExtractors.timeOfDay(),
			this.featureExtractors.dayOfWeek(),
			context.length / 10, // Context richness
			userSession.length / 20, // Session complexity
			key.length / 100, // Key complexity
			Math.random() * 0.1, // Noise feature
			1.0, // Bias feature
		];

		// Simple linear model prediction
		let prediction = this.model.bias;
		for (let i = 0; i < Math.min(features.length, this.model.weights.length); i++) {
			prediction += features[i] * this.model.weights[i];
		}

		// Apply sigmoid activation
		return 1 / (1 + Math.exp(-prediction));
	}

	private async updateModel(): Promise<void> {
		if (this.accessHistory.getSize() < 100) return; // Need minimum training data

		const trainingData: Array<{ features: number[]; label: number }> = [];
		const patterns: AccessPattern[] = [];

		// Collect training patterns
		let pattern = this.accessHistory.dequeue();
		while (pattern && patterns.length < 1000) {
			patterns.push(pattern);
			pattern = this.accessHistory.dequeue();
		}

		// Re-queue patterns
		patterns.forEach((p) => this.accessHistory.enqueue(p));

		// Generate training examples
		for (let i = 0; i < patterns.length - 1; i++) {
			const current = patterns[i];
			const next = patterns[i + 1];

			// Check if next access was within reasonable time window
			const timeDiff = next.timestamp - current.timestamp;
			const wasAccessed = timeDiff < 60000 * 60 * 24; // Within 24 hours

			const features = [
				this.featureExtractors.timeOfDay(),
				this.featureExtractors.dayOfWeek(),
				this.featureExtractors.accessFrequency(current),
				this.featureExtractors.timeSinceLastAccess(current.timestamp),
				this.featureExtractors.contentSize(current.contentSize),
				this.featureExtractors.sessionLength(current),
				1.0, // Bias
			];

			trainingData.push({
				features,
				label: wasAccessed ? 1 : 0,
			});
		}

		if (trainingData.length < 50) return;

		// Simple gradient descent training
		const learningRate = 0.01;
		const epochs = 10;

		for (let epoch = 0; epoch < epochs; epoch++) {
			const _totalLoss = 0;

			for (const example of trainingData) {
				// Forward pass
				let prediction = this.model.bias;
				for (
					let i = 0;
					i < Math.min(example.features.length, this.model.weights.length);
					i++
				) {
					prediction += example.features[i] * this.model.weights[i];
				}
				prediction = 1 / (1 + Math.exp(-prediction)); // Sigmoid

				// Calculate loss (binary cross-entropy)
				const _loss = -(
					example.label * Math.log(prediction + 1e-15) +
					(1 - example.label) * Math.log(1 - prediction + 1e-15)
				);
				// Track loss for monitoring (commented out to avoid unused variable warning)
				// totalLoss += loss;

				// Backward pass
				const error = prediction - example.label;
				this.model.bias -= learningRate * error;

				for (
					let i = 0;
					i < Math.min(example.features.length, this.model.weights.length);
					i++
				) {
					this.model.weights[i] -= learningRate * error * example.features[i];
				}
			}

			// Update accuracy
			if (epoch === epochs - 1) {
				let correct = 0;
				for (const example of trainingData) {
					let prediction = this.model.bias;
					for (
						let i = 0;
						i < Math.min(example.features.length, this.model.weights.length);
						i++
					) {
						prediction += example.features[i] * this.model.weights[i];
					}
					prediction = 1 / (1 + Math.exp(-prediction));

					if (
						(prediction > 0.5 && example.label === 1) ||
						(prediction <= 0.5 && example.label === 0)
					) {
						correct++;
					}
				}
				this.model.accuracy = correct / trainingData.length;
			}
		}

		this.model.trainingSize = trainingData.length;
		this.model.lastUpdate = Date.now();

		logger.debug('Model updated', {
			accuracy: this.model.accuracy.toFixed(3),
			trainingSize: this.model.trainingSize,
			weights: this.model.weights.map((w) => w.toFixed(3)),
		});
	}

	private queuePrefetchCandidates(
		accessedKey: string,
		context: string[],
		userSession: string
	): void {
		// Simple pattern-based prefetch candidate generation
		const basePriority = this.predictNextAccess(accessedKey, context, userSession);

		// Generate related keys based on patterns
		const candidates = [
			`${accessedKey}_next`,
			`${accessedKey}_related`,
			`${userSession}_${context[0]}`,
			`recent_${context.join('_')}`,
		];

		for (const candidateKey of candidates) {
			if (!this.cache.get(candidateKey)) {
				const priority = basePriority * (0.5 + Math.random() * 0.5);
				const confidence = this.predictNextAccess(candidateKey, context, userSession);

				if (confidence > this.prefetchThreshold) {
					this.prefetchQueue.enqueue({
						key: candidateKey,
						priority,
						confidence,
						estimatedSize: 1024, // Rough estimate
						contextMatch: this.featureExtractors.contextSimilarity(context, [
							candidateKey,
						]),
					});
				}
			}
		}
	}

	private async ensureSpace(requiredSize: number): Promise<void> {
		while (this.currentCacheSize + requiredSize > this.maxCacheSize) {
			// Find least valuable item to evict
			let leastValuable: { key: string; score: number } | null = null;

			const cacheKeys = this.cache.keys();
			for (const key of cacheKeys) {
				const entry = this.cache.get(key);
				if (!entry) continue;

				// Calculate eviction score (lower is worse)
				const timeSinceAccess = Date.now() - entry.lastAccess;
				const ageHours = timeSinceAccess / (1000 * 60 * 60);
				const frequencyScore = Math.log(entry.accessCount + 1);
				const predictionScore = entry.predictedAccess * entry.confidence;
				const sizeScore = 1 / Math.log(entry.size + 1);

				const score = frequencyScore + predictionScore + sizeScore - ageHours / 24;

				if (!leastValuable || score < leastValuable.score) {
					leastValuable = { key, score };
				}
			}

			if (leastValuable) {
				this.delete(leastValuable.key);
				logger.debug('Evicted cache entry', {
					key: this.truncateKey(leastValuable.key),
					score: leastValuable.score.toFixed(3),
				});
			} else {
				break; // No items to evict
			}
		}
	}

	private startPrefetchingLoop(): void {
		const prefetchInterval = 5000; // 5 seconds

		setInterval(async () => {
			if (!this.dataLoader) return;

			const candidates = this.getPrefetchRecommendations(3);

			for (const candidate of candidates) {
				if (this.currentCacheSize + candidate.estimatedSize < this.maxCacheSize * 0.8) {
					try {
						const value = await this.dataLoader(candidate.key);
						await this.set(candidate.key, value, [candidate.key]);
						logger.debug('Prefetched data', {
							key: this.truncateKey(candidate.key),
							confidence: candidate.confidence.toFixed(3),
						});
					} catch (error) {
						// Prefetch failures are non-critical
						logger.debug('Prefetch failed', {
							key: this.truncateKey(candidate.key),
							error,
						});
					}
				}
			}
		}, prefetchInterval);
	}

	private startModelUpdateLoop(): void {
		const updateInterval = 60000; // 1 minute

		setInterval(async () => {
			if (this.totalAccesses % this.modelUpdateInterval === 0) {
				await this.updateModel();
			}
		}, updateInterval);
	}

	private startCacheMaintenanceLoop(): void {
		const maintenanceInterval = 300000; // 5 minutes

		setInterval(() => {
			// Clean up expired entries
			const now = Date.now();
			const maxAge = 24 * 60 * 60 * 1000; // 24 hours

			const keysToDelete: string[] = [];
			const cacheKeys = this.cache.keys();

			for (const key of cacheKeys) {
				const entry = this.cache.get(key);
				if (entry && now - entry.lastAccess > maxAge) {
					keysToDelete.push(key);
				}
			}

			keysToDelete.forEach((key) => this.delete(key));

			if (keysToDelete.length > 0) {
				logger.debug('Cache maintenance completed', {
					expiredEntries: keysToDelete.length,
				});
			}
		}, maintenanceInterval);
	}

	private estimateSize(value: T): number {
		if (value === null || value === undefined) return 8;
		if (typeof value === 'string') return value.length * 2; // UTF-16
		if (typeof value === 'number') return 8;
		if (typeof value === 'boolean') return 4;
		if (typeof value === 'object') {
			try {
				return JSON.stringify(value).length * 2;
			} catch {
				return 1024; // Default estimate
			}
		}
		return 1024; // Default estimate
	}

	private formatBytes(bytes: number): string {
		const sizes = ['B', 'KB', 'MB', 'GB'];
		if (bytes === 0) return '0 B';
		const i = Math.floor(Math.log(bytes) / Math.log(1024));
		return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
	}

	private truncateKey(key: string): string {
		return key.length > 50 ? `${key.substring(0, 47)}...` : key;
	}
}

/**
 * Factory for creating optimized predictive caches
 */
export class PredictiveCacheFactory {
	/**
	 * Create content analysis cache with optimized settings
	 */
	static createAnalysisCache<T>(dataLoader?: (key: string) => Promise<T>): PredictiveCache<T> {
		return new PredictiveCache<T>(50 * 1024 * 1024, dataLoader); // 50MB for analysis
	}

	/**
	 * Create document cache with large capacity
	 */
	static createDocumentCache<T>(dataLoader?: (key: string) => Promise<T>): PredictiveCache<T> {
		return new PredictiveCache<T>(200 * 1024 * 1024, dataLoader); // 200MB for documents
	}

	/**
	 * Create small metadata cache
	 */
	static createMetadataCache<T>(dataLoader?: (key: string) => Promise<T>): PredictiveCache<T> {
		return new PredictiveCache<T>(10 * 1024 * 1024, dataLoader); // 10MB for metadata
	}
}

// Export singleton instances for common use cases
export const analysisCache = PredictiveCacheFactory.createAnalysisCache();
export const documentCache = PredictiveCacheFactory.createDocumentCache();
export const metadataCache = PredictiveCacheFactory.createMetadataCache();
