import { homedir } from 'node:os';

export function redactDiagnostics(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactDiagnostics);
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				/api.?key|token|password|secret|^content$|^manuscript$|^stderr$/i.test(key)
					? '[redacted]'
					: redactDiagnostics(item),
			])
		);
	}
	if (typeof value !== 'string') return value;
	return value
		.split(homedir())
		.join('~')
		.replace(/(?:sk|sk-ant|sk-or)-[A-Za-z0-9_-]{8,}/g, '[redacted]')
		.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@');
}
