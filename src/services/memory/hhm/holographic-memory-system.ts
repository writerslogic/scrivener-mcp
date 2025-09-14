/**
 * Holographic Hyperdimensional Memory System
 * Main integration point for all HHM components
 */

import type { HyperVector } from './hypervector.js';
import { SemanticVectors } from './hypervector.js';
import type { MemoryEntry, RetrievalResult } from './memory-substrate.js';
import { HolographicMemorySubstrate } from './memory-substrate.js';
import {
	MultiModalEncoder,
	TextEncoder,
	DocumentStructureEncoder,
	ConceptEncoder,
} from './multimodal-encoder.js';
import type { LogicalResult } from './logical-operations.js';
import { LogicalOperations } from './logical-operations.js';
import type { ConceptCandidate, EvolutionConfig } from './memory-evolution.js';
import { MemoryEvolution } from './memory-evolution.js';
import { getLogger } from '../../../core/logger.js';
import type { ScrivenerDocument } from '../../../types/index.js';

const logger = getLogger('holographic-memory-system');

export interface HHMConfig {
	dimensions?: number;
	maxMemories?: number;
	useGPU?: boolean;
	evolution?: Partial<EvolutionConfig>;
	similarityThreshold?: number;
	autoEvolve?: boolean;
}

export interface MemoryFormationResult {
	id: string;
	vector: HyperVector;
	modalities: string[];
	metadata: Record<string, unknown>;
}

export interface QueryResult extends RetrievalResult {
	reconstructed?: unknown;
	explanation?: string;
}

export class HolographicMemorySystem {
	private dimensions: number;
	private substrate: HolographicMemorySubstrate;
	private encoder: MultiModalEncoder;
	private logical: LogicalOperations;
	private evolution: MemoryEvolution;
	private config: HHMConfig;
	private memoryIndex: Map<string, { modality: string; originalData?: unknown }> = new Map();

	constructor(config: HHMConfig = {}) {
		this.config = {
			dimensions: 10000,
			maxMemories: 1000000,
			useGPU: false,
			similarityThreshold: 0.4,
			autoEvolve: true,
			...config,
		};

		this.dimensions = this.config.dimensions!;

		// Initialize core components
		this.substrate = new HolographicMemorySubstrate(
			this.dimensions,
			this.config.maxMemories,
			this.config.useGPU
		);

		this.encoder = new MultiModalEncoder(this.dimensions);
		this.logical = new LogicalOperations(this.dimensions, this.config.similarityThreshold);
		this.evolution = new MemoryEvolution(this.substrate, this.config.evolution);

		// Initialize semantic vectors
		SemanticVectors.setDimensions(this.dimensions);

		// Start evolution if enabled
		if (this.config.autoEvolve) {
			this.evolution.start();
		}

		logger.info('Holographic Memory System initialized', {
			dimensions: this.dimensions,
			maxMemories: this.config.maxMemories,
			useGPU: this.config.useGPU,
			autoEvolve: this.config.autoEvolve,
		});
	}

	/**
	 * Form a memory from text input
	 */
	async memorizeText(text: string, id?: string): Promise<MemoryFormationResult> {
		const memoryId = id || `text_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

		const encoded = await this.encoder.encode(text, 'text');

		await this.substrate.store(memoryId, encoded.vector, {
			modality: encoded.modality,
			context: encoded.metadata,
			timestamp: Date.now(),
		});

		this.memoryIndex.set(memoryId, {
			modality: 'text',
			originalData: text,
		});

		logger.debug('Text memorized', { id: memoryId, length: text.length });

		return {
			id: memoryId,
			vector: encoded.vector,
			modalities: ['text'],
			metadata: encoded.metadata,
		};
	}

	/**
	 * Form a memory from a Scrivener document
	 */
	async memorizeDocument(document: ScrivenerDocument): Promise<MemoryFormationResult> {
		const memoryId = `doc_${document.id}_${Date.now()}`;

		const encoded = await this.encoder.encode(document, 'document');

		await this.substrate.store(memoryId, encoded.vector, {
			modality: encoded.modality,
			context: { ...encoded.metadata, documentId: document.id },
			timestamp: Date.now(),
		});

		this.memoryIndex.set(memoryId, {
			modality: 'document',
			originalData: document,
		});

		logger.debug('Document memorized', {
			id: memoryId,
			documentId: document.id,
			title: document.title,
		});

		return {
			id: memoryId,
			vector: encoded.vector,
			modalities: ['document'],
			metadata: encoded.metadata,
		};
	}

	/**
	 * Form a composite memory from multiple inputs
	 */
	async memorizeComposite(
		inputs: Array<{ data: unknown; modality: string; id?: string }>
	): Promise<MemoryFormationResult> {
		const memoryId = `composite_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

		const composite = await this.encoder.encodeComposite(inputs);
		const modalities = inputs.map((i) => i.modality);

		await this.substrate.store(memoryId, composite, {
			modality: 'composite',
			context: { modalities, componentCount: inputs.length },
			timestamp: Date.now(),
		});

		this.memoryIndex.set(memoryId, {
			modality: 'composite',
			originalData: inputs,
		});

		logger.debug('Composite memory formed', {
			id: memoryId,
			modalities,
			componentCount: inputs.length,
		});

		return {
			id: memoryId,
			vector: composite,
			modalities,
			metadata: { componentCount: inputs.length },
		};
	}

	/**
	 * Form a temporal sequence memory
	 */
	async memorizeSequence(
		events: Array<{ data: unknown; modality: string; timestamp?: number }>
	): Promise<MemoryFormationResult> {
		const memoryId = `sequence_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

		const sequence = await this.encoder.encodeSequence(events);
		const modalities = [...new Set(events.map((e) => e.modality))];

		await this.substrate.store(memoryId, sequence, {
			modality: 'sequence',
			context: { modalities, eventCount: events.length },
			timestamp: Date.now(),
		});

		this.memoryIndex.set(memoryId, {
			modality: 'sequence',
			originalData: events,
		});

		logger.debug('Sequence memory formed', {
			id: memoryId,
			eventCount: events.length,
		});

		return {
			id: memoryId,
			vector: sequence,
			modalities,
			metadata: { eventCount: events.length },
		};
	}

	/**
	 * Remember a logical relationship
	 */
	async memorizeRelationship(
		subject: HyperVector | string,
		relation: string,
		object: HyperVector | string
	): Promise<MemoryFormationResult> {
		const memoryId = `relation_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

		// Convert strings to vectors if needed
		const subjectVector =
			typeof subject === 'string'
				? (await this.encoder.encode(subject, 'text')).vector
				: subject;
		const objectVector =
			typeof object === 'string'
				? (await this.encoder.encode(object, 'text')).vector
				: object;

		let relationVector: HyperVector;
		let logicalResult: LogicalResult;

		// Apply appropriate logical operation based on relation type
		switch (relation.toLowerCase()) {
			case 'causes':
				logicalResult = this.logical.causes(subjectVector, objectVector);
				break;
			case 'before':
				logicalResult = this.logical.before(subjectVector, objectVector);
				break;
			case 'after':
				logicalResult = this.logical.after(subjectVector, objectVector);
				break;
			case 'at':
				logicalResult = this.logical.at(subjectVector, objectVector);
				break;
			case 'has':
				logicalResult = this.logical.has(subjectVector, objectVector);
				break;
			case 'is':
				logicalResult = this.logical.is(subjectVector, objectVector);
				break;
			case 'like':
				logicalResult = this.logical.like(subjectVector, objectVector);
				break;
			default:
				// Generic relation
				const relVector = SemanticVectors.get(relation.toUpperCase());
				relationVector = subjectVector.bind(relVector).bind(objectVector);
				logicalResult = {
					vector: relationVector,
					operation: 'custom_relation',
					confidence: 0.8,
				};
		}

		await this.substrate.store(memoryId, logicalResult.vector, {
			modality: 'relation',
			context: {
				relationType: relation,
				operation: logicalResult.operation,
				confidence: logicalResult.confidence,
			},
			timestamp: Date.now(),
		});

		logger.debug('Relationship memorized', {
			id: memoryId,
			relation,
			confidence: logicalResult.confidence,
		});

		return {
			id: memoryId,
			vector: logicalResult.vector,
			modalities: ['relation'],
			metadata: {
				relation,
				confidence: logicalResult.confidence,
			},
		};
	}

	/**
	 * Query memory with text
	 */
	async queryText(text: string, k: number = 10): Promise<QueryResult[]> {
		const encoded = await this.encoder.encode(text, 'text');
		return this.query(encoded.vector, k);
	}

	/**
	 * Query memory with a hypervector
	 */
	async query(queryVector: HyperVector, k: number = 10): Promise<QueryResult[]> {
		const results = await this.substrate.retrieve(queryVector, k);

		// Enhance results with reconstruction attempts
		const enhanced: QueryResult[] = [];

		for (const result of results) {
			const indexEntry = this.memoryIndex.get(result.entry.id);

			enhanced.push({
				...result,
				reconstructed: indexEntry?.originalData,
				explanation: this.explainMemory(result.entry),
			});
		}

		logger.debug('Memory queried', {
			resultsFound: enhanced.length,
			topSimilarity: enhanced[0]?.similarity,
		});

		return enhanced;
	}

	/**
	 * Perform analogical reasoning
	 */
	async findAnalogy(a: string, b: string, c: string): Promise<QueryResult[]> {
		// Encode the inputs
		const aVec = (await this.encoder.encode(a, 'text')).vector;
		const bVec = (await this.encoder.encode(b, 'text')).vector;
		const cVec = (await this.encoder.encode(c, 'text')).vector;

		// Find D such that A:B :: C:D
		const analogyResult = this.logical.analogy(aVec, bVec, cVec);

		// Find memories similar to the predicted D
		const results = await this.query(analogyResult.vector, 5);

		logger.info('Analogy computed', {
			confidence: analogyResult.confidence,
			resultsFound: results.length,
		});

		return results;
	}

	/**
	 * Check logical consistency of stored memories
	 */
	async checkConsistency(memoryIds: string[]): Promise<{
		consistent: boolean;
		conflicts?: Array<{ id1: string; id2: string; issue: string }>;
	}> {
		const memories: HyperVector[] = [];
		const idMap: string[] = [];

		for (const id of memoryIds) {
			const memory = this.substrate.get(id);
			if (memory) {
				memories.push(memory.vector);
				idMap.push(id);
			}
		}

		const consistency = this.logical.checkConsistency(memories);

		if (!consistency.consistent && consistency.conflicts) {
			const conflicts = consistency.conflicts.map((c) => ({
				id1: idMap[c.i],
				id2: idMap[c.j],
				issue: `Potential contradiction (similarity: ${c.similarity.toFixed(3)})`,
			}));

			return { consistent: false, conflicts };
		}

		return { consistent: true };
	}

	/**
	 * Generate novel concepts
	 */
	async generateConcepts(): Promise<ConceptCandidate[]> {
		return this.evolution.generateNovelConcepts();
	}

	/**
	 * Enter dream mode for creative recombination
	 */
	async dream(duration: number = 10000): Promise<ConceptCandidate[]> {
		logger.info('Entering dream mode', { duration });
		const concepts = await this.evolution.dream(duration);

		// Optionally store the most promising concepts
		const topConcepts = concepts
			.sort((a, b) => b.novelty * b.coherence - a.novelty * a.coherence)
			.slice(0, 5);

		for (const concept of topConcepts) {
			await this.evolution.storeConcept(concept);
		}

		logger.info('Dream mode complete', {
			conceptsGenerated: concepts.length,
			conceptsStored: topConcepts.length,
		});

		return concepts;
	}

	/**
	 * Explain what a memory represents
	 */
	private explainMemory(entry: MemoryEntry): string {
		const parts: string[] = [];

		if (entry.metadata.modality) {
			parts.push(`Type: ${entry.metadata.modality}`);
		}

		if (entry.metadata.strength) {
			parts.push(`Strength: ${entry.metadata.strength.toFixed(2)}`);
		}

		if (entry.metadata.accessCount) {
			parts.push(`Accessed: ${entry.metadata.accessCount} times`);
		}

		if (entry.metadata.tags) {
			parts.push(`Tags: ${(entry.metadata.tags as string[]).join(', ')}`);
		}

		return parts.join(' | ');
	}

	/**
	 * Get system statistics
	 */
	getStats(): Record<string, unknown> {
		return {
			dimensions: this.dimensions,
			substrate: this.substrate.getStats(),
			evolution: this.evolution.getEvolutionStats(),
			indexSize: this.memoryIndex.size,
			modalities: this.encoder.getRegisteredModalities(),
		};
	}

	/**
	 * Export memory snapshot
	 */
	async exportSnapshot(): Promise<{
		config: HHMConfig;
		stats: Record<string, unknown>;
		timestamp: number;
	}> {
		return {
			config: this.config,
			stats: this.getStats(),
			timestamp: Date.now(),
		};
	}

	/**
	 * Clean up and destroy the system
	 */
	async destroy(): Promise<void> {
		logger.info('Destroying Holographic Memory System');

		this.evolution.destroy();
		await this.substrate.destroy();
		this.memoryIndex.clear();

		logger.info('Holographic Memory System destroyed');
	}
}
