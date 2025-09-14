import { EventEmitter } from 'events';
import { getLogger } from '../../../core/logger.js';
import type { StyleGuide } from '../../../memory-manager.js';
import type { ScrivenerDocument } from '../../../types/index.js';
import {
	AppError,
	ErrorCode,
	formatDuration,
	handleError,
	safeParse,
	truncate,
	unique,
	validateInput,
} from '../../../utils/common.js';
import { formatStyleGuideContext } from '../../../utils/style-guide-formatter.js';
import { getTextMetrics } from '../../../utils/text-metrics.js';
import { AdvancedLangChainFeatures } from '../../ai/langchain-advanced-features.js';
import { EnhancedLangChainService } from '../../ai/langchain-service-enhanced.js';

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

export interface DiscussionContribution {
	agentId: string;
	message: string;
	confidence: number;
	references: string[];
	timestamp: number;
}

export interface DiscussionRound {
	roundNumber: number;
	contributions: DiscussionContribution[];
	agreements: string[];
	disagreements: string[];
	newInsights: string[];
	timestamp: number;
}

export abstract class SpecializedAgent extends EventEmitter {
	protected langchain: EnhancedLangChainService;
	protected advanced: AdvancedLangChainFeatures;
	protected logger: ReturnType<typeof getLogger>;
	public persona: AgentPersona;
	private operationMetrics = new Map<string, { totalTime: number; callCount: number }>();

	constructor(langchain: EnhancedLangChainService, advanced: AdvancedLangChainFeatures, persona: AgentPersona) {
		super();
		this.langchain = langchain;
		this.advanced = advanced;
		this.logger = getLogger(`agent-${persona.name.toLowerCase()}`);
		this.persona = persona;

		// Set up error handling
		this.on('error', (error) => {
			this.logger.error(`Agent ${persona.name} error:`, error);
		});

		// Track performance metrics
		this.on('operation', (operation, duration) => {
			this.updateOperationMetrics(operation, duration);
		});
	}

	private updateOperationMetrics(
		operation: string, 
		duration: number
	): void {
		const existing = this.operationMetrics.get(operation);
		if (existing) {
			existing.totalTime += duration;
			existing.callCount += 1;
		} else {
			this.operationMetrics.set(operation, {
				totalTime: duration,
				callCount: 1,
			});
		}
	}

	getPerformanceMetrics(): Record<string, { avgTime: number; callCount: number; totalTime: number }> {
		const result: Record<string, { avgTime: number; callCount: number; totalTime: number }> = {};
		
		for (const [operation, metrics] of this.operationMetrics.entries()) {
			result[operation] = {
				avgTime: metrics.totalTime / metrics.callCount,
				callCount: metrics.callCount,
				totalTime: metrics.totalTime,
			};
		}
		
		return result;
	}

	protected async generateAnalysis(
		document: ScrivenerDocument,
		prompt: string,
		styleGuide?: StyleGuide
	): Promise<AgentAnalysis> {
		const startTime = performance.now();
		
		try {
			validateInput({ document, prompt }, {
				document: { type: 'object', required: true },
				prompt: { type: 'string', required: true, minLength: 10, maxLength: 10000 },
			});

			const textMetrics = getTextMetrics(document.content || '');
			const styleContext = styleGuide ? formatStyleGuideContext(styleGuide) : '';
			
			const contextualPrompt = `
${this.persona.perspective}

**Agent Role**: ${this.persona.role}
**Expertise**: ${this.persona.expertise.join(', ')}
**Focus Areas**: ${this.persona.focusAreas.join(', ')}

**Document Analysis**:
- Title: ${document.title}
- Word Count: ${textMetrics.wordCount}
- Reading Time: ${formatDuration(textMetrics.readingTimeMinutes * 60 * 1000)}
- Content Preview: ${truncate(document.content || '', 500)}

${styleContext ? `**Style Guidelines**:\n${styleContext}` : ''}

**Analysis Request**:
${prompt}

Please provide a detailed analysis focusing on your areas of expertise. Structure your response as JSON with the following format:
{
  "perspective": "brief description of your analytical perspective",
  "findings": [
    {
      "aspect": "specific aspect analyzed",
      "assessment": "detailed assessment",
      "confidence": 0.0-1.0,
      "evidence": ["specific examples from the text"],
      "suggestions": ["actionable recommendations"]
    }
  ],
  "overallScore": 0-100,
  "priority": "critical|high|medium|low",
  "reasoning": "explanation of your assessment and score"
}

Focus on ${this.persona.focusAreas.join(', ')} and consider potential ${this.persona.biases.join(', ')} in your analysis.
			`.trim();

			const response = await this.langchain.generateWithFallback(contextualPrompt);
			const analysisData = safeParse(response, {}) as any;

			if (!analysisData || typeof analysisData !== 'object') {
				throw new AppError('Failed to parse agent analysis response', ErrorCode.PROCESSING_ERROR);
			}

			const analysis: AgentAnalysis = {
				agentId: this.persona.name,
				perspective: analysisData.perspective || this.persona.perspective,
				findings: Array.isArray(analysisData.findings) ? analysisData.findings.map((finding: any) => ({
					aspect: String(finding.aspect || 'General'),
					assessment: String(finding.assessment || ''),
					confidence: Math.min(Math.max(Number(finding.confidence || 0.5), 0), 1),
					evidence: Array.isArray(finding.evidence) ? finding.evidence.map(String) : [],
					suggestions: Array.isArray(finding.suggestions) ? finding.suggestions.map(String) : [],
				})) : [],
				overallScore: Math.min(Math.max(Number(analysisData.overallScore || 50), 0), 100),
				priority: ['critical', 'high', 'medium', 'low'].includes(analysisData.priority) 
					? analysisData.priority 
					: 'medium',
				reasoning: String(analysisData.reasoning || 'Analysis completed'),
			};

			const duration = performance.now() - startTime;
			this.emit('operation', 'generateAnalysis', duration);
			
			this.logger.debug('Analysis generated successfully', {
				agentId: analysis.agentId,
				findingsCount: analysis.findings.length,
				overallScore: analysis.overallScore,
				priority: analysis.priority,
				duration: formatDuration(duration),
			});

			return analysis;

		} catch (error) {
			const duration = performance.now() - startTime;
			this.emit('operation', 'generateAnalysis', duration);
			
			throw handleError(error, 'SpecializedAgent.generateAnalysis');
		}
	}

	async discussWith(
		otherAgent: SpecializedAgent,
		topic: string,
		initialContext: string,
		maxRounds: number = 3
	): Promise<DiscussionRound[]> {
		const startTime = performance.now();
		const rounds: DiscussionRound[] = [];
		
		try {
			validateInput({ topic, initialContext, maxRounds }, {
				topic: { type: 'string', required: true, minLength: 5, maxLength: 500 },
				initialContext: { type: 'string', required: true, minLength: 10 },
				maxRounds: { type: 'number', required: true, min: 1, max: 10 },
			});

			this.logger.info(`Starting discussion between ${this.persona.name} and ${otherAgent.persona.name}`, {
				topic: truncate(topic, 100),
				maxRounds,
			});

			let currentContext = initialContext;
			
			for (let roundNum = 1; roundNum <= maxRounds; roundNum++) {
				const roundStartTime = performance.now();
				
				// Generate contributions from both agents
				const [myContribution, theirContribution] = await Promise.all([
					this.generateDiscussionContribution(topic, currentContext, rounds),
					otherAgent.generateDiscussionContribution(topic, currentContext, rounds),
				]);

				// Analyze the contributions
				const agreements = await this.findAgreements(
					myContribution.message, 
					theirContribution.message
				);
				const disagreements = await this.findDisagreements(
					myContribution.message, 
					theirContribution.message
				);
				const newInsights = await this.extractNewInsights(
					myContribution.message, 
					theirContribution.message, 
					currentContext
				);

				const round: DiscussionRound = {
					roundNumber: roundNum,
					contributions: [myContribution, theirContribution],
					agreements,
					disagreements,
					newInsights,
					timestamp: Date.now(),
				};
				
				rounds.push(round);
				
				// Update context for next round
				currentContext = [
					currentContext,
					`Round ${roundNum} contributions:`,
					`${this.persona.name}: ${truncate(myContribution.message, 200)}`,
					`${otherAgent.persona.name}: ${truncate(theirContribution.message, 200)}`,
					agreements.length > 0 ? `Agreements: ${agreements.join(', ')}` : '',
					newInsights.length > 0 ? `New insights: ${newInsights.join(', ')}` : '',
				].filter(Boolean).join('\n\n');
				
				const roundDuration = performance.now() - roundStartTime;
				this.logger.debug(`Discussion round ${roundNum} completed`, {
					agreements: agreements.length,
					disagreements: disagreements.length,
					newInsights: newInsights.length,
					duration: formatDuration(roundDuration),
				});
				
				// Check if we've reached consensus
				if (disagreements.length === 0 && agreements.length > 0) {
					this.logger.info('Early consensus reached, ending discussion', {
						roundNumber: roundNum,
						agreementsCount: agreements.length,
					});
					break;
				}
			}

			const totalDuration = performance.now() - startTime;
			this.emit('operation', 'discussWith', totalDuration);
			
			this.logger.info('Discussion completed', {
				totalRounds: rounds.length,
				totalAgreements: unique(rounds.flatMap(r => r.agreements)).length,
				totalInsights: unique(rounds.flatMap(r => r.newInsights)).length,
				duration: formatDuration(totalDuration),
			});

			return rounds;

		} catch (error) {
			const duration = performance.now() - startTime;
			this.emit('operation', 'discussWith', duration);
			
			throw handleError(error, 'SpecializedAgent.discussWith');
		}
	}

	private async generateDiscussionContribution(
		topic: string,
		context: string,
		previousRounds: DiscussionRound[]
	): Promise<DiscussionContribution> {
		const prompt = `
As ${this.persona.name} (${this.persona.role}), contribute to this discussion:

**Topic**: ${topic}
**Current Context**: ${truncate(context, 1000)}
**Your Expertise**: ${this.persona.expertise.join(', ')}
**Your Perspective**: ${this.persona.perspective}

${previousRounds.length > 0 ? `
**Previous Discussion Rounds**:
${previousRounds.slice(-2).map(round => 
	`Round ${round.roundNumber}: ${round.contributions.map(c => 
		`${c.agentId}: ${truncate(c.message, 150)}`
	).join(' | ')}`
).join('\n')}
` : ''}

Please provide your perspective on this topic. Consider:
- Your areas of expertise: ${this.persona.focusAreas.join(', ')}
- Your communication style: ${this.persona.communicationStyle}
- Potential biases you might have: ${this.persona.biases.join(', ')}

Respond with a thoughtful contribution (100-300 words) that adds value to the discussion.
		`.trim();

		const response = await this.langchain.generateWithFallback(prompt);
		
		return {
			agentId: this.persona.name,
			message: response.trim(),
			confidence: 0.8,
			references: [], // Could be extracted from the response
			timestamp: Date.now(),
		};
	}

	private async findAgreements(message1: string, message2: string): Promise<string[]> {
		const prompt = `
Compare these two messages and identify specific points of agreement:

Message 1: ${truncate(message1, 500)}
Message 2: ${truncate(message2, 500)}

List specific points where both messages agree or align. Be concise and specific.
Return only the agreement points, one per line.
		`.trim();

		const response = await this.langchain.generateWithFallback(prompt);
		return response
			.split('\n')
			.map((line: string) => line.trim())
			.filter((line: string) => line.length > 0)
			.slice(0, 5); // Limit to top 5 agreements
	}

	private async findDisagreements(message1: string, message2: string): Promise<string[]> {
		const prompt = `
Compare these two messages and identify specific points of disagreement or different perspectives:

Message 1: ${truncate(message1, 500)}
Message 2: ${truncate(message2, 500)}

List specific points where the messages disagree or offer different perspectives. Be concise and specific.
Return only the disagreement points, one per line.
		`.trim();

		const response = await this.langchain.generateWithFallback(prompt);
		return response
			.split('\n')
			.map((line: string) => line.trim())
			.filter((line: string) => line.length > 0)
			.slice(0, 5); // Limit to top 5 disagreements
	}

	private async extractNewInsights(
		message1: string,
		message2: string,
		context: string
	): Promise<string[]> {
		const prompt = `
Given this context: ${truncate(context, 300)}

Analyze these two messages for new insights or ideas that weren't present in the original context:

Message 1: ${truncate(message1, 400)}
Message 2: ${truncate(message2, 400)}

Identify novel insights, creative connections, or new perspectives that emerged from this exchange.
Return only the new insights, one per line.
		`.trim();

		const response = await this.langchain.generateWithFallback(prompt);
		return response
			.split('\n')
			.map((line: string) => line.trim())
			.filter((line: string) => line.length > 0 && line.length < 200)
			.slice(0, 3); // Limit to top 3 insights
	}

	// Abstract methods that must be implemented by specialized agents
	abstract analyze(document: ScrivenerDocument, styleGuide?: StyleGuide): Promise<AgentAnalysis>;
	abstract providePerspective(
		document: ScrivenerDocument,
		question: string,
		context?: string,
		styleGuide?: StyleGuide
	): Promise<string>;
	abstract critique(analysis: AgentAnalysis, document: ScrivenerDocument): Promise<string>;
}