import type { StyleGuide } from '../../../memory-manager.js';
import type { ScrivenerDocument } from '../../../types/index.js';
import { SpecializedAgent, type AgentAnalysis, type AgentPersona } from './base-agent.js';
import { EnhancedLangChainService } from '../../ai/langchain-service-enhanced.js';
import { AdvancedLangChainFeatures } from '../../ai/langchain-advanced-features.js';

export class ResearcherAgent extends SpecializedAgent {
	constructor(langchain: EnhancedLangChainService, advanced: AdvancedLangChainFeatures) {
		const persona: AgentPersona = {
			name: 'Researcher',
			role: 'Research and Fact-Checking Specialist',
			perspective: 'I focus on accuracy, evidence, research quality, and factual integrity. I evaluate content for credibility and information accuracy.',
			expertise: ['fact-checking', 'research methodology', 'source verification', 'accuracy assessment', 'evidence evaluation', 'credibility analysis'],
			personality: 'Analytical, skeptical, focused on truth and accuracy',
			focusAreas: ['factual accuracy', 'source credibility', 'research gaps', 'evidence quality', 'logical reasoning', 'information verification'],
			communicationStyle: 'Objective and evidence-based, focuses on verification and accuracy',
			biases: ['may prioritize facts over narrative flow', 'might be overly skeptical of creative elements'],
			strengths: ['strong analytical skills', 'excellent fact-checking abilities', 'logical reasoning'],
			limitations: ['may overlook creative license', 'could be too rigid about factual accuracy in fiction'],
		};
		
		super(langchain, advanced, persona);
	}

	async analyze(document: ScrivenerDocument, styleGuide?: StyleGuide): Promise<AgentAnalysis> {
		const prompt = `
Analyze this document from a research and accuracy perspective. Focus on:

1. **Factual Accuracy**: Are there any factual claims that need verification?
2. **Research Quality**: Is the information well-researched and credible?
3. **Source Material**: Are sources properly referenced or credited where needed?
4. **Logical Consistency**: Are arguments and claims logically sound?
5. **Evidence Support**: Are claims backed by appropriate evidence?
6. **Research Gaps**: What areas might need additional research or clarification?

Identify specific claims that need verification and suggest areas for further research.
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
As a research specialist, please address this question about the document:

**Question**: ${question}
${context ? `**Additional Context**: ${context}` : ''}

Consider the document from a research and accuracy perspective:
- What factual claims or information need verification?
- Are there research gaps that should be addressed?
- How credible and well-supported is the content?
- What additional research might strengthen the work?

Provide evidence-based insights that improve the accuracy and credibility of the content.
		`;

		const response = await this.langchain.generateWithFallback(prompt);
		return response;
	}

	async critique(analysis: AgentAnalysis, document: ScrivenerDocument): Promise<string> {
		const prompt = `
Review this analysis from a research and fact-checking perspective:

**Original Analysis**:
Agent: ${analysis.agentId}
Overall Score: ${analysis.overallScore}
Priority: ${analysis.priority}
Findings: ${analysis.findings.map(f => `${f.aspect}: ${f.assessment}`).join('; ')}

**Document Context**: ${document.title} (${(document.content || '').split(' ').length} words)

As a research specialist, provide constructive critique:
1. Does this analysis adequately address accuracy and research quality?
2. Are there important factual or logical issues that were missed?
3. Do the suggestions improve the credibility and accuracy of the content?
4. How could this analysis better serve research integrity?

Focus on factual accuracy and research quality.
		`;

		const response = await this.langchain.generateWithFallback(prompt);
		return response;
	}
}