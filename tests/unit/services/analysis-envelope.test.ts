import { analysisEnvelope } from '../../../src/services/editorial/analysis-envelope.js';
import { ANALYSIS_ENVELOPE_SCHEMA } from '../../../src/handlers/shared-schemas.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';

test('represents context-free provider work without inventing a project identity', () => {
	const envelope = analysisEnvelope(
		null,
		'document',
		[],
		{},
		'provider',
		{ prompt: 'A scene.' },
		'supplied-text'
	);
	expect(envelope.projectId).toBeNull();
	expect(envelope.sourceRevisions).toEqual([]);
	expect(envelope.policy.revisionChecked).toBe(false);
	expect(
		new AjvJsonSchemaValidator().getValidator(ANALYSIS_ENVELOPE_SCHEMA)(envelope).valid
	).toBe(true);
});

test('distinguishes supplied text hashes from saved RTF revisions and binds request identity to the distinction', () => {
	const documents = [{ documentId: 'scene', revision: 'a'.repeat(64) }];
	const saved = analysisEnvelope('project', 'document', documents, {}, 'raw', {
		includeEntities: false,
	});
	const supplied = analysisEnvelope(
		'project',
		'document',
		documents,
		{},
		'raw',
		{ includeEntities: false },
		'supplied-text'
	);
	expect(saved.sourceFormat).toBe('saved-rtf');
	expect(supplied.sourceFormat).toBe('supplied-text');
	expect(supplied.requestId).not.toBe(saved.requestId);
	expect(supplied.policy.revisionChecked).toBe(false);
	const validate = new AjvJsonSchemaValidator().getValidator(ANALYSIS_ENVELOPE_SCHEMA);
	for (const envelope of [saved, supplied]) expect(validate(envelope).valid).toBe(true);
	expect(validate({ ...supplied, sourceFormat: 'unknown' }).valid).toBe(false);
});

test('identifies application-owned local evidence without claiming native analysis or provider access', () => {
	const local = analysisEnvelope(
		'project',
		'manuscript',
		[{ documentId: 'scene', revision: 'saved' }],
		{},
		'local',
		{ operation: 'discover_connections', graphRevision: 'graph' }
	);
	expect(local.engine).toMatchObject({ name: 'scrivener-mcp', version: null });
	expect(local.policy).toMatchObject({
		mode: 'local',
		usesSavedProjectControls: false,
		providerAccess: false,
		allowsRawNativeAnalysis: false,
		revisionChecked: false,
	});
	expect(new AjvJsonSchemaValidator().getValidator(ANALYSIS_ENVELOPE_SCHEMA)(local).valid).toBe(
		true
	);
	const changed = analysisEnvelope(
		'project',
		'manuscript',
		[{ documentId: 'scene', revision: 'saved' }],
		{},
		'local',
		{ operation: 'discover_connections', graphRevision: 'changed' }
	);
	expect(changed.requestId).not.toBe(local.requestId);
	expect(changed.engine.configurationHash).not.toBe(local.engine.configurationHash);
});
