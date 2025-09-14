/**
 * Dynamic Memory Evolution and Novel Concept Generation for HHM
 * Implements memory consolidation, forgetting, and creative concept synthesis
 */

import { HyperVector } from './hypervector.js';
import type { HolographicMemorySubstrate, MemoryEntry } from './memory-substrate.js';
import { LogicalOperations } from './logical-operations.js';
import { getLogger } from '../../../core/logger.js';

const logger = getLogger('hhm-memory-evolution');

export interface ConceptCandidate {
	vector: HyperVector;
	name: string;
	components: string[];
	novelty: number;
	coherence: number;
	utility: number;
}

export interface EvolutionConfig {
	consolidationInterval: number; // ms
	consolidationThreshold: number; // access count
	decayRate: number; // 0-1
	decayInterval: number; // ms
	creativityThreshold: number; // 0-1
	minNovelty: number; // 0-1
	minCoherence: number; // 0-1
}

export class MemoryEvolution {
	private substrate: HolographicMemorySubstrate;
	private logical: LogicalOperations;
	private config: EvolutionConfig;
	private consolidationTimer?: NodeJS.Timeout;
	private decayTimer?: NodeJS.Timeout;
	private conceptHistory: Map<string, ConceptCandidate> = new Map();

	constructor(substrate: HolographicMemorySubstrate, config?: Partial<EvolutionConfig>) {
		this.substrate = substrate;
		this.logical = new LogicalOperations();
		this.config = {
			consolidationInterval: 60000, // 1 minute
			consolidationThreshold: 5,
			decayRate: 0.01,
			decayInterval: 300000, // 5 minutes
			creativityThreshold: 0.6,
			minNovelty: 0.4,
			minCoherence: 0.3,
			...config,
		};
	}

	/**
	 * Start automatic memory evolution processes
	 */
	start(): void {
		// Start consolidation cycle
		this.consolidationTimer = setInterval(
			() => this.consolidateMemories(),
			this.config.consolidationInterval
		);

		// Start decay cycle
		this.decayTimer = setInterval(() => this.decayMemories(), this.config.decayInterval);

		logger.info('Memory evolution started', {
			consolidationInterval: this.config.consolidationInterval,
			decayInterval: this.config.decayInterval,
		});
	}

	/**
	 * Stop automatic memory evolution
	 */
	stop(): void {
		if (this.consolidationTimer) {
			clearInterval(this.consolidationTimer);
		}
		if (this.decayTimer) {
			clearInterval(this.decayTimer);
		}

		logger.info('Memory evolution stopped');
	}

	/**
	 * Consolidate frequently accessed memories
	 */
	private async consolidateMemories(): Promise<void> {
		const stats = this.substrate.getStats();
		logger.debug('Starting memory consolidation', { stats });

		await this.substrate.consolidate(this.config.consolidationThreshold);

		// After consolidation, attempt to generate novel concepts
		await this.generateNovelConcepts();
	}

	/**
	 * Apply decay to old memories
	 */
	private async decayMemories(): Promise<void> {
		const stats = this.substrate.getStats();
		logger.debug('Starting memory decay', { stats });

		await this.substrate.decay(this.config.decayRate);
	}

	/**
	 * Generate novel concepts through creative binding
	 */
	async generateNovelConcepts(): Promise<ConceptCandidate[]> {
		// Retrieve recent, strong memories
		const queryVector = new HyperVector(); // Random probe
		const memories = await this.substrate.retrieve(queryVector, 50, 0.2);

		if (memories.length < 2) {
			return [];
		}

		const candidates: ConceptCandidate[] = [];

		// Try different combinations
		for (let i = 0; i < memories.length - 1; i++) {
			for (let j = i + 1; j < memories.length; j++) {
				const mem1 = memories[i].entry;
				const mem2 = memories[j].entry;

				// Skip if too similar (likely related)
				const similarity = mem1.vector.similarity(mem2.vector);
				if (similarity > 0.7 || similarity < 0.2) {
					continue;
				}

				// Create novel combination
				const candidate = this.synthesizeConcept(mem1, mem2);

				if (candidate && this.evaluateConcept(candidate)) {
					candidates.push(candidate);
					this.conceptHistory.set(candidate.name, candidate);
				}
			}
		}

		if (candidates.length > 0) {
			logger.info('Novel concepts generated', {
				count: candidates.length,
				topConcept: candidates[0].name,
			});
		}

		return candidates;
	}

	/**
	 * Synthesize a new concept from two memories
	 */
	private synthesizeConcept(mem1: MemoryEntry, mem2: MemoryEntry): ConceptCandidate | null {
		// Try different synthesis operations
		const operations = [
			() => mem1.vector.bind(mem2.vector), // Direct binding
			() => HyperVector.bundle([mem1.vector, mem2.vector]), // Bundling
			() => this.logical.analogy(mem1.vector, mem2.vector, new HyperVector()).vector, // Analogical
			() => this.blendVectors(mem1.vector, mem2.vector, 0.5), // Interpolation
		];

		// Randomly select a synthesis method
		const operation = operations[Math.floor(Math.random() * operations.length)];
		const synthesized = operation();

		// Generate a name for the concept
		const name = this.generateConceptName(mem1.id, mem2.id);

		// Calculate novelty
		const novelty = this.calculateNovelty(synthesized);

		// Calculate coherence
		const coherence = this.calculateCoherence(synthesized, [mem1.vector, mem2.vector]);

		// Calculate utility (based on potential connections)
		const utility = this.calculateUtility(synthesized);

		if (novelty < this.config.minNovelty || coherence < this.config.minCoherence) {
			return null;
		}

		return {
			vector: synthesized,
			name,
			components: [mem1.id, mem2.id],
			novelty,
			coherence,
			utility,
		};
	}

	/**
	 * Blend two vectors with weighted interpolation
	 */
	private blendVectors(v1: HyperVector, v2: HyperVector, weight: number): HyperVector {
		const components1 = v1.getComponents();
		const components2 = v2.getComponents();
		const blended = new Int8Array(components1.length);

		for (let i = 0; i < components1.length; i++) {
			const weighted = components1[i] * weight + components2[i] * (1 - weight);
			blended[i] = weighted >= 0 ? 1 : -1;
		}

		return new HyperVector(components1.length, blended);
	}

	/**
	 * Calculate novelty of a concept
	 */
	private calculateNovelty(concept: HyperVector): number {
		// Use a simple heuristic for novelty based on vector randomness
		const components = concept.getComponents();
		let uniqueness = 0;

		// Check distribution of +1 and -1 values
		let positiveCount = 0;
		for (const component of components) {
			if (component > 0) positiveCount++;
		}

		// More balanced distribution = higher novelty
		const balance = Math.abs(0.5 - positiveCount / components.length);
		uniqueness = 1.0 - balance * 2; // Convert to 0-1 scale

		return Math.max(0, Math.min(1, uniqueness));
	}

	/**
	 * Calculate coherence of a concept
	 */
	private calculateCoherence(concept: HyperVector, components: HyperVector[]): number {
		// Check if the concept preserves information from components
		let totalPreservation = 0;

		for (const component of components) {
			const similarity = concept.similarity(component);
			totalPreservation += similarity;
		}

		return totalPreservation / components.length;
	}

	/**
	 * Calculate utility of a concept
	 */
	private calculateUtility(concept: HyperVector): number {
		// Simple utility heuristic based on vector properties
		const components = concept.getComponents();

		// Calculate sparsity (utility increases with moderate sparsity)
		let zeroCount = 0;
		for (const component of components) {
			if (component === 0) zeroCount++;
		}

		const sparsity = zeroCount / components.length;
		// Optimal sparsity around 0.1-0.3 for hypervectors
		const optimalSparsity = 0.2;
		const sparsityScore = 1.0 - Math.abs(sparsity - optimalSparsity) / optimalSparsity;

		return Math.max(0, Math.min(1, sparsityScore));
	}

	/**
	 * Evaluate if a concept candidate is worth keeping
	 */
	private evaluateConcept(candidate: ConceptCandidate): boolean {
		// Weighted evaluation
		const score = candidate.novelty * 0.4 + candidate.coherence * 0.3 + candidate.utility * 0.3;

		return score >= this.config.creativityThreshold;
	}

	/**
	 * Generate a name for a novel concept
	 */
	private generateConceptName(component1: string, component2: string): string {
		// Extract meaningful parts from component IDs
		const part1 = component1.split('_')[0].substring(0, 4);
		const part2 = component2.split('_')[0].substring(0, 4);
		const timestamp = Date.now().toString(36).substring(-4);

		return `novel_${part1}_${part2}_${timestamp}`;
	}

	/**
	 * Store a generated concept as a new memory
	 */
	async storeConcept(candidate: ConceptCandidate): Promise<void> {
		await this.substrate.store(candidate.name, candidate.vector, {
			modality: 'generated',
			context: {
				components: candidate.components,
				novelty: candidate.novelty,
				coherence: candidate.coherence,
				utility: candidate.utility,
				generatedAt: Date.now(),
			},
			tags: ['generated', 'novel', 'creative'],
		});

		logger.info('Novel concept stored', {
			name: candidate.name,
			novelty: candidate.novelty,
			coherence: candidate.coherence,
		});
	}

	/**
	 * Evolve a specific memory through targeted operations
	 */
	async evolveMemory(
		memoryId: string,
		evolutionType: 'strengthen' | 'weaken' | 'mutate'
	): Promise<void> {
		const memory = this.substrate.get(memoryId);
		if (!memory) {
			throw new Error(`Memory ${memoryId} not found`);
		}

		switch (evolutionType) {
			case 'strengthen':
				// Re-bind with reinforcement vector
				const reinforcement = new HyperVector();
				memory.vector = memory.vector.bind(reinforcement);
				memory.metadata.strength *= 1.5;
				break;

			case 'weaken':
				// Add noise to weaken
				memory.vector = memory.vector.addNoise(0.1);
				memory.metadata.strength *= 0.7;
				break;

			case 'mutate':
				// Creative mutation
				const mutation = new HyperVector();
				memory.vector = this.blendVectors(memory.vector, mutation, 0.8);
				memory.metadata.context = {
					...memory.metadata.context,
					mutated: true,
					mutationTime: Date.now(),
				};
				break;
		}

		// Update in substrate
		await this.substrate.store(memoryId, memory.vector, memory.metadata);

		logger.info('Memory evolved', { memoryId, evolutionType });
	}

	/**
	 * Perform dream-like recombination of memories
	 */
	async dream(duration: number = 10000): Promise<ConceptCandidate[]> {
		logger.info('Starting dream phase', { duration });

		const startTime = Date.now();
		const dreamConcepts: ConceptCandidate[] = [];

		while (Date.now() - startTime < duration) {
			// Generate concepts with relaxed constraints
			const originalThreshold = this.config.creativityThreshold;
			const originalMinNovelty = this.config.minNovelty;
			const originalMinCoherence = this.config.minCoherence;

			// Relax constraints for dreaming
			this.config.creativityThreshold *= 0.5;
			this.config.minNovelty *= 0.5;
			this.config.minCoherence *= 0.5;

			const concepts = await this.generateNovelConcepts();
			dreamConcepts.push(...concepts);

			// Restore original constraints
			this.config.creativityThreshold = originalThreshold;
			this.config.minNovelty = originalMinNovelty;
			this.config.minCoherence = originalMinCoherence;

			// Brief pause between dream cycles
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		logger.info('Dream phase complete', {
			duration,
			conceptsGenerated: dreamConcepts.length,
		});

		return dreamConcepts;
	}

	/**
	 * Get statistics about memory evolution
	 */
	getEvolutionStats(): Record<string, unknown> {
		return {
			conceptsGenerated: this.conceptHistory.size,
			substrateStats: this.substrate.getStats(),
			config: this.config,
			recentConcepts: Array.from(this.conceptHistory.values())
				.slice(-10)
				.map((c) => ({
					name: c.name,
					novelty: c.novelty,
					coherence: c.coherence,
					utility: c.utility,
				})),
		};
	}

	/**
	 * Clean up resources
	 */
	destroy(): void {
		this.stop();
		this.conceptHistory.clear();
	}
}
