import { hasNonpersonalObject } from '../../../../src/services/editorial/object-coreference.js';
import { classifyNoun } from '../../../../src/services/editorial/continuity-nouns.js';

test.each([
	'lifted the brass lantern',
	'packed the empty suitcase',
	'locked the iron door',
	'folded the clean napkin',
	'opened the leather wallet',
])('recognizes a single nonpersonal object across varied verbs and nouns: %s', (predicate) => {
	expect(hasNonpersonalObject(predicate)).toBe(true);
});

test.each([
	'greeted the young woman',
	'helped the tired nurse',
	'watched the fox',
	'carried the old doll',
	'polished the bronze statue',
	'studied the portrait',
	'repaired the robot',
	'joined the crowd',
	'held the quargle',
	'closed her chest',
	'gave the nurse a map',
	'closed the chest beside Elena',
	'opened the chest and greeted Elena',
	'was the nurse',
	'saw a woman',
])('abstains when the object or clause can introduce another referent: %s', (predicate) => {
	expect(hasNonpersonalObject(predicate)).toBe(false);
});

test.each([159, 160, 161])('bounds parser input at %i characters', (length) => {
	expect(hasNonpersonalObject('opened the door'.padEnd(length))).toBe(length <= 160);
});

test('does not guess the meaning of unknown or polysemous nouns', () => {
	expect(classifyNoun('quargle')).toBe('unknown');
	expect(classifyNoun('doll')).toBe('ambiguous');
	expect(classifyNoun('lantern')).toBe('nonpersonal');
});

test('abstains on cabinet because its noun senses include a governing group', () => {
	expect(hasNonpersonalObject('moved the wooden cabinet')).toBe(false);
});

test.each([
	['packed the suitcases', true],
	['lifted the lanterns', true],
	['helped the nurses', false],
	['carried the dolls', false],
	['repaired the robots', false],
])('preserves noun classification under plural morphology: %s', (predicate, expected) => {
	expect(hasNonpersonalObject(predicate)).toBe(expected);
});
