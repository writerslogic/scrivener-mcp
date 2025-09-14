import type { StyleGuide } from '../../../memory-manager.js';
import type { ScrivenerDocument } from '../../../types/index.js';
import { SpecializedAgent, type AgentAnalysis, type AgentPersona } from './base-agent.js';
import { EnhancedLangChainService } from '../../ai/langchain-service-enhanced.js';
import { AdvancedLangChainFeatures } from '../../ai/langchain-advanced-features.js';

export class CriticAgent extends SpecializedAgent {
	constructor(langchain: EnhancedLangChainService, advanced: AdvancedLangChainFeatures) {
		const persona: AgentPersona = {
			name: 'Critic',
			role: 'Literary Critic and Analyst',
			perspective: 'I provide critical analysis of literary merit, thematic depth, and overall impact. I evaluate content from an analytical and interpretive standpoint.',
			expertise: ['literary analysis', 'thematic interpretation', 'critical theory', 'comparative analysis', 'artistic merit evaluation', 'cultural context'],
			personality: 'Insightful, analytical, focused on deeper meaning and literary value',
			focusAreas: ['thematic depth', 'literary techniques', 'artistic merit', 'cultural significance', 'originality', 'impact assessment'],
			communicationStyle: 'Thoughtful and analytical, focuses on deeper interpretation',
			biases: ['may overanalyze simple content', 'might prioritize complexity over accessibility'],
			strengths: ['deep analytical insight', 'broad literary knowledge', 'thematic understanding'],
			limitations: ['may be overly critical', 'could miss practical writing concerns'],
		};
		
		super(langchain, advanced, persona);
	}

	async analyze(document: ScrivenerDocument, styleGuide?: StyleGuide): Promise<AgentAnalysis> {
		const prompt = `
Analyze this document from a critical and literary perspective. Focus on:

1. **Thematic Depth**: What themes are explored and how effectively?
2. **Literary Merit**: Does the work demonstrate artistic and literary value?
3. **Originality**: How original and innovative is the approach or content?
4. **Cultural Context**: How does the work relate to broader cultural or literary contexts?
5. **Artistic Techniques**: What literary devices and techniques are employed?
6. **Overall Impact**: What is the potential impact or significance of this work?

Provide analytical insights that evaluate the deeper aspects and artistic merit of the content.
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
As a literary critic, please address this question about the document:

**Question**: ${question}
${context ? `**Additional Context**: ${context}` : ''}

Consider the document from a critical and analytical perspective:
- What deeper meanings or themes are present?
- How does this relate to literary and artistic merit?
- What cultural or literary contexts are relevant?
- How might this impact readers or contribute to discourse?

Provide critical insights that reveal deeper layers of meaning and artistic significance.
		`;

		const response = await this.langchain.generateWithFallback(prompt);
		return response;
	}

	async critique(analysis: AgentAnalysis, document: ScrivenerDocument): Promise<string> {
		const prompt = `
Review this analysis from a critical and literary perspective:

**Original Analysis**:
Agent: ${analysis.agentId}
Overall Score: ${analysis.overallScore}
Priority: ${analysis.priority}
Findings: ${analysis.findings.map(f => `${f.aspect}: ${f.assessment}`).join('; ')}

**Document Context**: ${document.title} (${(document.content || '').split(' ').length} words)

As a literary critic, provide constructive critique:
1. Does this analysis adequately explore thematic and artistic dimensions?
2. Are there important literary or cultural aspects that were overlooked?
3. Do the suggestions enhance the work's artistic and literary merit?
4. How could this analysis better serve critical understanding?

Focus on literary merit and deeper analytical insights.
		`;

		const response = await this.langchain.generateWithFallback(prompt);
		return response;
	}
}