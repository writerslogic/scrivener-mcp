import { join } from 'node:path';

export function crjsonAssessmentSchemaPath(): string {
	return join(__dirname, '../../../assets/c2pa-crjson-2.4/crJSON.schema.json');
}
