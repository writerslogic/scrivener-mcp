/**
 * Escape a string so it is matched literally inside a RegExp. Use this whenever
 * data (an entity name, a document field) is interpolated into a regular
 * expression, to prevent regex-injection / ReDoS from metacharacters in the data.
 */
export function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
