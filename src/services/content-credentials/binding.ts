import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { credentialBindingDirectory } from './worker-path.cjs';
import type { CredentialSigningAlgorithm } from './types.js';

interface CredentialBinding {
	default: (input: { module_or_path: Uint8Array }) => Promise<unknown>;
	inspect_asset: (
		mimeType: string,
		asset: Uint8Array,
		manifest: Uint8Array | undefined,
		settings: string,
		includeCrjson: boolean
	) => Promise<string>;
	validation_time_ms: (value: string) => number;
	core_version: () => string;
	sign_asset: (
		mimeType: string,
		asset: Uint8Array,
		sourceManifest: Uint8Array | undefined,
		definition: string,
		settings: string,
		certificates: string,
		algorithm: string,
		noEmbed: boolean,
		sign: (bytes: Uint8Array) => Promise<Uint8Array>
	) => Promise<unknown>;
}

export interface CredentialCallbackSigner {
	algorithm: CredentialSigningAlgorithm;
	certificates: string;
	sign: (bytes: Uint8Array) => Promise<Uint8Array>;
}

let binding: Promise<CredentialBinding> | undefined;

async function loadBinding(): Promise<CredentialBinding> {
	if (!binding) {
		binding = (async () => {
			const root = credentialBindingDirectory();
			const module: unknown = await import(pathToFileURL(join(root, 'binding.js')).href);
			if (
				!module ||
				typeof module !== 'object' ||
				!('default' in module) ||
				typeof module.default !== 'function' ||
				!('inspect_asset' in module) ||
				typeof module.inspect_asset !== 'function' ||
				!('validation_time_ms' in module) ||
				typeof module.validation_time_ms !== 'function' ||
				!('core_version' in module) ||
				typeof module.core_version !== 'function' ||
				!('sign_asset' in module) ||
				typeof module.sign_asset !== 'function'
			)
				throw new Error('SDK_UNAVAILABLE');
			const reader = module as CredentialBinding;
			await reader.default({
				module_or_path: await readFile(join(root, 'binding_bg.wasm')),
			});
			return reader;
		})();
		binding.catch(() => {
			binding = undefined;
		});
	}
	return binding;
}

export async function probeCredentialBinding(): Promise<string> {
	const version = (await loadBinding()).core_version();
	if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error('SDK_UNAVAILABLE');
	return version;
}

export async function signCredentialAssetBytes(input: {
	mimeType: string;
	asset: Buffer;
	sourceManifest?: Buffer;
	definition: Record<string, unknown>;
	settings: string;
	noEmbed: boolean;
	signer: CredentialCallbackSigner;
}): Promise<{ asset: Buffer; manifest: Buffer }> {
	const engine = await loadBinding();
	const result = await engine.sign_asset(
		input.mimeType,
		input.asset,
		input.sourceManifest,
		JSON.stringify(input.definition),
		input.settings,
		input.signer.certificates,
		input.signer.algorithm,
		input.noEmbed,
		input.signer.sign
	);
	if (
		!result ||
		typeof result !== 'object' ||
		!('asset' in result) ||
		!('manifest' in result) ||
		!(result.asset instanceof Uint8Array) ||
		!(result.manifest instanceof Uint8Array) ||
		result.asset.length > 136 * 1024 * 1024 ||
		!result.manifest.length ||
		result.manifest.length > 8 * 1024 * 1024
	)
		throw new Error('OUTPUT_LIMIT');
	return { asset: Buffer.from(result.asset), manifest: Buffer.from(result.manifest) };
}

export async function readCredentialAsset(
	mimeType: string,
	asset: Buffer,
	settings: string,
	manifest?: Buffer,
	validationTime?: string,
	includeCrjson = false
): Promise<{ report: unknown; crjson: unknown }> {
	const reader = await loadBinding();
	const nativeDate = Date;
	if (validationTime !== undefined) {
		if (typeof process.send !== 'function') throw new Error('ASSESSMENT_CLOCK_REQUIRES_WORKER');
		const milliseconds = reader.validation_time_ms(validationTime);
		if (!Number.isFinite(milliseconds)) throw new Error('VALIDATION_TIME_INVALID');
		// The SDK's WASM clock is changed only inside its one-request worker.
		globalThis.Date = new Proxy(nativeDate, {
			construct(target, args, receiver) {
				return Reflect.construct(target, args.length ? args : [milliseconds], receiver);
			},
			get(target, property, receiver) {
				return property === 'now'
					? () => milliseconds
					: Reflect.get(target, property, receiver);
			},
		});
	}
	try {
		const output = await reader.inspect_asset(
			mimeType,
			asset,
			manifest,
			settings,
			includeCrjson
		);
		if (Buffer.byteLength(output) > 16 * 1024 * 1024) throw new Error('REPORT_LIMIT');
		const value: unknown = JSON.parse(output);
		if (!value || typeof value !== 'object' || !('report' in value) || !('crjson' in value))
			throw new Error('REPORT_INVALID');
		return { report: value.report, crjson: value.crjson };
	} finally {
		globalThis.Date = nativeDate;
	}
}
