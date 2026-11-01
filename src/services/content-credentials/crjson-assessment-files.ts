import { lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createError, ErrorCode } from '../../core/errors.js';
import {
	canonicalCredentialOutputPath,
	protectCredentialOutputPath,
	writeExclusiveCredentialFile,
} from './local-files.js';
import type { CrjsonAssessmentExport } from './crjson-assessment.js';

export async function prepareCrjsonAssessmentFiles(
	assessmentPath: string,
	nativePath: string
): Promise<(output: CrjsonAssessmentExport) => Promise<void>> {
	const destinations: string[] = [];
	for (const path of [assessmentPath, nativePath]) {
		if (
			typeof path !== 'string' ||
			!isAbsolute(path) ||
			path.length > 4096 ||
			path.includes('\0')
		)
			throw createError(
				ErrorCode.PATH_INVALID,
				undefined,
				'Assessment outputs require absolute local paths without NUL characters.'
			);
		protectCredentialOutputPath(path);
		const canonical = await canonicalCredentialOutputPath(path);
		protectCredentialOutputPath(canonical);
		const existing = await lstat(canonical).catch((error: NodeJS.ErrnoException) => {
			if (error.code === 'ENOENT') return undefined;
			throw createError(
				ErrorCode.PATH_INVALID,
				undefined,
				'Assessment output cannot be inspected safely.'
			);
		});
		if (existing)
			throw createError(
				ErrorCode.FILE_WRITE_ERROR,
				undefined,
				'Assessment outputs must use two new files.'
			);
		destinations.push(canonical);
	}
	const [assessment, native] = destinations;
	if (assessment === native)
		throw createError(
			ErrorCode.INVALID_INPUT,
			undefined,
			'Assessment and native evidence require different output paths.'
		);
	return async (output) => {
		await writeExclusiveCredentialFile(native, output.nativeEvidenceBytes);
		try {
			await writeExclusiveCredentialFile(assessment, output.assessmentBytes);
		} catch {
			throw createError(
				ErrorCode.FILE_WRITE_ERROR,
				undefined,
				'Assessment export could not complete. Native evidence was retained; inspect both destinations and retry with two new paths.'
			);
		}
	};
}
