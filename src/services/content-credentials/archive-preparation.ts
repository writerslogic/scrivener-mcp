import JSZip from 'jszip';
import { Readable } from 'node:stream';

const MAX_ENTRIES = 4096;

export async function prepareUnsignedCredentialArchive(bytes: Buffer, maximum: number): Promise<Buffer> {
	if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 128 * 1024 * 1024 || bytes.length > maximum)
		throw new Error('Credential archive size limit is invalid or exceeded');
	const archive = await JSZip.loadAsync(bytes);
	const entries = Object.values(archive.files);
	if (!entries.length || entries.length > MAX_ENTRIES)
		throw new Error('Credential archives must contain at most 4096 entries');
	let expanded = 0;
	for (const entry of entries) {
		if (entry.name.length > 4096 || entry.name.includes('\0') || entry.name.includes('\\') || entry.name.startsWith('/') || entry.name.split('/').includes('..') || (entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name))
			throw new Error('Credential archive contains an unsafe entry name');
		if (entry.name.toLowerCase().endsWith('.c2pa'))
			throw new Error('Existing archive credentials must be validated before archive preparation');
		if (entry.dir) continue;
		const stream = new Readable().wrap(entry.nodeStream('nodebuffer'));
		try {
			for await (const chunk of stream) {
				if (!Buffer.isBuffer(chunk)) throw new Error('Credential archive returned unsupported entry data');
				expanded += chunk.length;
				if (!Number.isSafeInteger(expanded) || expanded > maximum)
					throw new Error('Expanded credential archive exceeds the asset limit');
			}
		} finally {
			stream.destroy();
		}
	}
	const prepared = await archive.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
	if (prepared.length > maximum) throw new Error('Prepared credential archive exceeds the asset limit');
	return prepared;
}
