import type { StyleGuide } from '../../../memory-manager.js';
import type { ScrivenerDocument } from '../../../types/index.js';
import { SpecializedAgent, type AgentAnalysis, type AgentPersona, type DiscussionRound } from './base-agent.js';
import { EnhancedLangChainService } from '../../ai/langchain-service-enhanced.js';
import { AdvancedLangChainFeatures } from '../../ai/langchain-advanced-features.js';
import { unique } from '../../../utils/common.js';

export class CoordinatorAgent extends SpecializedAgent {
	constructor(langchain: EnhancedLangChainService, advanced: AdvancedLangChainFeatures) {
		const persona: AgentPersona = {
			name: 'Coordinator',
			role: 'Analysis Coordinator and Synthesizer',
			perspective: 'I synthesize multiple perspectives, identify consensus, resolve conflicts, and coordinate collaborative analysis efforts.',
			expertise: ['synthesis', 'consensus building', 'conflict resolution', 'priority assessment', 'collaborative coordination', 'holistic analysis'],
			personality: 'Diplomatic, organized, focused on integration and coordination',
			focusAreas: ['consensus building', 'priority synthesis', 'conflict resolution', 'collaborative coordination', 'holistic integration', 'actionable recommendations'],
			communicationStyle: 'Balanced and diplomatic, focuses on synthesis and coordination',
			biases: ['may prioritize consensus over individual insights', 'might dilute strong opinions for harmony'],
			strengths: ['excellent synthesis abilities', 'diplomatic coordination', 'holistic perspective'],
			limitations: ['may suppress valuable dissenting views', 'could over-compromise'],
		};
		
		super(langchain, advanced, persona);
	}

	async analyze(document: ScrivenerDocument, styleGuide?: StyleGuide): Promise<AgentAnalysis> {
		const prompt = `
Analyze this document from a coordination and synthesis perspective. Focus on:

1. **Overall Cohesion**: How well do different elements work together?
2. **Integration Opportunities**: Where could different aspects be better integrated?
3. **Priority Assessment**: What are the most critical issues to address?
4. **Holistic View**: What is the big picture perspective on this document?
5. **Coordination Needs**: What aspects need coordinated attention?
6. **Synthesis Potential**: How can different elements be synthesized for improvement?

Provide a coordinated analysis that identifies priorities and integration opportunities.
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
As an analysis coordinator, please address this question about the document:

**Question**: ${question}
${context ? `**Additional Context**: ${context}` : ''}

Consider the document from a coordinating and synthesizing perspective:
- How does this fit into the bigger picture?
- What coordination or integration is needed?
- How should priorities be balanced?
- What synthesis opportunities exist?

Provide coordinated insights that help integrate different perspectives and priorities.
		`;

		const response = await this.langchain.generateWithFallback(prompt);
		return response;
	}

	async critique(analysis: AgentAnalysis, document: ScrivenerDocument): Promise<string> {
		const prompt = `
Review this analysis from a coordination and synthesis perspective:

**Original Analysis**:
Agent: ${analysis.agentId}
Overall Score: ${analysis.overallScore}
Priority: ${analysis.priority}
Findings: ${analysis.findings.map(f => `${f.aspect}: ${f.assessment}`).join('; ')}

**Document Context**: ${document.title} (${(document.content || '').split(' ').length} words)

As a coordinator, provide constructive critique:
1. Does this analysis fit well with other perspectives?
2. Are there coordination or integration issues?
3. How well are priorities balanced and synthesized?
4. How could this analysis better serve overall coordination?

Focus on synthesis, integration, and coordinated understanding.
		`;

		const response = await this.langchain.generateWithFallback(prompt);
		return response;
	}

	async buildConsensus(rounds: DiscussionRound[]): Promise<string[]> {
		if (rounds.length === 0) return [];
		
		const allAgreements = unique(rounds.flatMap(round => round.agreements));
		const allInsights = unique(rounds.flatMap(round => round.newInsights));
		
		const prompt = `
Based on these discussion rounds, build consensus points:

**Agreements across rounds**: ${allAgreements.join('; ')}
**New insights generated**: ${allInsights.join('; ')}

**Discussion History**:
${rounds.map(round => 
			`Round ${round.roundNumber}: ${round.contributions.length} contributions, ${round.agreements.length} agreements, ${round.newInsights.length} insights`
		).join('\n')}

Synthesize the strongest consensus points that emerged from these discussions. 
Focus on points with broad agreement and significant insights.
Return the top consensus points, one per line.
		`.trim();

		const response = await this.langchain.generateWithFallback(prompt);
		return response
			.split('\n')
			.map((line: string) => line.trim())
			.filter((line: string) => line.length > 0)
			.slice(0, 10); // Limit to top 10 consensus points
	}

	async identifyUnresolved(rounds: DiscussionRound[]): Promise<string[]> {
		if (rounds.length === 0) return [];
		
		const allDisagreements = unique(rounds.flatMap(round => round.disagreements));
		
		const prompt = `
Identify unresolved issues from these discussion rounds:

**Persistent disagreements**: ${allDisagreements.join('; ')}

**Discussion History**:
${rounds.map(round => 
			`Round ${round.roundNumber}: ${round.disagreements.length} disagreements`
		).join('\n')}

Identify the most significant unresolved issues that persist across rounds.
Focus on substantive disagreements that need further attention.
Return the key unresolved issues, one per line.
		`.trim();

		const response = await this.langchain.generateWithFallback(prompt);
		return response
			.split('\n')
			.map((line: string) => line.trim())
			.filter((line: string) => line.length > 0)
			.slice(0, 5); // Limit to top 5 unresolved issues
	}

	async synthesizeAnalyses(analyses: AgentAnalysis[]): Promise<AgentAnalysis> {
		if (analyses.length === 0) {
			throw new Error('Cannot synthesize empty analysis array');
		}

		if (analyses.length === 1) {
			return analyses[0];
		}

		const prompt = `
Synthesize these multiple agent analyses into a coordinated overall assessment:

${analyses.map(analysis => `
**${analysis.agentId} Analysis**:
- Overall Score: ${analysis.overallScore}
- Priority: ${analysis.priority}
- Key Findings: ${analysis.findings.map(f => `${f.aspect}: ${f.assessment} (confidence: ${f.confidence})`).join('; ')}
- Reasoning: ${analysis.reasoning}
`).join('\n')}

Create a synthesized analysis that:
1. Integrates the strongest insights from each agent
2. Identifies areas of consensus and disagreement
3. Provides a balanced overall assessment
4. Prioritizes the most critical issues
5. Offers coordinated recommendations

Structure as JSON with the standard AgentAnalysis format.
		`.trim();

		const response = await this.langchain.generateWithFallback(prompt);
		const synthesizedData = JSON.parse(response);

		return {
			agentId: 'Synthesized',
			perspective: synthesizedData.perspective || 'Coordinated synthesis of multiple agent perspectives',
			findings: Array.isArray(synthesizedData.findings) ? synthesizedData.findings : [],
			overallScore: Math.min(Math.max(Number(synthesizedData.overallScore || 70), 0), 100),
			priority: ['critical', 'high', 'medium', 'low'].includes(synthesizedData.priority) 
				? synthesizedData.priority 
				: 'medium',
			reasoning: synthesizedData.reasoning || 'Synthesized analysis from multiple agent perspectives',
		};
	}
}