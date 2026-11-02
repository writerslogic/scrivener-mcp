import { createHash } from 'node:crypto';
import { stat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Embedder, Reranker } from 'writerslogic-warm/semantic';
import { validateEmbeddingSpace } from './hhm/document-index.js';

export interface WarmModels {
	embedder?: Embedder;
	rerank?: Reranker;
	fingerprint: string;
	close(): Promise<void>;
}

function setting(name: string, maximum = 4096): string | undefined {
	const value = process.env[name];
	if (value === undefined || value === '') return undefined;
	if (!value.trim() || value.includes('\0') || Buffer.byteLength(value) > maximum)
		throw new Error(`${name} must be a bounded nonempty value without NUL`);
	return value;
}

async function modelPath(value: string): Promise<string> {
	if (!isAbsolute(value)) throw new Error('Warm model directories must use absolute paths');
	const location = await realpath(value);
	if (!(await stat(location)).isDirectory())
		throw new Error('Warm model paths must identify local directories');
	return location;
}

export async function loadWarmModels(): Promise<WarmModels | undefined> {
	const embeddingPath = setting('SCRIVENER_WARM_EMBED_MODEL_PATH');
	const rerankPath = setting('SCRIVENER_WARM_RERANK_MODEL_PATH');
	const modelId = setting('SCRIVENER_WARM_EMBED_MODEL_ID', 512);
	const revision = setting('SCRIVENER_WARM_EMBED_REVISION', 512);
	if (!embeddingPath && (modelId || revision))
		throw new Error('Warm embedding identity requires SCRIVENER_WARM_EMBED_MODEL_PATH');
	if (!embeddingPath && !rerankPath) return undefined;
	if (embeddingPath && (!modelId || !revision))
		throw new Error('Warm embeddings require an explicit model ID and revision');
	const dtype = setting('SCRIVENER_WARM_MODEL_DTYPE', 16) ?? 'fp32';
	if (!['fp32', 'fp16', 'q8', 'int8', 'uint8', 'q4', 'q4f16', 'bnb4'].includes(dtype))
		throw new Error('Unsupported Warm local model dtype');
	const queryPrefix = setting('SCRIVENER_WARM_QUERY_PREFIX') ?? '';
	const documentPrefix = setting('SCRIVENER_WARM_DOCUMENT_PREFIX') ?? '';
	const { createLocalEmbedder, createLocalReranker } = await import('writerslogic-warm/semantic');
	let embedder: Embedder | undefined;
	let rerank: Reranker | undefined;
	let embedderReleased = false;
	let rerankerReleased = false;
	let closing: Promise<void> | undefined;
	const close = (): Promise<void> => {
		if (closing) return closing;
		closing = (async () => {
			const results = await Promise.allSettled([
				(async () => {
					if (embedderReleased) return;
					await embedder?.dispose?.();
					embedderReleased = true;
				})(),
				(async () => {
					if (rerankerReleased) return;
					await rerank?.dispose?.();
					rerankerReleased = true;
				})(),
			]);
			const failures = results.filter((result) => result.status === 'rejected');
			if (failures.length)
				throw new Error('Warm local model resources failed to close', {
					cause: failures.map((failure) => failure.reason),
				});
		})().finally(() => {
			closing = undefined;
		});
		return closing;
	};
	try {
		if (embeddingPath) {
			embedder = await createLocalEmbedder({
				modelPath: await modelPath(embeddingPath),
				modelId: modelId!,
				revision: revision!,
				queryPrefix,
				documentPrefix,
				dtype,
			});
			validateEmbeddingSpace(embedder.space);
			if (embedder.space.normalization !== 'l2' || embedder.space.metric !== 'cosine')
				throw new Error('Warm local embeddings require normalized cosine vectors');
		}
		const canonicalRerankPath = rerankPath ? await modelPath(rerankPath) : undefined;
		if (canonicalRerankPath)
			rerank = await createLocalReranker({ modelPath: canonicalRerankPath, dtype });
		return {
			embedder,
			rerank,
			fingerprint: createHash('sha256')
				.update(
					JSON.stringify([embedder?.space ?? null, canonicalRerankPath ?? null, dtype])
				)
				.digest('hex'),
			close,
		};
	} catch (error) {
		try {
			await close();
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				'Warm local model initialization and cleanup failed',
				{ cause: cleanupError }
			);
		}
		throw error;
	}
}
