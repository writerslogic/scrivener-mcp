import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats, { type FormatsPlugin } from 'ajv-formats';
import { createError, ErrorCode } from '../../core/errors.js';
import { CREDENTIAL_LIMITS } from './limits.js';
import { crjsonAssessmentSchemaPath } from './crjson-assessment-assets.cjs';
import { credentialProductVersion } from './worker-path.cjs';
import type { ValidateCredentialResult } from './types.js';

const SCHEMA_SHA256 = '22c824f17353515c089667306fd7e49e2753201d37a9e73631bd36c2ffc848d9';
const NATIVE_EVIDENCE_BYTES = CREDENTIAL_LIMITS.manifestBytes * 2 + 256 * 1024;
// Each native report permits depth 64 and 250,000 nodes; the sidecar adds two wrappers and metadata.
const EVIDENCE_DEPTH = 64 + 2;
const EVIDENCE_NODES = 2 * 250_000 + 4096;
const MANIFEST_FIELDS = new Set([
	'label',
	'assertions',
	'claim',
	'claim.v2',
	'signature',
	'validationResults',
	'ingredientDeltas',
	'isUpdateManifest',
	'isCompressedManifest',
]);
let validators: { document: ValidateFunction; identity: ValidateFunction } | undefined;

const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value);

function fail(code: ErrorCode, message: string): never {
	throw createError(code, undefined, message);
}

function schemaValidators(): NonNullable<typeof validators> {
	if (validators) return validators;
	try {
		const bytes = readFileSync(crjsonAssessmentSchemaPath());
		if (bytes.length !== 75699 || hash(bytes) !== SCHEMA_SHA256) throw new Error();
		const ajv = new Ajv2020({
			strict: false,
			validateSchema: true,
			validateFormats: true,
			allErrors: false,
			coerceTypes: false,
			useDefaults: false,
			removeAdditional: false,
		});
		(addFormats as unknown as FormatsPlugin)(ajv);
		validators = {
			document: ajv.compile(JSON.parse(bytes.toString('utf8'))),
			identity: ajv.compile({
				type: 'object',
				required: ['assetPath', 'mimeType', 'sourceRevision', 'validationTime', 'report'],
				properties: {
					assetPath: { type: 'string', minLength: 1, maxLength: 4096 },
					mimeType: { type: 'string', minLength: 1, maxLength: 127 },
					sourceRevision: { type: 'string', pattern: '^[a-f0-9]{64}$' },
					validationTime: { type: 'string', maxLength: 64, format: 'date-time' },
					report: { type: ['object', 'null'] },
				},
			}),
		};
		return validators;
	} catch {
		return fail(
			ErrorCode.DEPENDENCY_ERROR,
			'The pinned C2PA 2.4 schema is unavailable or invalid.'
		);
	}
}

function boundedJson(value: unknown, maximum: number): void {
	let bytes = 1;
	let nodes = 0;
	const ancestors = new Set<object>();
	function invalid(): never {
		fail(ErrorCode.INVALID_FORMAT, 'Assessment evidence must contain only lossless JSON data.');
	}
	function limit(): never {
		fail(ErrorCode.RESOURCE_EXHAUSTED, 'Assessment evidence exceeds its supported bounds.');
	}
	const stringBytes = (text: string): number => {
		if (Buffer.byteLength(text) > maximum) limit();
		return Buffer.byteLength(JSON.stringify(text));
	};
	const visit = (item: unknown, depth: number): void => {
		if (depth > EVIDENCE_DEPTH || ++nodes > EVIDENCE_NODES) limit();
		if (typeof item === 'string') bytes += stringBytes(item);
		else if (item === null || typeof item === 'boolean') bytes += String(item).length;
		else if (typeof item === 'number' && Number.isFinite(item))
			bytes += JSON.stringify(item).length;
		else if (typeof item === 'object') {
			const array = Array.isArray(item);
			const prototype = Object.getPrototypeOf(item);
			if (
				ancestors.has(item) ||
				(array
					? prototype !== Array.prototype
					: prototype !== Object.prototype && prototype !== null)
			)
				invalid();
			const keys = Object.keys(item);
			if (keys.length > EVIDENCE_NODES - nodes) limit();
			if (
				Reflect.ownKeys(item).length !== keys.length + Number(array) ||
				(array && keys.length !== item.length)
			)
				invalid();
			ancestors.add(item);
			bytes += 2 + Math.max(0, keys.length - 1);
			for (const [index, key] of keys.entries()) {
				const descriptor = Object.getOwnPropertyDescriptor(item, key);
				if (!descriptor || !('value' in descriptor) || (array && key !== String(index)))
					invalid();
				if (!array) bytes += stringBytes(key) + 1;
				if (bytes > maximum) limit();
				visit(descriptor.value, depth + 1);
			}
			ancestors.delete(item);
		} else invalid();
		if (bytes > maximum) limit();
	};
	visit(value, 0);
}

function serialize(value: unknown, maximum: number): Buffer {
	boundedJson(value, maximum);
	return Buffer.from(`${JSON.stringify(value)}\n`);
}

export interface CrjsonAssessmentExport {
	assessmentBytes: Buffer;
	nativeEvidenceBytes: Buffer;
}

export function createCrjsonAssessmentExport(
	inspection: ValidateCredentialResult,
	version: '2.4'
): CrjsonAssessmentExport {
	if (version !== '2.4')
		fail(
			ErrorCode.UNSUPPORTED_OPERATION,
			'Only the pinned C2PA 2.4 assessment export is supported.'
		);
	boundedJson(inspection, NATIVE_EVIDENCE_BYTES);
	if (!record(inspection) || inspection.sdkVersion !== '0.91.7')
		fail(
			ErrorCode.UNSUPPORTED_OPERATION,
			'The native SDK version is unsupported by this assessment export.'
		);
	const { document, identity } = schemaValidators();
	if (!identity(inspection))
		fail(
			ErrorCode.INVALID_INPUT,
			'Assessment export requires the original source revision and assessment identity.'
		);
	const native = inspection.crjson;
	if (
		!record(native) ||
		!Array.isArray(native.manifests) ||
		!record(native.jsonGenerator) ||
		native.jsonGenerator.name !== 'c2pa-rs' ||
		native.jsonGenerator.version !== inspection.sdkVersion ||
		Object.keys(native.jsonGenerator).some((key) => key !== 'name' && key !== 'version')
	)
		fail(
			ErrorCode.INVALID_FORMAT,
			'The native crJSON serializer identity or manifest list is unsupported.'
		);
	const labels = new Set<string>();
	const manifests = native.manifests.map((manifest: unknown) => {
		if (
			!record(manifest) ||
			typeof manifest.label !== 'string' ||
			manifest.label.length === 0 ||
			manifest.label.length > 4096 ||
			labels.has(manifest.label) ||
			typeof manifest.isUpdateManifest !== 'boolean' ||
			typeof manifest.isCompressedManifest !== 'boolean' ||
			Object.keys(manifest).some((key) => !MANIFEST_FIELDS.has(key))
		)
			fail(ErrorCode.INVALID_FORMAT, 'The native crJSON manifest shape is unsupported.');
		labels.add(manifest.label);
		const {
			isUpdateManifest: _update,
			isCompressedManifest: _compressed,
			...projected
		} = manifest;
		return projected;
	});
	const generator = { name: 'scrivener-mcp', version: credentialProductVersion() };
	const assessment = { ...native, manifests, jsonGenerator: generator };
	if (!document(assessment))
		fail(
			ErrorCode.INVALID_FORMAT,
			'The native crJSON cannot be represented by the pinned C2PA 2.4 schema.'
		);
	const assessmentBytes = serialize(assessment, CREDENTIAL_LIMITS.manifestBytes);
	const nativeEvidenceBytes = serialize(
		{
			evidenceVersion: 1,
			formalConformance: 'not-assessed',
			export: {
				format: 'c2pa-crjson',
				specificationVersion: version,
				schemaSha256: SCHEMA_SHA256,
				generator,
				sourceRevision: inspection.sourceRevision,
				sdkVersion: inspection.sdkVersion,
				validationTime: inspection.validationTime,
				assessmentBytes: assessmentBytes.length,
				assessmentSha256: hash(assessmentBytes),
				removedManifestFields: ['isUpdateManifest', 'isCompressedManifest'],
			},
			inspection,
		},
		NATIVE_EVIDENCE_BYTES
	);
	return { assessmentBytes, nativeEvidenceBytes };
}
