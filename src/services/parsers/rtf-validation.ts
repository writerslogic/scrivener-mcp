export interface RtfControl {
	word?: string;
	parameter?: number;
	end: number;
}

export function readRtfControl(raw: string, start: number): RtfControl | undefined {
	if (raw[start] !== '\\' || start + 1 >= raw.length) return undefined;
	let end = start + 1;
	if (raw[end] === "'") {
		return /^[\da-f]{2}$/i.test(raw.slice(end + 1, end + 3)) ? { end: end + 3 } : undefined;
	}
	if (!/[a-z]/i.test(raw[end])) {
		const code = raw.charCodeAt(end);
		return (code >= 32 && code < 127) || /[\t\r\n]/.test(raw[end])
			? { end: end + 1 }
			: undefined;
	}
	while (end < raw.length && /[a-z]/i.test(raw[end])) end++;
	if (end - start > 33) return undefined;
	const word = raw.slice(start + 1, end).toLowerCase();
	const parameterStart = end;
	if (raw[end] === '-') end++;
	const digitsStart = end;
	while (end < raw.length && /\d/.test(raw[end])) end++;
	if (digitsStart !== parameterStart && digitsStart === end) return undefined;
	const parameter = end > digitsStart ? Number(raw.slice(parameterStart, end)) : undefined;
	if (parameter !== undefined && !Number.isSafeInteger(parameter)) return undefined;
	if (raw[end] === ' ') end++;
	if (word === 'bin') {
		if (parameter === undefined || parameter < 0) return undefined;
		let remaining = parameter;
		// Saved RTF is decoded from UTF-8; binary lengths still count source bytes.
		while (remaining > 0 && end < raw.length) {
			const code = raw.codePointAt(end)!;
			const bytes = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
			if (remaining < bytes) return undefined;
			remaining -= bytes;
			end += code > 0xffff ? 2 : 1;
		}
		if (remaining) return undefined;
	}
	return { word, parameter, end };
}

export function rtfGroupEnd(raw: string, start: number): number | undefined {
	if (raw[start] !== '{') return undefined;
	let depth = 0;
	for (let offset = start; offset < raw.length;) {
		const character = raw[offset];
		if (character === '\\') {
			const control = readRtfControl(raw, offset);
			if (!control) return undefined;
			offset = control.end;
			continue;
		}
		if (character === '{') depth++;
		else if (character === '}' && --depth === 0) return offset + 1;
		else if (character.charCodeAt(0) < 32 && !/[\t\r\n]/.test(character)) return undefined;
		offset++;
	}
	return undefined;
}

export function isStructurallyValidRtf(raw: string): boolean {
	let start = raw[0] === '\uFEFF' ? 1 : 0;
	while (start < raw.length && /[\t\r\n ]/.test(raw[start])) start++;
	if (raw[start] !== '{') return false;
	const declaration = readRtfControl(raw, start + 1);
	if (declaration?.word !== 'rtf' || declaration.parameter !== 1) return false;
	const end = rtfGroupEnd(raw, start);
	return end !== undefined && /^[\t\r\n ]*$/.test(raw.slice(end));
}
