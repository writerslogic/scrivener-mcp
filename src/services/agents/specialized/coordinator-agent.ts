import type { StyleGuide } from '../../../memory-manager.js';
import type { ScrivenerDocument } from '../../../types/index.js';
import {
	SpecializedAgent,
	type AgentAnalysis,
	type AgentPersona,
	type DiscussionRound,
} from './base-agent.js';
import { EnhancedLangChainService } from '../../ai/langchain-service-enhanced.js';
import { AdvancedLangChainFeatures } from '../../ai/langchain-advanced-features.js';
import { truncate, unique } from '../../../utils/common.js';

export class CoordinatorAgent extends SpecializedAgent {
	constructor(langchain: EnhancedLangChainService, advanced: AdvancedLangChainFeatures) {
		const persona: AgentPersona = {
			name: 'Coordinator',
			role: 'Analysis Coordinator and Synthesizer',
			perspective:
				'I synthesize multiple perspectives, identify consensus, resolve conflicts, and coordinate collaborative analysis efforts.',
			expertise: [
				'synthesis',
				'consensus building',
				'conflict resolution',
				'priority assessment',
				'collaborative coordination',
				'holistic analysis',
			],
			personality: 'Diplomatic, organized, focused on integration and coordination',
			focusAreas: [
				'consensus building',
				'priority synthesis',
				'conflict resolution',
				'collaborative coordination',
				'holistic integration',
				'actionable recommendations',
			],
			communicationStyle: 'Balanced and diplomatic, focuses on synthesis and coordination',
			biases: [
				'may prioritize consensus over individual insights',
				'might dilute strong opinions for harmony',
			],
			strengths: [
				'excellent synthesis abilities',
				'diplomatic coordination',
				'holistic perspective',
			],
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
Findings: ${analysis.findings.map((f) => `${f.aspect}: ${f.assessment}`).join('; ')}

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

		const allAgreements = unique(rounds.flatMap((round) => round.agreements));
		const allInsights = unique(rounds.flatMap((round) => round.newInsights));

		const prompt = `
Based on these discussion rounds, build consensus points:

**Agreements across rounds**: ${allAgreements.join('; ')}
**New insights generated**: ${allInsights.join('; ')}

**Discussion History**:
${rounds
	.map(
		(round) =>
			`Round ${round.roundNumber}: ${round.contributions.length} contributions, ${round.agreements.length} agreements, ${round.newInsights.length} insights`
	)
	.join('\n')}

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

		const allDisagreements = unique(rounds.flatMap((round) => round.disagreements));

		const prompt = `
Identify unresolved issues from these discussion rounds:

**Persistent disagreements**: ${allDisagreements.join('; ')}

**Discussion History**:
${rounds
	.map((round) => `Round ${round.roundNumber}: ${round.disagreements.length} disagreements`)
	.join('\n')}

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

	async synthesizeAnalyses(
		analyses: AgentAnalysis[],
		discussionRounds: DiscussionRound[] = []
	): Promise<AgentAnalysis> {
		if (analyses.length === 0) {
			throw new Error('Cannot synthesize empty analysis array');
		}

		const prompt = `
You are the COORDINATOR of a high-level writing roundtable. 
Your task is to SYNTHESIZE all expert inputs and discussion results into a SOTA final report.

**Expert Initial Analyses**:
${analyses.map((a) => `- ${a.agentId}: Score ${a.overallScore}, Reasoning: ${a.reasoning}`).join('\n')}

**Roundtable Discussion Summary**:
${discussionRounds.map((r) => `Round ${r.roundNumber}: Agreements: ${r.agreements.join(', ')} | New Insights: ${r.newInsights.join(', ')}`).join('\n')}

Create a MASTER SYNTHESIS that:
1. Calibrates the final score based on the consensus level.
2. Identifies "High Confidence" findings where experts agree.
3. Highlights "Unique Expert Insights" from specialized agents.
4. Resolves or flags persistent conflicts.
5. Provides a tiered set of recommendations (Critical vs. Stylistic).

Structure as JSON with the standard AgentAnalysis format.
		`.trim();

		const response = await this.langchain.generateWithFallback(prompt);
		let synthesizedData;
		try {
			synthesizedData = JSON.parse(response);
		} catch {
			// Fallback if parsing fails
			synthesizedData = {
				perspective: 'Synthesized with errors',
				findings: [],
				overallScore: 70,
				priority: 'medium',
				reasoning: 'Failed to parse synthesis JSON',
			};
		}

		return {
			agentId: 'Consensus-Synthesizer',
			perspective: synthesizedData.perspective || 'Roundtable Consensus',
			findings: Array.isArray(synthesizedData.findings) ? synthesizedData.findings : [],
			overallScore: this.calibrateScore(analyses, discussionRounds),
			priority: synthesizedData.priority || 'medium',
			reasoning:
				synthesizedData.reasoning || 'Synthesized analysis from multi-agent roundtable',
		};
	}

	async analyzeRound(
		contributions: any[],
		context: string
	): Promise<{
		agreements: string[];
		disagreements: string[];
		insights: string[];
		consensusScore: number;
	}> {
		const prompt = `
Analyze this discussion round between writing experts:

**Context**: ${truncate(context, 1000)}
**Contributions**:
${contributions.map((c) => `${c.agentId}: ${truncate(c.message, 500)}`).join('\n\n')}

Extract:
1. Points of Agreement (List)
2. Remaining Conflicts or Divergent Views (List)
3. New Breakthrough Insights (List)
4. Overall Consensus Score (0.0 to 1.0)

Return as JSON with fields: agreements, disagreements, insights, consensusScore`;

		const response = await this.langchain.generateWithFallback(prompt);
		try {
			const parsed = JSON.parse(response);
			return {
				agreements: parsed.agreements || [],
				disagreements: parsed.disagreements || [],
				insights: parsed.insights || [],
				consensusScore: Number(parsed.consensusScore) || 0.5,
			};
		} catch {
			return { agreements: [], disagreements: [], insights: [], consensusScore: 0.5 };
		}
	}

	private calibrateScore(analyses: AgentAnalysis[], rounds: DiscussionRound[]): number {
		const baseAvg = analyses.reduce((sum, a) => sum + a.overallScore, 0) / analyses.length;
		const latestConsensus =
			rounds.length > 0 ? (rounds[rounds.length - 1] as any).consensusScore || 0.5 : 0.5;

		// SOTA formula: Weighted average between original scores and final consensus
		return Math.round(baseAvg * 0.4 + latestConsensus * 100 * 0.6);
	}
}
