export function publicationLanguage(value: unknown = 'und'): string {
	if (
		typeof value !== 'string' ||
		value.length > 255 ||
		!/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(value)
	)
		throw new Error(
			'Publication language must be a Unicode BCP47 language tag (maximum 255 characters), such as fr, ja or und'
		);
	try {
		return Intl.getCanonicalLocales(value)[0];
	} catch {
		throw new Error('Publication language must be a valid Unicode BCP47 language tag');
	}
}
