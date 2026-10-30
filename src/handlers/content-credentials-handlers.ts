import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import {
	getCredentialCapabilities,
	signCredentialAsset,
	validateCredentialAsset,
} from '../services/content-credentials/service.js';
import type { CredentialValidation } from '../services/content-credentials/types.js';
import type { ToolDefinition, ToolSchema } from './types.js';

const localPath = z
	.string()
	.min(1)
	.max(4096)
	.refine((value) => isAbsolute(value) && !value.includes('\0'), {
		message: 'Use an absolute local file path without NUL characters.',
	});
const mimePattern = /^[\w!#$%&'*+.^`|~-]+\/[\w!#$%&'*+.^`|~-]+$/;
const mimeType = z.string().min(3).max(255).regex(mimePattern);
const reportInput = z.boolean().default(false);
const capabilitiesInput = z.object({}).strict();
const signInput = z
	.object({
		assetPath: localPath,
		outputPath: localPath,
		mimeType: mimeType.optional(),
		mode: z.enum(['embedded', 'sidecar']).default('embedded'),
		title: z.string().max(500).optional(),
		sourceManifestPath: localPath.optional(),
		preserveInvalidSource: z.boolean().optional(),
		includeReport: reportInput,
	})
	.strict()
	.refine((request) => resolve(request.assetPath) !== resolve(request.outputPath), {
		path: ['outputPath'],
		message: 'outputPath must name a different file from assetPath.',
	});
const validateInput = z
	.object({
		assetPath: localPath,
		mimeType: mimeType.optional(),
		manifestPath: localPath.optional(),
		includeCrjson: z.boolean().optional(),
		includeReport: reportInput,
	})
	.strict();

const pathProperty = {
	type: 'string',
	minLength: 1,
	maxLength: 4096,
	description: 'Absolute path to a local asset file; URLs and NUL characters are rejected.',
};
const mimeProperty = {
	type: 'string',
	minLength: 3,
	maxLength: 255,
	pattern: mimePattern.source,
	description: 'Optional MIME media type without parameters; otherwise inferred by the service.',
};
const reportProperty = {
	type: 'boolean',
	default: false,
	description: 'Include the potentially large raw SDK validation report; default false.',
};
const crjsonProperty = {
	type: 'boolean',
	default: false,
	description: 'Include genuine SDK crJSON; potentially large and omitted by default.',
};
const validationProperties: ToolSchema['properties'] = {
	state: {
		type: 'string',
		enum: ['valid', 'invalid', 'unsigned', 'untrusted'],
		description:
			'Normalized credential result; signature integrity and signer trust are separate.',
	},
	integrity: {
		type: 'string',
		enum: ['valid', 'invalid', 'not-evaluated'],
		description: 'Whether the asset and credential signature passed integrity checks.',
	},
	activeIntegrity: {
		type: 'string',
		enum: ['valid', 'invalid', 'not-evaluated'],
		description:
			'Integrity of the active manifest alone; historical ingredient failures remain in the overall result.',
	},
	trust: {
		type: 'string',
		enum: ['trusted', 'untrusted', 'not-evaluated'],
		description: 'Signer trust under the server administrator’s configured trust policy.',
	},
	trustPolicy: {
		type: 'string',
		enum: ['configured-roots', 'none'],
		description: 'Whether administrator-configured trust roots were available for validation.',
	},
	activeManifest: {
		type: 'string',
		description: 'Active manifest identifier reported by the SDK, when present.',
	},
	validationCodes: {
		type: 'array',
		items: { type: 'string', description: 'An SDK validation status code.' },
		description: 'SDK validation codes supporting the normalized integrity and trust results.',
	},
	sourceValidationCodes: {
		type: 'array',
		maxItems: 1024,
		items: {
			type: 'string',
			description: 'A source validation code recorded in the signed failure disclosure.',
		},
		description:
			'Recorded source failures and evidence, distinct from current-manifest validation. A valid new signature does not repair the source history.',
	},
	report: {
		type: ['object', 'null'],
		additionalProperties: true,
		description: 'Raw SDK report, returned only when includeReport is explicitly true.',
	},
	crjson: {
		type: 'object',
		additionalProperties: true,
		description: 'Actual SDK crJSON, returned only when includeCrjson is explicitly true.',
	},
	validationTime: {
		type: 'string',
		maxLength: 64,
		description: 'Administrator assessment time, when a privileged assessment policy was used.',
	},
};
const validationRequired = ['state', 'integrity', 'trust', 'trustPolicy', 'validationCodes'];
const validationSchema = {
	type: 'object',
	additionalProperties: false,
	properties: validationProperties,
	required: validationRequired,
	description: 'Normalized validation with an optional raw SDK report.',
};
const revisionProperties = {
	assetPath: pathProperty,
	mimeType: { ...mimeProperty, description: 'MIME type used for the asset operation.' },
	sourceRevision: {
		type: 'string',
		pattern: '^[a-f0-9]{64}$',
		description: 'SHA-256 revision of the source asset bytes processed by the service.',
	},
	sdkVersion: { type: 'string', description: 'Actual SDK version used for this operation.' },
};

function validationResult<T extends CredentialValidation>(
	result: T,
	includeReport: boolean,
	includeCrjson = false
): Omit<T, 'report' | 'crjson'> & {
	report?: CredentialValidation['report'];
	crjson?: Record<string, unknown>;
} {
	const { report, crjson, ...summary } = result;
	return {
		...summary,
		...(includeReport ? { report } : {}),
		...(includeCrjson && crjson ? { crjson } : {}),
	};
}

const capabilitiesOutput: ToolSchema = {
	type: 'object',
	additionalProperties: false,
	properties: {
		available: { type: 'boolean', description: 'Whether the installed SDK actually loads.' },
		sdkVersion: {
			type: ['string', 'null'],
			description: 'Installed SDK version, or null when unavailable.',
		},
		unavailableReason: {
			type: 'string',
			description: 'Public diagnostic explaining SDK unavailability, when applicable.',
		},
		formats: {
			type: 'array',
			description: 'Declared format coverage and explicit per-format limitations.',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					mimeType: { type: 'string', description: 'MIME type identifying this format.' },
					extensions: {
						type: 'array',
						items: { type: 'string', description: 'A recognized file extension.' },
						description: 'File extensions recognized for MIME inference.',
					},
					category: {
						type: 'string',
						enum: [
							'image',
							'video',
							'audio',
							'document',
							'text',
							'font',
							'model',
							'other',
						],
						description: 'Media family containing this format.',
					},
					embedded: {
						type: 'string',
						enum: ['supported', 'unsupported', 'experimental'],
						description: 'SDK coverage for embedding a manifest in the asset.',
					},
					sidecar: {
						type: 'boolean',
						description: 'Whether a detached manifest is supported for this format.',
					},
					notes: { type: 'string', description: 'Coverage limitations for this format.' },
					preparation: {
						type: 'string',
						enum: ['zip-store'],
						description:
							'Unsigned archives are repackaged to STORE without changing entry payloads; the original source remains unchanged.',
					},
				},
				required: ['mimeType', 'extensions', 'category', 'embedded', 'sidecar'],
			},
		},
		modes: {
			type: 'array',
			items: {
				type: 'string',
				enum: ['embedded', 'sidecar'],
				description: 'An available credential storage mode.',
			},
			description: 'Credential storage modes offered by the service.',
		},
		compressedManifests: {
			type: 'object',
			additionalProperties: false,
			properties: {
				generation: {
					type: 'boolean',
					description: 'Compressed manifest generation support.',
				},
				validation: {
					type: 'boolean',
					description: 'Compressed manifest validation support.',
				},
			},
			required: ['generation', 'validation'],
			description: 'Explicit SDK support for generating and reading compressed manifests.',
		},
		signerConfigured: {
			type: 'boolean',
			description:
				'Whether administrator signing configuration is present; never reveals it.',
		},
		conformance: {
			type: 'object',
			additionalProperties: false,
			properties: {
				status: {
					type: 'string',
					enum: ['not-assessed'],
					description: 'Official C2PA conformance has not been assessed.',
				},
				maxAssuranceLevel: {
					type: 'null',
					description: 'No official assurance level is claimed.',
				},
				implementationClass: {
					type: 'string',
					enum: ['edge'],
					description: 'Local edge integration rather than a remote signing service.',
				},
				attestationMethods: {
					type: 'array',
					maxItems: 0,
					items: { type: 'string', description: 'An assessed attestation method.' },
					description:
						'Empty: no assessed attestation methods or human-authorship claims.',
				},
			},
			required: ['status', 'maxAssuranceLevel', 'implementationClass', 'attestationMethods'],
			description: 'Explicit limits on conformance and assurance claims.',
		},
		limits: {
			type: 'object',
			additionalProperties: false,
			properties: {
				assetBytes: {
					type: 'integer',
					minimum: 1,
					description: 'Maximum source asset bytes.',
				},
				manifestBytes: {
					type: 'integer',
					minimum: 1,
					description: 'Maximum detached manifest bytes.',
				},
				timeoutMs: {
					type: 'integer',
					minimum: 1,
					description: 'Maximum isolated native operation duration in milliseconds.',
				},
			},
			required: ['assetBytes', 'manifestBytes', 'timeoutMs'],
			description: 'Enforced service allocation and operation limits.',
		},
	},
	required: [
		'available',
		'sdkVersion',
		'formats',
		'modes',
		'compressedManifests',
		'signerConfigured',
		'conformance',
		'limits',
	],
};

export const contentCredentialsHandlers: ToolDefinition[] = [
	{
		name: 'c2pa_capabilities',
		title: 'Inspect Local Content Credentials Capabilities',
		description:
			'Report actual local C2PA SDK availability, format coverage, compressed-manifest support, limits and administrator signing-configuration presence. No open project or network is required. Conformance is not assessed and no human-authorship claim is made.',
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
		outputSchema: capabilitiesOutput,
		handler: async (args) => {
			capabilitiesInput.parse(args);
			const result = await getCredentialCapabilities();
			const status = result.available
				? `Local C2PA SDK ${result.sdkVersion ?? 'unknown'} is available.`
				: `Local C2PA SDK is unavailable: ${result.unavailableReason ?? 'not installed'}.`;
			return {
				content: [
					{
						type: 'text',
						text: `${status} Signing is ${result.signerConfigured ? 'configured' : 'not configured by the administrator'}. Conformance is not assessed; credentials do not establish human authorship.`,
					},
				],
				structuredContent: { ...result },
			};
		},
	},
	{
		name: 'sign_content_credentials',
		title: 'Sign a Local Asset with Content Credentials',
		description:
			'Create an embedded or detached C2PA credential output from a local asset using administrator-configured signing material. Requires an explicit different output path; no open project or network is required. Signer keys, certificates, passwords and trust configuration cannot be supplied through this tool. A signature does not establish human authorship or official conformance.',
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				assetPath: pathProperty,
				outputPath: {
					...pathProperty,
					description: 'Explicit new output file path, different from the source asset.',
				},
				mimeType: mimeProperty,
				mode: {
					type: 'string',
					enum: ['embedded', 'sidecar'],
					default: 'embedded',
					description:
						'Embed credentials in a new asset or create a detached sidecar manifest.',
				},
				title: {
					type: 'string',
					maxLength: 500,
					description: 'Optional signed asset title.',
				},
				sourceManifestPath: {
					...pathProperty,
					description:
						'Optional detached source manifest to preserve as a parent ingredient.',
				},
				preserveInvalidSource: {
					type: 'boolean',
					default: false,
					description:
						'Explicitly preserve invalid source credentials as an ingredient with signed failure disclosure. The source history is not repaired or declared valid.',
				},
				includeReport: reportProperty,
			},
			required: ['assetPath', 'outputPath'],
		},
		outputSchema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				...revisionProperties,
				sourceManifestRevision: {
					...revisionProperties.sourceRevision,
					description: 'SHA-256 revision of the detached source manifest, when supplied.',
				},
				outputPath: { ...pathProperty, description: 'Created credential output path.' },
				mode: {
					type: 'string',
					enum: ['embedded', 'sidecar'],
					description: 'Storage mode actually produced by the signing operation.',
				},
				bytes: {
					type: 'integer',
					minimum: 0,
					description: 'Number of output bytes written.',
				},
				validation: validationSchema,
				sourceValidation: {
					...validationSchema,
					properties: Object.fromEntries(
						Object.entries(validationProperties).filter(
							([name]) => !['report', 'crjson', 'validationTime'].includes(name)
						)
					),
					description:
						'Original source validation, including preserved failures when explicitly requested.',
				},
			},
			required: [
				'assetPath',
				'outputPath',
				'mimeType',
				'mode',
				'bytes',
				'sourceRevision',
				'sdkVersion',
				'validation',
			],
		},
		handler: async (args) => {
			const { includeReport, ...request } = signInput.parse(args);
			const result = await signCredentialAsset(request);
			return {
				content: [
					{
						type: 'text',
						text: `Created ${result.mode} Content Credentials output. Integrity: ${result.validation.integrity}; trust: ${result.validation.trust}.${result.sourceValidation?.state === 'invalid' ? ' Invalid source history was preserved with a signed disclosure; it remains invalid.' : ''} A signature does not establish human authorship.`,
					},
				],
				structuredContent: {
					...result,
					validation: validationResult(result.validation, includeReport),
				},
			};
		},
	},
	{
		name: 'validate_content_credentials',
		title: 'Validate Local Content Credentials',
		description:
			'Validate a local asset, optionally with an explicit detached manifest. Return signature integrity separately from signer trust and include SDK evidence codes and the source revision. Uses administrator trust configuration without network access or an open project; raw SDK reports are opt-in. Validation does not establish human authorship or official conformance.',
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		inputSchema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				assetPath: pathProperty,
				mimeType: mimeProperty,
				manifestPath: {
					...pathProperty,
					description: 'Optional absolute path to a detached credential manifest.',
				},
				includeCrjson: crjsonProperty,
				includeReport: reportProperty,
			},
			required: ['assetPath'],
		},
		outputSchema: {
			type: 'object',
			additionalProperties: false,
			properties: { ...revisionProperties, ...validationProperties },
			required: [
				'assetPath',
				'mimeType',
				'sourceRevision',
				'sdkVersion',
				...validationRequired,
			],
		},
		handler: async (args) => {
			const { includeReport, ...request } = validateInput.parse(args);
			const result = await validateCredentialAsset(request);
			return {
				content: [
					{
						type: 'text',
						text: `Content Credentials: ${result.state}. Integrity: ${result.integrity}; trust: ${result.trust} (${result.trustPolicy}).${result.sourceValidationCodes?.length ? ' The signed record discloses invalid source history; the new signature does not repair it.' : ''} Validation does not establish human authorship.`,
					},
				],
				structuredContent: {
					...validationResult(result, includeReport, request.includeCrjson),
				},
			};
		},
	},
];
