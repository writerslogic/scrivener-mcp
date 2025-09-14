/**
 * Multi-Modal Encoder for HHM
 * Maps different data types (text, images, audio) to hypervectors
 */

import { HyperVector } from './hypervector.js';
import { getLogger } from '../../../core/logger.js';
import type { ScrivenerDocument } from '../../../types/index.js';

const logger = getLogger('hhm-multimodal-encoder');

export interface EncodingResult {
	vector: HyperVector;
	modality: string;
	metadata: Record<string, unknown>;
}

export abstract class ModalityEncoder {
	protected dimensions: number;

	constructor(dimensions: number = 10000) {
		this.dimensions = dimensions;
	}

	abstract encode(input: unknown): Promise<EncodingResult>;
	abstract getModality(): string;
}

/**
 * Text encoder using character n-grams and semantic hashing
 */
export class TextEncoder extends ModalityEncoder {
	private wordVectors: Map<string, HyperVector> = new Map();
	private ngramSize: number;

	constructor(dimensions: number = 10000, ngramSize: number = 3) {
		super(dimensions);
		this.ngramSize = ngramSize;
	}

	async encode(text: string): Promise<EncodingResult> {
		const words = this.tokenize(text);
		const wordVectors: HyperVector[] = [];

		for (const word of words) {
			let wordVector = this.wordVectors.get(word);

			if (!wordVector) {
				// Create new vector for unknown word using n-gram encoding
				wordVector = this.encodeWordWithNgrams(word);
				this.wordVectors.set(word, wordVector);
			}

			wordVectors.push(wordVector);
		}

		// Combine word vectors with positional encoding
		const textVector = this.combineWithPosition(wordVectors);

		return {
			vector: textVector,
			modality: 'text',
			metadata: {
				wordCount: words.length,
				uniqueWords: new Set(words).size,
				textLength: text.length,
			},
		};
	}

	private tokenize(text: string): string[] {
		// Simple tokenization - can be replaced with more sophisticated methods
		return text
			.toLowerCase()
			.replace(/[^\w\s]/g, ' ')
			.split(/\s+/)
			.filter((word) => word.length > 0);
	}

	private encodeWordWithNgrams(word: string): HyperVector {
		const ngrams = this.extractNgrams(word);
		const ngramVectors: HyperVector[] = [];

		for (const ngram of ngrams) {
			// Create deterministic vector for each n-gram
			const seed = this.hashString(ngram);
			ngramVectors.push(this.createSeededVector(seed));
		}

		// Bundle n-gram vectors to create word vector
		return HyperVector.bundle(ngramVectors);
	}

	private extractNgrams(word: string): string[] {
		const ngrams: string[] = [];
		const paddedWord = `#${word}#`; // Add boundary markers

		for (let i = 0; i <= paddedWord.length - this.ngramSize; i++) {
			ngrams.push(paddedWord.substring(i, i + this.ngramSize));
		}

		return ngrams;
	}

	private combineWithPosition(vectors: HyperVector[]): HyperVector {
		if (vectors.length === 0) {
			return new HyperVector(this.dimensions);
		}

		// Apply positional encoding through permutation
		const positionEncoded = vectors.map((vector, index) => {
			// Each position gets a unique permutation
			return vector.permute(index);
		});

		// Bundle all position-encoded vectors
		return HyperVector.bundle(positionEncoded);
	}

	private hashString(str: string): number {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash = hash & hash;
		}
		return Math.abs(hash);
	}

	private createSeededVector(seed: number): HyperVector {
		const components = new Int8Array(this.dimensions);
		let rand = seed;

		for (let i = 0; i < this.dimensions; i++) {
			rand = (rand * 1664525 + 1013904223) & 0xffffffff;
			components[i] = rand & 1 ? 1 : -1;
		}

		return new HyperVector(this.dimensions, components);
	}

	getModality(): string {
		return 'text';
	}
}

/**
 * Document structure encoder for Scrivener documents
 */
export class DocumentStructureEncoder extends ModalityEncoder {
	private textEncoder: TextEncoder;

	constructor(dimensions: number = 10000) {
		super(dimensions);
		this.textEncoder = new TextEncoder(dimensions);
	}

	async encode(document: ScrivenerDocument): Promise<EncodingResult> {
		const components: HyperVector[] = [];

		// Encode title
		if (document.title) {
			const titleResult = await this.textEncoder.encode(document.title);
			// Give title special weight
			components.push(titleResult.vector);
			components.push(titleResult.vector); // Double weight
		}

		// Encode synopsis
		if (document.synopsis) {
			const synopsisResult = await this.textEncoder.encode(document.synopsis);
			components.push(synopsisResult.vector);
		}

		// Encode content
		if (document.content) {
			const contentResult = await this.textEncoder.encode(document.content);
			components.push(contentResult.vector);
		}

		// Encode notes
		if (document.notes) {
			const notesResult = await this.textEncoder.encode(document.notes);
			components.push(notesResult.vector);
		}

		// Encode document type as semantic vector
		const typeVector = this.encodeDocumentType(document.type);
		components.push(typeVector);

		// Bundle all components
		const documentVector = HyperVector.bundle(components);

		return {
			vector: documentVector,
			modality: 'document',
			metadata: {
				documentId: document.id,
				documentType: document.type,
				wordCount: document.wordCount,
				hasChildren: document.children && document.children.length > 0,
			},
		};
	}

	private encodeDocumentType(type: string): HyperVector {
		// Create consistent vectors for document types
		const seed = this.hashString(`DOCTYPE_${type}`);
		return this.createSeededVector(seed);
	}

	private hashString(str: string): number {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash = hash & hash;
		}
		return Math.abs(hash);
	}

	private createSeededVector(seed: number): HyperVector {
		const components = new Int8Array(this.dimensions);
		let rand = seed;

		for (let i = 0; i < this.dimensions; i++) {
			rand = (rand * 1664525 + 1013904223) & 0xffffffff;
			components[i] = rand & 1 ? 1 : -1;
		}

		return new HyperVector(this.dimensions, components);
	}

	getModality(): string {
		return 'document';
	}
}

/**
 * Concept encoder for abstract ideas and relationships
 */
export class ConceptEncoder extends ModalityEncoder {
	private conceptVectors: Map<string, HyperVector> = new Map();

	async encode(concept: {
		name: string;
		attributes?: Record<string, string>;
	}): Promise<EncodingResult> {
		let baseVector = this.conceptVectors.get(concept.name);

		if (!baseVector) {
			// Create new vector for concept
			const seed = this.hashString(concept.name);
			baseVector = this.createSeededVector(seed);
			this.conceptVectors.set(concept.name, baseVector);
		}

		// If attributes provided, bind them to the base vector
		let conceptVector = baseVector;
		if (concept.attributes) {
			for (const [key, value] of Object.entries(concept.attributes)) {
				const attrVector = this.createAttributeVector(key, value);
				conceptVector = conceptVector.bind(attrVector);
			}
		}

		return {
			vector: conceptVector,
			modality: 'concept',
			metadata: {
				conceptName: concept.name,
				attributeCount: Object.keys(concept.attributes || {}).length,
			},
		};
	}

	private createAttributeVector(key: string, value: string): HyperVector {
		const keySeed = this.hashString(`ATTR_KEY_${key}`);
		const valueSeed = this.hashString(`ATTR_VAL_${value}`);

		const keyVector = this.createSeededVector(keySeed);
		const valueVector = this.createSeededVector(valueSeed);

		// Bind key and value
		return keyVector.bind(valueVector);
	}

	private hashString(str: string): number {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash = hash & hash;
		}
		return Math.abs(hash);
	}

	private createSeededVector(seed: number): HyperVector {
		const components = new Int8Array(this.dimensions);
		let rand = seed;

		for (let i = 0; i < this.dimensions; i++) {
			rand = (rand * 1664525 + 1013904223) & 0xffffffff;
			components[i] = rand & 1 ? 1 : -1;
		}

		return new HyperVector(this.dimensions, components);
	}

	getModality(): string {
		return 'concept';
	}
}

/**
 * Multi-modal encoder manager
 */
export class MultiModalEncoder {
	private encoders: Map<string, ModalityEncoder> = new Map();
	private dimensions: number;

	constructor(dimensions: number = 10000) {
		this.dimensions = dimensions;

		// Register default encoders
		this.registerEncoder('text', new TextEncoder(dimensions));
		this.registerEncoder('document', new DocumentStructureEncoder(dimensions));
		this.registerEncoder('concept', new ConceptEncoder(dimensions));
	}

	registerEncoder(modality: string, encoder: ModalityEncoder): void {
		this.encoders.set(modality, encoder);
		logger.info('Encoder registered', { modality });
	}

	async encode(input: unknown, modality: string): Promise<EncodingResult> {
		const encoder = this.encoders.get(modality);

		if (!encoder) {
			throw new Error(`No encoder registered for modality: ${modality}`);
		}

		return encoder.encode(input);
	}

	/**
	 * Encode multiple inputs and bind them into a composite memory
	 */
	async encodeComposite(
		inputs: Array<{ data: unknown; modality: string }>
	): Promise<HyperVector> {
		const vectors: HyperVector[] = [];

		for (const input of inputs) {
			const result = await this.encode(input.data, input.modality);
			vectors.push(result.vector);
		}

		// Bundle all modality vectors into composite memory
		return HyperVector.bundle(vectors);
	}

	/**
	 * Encode temporal sequence of inputs
	 */
	async encodeSequence(
		inputs: Array<{ data: unknown; modality: string; timestamp?: number }>
	): Promise<HyperVector> {
		// Sort by timestamp if provided
		const sorted = inputs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

		const vectors: HyperVector[] = [];
		for (let i = 0; i < sorted.length; i++) {
			const result = await this.encode(sorted[i].data, sorted[i].modality);
			// Apply temporal encoding through permutation
			const temporalVector = result.vector.permute(i * 100);
			vectors.push(temporalVector);
		}

		return HyperVector.bundle(vectors);
	}

	getRegisteredModalities(): string[] {
		return Array.from(this.encoders.keys());
	}
}
