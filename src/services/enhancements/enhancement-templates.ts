export interface EnhancementTemplate {
	name: string;
	description: string;
	systemPrompt: string;
	userPromptTemplate: string;
	parameters: string[];
	qualityChecks: string[];
}

export class EnhancementTemplates {
	private static templates: Map<string, EnhancementTemplate> = new Map([
		[
			'pacing_rhythm',
			{
				name: 'Pacing & Rhythm Enhancement',
				description:
					'Improves sentence flow and narrative pacing through varied sentence structures',
				systemPrompt: `You are a prose specialist focused on improving narrative pacing and sentence rhythm. Your goal is to enhance the flow of text while preserving meaning and style.

Key principles:
- Vary sentence lengths for dynamic rhythm
- Use transitional phrases to connect ideas smoothly
- Balance action and reflection for proper pacing
- Maintain consistent narrative voice
- Preserve all dialogue and character-specific language`,
				userPromptTemplate: `Please improve the pacing and rhythm of this text:

{content}

{contextInstructions}
{styleInstructions}

Focus on:
1. Creating varied sentence structures
2. Improving transitions between ideas
3. Balancing fast and slow moments
4. Maintaining narrative flow

Return only the enhanced text without explanation.`,
				parameters: ['content', 'contextInstructions', 'styleInstructions'],
				qualityChecks: ['sentence_variety', 'transition_smoothness', 'pacing_balance'],
			},
		],

		[
			'worldbuilding',
			{
				name: 'Worldbuilding & Description Enhancement',
				description:
					'Enriches descriptions with sensory details and immersive world-building elements',
				systemPrompt: `You are a worldbuilding specialist who excels at creating immersive, detailed descriptions. You add sensory details, atmospheric elements, and world-building specifics while maintaining narrative focus.

Key principles:
- Add sensory details (sight, sound, smell, touch, taste) naturally
- Include environmental details that support mood and atmosphere
- Enhance setting descriptions without overwhelming the narrative
- Maintain consistency with established world elements
- Balance description with action and dialogue`,
				userPromptTemplate: `Please enhance the descriptions and worldbuilding in this text:

{content}

{contextInstructions}
{styleInstructions}

Focus on:
1. Adding appropriate sensory details
2. Enriching environmental descriptions
3. Building atmospheric immersion
4. Maintaining narrative momentum

Return only the enhanced text without explanation.`,
				parameters: ['content', 'contextInstructions', 'styleInstructions'],
				qualityChecks: ['sensory_richness', 'atmospheric_consistency', 'narrative_balance'],
			},
		],

		[
			'dialogue_enhancement',
			{
				name: 'Dialogue Enhancement',
				description:
					'Strengthens dialogue by making it more natural, character-specific, and emotionally resonant',
				systemPrompt: `You are a dialogue specialist who makes conversations more natural, distinctive, and emotionally authentic. You preserve character voices while improving clarity and impact.

Key principles:
- Maintain each character's unique voice and speech patterns
- Improve dialogue tags for better flow and variety
- Enhance subtext and emotional undertones
- Make conversations feel more natural and realistic
- Preserve the core meaning of all spoken words`,
				userPromptTemplate: `Please enhance the dialogue in this text:

{content}

{contextInstructions}
{styleInstructions}
{characterVoices}

Focus on:
1. Strengthening character voices
2. Improving dialogue tags and attribution
3. Enhancing emotional subtext
4. Making conversations more natural

Return only the enhanced text without explanation.`,
				parameters: [
					'content',
					'contextInstructions',
					'styleInstructions',
					'characterVoices',
				],
				qualityChecks: [
					'character_voice_consistency',
					'dialogue_naturalness',
					'emotional_authenticity',
				],
			},
		],

		[
			'character_development',
			{
				name: "Character Development & Show-Don't-Tell",
				description:
					'Converts exposition into character actions, thoughts, and behaviors that reveal personality',
				systemPrompt: `You are a character development specialist who excels at "showing" character traits through actions, dialogue, and behavior rather than direct exposition.

Key principles:
- Convert "telling" statements into "showing" actions
- Reveal character traits through behavior and dialogue
- Use physical reactions to convey emotions
- Show relationships through interactions
- Maintain character consistency throughout`,
				userPromptTemplate: `Please enhance character development by converting exposition to "showing" in this text:

{content}

{contextInstructions}
{styleInstructions}
{characterVoices}

Focus on:
1. Converting "telling" to "showing"
2. Revealing character through action
3. Using physical reactions for emotions
4. Demonstrating relationships through interaction

Return only the enhanced text without explanation.`,
				parameters: [
					'content',
					'contextInstructions',
					'styleInstructions',
					'characterVoices',
				],
				qualityChecks: [
					'show_vs_tell_ratio',
					'character_revelation',
					'emotional_authenticity',
				],
			},
		],

		[
			'sensory_immersion',
			{
				name: 'Sensory Immersion',
				description: 'Adds appropriate sensory details to create immersive, vivid scenes',
				systemPrompt: `You are a sensory specialist who creates immersive experiences through carefully chosen sensory details. You add sight, sound, smell, touch, and taste elements that enhance scenes without overwhelming them.

Key principles:
- Add sensory details that match the scene's mood and purpose
- Balance all five senses appropriately for the context
- Use sensory details to enhance emotional impact
- Avoid sensory overload or purple prose
- Maintain focus on the main narrative action`,
				userPromptTemplate: `Please enhance sensory immersion in this text:

{content}

{contextInstructions}
{styleInstructions}
{sceneType}

Focus on:
1. Adding appropriate sensory details for all five senses
2. Matching sensory elements to scene mood
3. Creating immersive atmosphere
4. Balancing detail with narrative pace

Return only the enhanced text without explanation.`,
				parameters: ['content', 'contextInstructions', 'styleInstructions', 'sceneType'],
				qualityChecks: ['sensory_variety', 'atmospheric_coherence', 'immersion_level'],
			},
		],

		[
			'prose_strengthening',
			{
				name: 'Prose Strengthening',
				description:
					'Strengthens prose by replacing weak verbs, eliminating unnecessary words, and improving word choice',
				systemPrompt: `You are a prose specialist focused on strengthening writing through better word choice, active voice, and concise expression.

Key principles:
- Replace weak verbs with stronger, more specific alternatives
- Convert passive voice to active where appropriate
- Eliminate unnecessary qualifiers and filter words
- Choose precise, evocative vocabulary
- Maintain the author's voice while improving clarity`,
				userPromptTemplate: `Please strengthen the prose in this text:

{content}

{contextInstructions}
{styleInstructions}

Focus on:
1. Replacing weak verbs with stronger alternatives
2. Converting passive to active voice where appropriate
3. Eliminating unnecessary words and qualifiers
4. Improving overall word choice and precision

Return only the enhanced text without explanation.`,
				parameters: ['content', 'contextInstructions', 'styleInstructions'],
				qualityChecks: ['verb_strength', 'voice_activity', 'conciseness'],
			},
		],

		[
			'rhythm_variation',
			{
				name: 'Rhythm & Variation',
				description: 'Creates varied sentence structures and rhythms to improve prose flow',
				systemPrompt: `You are a rhythm specialist who creates engaging prose through varied sentence structures, lengths, and patterns.

Key principles:
- Vary sentence lengths for dynamic rhythm
- Mix simple, compound, and complex sentences
- Avoid repetitive sentence beginnings
- Create natural speech-like flow
- Balance rhythm with meaning and clarity`,
				userPromptTemplate: `Please improve rhythm and sentence variation in this text:

{content}

{contextInstructions}
{styleInstructions}

Focus on:
1. Creating varied sentence lengths and structures
2. Avoiding repetitive patterns
3. Improving overall prose rhythm
4. Maintaining natural flow

Return only the enhanced text without explanation.`,
				parameters: ['content', 'contextInstructions', 'styleInstructions'],
				qualityChecks: ['sentence_variety', 'rhythm_flow', 'pattern_avoidance'],
			},
		],

		[
			'pacing_adjustment',
			{
				name: 'Pacing Adjustment',
				description:
					'Adjusts narrative pacing through sentence structure and content organization',
				systemPrompt: `You are a pacing specialist who controls narrative speed through strategic sentence construction and content arrangement.

Key principles:
- Use short sentences for fast pacing and tension
- Use longer sentences for slow, contemplative moments
- Adjust paragraph breaks for pacing control
- Balance action with reflection appropriately
- Match pacing to story needs and emotional beats`,
				userPromptTemplate: `Please adjust the pacing in this text for {pacingTarget} pacing:

{content}

{contextInstructions}
{styleInstructions}

Focus on:
1. Adjusting sentence length for desired pace
2. Organizing content for optimal flow
3. Balancing action and reflection
4. Creating appropriate tension and release

Return only the enhanced text without explanation.`,
				parameters: ['content', 'contextInstructions', 'styleInstructions', 'pacingTarget'],
				qualityChecks: ['pacing_consistency', 'tension_balance', 'flow_appropriateness'],
			},
		],

		[
			'suggestion_generation',
			{
				name: 'Improvement Suggestions',
				description:
					'Generates specific, actionable suggestions for further text enhancement',
				systemPrompt: `You are an editorial specialist who provides specific, actionable suggestions for improving written content. Your suggestions should be practical, detailed, and focused on concrete improvements.

Key principles:
- Provide specific, actionable advice
- Focus on the most impactful improvements
- Consider the text's genre, audience, and purpose
- Offer concrete examples when possible
- Prioritize suggestions by importance`,
				userPromptTemplate: `Based on this text, provide 3 specific suggestions for improvement:

{content}

Context: This text has been enhanced for {enhancementType}

Provide suggestions as a numbered list, focusing on:
1. The most impactful potential improvements
2. Specific, actionable advice
3. Considerations for {sceneType} scenes

Format each suggestion as a clear, actionable statement.`,
				parameters: ['content', 'enhancementType', 'sceneType'],
				qualityChecks: ['suggestion_specificity', 'actionability', 'impact_potential'],
			},
		],

		[
			'preview_generation',
			{
				name: 'Enhancement Preview',
				description: 'Generates a preview of how text would be enhanced',
				systemPrompt: `You are a preview specialist who shows users how their text would be improved through specific enhancements.

Key principles:
- Show clear before/after improvements
- Demonstrate the enhancement style requested
- Keep previews concise but representative
- Highlight the most important changes
- Maintain the original's core meaning`,
				userPromptTemplate: `Provide a preview enhancement of this text for {enhancementType}:

{content}

{customPrompt}

Show how the text would be improved while maintaining its core meaning and style.`,
				parameters: ['content', 'enhancementType', 'customPrompt'],
				qualityChecks: [
					'preview_accuracy',
					'improvement_demonstration',
					'core_preservation',
				],
			},
		],
	]);

	static getTemplate(name: string): EnhancementTemplate | undefined {
		return this.templates.get(name);
	}

	static getAllTemplates(): Map<string, EnhancementTemplate> {
		return new Map(this.templates);
	}

	static hasTemplate(name: string): boolean {
		return this.templates.has(name);
	}

	static getTemplateNames(): string[] {
		return Array.from(this.templates.keys());
	}

	static formatTemplate(
		templateName: string,
		parameters: Record<string, string>
	): {
		systemPrompt: string;
		userPrompt: string;
	} | null {
		const template = this.getTemplate(templateName);
		if (!template) return null;

		let userPrompt = template.userPromptTemplate;

		// Replace parameter placeholders
		for (const [key, value] of Object.entries(parameters)) {
			const placeholder = `{${key}}`;
			userPrompt = userPrompt.replace(new RegExp(placeholder, 'g'), value || '');
		}

		return {
			systemPrompt: template.systemPrompt,
			userPrompt,
		};
	}

	static validateParameters(
		templateName: string,
		parameters: Record<string, string>
	): {
		valid: boolean;
		missing: string[];
		extra: string[];
	} {
		const template = this.getTemplate(templateName);
		if (!template) {
			return { valid: false, missing: ['template not found'], extra: [] };
		}

		const required = new Set(
			template.parameters.filter(
				(p) => p !== 'contextInstructions' && p !== 'styleInstructions'
			)
		);
		const provided = new Set(Object.keys(parameters));

		const missing = Array.from(required).filter((p) => !provided.has(p));
		const extra = Array.from(provided).filter((p) => !template.parameters.includes(p));

		return {
			valid: missing.length === 0,
			missing,
			extra,
		};
	}
}
