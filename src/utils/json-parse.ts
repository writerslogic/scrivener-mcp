/**
 * Best-effort parse of a model reply to JSON. Strips ``` code fences, extracts
 * the first JSON value (array or object), and returns null -- never throws --
 * when the reply contains no JSON or is malformed, so a flaky completion
 * degrades to an empty result instead of crashing the caller. Pass a logger to
 * record why a parse failed.
 */
export function parseModelJson(
	raw: string,
	logger?: { warn: (message: string, context?: Record<string, unknown>) => void }
): unknown {
	const withoutFences = raw.replace(/```(?:json)?/gi, '').trim();
	const start = withoutFences.search(/[[{]/);
	if (start === -1) {
		logger?.warn('Model reply contained no JSON; treating as empty result', {
			preview: raw.slice(0, 120),
		});
		return null;
	}
	const end = Math.max(withoutFences.lastIndexOf(']'), withoutFences.lastIndexOf('}'));
	try {
		return JSON.parse(withoutFences.slice(start, end + 1));
	} catch (error) {
		logger?.warn('Model reply was not valid JSON; treating as empty result', {
			preview: raw.slice(0, 120),
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}
