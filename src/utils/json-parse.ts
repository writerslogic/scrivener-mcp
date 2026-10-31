/**
 * Extract a model's JSON object/array without changing strings inside it.
 * Returns null on malformed or absent JSON; callers must surface unavailability.
 */
export function parseModelJson(
	raw: string,
	logger?: { warn: (message: string, context?: Record<string, unknown>) => void }
): unknown {
	const start = raw.search(/[[{]/);
	if (start === -1) {
		logger?.warn('Model reply contained no JSON; parsed value unavailable', {
			responseCharacters: raw.length,
		});
		return null;
	}
	const end = Math.max(raw.lastIndexOf(']'), raw.lastIndexOf('}'));
	try {
		return JSON.parse(raw.slice(start, end + 1));
	} catch {
		logger?.warn('Model reply was not valid JSON; parsed value unavailable', {
			responseCharacters: raw.length,
		});
		return null;
	}
}
