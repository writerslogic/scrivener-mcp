import nlp from 'compromise';
import { classifyNoun, isMaterialNoun } from './continuity-nouns.js';

export function hasNonpersonalObject(predicate: string): boolean {
	if (!predicate || predicate.length > 160) return false;
	const terms = nlp(predicate)
		.json()
		.flatMap(
			(sentence: { terms: Array<{ normal: string; tags: string[] }> }) => sentence.terms
		) as Array<{ normal: string; tags: string[] }>;
	if (terms.length < 3 || terms.length > 8) return false;
	const [verb, determiner] = terms;
	if (
		!verb.tags.includes('Verb') ||
		!verb.tags.some((tag) => tag === 'PastTense' || tag === 'PresentTense') ||
		verb.tags.some((tag) => ['Copula', 'Modal', 'Negative'].includes(tag))
	)
		return false;
	if (!['a', 'an', 'the'].includes(determiner.normal)) return false;
	if (
		!terms
			.slice(2, -1)
			.every(
				(term) =>
					(term.tags.includes('Adjective') ||
						(term.tags.includes('Noun') && isMaterialNoun(term.normal))) &&
					!term.tags.some((tag) => ['Verb', 'ProperNoun', 'Person'].includes(tag))
			)
	)
		return false;
	const head = terms[terms.length - 1];
	if (
		!head.tags.includes('Noun') ||
		head.tags.some((tag) => ['ProperNoun', 'Person', 'Actor', 'Pronoun'].includes(tag))
	)
		return false;
	const classification = classifyNoun(head.normal);
	if (classification !== 'unknown') return classification === 'nonpersonal';
	const singular = nlp(head.normal).nouns().toSingular().text().toLowerCase();
	return singular !== head.normal && classifyNoun(singular) === 'nonpersonal';
}
