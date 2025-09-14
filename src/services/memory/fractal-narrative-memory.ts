/**
 * Fractal Narrative Memory System
 * Implements multi-scale narrative memory with fractal segmentation,
 * graph-based relationship tracking, and motif clustering
 */

import { EventEmitter } from 'events';
import { Database } from 'sqlite3';
// import { pipeline } from '@xenova/transformers';
// import * as faiss from 'faiss-node';
// Mock implementations - replace with actual imports when libraries are available
const pipeline: (task: string, model: string) => Promise<{ (text: string): Promise<number[]> }> = () =>
	Promise.resolve(async (text: string) => [/* mock embeddings */]);
const faiss: { IndexFlatL2?: { new (dim: number): { add: (vectors: Float32Array) => void; search: (query: Float32Array, k: number) => { labels: Int32Array; distances: Float32Array } } } } = {};
import { getLogger } from '../../core/logger.js';
import { AppError, ErrorCode } from '../../utils/common.js';
import type { ScrivenerDocument } from '../../types/index.js';

// ============================================================================
// Core Types and Interfaces
// ============================================================================

export interface MicroSegment {
	id: string;
	chapter: number;
	paraIndex: number;
	sentIndex: number;
	beatIndex?: number;
	text: string;
	startChar: number;
	endChar: number;
	embeddingId?: string;
	tokens: number;
}

export interface MesoSegment {
	id: string;
	chapter: number;
	startChar: number;
	endChar: number;
	text: string;
	microIds: string[];
	embeddingId?: string;
	sceneType?: 'action' | 'dialogue' | 'description' | 'transition';
	tokens: number;
}

export interface MacroSegment {
	id: string;
	chapterOrArc: string;
	startChar: number;
	endChar: number;
	text: string;
	mesoIds: string[];
	embeddingId?: string;
	arcType?: 'setup' | 'rising' | 'climax' | 'falling' | 'resolution';
}

export interface GraphNode {
	nodeId: string;
	nodeType: 'character' | 'object' | 'motif' | 'setting' | 'event' | 'segment';
	canonicalName: string;
	attributesJson: Record<string, any>;
	frequency: number;
	centrality?: number;
}

export interface GraphEdge {
	edgeId: string;
	fromNode: string;
	toNode: string;
	edgeType: 'interacts' | 'cooccurrence' | 'emotional' | 'causal' | 'temporal';
	weight: number;
	evidenceJson: Record<string, any>;
}

export interface MotifCluster {
	clusterId: number;
	keywords: string[];
	label?: string;
	segments: string[];
	centroid?: Float32Array;
	coherenceScore: number;
}

export interface RetrievalResult {
	scale: 'micro' | 'meso' | 'macro';
	segmentId: string;
	score: number;
	segment: MicroSegment | MesoSegment | MacroSegment;
	graphBoost: number;
	contextBoost: number;
}

export interface FractalMemoryConfig {
	microTokenRange: [number, number]; // [5, 40]
	mesoTokenRange: [number, number]; // [100, 1200]
	mesoOverlap: number; // 50 tokens
	scaleWeights: {
		micro: number;
		meso: number;
		macro: number;
	};
	graphBoostWeight: number;
	contextBoostWeight: number;
	minClusterSize: number;
	embeddingModel: string;
}

// ============================================================================
// Fractal Segmentation Engine
// ============================================================================

export class FractalSegmenter {
	private logger: ReturnType<typeof getLogger>;
	private sentenceTokenizer: unknown; // spaCy or similar
	private config: FractalMemoryConfig;

	constructor(config: FractalMemoryConfig) {
		this.logger = getLogger('FractalSegmenter');
		this.config = config;
	}

	async segment(
		chapterText: string,
		chapterIndex: number
	): Promise<{
		micro: MicroSegment[];
		meso: MesoSegment[];
		macro: MacroSegment[];
	}> {
		this.logger.debug(`Segmenting chapter ${chapterIndex}`);

		// 1. Create micro segments (sentences/beats)
		const microSegments = await this.createMicroSegments(chapterText, chapterIndex);

		// 2. Create meso segments (scenes/blocks)
		const mesoSegments = await this.createMesoSegments(
			chapterText,
			chapterIndex,
			microSegments
		);

		// 3. Create macro segment for chapter
		const macroSegment = this.createMacroSegment(chapterText, chapterIndex, mesoSegments);

		return {
			micro: microSegments,
			meso: mesoSegments,
			macro: [macroSegment],
		};
	}

	private async createMicroSegments(text: string, chapterIndex: number): Promise<MicroSegment[]> {
		const sentences = await this.splitIntoSentences(text);
		const microSegments: MicroSegment[] = [];

		for (let i = 0; i < sentences.length; i++) {
			const sent = sentences[i];
			const beats = this.splitLongSentence(sent);

			for (let j = 0; j < beats.length; j++) {
				const beat = beats[j];
				if (typeof beat === 'string') {
					// Handle string beat (simplified case)
					microSegments.push({
						id: `micro_${chapterIndex}_${i}_${j}`,
						chapter: chapterIndex,
						paraIndex: this.getParagraphIndex(sent.startChar, text),
						sentIndex: i,
						beatIndex: beats.length > 1 ? j : undefined,
						text: beat,
						startChar: sent.startChar,
						endChar: sent.endChar,
						tokens: this.countTokens(beat),
					});
				} else if (typeof beat === 'object' && beat !== null && 'text' in beat) {
					// Handle object beat with text property
					microSegments.push({
						id: `micro_${chapterIndex}_${i}_${j}`,
						chapter: chapterIndex,
						paraIndex: this.getParagraphIndex(sent.startChar, text),
						sentIndex: i,
						beatIndex: beats.length > 1 ? j : undefined,
						text: (beat as { text: string; startChar: number; endChar: number }).text,
						startChar: (beat as { text: string; startChar: number; endChar: number }).startChar,
						endChar: (beat as { text: string; startChar: number; endChar: number }).endChar,
						tokens: this.countTokens((beat as { text: string; startChar: number; endChar: number }).text),
					});
				}
			}
		}

		return microSegments;
	}

	private async createMesoSegments(
		text: string,
		chapterIndex: number,
		microSegments: MicroSegment[]
	): Promise<MesoSegment[]> {
		// Try to detect natural scene boundaries
		const sceneBreaks = this.detectSceneBreaks(text);

		if (sceneBreaks.length > 0) {
			return this.createScenesFromBreaks(text, chapterIndex, microSegments, sceneBreaks);
		} else {
			// Fall back to sliding windows
			return this.createSlidingWindows(text, chapterIndex, microSegments);
		}
	}

	private detectSceneBreaks(text: string): number[] {
		const breaks: number[] = [0];

		// Look for explicit scene markers
		const sceneMarkers = [
			/\n\n\*\*\*\n\n/g, // asterisk breaks
			/\n\n---\n\n/g, // dash breaks
			/\n\n\s*\n\n/g, // multiple blank lines
			/Chapter \d+/gi, // chapter markers
		];

		for (const marker of sceneMarkers) {
			let match;
			while ((match = marker.exec(text)) !== null) {
				breaks.push(match.index);
			}
		}

		// Also detect major setting/time changes (requires NLP)
		// This would use more sophisticated scene detection

		return [...new Set(breaks)].sort((a, b) => a - b);
	}

	private createMacroSegment(
		text: string,
		chapterIndex: number,
		mesoSegments: MesoSegment[]
	): MacroSegment {
		return {
			id: `macro_ch${chapterIndex}`,
			chapterOrArc: `Chapter ${chapterIndex}`,
			startChar: 0,
			endChar: text.length,
			text,
			mesoIds: mesoSegments.map((m) => m.id),
			arcType: this.detectArcType(text),
		};
	}

	private splitLongSentence(sentence: { text: string; startChar: number; endChar: number }): Array<{ text: string; startChar: number; endChar: number } | string> {
		const { text } = sentence;
		const tokens = this.countTokens(text);

		if (tokens <= this.config.microTokenRange[1]) {
			return [sentence];
		}

		// Split on semicolons, then commas if needed
		const beats: string[] = [];
		const splitPoints = [';', ',', ' and ', ' but ', ' or '];

		// Implementation of smart splitting...
		// (simplified for brevity)
		// For now, just split by spaces if too long
		if (tokens > this.config.microTokenRange[1]) {
			const words = text.split(' ');
			const chunkSize = Math.ceil(words.length / Math.ceil(tokens / this.config.microTokenRange[1]));
			for (let i = 0; i < words.length; i += chunkSize) {
				beats.push(words.slice(i, i + chunkSize).join(' '));
			}
		}

		return beats.length > 0 ? beats : [sentence];
	}

	private countTokens(text: string): number {
		// Simple approximation - replace with proper tokenizer
		return text.split(/\s+/).length;
	}

	private getParagraphIndex(charPos: number, text: string): number {
		const beforeText = text.substring(0, charPos);
		return (beforeText.match(/\n\n/g) || []).length;
	}

	private splitIntoSentences(
		text: string
	): Promise<Array<{ text: string; startChar: number; endChar: number }>> {
		// Use spaCy or similar for proper sentence splitting
		// Placeholder implementation
		return Promise.resolve([]);
	}

	private createSlidingWindows(
		text: string,
		chapterIndex: number,
		microSegments: MicroSegment[]
	): MesoSegment[] {
		const windows: MesoSegment[] = [];
		const [minTokens, maxTokens] = this.config.mesoTokenRange;
		const overlap = this.config.mesoOverlap;

		let windowStart = 0;
		let windowIndex = 0;

		while (windowStart < microSegments.length) {
			let windowEnd = windowStart;
			let tokenCount = 0;

			// Expand window until we hit max tokens
			while (windowEnd < microSegments.length && tokenCount < maxTokens) {
				tokenCount += microSegments[windowEnd].tokens;
				windowEnd++;
			}

			// Ensure minimum size
			if (tokenCount < minTokens && windowEnd < microSegments.length) {
				windowEnd = microSegments.length;
			}

			const windowMicros = microSegments.slice(windowStart, windowEnd);
			const windowText = windowMicros.map((m) => m.text).join(' ');

			windows.push({
				id: `meso_${chapterIndex}_${windowIndex}`,
				chapter: chapterIndex,
				startChar: windowMicros[0].startChar,
				endChar: windowMicros[windowMicros.length - 1].endChar,
				text: windowText,
				microIds: windowMicros.map((m) => m.id),
				tokens: tokenCount,
				sceneType: this.detectSceneType(windowText),
			});

			// Move window with overlap
			const advance = Math.max(
				1,
				Math.floor((windowEnd - windowStart) * (1 - overlap / maxTokens))
			);
			windowStart += advance;
			windowIndex++;
		}

		return windows;
	}

	private createScenesFromBreaks(
		text: string,
		chapterIndex: number,
		microSegments: MicroSegment[],
		sceneBreaks: number[]
	): MesoSegment[] {
		// Implementation for creating scenes from detected breaks
		return [];
	}

	private detectSceneType(text: string): 'action' | 'dialogue' | 'description' | 'transition' {
		// Simple heuristics for scene type detection
		const dialogueRatio = (text.match(/["']/g) || []).length / text.length;
		const actionWords = (text.match(/\b(ran|jumped|fought|grabbed|threw)\b/gi) || []).length;

		if (dialogueRatio > 0.05) return 'dialogue';
		if (actionWords > 3) return 'action';
		if (text.length < 200) return 'transition';
		return 'description';
	}

	private detectArcType(text: string): 'setup' | 'rising' | 'climax' | 'falling' | 'resolution' {
		// Placeholder - would use more sophisticated narrative analysis
		return 'rising';
	}
}

// ============================================================================
// Fractal Retrieval Engine
// ============================================================================

export class FractalRetriever {
	private logger: ReturnType<typeof getLogger>;
	private microIndex: unknown; // FAISS index
	private mesoIndex: unknown;
	private macroIndex: unknown;
	private config: FractalMemoryConfig;
	private embedder: unknown;

	constructor(config: FractalMemoryConfig) {
		this.logger = getLogger('FractalRetriever');
		this.config = config;
	}

	async initialize() {
		// Initialize FAISS indices
		const dimension = 768; // for sentence-transformers
		if (faiss.IndexFlatL2) {
			this.microIndex = new faiss.IndexFlatL2(dimension);
			this.mesoIndex = new faiss.IndexFlatL2(dimension);
			this.macroIndex = new faiss.IndexFlatL2(dimension);
		}

		// Initialize embedder
		this.embedder = await pipeline('feature-extraction', this.config.embeddingModel);
	}

	async retrieve(
		query: string,
		k: number = 10,
		scaleWeights?: Partial<typeof this.config.scaleWeights>,
		graphDB?: Database
	): Promise<RetrievalResult[]> {
		const weights = { ...this.config.scaleWeights, ...scaleWeights };
		const queryEmbedding = await this.embed(query);

		const results: RetrievalResult[] = [];

		// Search each scale
		for (const [scale, weight] of Object.entries(weights)) {
			if (weight === 0) continue;

			const index = this.getIndexForScale(scale as 'micro' | 'meso' | 'macro');
			const searchK = Math.ceil(k * weight * 2);

			const { distances, labels } = await (index as any).search(queryEmbedding, searchK);

			for (let i = 0; i < labels.length; i++) {
				const segmentId = this.getSegmentIdFromLabel(labels[i], scale);
				const segment = await this.loadSegment(segmentId, scale);

				const similarity = 1 / (1 + distances[i]); // Convert distance to similarity
				const graphBoost = graphDB
					? await this.computeGraphBoost(segment, query, graphDB)
					: 0;
				const contextBoost = this.computeContextBoost(segment);

				const score =
					weight * similarity +
					this.config.graphBoostWeight * graphBoost +
					this.config.contextBoostWeight * contextBoost;

				results.push({
					scale: scale as 'micro' | 'meso' | 'macro',
					segmentId,
					score,
					segment,
					graphBoost,
					contextBoost,
				});
			}
		}

		// Sort by score and return top k
		return results.sort((a, b) => b.score - a.score).slice(0, k);
	}

	private async embed(text: string): Promise<Float32Array> {
		const output = await (this.embedder as any)(text);
		return new Float32Array((output as any).data);
	}

	private getIndexForScale(scale: 'micro' | 'meso' | 'macro') {
		switch (scale) {
			case 'micro':
				return this.microIndex;
			case 'meso':
				return this.mesoIndex;
			case 'macro':
				return this.macroIndex;
		}
	}

	private async computeGraphBoost(
		segment: Record<string, unknown>,
		query: string,
		graphDB: Database
	): Promise<number> {
		// Query graph for nodes in segment
		// Boost if segment contains high-centrality nodes or query-relevant nodes
		return 0; // Placeholder
	}

	private computeContextBoost(segment: Record<string, unknown>): number {
		// Boost based on recency, proximity to important events, etc.
		return 0; // Placeholder
	}

	private getSegmentIdFromLabel(label: number, scale: string): string {
		// Map FAISS label to segment ID
		return `${scale}_${label}`;
	}

	private async loadSegment(segmentId: string, scale: string): Promise<any> {
		// Load segment from database
		return {};
	}
}

// ============================================================================
// Narrative Graph Manager
// ============================================================================

export class NarrativeGraphManager {
	public db: Database;
	private logger: ReturnType<typeof getLogger>;
	private corefResolver: unknown;
	private motifDetector: unknown;

	constructor(dbPath: string) {
		this.logger = getLogger('NarrativeGraphManager');
		this.db = new Database(dbPath);
		this.initializeSchema();
	}

	private initializeSchema() {
		// Create tables for nodes, edges, and segment mappings
		this.db.run(`
      CREATE TABLE IF NOT EXISTS nodes (
        node_id TEXT PRIMARY KEY,
        node_type TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        attributes_json TEXT,
        frequency INTEGER DEFAULT 1,
        centrality REAL
      )
    `);

		this.db.run(`
      CREATE TABLE IF NOT EXISTS edges (
        edge_id TEXT PRIMARY KEY,
        from_node TEXT NOT NULL,
        to_node TEXT NOT NULL,
        edge_type TEXT NOT NULL,
        weight REAL DEFAULT 1.0,
        evidence_json TEXT,
        FOREIGN KEY (from_node) REFERENCES nodes(node_id),
        FOREIGN KEY (to_node) REFERENCES nodes(node_id)
      )
    `);

		this.db.run(`
      CREATE TABLE IF NOT EXISTS segment_node_map (
        segment_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        role TEXT,
        PRIMARY KEY (segment_id, node_id),
        FOREIGN KEY (node_id) REFERENCES nodes(node_id)
      )
    `);

		// Create indices for performance
		this.db.run(`CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_node)`);
		this.db.run(`CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_node)`);
		this.db.run(`CREATE INDEX IF NOT EXISTS idx_segment_map ON segment_node_map(segment_id)`);
	}

	async updateGraphForSegment(segment: MesoSegment): Promise<void> {
		// 1. Extract entities using coreference resolution
		const entities = await this.extractEntities(segment.text);

		// 2. Detect motifs
		const motifs = await this.detectMotifs(segment.text);

		// 3. Update nodes
		const nodeIds: string[] = [];

		for (const entity of entities) {
			const nodeId = await this.upsertNode(entity);
			nodeIds.push(nodeId);
			await this.linkSegmentToNode(segment.id, nodeId, entity.role);
		}

		for (const motif of motifs) {
			const nodeId = await this.upsertMotifNode(motif);
			nodeIds.push(nodeId);
			await this.linkSegmentToNode(segment.id, nodeId, 'motif');
		}

		// 4. Create co-occurrence edges
		for (let i = 0; i < nodeIds.length; i++) {
			for (let j = i + 1; j < nodeIds.length; j++) {
				await this.upsertEdge(nodeIds[i], nodeIds[j], 'cooccurrence', {
					segment: segment.id,
				});
			}
		}

		// 5. Update centrality metrics
		await this.updateCentralityMetrics();
	}

	private async extractEntities(text: string): Promise<any[]> {
		// Use coreference resolution and NER
		// Placeholder implementation
		return [];
	}

	private async detectMotifs(text: string): Promise<any[]> {
		// Pattern matching for known motifs
		// Placeholder implementation
		return [];
	}

	private async upsertNode(entity: Record<string, unknown>): Promise<string> {
		const nodeId = this.generateNodeId(entity);
		const canonical = this.canonicalize(String(entity.name || ''));

		return new Promise((resolve, reject) => {
			this.db.run(
				`INSERT INTO nodes (node_id, node_type, canonical_name, attributes_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
         frequency = frequency + 1`,
				[nodeId, entity.type, canonical, JSON.stringify(entity.attributes)],
				(err) => {
					if (err) reject(err);
					else resolve(nodeId);
				}
			);
		});
	}

	private async upsertMotifNode(motif: Record<string, unknown>): Promise<string> {
		const nodeId = `motif_${motif.label}`;

		return new Promise((resolve, reject) => {
			this.db.run(
				`INSERT INTO nodes (node_id, node_type, canonical_name, attributes_json)
         VALUES (?, 'motif', ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
         frequency = frequency + 1`,
				[nodeId, motif.label, JSON.stringify(motif)],
				(err) => {
					if (err) reject(err);
					else resolve(nodeId);
				}
			);
		});
	}

	private async upsertEdge(
		fromNode: string,
		toNode: string,
		edgeType: string,
		evidence: unknown
	): Promise<void> {
		const edgeId = `${fromNode}_${toNode}_${edgeType}`;

		return new Promise((resolve, reject) => {
			this.db.run(
				`INSERT INTO edges (edge_id, from_node, to_node, edge_type, evidence_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(edge_id) DO UPDATE SET
         weight = weight + 1`,
				[edgeId, fromNode, toNode, edgeType, JSON.stringify(evidence)],
				(err) => {
					if (err) reject(err);
					else resolve();
				}
			);
		});
	}

	private async linkSegmentToNode(
		segmentId: string,
		nodeId: string,
		role: string
	): Promise<void> {
		return new Promise((resolve, reject) => {
			this.db.run(
				`INSERT OR IGNORE INTO segment_node_map (segment_id, node_id, role)
         VALUES (?, ?, ?)`,
				[segmentId, nodeId, role],
				(err) => {
					if (err) reject(err);
					else resolve();
				}
			);
		});
	}

	private generateNodeId(entity: Record<string, unknown>): string {
		const entityType = String(entity.type || 'unknown');
		const entityName = String(entity.name || 'unnamed');
		return `${entityType}_${entityName.toLowerCase().replace(/\s+/g, '_')}`;
	}

	private canonicalize(name: string): string {
		// Map aliases to canonical names
		const aliases: Record<string, string> = {
			tom: 'Thomas',
			tommy: 'Thomas',
			// Add more aliases
		};

		const lower = name.toLowerCase();
		return aliases[lower] || name;
	}

	private async updateCentralityMetrics(): Promise<void> {
		// Calculate degree centrality for all nodes
		// This is a simplified version - could use PageRank or other metrics

		const query = `
      UPDATE nodes
      SET centrality = (
        SELECT COUNT(*) FROM edges
        WHERE edges.from_node = nodes.node_id
        OR edges.to_node = nodes.node_id
      )
    `;

		return new Promise((resolve, reject) => {
			this.db.run(query, (err) => {
				if (err) reject(err);
				else resolve();
			});
		});
	}

	async checkContinuity(character: string): Promise<any[]> {
		// Check for continuity violations
		const query = `
      SELECT n1.canonical_name, n1.attributes_json as state1,
             n2.attributes_json as state2, e.evidence_json
      FROM nodes n1
      JOIN edges e ON n1.node_id = e.from_node
      JOIN nodes n2 ON n2.node_id = e.to_node
      WHERE n1.canonical_name = ?
      AND n1.node_type = 'character'
      AND e.edge_type = 'temporal'
    `;

		return new Promise((resolve, reject) => {
			this.db.all(query, [character], (err, rows) => {
				if (err) reject(err);
				else {
					// Check for contradictions in character states
					const violations = this.detectViolations(rows);
					resolve(violations);
				}
			});
		});
	}

	private detectViolations(rows: unknown[]): Array<{ id: string; similarity?: number; [key: string]: unknown }> {
		// Analyze temporal edges for contradictions
		// Placeholder implementation
		return [];
	}
}

// ============================================================================
// Motif Clustering Engine
// ============================================================================

export class MotifClusteringEngine {
	private logger: ReturnType<typeof getLogger>;
	private clusterer: unknown; // HDBSCAN
	private minClusterSize: number;

	constructor(minClusterSize: number = 5) {
		this.logger = getLogger('MotifClusteringEngine');
		this.minClusterSize = minClusterSize;
	}

	async clusterMotifs(embeddings: Float32Array[]): Promise<MotifCluster[]> {
		// Run HDBSCAN clustering
		const labels = await this.runClustering(embeddings);

		// Extract clusters
		const clusters: Map<number, number[]> = new Map();
		labels.forEach((label, idx) => {
			if (label !== -1) {
				// -1 indicates noise
				if (!clusters.has(label)) {
					clusters.set(label, []);
				}
				clusters.get(label)!.push(idx);
			}
		});

		// Create cluster objects with keywords
		const motifClusters: MotifCluster[] = [];

		for (const [clusterId, indices] of clusters) {
			const clusterEmbeddings = indices.map((i) => embeddings[i]);
			const centroid = this.computeCentroid(clusterEmbeddings);
			const keywords = await this.extractKeywords(indices);
			const coherence = this.computeCoherence(clusterEmbeddings, centroid);

			motifClusters.push({
				clusterId,
				keywords,
				segments: indices.map((i) => `segment_${i}`),
				centroid,
				coherenceScore: coherence,
			});
		}

		return motifClusters;
	}

	private async runClustering(embeddings: Float32Array[]): Promise<number[]> {
		// Run HDBSCAN
		// Placeholder - would use actual HDBSCAN implementation
		return embeddings.map(() => Math.floor(Math.random() * 5));
	}

	private computeCentroid(embeddings: Float32Array[]): Float32Array {
		const dim = embeddings[0].length;
		const centroid = new Float32Array(dim);

		for (const emb of embeddings) {
			for (let i = 0; i < dim; i++) {
				centroid[i] += emb[i] / embeddings.length;
			}
		}

		return centroid;
	}

	private async extractKeywords(indices: number[]): Promise<string[]> {
		// Extract representative keywords using TF-IDF
		// Placeholder implementation
		return ['frost', 'cold', 'breath'];
	}

	private computeCoherence(embeddings: Float32Array[], centroid: Float32Array): number {
		// Compute average distance to centroid
		let totalDistance = 0;

		for (const emb of embeddings) {
			let distance = 0;
			for (let i = 0; i < centroid.length; i++) {
				distance += Math.pow(emb[i] - centroid[i], 2);
			}
			totalDistance += Math.sqrt(distance);
		}

		return 1 / (1 + totalDistance / embeddings.length);
	}

	async labelClusters(
		clusters: MotifCluster[],
		humanLabels?: Map<number, string>
	): Promise<void> {
		for (const cluster of clusters) {
			if (humanLabels?.has(cluster.clusterId)) {
				cluster.label = humanLabels.get(cluster.clusterId);
			} else {
				// Auto-label based on keywords
				cluster.label = this.generateLabel(cluster.keywords);
			}
		}
	}

	private generateLabel(keywords: string[]): string {
		// Simple heuristic labeling
		if (keywords.includes('frost') || keywords.includes('cold')) {
			return 'cold-presence';
		}
		if (keywords.includes('purple') || keywords.includes('stain')) {
			return 'purple-motif';
		}
		return keywords.slice(0, 3).join('-');
	}
}

// ============================================================================
// Main Fractal Narrative Memory System
// ============================================================================

export class FractalNarrativeMemory extends EventEmitter {
	private segmenter: FractalSegmenter;
	private retriever: FractalRetriever;
	private graphManager: NarrativeGraphManager;
	private motifEngine: MotifClusteringEngine;
	private config: FractalMemoryConfig;
	private logger: ReturnType<typeof getLogger>;
	private db!: Database;
	private cache: Map<string, any>;

	constructor(config?: Partial<FractalMemoryConfig>) {
		super();
		this.logger = getLogger('FractalNarrativeMemory');

		this.config = {
			microTokenRange: [5, 40],
			mesoTokenRange: [100, 1200],
			mesoOverlap: 50,
			scaleWeights: {
				micro: 1.0,
				meso: 0.6,
				macro: 0.3,
			},
			graphBoostWeight: 0.2,
			contextBoostWeight: 0.1,
			minClusterSize: 5,
			embeddingModel: 'sentence-transformers/all-MiniLM-L6-v2',
			...config,
		};

		this.segmenter = new FractalSegmenter(this.config);
		this.retriever = new FractalRetriever(this.config);
		this.graphManager = new NarrativeGraphManager('./narrative_graph.db');
		this.motifEngine = new MotifClusteringEngine(this.config.minClusterSize);
		this.cache = new Map();
	}

	async initialize(): Promise<void> {
		this.logger.info('Initializing Fractal Narrative Memory');

		await this.retriever.initialize();
		await this.initializeDatabase();

		this.logger.info('Fractal Narrative Memory initialized');
		this.emit('initialized');
	}

	private async initializeDatabase(): Promise<void> {
		this.db = new Database('./fractal_memory.db');

		// Create segment tables
		const tables = [
			`CREATE TABLE IF NOT EXISTS segments_micro (
        id TEXT PRIMARY KEY,
        chapter INTEGER,
        para_index INTEGER,
        sent_index INTEGER,
        beat_index INTEGER,
        text TEXT,
        start_char INTEGER,
        end_char INTEGER,
        embedding_id TEXT,
        tokens INTEGER
      )`,
			`CREATE TABLE IF NOT EXISTS segments_meso (
        id TEXT PRIMARY KEY,
        chapter INTEGER,
        start_char INTEGER,
        end_char INTEGER,
        text TEXT,
        micro_ids TEXT,
        embedding_id TEXT,
        scene_type TEXT,
        tokens INTEGER
      )`,
			`CREATE TABLE IF NOT EXISTS segments_macro (
        id TEXT PRIMARY KEY,
        chapter_or_arc TEXT,
        start_char INTEGER,
        end_char INTEGER,
        text TEXT,
        meso_ids TEXT,
        embedding_id TEXT,
        arc_type TEXT
      )`,
		];

		for (const sql of tables) {
			await new Promise((resolve, reject) => {
				this.db.run(sql, (err) => (err ? reject(err) : resolve(void 0)));
			});
		}
	}

	async ingestDocument(document: ScrivenerDocument): Promise<void> {
		this.logger.info(`Ingesting document: ${document.id}`);

		// 1. Segment the document
		const segments = await this.segmenter.segment(
			document.content || '',
			parseInt(String(document.metadata?.chapter || '1'))
		);

		// 2. Generate embeddings and index
		await this.indexSegments(segments.micro, 'micro');
		await this.indexSegments(segments.meso, 'meso');
		await this.indexSegments(segments.macro, 'macro');

		// 3. Update narrative graph
		for (const meso of segments.meso) {
			await this.graphManager.updateGraphForSegment(meso);
		}

		// 4. Run motif clustering periodically
		if (Math.random() < 0.1) {
			// Run for 10% of documents
			await this.clusterMotifs();
		}

		this.emit('documentIngested', document.id);
	}

	private async indexSegments(segments: Array<MicroSegment | MesoSegment | MacroSegment>, scale: string): Promise<void> {
		// Store segments in database and index embeddings
		for (const segment of segments) {
			await this.storeSegment(segment, scale);
			await this.indexSegment(segment, scale);
		}
	}

	private async storeSegment(segment: MicroSegment | MesoSegment | MacroSegment, scale: string): Promise<void> {
		// Store in appropriate table based on scale
		// Implementation depends on segment type
	}

	private async indexSegment(segment: MicroSegment | MesoSegment | MacroSegment, scale: string): Promise<void> {
		// Generate embedding and add to FAISS index
		// Implementation depends on retriever
	}

	async query(
		queryText: string,
		options?: {
			k?: number;
			scaleWeights?: Partial<{ micro: number; meso: number; macro: number }>;
			policy?: 'line-fix' | 'scene-fix' | 'thematic';
		}
	): Promise<RetrievalResult[]> {
		// Apply retrieval policy
		let scaleWeights = options?.scaleWeights || this.config.scaleWeights;

		if (options?.policy) {
			scaleWeights = this.applyPolicy(options.policy);
		}

		// Check cache
		const cacheKey = `${queryText}_${JSON.stringify(scaleWeights)}_${options?.k || 10}`;
		if (this.cache.has(cacheKey)) {
			return this.cache.get(cacheKey);
		}

		// Perform retrieval
		const results = await this.retriever.retrieve(
			queryText,
			options?.k || 10,
			scaleWeights,
			this.graphManager.db
		);

		// Cache results
		this.cache.set(cacheKey, results);

		// Clear old cache entries if too large
		if (this.cache.size > 100) {
			const firstKey = this.cache.keys().next().value;
			if (firstKey !== undefined) {
				this.cache.delete(firstKey);
			}
		}

		return results;
	}

	private applyPolicy(policy: 'line-fix' | 'scene-fix' | 'thematic') {
		switch (policy) {
			case 'line-fix':
				return { micro: 0.9, meso: 0.1, macro: 0.0 };
			case 'scene-fix':
				return { micro: 0.2, meso: 0.7, macro: 0.1 };
			case 'thematic':
				return { micro: 0.1, meso: 0.3, macro: 0.8 };
			default:
				return this.config.scaleWeights;
		}
	}

	async checkContinuity(character: string): Promise<any[]> {
		return this.graphManager.checkContinuity(character);
	}

	async findMotif(motifName: string): Promise<RetrievalResult[]> {
		// Search for segments containing a specific motif
		const query = `Find all instances of the ${motifName} motif`;
		return this.query(query, { policy: 'thematic' });
	}

	async expandBeat(segmentId: string, context?: string): Promise<string> {
		// Use LLM to expand a micro segment
		// Placeholder implementation
		return 'Expanded beat text...';
	}

	private async clusterMotifs(): Promise<void> {
		// Get all meso embeddings
		// Run clustering
		// Update graph with motif nodes
		this.logger.info('Running motif clustering...');
	}

	async getStats(): Promise<any> {
		return {
			microSegments: await this.getSegmentCount('micro'),
			mesoSegments: await this.getSegmentCount('meso'),
			macroSegments: await this.getSegmentCount('macro'),
			graphNodes: await this.getNodeCount(),
			graphEdges: await this.getEdgeCount(),
			motifClusters: await this.getMotifCount(),
		};
	}

	private async getSegmentCount(scale: string): Promise<number> {
		return new Promise((resolve, reject) => {
			this.db.get(
				`SELECT COUNT(*) as count FROM segments_${scale}`,
				(err, row: { count: number }) => {
					if (err) reject(err);
					else resolve(Number(row?.count || 0));
				}
			);
		});
	}

	private async getNodeCount(): Promise<number> {
		return new Promise((resolve, reject) => {
			this.graphManager.db.get(
				`SELECT COUNT(*) as count FROM nodes`,
				(err, row: { count: number }) => {
					if (err) reject(err);
					else resolve(Number(row?.count || 0));
				}
			);
		});
	}

	private async getEdgeCount(): Promise<number> {
		return new Promise((resolve, reject) => {
			this.graphManager.db.get(
				`SELECT COUNT(*) as count FROM edges`,
				(err, row: { count: number }) => {
					if (err) reject(err);
					else resolve(Number(row?.count || 0));
				}
			);
		});
	}

	private async getMotifCount(): Promise<number> {
		return new Promise((resolve, reject) => {
			this.graphManager.db.get(
				`SELECT COUNT(*) as count FROM nodes WHERE node_type = 'motif'`,
				(err, row: { count: number }) => {
					if (err) reject(err);
					else resolve(Number(row?.count || 0));
				}
			);
		});
	}
}
