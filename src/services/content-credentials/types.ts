export type CredentialMediaCategory =
	'image' | 'video' | 'audio' | 'document' | 'text' | 'font' | 'model' | 'other';

export interface CredentialFormat {
	mimeType: string;
	extensions: readonly string[];
	category: CredentialMediaCategory;
	embedded: 'supported' | 'unsupported' | 'experimental';
	sidecar: boolean;
	preparation?: 'zip-store';
	notes?: string;
}

export type CredentialMode = 'embedded' | 'sidecar';

export type CredentialSigningAlgorithm =
	'es256' | 'es384' | 'es512' | 'ps256' | 'ps384' | 'ps512' | 'ed25519';

export interface CredentialCapabilities {
	available: boolean;
	sdkVersion: string | null;
	unavailableReason?: string;
	formats: readonly CredentialFormat[];
	modes: readonly CredentialMode[];
	compressedManifests: { generation: boolean; validation: boolean };
	signerConfigured: boolean;
	conformance: {
		status: 'not-assessed';
		maxAssuranceLevel: null;
		implementationClass: 'edge';
		attestationMethods: readonly string[];
	};
	limits: { assetBytes: number; manifestBytes: number; timeoutMs: number };
}

export interface CredentialValidation {
	state: 'valid' | 'invalid' | 'unsigned' | 'untrusted';
	integrity: 'valid' | 'invalid' | 'not-evaluated';
	trust: 'trusted' | 'untrusted' | 'not-evaluated';
	trustPolicy: 'configured-roots' | 'none';
	activeManifest?: string;
	validationCodes: string[];
	sourceValidationCodes?: string[];
	report: Record<string, unknown> | null;
	crjson?: Record<string, unknown>;
	validationTime?: string;
	activeIntegrity?: 'valid' | 'invalid' | 'not-evaluated';
}

export type CredentialSourceValidation = Omit<
	CredentialValidation,
	'report' | 'crjson' | 'validationTime'
>;

export interface CredentialSignerConfiguration {
	certificatePath: string;
	privateKeyPath: string;
	password: string;
}

export type CredentialWorkerRequest = { operation: 'probe' } | CredentialAssetWorkerRequest;

export interface CredentialAssetWorkerRequest {
	operation: 'sign' | 'validate';
	assetPath: string;
	mimeType: string;
	mode: CredentialMode;
	destinationPath?: string;
	manifestPath?: string;
	title?: string;
	signer?: CredentialSignerConfiguration;
	trustAnchorsPath?: string;
	timestampTrustAnchorsPath?: string;
	validationTime?: string;
	includeCrjson?: boolean;
	sourceManifestPath?: string;
	preserveInvalidSource?: boolean;
}

export type CredentialWorkerResponse =
	| { ok: true; operation: 'probe'; sdkVersion: string }
	| {
			ok: true;
			operation: 'sign' | 'validate';
			sdkVersion: string;
			validation: CredentialValidation;
			manifestBytes?: number;
			assetBytes?: number;
			sourceValidation?: CredentialSourceValidation;
	  }
	| {
			ok: false;
			code: string;
			message: string;
	  };

export interface SignCredentialRequest {
	assetPath: string;
	outputPath: string;
	mimeType?: string;
	mode?: CredentialMode;
	title?: string;
	sourceManifestPath?: string;
	preserveInvalidSource?: boolean;
}

export interface ValidateCredentialRequest {
	assetPath: string;
	mimeType?: string;
	manifestPath?: string;
	includeCrjson?: boolean;
}

export interface CredentialAssessmentPolicy {
	trustAnchorsPath: string;
	timestampTrustAnchorsPath: string;
	validationTime: string;
}

export interface SignCredentialResult {
	assetPath: string;
	outputPath: string;
	mimeType: string;
	mode: CredentialMode;
	bytes: number;
	sourceRevision: string;
	sourceManifestRevision?: string;
	sdkVersion: string;
	validation: CredentialValidation;
	sourceValidation?: CredentialSourceValidation;
}

export interface ValidateCredentialResult extends CredentialValidation {
	assetPath: string;
	mimeType: string;
	sourceRevision: string;
	sdkVersion: string;
}
