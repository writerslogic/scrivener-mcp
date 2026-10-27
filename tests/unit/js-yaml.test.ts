import { createRequire } from 'node:module';

const { safeLoad } = createRequire(__filename)('js-yaml') as {
	safeLoad: (source: string, options?: { maxTotalMergeKeys: number }) => unknown;
};

function emptyMerges(sources: number, targets = 1): string {
	return `sources: &sources [${Array(sources).fill('{}').join(',')}]\ntargets:\n${'  - <<: *sources\n'.repeat(
		targets
	)}`;
}

describe('js-yaml empty merge sources', () => {
	it.each([3, 4])('accepts %i empty sources within the merge limit', (sources) => {
		expect(safeLoad(emptyMerges(sources), { maxTotalMergeKeys: 4 })).toEqual({
			sources: Array(sources).fill({}),
			targets: [{}],
		});
	});

	it('rejects empty sources above the merge limit', () => {
		expect(() => safeLoad(emptyMerges(5), { maxTotalMergeKeys: 4 })).toThrow(
			'merge keys exceeded maxTotalMergeKeys (4)'
		);
	});

	it('counts empty sources across repeated merge targets', () => {
		expect(() => safeLoad(emptyMerges(2, 3), { maxTotalMergeKeys: 4 })).toThrow(
			'merge keys exceeded maxTotalMergeKeys (4)'
		);
	});

	it('bounds repeated empty merges with the default limit', () => {
		expect(() => safeLoad(emptyMerges(100, 101))).toThrow(
			'merge keys exceeded maxTotalMergeKeys (10000)'
		);
	});
});
