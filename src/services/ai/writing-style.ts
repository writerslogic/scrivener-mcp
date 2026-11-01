import { createHash } from 'node:crypto';

export const MAX_STYLE_SAMPLES = 64;
export const MAX_STYLE_SAMPLE_LENGTH = 64000;
export const MAX_STYLE_CONTEXT = 8000;
export const STYLE_SCALARS = [
	'voice',
	'tone',
	'sentenceStructure',
	'vocabularyComplexity',
	'pacing',
] as const;
export const STYLE_LISTS = ['strengths', 'improvements'] as const;
export const STYLE_FIELDS = [...STYLE_SCALARS, ...STYLE_LISTS];
type StyleField = (typeof STYLE_FIELDS)[number];

export interface StyleCoverage {
	samples: Array<{
		sampleId: string;
		revision: string;
		start: 0;
		end: number;
		sourceCharacters: number;
		truncated: boolean;
	}>;
	truncated: boolean;
}

export interface WritingStyleResult {
	analysis: Record<(typeof STYLE_SCALARS)[number], string | null> &
		Record<(typeof STYLE_LISTS)[number], string[] | null>;
	availability: {
		status: 'available' | 'partial' | 'unavailable';
		unavailableFields: StyleField[];
		partialFields: StyleField[];
	};
	coverage: StyleCoverage;
}

export function prepareStyleSamples(samples: string[]): {
	context: string;
	coverage: StyleCoverage;
} {
	if (!Array.isArray(samples) || !samples.length || samples.length > MAX_STYLE_SAMPLES)
		throw new Error('Style analysis requires 1–64 text samples');
	const snapshot = [...samples];
	if (
		snapshot.some(
			(sample) =>
				typeof sample !== 'string' ||
				!sample.trim() ||
				sample.length > MAX_STYLE_SAMPLE_LENGTH
		)
	)
		throw new Error(
			'Style samples must contain 1–64000 UTF-16 characters and non-whitespace text'
		);
	let context = '';
	const ranges = snapshot.map((sample, index) => {
		const separator = context ? '\n\n---\n\n' : '';
		let end = Math.min(
			sample.length,
			Math.max(0, MAX_STYLE_CONTEXT - context.length - separator.length)
		);
		if (end < sample.length && /[\uD800-\uDBFF]/.test(sample[end - 1])) end--;
		if (end) context += separator + sample.slice(0, end);
		return {
			sampleId: `sample-${index + 1}`,
			revision: createHash('sha256').update(sample).digest('hex'),
			start: 0 as const,
			end,
			sourceCharacters: sample.length,
			truncated: end < sample.length,
		};
	});
	return {
		context,
		coverage: { samples: ranges, truncated: ranges.some((sample) => sample.truncated) },
	};
}

export function parseStyleProfile(
	parsed: unknown
): Pick<WritingStyleResult, 'analysis' | 'availability'> {
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
		throw new Error('Style analysis unavailable: the provider returned an invalid JSON object');
	const fields = parsed as Record<string, unknown>;
	const analysis: WritingStyleResult['analysis'] = {
		voice: null,
		tone: null,
		sentenceStructure: null,
		vocabularyComplexity: null,
		pacing: null,
		strengths: null,
		improvements: null,
	};
	const unavailableFields: StyleField[] = [];
	const partialFields: StyleField[] = [];
	for (const field of STYLE_SCALARS) {
		const value = fields[field];
		if (typeof value === 'string' && value.trim()) analysis[field] = value;
		else unavailableFields.push(field);
	}
	for (const field of STYLE_LISTS) {
		const value = fields[field];
		if (!Array.isArray(value)) {
			unavailableFields.push(field);
			continue;
		}
		const valid = value.filter(
			(item): item is string => typeof item === 'string' && Boolean(item.trim())
		);
		if (!valid.length && value.length) unavailableFields.push(field);
		else {
			analysis[field] = valid;
			if (valid.length !== value.length) partialFields.push(field);
		}
	}
	return {
		analysis,
		availability: {
			status:
				unavailableFields.length === STYLE_FIELDS.length
					? 'unavailable'
					: unavailableFields.length || partialFields.length
						? 'partial'
						: 'available',
			unavailableFields,
			partialFields,
		},
	};
}
