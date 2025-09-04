declare module 'sentiment' {
	interface AnalysisResult {
		score: number;
		comparative: number;
		calculation: Array<{ [key: string]: number }>;
		tokens: string[];
		words: string[];
		positive: string[];
		negative: string[];
	}

	class Sentiment {
		analyze(text: string): AnalysisResult;
	}

	export = Sentiment;
}
