export type CredentialMediaCategory =
	| 'image'
	| 'video'
	| 'audio'
	| 'document'
	| 'text'
	| 'font'
	| 'model'
	| 'other';

export interface CredentialFormat {
	mimeType: string;
	extensions: readonly string[];
	category: CredentialMediaCategory;
	embedded: 'supported' | 'unsupported' | 'experimental';
	sidecar: boolean;
	notes?: string;
}

export type CredentialMode = 'embedded' | 'sidecar';

export interface CredentialValidation {
	state: 'valid' | 'invalid' | 'unsigned' | 'untrusted';
	integrity: 'valid' | 'invalid' | 'not-evaluated';
	trust: 'trusted' | 'untrusted' | 'not-evaluated';
	trustPolicy: 'configured-roots' | 'none';
	activeManifest?: string;
	validationCodes: string[];
	report: Record<string, unknown> | null;
}

export interface CredentialSignerConfiguration {
	certificatePath: string;
	privateKeyPath: string;
	password: string;
}

export interface CredentialWorkerRequest {
	operation: 'sign' | 'validate';
	assetPath: string;
	mimeType: string;
	mode: CredentialMode;
	destinationPath?: string;
	manifestPath?: string;
	title?: string;
	signer?: CredentialSignerConfiguration;
	trustAnchorsPath?: string;
}

export type CredentialWorkerResponse =
	| {
			ok: true;
			sdkVersion: string;
			validation: CredentialValidation;
			manifestBytes?: number;
			assetBytes?: number;
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
}

export interface ValidateCredentialRequest {
	assetPath: string;
	mimeType?: string;
	manifestPath?: string;
}

export interface SignCredentialResult {
	assetPath: string;
	outputPath: string;
	mimeType: string;
	mode: CredentialMode;
	bytes: number;
	sourceRevision: string;
	sdkVersion: string;
	validation: CredentialValidation;
}

export interface ValidateCredentialResult extends CredentialValidation {
	assetPath: string;
	mimeType: string;
	sourceRevision: string;
	sdkVersion: string;
}
