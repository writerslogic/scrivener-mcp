import type { JsonSchemaType } from '@modelcontextprotocol/server';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { enhanceContentHandler } from '../../../src/handlers/analysis-handlers/content-enhancement.js';
import { createProjectSchemaValidator } from '../../../src/utils/json-schema-validator.js';
import before from '../../fixtures/contracts/enhance-content-output-before-refs.json';
import results from '../../fixtures/contracts/enhance-content-valid-results.json';

const schema = enhanceContentHandler.outputSchema as unknown as JsonSchemaType;

it('retains every pre-ref constraint, annotation, variant and property after local expansion', () => {
	const expanded = JSON.parse(JSON.stringify(schema));
	expect(Object.keys(expanded.$defs)).toEqual(['AnalysisEnvelope']);
	for (const index of [0, 1]) {
		expect(expanded.oneOf[index].properties.envelope).toEqual({
			$ref: '#/$defs/AnalysisEnvelope',
			description: expanded.$defs.AnalysisEnvelope.description,
		});
		expanded.oneOf[index].properties.envelope = {
			...expanded.$defs.AnalysisEnvelope,
			description: expanded.oneOf[index].properties.envelope.description,
		};
	}
	delete expanded.$defs;
	expect(expanded).toEqual(before);
});

describe.each([
	['application draft-07', createProjectSchemaValidator()],
	['SDK default 2020-12', new AjvJsonSchemaValidator()],
] as const)('%s enhancement schema', (_name, provider) => {
	const validate = provider.getValidator(schema);
	const validateBefore = provider.getValidator(before as unknown as JsonSchemaType);

	it.each(['rewrite', 'unavailable', 'spooled'] as const)('accepts the %s variant', (variant) => {
		expect(validate(results[variant]).valid).toBe(true);
		expect(validateBefore(results[variant]).valid).toBe(true);
	});

	it.each(['rewrite', 'unavailable'] as const)(
		'keeps required fields, types, enums and closed objects inside the %s envelope',
		(variant) => {
			const envelope = results[variant].envelope;
			const { sourceRevisions: _revisions, ...missingRevisions } = envelope;
			const invalidEnvelopes = [
				missingRevisions,
				{ ...envelope, sourceRevisions: 'unsupported' },
				{ ...envelope, scope: { ...envelope.scope, kind: 'unsupported' } },
				{ ...envelope, policy: { ...envelope.policy, mutatesManuscript: true } },
				{ ...envelope, engine: { ...envelope.engine, extra: 'unsupported' } },
				{ ...envelope, extra: 'unsupported' },
			];
			for (const invalidEnvelope of invalidEnvelopes) {
				const value = { ...results[variant], envelope: invalidEnvelope };
				expect(validate(value).valid).toBe(false);
				expect(validateBefore(value).valid).toBe(false);
			}
		}
	);

	it.each([
		[0, false],
		[1, true],
		[2, true],
		[11999, true],
		[12000, true],
		[12001, false],
	])('preserves sourceCharacters=%i acceptance=%s', (characters, valid) => {
		const value = structuredClone(results.rewrite);
		value.coverage.sourceCharacters = characters;
		expect(validate(value).valid).toBe(valid);
		expect(validateBefore(value).valid).toBe(valid);
	});
});
