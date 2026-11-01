import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorCode } from '../../../src/core/errors.js';
import { createCrjsonAssessmentExport } from '../../../src/services/content-credentials/crjson-assessment.js';
import { CREDENTIAL_LIMITS } from '../../../src/services/content-credentials/limits.js';
import type { ValidateCredentialResult } from '../../../src/services/content-credentials/types.js';

const time = '2026-10-31T12:00:00Z';
const failure = 'assertion.dataHash.mismatch';
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function manifest(label: string, update: boolean, compressed: boolean) {
	return {
		label,
		isUpdateManifest: update,
		isCompressedManifest: compressed,
		assertions: { 'extras:fixture': { text: 'Résumé — 原文', unchanged: true } },
		'claim.v2': {
			instanceID: 'urn:uuid:00000000-0000-4000-8000-000000000001',
			claim_generator_info: { name: 'serialization-fixture' },
			signature: 'self#jumbf=c2pa.signature',
			created_assertions: [{ url: 'self#jumbf=c2pa.assertions/fixture', hash: "b64'AA==" }],
			gathered_assertions: [],
			redacted_assertions: [],
		},
		signature: {
			algorithm: 'ES256',
			certificateInfo: {
				serialNumber: '1',
				issuer: { CN: 'Serialization fixture issuer' },
				subject: { CN: 'Serialization fixture subject' },
				validity: { notBefore: '2026-01-01T00:00:00Z', notAfter: '2027-01-01T00:00:00Z' },
			},
		},
		validationResults: {
			success: [{ code: 'claimSignature.validated' }],
			informational: [],
			failure: [{ code: failure, explanation: 'Keep this native failure unchanged.' }],
			specVersion: '2.3.0',
			validationTime: time,
		},
		ingredientDeltas: [],
	};
}

function inspection(): ValidateCredentialResult {
	return {
		assetPath: join(tmpdir(), 'serialization-fixture.png'),
		mimeType: 'image/png',
		sourceRevision: 'f'.repeat(64),
		sdkVersion: '0.91.7',
		validationTime: time,
		state: 'invalid',
		integrity: 'invalid',
		trust: 'untrusted',
		trustPolicy: 'configured-roots',
		activeManifest: 'urn:c2pa:active',
		validationCodes: [failure],
		report: { nativeField: ['preserved', false, 42] },
		crjson: {
			'@context': { '@vocab': 'https://c2pa.org/crjson', extras: 'urn:fixture:extras:' },
			jsonGenerator: { name: 'c2pa-rs', version: '0.91.7' },
			manifests: [
				manifest('urn:c2pa:active', true, false),
				manifest('urn:c2pa:parent', false, true),
			],
		},
	};
}

function manifests(input: ValidateCredentialResult): ReturnType<typeof manifest>[] {
	return input.crjson!.manifests as ReturnType<typeof manifest>[];
}

function freeze(value: unknown): void {
	if (value && typeof value === 'object') {
		Object.freeze(value);
		for (const child of Object.values(value)) freeze(child);
	}
}

test('exports from a foreign working directory and binds exact UTF-8 bytes without changing native findings', () => {
	const input = inspection();
	const original = JSON.stringify(input);
	freeze(input);
	const cwd = process.cwd();
	let output: ReturnType<typeof createCrjsonAssessmentExport>;
	try {
		process.chdir(tmpdir());
		output = createCrjsonAssessmentExport(input, '2.4');
	} finally {
		process.chdir(cwd);
	}
	const assessment = JSON.parse(output.assessmentBytes.toString('utf8'));
	const evidence = JSON.parse(output.nativeEvidenceBytes.toString('utf8'));
	const expected = JSON.parse(original).crjson;
	for (const item of expected.manifests) {
		delete item.isUpdateManifest;
		delete item.isCompressedManifest;
	}
	expected.jsonGenerator = {
		name: 'scrivener-mcp',
		version: JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf8')).version,
	};
	expect(assessment).toEqual(expected);
	expect(evidence.inspection).toEqual(input);
	expect(evidence.formalConformance).toBe('not-assessed');
	expect(evidence.export).toMatchObject({
		specificationVersion: '2.4',
		schemaSha256: '22c824f17353515c089667306fd7e49e2753201d37a9e73631bd36c2ffc848d9',
		assessmentSha256: digest(output.assessmentBytes),
		assessmentBytes: output.assessmentBytes.length,
		sourceRevision: input.sourceRevision,
		sdkVersion: input.sdkVersion,
		validationTime: time,
		removedManifestFields: ['isUpdateManifest', 'isCompressedManifest'],
	});
	expect(evidence.inspection.crjson.manifests[0].isUpdateManifest).toBe(true);
	expect(evidence.inspection.crjson.manifests[1].isCompressedManifest).toBe(true);
	expect(output.assessmentBytes.toString('utf8')).toContain('Résumé — 原文');
	expect(output.assessmentBytes[output.assessmentBytes.length - 1]).toBe(10);
	expect(JSON.stringify(input)).toBe(original);
	expect(createCrjsonAssessmentExport(input, '2.4')).toEqual(output);
});

test.each(['2.3', '2.5', '', undefined])(
	'rejects unrequested or unsupported target version %p',
	(version) => {
		expect(() => createCrjsonAssessmentExport(inspection(), version as '2.4')).toThrow(
			expect.objectContaining({ code: ErrorCode.UNSUPPORTED_OPERATION })
		);
	}
);

test.each(['0.91.6', '0.91.8', 'malformed'])(
	'rejects unverified native serializer version %p',
	(version) => {
		const input = inspection();
		input.sdkVersion = version;
		expect(() => createCrjsonAssessmentExport(input, '2.4')).toThrow(
			expect.objectContaining({ code: ErrorCode.UNSUPPORTED_OPERATION })
		);
	}
);

test.each([
	['sourceRevision', 'invalid'],
	['validationTime', '2026-02-30T12:00:00Z'],
	['validationTime', '2026-10-31'],
	['mimeType', ''],
] as const)('rejects malformed assessment identity %s', (key, value) => {
	const input = { ...inspection(), [key]: value };
	expect(() => createCrjsonAssessmentExport(input, '2.4')).toThrow(
		expect.objectContaining({ code: ErrorCode.INVALID_INPUT })
	);
});

test.each([
	[
		'unknown manifest field',
		(item: Record<string, unknown>): void => {
			item.futureField = true;
		},
	],
	[
		'missing update flag',
		(item: Record<string, unknown>): void => {
			delete item.isUpdateManifest;
		},
	],
	[
		'string compressed flag',
		(item: Record<string, unknown>): void => {
			item.isCompressedManifest = 'false';
		},
	],
	[
		'numeric update flag',
		(item: Record<string, unknown>): void => {
			item.isUpdateManifest = 0;
		},
	],
	[
		'missing signature',
		(item: Record<string, unknown>): void => {
			delete item.signature;
		},
	],
	[
		'wrong assertion type',
		(item: Record<string, unknown>): void => {
			item.assertions = [];
		},
	],
] as const)('rejects unsupported native shape: %s', (_name, change) => {
	const input = inspection();
	change(manifests(input)[0]);
	const before = JSON.stringify(input);
	expect(() => createCrjsonAssessmentExport(input, '2.4')).toThrow(
		expect.objectContaining({ code: ErrorCode.INVALID_FORMAT })
	);
	expect(JSON.stringify(input)).toBe(before);
});

test('rejects duplicate labels and conflicting generator identity', () => {
	const input = inspection();
	manifests(input)[1].label = manifests(input)[0].label;
	expect(() => createCrjsonAssessmentExport(input, '2.4')).toThrow(/manifest shape/);
	for (const generator of [
		{ name: 'another-generator', version: '0.91.7' },
		{ name: 'c2pa-rs', version: '0.91.6' },
		{ name: 'c2pa-rs', version: '0.91.7', futureField: true },
	]) {
		const next = inspection();
		next.crjson!.jsonGenerator = generator;
		expect(() => createCrjsonAssessmentExport(next, '2.4')).toThrow(/serializer identity/);
	}
});

test('enforces nested schema constraints and date-time formats without leaking native content', () => {
	const input = inspection();
	manifests(input)[0].signature.certificateInfo.validity.notAfter = 'private-invalid-date';
	expect(() => createCrjsonAssessmentExport(input, '2.4')).toThrow(
		'The native crJSON cannot be represented by the pinned C2PA 2.4 schema.'
	);
	const next = inspection();
	manifests(next)[0]['claim.v2'].created_assertions = [];
	expect(() => createCrjsonAssessmentExport(next, '2.4')).toThrow(/pinned C2PA 2.4 schema/);
});

test('preserves a v1 claim and rejects ambiguous v1/v2 claims', () => {
	const input = inspection();
	const native = manifests(input)[0] as Record<string, unknown>;
	native.claim = {
		claim_generator: 'serialization-fixture/1.0',
		claim_generator_info: [{ name: 'serialization-fixture' }],
		signature: 'self#jumbf=c2pa.signature',
		assertions: [{ url: 'self#jumbf=c2pa.assertions/fixture', hash: "b64'AA==" }],
		'dc:format': 'image/png',
		instanceID: 'urn:uuid:00000000-0000-4000-8000-000000000002',
		redacted_assertions: [],
	};
	expect(() => createCrjsonAssessmentExport(input, '2.4')).toThrow(/pinned C2PA 2.4 schema/);
	delete native['claim.v2'];
	const { assessmentBytes, nativeEvidenceBytes } = createCrjsonAssessmentExport(input, '2.4');
	expect(JSON.parse(assessmentBytes.toString()).manifests[0].claim).toEqual(native.claim);
	expect(JSON.parse(nativeEvidenceBytes.toString()).inspection).toEqual(input);
});

test('retains an unsigned inspection with no fabricated manifests or validation success', () => {
	const input = inspection();
	input.state = 'unsigned';
	input.integrity = 'not-evaluated';
	input.trust = 'not-evaluated';
	input.validationCodes = [];
	input.report = null;
	input.crjson!.manifests = [];
	delete input.activeManifest;
	const output = createCrjsonAssessmentExport(input, '2.4');
	expect(JSON.parse(output.assessmentBytes.toString()).manifests).toEqual([]);
	expect(JSON.parse(output.nativeEvidenceBytes.toString()).inspection).toEqual(input);
});

test.each([4095, 4096, 4097])('bounds manifest labels at %i characters', (length) => {
	const input = inspection();
	manifests(input)[0].label = 'x'.repeat(length);
	if (length <= 4096)
		expect(
			JSON.parse(createCrjsonAssessmentExport(input, '2.4').assessmentBytes.toString())
				.manifests[0].label
		).toHaveLength(length);
	else expect(() => createCrjsonAssessmentExport(input, '2.4')).toThrow(/manifest shape/);
});

test.each([65, 66, 67])('bounds sidecar depth at %i including its two wrappers', (depth) => {
	const input = inspection();
	let report: Record<string, unknown> = { value: 'preserved' };
	for (let level = 3; level < depth; level++) report = { child: report };
	input.report = report;
	if (depth <= 66)
		expect(
			JSON.parse(createCrjsonAssessmentExport(input, '2.4').nativeEvidenceBytes.toString())
				.inspection.report
		).toEqual(report);
	else
		expect(() => createCrjsonAssessmentExport(input, '2.4')).toThrow(
			expect.objectContaining({ code: ErrorCode.RESOURCE_EXHAUSTED })
		);
});

test.each([undefined, NaN, Infinity, BigInt(1), new Date(time)])(
	'rejects non-JSON native data instead of silently rewriting %p',
	(value) => {
		const input = inspection();
		input.report!.unsupported = value;
		expect(() => createCrjsonAssessmentExport(input, '2.4')).toThrow(/lossless JSON/);
	}
);

test('rejects cycles and accessor properties without invoking them', () => {
	const input = inspection();
	input.report!.cycle = input.report;
	expect(() => createCrjsonAssessmentExport(input, '2.4')).toThrow(/lossless JSON/);
	const next = inspection();
	const getter = jest.fn(() => 'changed');
	Object.defineProperty(next.report!, 'accessor', { get: getter, enumerable: true });
	expect(() => createCrjsonAssessmentExport(next, '2.4')).toThrow(/lossless JSON/);
	expect(getter).not.toHaveBeenCalled();
});

test.each([-1, 0, 1])('bounds exact assessment UTF-8 bytes at limit offset %i', (offset) => {
	const input = inspection();
	input.crjson!.padding = 'é';
	const size = createCrjsonAssessmentExport(input, '2.4').assessmentBytes.length;
	input.crjson!.padding = 'é' + 'x'.repeat(CREDENTIAL_LIMITS.manifestBytes - size + offset);
	if (offset <= 0)
		expect(createCrjsonAssessmentExport(input, '2.4').assessmentBytes.length).toBe(
			CREDENTIAL_LIMITS.manifestBytes + offset
		);
	else
		expect(() => createCrjsonAssessmentExport(input, '2.4')).toThrow(
			expect.objectContaining({ code: ErrorCode.RESOURCE_EXHAUSTED })
		);
});

test.each([-1, 0, 1])('bounds complete native evidence bytes at limit offset %i', (offset) => {
	const input = inspection();
	input.report!.padding = '';
	const size = createCrjsonAssessmentExport(input, '2.4').nativeEvidenceBytes.length;
	const maximum = CREDENTIAL_LIMITS.manifestBytes * 2 + 256 * 1024;
	input.report!.padding = 'x'.repeat(maximum - size + offset);
	if (offset <= 0)
		expect(createCrjsonAssessmentExport(input, '2.4').nativeEvidenceBytes.length).toBe(
			maximum + offset
		);
	else
		expect(() => createCrjsonAssessmentExport(input, '2.4')).toThrow(
			expect.objectContaining({ code: ErrorCode.RESOURCE_EXHAUSTED })
		);
});
