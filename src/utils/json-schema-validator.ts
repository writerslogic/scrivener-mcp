import { Ajv } from 'ajv';
import addFormats, { type FormatsPlugin } from 'ajv-formats';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';

export function createProjectSchemaValidator(): AjvJsonSchemaValidator {
	// Application schemas retain draft-07 semantics and the project's pinned AJV engine.
	const ajv = new Ajv({
		strict: false,
		validateFormats: true,
		validateSchema: false,
		allErrors: true,
	});
	(addFormats as unknown as FormatsPlugin)(ajv);
	return new AjvJsonSchemaValidator(ajv);
}
