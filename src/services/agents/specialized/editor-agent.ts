import type { StyleGuide } from '../../../memory-manager.js';
import type { ScrivenerDocument } from '../../../types/index.js';
import { SpecializedAgent, type AgentAnalysis, type AgentPersona } from './base-agent.js';
import { EnhancedLangChainService } from '../../ai/langchain-service-enhanced.js';
import { AdvancedLangChainFeatures } from '../../ai/langchain-advanced-features.js';
import { truncate } from '../../../utils/common.js';

export class EditorAgent extends SpecializedAgent {
	constructor(langchain: EnhancedLangChainService, advanced: AdvancedLangChainFeatures) {
		const persona: AgentPersona = {
			name: 'Editor',
			role: 'Professional Editor and Proofreader',
			perspective:
				'I focus on clarity, coherence, grammar, style consistency, and overall readability. I evaluate content for publication readiness and audience accessibility.',
			expertise: [
				'grammar and syntax',
				'style consistency',
				'clarity and coherence',
				'proofreading',
				'publication standards',
				'audience considerations',
			],
			personality: 'Meticulous, detail-oriented, focused on precision and clarity',
			focusAreas: [
				'grammar and punctuation',
				'sentence structure',
				'consistency',
				'clarity',
				'readability',
				'style adherence',
			],
			communicationStyle: 'Precise and constructive, focuses on concrete improvements',
			biases: [
				'may prioritize correctness over creativity',
				'might be overly focused on minor details',
			],
			strengths: [
				'excellent attention to detail',
				'strong grasp of language mechanics',
				'clarity enhancement',
			],
			limitations: ['may miss creative opportunities', 'could be too rigid about rules'],
		};

		super(langchain, advanced, persona);
	}

	async analyze(document: ScrivenerDocument, styleGuide?: StyleGuide): Promise<AgentAnalysis> {
		const metrics = await this.advanced.analyzeWritingStyle(document.content || '');

		const prompt = `
Perform a SOTA EDITORIAL ANALYSIS on this manuscript segment. 
Technical Data:
- Voice Consistency: ${metrics.voice?.consistency || 'unknown'}
- Complexity Level: ${metrics.structure?.complexity || 'standard'}
- Literary Devices: ${JSON.stringify(metrics.literaryDevices?.slice(0, 5))}

Focus your analysis on:
1. **Structural Pacing**: Does the sentence complexity align with the scene type?
2. **Style Guide Compliance**: How well does the prose adhere to the ${styleGuide?.tone || 'General'} tone requirements?
3. **Clarity Bottlenecks**: Identify exactly where cognitive load becomes too high for the reader.
4. **Vocabulary Precision**: Flag weak verbs or excessive adverbs that dilute the narrative voice.
5. **Scale-Aware Critique**: How does this segment contribute to the overall chapter's readability?

Provide specific, actionable suggestions with "Before" and "After" examples where appropriate.
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
As a SOTA Editorial Strategist, address the following query:
**Query**: ${question}

**Contextual Breadth**: 
${context ? truncate(context, 1000) : 'No additional context provided.'}

Evaluate this from a perspective of:
- **Reader Cognitive Load**: Does this choice improve or hinder accessibility?
- **Voice Consistency**: Does this maintain the ${styleGuide?.voice || 'established'} narrative voice?
- **Commercial Polish**: Does this align with current publication standards for the genre?

Provide a high-fidelity editorial recommendation.
		`;

		const response = await this.langchain.generateWithFallback(prompt);
		return response;
	}

	async critique(analysis: AgentAnalysis, document: ScrivenerDocument): Promise<string> {
		const prompt = `
Perform a CROSS-AGENT EDITORIAL CRITIQUE.
**Source Analysis**: ${analysis.agentId}
**Primary Claim**: ${analysis.reasoning}

Evaluate the editorial validity of this analysis:
1. **Implementation Feasibility**: Are the suggestions too abstract, or can an author actually apply them?
2. **Clarity Impact**: Would following this advice actually improve the Flesch-Kincaid metrics of the text?
3. **Blind Spots**: What technical editing issues (syntax, density, flow) did this analysis miss?

Synthesize your critique into 3 high-value refinement points.
		`;

		const response = await this.langchain.generateWithFallback(prompt);
		return response;
	}
}
