import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const gate = pathToFileURL(resolve(__dirname, '../../../scripts/check-tool-registry.mjs')).href;

async function inspect(outputSchema: object | null, name = 'generate_content') {
	const tool = {
		name,
		title: 'Generate Content',
		description: 'Generate text with explicit source provenance and measured result coverage.',
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		inputSchema: { type: 'object', properties: {} },
		...(outputSchema ? { outputSchema } : {}),
	};
	const { stdout } = await execute(process.execPath, [
		'--input-type=module',
		'-e',
		`import { inspectToolRegistry } from ${JSON.stringify(gate)};
process.stdout.write(JSON.stringify(inspectToolRegistry(${JSON.stringify([tool])})));`,
	]);
	return JSON.parse(stdout) as { problems: string[]; dataCount: number };
}

describe('tool registry schema metadata gate', () => {
	it('accepts documented union outputs and requires them for structured tools', async () => {
		const schema = {
			type: 'object',
			oneOf: [
				{ properties: { result: { type: 'string', description: 'Generated text.' } } },
				{
					properties: {
						_ref: { type: 'string', description: 'Stored result identity.' },
					},
				},
			],
		};
		for (const name of [
			'generate_content',
			'enhance_content',
			'remember',
			'suggest_improvements',
			'generate_marketing_materials',
			'add_relationship',
		]) {
			expect(await inspect(schema, name)).toMatchObject({ problems: [], dataCount: 1 });
			expect((await inspect(null, name)).problems).toContain(
				`${name}: data tool missing outputSchema`
			);
		}
	});

	it('finds undocumented fields nested in union branches, arrays, maps and definitions', async () => {
		const leaf = { properties: { evidence: { type: 'string' } } };
		const result = await inspect({
			type: 'object',
			oneOf: [{ anyOf: [{ allOf: [{ items: leaf }] }] }],
			additionalProperties: leaf,
			$defs: { Entry: leaf },
			definitions: { LegacyEntry: leaf },
		});
		expect(result.problems).toEqual([
			'generate_content.outputSchema{}.evidence: undescribed',
			'generate_content.outputSchema.oneOf[0].anyOf[0].allOf[0][].evidence: undescribed',
			'generate_content.outputSchema.$defs.Entry.evidence: undescribed',
			'generate_content.outputSchema.definitions.LegacyEntry.evidence: undescribed',
		]);
	});

	it('rejects empty property shells and blank descriptions inside otherwise explicit unions', async () => {
		const result = await inspect({
			type: 'object',
			properties: {},
			oneOf: [{ properties: { value: { type: 'string', description: ' ' } } }],
		});
		expect(result.problems).toEqual([
			'generate_content.outputSchema: empty properties',
			'generate_content.outputSchema.oneOf[0].value: undescribed',
		]);
	});

	it('preserves the explicit text-only tool contract', async () => {
		expect(await inspect(null, 'read_document')).toMatchObject({ problems: [], dataCount: 0 });
		expect((await inspect({ type: 'object' }, 'read_document')).problems).toContain(
			'read_document: text-only tool unexpectedly declares outputSchema'
		);
	});
});
