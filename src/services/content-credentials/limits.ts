export const CREDENTIAL_LIMITS = Object.freeze({
	assetBytes: 128 * 1024 * 1024,
	manifestBytes: 8 * 1024 * 1024,
	timeoutMs: 30000,
});

export const MAX_CONFIGURATION_BYTES = 128 * 1024;
export const MAX_TRUST_CONFIGURATION_BYTES = 2 * 1024 * 1024;
export const MAX_TRUST_CERTIFICATES = 256;
export const MAX_VALIDATION_CODES = 1024;
