declare module 'pos' {
	export class Lexer {
		lex(text: string): string[];
	}

	export class Tagger {
		tag(tokens: string[]): Array<[string, string]>;
	}
}
