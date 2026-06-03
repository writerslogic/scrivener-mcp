/**
 * Type declarations for @hms/native
 * Allows tsc to compile when the native binary is not available (CI, npm install)
 */
declare module '@hms/native' {
	export interface TextMetrics {
		wordCount: number;
		sentenceCount: number;
		syllableCount: number;
		vowelCount: number;
		consonantCount: number;
		punctuationCount: number;
	}
	export interface RetrievalResult {
		id: string;
		similarity: number;
	}
	export interface ConceptCandidate {
		centroidId: string;
		memberCount: number;
		coherence: number;
		memberIds: Array<string>;
	}
	export interface MemorizeBatchItem {
		id: string;
		text: string;
	}
	export class HolographicMemorySystem {
		constructor(dimensions: number, storagePath?: string | undefined | null);
		analyzeText(text: string): Promise<TextMetrics>;
		calculateReadability(metrics: TextMetrics): Promise<number>;
		memorizeText(id: string, text: string, traceId?: string | undefined | null): Promise<void>;
		memorizeTextBuffer(
			id: string,
			text: Buffer,
			traceId?: string | undefined | null
		): Promise<void>;
		memorizeBatch(
			items: Array<MemorizeBatchItem>,
			traceId?: string | undefined | null
		): Promise<void>;
		memorizeFile(id: string, filePath: string): Promise<void>;
		memorizeVector(id: string, vector: Float32Array): Promise<void>;
		memorizeScalar(id: string, value: number, min: number, max: number): Promise<void>;
		query(
			text: string,
			k: number,
			traceId?: string | undefined | null
		): Promise<Array<RetrievalResult>>;
		queryVector(vector: Float32Array, k: number): Promise<Array<RetrievalResult>>;
		queryScalar(
			value: number,
			min: number,
			max: number,
			k: number
		): Promise<Array<RetrievalResult>>;
		queryBatch(texts: Array<string>, k: number): Promise<Array<Array<RetrievalResult>>>;
		queryVectorBatch(
			vectors: Array<Float32Array>,
			k: number
		): Promise<Array<Array<RetrievalResult>>>;
		analyzeComponents(text: string): Promise<Array<RetrievalResult>>;
		factorizeDiffusion(
			productText: string,
			domains: Array<Array<string>>,
			maxIter: number
		): Promise<Array<string | null>>;
		memorizeTriplet(id: string, head: string, relation: string, tail: string): Promise<void>;
		queryTriplet(head: string, relation: string, k: number): Promise<Array<RetrievalResult>>;
		findAnalogy(
			a: string,
			b: string,
			c: string,
			traceId?: string | undefined | null
		): Promise<Array<RetrievalResult>>;
		synthesizeConcepts(): Promise<Array<ConceptCandidate>>;
		memorizeSequence(id: string, sequence: Array<string>): Promise<void>;
	}
}
