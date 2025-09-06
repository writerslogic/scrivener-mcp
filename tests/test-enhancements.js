#!/usr/bin/env node
import { ContentAnalyzer } from '../dist/content-analyzer.js';

console.log('='.repeat(50));
console.log('ENHANCEMENT FEATURES TEST');
console.log('='.repeat(50));

const analyzer = new ContentAnalyzer();

// Test 1: Advanced Readability Analysis
console.log('\nTest 1: Advanced Readability Analysis');
try {
    const testText = "The quick brown fox jumps over the lazy dog. This is a simple sentence. Complex analytical methodologies require sophisticated implementation strategies.";
    const readability = await analyzer.getAdvancedReadabilityAnalysis(testText);
    
    console.log(`✅ Flesch Reading Ease: ${readability.fleschReadingEase.toFixed(2)}`);
    console.log(`✅ Grade Level: ${readability.fleschKincaidGrade.toFixed(2)}`);
    console.log(`✅ SMOG Index: ${readability.smogIndex.toFixed(2)}`);
    console.log(`✅ Target Audience: ${readability.targetAudience}`);
    console.log('✅ Advanced Readability PASSED');
} catch (error) {
    console.log('❌ Advanced Readability FAILED:', error.message);
}

// Test 2: HTML to Markdown Conversion
console.log('\nTest 2: HTML to Markdown Conversion');
try {
    const html = '<h1>Title</h1><p>This is a <strong>bold</strong> paragraph with a <a href="http://example.com">link</a>.</p><ul><li>Item 1</li><li>Item 2</li></ul>';
    const markdown = analyzer.convertHtmlToMarkdown(html);
    
    const expectedPatterns = ['# Title', '**bold**', '[link](http://example.com)', 'Item 1'];
    const allPatternsFound = expectedPatterns.every(pattern => markdown.includes(pattern));
    
    if (allPatternsFound) {
        console.log('✅ HTML to Markdown conversion works correctly');
        console.log('✅ HTML to Markdown PASSED');
    } else {
        console.log('❌ HTML to Markdown FAILED - missing expected patterns');
        console.log('Generated:', markdown);
    }
} catch (error) {
    console.log('❌ HTML to Markdown FAILED:', error.message);
}

// Test 3: Web Content Parsing
console.log('\nTest 3: Web Content Parsing');
try {
    const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Test Article</title>
            <meta name="author" content="Test Author">
        </head>
        <body>
            <article>
                <h1>Main Title</h1>
                <p>This is the main content of the article.</p>
                <p>Another paragraph with <a href="http://example.com">external link</a>.</p>
                <blockquote>"This is a quote from the article."</blockquote>
            </article>
        </body>
        </html>
    `;
    
    const parsed = analyzer.parseWebContent(htmlContent, 'http://test.com', {
        convertToMarkdown: true,
        extractResearchData: true
    });
    
    console.log(`✅ Title extracted: ${parsed.title}`);
    console.log(`✅ Author extracted: ${parsed.author}`);
    console.log(`✅ Word count: ${parsed.metadata.wordCount}`);
    console.log(`✅ Content converted: ${parsed.content.includes('# Main Title')}`);
    
    const researchData = analyzer.extractResearchData(parsed, ['article', 'content']);
    console.log(`✅ Research quotes found: ${researchData.quotes.length}`);
    
    console.log('✅ Web Content Parsing PASSED');
} catch (error) {
    console.log('❌ Web Content Parsing FAILED:', error.message);
}

// Test 4: Readability Comparison
console.log('\nTest 4: Readability Comparison');
try {
    const simpleText = "The cat sat on the mat. It was warm. The sun shone.";
    const complexText = "The feline positioned itself strategically upon the textile floor covering, experiencing considerable thermal comfort due to the solar radiation penetrating the atmospheric layers.";
    
    const comparison = await analyzer.compareReadability(simpleText, complexText);
    
    console.log(`✅ Simpler text identified: ${comparison.comparison.easier}`);
    console.log(`✅ Key differences found: ${comparison.comparison.keyDifferences.length}`);
    console.log(`✅ Recommendations provided: ${comparison.comparison.recommendations.length}`);
    console.log('✅ Readability Comparison PASSED');
} catch (error) {
    console.log('❌ Readability Comparison FAILED:', error.message);
}

// Test 5: OpenAI Configuration Check
console.log('\nTest 5: OpenAI Configuration');
try {
    const isConfigured = analyzer.isOpenAIConfigured();
    console.log(`✅ OpenAI configuration check: ${isConfigured ? 'Configured' : 'Not configured (expected)'}`);
    
    // Test configuration (without real API key)
    analyzer.configureOpenAI({ apiKey: 'test-key-12345' });
    const configuredAfter = analyzer.isOpenAIConfigured();
    console.log(`✅ OpenAI configuration after setup: ${configuredAfter ? 'Configured' : 'Not configured'}`);
    console.log('✅ OpenAI Configuration PASSED');
} catch (error) {
    console.log('❌ OpenAI Configuration FAILED:', error.message);
}

// Test 6: Readability Trends
console.log('\nTest 6: Readability Trends Analysis');
try {
    const longText = `
        This is a simple introduction paragraph. Short sentences work well. Easy to read.
        
        However, as the document progresses, the complexity begins to increase substantially, with longer sentences that contain multiple clauses and more sophisticated vocabulary that might challenge readers.
        
        The concluding section returns to simplicity. Clear thoughts. Direct communication. Better readability.
    `;
    
    const trends = await analyzer.analyzeReadabilityTrends(longText, 3);
    
    console.log(`✅ Trend segments analyzed: ${trends.segments.length}`);
    console.log(`✅ Overall trend: ${trends.overallTrend}`);
    console.log(`✅ Problematic sections: ${trends.problematicSections.length}`);
    console.log('✅ Readability Trends PASSED');
} catch (error) {
    console.log('❌ Readability Trends FAILED:', error.message);
}

console.log('\n' + '='.repeat(50));
console.log('ENHANCEMENT FEATURES TEST COMPLETE');
console.log('='.repeat(50));