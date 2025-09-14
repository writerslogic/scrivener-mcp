import { EventEmitter } from 'events';
import { getLogger } from '../../core/logger.js';
import type { StyleGuide } from '../../memory-manager.js';
import type { ScrivenerDocument } from '../../types/index.js';
import {
	AppError,
	ErrorCode,
	formatDuration,
	handleError,
	safeParse,
	truncate,
	unique,
	validateInput,
} from '../../utils/common.js';
import { formatStyleGuideContext } from '../../utils/style-guide-formatter.js';
import { getTextMetrics } from '../../utils/text-metrics.js';
import { AdvancedLangChainFeatures } from '../ai/langchain-advanced-features.js';
import { EnhancedLangChainService } from '../ai/langchain-service-enhanced.js';
const Logger = getLogger;

export interface AgentPersona {
	name: string;
	role: string;
	perspective: string;
	expertise: string[];
	personality: string;
	focusAreas: string[];
	communicationStyle: string;
	biases: string[];
	strengths: string[];
	limitations: string[];
}

export interface AgentAnalysis {
	agentId: string;
	perspective: string;
	findings: Array<{
		aspect: string;
		assessment: string;
		confidence: number;
		evidence: string[];
		suggestions: string[];
	}>;
	overallScore: number;
	priority: 'critical' | 'high' | 'medium' | 'low';
	reasoning: string;
}

export interface CollaborativeResult {
	consensus: {
		agreements: Array<{ aspect: string; confidence: number; agents: string[] }>;
		disagreements: Array<{
			aspect: string;
			positions: Array<{ agent: string; position: string; confidence: number }>;
		}>;
		unresolved: string[];
	};
	synthesis: {
		combinedScore: number;
		keyFindings: string[];
		actionPriorities: Array<{ action: string; urgency: number; complexity: string }>;
		tradeoffs: Array<{ decision: string; benefits: string[]; costs: string[] }>;
	};
	recommendations: Array<{
		recommendation: string;
		supportingAgents: string[];
		dissenting: Array<{ agent: string; concerns: string[] }>;
		confidence: number;
		implementation: {
			effort: 'low' | 'medium' | 'high' | 'very-high';
			timeframe: string;
			dependencies: string[];
		};
	}>;
	individualPerspectives: AgentAnalysis[];
}

export interface AgentDiscussion {
	id: string;
	topic: string;
	participants: string[];
	rounds: Array<{
		round: number;
		contributions: Array<{
			agentId: string;
			message: string;
			references: string[];
			questions: string[];
		}>;
		agreements: string[];
		newInsights: string[];
	}>;
	finalConsensus: string[];
	unresolved: string[];
}

export interface DiscussionRound {
	round: number;
	contributions: Array<{
		agentId: string;
		message: string;
		references: string[];
		questions: string[];
	}>;
	agreements: string[];
	newInsights: string[];
}

export interface AgentAnalysisResult {
	perspective: string;
	findings: string[];
	overallScore: number;
	priority: 'low' | 'medium' | 'high';
	reasoning: string;
}

export interface WorkshopPhaseOutput {
	agentId: string;
	type: 'analysis' | 'suggestion' | 'question' | 'insight';
	content: string;
	confidence: number;
	timestamp: string;
}

export interface WorkshopSession {
	id: string;
	document: ScrivenerDocument;
	focus: string[];
	agents: SpecializedAgent[];
	phases: Array<{
		name: string;
		duration: number;
		activities: string[];
		outputs: WorkshopPhaseOutput[];
	}>;
	results: CollaborativeResult;
	insights: string[];
	followUpActions: string[];
}

abstract class SpecializedAgent {
	protected langchain: EnhancedLangChainService;
	protected advanced: AdvancedLangChainFeatures;
	protected logger: ReturnType<typeof getLogger>;
	public persona: AgentPersona;
	private operationMetrics = new Map<string, { totalTime: number; callCount: number }>();

	constructor(persona: AgentPersona) {
		this.langchain = new EnhancedLangChainService();
		this.advanced = new AdvancedLangChainFeatures();
		this.logger = Logger(`Agent_${persona.name}`);
		this.persona = persona;

		// Validate persona structure
		validateInput(
			{ persona },
			{
				persona: {
					type: 'object',
					required: true,
				},
			}
		);
	}

	/**
	 * Track operation performance metrics
	 */
	private updateOperationMetrics(
		operationName: string,
		executionTime: number,
		success: boolean
	): void {
		const existing = this.operationMetrics.get(operationName) || { totalTime: 0, callCount: 0 };
		existing.totalTime += executionTime;
		existing.callCount += 1;
		this.operationMetrics.set(operationName, existing);

		this.logger.debug(
			`Agent ${this.persona.name} operation ${operationName} ${success ? 'succeeded' : 'failed'} in ${formatDuration(executionTime)}`,
			{
				averageTime: formatDuration(existing.totalTime / existing.callCount),
				callCount: existing.callCount,
				success,
			}
		);
	}

	/**
	 * Get performance metrics for monitoring
	 */
	getOperationMetrics(): Record<string, { averageTime: number; callCount: number }> {
		const result: Record<string, { averageTime: number; callCount: number }> = {};
		for (const [operation, metrics] of this.operationMetrics.entries()) {
			result[operation] = {
				averageTime: metrics.totalTime / metrics.callCount,
				callCount: metrics.callCount,
			};
		}
		return result;
	}

	abstract analyze(document: ScrivenerDocument, styleGuide?: StyleGuide): Promise<AgentAnalysis>;

	abstract providePerspective(
		document: ScrivenerDocument,
		styleGuide?: StyleGuide
	): Promise<string>;

	abstract critique(
		document: ScrivenerDocument,
		otherAnalysis?: AgentAnalysis,
		styleGuide?: StyleGuide
	): Promise<string>;

	protected async generateAnalysis(
		document: ScrivenerDocument,
		focusPrompt: string,
		specificQuestions: string[],
		styleGuide?: StyleGuide
	): Promise<AgentAnalysis> {
		// Validate input parameters
		validateInput(
			{ document, focusPrompt, specificQuestions },
			{
				document: { type: 'object', required: true },
				focusPrompt: { type: 'string', required: true, minLength: 10 },
				specificQuestions: { type: 'array', required: true },
			}
		);

		const operationName = 'generateAnalysis';
		const startTime = performance.now();

		// Get text metrics for logging and analysis
		const content = document.content || '';
		const textMetrics = getTextMetrics(content);

		try {
			const truncatedContent = truncate(content, 2000);

			this.logger.debug(`Generating analysis for document "${document.title}"`, {
				wordCount: textMetrics.wordCount,
				sentenceCount: textMetrics.sentenceCount,
				paragraphCount: textMetrics.paragraphCount,
				hasStyleGuide: !!styleGuide,
				focusAreas: this.persona.focusAreas.join(', '),
			});
			// Include style guide information if available
			const styleGuideContext = formatStyleGuideContext(styleGuide, {
				contextType: 'analysis',
				customFields: ['voice', 'styleNotes'],
			});

			const prompt = `As a ${this.persona.expertise.join(' and ')} specialist with a ${this.persona.personality} personality, analyze this document:

Title: "${document.title}"
Content: "${truncatedContent}..."
Word Count: ${textMetrics.wordCount}
Sentences: ${textMetrics.sentenceCount}
Reading Time: ${textMetrics.readingTimeMinutes} minutes

${styleGuideContext}

${focusPrompt}

Your expertise: ${this.persona.expertise.join(', ')}
Your focus areas: ${this.persona.focusAreas.join(', ')}
Communication style: ${this.persona.communicationStyle}

Specific questions to address:
${specificQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}

Provide analysis with:
1. Overall perspective on the work
2. Specific findings with confidence levels
3. Evidence-based assessments
4. Actionable suggestions
5. Overall score (0-100)
6. Priority level and reasoning

Keep your ${this.persona.personality} personality and ${this.persona.communicationStyle} style throughout.

Return JSON with fields: perspective, findings, overallScore, priority, reasoning`;

			const result = await this.langchain.generateWithTemplate('agent_analysis', content, {
				agentPersona: this.persona,
				focusAreas: this.persona.focusAreas,
				format: 'json',
				customPrompt: prompt,
			});

			const analysis = safeParse(result.content, {
				perspective: '',
				findings: [],
				overallScore: 0,
				priority: 'medium' as const,
				reasoning: '',
			}) as AgentAnalysisResult;

			const finalAnalysis: AgentAnalysis = {
				agentId: this.persona.name,
				perspective: analysis.perspective || `Analysis from ${this.persona.name}`,
				findings: Array.isArray(analysis.findings)
					? analysis.findings.map((finding: unknown) => {
							const f = finding as Record<string, unknown>;
							return {
								aspect: String(f.aspect || 'General'),
								assessment: String(f.assessment || 'Analysis performed'),
								confidence: Number(f.confidence) || 0.7,
								evidence: Array.isArray(f.evidence) ? f.evidence.map(String) : [],
								suggestions: Array.isArray(f.suggestions)
									? f.suggestions.map(String)
									: [],
							};
						})
					: [],
				overallScore: Math.max(0, Math.min(100, analysis.overallScore || 70)),
				priority: analysis.priority || 'medium',
				reasoning: analysis.reasoning || 'Standard analysis completed',
			};

			this.updateOperationMetrics(operationName, performance.now() - startTime, true);
			return finalAnalysis;
		} catch (error) {
			this.updateOperationMetrics(operationName, performance.now() - startTime, false);
			const appError = handleError(
				error,
				`SpecializedAgent.generateAnalysis [${this.persona.name}]`
			);
			this.logger.error('Failed to generate agent analysis', {
				error: appError.message,
				operation: 'Generating agent analysis',
				documentTitle: document.title,
				wordCount: textMetrics.wordCount,
			});

			return {
				agentId: this.persona.name,
				perspective: 'Analysis unavailable due to technical error',
				findings: [],
				overallScore: 50,
				priority: 'low' as const,
				reasoning: 'Analysis could not be completed',
			};
		}
	}

	async discussWith(
		otherAgent: SpecializedAgent,
		topic: string,
		rounds: number = 3
	): Promise<AgentDiscussion> {
		const discussion: AgentDiscussion = {
			id: `discussion_${Date.now()}`,
			topic,
			participants: [this.persona.name, otherAgent.persona.name],
			rounds: [],
			finalConsensus: [],
			unresolved: [],
		};

		try {
			for (let round = 1; round <= rounds; round++) {
				const roundData = {
					round,
					contributions: [] as Array<{
						agentId: string;
						message: string;
						references: string[];
						questions: string[];
					}>,
					agreements: [] as string[],
					newInsights: [] as string[],
				};

				// This agent's contribution
				const myContribution = await this.generateDiscussionContribution(
					topic,
					discussion.rounds,
					round
				);
				roundData.contributions.push({
					agentId: this.persona.name,
					message: myContribution.message,
					references: myContribution.references,
					questions: myContribution.questions,
				});

				// Other agent's contribution
				const otherContribution = await otherAgent.generateDiscussionContribution(
					topic,
					discussion.rounds,
					round
				);
				roundData.contributions.push({
					agentId: otherAgent.persona.name,
					message: otherContribution.message,
					references: otherContribution.references,
					questions: otherContribution.questions,
				});

				// Find agreements and insights
				roundData.agreements = await this.findAgreements(
					myContribution.message,
					otherContribution.message
				);
				roundData.newInsights = await this.extractNewInsights(roundData.contributions);

				discussion.rounds.push(roundData);
			}

			// Build final consensus
			discussion.finalConsensus = await this.buildConsensus(discussion.rounds);
			discussion.unresolved = await this.identifyUnresolved(discussion.rounds);
		} catch (error) {
			this.logger.error('Agent discussion failed', { error: (error as Error).message });
		}

		return discussion;
	}

	private async generateDiscussionContribution(
		topic: string,
		previousRounds: DiscussionRound[],
		currentRound: number
	): Promise<{ message: string; references: string[]; questions: string[] }> {
		const context = previousRounds
			.map((r) => r.contributions.map((c) => `${c.agentId}: ${c.message}`).join('\n'))
			.join('\n\n');

		const prompt = `As ${this.persona.name} (${this.persona.personality} ${this.persona.expertise.join(' and ')} specialist), contribute to this discussion:

Topic: ${topic}
Round: ${currentRound}
Communication style: ${this.persona.communicationStyle}

Previous discussion:
${context}

Provide your perspective, addressing:
1. Your expert viewpoint on the topic
2. Response to previous points
3. New insights from your expertise
4. Questions for other participants

Stay true to your ${this.persona.personality} personality and ${this.persona.communicationStyle} communication style.
Be constructive but don't hesitate to disagree when your expertise suggests otherwise.

Return JSON with: message, references, questions`;

		try {
			const result = await this.langchain.generateWithTemplate(
				'discussion_contribution',
				topic,
				{
					agent: this.persona,
					round: currentRound,
					format: 'json',
					customPrompt: prompt,
				}
			);

			const contribution = JSON.parse(result.content);
			return {
				message: contribution.message || 'No contribution available',
				references: Array.isArray(contribution.references) ? contribution.references : [],
				questions: Array.isArray(contribution.questions) ? contribution.questions : [],
			};
		} catch (error) {
			this.logger.error('Agent contribution failed', {
				agentName: this.persona.name,
				error: (error as Error).message,
			});
			return {
				message: `${this.persona.name}: I need to analyze this topic further.`,
				references: [],
				questions: [],
			};
		}
	}

	private async findAgreements(message1: string, message2: string): Promise<string[]> {
		const prompt = `Find points of agreement between these two perspectives:

Perspective 1: ${message1}
Perspective 2: ${message2}

Return only the specific points where both perspectives align or complement each other.
Return as JSON array of agreement strings.`;

		try {
			const result = await this.langchain.generateWithTemplate(
				'find_agreements',
				`${message1}\n\n${message2}`,
				{ format: 'json', customPrompt: prompt }
			);

			const agreements = JSON.parse(result.content);
			return Array.isArray(agreements) ? agreements : [];
		} catch {
			return [];
		}
	}

	private async extractNewInsights(
		contributions: Array<{
			agentId: string;
			message: string;
			references: string[];
			questions: string[];
		}>
	): Promise<string[]> {
		const combined = contributions.map((c) => c.message).join('\n\n');

		const prompt = `Extract new insights that emerged from this discussion round:

${combined}

Identify novel ideas, unexpected connections, or emergent understanding that arose from the interaction.
Return as JSON array of insight strings.`;

		try {
			const result = await this.langchain.generateWithTemplate('extract_insights', combined, {
				format: 'json',
				customPrompt: prompt,
			});

			const insights = JSON.parse(result.content);
			return Array.isArray(insights) ? insights : [];
		} catch {
			return [];
		}
	}

	private async buildConsensus(rounds: DiscussionRound[]): Promise<string[]> {
		const allAgreements = rounds.flatMap((r) => r.agreements);
		const allInsights = rounds.flatMap((r) => r.newInsights);

		return unique([...allAgreements, ...allInsights]);
	}

	private async identifyUnresolved(rounds: DiscussionRound[]): Promise<string[]> {
		const allContributions = rounds
			.flatMap((r) => r.contributions.map((c) => c.message))
			.join('\n\n');

		const prompt = `Identify unresolved issues or ongoing disagreements from this discussion:

${allContributions}

Return JSON array of unresolved issues or points of continuing disagreement.`;

		try {
			const result = await this.langchain.generateWithTemplate(
				'identify_unresolved',
				allContributions,
				{ format: 'json', customPrompt: prompt }
			);

			const unresolved = JSON.parse(result.content);
			return Array.isArray(unresolved) ? unresolved : [];
		} catch {
			return [];
		}
	}
}

export class EditorAgent extends SpecializedAgent {
	constructor() {
		super({
			name: 'Editor',
			role: 'Developmental Editor',
			perspective: 'Structural and commercial analysis',
			expertise: ['developmental editing', 'story structure', 'narrative flow'],
			personality: 'analytical and constructive',
			focusAreas: [
				'plot consistency',
				'character development',
				'pacing',
				'overall structure',
			],
			communicationStyle: 'direct but supportive',
			biases: ['prefers traditional story structures', 'focuses on commercial viability'],
			strengths: ['structural analysis', 'market awareness', 'objective assessment'],
			limitations: ['may overlook experimental approaches', 'can be overly commercial'],
		});
	}

	async analyze(document: ScrivenerDocument, styleGuide?: StyleGuide): Promise<AgentAnalysis> {
		return this.generateAnalysis(
			document,
			'Focus on structural elements, plot coherence, character development, and commercial potential.',
			[
				'Is the story structure sound and engaging?',
				'Are characters well-developed with clear arcs?',
				'Does the pacing work throughout?',
				'What are the commercial prospects?',
				'What structural improvements are needed?',
			],
			styleGuide
		);
	}

	async providePerspective(
		document: ScrivenerDocument,
		styleGuide?: StyleGuide
	): Promise<string> {
		const styleGuideContext = formatStyleGuideContext(styleGuide, {
			contextType: 'perspective',
		});

		const prompt = `As an experienced developmental editor, provide your professional perspective on this manuscript:

"${document.title}"
${(document.content || '').slice(0, 1500)}...${styleGuideContext}

Focus on:
- Overall structure and organization
- Character development and arcs
- Plot coherence and pacing
- Commercial viability
- Reader engagement potential
${styleGuide ? '- Adherence to style guide requirements' : ''}

Provide honest, constructive feedback in your direct but supportive style.`;

		try {
			const result = await this.langchain.generateWithTemplate(
				'editor_perspective',
				document.content || '',
				{ customPrompt: prompt }
			);
			return result.content;
		} catch {
			return 'As an editor, I see potential in this work that needs structural development.';
		}
	}

	async critique(
		document: ScrivenerDocument,
		otherAnalysis?: AgentAnalysis,
		styleGuide?: StyleGuide
	): Promise<string> {
		const context = otherAnalysis
			? `\n\nOther analysis to consider: ${otherAnalysis.perspective}`
			: '';

		const styleGuideContext = formatStyleGuideContext(styleGuide, { contextType: 'critique' });

		const prompt = `As a developmental editor, provide constructive critique of this work:

"${document.title}"
${(document.content || '').slice(0, 1000)}...${context}${styleGuideContext}

Give specific, actionable feedback focusing on:
- What's working well
- What needs improvement
- Specific suggestions for fixes
- Priority of changes
${styleGuide ? '- Style guide compliance issues' : ''}

Be direct but encouraging, as befits an experienced editor.`;

		try {
			const result = await this.langchain.generateWithTemplate(
				'editor_critique',
				document.content || '',
				{ customPrompt: prompt }
			);
			return result.content;
		} catch {
			return 'This manuscript needs focused revision in several key areas.';
		}
	}
}

export class CriticAgent extends SpecializedAgent {
	constructor() {
		super({
			name: 'Critic',
			role: 'Literary Critic',
			perspective: 'Artistic and thematic analysis',
			expertise: ['literary analysis', 'thematic depth', 'artistic merit'],
			personality: 'intellectually rigorous and challenging',
			focusAreas: [
				'thematic coherence',
				'artistic innovation',
				'literary significance',
				'depth',
			],
			communicationStyle: 'scholarly and probing',
			biases: ['values literary merit over commercial appeal', 'prefers complexity'],
			strengths: ['deep analysis', 'thematic insight', 'artistic evaluation'],
			limitations: ['may undervalue accessibility', 'can be overly theoretical'],
		});
	}

	async analyze(document: ScrivenerDocument, styleGuide?: StyleGuide): Promise<AgentAnalysis> {
		const styleGuideContext = formatStyleGuideContext(styleGuide, { contextType: 'critique' });
		const enhancedPrompt = `Examine thematic depth, artistic merit, literary significance, and innovative elements.${
			styleGuide
				? ` Consider how well the work aligns with the specified style and genre expectations.${styleGuideContext}`
				: ''
		}`;

		return this.generateAnalysis(document, enhancedPrompt, [
			'What themes are explored and how effectively?',
			'Is there artistic innovation or unique voice?',
			'How does this contribute to literary discourse?',
			"What is the work's intellectual depth?",
			'Are there layers of meaning to discover?',
			...(styleGuide ? ['Does it meet the specified style and genre requirements?'] : []),
		]);
	}

	async providePerspective(
		document: ScrivenerDocument,
		styleGuide?: StyleGuide
	): Promise<string> {
		const styleGuideContext = formatStyleGuideContext(styleGuide, {
			contextType: 'perspective',
		});

		const prompt = `As a literary critic, analyze this work for its artistic and thematic merit:

"${document.title}"
${(document.content || '').slice(0, 1500)}...${styleGuideContext}

Examine:
- Thematic depth and complexity
- Artistic innovation and technique
- Literary significance and contribution
- Layers of meaning and interpretation
- Intellectual engagement
${styleGuide ? '- Genre and stylistic adherence' : ''}

Provide a scholarly but accessible analysis in your rigorous style.`;

		try {
			const result = await this.langchain.generateWithTemplate(
				'critic_perspective',
				document.content || '',
				{ customPrompt: prompt }
			);
			return result.content;
		} catch {
			return 'This work presents interesting thematic possibilities that warrant deeper exploration.';
		}
	}

	async critique(
		document: ScrivenerDocument,
		otherAnalysis?: AgentAnalysis,
		styleGuide?: StyleGuide
	): Promise<string> {
		const context = otherAnalysis ? `\n\nOther analysis: ${otherAnalysis.perspective}` : '';
		const styleGuideContext = formatStyleGuideContext(styleGuide, { contextType: 'critique' });

		const prompt = `As a literary critic, provide intellectual critique of this work:

"${document.title}"
${(document.content || '').slice(0, 1000)}...${context}${styleGuideContext}

Challenge the work on:
- Thematic development and coherence
- Artistic ambition vs execution
- Intellectual depth and rigor
- Innovation vs convention
- Contribution to literary discourse
${styleGuide ? '- Adherence to stated stylistic goals' : ''}

Be intellectually honest and challenging while remaining constructive.`;

		try {
			const result = await this.langchain.generateWithTemplate(
				'critic_critique',
				document.content || '',
				{ customPrompt: prompt }
			);
			return result.content;
		} catch {
			return 'This work would benefit from greater thematic ambition and artistic risk-taking.';
		}
	}
}

export class ResearcherAgent extends SpecializedAgent {
	constructor() {
		super({
			name: 'Researcher',
			role: 'Fact Checker',
			perspective: 'Accuracy and consistency verification',
			expertise: ['fact-checking', 'historical accuracy', 'world-building consistency'],
			personality: 'meticulous and detail-oriented',
			focusAreas: ['accuracy', 'consistency', 'plausibility', 'research depth'],
			communicationStyle: 'precise and evidence-based',
			biases: ['prioritizes accuracy over artistic license', 'can be pedantic'],
			strengths: ['attention to detail', 'verification skills', 'consistency tracking'],
			limitations: [
				'may stifle creativity with over-focus on facts',
				'can miss emotional truth',
			],
		});
	}

	async analyze(document: ScrivenerDocument, styleGuide?: StyleGuide): Promise<AgentAnalysis> {
		const styleGuideContext = formatStyleGuideContext(styleGuide, { contextType: 'critique' });
		const enhancedPrompt = `Verify factual accuracy, internal consistency, and plausibility of world-building elements.${
			styleGuide
				? ` Ensure accuracy standards align with the specified style guide requirements.${styleGuideContext}`
				: ''
		}`;

		return this.generateAnalysis(document, enhancedPrompt, [
			'Are factual claims accurate and verifiable?',
			'Is the internal logic consistent throughout?',
			'Are world-building elements plausible?',
			'What research gaps need addressing?',
			'Are there consistency issues to resolve?',
			...(styleGuide ? ['Do accuracy standards match style guide expectations?'] : []),
		]);
	}

	async providePerspective(
		document: ScrivenerDocument,
		styleGuide?: StyleGuide
	): Promise<string> {
		const styleGuideContext = formatStyleGuideContext(styleGuide, {
			contextType: 'perspective',
		});

		const prompt = `As a detail-oriented researcher, examine this work for accuracy and consistency:

"${document.title}"
${(document.content || '').slice(0, 1500)}...${styleGuideContext}

Investigate:
- Factual accuracy of claims and references
- Internal consistency of world-building
- Plausibility of scenarios and events
- Research depth and authenticity
- Logical coherence throughout

Provide precise, evidence-based observations in your meticulous style.`;

		try {
			const result = await this.langchain.generateWithTemplate(
				'researcher_perspective',
				document.content || '',
				{ customPrompt: prompt }
			);
			return result.content;
		} catch {
			return 'This work requires careful fact-checking and consistency verification.';
		}
	}

	async critique(
		document: ScrivenerDocument,
		otherAnalysis?: AgentAnalysis,
		styleGuide?: StyleGuide
	): Promise<string> {
		const context = otherAnalysis ? `\n\nOther analysis: ${otherAnalysis.perspective}` : '';
		const styleGuideContext = formatStyleGuideContext(styleGuide, { contextType: 'critique' });

		const prompt = `As a researcher, identify accuracy and consistency issues in this work:

"${document.title}"
${(document.content || '').slice(0, 1000)}...${context}${styleGuideContext}

Flag issues with:
- Factual accuracy and verification needs
- Internal consistency problems
- World-building logic gaps
- Research requirements
- Timeline or continuity errors

Be thorough and precise in identifying specific issues.`;

		try {
			const result = await this.langchain.generateWithTemplate(
				'researcher_critique',
				document.content || '',
				{ customPrompt: prompt }
			);
			return result.content;
		} catch {
			return 'Several areas require fact-checking and consistency review.';
		}
	}
}

export class StylistAgent extends SpecializedAgent {
	constructor() {
		super({
			name: 'Stylist',
			role: 'Style Editor',
			perspective: 'Language and voice craftsmanship',
			expertise: ['prose style', 'voice development', 'language craft'],
			personality: 'artistic and language-focused',
			focusAreas: ['prose quality', 'voice consistency', 'language beauty', 'rhythm'],
			communicationStyle: 'expressive and craft-focused',
			biases: ['prioritizes beautiful language', 'may sacrifice clarity for style'],
			strengths: ['language sensitivity', 'voice recognition', 'stylistic analysis'],
			limitations: ['may overlook plot for prose', 'can be overly aesthetic'],
		});
	}

	async analyze(document: ScrivenerDocument, styleGuide?: StyleGuide): Promise<AgentAnalysis> {
		const focusPrompt = styleGuide
			? `Evaluate prose style, voice consistency, and language craft with particular attention to the provided style guide requirements. Assess how well the writing aligns with the specified genre, audience, tone, and voice expectations.`
			: 'Evaluate prose style, voice consistency, language craft, and overall artistic expression.';

		const questions = styleGuide
			? [
					'How well does the prose style match the intended genre and audience?',
					'Is the narrative voice consistent with the style guide requirements?',
					'Does the tone align with the specified style guide tone?',
					'How effectively does the language serve the target audience?',
					'What stylistic adjustments would better serve the style requirements?',
				]
			: [
					'Is the prose style distinctive and effective?',
					'How consistent is the narrative voice?',
					'What is the quality of language craft?',
					'Does the rhythm and flow work well?',
					'How can the stylistic elements be enhanced?',
				];

		return this.generateAnalysis(document, focusPrompt, questions, styleGuide);
	}

	async providePerspective(
		document: ScrivenerDocument,
		styleGuide?: StyleGuide
	): Promise<string> {
		const styleGuideContext = formatStyleGuideContext(styleGuide, {
			contextType: 'perspective',
		});

		const prompt = `As a prose stylist, analyze the language and voice in this work:

"${document.title}"
${(document.content || '').slice(0, 1500)}...${styleGuideContext}

Examine:
- Prose style and distinctiveness
- Voice consistency and strength
- Language craft and word choice
- Rhythm, flow, and musicality
- Stylistic effectiveness and beauty

Provide artistic, craft-focused observations in your expressive style.`;

		try {
			const result = await this.langchain.generateWithTemplate(
				'stylist_perspective',
				document.content || '',
				{ customPrompt: prompt }
			);
			return result.content;
		} catch {
			return 'The prose shows potential but needs refinement in voice and stylistic consistency.';
		}
	}

	async critique(
		document: ScrivenerDocument,
		otherAnalysis?: AgentAnalysis,
		styleGuide?: StyleGuide
	): Promise<string> {
		const context = otherAnalysis ? `\n\nOther analysis: ${otherAnalysis.perspective}` : '';
		const styleGuideContext = formatStyleGuideContext(styleGuide, { contextType: 'critique' });

		const prompt = `As a stylist, critique the language and prose craft in this work:

"${document.title}"
${(document.content || '').slice(0, 1000)}...${context}${styleGuideContext}

Focus on:
- Prose style strengths and weaknesses
- Voice development opportunities
- Language craft improvements
- Rhythm and flow adjustments
- Overall stylistic enhancement

Be artistic and craft-focused in your feedback.`;

		try {
			const result = await this.langchain.generateWithTemplate(
				'stylist_critique',
				document.content || '',
				{ customPrompt: prompt }
			);
			return result.content;
		} catch {
			return 'The prose needs attention to voice consistency and stylistic refinement.';
		}
	}
}

export class PlotterAgent extends SpecializedAgent {
	constructor() {
		super({
			name: 'Plotter',
			role: 'Plot Analyst',
			perspective: 'Structural and mechanical narrative analysis',
			expertise: ['plot structure', 'story mechanics', 'narrative engineering'],
			personality: 'systematic and logic-driven',
			focusAreas: ['plot logic', 'story beats', 'conflict structure', 'resolution'],
			communicationStyle: 'analytical and systematic',
			biases: ['prefers well-plotted stories', 'may undervalue character-driven work'],
			strengths: ['structural analysis', 'plot mechanics', 'story logic'],
			limitations: ['may overlook emotional nuance', 'can be formulaic'],
		});
	}

	async analyze(document: ScrivenerDocument, styleGuide?: StyleGuide): Promise<AgentAnalysis> {
		const styleGuideContext = formatStyleGuideContext(styleGuide, { contextType: 'critique' });
		const enhancedPrompt = `Analyze plot structure, story mechanics, conflict development, and narrative logic.${
			styleGuide
				? ` Consider how plot requirements align with the specified genre and style expectations.${styleGuideContext}`
				: ''
		}`;

		return this.generateAnalysis(document, enhancedPrompt, [
			'Does the plot structure work effectively?',
			'Are story beats properly developed?',
			'Is conflict escalation well-managed?',
			'How solid is the story logic?',
			'What plot improvements are needed?',
			...(styleGuide ? ['Does the plot structure fit genre expectations?'] : []),
		]);
	}

	async providePerspective(
		document: ScrivenerDocument,
		styleGuide?: StyleGuide
	): Promise<string> {
		const styleGuideContext = formatStyleGuideContext(styleGuide, {
			contextType: 'perspective',
		});

		const prompt = `As a plot specialist, analyze the story structure and mechanics:

"${document.title}"
${(document.content || '').slice(0, 1500)}...${styleGuideContext}

Examine:
- Plot structure and story beats
- Conflict development and escalation
- Cause-and-effect relationships
- Story logic and mechanics
- Narrative momentum and tension

Provide systematic, analytically-focused observations.`;

		try {
			const result = await this.langchain.generateWithTemplate(
				'plotter_perspective',
				document.content || '',
				{ customPrompt: prompt }
			);
			return result.content;
		} catch {
			return 'The plot structure needs systematic development and stronger story mechanics.';
		}
	}

	async critique(
		document: ScrivenerDocument,
		otherAnalysis?: AgentAnalysis,
		styleGuide?: StyleGuide
	): Promise<string> {
		const context = otherAnalysis ? `\n\nOther analysis: ${otherAnalysis.perspective}` : '';
		const styleGuideContext = formatStyleGuideContext(styleGuide, { contextType: 'critique' });

		const prompt = `As a plot specialist, critique the story structure and mechanics:

"${document.title}"
${(document.content || '').slice(0, 1000)}...${context}${styleGuideContext}

Analyze:
- Plot structure effectiveness
- Story beat development
- Conflict and tension management
- Logical consistency
- Narrative momentum

Be systematic and logic-focused in your critique.`;

		try {
			const result = await this.langchain.generateWithTemplate(
				'plotter_critique',
				document.content || '',
				{ customPrompt: prompt }
			);
			return result.content;
		} catch {
			return 'The plot requires structural revision and stronger story mechanics.';
		}
	}
}

export class LangChainMultiAgentSystem extends EventEmitter {
	private agents: Map<string, SpecializedAgent>;
	private logger: ReturnType<typeof getLogger>;
	private activeWorkshops: Map<string, WorkshopSession> = new Map();
	private systemMetrics = new Map<
		string,
		{ totalTime: number; callCount: number; successCount: number }
	>();

	constructor() {
		super();
		this.logger = getLogger('MultiAgentSystem');
		this.agents = new Map([
			['editor', new EditorAgent()],
			['critic', new CriticAgent()],
			['researcher', new ResearcherAgent()],
			['stylist', new StylistAgent()],
			['plotter', new PlotterAgent()],
		]);

		this.logger.info('Multi-agent system initialized', {
			agentCount: this.agents.size,
			availableAgents: Array.from(this.agents.keys()),
		});
	}

	/**
	 * Track system-level operation metrics
	 */
	private updateSystemMetrics(
		operationName: string,
		executionTime: number,
		success: boolean
	): void {
		const existing = this.systemMetrics.get(operationName) || {
			totalTime: 0,
			callCount: 0,
			successCount: 0,
		};
		existing.totalTime += executionTime;
		existing.callCount += 1;
		if (success) existing.successCount += 1;
		this.systemMetrics.set(operationName, existing);

		const successRate = (existing.successCount / existing.callCount) * 100;
		this.logger.debug(
			`System operation ${operationName} completed in ${formatDuration(executionTime)}`,
			{
				averageTime: formatDuration(existing.totalTime / existing.callCount),
				callCount: existing.callCount,
				successRate: `${successRate.toFixed(1)}%`,
				success,
			}
		);
	}

	/**
	 * Get comprehensive system metrics including all agents
	 */
	getSystemMetrics(): {
		systemOperations: Record<
			string,
			{ averageTime: number; callCount: number; successRate: number }
		>;
		agentMetrics: Record<string, Record<string, { averageTime: number; callCount: number }>>;
		activeWorkshops: number;
	} {
		const systemOperations: Record<
			string,
			{ averageTime: number; callCount: number; successRate: number }
		> = {};
		for (const [operation, metrics] of this.systemMetrics.entries()) {
			systemOperations[operation] = {
				averageTime: metrics.totalTime / metrics.callCount,
				callCount: metrics.callCount,
				successRate: (metrics.successCount / metrics.callCount) * 100,
			};
		}

		const agentMetrics: Record<
			string,
			Record<string, { averageTime: number; callCount: number }>
		> = {};
		for (const [agentId, agent] of this.agents.entries()) {
			agentMetrics[agentId] = agent.getOperationMetrics();
		}

		return {
			systemOperations,
			agentMetrics,
			activeWorkshops: this.activeWorkshops.size,
		};
	}

	async initialize(): Promise<void> {
		// Initialize all agents if needed
		this.logger.info('Multi-agent system initialized');
	}

	async collaborativeEdit(
		document: ScrivenerDocument,
		options?: {
			agents?: string[];
			rounds?: number;
			focusAreas?: string[];
		}
	): Promise<CollaborativeResult> {
		// Validate input
		validateInput(
			{ document, options },
			{
				document: {
					type: 'object',
					required: true,
				},
				options: { type: 'object', required: false },
			}
		);

		const {
			agents: selectedAgents = ['editor', 'critic', 'stylist', 'plotter'],
			rounds = 1,
			focusAreas = [],
		} = options || {};

		const operationName = 'collaborativeEdit';
		const startTime = performance.now();

		try {
			// Get document metrics for logging
			const textMetrics = getTextMetrics(document.content || '');

			this.logger.info(`Starting collaborative edit`, {
				agentCount: selectedAgents.length,
				rounds,
				focusAreas,
				wordCount: textMetrics.wordCount,
				readingTime: textMetrics.readingTimeMinutes,
				documentTitle: document.title,
			});

			let currentAnalyses: AgentAnalysis[] = [];

			// Run collaborative rounds for iterative improvement
			for (let round = 1; round <= rounds; round++) {
				this.logger.debug(`Running collaborative round ${round} of ${rounds}`);

				// Analysis by all agents
				const individualAnalyses = await Promise.all(
					selectedAgents.map(async (agentId) => {
						const agent = this.agents.get(agentId);
						if (!agent) throw new Error(`Agent ${agentId} not found`);
						return agent.analyze(document);
					})
				);

				currentAnalyses = individualAnalyses;

				// Break on final round to proceed to synthesis
				if (round === rounds) break;

				this.logger.debug(`Completed round ${round}, preparing for next iteration`);
			}

			// Find consensus and disagreements from final round
			const consensus = await this.buildConsensus(currentAnalyses);

			// Synthesize findings
			const synthesis = await this.synthesizeAnalyses(currentAnalyses, focusAreas);

			// Generate collaborative recommendations
			const recommendations = await this.generateCollaborativeRecommendations(
				currentAnalyses,
				consensus,
				synthesis
			);

			const result: CollaborativeResult = {
				consensus,
				synthesis,
				recommendations,
				individualPerspectives: currentAnalyses,
			};

			this.updateSystemMetrics(operationName, performance.now() - startTime, true);
			this.emit('collaborativeEditCompleted', { document: document.id, result });
			return result;
		} catch (error) {
			this.updateSystemMetrics(operationName, performance.now() - startTime, false);
			handleError(error, 'LangChainMultiAgentSystem.collaborativeEdit');
			throw new AppError('Multi-agent collaboration failed', ErrorCode.ANALYSIS_ERROR);
		}
	}

	async interactiveWorkshop(
		document: ScrivenerDocument,
		options?: {
			duration?: number;
			focusAreas?: string[];
			includeCritique?: boolean;
			agents?: string[];
			rounds?: number;
		}
	): Promise<WorkshopSession> {
		const sessionId = `workshop_${Date.now()}`;
		const {
			duration = 3,
			focusAreas = ['structure', 'character', 'style'],
			includeCritique = true,
			agents = ['editor', 'critic', 'researcher'],
			rounds = 2,
		} = options || {};

		// Filter agents based on configuration
		const selectedAgents = agents.filter((agentId) => this.agents.has(agentId));
		const workshopAgents = selectedAgents
			.map((agentId) => this.agents.get(agentId)!)
			.filter(Boolean);

		const session: WorkshopSession = {
			id: sessionId,
			document,
			focus: focusAreas,
			agents: workshopAgents,
			phases: [],
			results: {} as CollaborativeResult,
			insights: [],
			followUpActions: [],
		};

		try {
			this.logger.info(`Starting interactive workshop session: ${sessionId}`, {
				duration: `${duration} hours`,
				agents: selectedAgents,
				rounds,
				focusAreas,
			});
			this.activeWorkshops.set(sessionId, session);

			// Run multiple rounds of analysis and discussion
			for (let round = 1; round <= rounds; round++) {
				this.logger.debug(`Workshop round ${round} of ${rounds}`);

				// Phase 1: Individual Analysis (per round)
				const analysisPhase = await this.runAnalysisPhase(session, round);
				session.phases.push(analysisPhase);

				// Phase 2: Agent Discussion (per round)
				const discussionPhase = await this.runDiscussionPhase(session, round);
				session.phases.push(discussionPhase);

				// Add duration tracking
				const phaseEndTime = Date.now();
				const elapsedHours =
					(phaseEndTime - parseInt(sessionId.split('_')[1])) / (1000 * 60 * 60);

				if (elapsedHours >= duration) {
					this.logger.info(`Workshop duration limit (${duration}h) reached, wrapping up`);
					break;
				}
			}

			// Phase 3: Collaborative Synthesis (if requested)
			if (includeCritique) {
				const synthesisPhase = await this.runSynthesisPhase(session);
				session.phases.push(synthesisPhase);
			}

			// Generate final results
			session.results = await this.consolidateWorkshopResults(session);
			session.insights = await this.extractWorkshopInsights(session);
			session.followUpActions = await this.generateFollowUpActions(session);

			this.emit('workshopCompleted', { sessionId, results: session.results });
			return session;
		} catch (error) {
			this.logger.error('Interactive workshop failed', {
				sessionId,
				error: (error as Error).message,
			});
			throw new AppError('Workshop session failed', ErrorCode.ANALYSIS_ERROR);
		} finally {
			this.activeWorkshops.delete(sessionId);
		}
	}

	private async runAnalysisPhase(
		session: WorkshopSession,
		_round?: number
	): Promise<{
		name: string;
		duration: number;
		activities: string[];
		outputs: WorkshopPhaseOutput[];
	}> {
		const startTime = Date.now();

		const analyses = await Promise.all(
			session.agents.map((agent) => agent.analyze(session.document))
		);

		// Convert AgentAnalysis to WorkshopPhaseOutput
		const workshopOutputs: WorkshopPhaseOutput[] = analyses.map((analysis) => ({
			agentId: analysis.agentId,
			type: 'analysis' as const,
			content: analysis.perspective,
			confidence: analysis.overallScore / 100,
			timestamp: new Date().toISOString(),
		}));

		return {
			name: 'Individual Analysis',
			duration: Date.now() - startTime,
			activities: ['Agent analysis', 'Perspective gathering', 'Initial assessment'],
			outputs: workshopOutputs,
		};
	}

	private async runDiscussionPhase(
		session: WorkshopSession,
		_round?: number
	): Promise<{
		name: string;
		duration: number;
		activities: string[];
		outputs: WorkshopPhaseOutput[];
	}> {
		const startTime = Date.now();
		const discussions: AgentDiscussion[] = [];

		// Pairwise discussions between agents
		for (let i = 0; i < session.agents.length - 1; i++) {
			for (let j = i + 1; j < session.agents.length; j++) {
				const agent1 = session.agents[i];
				const agent2 = session.agents[j];

				const discussion = await agent1.discussWith(
					agent2,
					`Analysis of "${session.document.title}"`,
					2
				);

				discussions.push(discussion);
			}
		}

		// Convert AgentDiscussion to WorkshopPhaseOutput
		const workshopOutputs: WorkshopPhaseOutput[] = discussions.flatMap((discussion) =>
			discussion.rounds.flatMap((round) =>
				round.contributions.map((contribution) => ({
					agentId: contribution.agentId,
					type: 'insight' as const,
					content: contribution.message,
					confidence: 0.8,
					timestamp: new Date().toISOString(),
				}))
			)
		);

		return {
			name: 'Agent Discussions',
			duration: Date.now() - startTime,
			activities: ['Pairwise discussions', 'Consensus building', 'Insight extraction'],
			outputs: workshopOutputs,
		};
	}

	private async runSynthesisPhase(session: WorkshopSession): Promise<{
		name: string;
		duration: number;
		activities: string[];
		outputs: WorkshopPhaseOutput[];
	}> {
		const startTime = Date.now();

		// Extract individual analyses from phase outputs
		const analysisPhase = session.phases.find((p) => p.name === 'Individual Analysis');
		const individualAnalyses: AgentAnalysis[] = analysisPhase
			? (analysisPhase.outputs as unknown as AgentAnalysis[])
			: [];

		// Generate collaborative critique
		const collaborativeCritique = await this.generateCollaborativeCritique(
			session.document,
			individualAnalyses
		);

		const workshopOutputs: WorkshopPhaseOutput[] = [
			{
				agentId: 'system',
				type: 'suggestion' as const,
				content: collaborativeCritique,
				confidence: 0.9,
				timestamp: new Date().toISOString(),
			},
		];

		return {
			name: 'Collaborative Synthesis',
			duration: Date.now() - startTime,
			activities: ['Synthesis generation', 'Critique collaboration', 'Final recommendations'],
			outputs: workshopOutputs,
		};
	}

	private async generateCollaborativeCritique(
		document: ScrivenerDocument,
		analyses: AgentAnalysis[]
	): Promise<string> {
		const expertAnalyses = analyses.map((a) => ({
			expert: a.agentId,
			analysis: a.perspective,
			confidence: a.overallScore / 100,
			recommendations: a.findings.flatMap((f) => f.suggestions),
		}));

		const combinedPerspectives = analyses
			.map(
				(a) =>
					`${a.agentId}: ${a.perspective}\nFindings: ${a.findings.map((f) => f.assessment).join('; ')}`
			)
			.join('\n\n');

		const prompt = `Based on these expert analyses, provide a collaborative critique:

Document: "${document.title}"
${(document.content || '').slice(0, 1000)}...

Expert Perspectives:
${combinedPerspectives}

Synthesize into:
1. Areas of agreement among experts
2. Key disagreements and their merit
3. Prioritized recommendations
4. Overall assessment
5. Next steps for improvement

Provide a balanced, comprehensive critique that honors each expert's perspective.`;

		try {
			const langchainService = new EnhancedLangChainService();
			const result = await langchainService.generateWithTemplate(
				'collaborative_critique',
				document.content || '',
				{ expertAnalyses, customPrompt: prompt }
			);

			return result.content as string;
		} catch (error) {
			this.logger.warn('Collaborative critique generation failed', {
				error: (error as Error).message,
			});
			return 'Collaborative critique could not be generated at this time.';
		}
	}

	private async buildConsensus(
		analyses: AgentAnalysis[]
	): Promise<CollaborativeResult['consensus']> {
		const agreements: Array<{ aspect: string; confidence: number; agents: string[] }> = [];
		const disagreements: Array<{
			aspect: string;
			positions: Array<{ agent: string; position: string; confidence: number }>;
		}> = [];

		// Find common themes in findings
		const allFindings = analyses.flatMap((a) => a.findings);
		const aspectGroups = this.groupFindingsByAspect(allFindings);

		for (const [aspect, findings] of aspectGroups) {
			const assessments = findings.map((f) => f.assessment);
			const uniqueAssessments = [...new Set(assessments)];

			if (uniqueAssessments.length === 1) {
				// Agreement
				agreements.push({
					aspect,
					confidence:
						findings.reduce((sum, f) => sum + f.confidence, 0) / findings.length,
					agents: [
						...new Set(
							findings.map(
								(f) =>
									analyses.find((a) => a.findings.includes(f))?.agentId ||
									'unknown'
							)
						),
					],
				});
			} else {
				// Disagreement
				const positions = uniqueAssessments.map((assessment) => {
					const relatedFindings = findings.filter((f) => f.assessment === assessment);
					const agent =
						analyses.find((a) => a.findings.some((f) => relatedFindings.includes(f)))
							?.agentId || 'unknown';
					const confidence =
						relatedFindings.reduce((sum, f) => sum + f.confidence, 0) /
						relatedFindings.length;

					return { agent, position: assessment, confidence };
				});

				disagreements.push({ aspect, positions });
			}
		}

		return {
			agreements,
			disagreements,
			unresolved: disagreements.filter((d) => d.positions.length > 2).map((d) => d.aspect),
		};
	}

	private groupFindingsByAspect(
		findings: AgentAnalysis['findings']
	): Map<string, AgentAnalysis['findings']> {
		const groups = new Map<string, AgentAnalysis['findings']>();

		for (const finding of findings) {
			const existing = groups.get(finding.aspect) || [];
			existing.push(finding);
			groups.set(finding.aspect, existing);
		}

		return groups;
	}

	private async synthesizeAnalyses(
		analyses: AgentAnalysis[],
		focusAreas: string[]
	): Promise<CollaborativeResult['synthesis']> {
		const combinedScore =
			analyses.reduce((sum, a) => sum + a.overallScore, 0) / analyses.length;

		// Filter findings based on focus areas if specified
		const keyFindings = analyses.flatMap((a) => {
			const findings = a.findings.filter((f) => f.confidence > 0.7);
			if (focusAreas.length > 0) {
				// Filter findings that relate to focus areas
				return findings
					.filter((f) =>
						focusAreas.some(
							(area) =>
								f.aspect.toLowerCase().includes(area.toLowerCase()) ||
								f.assessment.toLowerCase().includes(area.toLowerCase())
						)
					)
					.map((f) => f.assessment);
			}
			return findings.map((f) => f.assessment);
		});

		const uniqueFindings = [...new Set(keyFindings)];

		const actionPriorities = await this.extractActionPriorities(analyses);
		const tradeoffs = await this.identifyTradeoffs(analyses);

		return {
			combinedScore: Math.round(combinedScore),
			keyFindings: uniqueFindings.slice(0, 8),
			actionPriorities,
			tradeoffs,
		};
	}

	private async extractActionPriorities(analyses: AgentAnalysis[]): Promise<
		Array<{
			action: string;
			urgency: number;
			complexity: string;
		}>
	> {
		// Extract suggestions from all analyses
		const allSuggestions = analyses.flatMap((a) => a.findings.flatMap((f) => f.suggestions));

		// Count frequency and assess urgency
		const suggestionCounts = new Map<string, number>();
		allSuggestions.forEach((suggestion) => {
			suggestionCounts.set(suggestion, (suggestionCounts.get(suggestion) || 0) + 1);
		});

		// Convert to priority format
		return Array.from(suggestionCounts.entries())
			.sort(([, a], [, b]) => b - a) // Sort by frequency
			.slice(0, 5)
			.map(([action, frequency]) => ({
				action,
				urgency: Math.min(100, frequency * 20), // Convert to 0-100 scale
				complexity: this.assessComplexity(action),
			}));
	}

	private assessComplexity(action: string): string {
		const complexityKeywords = {
			low: ['fix', 'correct', 'adjust', 'polish'],
			medium: ['revise', 'improve', 'enhance', 'develop'],
			high: ['restructure', 'rewrite', 'reimagine', 'transform'],
		};

		const actionLower = action.toLowerCase();

		for (const [level, keywords] of Object.entries(complexityKeywords)) {
			if (keywords.some((keyword) => actionLower.includes(keyword))) {
				return level;
			}
		}

		return 'medium';
	}

	private async identifyTradeoffs(_analyses: AgentAnalysis[]): Promise<
		Array<{
			decision: string;
			benefits: string[];
			costs: string[];
		}>
	> {
		// This would analyze conflicting recommendations and identify tradeoffs
		// For now, return a placeholder
		return [];
	}

	private async generateCollaborativeRecommendations(
		analyses: AgentAnalysis[],
		_consensus: CollaborativeResult['consensus'],
		synthesis: CollaborativeResult['synthesis']
	): Promise<CollaborativeResult['recommendations']> {
		const recommendations: CollaborativeResult['recommendations'] = [];

		// Generate recommendations from high-priority actions
		for (const priority of synthesis.actionPriorities.slice(0, 5)) {
			const supportingAgents = analyses
				.filter((a) => a.findings.some((f) => f.suggestions.includes(priority.action)))
				.map((a) => a.agentId);

			const dissentingAgents = analyses
				.filter((a) => !supportingAgents.includes(a.agentId))
				.map((a) => ({
					agent: a.agentId,
					concerns: a.findings.filter((f) => f.confidence > 0.6).map((f) => f.assessment),
				}));

			recommendations.push({
				recommendation: priority.action,
				supportingAgents,
				dissenting: dissentingAgents,
				confidence: supportingAgents.length / analyses.length,
				implementation: {
					effort: priority.complexity as 'low' | 'medium' | 'high' | 'very-high',
					timeframe: this.estimateTimeframe(priority.complexity),
					dependencies: [],
				},
			});
		}

		return recommendations;
	}

	private estimateTimeframe(complexity: string): string {
		switch (complexity) {
			case 'low':
				return '1-2 days';
			case 'medium':
				return '1-2 weeks';
			case 'high':
				return '1-2 months';
			default:
				return '1-2 weeks';
		}
	}

	private async consolidateWorkshopResults(
		session: WorkshopSession
	): Promise<CollaborativeResult> {
		// Extract the actual analyses that were stored separately
		const analysisPhase = session.phases.find((p) => p.name === 'Individual Analysis');
		if (!analysisPhase) {
			throw new Error('No analysis phase found for consolidation');
		}

		return this.collaborativeEdit(session.document, {
			agents: session.agents.map((a) => a.persona.name.toLowerCase()),
		});
	}

	private async extractWorkshopInsights(session: WorkshopSession): Promise<string[]> {
		// Extract insights from workshop phase outputs
		const allInsights: string[] = [];
		for (const phase of session.phases) {
			for (const output of phase.outputs) {
				if (output.type === 'insight') {
					allInsights.push(output.content);
				}
			}
		}

		return [...new Set(allInsights)].slice(0, 10);
	}

	private async generateFollowUpActions(_session: WorkshopSession): Promise<string[]> {
		return [
			'Review collaborative recommendations',
			'Prioritize implementation tasks',
			'Schedule follow-up analysis',
			'Document key insights',
			'Plan next workshop session',
		];
	}

	getAgent(agentId: string): SpecializedAgent | undefined {
		return this.agents.get(agentId);
	}

	getAvailableAgents(): string[] {
		return Array.from(this.agents.keys());
	}

	getActiveWorkshops(): string[] {
		return Array.from(this.activeWorkshops.keys());
	}

	getWorkshopSession(sessionId: string): WorkshopSession | undefined {
		return this.activeWorkshops.get(sessionId);
	}

	// TODO: Implement perspective filtering when agent perspectives are added
	// private filterPerspectiveByFocus(perspective: string, focusAreas: string[]): string {
	// 	if (focusAreas.length === 0) return perspective;
	//
	// 	// Simple filtering: highlight sections that match focus areas
	// 	const focusKeywords = focusAreas.map((area) => area.toLowerCase());
	// 	const sentences = perspective.split(/[.!?]+/);
	//
	// 	const relevantSentences = sentences.filter((sentence) =>
	// 		focusKeywords.some((keyword) => sentence.toLowerCase().includes(keyword))
	// 	);
	//
	// 	return relevantSentences.length > 0 ? `${relevantSentences.join('. ')}.` : perspective; // Return original if no focus matches found
	// }
}
