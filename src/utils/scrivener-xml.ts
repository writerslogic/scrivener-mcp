/** Attribute-preserving XML with the direct field access used by binder services. */
const BINDER_ATTRIBUTES = ['UUID', 'ID', 'Type', 'Created', 'Modified'];

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Keep xml2js's `$` attribute map as the source of truth. Non-enumerable aliases
 * let existing callers use item.UUID without emitting a second <UUID> element.
 * A real child with the same name always remains separate from the attribute.
 */
export function exposeXmlAttributes(value: unknown, elementName = ''): void {
	if (Array.isArray(value)) {
		for (const item of value) exposeXmlAttributes(item, elementName);
		return;
	}
	if (!isRecord(value)) return;
	for (const [name, child] of Object.entries(value)) {
		if (name !== '$') exposeXmlAttributes(child, name);
	}
	const attributes = isRecord(value.$) ? value.$ : {};
	const names = new Set([
		...Object.keys(attributes),
		...(elementName === 'BinderItem' ? BINDER_ATTRIBUTES : []),
	]);
	for (const name of names) {
		if (Object.prototype.hasOwnProperty.call(value, name)) continue;
		Object.defineProperty(value, name, {
			configurable: true,
			enumerable: false,
			get: () => (isRecord(value.$) ? value.$[name] : undefined),
			set: (next: unknown) => {
				if (!isRecord(value.$)) value.$ = {};
				(value.$ as Record<string, unknown>)[name] = next;
			},
		});
	}
}

/**
 * New binder items are still created as plain objects by document services.
 * Encode their known native attributes; loaded nodes already carry all original
 * attributes in `$`, including metadata unknown to this server.
 * Call only on the detached copy used for serialization.
 */
export function encodeNewBinderAttributes(value: unknown, elementName = ''): void {
	if (Array.isArray(value)) {
		for (const item of value) encodeNewBinderAttributes(item, elementName);
		return;
	}
	if (!isRecord(value)) return;
	if (elementName === 'BinderItem' && !isRecord(value.$)) {
		const attributes: Record<string, unknown> = {};
		for (const name of BINDER_ATTRIBUTES) {
			if (Object.prototype.hasOwnProperty.call(value, name)) {
				attributes[name] = value[name];
				delete value[name];
			}
		}
		if (Object.keys(attributes).length) value.$ = attributes;
	}
	for (const [name, child] of Object.entries(value)) {
		if (name !== '$') encodeNewBinderAttributes(child, name);
	}
}
