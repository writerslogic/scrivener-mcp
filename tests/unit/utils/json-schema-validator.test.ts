import { Ajv } from 'ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/server';
import { createProjectSchemaValidator } from '../../../src/utils/json-schema-validator.js';

test('uses the direct AJV engine and preserves draft-07 tuple validation', () => {
	const provider = createProjectSchemaValidator();
	const schema = {
		type: 'array',
		minItems: 2,
		items: [{ type: 'integer' }, { type: 'string' }],
		additionalItems: false,
	};
	const compile = jest.spyOn(Ajv.prototype, 'compile');
	try {
		const validate = provider.getValidator(schema as unknown as JsonSchemaType);
		expect(compile).toHaveBeenCalledWith(schema);
		expect(validate([1]).valid).toBe(false);
		expect(validate([1, 'chapter']).valid).toBe(true);
		expect(validate([1, 'chapter', 'extra']).valid).toBe(false);
		expect(validate(['1', 'chapter'])).toMatchObject({
			valid: false,
			errorMessage: expect.stringContaining('must be integer'),
		});
	} finally {
		compile.mockRestore();
	}
});

test('validates formats and returns all errors without rewriting input data', () => {
	const validate = createProjectSchemaValidator().getValidator({
		type: 'object',
		additionalProperties: false,
		properties: {
			address: { type: 'string', format: 'email' },
			created: { type: 'string', format: 'date-time' },
			count: { type: 'integer', default: 1 },
		},
		required: ['address', 'created', 'count'],
	});
	const value = { address: 'invalid', created: 'invalid', extra: true };
	const before = structuredClone(value);
	const result = validate(value);
	expect(result.valid).toBe(false);
	expect(result.data).toBeUndefined();
	for (const detail of ['email', 'date-time', 'count', 'additional properties'])
		expect(result.errorMessage).toContain(detail);
	expect(value).toEqual(before);
	expect(
		validate({ address: 'writer@example.test', created: '2026-11-02T12:00:00Z', count: 1 })
			.valid
	).toBe(true);
});

test('propagates schema compilation errors and does not enable runtime data references', () => {
	const provider = createProjectSchemaValidator();
	expect(() => provider.getValidator({ $ref: 'https://example.test/missing-schema' })).toThrow(
		/can't resolve reference/
	);
	expect(() =>
		provider.getValidator({
			type: 'string',
			format: { $data: '/format' },
		} as unknown as JsonSchemaType)
	).toThrow(/format value must be/);
});
