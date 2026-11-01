import { parseModelJson } from '../../../src/utils/json-parse.js';

test.each(['', '```json\n', 'Provider reply:\n'])(
	'preserves literal fences and brackets inside JSON after %j',
	(prefix) => {
		const value = {
			feedback: 'Keep ```json and ``` verbatim; characters [ { ] } matter.',
			values: [null, 0, false, ''],
		};
		const raw = `${prefix}${JSON.stringify(value)}${prefix ? '\n```' : ''}`;
		expect(parseModelJson(raw)).toEqual(value);
	}
);

test('preserves a valid root array and its positions', () => {
	expect(parseModelJson('```json\n[null,{"feedback":"```"},false]\n```')).toEqual([
		null,
		{ feedback: '```' },
		false,
	]);
});

test.each(['No findings available', '{"feedback":', '{"x":1} {"y":2}', 'null', ''])(
	'reports unavailable JSON without manufacturing a collection: %j',
	(raw) => {
		const warn = jest.fn();
		expect(parseModelJson(raw, { warn })).toBeNull();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('unavailable'), {
			responseCharacters: raw.length,
		});
	}
);
