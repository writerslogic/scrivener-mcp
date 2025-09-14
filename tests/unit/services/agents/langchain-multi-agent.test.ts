import { describe, it, expect, beforeEach, afterEach, vi } from '@jest/globals';
import {
  type AgentPersona,
  type AgentAnalysis,
  type CollaborativeResult,
  LangChainMultiAgentOrchestrator,
} from '../../../../src/services/agents/langchain-multi-agent.js';
import type { ScrivenerDocument, StyleGuide } from '../../../../src/types/index.js';
import { ApplicationError as AppError, ErrorCode } from '../../../../src/core/errors.js';

// Mock dependencies
jest.mock('../../../../src/services/ai/langchain-service-enhanced.js', () => ({
  EnhancedLangChainService: jest.fn(() => ({
    generateWithTemplate: jest.fn().mockResolvedValue({
      content: JSON.stringify({
        perspective: 'Test analysis perspective',
        findings: [
          {
            aspect: 'Character Development',
            assessment: 'Well-developed protagonists',
            confidence: 0.85,
            evidence: ['Character arc is clear', 'Motivations are established'],
            suggestions: ['Develop secondary characters more'],
          },
        ],
        overallScore: 78,
        priority: 'medium',
        reasoning: 'Good foundation with room for improvement',
      }),
    }),
    initialize: jest.fn(),
  })),
}));

jest.mock('../../../../src/services/ai/langchain-advanced-features.js', () => ({
  AdvancedLangChainFeatures: jest.fn(() => ({
    initialize: jest.fn(),
  })),
}));

jest.mock('../../../../src/core/logger.js', () => ({
  getLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  })),
}));

describe('LangChain Multi-Agent StyleGuide Integration', () => {
  let orchestrator: LangChainMultiAgentOrchestrator;
  let mockDocument: ScrivenerDocument;
  let mockStyleGuide: StyleGuide;
  let editorPersona: AgentPersona;
  let criticPersona: AgentPersona;

  beforeEach(() => {
    mockDocument = {
      id: 'test-doc-1',
      title: 'Test Chapter',
      content: 'This is a test chapter with some content for analysis.',
      type: 'Text',
      path: 'Manuscript/Chapter 1',
    };

    mockStyleGuide = {
      genre: 'Science Fiction',
      audience: 'Young Adult',
      tone: 'Adventurous',
      voice: 'First Person',
      styleNotes: 'Fast-paced action with technical elements',
    };

    editorPersona = {
      name: 'Editor',
      expertise: ['developmental editing', 'narrative structure'],
      personality: 'analytical',
      focusAreas: ['plot', 'character development', 'pacing'],
      communicationStyle: 'constructive',
      biases: ['prefers traditional structure'],
      strengths: ['story analysis', 'character motivation'],
      limitations: ['modern genres', 'experimental styles'],
    };

    criticPersona = {
      name: 'Critic',
      expertise: ['literary criticism', 'genre analysis'],
      personality: 'meticulous',
      focusAreas: ['literary quality', 'genre conventions', 'originality'],
      communicationStyle: 'detailed',
      biases: ['literary fiction preference'],
      strengths: ['technical analysis', 'comparative literature'],
      limitations: ['commercial appeal', 'popular genres'],
    };

    orchestrator = new LangChainMultiAgentOrchestrator();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('StyleGuide Integration in Agent Analysis', () => {
    it('should incorporate StyleGuide into agent analysis', async () => {
      const mockAgent = orchestrator.createSpecializedAgent(editorPersona);
      const analysis = await mockAgent.analyze(mockDocument, mockStyleGuide);

      expect(analysis).toBeDefined();
      expect(analysis.agentId).toBe('Editor');
      expect(analysis.perspective).toContain('Test analysis perspective');
      expect(analysis.findings).toHaveLength(1);
      expect(analysis.overallScore).toBe(78);
      expect(analysis.priority).toBe('medium');

      // Verify that style guide context was included in the analysis
      const mockLangChain = mockAgent['langchain'];
      expect(mockLangChain.generateWithTemplate).toHaveBeenCalledWith(
        'agent_analysis',
        mockDocument.content,
        expect.objectContaining({
          agentPersona: editorPersona,
          focusAreas: editorPersona.focusAreas,
          format: 'json',
          customPrompt: expect.stringContaining('Style Guide Context'),
        })
      );
    });

    it('should include specific style guide elements in analysis prompt', async () => {
      const mockAgent = orchestrator.createSpecializedAgent(editorPersona);
      await mockAgent.analyze(mockDocument, mockStyleGuide);

      const mockLangChain = mockAgent['langchain'];
      const call = mockLangChain.generateWithTemplate.mock.calls[0];
      const prompt = call[2].customPrompt;

      expect(prompt).toContain('Genre: Science Fiction');
      expect(prompt).toContain('Target Audience: Young Adult');
      expect(prompt).toContain('Tone: Adventurous');
      expect(prompt).toContain('Voice: First Person');
      expect(prompt).toContain('Style Notes: Fast-paced action with technical elements');
      expect(prompt).toContain('Please consider these style requirements in your analysis');
    });

    it('should work without StyleGuide when not provided', async () => {
      const mockAgent = orchestrator.createSpecializedAgent(editorPersona);
      const analysis = await mockAgent.analyze(mockDocument);

      expect(analysis).toBeDefined();
      expect(analysis.agentId).toBe('Editor');

      const mockLangChain = mockAgent['langchain'];
      const call = mockLangChain.generateWithTemplate.mock.calls[0];
      const prompt = call[2].customPrompt;

      expect(prompt).not.toContain('Style Guide Context');
      expect(prompt).not.toContain('Genre:');
      expect(prompt).not.toContain('Target Audience:');
    });

    it('should handle partial StyleGuide information', async () => {
      const partialStyleGuide: StyleGuide = {
        genre: 'Fantasy',
        tone: 'Epic',
        // Missing audience, voice, styleNotes
      };

      const mockAgent = orchestrator.createSpecializedAgent(editorPersona);
      await mockAgent.analyze(mockDocument, partialStyleGuide);

      const mockLangChain = mockAgent['langchain'];
      const call = mockLangChain.generateWithTemplate.mock.calls[0];
      const prompt = call[2].customPrompt;

      expect(prompt).toContain('Genre: Fantasy');
      expect(prompt).toContain('Tone: Epic');
      expect(prompt).toContain('Target Audience: Not specified');
      expect(prompt).toContain('Voice: Not specified');
      expect(prompt).toContain('Style Notes: None provided');
    });
  });

  describe('StyleGuide Integration in Agent Perspectives', () => {
    it('should incorporate StyleGuide into perspective generation', async () => {
      const mockAgent = orchestrator.createSpecializedAgent(criticPersona);
      
      // Mock the perspective method response
      const mockLangChain = mockAgent['langchain'];
      mockLangChain.generateWithTemplate.mockResolvedValueOnce({
        content: 'Perspective considering style guide requirements',
      });

      const perspective = await mockAgent.providePerspective(mockDocument, mockStyleGuide);

      expect(perspective).toBe('Perspective considering style guide requirements');
      expect(mockLangChain.generateWithTemplate).toHaveBeenCalledWith(
        'agent_perspective',
        mockDocument.content,
        expect.objectContaining({
          styleGuide: mockStyleGuide,
        })
      );
    });
  });

  describe('StyleGuide Integration in Agent Critique', () => {
    it('should incorporate StyleGuide into critique generation', async () => {
      const mockAgent = orchestrator.createSpecializedAgent(editorPersona);
      const otherAnalysis: AgentAnalysis = {
        agentId: 'Critic',
        perspective: 'Critical analysis perspective',
        findings: [],
        overallScore: 65,
        priority: 'high',
        reasoning: 'Needs improvement',
      };

      // Mock the critique method response
      const mockLangChain = mockAgent['langchain'];
      mockLangChain.generateWithTemplate.mockResolvedValueOnce({
        content: 'Critique considering style guide and other analysis',
      });

      const critique = await mockAgent.critique(mockDocument, otherAnalysis, mockStyleGuide);

      expect(critique).toBe('Critique considering style guide and other analysis');
      expect(mockLangChain.generateWithTemplate).toHaveBeenCalledWith(
        'agent_critique',
        mockDocument.content,
        expect.objectContaining({
          otherAnalysis,
          styleGuide: mockStyleGuide,
        })
      );
    });
  });

  describe('Multi-Agent Collaboration with StyleGuide', () => {
    it('should use StyleGuide in collaborative analysis', async () => {
      const agents = [
        orchestrator.createSpecializedAgent(editorPersona),
        orchestrator.createSpecializedAgent(criticPersona),
      ];

      const result = await orchestrator.collaborativeAnalysis(
        mockDocument,
        agents,
        mockStyleGuide
      );

      expect(result).toBeDefined();
      expect(result.individualPerspectives).toHaveLength(2);
      expect(result.consensus).toBeDefined();
      expect(result.synthesis).toBeDefined();
      expect(result.recommendations).toBeDefined();

      // Verify each agent received the style guide
      agents.forEach(agent => {
        const mockLangChain = agent['langchain'];
        expect(mockLangChain.generateWithTemplate).toHaveBeenCalledWith(
          'agent_analysis',
          mockDocument.content,
          expect.objectContaining({
            customPrompt: expect.stringContaining('Style Guide Context'),
          })
        );
      });
    });

    it('should handle collaborative analysis without StyleGuide', async () => {
      const agents = [orchestrator.createSpecializedAgent(editorPersona)];

      const result = await orchestrator.collaborativeAnalysis(mockDocument, agents);

      expect(result).toBeDefined();
      expect(result.individualPerspectives).toHaveLength(1);

      const mockLangChain = agents[0]['langchain'];
      const call = mockLangChain.generateWithTemplate.mock.calls[0];
      const prompt = call[2].customPrompt;

      expect(prompt).not.toContain('Style Guide Context');
    });
  });

  describe('Workshop Sessions with StyleGuide', () => {
    it('should integrate StyleGuide into workshop sessions', async () => {
      const agents = [
        orchestrator.createSpecializedAgent(editorPersona),
        orchestrator.createSpecializedAgent(criticPersona),
      ];

      const session = await orchestrator.conductWorkshop(
        mockDocument,
        ['character development', 'genre adherence'],
        agents,
        mockStyleGuide
      );

      expect(session).toBeDefined();
      expect(session.document).toBe(mockDocument);
      expect(session.focus).toContain('character development');
      expect(session.focus).toContain('genre adherence');
      expect(session.agents).toHaveLength(2);
      expect(session.results).toBeDefined();

      // Verify style guide was considered in the workshop
      agents.forEach(agent => {
        const mockLangChain = agent['langchain'];
        const calls = mockLangChain.generateWithTemplate.mock.calls;
        expect(calls.some(call => 
          call[2].customPrompt?.includes('Style Guide Context')
        )).toBe(true);
      });
    });
  });

  describe('StyleGuide Validation and Error Handling', () => {
    it('should handle invalid StyleGuide gracefully', async () => {
      const invalidStyleGuide = {
        // Invalid structure
        invalidField: 'invalid value',
      } as any;

      const mockAgent = orchestrator.createSpecializedAgent(editorPersona);
      
      // Should not throw, but handle gracefully
      const analysis = await mockAgent.analyze(mockDocument, invalidStyleGuide);

      expect(analysis).toBeDefined();
      expect(analysis.agentId).toBe('Editor');
    });

    it('should handle StyleGuide with null/undefined values', async () => {
      const styleGuideWithNulls: StyleGuide = {
        genre: null as any,
        audience: undefined as any,
        tone: '',
        voice: 'Third Person',
        styleNotes: null as any,
      };

      const mockAgent = orchestrator.createSpecializedAgent(editorPersona);
      await mockAgent.analyze(mockDocument, styleGuideWithNulls);

      const mockLangChain = mockAgent['langchain'];
      const call = mockLangChain.generateWithTemplate.mock.calls[0];
      const prompt = call[2].customPrompt;

      expect(prompt).toContain('Genre: Not specified');
      expect(prompt).toContain('Target Audience: Not specified');
      expect(prompt).toContain('Tone: Not specified');
      expect(prompt).toContain('Voice: Third Person');
      expect(prompt).toContain('Style Notes: None provided');
    });

    it('should handle agent analysis failure with StyleGuide', async () => {
      const mockAgent = orchestrator.createSpecializedAgent(editorPersona);
      const mockLangChain = mockAgent['langchain'];
      
      mockLangChain.generateWithTemplate.mockRejectedValueOnce(
        new Error('Analysis generation failed')
      );

      const analysis = await mockAgent.analyze(mockDocument, mockStyleGuide);

      expect(analysis.agentId).toBe('Editor');
      expect(analysis.perspective).toBe('Analysis unavailable due to technical error');
      expect(analysis.findings).toEqual([]);
      expect(analysis.overallScore).toBe(50);
      expect(analysis.priority).toBe('low');
    });
  });

  describe('StyleGuide Context Generation', () => {
    it('should generate complete style guide context string', async () => {
      const mockAgent = orchestrator.createSpecializedAgent(editorPersona);
      await mockAgent.analyze(mockDocument, mockStyleGuide);

      const mockLangChain = mockAgent['langchain'];
      const call = mockLangChain.generateWithTemplate.mock.calls[0];
      const prompt = call[2].customPrompt;

      const expectedContext = `
Style Guide Context:
- Genre: Science Fiction
- Target Audience: Young Adult
- Tone: Adventurous
- Voice: First Person
- Style Notes: Fast-paced action with technical elements

Please consider these style requirements in your analysis.
`;

      expect(prompt).toContain(expectedContext.trim());
    });

    it('should generate empty context when no StyleGuide provided', async () => {
      const mockAgent = orchestrator.createSpecializedAgent(editorPersona);
      await mockAgent.analyze(mockDocument);

      const mockLangChain = mockAgent['langchain'];
      const call = mockLangChain.generateWithTemplate.mock.calls[0];
      const prompt = call[2].customPrompt;

      expect(prompt).not.toContain('Style Guide Context:');
      expect(prompt).not.toContain('Please consider these style requirements');
    });
  });

  describe('Agent Specialization with StyleGuide', () => {
    it('should allow different agents to interpret StyleGuide differently', async () => {
      const styleExpertPersona: AgentPersona = {
        name: 'StyleExpert',
        expertise: ['style analysis', 'genre conventions'],
        personality: 'perfectionist',
        focusAreas: ['voice consistency', 'genre adherence', 'audience appropriateness'],
        communicationStyle: 'precise',
        biases: ['style over substance'],
        strengths: ['style analysis', 'consistency checking'],
        limitations: ['plot development', 'character psychology'],
      };

      const styleAgent = orchestrator.createSpecializedAgent(styleExpertPersona);
      const editorAgent = orchestrator.createSpecializedAgent(editorPersona);

      const [styleAnalysis, editorAnalysis] = await Promise.all([
        styleAgent.analyze(mockDocument, mockStyleGuide),
        editorAgent.analyze(mockDocument, mockStyleGuide),
      ]);

      expect(styleAnalysis.agentId).toBe('StyleExpert');
      expect(editorAnalysis.agentId).toBe('Editor');

      // Both should receive the same style guide but interpret it through their persona
      const styleLangChain = styleAgent['langchain'];
      const editorLangChain = editorAgent['langchain'];

      const stylePrompt = styleLangChain.generateWithTemplate.mock.calls[0][2].customPrompt;
      const editorPrompt = editorLangChain.generateWithTemplate.mock.calls[0][2].customPrompt;

      // Both should contain style guide context
      expect(stylePrompt).toContain('Style Guide Context:');
      expect(editorPrompt).toContain('Style Guide Context:');

      // But with different agent personas
      expect(stylePrompt).toContain('style analysis and genre conventions specialist');
      expect(editorPrompt).toContain('developmental editing and narrative structure specialist');
    });
  });
});