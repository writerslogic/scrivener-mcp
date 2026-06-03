import type { StyleGuide } from '../../../memory-manager.js';
import type { ScrivenerDocument } from '../../../types/index.js';
import { SpecializedAgent, type AgentAnalysis, type AgentPersona } from './base-agent.js';
import { EnhancedLangChainService } from '../../ai/langchain-service-enhanced.js';
import { AdvancedLangChainFeatures } from '../../ai/langchain-advanced-features.js';
import { truncate } from '../../../utils/common.js';

export class CriticAgent extends SpecializedAgent {
	constructor(langchain: EnhancedLangChainService, advanced: AdvancedLangChainFeatures) {
		const persona: AgentPersona = {
			name: 'Critic',
			role: 'Literary Critic and Analyst',
			perspective:
				'I provide critical analysis of literary merit, thematic depth, and overall impact. I evaluate content from an analytical and interpretive standpoint.',
			expertise: [
				'literary analysis',
				'thematic interpretation',
				'critical theory',
				'comparative analysis',
				'artistic merit evaluation',
				'cultural context',
			],
			personality: 'Insightful, analytical, focused on deeper meaning and literary value',
			focusAreas: [
				'thematic depth',
				'literary techniques',
				'artistic merit',
				'cultural significance',
				'originality',
				'impact assessment',
			],
			communicationStyle: 'Thoughtful and analytical, focuses on deeper interpretation',
			biases: [
				'may overanalyze simple content',
				'might prioritize complexity over accessibility',
			],
			strengths: [
				'deep analytical insight',
				'broad literary knowledge',
				'thematic understanding',
			],
			limitations: ['may be overly critical', 'could miss practical writing concerns'],
		};

		super(langchain, advanced, persona);
	}

	async analyze(document: ScrivenerDocument, styleGuide?: StyleGuide): Promise<AgentAnalysis> {
		// SOTA: Use HMS to find conceptual bridges before analyzing
		const prompt = `
Perform a SOTA LITERARY CRITIQUE on this segment.
Genre Context: ${styleGuide?.genre || 'unspecified'}

Focus your analysis on:
1. **Thematic Resonance**: How do the core motifs (e.g., ${styleGuide?.styleNotes || 'themes'}) surface in the subtext?
2. **Structural Innovation**: Does the narrative structure challenge or reinforce genre conventions?
3. **Subtextual Integrity**: Identify areas where the prose is "on the nose" and lacks interpretive depth.
4. **Symbolic Cohesion**: Evaluate the effectiveness of recurring symbols or metaphors.
5. **Impact Velocity**: How effectively does this segment build tension or emotional weight?

Identify "Latent Concept Bridges" where this segment connects to deeper manuscript themes. 
Provide a critical assessment that moves beyond plot to artistic intent.
		`;

		return this.generateAnalysis(document, prompt, styleGuide);
	}

	async providePerspective(
		document: ScrivenerDocument,
		question: string,
		context?: string,
		styleGuide?: StyleGuide
	): Promise<string> {
		const prompt = `
As a SOTA Literary Analyst, provide a deep-theoretical perspective on:
**Query**: ${question}

**Intertextual Context**: 
${context ? truncate(context, 1000) : 'Isolated segment analysis.'}

Evaluate using the following lenses:
- **Deconstructive**: What underlying assumptions or contradictions exist in this narrative choice?
- **Formalist**: How do the mechanics of the prose support the thematic goals?
- **Aesthetic**: Is the work achieving its intended emotional or intellectual impact?

Provide a high-fidelity critical recommendation.
		`;

		const response = await this.langchain.generateWithFallback(prompt);
		return response;
	}

	async critique(analysis: AgentAnalysis, document: ScrivenerDocument): Promise<string> {
		const prompt = `
Perform a SOTA CROSS-AGENT CRITICAL REVIEW.
**Source Analysis**: ${analysis.agentId}
**Perspective**: ${analysis.perspective}

Review the critical validity of this analysis:
1. **Interpretive Depth**: Does this analysis stay on the surface, or does it reach the subtext?
2. **Thematic Alignment**: Does the advice align with the broader artistic goals of the ${document.title}?
3. **Artistic Merit**: Does following this advice make the work more "commercial" at the expense of its "merit"?

Provide 3 critical provocations to refine this analysis.
		`;

		const response = await this.langchain.generateWithFallback(prompt);
		return response;
	}
}
