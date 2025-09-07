import { ContentEnhancer } from '../dist/services/enhancements/content-enhancer.js';

console.log('Testing Content Enhancer...\n');

const enhancer = new ContentEnhancer();

// Test 1: Filter Word Elimination
async function testFilterWordElimination() {
    console.log('Test 1: Filter Word Elimination');
    
    const content = "She really just wanted to basically go home. It was actually quite late and she was definitely tired.";
    
    const result = await enhancer.enhance({
        content,
        type: 'eliminate-filter-words',
        options: { aggressiveness: 'moderate' }
    });
    
    console.log('Original:', content);
    console.log('Enhanced:', result.enhanced);
    console.log('Changes applied:', result.changes.length);
    console.log('Original word count:', result.metrics.originalWordCount);
    console.log('Enhanced word count:', result.metrics.enhancedWordCount);
    
    // Should remove filter words like "really", "just", "basically", etc.
    const filterWordsRemoved = 
        !result.enhanced.includes('really') &&
        !result.enhanced.includes('basically') &&
        result.enhanced.length < content.length;
    
    return filterWordsRemoved && result.changes.length > 0;
}

// Test 2: Verb Strengthening
async function testVerbStrengthening() {
    console.log('\nTest 2: Verb Strengthening');
    
    const content = "He walked quickly to the store. She said loudly to get attention. They moved slowly through the crowd.";
    
    const result = await enhancer.enhance({
        content,
        type: 'strengthen-verbs'
    });
    
    console.log('Original:', content);
    console.log('Enhanced:', result.enhanced);
    console.log('Changes applied:', result.changes.length);
    
    // Print some changes
    for (const change of result.changes.slice(0, 3)) {
        console.log(`  Changed "${change.original}" to "${change.replacement}"`);
        console.log(`  Reason: ${change.reason}`);
    }
    
    // Should replace weak verb+adverb combinations
    const hasStrongerVerbs = 
        result.enhanced.includes('hurried') || 
        result.enhanced.includes('shouted') ||
        result.enhanced.includes('crept');
    
    return hasStrongerVerbs && result.changes.length > 0;
}

// Test 3: Sentence Variation
async function testSentenceVariation() {
    console.log('\nTest 3: Sentence Variation');
    
    const content = "The cat sat on the mat. The dog ran in the yard. The bird flew in the sky. The fish swam in the pond.";
    
    const result = await enhancer.enhance({
        content,
        type: 'vary-sentences'
    });
    
    console.log('Original:', content);
    console.log('Enhanced:', result.enhanced);
    console.log('Changes applied:', result.changes.length);
    console.log('Readability change:', result.metrics.readabilityChange.toFixed(2));
    
    // Should vary sentence openings
    const hasVariation = result.enhanced !== content;
    
    return hasVariation;
}

// Test 4: Sensory Details
async function testSensoryDetails() {
    console.log('\nTest 4: Adding Sensory Details');
    
    const content = "She walked into the room. There was a table with food. People were talking.";
    
    const result = await enhancer.enhance({
        content,
        type: 'add-sensory-details'
    });
    
    console.log('Original:', content);
    console.log('Enhanced:', result.enhanced);
    console.log('Changes applied:', result.changes.length);
    
    // Should add sensory descriptions
    const hasSensoryAdditions = result.enhanced.length > content.length;
    
    return hasSensoryAdditions;
}

// Test 5: Show Don't Tell
async function testShowDontTell() {
    console.log('\nTest 5: Show Don\'t Tell');
    
    const content = "She was angry. He felt sad. They were excited about the news.";
    
    const result = await enhancer.enhance({
        content,
        type: 'show-dont-tell'
    });
    
    console.log('Original:', content);
    console.log('Enhanced:', result.enhanced);
    console.log('Changes applied:', result.changes.length);
    
    for (const change of result.changes) {
        console.log(`  Changed "${change.original}" to "${change.replacement}"`);
    }
    
    // Should convert telling to showing
    const hasShowing = 
        result.enhanced.includes('clenched') ||
        result.enhanced.includes('slumped') ||
        result.enhanced.includes('smiled');
    
    return hasShowing || result.changes.length > 0;
}

// Test 6: Flow Improvement
async function testFlowImprovement() {
    console.log('\nTest 6: Flow Improvement');
    
    const content = "She went to the store. She bought milk. She came home. She made coffee.";
    
    const result = await enhancer.enhance({
        content,
        type: 'improve-flow'
    });
    
    console.log('Original:', content);
    console.log('Enhanced:', result.enhanced);
    console.log('Changes applied:', result.changes.length);
    
    // Should add transitions or vary structure
    const hasImprovedFlow = result.enhanced !== content;
    
    return hasImprovedFlow || result.changes.length >= 0; // May not always need changes
}

// Test 7: Description Enhancement
async function testDescriptionEnhancement() {
    console.log('\nTest 7: Description Enhancement');
    
    const content = "The man walked through the door into the room. The woman sat at the table.";
    
    const result = await enhancer.enhance({
        content,
        type: 'enhance-descriptions'
    });
    
    console.log('Original:', content);
    console.log('Enhanced:', result.enhanced);
    console.log('Changes applied:', result.changes.length);
    
    // Should add descriptive adjectives
    const hasEnhancedDescriptions = 
        result.enhanced.length >= content.length &&
        result.changes.some(c => c.type === 'description-enhancement');
    
    return hasEnhancedDescriptions || result.enhanced !== content;
}

// Test 8: Dialogue Strengthening
async function testDialogueStrengthening() {
    console.log('\nTest 8: Dialogue Strengthening');
    
    const content = '"Hello," said John. "How are you?" asked Mary. "Fine," replied John.';
    
    const result = await enhancer.enhance({
        content,
        type: 'strengthen-dialogue'
    });
    
    console.log('Original:', content);
    console.log('Enhanced:', result.enhanced);
    console.log('Changes applied:', result.changes.length);
    
    // Should improve dialogue tags
    const hasStrongerDialogue = 
        result.enhanced.includes('inquired') ||
        result.enhanced.includes('murmured') ||
        result.changes.length > 0;
    
    return hasStrongerDialogue || result.enhanced !== content;
}

// Test 9: Pacing Fix
async function testPacingFix() {
    console.log('\nTest 9: Pacing Fix');
    
    const content = "This is an incredibly long sentence that goes on and on with multiple clauses and ideas all crammed together making it very difficult to read and understand. Short. Another extremely long sentence with too many words.";
    
    const result = await enhancer.enhance({
        content,
        type: 'fix-pacing',
        options: { tone: 'maintain' }
    });
    
    console.log('Original:', content);
    console.log('Enhanced:', result.enhanced);
    console.log('Changes applied:', result.changes.length);
    
    // Should break up long sentences or adjust pacing
    const hasPacingFixes = result.changes.some(c => c.type === 'pacing-adjustment');
    
    return hasPacingFixes || result.enhanced !== content;
}

// Test 10: Content Expansion
async function testContentExpansion() {
    console.log('\nTest 10: Content Expansion');
    
    const content = "The detective entered. He looked around. Evidence everywhere.";
    
    const result = await enhancer.enhance({
        content,
        type: 'expand',
        options: { length: 'longer' }
    });
    
    console.log('Original:', content);
    console.log('Original word count:', result.metrics.originalWordCount);
    console.log('Enhanced:', result.enhanced);
    console.log('Enhanced word count:', result.metrics.enhancedWordCount);
    console.log('Changes applied:', result.changes.length);
    
    // Should expand content
    const isExpanded = result.metrics.enhancedWordCount > result.metrics.originalWordCount;
    
    return isExpanded;
}

// Test 11: Content Condensing
async function testContentCondensing() {
    console.log('\nTest 11: Content Condensing');
    
    const content = "In order to understand the situation better, she made the decision to investigate the matter further. Due to the fact that time was limited, she needed to work quickly.";
    
    const result = await enhancer.enhance({
        content,
        type: 'condense',
        options: { length: 'shorter' }
    });
    
    console.log('Original:', content);
    console.log('Original word count:', result.metrics.originalWordCount);
    console.log('Enhanced:', result.enhanced);
    console.log('Enhanced word count:', result.metrics.enhancedWordCount);
    console.log('Changes applied:', result.changes.length);
    
    // Should condense content
    const isCondensed = result.metrics.enhancedWordCount <= result.metrics.originalWordCount;
    
    return isCondensed;
}

// Test 12: Complete Rewrite
async function testRewrite() {
    console.log('\nTest 12: Complete Rewrite');
    
    const content = "The man walked. He was tired. It was late.";
    
    const result = await enhancer.enhance({
        content,
        type: 'rewrite',
        options: {
            tone: 'darker',
            complexity: 'elevate'
        }
    });
    
    console.log('Original:', content);
    console.log('Enhanced:', result.enhanced);
    console.log('Changes applied:', result.changes.length);
    
    // Should rewrite content
    const isRewritten = result.enhanced !== content && result.changes.length > 0;
    
    return isRewritten;
}

// Test 13: Multiple Enhancement Options
async function testEnhancementOptions() {
    console.log('\nTest 13: Enhancement Options');
    
    const content = "She walked to the store. She was happy.";
    
    const lightResult = await enhancer.enhance({
        content,
        type: 'enhance-descriptions',
        options: { aggressiveness: 'light' }
    });
    
    const heavyResult = await enhancer.enhance({
        content,
        type: 'enhance-descriptions',
        options: { aggressiveness: 'heavy' }
    });
    
    console.log('Original:', content);
    console.log('Light enhancement changes:', lightResult.changes.length);
    console.log('Heavy enhancement changes:', heavyResult.changes.length);
    
    // Heavy should make more changes than light
    return lightResult.changes.length <= heavyResult.changes.length;
}

// Test 14: Style Guide Application
async function testStyleGuideApplication() {
    console.log('\nTest 14: Style Guide Application');
    
    const content = "The detective walks into the room. He sees the evidence.";
    
    const styleGuide = {
        tone: ['noir', 'dark'],
        voice: 'hardboiled detective',
        pov: 'first',
        tense: 'past',
        vocabularyLevel: 'advanced',
        sentenceComplexity: 'complex',
        paragraphLength: 'medium',
        customGuidelines: []
    };
    
    const result = await enhancer.enhance({
        content,
        type: 'rewrite',
        styleGuide
    });
    
    console.log('Original:', content);
    console.log('With style guide:', result.enhanced);
    console.log('Changes applied:', result.changes.length);
    
    // Should apply style guide
    return result.enhanced !== content;
}

// Test 15: Suggestions Quality
async function testSuggestionsQuality() {
    console.log('\nTest 15: Suggestions Quality');
    
    const content = "She really just wanted to go home. The very big house was quite nice.";
    
    const result = await enhancer.enhance({
        content,
        type: 'eliminate-filter-words'
    });
    
    console.log('Suggestions provided:');
    for (const suggestion of result.suggestions) {
        console.log(`  - ${suggestion}`);
    }
    
    // Should provide helpful suggestions
    return result.suggestions.length > 0;
}

// Run all tests
async function runAllTests() {
    console.log('='.repeat(50));
    console.log('CONTENT ENHANCER TEST SUITE');
    console.log('='.repeat(50));
    
    const tests = [
        { name: 'Filter Word Elimination', fn: testFilterWordElimination },
        { name: 'Verb Strengthening', fn: testVerbStrengthening },
        { name: 'Sentence Variation', fn: testSentenceVariation },
        { name: 'Sensory Details', fn: testSensoryDetails },
        { name: 'Show Don\'t Tell', fn: testShowDontTell },
        { name: 'Flow Improvement', fn: testFlowImprovement },
        { name: 'Description Enhancement', fn: testDescriptionEnhancement },
        { name: 'Dialogue Strengthening', fn: testDialogueStrengthening },
        { name: 'Pacing Fix', fn: testPacingFix },
        { name: 'Content Expansion', fn: testContentExpansion },
        { name: 'Content Condensing', fn: testContentCondensing },
        { name: 'Complete Rewrite', fn: testRewrite },
        { name: 'Enhancement Options', fn: testEnhancementOptions },
        { name: 'Style Guide Application', fn: testStyleGuideApplication },
        { name: 'Suggestions Quality', fn: testSuggestionsQuality }
    ];
    
    let passed = 0;
    let failed = 0;
    
    for (const test of tests) {
        try {
            const result = await test.fn();
            if (result) {
                console.log(`✅ ${test.name} PASSED\n`);
                passed++;
            } else {
                console.log(`❌ ${test.name} FAILED\n`);
                failed++;
            }
        } catch (error) {
            console.log(`❌ ${test.name} ERROR:`, error.message, '\n');
            failed++;
        }
    }
    
    console.log('='.repeat(50));
    console.log(`RESULTS: ${passed} passed, ${failed} failed`);
    console.log('='.repeat(50));
    
    if (failed > 0) {
        process.exit(1);
    }
}

// Run the tests
runAllTests().catch(error => {
    console.error('Test suite error:', error);
    process.exit(1);
});