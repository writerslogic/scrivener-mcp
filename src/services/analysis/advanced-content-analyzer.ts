/**
 * Advanced Content Analyzer with proper linguistic analysis
 * Fixes all the critical issues in the original implementation
 */

import nlp from 'compromise';
import { generateHash } from '../../utils/common.js';
import datePlugin from 'compromise-dates';
// @ts-expect-error - compromise-numbers doesn't have types
import numbersPlugin from 'compromise-numbers';
import { syllable } from 'syllable';
import { getLogger } from '../../core/logger.js';

// Extend Compromise with plugins
nlp.plugin(datePlugin);
nlp.plugin(numbersPlugin);

const _logger = getLogger('advanced-content-analyzer');

// CMU Pronouncing Dictionary subset for common words with tricky syllables
const CMU_SYLLABLES: Record<string, number> = {
	type: 1,
	make: 1,
	take: 1,
	like: 1,
	time: 1,
	made: 1,
	people: 2,
	little: 2,
	every: 3,
	different: 3,
	comfortable: 4,
	beautiful: 3,
	interesting: 4,
	dangerous: 3,
	invisible: 4,
	terrible: 3,
	horrible: 3,
	vegetable: 4,
	responsible: 4,
	temperature: 4,
	literature: 4,
	chocolate: 3,
	separate: 3,
	desperate: 3,
	deliberate: 4,
	corporate: 3,
	elaborate: 4,
	immediate: 4,
	articulate: 4,
	associate: 4,
	appreciate: 4,
	// Add more as needed
};

export interface SceneBreakAnalysis {
	totalBreaks: number;
	types: {
		explicit: number; // *** or similar
		temporal: number; // "Three days later"
		spatial: number; // Location changes
		povSwitch: number; // POV changes
		whiteSpace: number; // Significant gaps
	};
	averageSceneLength: number;
	sceneList: Array<{
		start: number;
		end: number;
		type: string;
		trigger?: string;
	}>;
}

export interface ShowVsTellAnalysis {
	ratio: number;
	issues: Array<{
		type: 'filter_word' | 'emotional_telling' | 'sensory_filter' | 'abstract_language';
		text: string;
		suggestion: string;
		location: { line: number; column: number };
	}>;
	score: number; // 0-100, higher is better (more showing)
}

export interface DialogueAttributionAnalysis {
	totalDialogueLines: number;
	attributionTypes: {
		said: number;
		saidBookisms: number; // fancy alternatives to "said"
		actionBeats: number;
		unattributed: number;
		adverbialTags: number; // "he said angrily"
	};
	efficiency: number; // 0-100
	issues: string[];
	floatingDialogue: number; // Dialogue without clear speaker
}

export interface POVAnalysis {
	type: 'first' | 'second' | 'third_limited' | 'third_omniscient' | 'mixed';
	consistency: number; // 0-100
	focalCharacter?: string;
	violations: Array<{
		type: 'head_hopping' | 'pov_shift' | 'omniscient_intrusion' | 'filter_word';
		text: string;
		location: { line: number; column: number };
		severity: 'minor' | 'major';
	}>;
	narrativeDistance: 'intimate' | 'close' | 'medium' | 'distant' | 'variable';
}

export interface PassiveVoiceAnalysis {
	instances: Array<{
		sentence: string;
		passive: string;
		active_suggestion?: string;
		location: { line: number; column: number };
	}>;
	percentage: number;
	byAgentPresent: number; // Passives with "by" agent
	agentlessPassives: number; // More problematic passives without agent
}

export class AdvancedContentAnalyzer {
	private syllableCache = new Map<string, number>();

	/**
	 * Accurate syllable counting using dictionary + fallback algorithm
	 */
	countSyllables(word: string): number {
		const lower = word.toLowerCase();

		// Check cache first
		if (this.syllableCache.has(lower)) {
			return this.syllableCache.get(lower)!;
		}

		// Check CMU dictionary
		if (CMU_SYLLABLES[lower]) {
			const count = CMU_SYLLABLES[lower];
			this.syllableCache.set(lower, count);
			return count;
		}

		// Use syllable library (much more accurate than regex)
		const count = syllable(word);
		this.syllableCache.set(lower, count);
		return count;
	}

	/**
	 * Calculate accurate readability scores
	 */
	calculateReadability(text: string): {
		fleschReadingEase: number;
		fleschKincaidGrade: number;
		gunningFog: number;
		smog: number;
		automatedReadability: number;
	} {
		const sentences = text.match(/[.!?]+/g)?.length || 1;
		const words = text.match(/\b\w+\b/g) || [];
		const wordCount = words.length;

		// Count syllables accurately
		let totalSyllables = 0;
		let complexWords = 0; // 3+ syllables

		words.forEach((word) => {
			const syllables = this.countSyllables(word);
			totalSyllables += syllables;
			if (syllables >= 3) {
				complexWords++;
			}
		});

		// Flesch Reading Ease
		const avgSyllablesPerWord = totalSyllables / wordCount;
		const avgWordsPerSentence = wordCount / sentences;
		const fleschReadingEase =
			206.835 - 1.015 * avgWordsPerSentence - 84.6 * avgSyllablesPerWord;

		// Flesch-Kincaid Grade Level
		const fleschKincaidGrade = 0.39 * avgWordsPerSentence + 11.8 * avgSyllablesPerWord - 15.59;

		// Gunning Fog Index
		const fogIndex = 0.4 * (avgWordsPerSentence + (100 * complexWords) / wordCount);

		// SMOG (Simplified Measure of Gobbledygook)
		const smog = 1.043 * Math.sqrt(complexWords * (30 / sentences)) + 3.1291;

		// Automated Readability Index
		const characters = text.replace(/\s/g, '').length;
		const ari = 4.71 * (characters / wordCount) + 0.5 * avgWordsPerSentence - 21.43;

		return {
			fleschReadingEase: Math.max(0, Math.min(100, fleschReadingEase)),
			fleschKincaidGrade: Math.max(0, fleschKincaidGrade),
			gunningFog: Math.max(0, fogIndex),
			smog: Math.max(0, smog),
			automatedReadability: Math.max(0, ari),
		};
	}

	/**
	 * Intelligent scene break detection
	 */
	detectSceneBreaks(text: string): SceneBreakAnalysis {
		const lines = text.split('\n');
		const scenes: SceneBreakAnalysis['sceneList'] = [];
		let currentScene = {
			start: 0,
			end: 0,
			type: 'initial',
			trigger: undefined as string | undefined,
		};

		const analysis: SceneBreakAnalysis = {
			totalBreaks: 0,
			types: {
				explicit: 0,
				temporal: 0,
				spatial: 0,
				povSwitch: 0,
				whiteSpace: 0,
			},
			averageSceneLength: 0,
			sceneList: [],
		};

		// Temporal shift patterns
		const temporalPatterns = [
			/^(The next|Next|That|Later that|Early the next) (morning|day|evening|night|week|month|year)/i,
			/^(Hours|Days|Weeks|Months|Years|Minutes) (later|earlier|passed|before|after)/i,
			/^(After|Before|When|Once|As soon as)/i,
			/^Meanwhile|^Subsequently|^Previously/i,
			/\b(dawn|dusk|sunrise|sunset|midnight|noon)\b/i,
		];

		// Location change patterns
		const locationPatterns = [
			/^(At|In|On|Inside|Outside|Above|Below|Near) (the|a)/i,
			/^Back (at|in|to)/i,
			/\b(arrived at|reached|entered|left|departed)\b/i,
		];

		// POV indicators
		let lastPOVCharacter: string | null = null;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();
			const nextLine = lines[i + 1]?.trim() || '';
			const prevLine = lines[i - 1]?.trim() || '';

			let breakDetected = false;
			let breakType = '';
			let trigger = '';

			// Explicit scene breaks
			if (trimmed.match(/^(\*\s*){3,}$|^(#|•|◆|□|\*)\s*$|^Chapter\s+\d+/i)) {
				breakDetected = true;
				breakType = 'explicit';
				trigger = trimmed;
				analysis.types.explicit++;
			}

			// White space breaks (empty lines around text)
			else if (trimmed === '' && prevLine === '' && nextLine && nextLine !== '') {
				// Significant white space (2+ empty lines)
				breakDetected = true;
				breakType = 'whiteSpace';
				analysis.types.whiteSpace++;
			}

			// Temporal shifts
			else if (
				temporalPatterns.some((pattern) => {
					const match = trimmed.match(pattern);
					if (match) {
						trigger = match[0];
						return true;
					}
					return false;
				})
			) {
				breakDetected = true;
				breakType = 'temporal';
				analysis.types.temporal++;
			}

			// Spatial shifts
			else if (
				locationPatterns.some((pattern) => {
					const match = trimmed.match(pattern);
					if (match) {
						trigger = match[0];
						return true;
					}
					return false;
				})
			) {
				breakDetected = true;
				breakType = 'spatial';
				analysis.types.spatial++;
			}

			// POV switches (check for character name + thought/action)
			else {
				const doc = nlp(trimmed);
				const people = doc.people().out('array');
				if (people.length > 0 && people[0] !== lastPOVCharacter) {
					// Check if this seems like a POV switch
					if (doc.has('#Pronoun #Verb') || doc.has('#Person #Verb')) {
						lastPOVCharacter = people[0];
						if (i > 0) {
							// Don't count the first character introduction
							breakDetected = true;
							breakType = 'povSwitch';
							trigger = `POV: ${people[0]}`;
							analysis.types.povSwitch++;
						}
					}
				}
			}

			if (breakDetected) {
				currentScene.end = i;
				if (currentScene.end > currentScene.start) {
					scenes.push({ ...currentScene });
				}
				currentScene = {
					start: i + 1,
					end: 0,
					type: breakType,
					trigger: trigger || undefined,
				};
				analysis.totalBreaks++;
			}
		}

		// Add final scene
		currentScene.end = lines.length;
		if (currentScene.end > currentScene.start) {
			scenes.push(currentScene);
		}

		analysis.sceneList = scenes;
		analysis.averageSceneLength =
			scenes.length > 0
				? scenes.reduce((sum, s) => sum + (s.end - s.start), 0) / scenes.length
				: 0;

		return analysis;
	}

	/**
	 * Sophisticated Show vs Tell analysis
	 */
	analyzeShowVsTell(text: string): ShowVsTellAnalysis {
		const lines = text.split('\n');
		const issues: ShowVsTellAnalysis['issues'] = [];
		let showCount = 0;
		let tellCount = 0;

		// Filter words that distance the reader
		const filterWords = [
			'saw',
			'heard',
			'felt',
			'noticed',
			'realized',
			'wondered',
			'thought',
			'knew',
			'understood',
			'seemed',
			'appeared',
			'looked like',
			'sounded like',
		];

		// Emotional telling patterns
		const emotionalTelling = [
			/\bwas (angry|happy|sad|afraid|excited|nervous|anxious|worried)/i,
			/\bfelt (angry|happy|sad|afraid|excited|nervous|anxious|worried)/i,
			/\blooked (angry|happy|sad|afraid|excited|nervous|anxious|worried)/i,
			/\bseemed (angry|happy|sad|afraid|excited|nervous|anxious|worried)/i,
		];

		// Sensory filtering patterns
		const sensoryFilters = [
			/\b(saw|watched|observed|noticed) (that|how|as)/i,
			/\b(heard|listened to) the sound of/i,
			/\b(felt|sensed) the (presence|feeling) of/i,
			/\bsmelled the (scent|odor|fragrance) of/i,
			/\btasted the flavor of/i,
		];

		lines.forEach((line, lineNum) => {
			const doc = nlp(line);

			// Check for filter words
			filterWords.forEach((word) => {
				if (doc.has(word)) {
					const matches = line.match(new RegExp(`\\b${word}\\b`, 'gi')) || [];
					matches.forEach((match) => {
						const column = line.indexOf(match);
						issues.push({
							type: 'filter_word',
							text: match,
							suggestion: `Consider removing "${match}" and showing the action directly`,
							location: { line: lineNum, column },
						});
						tellCount++;
					});
				}
			});

			// Check emotional telling
			emotionalTelling.forEach((pattern) => {
				const match = line.match(pattern);
				if (match) {
					issues.push({
						type: 'emotional_telling',
						text: match[0],
						suggestion: `Show the emotion through action/dialogue instead of stating "${match[0]}"`,
						location: { line: lineNum, column: line.indexOf(match[0]) },
					});
					tellCount++;
				}
			});

			// Check sensory filters
			sensoryFilters.forEach((pattern) => {
				const match = line.match(pattern);
				if (match) {
					issues.push({
						type: 'sensory_filter',
						text: match[0],
						suggestion: `Remove the filter "${match[0]}" and describe directly`,
						location: { line: lineNum, column: line.indexOf(match[0]) },
					});
					tellCount++;
				}
			});

			// Count concrete vs abstract language
			const concreteWords = doc.match('#Noun').not('#Abstract').length;
			const abstractWords = doc.match('#Abstract').length;

			if (abstractWords > concreteWords * 2) {
				issues.push({
					type: 'abstract_language',
					text: `${line.substring(0, 50)}...`,
					suggestion: 'Use more concrete, specific details',
					location: { line: lineNum, column: 0 },
				});
				tellCount += abstractWords;
			} else {
				showCount += concreteWords;
			}

			// Reward specific sensory details
			if (
				doc.has('#Color') ||
				doc.has('#Texture') ||
				line.match(/\b(rough|smooth|soft|hard|cold|warm|hot)\b/i)
			) {
				showCount += 2;
			}

			// Reward active, specific verbs
			const activeVerbs = doc.verbs().not('#Auxiliary').not('#Modal').not('#Copula').length;
			showCount += activeVerbs;
		});

		const total = showCount + tellCount;
		const ratio = showCount / (tellCount || 1);
		const score = total > 0 ? (showCount / total) * 100 : 50;

		return {
			ratio,
			issues: issues.slice(0, 50), // Limit to top 50 issues
			score: Math.round(score),
		};
	}

	/**
	 * Comprehensive dialogue attribution analysis
	 */
	analyzeDialogueAttribution(text: string): DialogueAttributionAnalysis {
		const dialogueRegex = /["']([^"']+)["']/g;
		const dialogueMatches = [...text.matchAll(dialogueRegex)];

		const analysis: DialogueAttributionAnalysis = {
			totalDialogueLines: dialogueMatches.length,
			attributionTypes: {
				said: 0,
				saidBookisms: 0,
				actionBeats: 0,
				unattributed: 0,
				adverbialTags: 0,
			},
			efficiency: 0,
			issues: [],
			floatingDialogue: 0,
		};

		// Said bookisms to detect
		const saidBookisms = [
			'exclaimed',
			'pronounced',
			'declared',
			'announced',
			'stated',
			'uttered',
			'expressed',
			'voiced',
			'articulated',
			'ejaculated',
			'cried',
			'shouted',
			'whispered',
			'murmured',
			'muttered',
			'growled',
			'snarled',
			'hissed',
			'spat',
			'barked',
		];

		// Adverbs that often appear with dialogue tags
		const dialogueAdverbs = [
			'angrily',
			'happily',
			'sadly',
			'quietly',
			'loudly',
			'softly',
			'harshly',
			'gently',
			'sarcastically',
			'bitterly',
			'sweetly',
		];

		const lines = text.split('\n');
		const _lastSpeaker = '';
		let unattributedRun = 0;

		dialogueMatches.forEach((match, _index) => {
			const dialogue = match[0];
			const lineNum = text.substring(0, match.index!).split('\n').length - 1;
			const line = lines[lineNum];
			const nextLine = lines[lineNum + 1] || '';
			const prevLine = lines[lineNum - 1] || '';

			// Check what follows/precedes the dialogue
			const afterDialogue = line.substring(line.indexOf(dialogue) + dialogue.length);
			const beforeDialogue = line.substring(0, line.indexOf(dialogue));

			let attributed = false;

			// Check for "said" attribution
			if (
				afterDialogue.match(/\b(said|says|saying)\b/i) ||
				beforeDialogue.match(/\b(said|says|saying)\b/i)
			) {
				analysis.attributionTypes.said++;
				attributed = true;

				// Check for adverbial tags
				dialogueAdverbs.forEach((adverb) => {
					if (afterDialogue.includes(adverb) || beforeDialogue.includes(adverb)) {
						analysis.attributionTypes.adverbialTags++;
						analysis.issues.push(
							`Adverbial tag "${adverb}" - consider using action beat instead`
						);
					}
				});
			}

			// Check for said bookisms
			let foundBookism = false;
			saidBookisms.forEach((bookism) => {
				if (
					afterDialogue.match(new RegExp(`\\b${bookism}\\b`, 'i')) ||
					beforeDialogue.match(new RegExp(`\\b${bookism}\\b`, 'i'))
				) {
					analysis.attributionTypes.saidBookisms++;
					analysis.issues.push(
						`Said-bookism "${bookism}" - consider using "said" or action beat`
					);
					attributed = true;
					foundBookism = true;
				}
			});

			// Check for action beats (character action near dialogue)
			if (!attributed && !foundBookism) {
				const doc = nlp(nextLine);
				if (doc.has('#Person #Verb') || doc.has('#Pronoun #Verb')) {
					analysis.attributionTypes.actionBeats++;
					attributed = true;
				} else {
					const prevDoc = nlp(prevLine);
					if (prevDoc.has('#Person #Verb') || prevDoc.has('#Pronoun #Verb')) {
						analysis.attributionTypes.actionBeats++;
						attributed = true;
					}
				}
			}

			// Track unattributed dialogue
			if (!attributed) {
				analysis.attributionTypes.unattributed++;
				unattributedRun++;

				if (unattributedRun > 3) {
					analysis.floatingDialogue++;
					if (unattributedRun === 4) {
						analysis.issues.push(
							`Floating dialogue detected at line ${lineNum} - unclear speaker`
						);
					}
				}
			} else {
				unattributedRun = 0;
			}
		});

		// Calculate efficiency score
		const saidRatio = analysis.attributionTypes.said / (analysis.totalDialogueLines || 1);
		const bookismRatio =
			analysis.attributionTypes.saidBookisms / (analysis.totalDialogueLines || 1);
		const actionBeatRatio =
			analysis.attributionTypes.actionBeats / (analysis.totalDialogueLines || 1);
		const unattributedRatio =
			analysis.attributionTypes.unattributed / (analysis.totalDialogueLines || 1);

		// Ideal: mostly "said" and action beats, minimal bookisms, some unattributed (but not too many)
		analysis.efficiency = Math.round(
			saidRatio * 40 +
				actionBeatRatio * 40 +
				Math.max(0, 20 - bookismRatio * 40) +
				Math.max(0, 20 - Math.abs(unattributedRatio - 0.2) * 50)
		);

		return analysis;
	}

	/**
	 * Proper passive voice detection using grammatical parsing
	 */
	detectPassiveVoice(text: string): PassiveVoiceAnalysis {
		const sentences = text.split(/[.!?]+/);
		const instances: PassiveVoiceAnalysis['instances'] = [];
		let totalClauses = 0;
		let passiveClauses = 0;
		let byAgentPresent = 0;
		let agentlessPassives = 0;

		sentences.forEach((sentence, index) => {
			if (!sentence.trim()) return;

			const doc = nlp(sentence);
			totalClauses++;

			// Use NLP library to detect passive voice more accurately
			const hasPassiveVoice = doc.has('#Passive');
			if (hasPassiveVoice) {
				passiveClauses++;
				return;
			}

			// Fallback to pattern-based detection for cases NLP misses
			// Passive voice pattern: be-verb + past participle
			// Examples: "was eaten", "is being written", "has been done"
			const beVerbs = ['is', 'are', 'was', 'were', 'been', 'being', 'be', 'am'];

			beVerbs.forEach((beVerb) => {
				const pattern = new RegExp(
					`\\b${beVerb}\\s+\\w+ed\\b|\\b${beVerb}\\s+\\w+en\\b`,
					'gi'
				);
				const matches = sentence.match(pattern);

				if (matches) {
					matches.forEach((match) => {
						// Verify it's actually passive (not "was running" which is past progressive)
						const words = match.split(/\s+/);
						const participle = words[words.length - 1];

						// Check if it's a past participle (not a gerund)
						if (
							participle.endsWith('ed') ||
							participle.endsWith('en') ||
							[
								'written',
								'taken',
								'given',
								'done',
								'gone',
								'seen',
								'made',
								'found',
								'told',
								'known',
							].includes(participle)
						) {
							// Check for "by" agent
							const hasAgent = sentence.match(new RegExp(`${match}.*?\\bby\\b`, 'i'));

							if (hasAgent) {
								byAgentPresent++;
							} else {
								agentlessPassives++;
							}

							// Try to suggest active voice
							let activeSuggestion = undefined;
							if (hasAgent) {
								// "The book was written by John" -> "John wrote the book"
								const agentMatch = sentence.match(
									new RegExp(`${match}.*?by\\s+(\\w+)`, 'i')
								);
								if (agentMatch) {
									const agent = agentMatch[1];
									const verbRoot = participle.replace(/ed$|en$/, '');
									activeSuggestion = `${agent} ${verbRoot}...`;
								}
							}

							instances.push({
								sentence: sentence.trim(),
								passive: match,
								active_suggestion: activeSuggestion,
								location: {
									line: index,
									column: sentence.indexOf(match),
								},
							});
						}
					});
				}
			});

			// Also check for "get" passives: "got eaten", "gets done"
			const getPassives = sentence.match(/\b(get|gets|got|gotten)\s+\w+ed\b/gi);
			if (getPassives) {
				getPassives.forEach((match) => {
					agentlessPassives++;
					instances.push({
						sentence: sentence.trim(),
						passive: match,
						active_suggestion: undefined,
						location: {
							line: index,
							column: sentence.indexOf(match),
						},
					});
				});
			}
		});

		const totalPassives = instances.length;
		const percentage = totalClauses > 0 ? (totalPassives / totalClauses) * 100 : 0;

		return {
			instances: instances.slice(0, 50), // Limit to 50 examples
			percentage: Math.round(percentage * 10) / 10,
			byAgentPresent,
			agentlessPassives,
		};
	}

	/**
	 * POV and focal character tracking
	 */
	analyzePOV(text: string): POVAnalysis {
		const doc = nlp(text);
		const sentences = text.split(/[.!?]+/);

		const analysis: POVAnalysis = {
			type: 'third_limited',
			consistency: 100,
			violations: [],
			narrativeDistance: 'medium',
		};

		// Detect POV type
		const firstPersonCount = doc.match('(i|me|my|mine|myself|we|us|our|ours)').length;
		const secondPersonCount = doc.match('(you|your|yours)').not('#Quote').length;
		const thirdPersonCount = doc.match(
			'(he|she|it|they|him|her|them|his|hers|its|their)'
		).length;

		const totalPronouns = firstPersonCount + secondPersonCount + thirdPersonCount;

		if (firstPersonCount > totalPronouns * 0.6) {
			analysis.type = 'first';
		} else if (secondPersonCount > totalPronouns * 0.3) {
			analysis.type = 'second';
		} else if (thirdPersonCount > totalPronouns * 0.6) {
			// Determine if limited or omniscient
			analysis.type = 'third_limited'; // Will refine below
		} else {
			analysis.type = 'mixed';
			analysis.consistency = 70;
		}

		// Find focal character(s)
		const characters = doc.people().out();
		if (Object.keys(characters).length > 0) {
			const mainCharacter = Object.entries(characters).sort(
				(a, b) => (b[1] as number) - (a[1] as number)
			)[0][0];
			analysis.focalCharacter = mainCharacter;
		}

		// Check for POV violations
		const currentPOVCharacter = analysis.focalCharacter;
		let intimacyScore = 0;
		let distanceScore = 0;

		sentences.forEach((sentence, index) => {
			if (!sentence.trim()) return;

			const sentDoc = nlp(sentence);

			// Head-hopping detection (third person)
			if (analysis.type.startsWith('third')) {
				// Check for thoughts/feelings of non-focal characters
				const thoughtVerbs = [
					'thought',
					'felt',
					'wondered',
					'realized',
					'knew',
					'understood',
				];
				const characters = sentDoc.people().out('array');

				thoughtVerbs.forEach((verb) => {
					if (sentence.includes(verb)) {
						characters.forEach((char: string) => {
							if (char !== currentPOVCharacter && sentence.includes(char)) {
								analysis.violations.push({
									type: 'head_hopping',
									text: sentence.substring(0, 100),
									location: { line: index, column: 0 },
									severity: 'major',
								});
								analysis.consistency -= 5;
							}
						});
					}
				});
			}

			// Filter word detection (distancing)
			const filterWords = ['saw', 'heard', 'felt', 'noticed', 'observed', 'watched'];
			filterWords.forEach((word) => {
				if (sentence.includes(word) && analysis.focalCharacter) {
					const beforeWord = sentence.substring(0, sentence.indexOf(word));
					if (
						beforeWord.includes(analysis.focalCharacter) ||
						beforeWord.match(/\b(he|she|they)\b/i)
					) {
						analysis.violations.push({
							type: 'filter_word',
							text: word,
							location: { line: index, column: sentence.indexOf(word) },
							severity: 'minor',
						});
						distanceScore++;
					}
				}
			});

			// Check for omniscient intrusions
			if (analysis.type === 'third_limited') {
				// Look for knowledge the focal character shouldn't have
				if (
					sentence.match(/\bmeanwhile\b/i) ||
					sentence.match(/\blittle did (he|she|they) know\b/i) ||
					sentence.match(/\bunbeknownst to/i)
				) {
					analysis.violations.push({
						type: 'omniscient_intrusion',
						text: sentence.substring(0, 100),
						location: { line: index, column: 0 },
						severity: 'major',
					});
					analysis.consistency -= 3;
				}
			}

			// Track narrative distance
			if (sentence.match(/\b(felt|thought|wondered|realized)\b/)) {
				intimacyScore++;
			}
			if (sentence.match(/\b(seemed|appeared|apparently|evidently)\b/)) {
				distanceScore++;
			}
		});

		// Determine narrative distance
		const distanceRatio = distanceScore / (intimacyScore + distanceScore || 1);
		if (distanceRatio < 0.2) {
			analysis.narrativeDistance = 'intimate';
		} else if (distanceRatio < 0.4) {
			analysis.narrativeDistance = 'close';
		} else if (distanceRatio < 0.6) {
			analysis.narrativeDistance = 'medium';
		} else if (distanceRatio < 0.8) {
			analysis.narrativeDistance = 'distant';
		} else {
			analysis.narrativeDistance = 'variable';
		}

		// Check if third person is omniscient based on violations
		if (
			analysis.type === 'third_limited' &&
			analysis.violations.filter((v) => v.type === 'head_hopping').length > 5
		) {
			analysis.type = 'third_omniscient';
			// Omniscient is not a violation, so restore consistency
			analysis.consistency = Math.min(100, analysis.consistency + 25);
			// Remove head-hopping violations for omniscient
			analysis.violations = analysis.violations.filter((v) => v.type !== 'head_hopping');
		}

		analysis.consistency = Math.max(0, Math.min(100, analysis.consistency));

		return analysis;
	}

	/**
	 * Generate content hash for proper caching
	 */
	generateContentHash(content: string): string {
		return generateHash(content);
	}

	/**
	 * Create cache key using content hash
	 */
	createCacheKey(documentId: string, content: string, analysisType: string): string {
		const contentHash = this.generateContentHash(content);
		return `analysis:${documentId}:${analysisType}:${contentHash}`;
	}
}

// Export singleton
export const advancedAnalyzer = new AdvancedContentAnalyzer();
