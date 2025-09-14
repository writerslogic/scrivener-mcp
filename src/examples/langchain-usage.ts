/* eslint-disable no-console */
/**
 * Example usage of the Enhanced LangChain Service
 * Demonstrates effective use of LangChain for manuscript analysis and writing assistance
 */

import { EnhancedLangChainService } from '../services/ai/langchain-service-enhanced.js';
import type { ScrivenerDocument } from '../types/index.js';

async function demonstrateLangChainUsage() {
	// Initialize with OpenAI model (add more providers as needed)
	const langchainService = new EnhancedLangChainService([
		{
			provider: 'openai',
			modelName: 'gpt-4-turbo-preview',
			apiKey: process.env.OPENAI_API_KEY,
			temperature: 0.7,
			streaming: true,
		},
		// Uncomment when @langchain/anthropic is installed:
		// {
		// 	provider: 'anthropic',
		// 	modelName: 'claude-3-opus-20240229',
		// 	apiKey: process.env.ANTHROPIC_API_KEY,
		// 	temperature: 0.7,
		// 	streaming: true,
		// },
	]);

	// Sample manuscript documents
	const documents: ScrivenerDocument[] = [
		{
			id: 'chapter-1',
			title: 'Chapter 1: The Beginning',
			type: 'Text',
			path: '/manuscript/chapter-1.md',
			content: `Sarah stood at the edge of the cliff, wind whipping through her dark hair. 
				The letter in her pocket felt heavier than the rocks beneath her feet. 
				Twenty years had passed since she'd last been here, since the accident that changed everything.
				
				"You came," a voice said behind her.
				
				She didn't turn. She'd recognize that voice anywhere, even after all these years.
				"I had to," she replied. "After what you wrote..."
				
				The man stepped beside her, his presence familiar yet strange. David had aged well, 
				but his eyes still held that same intensity that had once made her believe in forever.`,
		},
		{
			id: 'chapter-2',
			title: 'Chapter 2: Revelations',
			type: 'Text',
			path: '/manuscript/chapter-2.md',
			content: `The coffee shop hadn't changed much. Same cracked leather seats, same smell of 
				burnt coffee and hope. Sarah stirred her latte, avoiding David's gaze.
				
				"The police never found out what really happened that night," David said quietly.
				
				Sarah's hand stilled. "Some things are better left buried."
				
				"Not when innocent people are still paying for it." He slid a photograph across the table.
				A young woman, barely twenty, with Sarah's eyes and David's stubborn chin.
				
				"Her name is Emma," he continued. "Our daughter."`,
		},
		{
			id: 'chapter-3',
			title: 'Chapter 3: The Past Returns',
			type: 'Text',
			path: '/manuscript/chapter-3.md',
			content: `Emma had grown up thinking her parents died in a car crash. The truth was more 
				complicated, as truth often is. Sarah had given her up for adoption the day she was born,
				convinced it was the only way to keep her safe from the shadows that haunted their family.
				
				Now, twenty years later, those shadows had found Emma anyway.
				
				"She's in danger," David said, his voice urgent. "The same people who came after us—"
				
				"Are dead," Sarah interrupted. "I made sure of it."
				
				David shook his head. "Their organization isn't. And they know about Emma."`,
		},
	];

	console.log('🚀 Enhanced LangChain Service Demonstration\n');

	// 1. Build vector store with advanced chunking
	console.log('1️⃣ Building vector store with hybrid chunking strategy...');
	await langchainService.buildVectorStore(documents, { strategy: 'hybrid' });
	console.log('✅ Vector store built successfully\n');

	// 2. Semantic search with reranking
	console.log('2️⃣ Performing semantic search with reranking...');
	const searchResults = await langchainService.semanticSearch('daughter secret identity', {
		topK: 3,
		rerank: true,
	});
	console.log(`Found ${searchResults.length} relevant passages:`);
	searchResults.forEach((doc, i) => {
		console.log(`  ${i + 1}. ${doc.pageContent.substring(0, 100)}...`);
	});
	console.log();

	// 3. Character development analysis
	console.log('3️⃣ Analyzing character development...');
	const characterAnalysis = await langchainService.generateWithTemplate(
		'character_development',
		"Analyze Sarah's character arc and her relationship with David and Emma"
	);
	console.log('Character Analysis:', `${characterAnalysis.content.substring(0, 200)}...\n`);

	// 4. Plot structure analysis
	console.log('4️⃣ Analyzing plot structure...');
	const plotAnalysis = await langchainService.generateWithTemplate(
		'plot_structure',
		'Evaluate the three-act structure and identify the inciting incident'
	);
	console.log('Plot Analysis:', `${plotAnalysis.content.substring(0, 200)}...\n`);

	// 5. Dialogue enhancement suggestions
	console.log('5️⃣ Getting dialogue enhancement suggestions...');
	const dialogueSuggestions = await langchainService.generateWithTemplate(
		'dialogue_enhancement',
		'Suggest improvements for the dialogue between Sarah and David in the coffee shop'
	);
	console.log('Dialogue Suggestions:', `${dialogueSuggestions.content.substring(0, 200)}...\n`);

	// 6. Advanced plot consistency check
	console.log('6️⃣ Running advanced plot consistency check...');
	const consistencyCheck = await langchainService.checkPlotConsistencyAdvanced(documents);
	console.log(`Found ${consistencyCheck.issues.length} potential issues:`);
	consistencyCheck.issues.forEach((issue) => {
		console.log(`  - [${issue.severity.toUpperCase()}] ${issue.issue}`);
		console.log(`    Suggestion: ${issue.suggestion}`);
		console.log(`    Confidence: ${(issue.confidence * 100).toFixed(0)}%`);
	});
	console.log(`\nCharacter Graph: ${consistencyCheck.characterGraph.size} characters mapped`);
	console.log(`Timeline: ${consistencyCheck.timeline.length} events extracted\n`);

	// 7. Streaming generation example
	console.log('7️⃣ Generating with streaming (first 100 chars)...');
	let streamedContent = '';
	await langchainService.generateWithStreaming(
		'Write the opening of Chapter 4',
		searchResults.map((doc) => doc.pageContent).join('\n'),
		{
			onToken: (token) => {
				streamedContent += token;
				if (streamedContent.length <= 100) {
					process.stdout.write(token);
				}
			},
			onEnd: () => {
				console.log('...\n');
			},
			onError: (error) => {
				console.error('Streaming error:', error);
			},
		}
	);

	// 8. Conversational Q&A with memory
	console.log('8️⃣ Testing conversational Q&A with memory...');
	const qa1 = await langchainService.askWithMemory(
		'Who is Emma and what is her relationship to Sarah?',
		'session-1'
	);
	console.log('Q: Who is Emma and what is her relationship to Sarah?');
	console.log('A:', `${qa1.answer.substring(0, 150)}...\n`);

	const qa2 = await langchainService.askWithMemory('What danger is she in?', 'session-1');
	console.log('Q: What danger is she in? (using conversation memory)');
	console.log('A:', `${qa2.answer.substring(0, 150)}...\n`);

	// 9. Multi-model fallback
	console.log('9️⃣ Testing multi-model fallback...');
	const fallbackResponse = await langchainService.generateWithFallback(
		'Suggest a plot twist for the next chapter',
		['openai-gpt-4-turbo-preview'] // Add more model names when available
	);
	console.log('Plot Twist Suggestion:', `${fallbackResponse.substring(0, 150)}...\n`);

	// 10. Comprehensive manuscript report
	console.log('🔟 Generating comprehensive manuscript report...');
	const report = await langchainService.generateManuscriptReport(documents);
	console.log('\n📊 MANUSCRIPT REPORT');
	console.log('='.repeat(50));
	console.log('\n📝 Summary:');
	console.log(`${report.summary.substring(0, 300)}...`);
	console.log('\n💪 Strengths:');
	report.strengths.slice(0, 3).forEach((s) => console.log(`  • ${s}`));
	console.log('\n⚠️ Weaknesses:');
	report.weaknesses.slice(0, 3).forEach((w) => console.log(`  • ${w}`));
	console.log('\n💡 Recommendations:');
	report.recommendations.slice(0, 3).forEach((r) => console.log(`  • ${r}`));
	console.log('\n📈 Statistics:');
	console.log(`  • Total Words: ${report.statistics.totalWords}`);
	console.log(`  • Total Chapters: ${report.statistics.totalChapters}`);
	console.log(`  • Average Chapter Length: ${report.statistics.averageChapterLength} words`);
	console.log('\n🎯 Market Analysis:');
	console.log(`  • Genre: ${report.marketability.genre}`);
	console.log(`  • Target Audience: ${report.marketability.targetAudience}`);
	console.log(`  • Comparable Titles: ${report.marketability.comparableTitles.join(', ')}`);
	console.log(`  • Unique Selling Points:`);
	report.marketability.uniqueSellingPoints.forEach((usp) => console.log(`    - ${usp}`));

	// Service statistics
	console.log('\n📊 Service Statistics:');
	const stats = langchainService.getStatistics();
	console.log(`  • Models Loaded: ${stats.modelsLoaded}`);
	console.log(`  • Vector Store Size: ${stats.vectorStoreSize} chunks`);
	console.log(`  • Active Conversations: ${stats.activeConversations}`);
	console.log(`  • Contexts Stored: ${stats.contextsStored}`);

	// Cleanup
	langchainService.clearMemory();
	console.log('\n✅ Demo completed and memory cleared');
}

// Run the demonstration
if (import.meta.url === `file://${process.argv[1]}`) {
	demonstrateLangChainUsage().catch(console.error);
}

export { demonstrateLangChainUsage };
