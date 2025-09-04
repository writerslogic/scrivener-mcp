declare module 'textstat' {
	interface TextstatResult {
		flesch_reading_ease: number;
		flesch_kincaid_grade: number;
		smog_index: number;
		coleman_liau_index: number;
		automated_readability_index: number;
		difficult_words: number;
		linsear_write_formula: number;
		gunning_fog: number;
		text_standard: string;
		syllable_count: number;
		lexicon_count: number;
		sentence_count: number;
		char_count: boolean;
		avg_sentence_length: number;
		avg_syllables_per_word: number;
		avg_letter_per_word: number;
		avg_sentence_per_word: number;
	}

	export function flesch_reading_ease(text: string): number;
	export function flesch_kincaid_grade(text: string): number;
	export function smog_index(text: string): number;
	export function coleman_liau_index(text: string): number;
	export function automated_readability_index(text: string): number;
	export function difficult_words(text: string): number;
	export function linsear_write_formula(text: string): number;
	export function gunning_fog(text: string): number;
	export function text_standard(text: string): string;
	export function syllable_count(text: string): number;
	export function lexicon_count(text: string, removePunctuation?: boolean): number;
	export function sentence_count(text: string): number;
	export function char_count(text: string, ignorSpaces?: boolean): number;
	export function avg_sentence_length(text: string): number;
	export function avg_syllables_per_word(text: string): number;
	export function avg_letter_per_word(text: string): number;
	export function avg_sentence_per_word(text: string): number;
}
