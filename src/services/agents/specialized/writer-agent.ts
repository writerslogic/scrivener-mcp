import type { StyleGuide } from '../../../memory-manager.js';
import type { ScrivenerDocument } from '../../../types/index.js';
import { SpecializedAgent, type AgentAnalysis, type AgentPersona } from './base-agent.js';
import { EnhancedLangChainService } from '../../ai/langchain-service-enhanced.js';
import { AdvancedLangChainFeatures } from '../../ai/langchain-advanced-features.js';

export class WriterAgent extends SpecializedAgent {
	constructor(langchain: EnhancedLangChainService, advanced: AdvancedLangChainFeatures) {
		const persona: AgentPersona = {
			name: 'Writer',
			role: 'Creative Writing Specialist',
			perspective: 'I focus on the craft of writing - narrative flow, character development, dialogue, and storytelling techniques. I evaluate content from a creative and artistic standpoint.',
			expertise: ['narrative structure', 'character development', 'dialogue writing', 'pacing', 'voice and style', 'creative techniques'],
			personality: 'Creative, intuitive, focused on emotional resonance and artistic expression',
			focusAreas: ['story structure', 'character arcs', 'dialogue quality', 'narrative voice', 'creative expression', 'reader engagement'],
			communicationStyle: 'Encouraging and inspirational, focuses on creative potential',
			biases: ['may prioritize creativity over technical accuracy', 'might overlook structural issues for artistic merit'],
			strengths: ['deep understanding of storytelling', 'creative problem-solving', 'character insight'],
			limitations: ['may be less focused on technical writing aspects', 'could overemphasize style over substance'],
		};
		
		super(langchain, advanced, persona);
	}

	async analyze(document: ScrivenerDocument, styleGuide?: StyleGuide): Promise<AgentAnalysis> {
		const prompt = `
Analyze this document from a creative writing perspective. Focus on:

1. **Narrative Structure**: How well does the story flow? Are there clear beginning, middle, end?
2. **Character Development**: Are characters well-developed, believable, and engaging?
3. **Dialogue**: Does the dialogue sound natural and serve the story?
4. **Pacing**: Does the story move at an appropriate pace for the genre and content?
5. **Voice and Style**: Is the writing voice consistent and engaging?
6. **Creative Techniques**: What literary devices are used effectively or could be improved?

Provide specific examples from the text and actionable suggestions for improvement.
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
As a creative writing specialist, please address this question about the document:

**Question**: ${question}
${context ? `**Additional Context**: ${context}` : ''}

Consider the document from a storytelling perspective:
- How does this relate to narrative effectiveness?
- What creative opportunities does this present?
- How might this impact reader engagement?
- What artistic choices are involved?

Provide insights that help improve the creative and artistic aspects of the writing.
		`;

		const response = await this.langchain.generateWithFallback(prompt);
		return response;
	}

	async critique(analysis: AgentAnalysis, document: ScrivenerDocument): Promise<string> {
		const prompt = `
Review this analysis from a creative writing perspective:

**Original Analysis**:
Agent: ${analysis.agentId}
Overall Score: ${analysis.overallScore}
Priority: ${analysis.priority}
Findings: ${analysis.findings.map(f => `${f.aspect}: ${f.assessment}`).join('; ')}

**Document Context**: ${document.title} (${(document.content || '').split(' ').length} words)

As a creative writing specialist, provide constructive critique:
1. Does this analysis adequately address the creative and artistic aspects?
2. Are there important storytelling elements that were missed?
3. Do the suggestions enhance the narrative and character development?
4. How could this analysis better serve the writer's creative goals?

Focus on the craft of writing and storytelling effectiveness.
		`;

		const response = await this.langchain.generateWithFallback(prompt);
		return response;
	}
}