/**
 * Logical Operations for HHM
 * Implements reasoning through vector arithmetic
 */

import { HyperVector, SemanticVectors } from './hypervector.js';
import { getLogger } from '../../../core/logger.js';

const logger = getLogger('hhm-logical-operations');

export interface LogicalResult {
	vector: HyperVector;
	operation: string;
	confidence: number;
	metadata?: Record<string, unknown>;
}

export class LogicalOperations {
	private dimensions: number;
	private similarityThreshold: number;

	constructor(dimensions: number = 10000, similarityThreshold: number = 0.4) {
		this.dimensions = dimensions;
		this.similarityThreshold = similarityThreshold;
		SemanticVectors.setDimensions(dimensions);
	}

	/**
	 * Negation: NOT A
	 */
	negate(concept: HyperVector): LogicalResult {
		const notVector = SemanticVectors.NEGATION();
		const negated = notVector.bind(concept);

		return {
			vector: negated,
			operation: 'negation',
			confidence: 1.0,
		};
	}

	/**
	 * Conjunction: A AND B
	 */
	and(concepts: HyperVector[]): LogicalResult {
		if (concepts.length < 2) {
			throw new Error('AND operation requires at least 2 concepts');
		}

		const bundled = HyperVector.bundle(concepts);

		// Calculate confidence based on how well the bundle preserves individual concepts
		let totalSimilarity = 0;
		for (const concept of concepts) {
			totalSimilarity += bundled.similarity(concept);
		}
		const confidence = totalSimilarity / concepts.length;

		return {
			vector: bundled,
			operation: 'conjunction',
			confidence,
			metadata: {
				inputCount: concepts.length,
			},
		};
	}

	/**
	 * Disjunction: A OR B
	 * Implemented as a weighted bundle with lower threshold
	 */
	or(concepts: HyperVector[]): LogicalResult {
		if (concepts.length < 2) {
			throw new Error('OR operation requires at least 2 concepts');
		}

		// Create a softer bundle by adding noise
		const bundled = HyperVector.bundle(concepts);
		const softened = bundled.addNoise(0.1);

		return {
			vector: softened,
			operation: 'disjunction',
			confidence: 0.8,
			metadata: {
				inputCount: concepts.length,
			},
		};
	}

	/**
	 * Implication: A → B (If A then B)
	 */
	implies(antecedent: HyperVector, consequent: HyperVector): LogicalResult {
		// Create implication as: NOT A OR B
		const notA = this.negate(antecedent);
		const implication = this.or([notA.vector, consequent]);

		return {
			vector: implication.vector,
			operation: 'implication',
			confidence: implication.confidence * 0.9,
		};
	}

	/**
	 * Causality: A causes B
	 */
	causes(cause: HyperVector, effect: HyperVector): LogicalResult {
		const causalityVector = SemanticVectors.CAUSALITY();

		// Bind cause with causality relation
		const causalBinding = cause.bind(causalityVector);

		// Then bind with effect
		const fullCausality = causalBinding.bind(effect);

		return {
			vector: fullCausality,
			operation: 'causality',
			confidence: 0.85,
			metadata: {
				relationType: 'causal',
			},
		};
	}

	/**
	 * Extract effect from causal relationship
	 */
	extractEffect(causalVector: HyperVector, cause: HyperVector): LogicalResult {
		const causalityVector = SemanticVectors.CAUSALITY();

		// Unbind to get effect: (cause ⊗ causality ⊗ effect) ⊗ (cause ⊗ causality)^-1
		const causePart = cause.bind(causalityVector);
		const effect = causalVector.unbind(causePart);

		return {
			vector: effect,
			operation: 'effect_extraction',
			confidence: 0.75,
		};
	}

	/**
	 * Temporal before: A before B
	 */
	before(first: HyperVector, second: HyperVector): LogicalResult {
		const beforeVector = SemanticVectors.TEMPORAL_BEFORE();

		const temporal = first.bind(beforeVector).bind(second);

		return {
			vector: temporal,
			operation: 'temporal_before',
			confidence: 0.9,
			metadata: {
				temporalRelation: 'before',
			},
		};
	}

	/**
	 * Temporal after: A after B
	 */
	after(first: HyperVector, second: HyperVector): LogicalResult {
		const afterVector = SemanticVectors.TEMPORAL_AFTER();

		const temporal = first.bind(afterVector).bind(second);

		return {
			vector: temporal,
			operation: 'temporal_after',
			confidence: 0.9,
			metadata: {
				temporalRelation: 'after',
			},
		};
	}

	/**
	 * Location: A at B
	 */
	at(entity: HyperVector, location: HyperVector): LogicalResult {
		const locationVector = SemanticVectors.LOCATION();

		const spatial = entity.bind(locationVector).bind(location);

		return {
			vector: spatial,
			operation: 'location',
			confidence: 0.95,
			metadata: {
				spatialRelation: 'at',
			},
		};
	}

	/**
	 * Extract location from spatial relationship
	 */
	extractLocation(spatialVector: HyperVector, entity: HyperVector): LogicalResult {
		const locationVector = SemanticVectors.LOCATION();

		const entityPart = entity.bind(locationVector);
		const location = spatialVector.unbind(entityPart);

		return {
			vector: location,
			operation: 'location_extraction',
			confidence: 0.7,
		};
	}

	/**
	 * Possession: A has B
	 */
	has(owner: HyperVector, object: HyperVector): LogicalResult {
		const possessionVector = SemanticVectors.POSSESSION();

		const possession = owner.bind(possessionVector).bind(object);

		return {
			vector: possession,
			operation: 'possession',
			confidence: 0.9,
			metadata: {
				relation: 'possession',
			},
		};
	}

	/**
	 * Identity: A is B
	 */
	is(subject: HyperVector, predicate: HyperVector): LogicalResult {
		const identityVector = SemanticVectors.IDENTITY();

		const identity = subject.bind(identityVector).bind(predicate);

		return {
			vector: identity,
			operation: 'identity',
			confidence: 0.95,
			metadata: {
				relation: 'identity',
			},
		};
	}

	/**
	 * Similarity: A like B
	 */
	like(first: HyperVector, second: HyperVector): LogicalResult {
		const similarityVector = SemanticVectors.SIMILARITY();

		const similar = first.bind(similarityVector).bind(second);

		// Calculate actual similarity for confidence
		const actualSimilarity = first.similarity(second);

		return {
			vector: similar,
			operation: 'similarity',
			confidence: actualSimilarity,
			metadata: {
				relation: 'similarity',
				similarityScore: actualSimilarity,
			},
		};
	}

	/**
	 * Check if a vector satisfies a logical condition
	 */
	satisfies(vector: HyperVector, condition: HyperVector): boolean {
		const similarity = vector.similarity(condition);
		return similarity >= this.similarityThreshold;
	}

	/**
	 * Perform logical inference
	 * Given premises, derive conclusion
	 */
	infer(premises: HyperVector[], rules: HyperVector[]): LogicalResult {
		// Bundle all premises
		const premiseBundle = HyperVector.bundle(premises);

		// Find the most applicable rule
		let bestRule: HyperVector | null = null;
		let bestSimilarity = 0;

		for (const rule of rules) {
			const similarity = premiseBundle.similarity(rule);
			if (similarity > bestSimilarity) {
				bestSimilarity = similarity;
				bestRule = rule;
			}
		}

		if (!bestRule || bestSimilarity < this.similarityThreshold) {
			// No applicable rule found
			return {
				vector: new HyperVector(this.dimensions),
				operation: 'inference_failed',
				confidence: 0,
				metadata: {
					reason: 'No applicable rule found',
					bestSimilarity,
				},
			};
		}

		// Apply the rule to derive conclusion
		const conclusion = premiseBundle.bind(bestRule);

		return {
			vector: conclusion,
			operation: 'inference',
			confidence: bestSimilarity,
			metadata: {
				premiseCount: premises.length,
				ruleApplied: true,
			},
		};
	}

	/**
	 * Analogical reasoning: A is to B as C is to ?
	 */
	analogy(a: HyperVector, b: HyperVector, c: HyperVector): LogicalResult {
		// Find the relationship between A and B
		const relationAB = a.unbind(b);

		// Apply the same relationship to C
		const d = c.bind(relationAB);

		// Calculate confidence based on consistency
		const verifyRelation = c.unbind(d);
		const confidence = relationAB.similarity(verifyRelation);

		return {
			vector: d,
			operation: 'analogy',
			confidence,
			metadata: {
				analogyType: 'proportional',
				relationStrength: confidence,
			},
		};
	}

	/**
	 * Compose multiple logical operations
	 */
	compose(operations: Array<{ op: string; args: HyperVector[] }>): LogicalResult {
		let result: HyperVector = operations[0].args[0];
		let totalConfidence = 1.0;
		const steps: string[] = [];

		for (const { op, args } of operations) {
			let opResult: LogicalResult;

			switch (op) {
				case 'not':
					opResult = this.negate(args[0]);
					break;
				case 'and':
					opResult = this.and(args);
					break;
				case 'or':
					opResult = this.or(args);
					break;
				case 'implies':
					opResult = this.implies(args[0], args[1]);
					break;
				case 'causes':
					opResult = this.causes(args[0], args[1]);
					break;
				default:
					throw new Error(`Unknown operation: ${op}`);
			}

			result = opResult.vector;
			totalConfidence *= opResult.confidence;
			steps.push(op);
		}

		return {
			vector: result,
			operation: 'composition',
			confidence: totalConfidence,
			metadata: {
				steps,
				operationCount: operations.length,
			},
		};
	}

	/**
	 * Test logical consistency of a set of statements
	 */
	checkConsistency(statements: HyperVector[]): {
		consistent: boolean;
		confidence: number;
		conflicts?: Array<{ i: number; j: number; similarity: number }>;
	} {
		const conflicts: Array<{ i: number; j: number; similarity: number }> = [];
		let minSimilarity = 1.0;

		for (let i = 0; i < statements.length; i++) {
			for (let j = i + 1; j < statements.length; j++) {
				const similarity = statements[i].similarity(statements[j]);

				// Check for contradiction (very low similarity might indicate negation)
				if (similarity < 0.2) {
					// Possible contradiction
					const negated = this.negate(statements[i]);
					const negSimilarity = negated.vector.similarity(statements[j]);

					if (negSimilarity > 0.7) {
						// Strong contradiction detected
						conflicts.push({ i, j, similarity: negSimilarity });
					}
				}

				minSimilarity = Math.min(minSimilarity, similarity);
			}
		}

		return {
			consistent: conflicts.length === 0,
			confidence: conflicts.length === 0 ? minSimilarity : 0,
			conflicts: conflicts.length > 0 ? conflicts : undefined,
		};
	}
}
