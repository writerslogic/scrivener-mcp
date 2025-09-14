declare module 'rtf-parser' {
	interface RTFDoc {
		// Note: Using 'unknown' here because rtf-parser library returns variable content structure
		// Content can be nested objects, arrays, or plain text depending on RTF complexity
		content?: unknown;
		meta?: {
			title?: string;
			author?: string;
			subject?: string;
			keywords?: string;
			creationDate?: Date;
			modificationDate?: Date;
		};
	}

	interface ParseOptions {
		ignoreWhitespace?: boolean;
	}

	function parseRTF(rtfString: string, callback: (err: Error | null, doc: RTFDoc) => void): void;
	function parseRTF(
		rtfString: string,
		options: ParseOptions,
		callback: (err: Error | null, doc: RTFDoc) => void
	): void;

	namespace parseRTF {
		function string(
			rtfString: string,
			callback: (err: Error | null, doc: RTFDoc) => void
		): void;
		function string(
			rtfString: string,
			options: ParseOptions,
			callback: (err: Error | null, doc: RTFDoc) => void
		): void;
	}

	export = parseRTF;
}
