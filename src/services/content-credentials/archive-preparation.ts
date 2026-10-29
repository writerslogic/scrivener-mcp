import JSZip from 'jszip';
import { Readable } from 'node:stream';
import { CREDENTIAL_LIMITS } from './limits.js';

const MAX_ENTRIES = 4096;

function archiveEntryCount(bytes: Buffer): number {
	for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
		if (
			bytes.readUInt32LE(offset) !== 0x06054b50 ||
			offset + 22 + bytes.readUInt16LE(offset + 20) !== bytes.length
		)
			continue;
		const count = bytes.readUInt16LE(offset + 10);
		if (count < 1 || count > MAX_ENTRIES)
			throw new Error('Credential archives must contain at most 4096 entries');
		if (
			bytes.readUInt16LE(offset + 4) !== 0 ||
			bytes.readUInt16LE(offset + 6) !== 0 ||
			bytes.readUInt16LE(offset + 8) !== count ||
			bytes.readUInt32LE(offset + 16) + bytes.readUInt32LE(offset + 12) > offset
		)
			throw new Error('Multipart and ZIP64 credential archives cannot be prepared');
		let cursor = bytes.readUInt32LE(offset + 16);
		const end = cursor + bytes.readUInt32LE(offset + 12);
		for (let index = 0; index < count; index++) {
			if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50)
				throw new Error('Credential archive central directory is inconsistent');
			cursor +=
				46 +
				bytes.readUInt16LE(cursor + 28) +
				bytes.readUInt16LE(cursor + 30) +
				bytes.readUInt16LE(cursor + 32);
		}
		if (cursor !== end) throw new Error('Credential archive central directory is inconsistent');
		return count;
	}
	throw new Error('Credential archive has no valid central directory');
}

export async function prepareUnsignedCredentialArchive(
	bytes: Buffer,
	maximum: number
): Promise<Buffer> {
	if (
		!Number.isSafeInteger(maximum) ||
		maximum < 1 ||
		maximum > CREDENTIAL_LIMITS.assetBytes ||
		bytes.length > maximum
	)
		throw new Error('Credential archive size limit is invalid or exceeded');
	const declaredEntries = archiveEntryCount(bytes);
	const archive = await JSZip.loadAsync(bytes);
	const entries = Object.values(archive.files);
	if (entries.length !== declaredEntries)
		throw new Error('Credential archive contains duplicate or ambiguous entry names');
	let expanded = 0;
	for (const entry of entries) {
		if (
			entry.name.length > 4096 ||
			entry.name.includes('\0') ||
			entry.name.includes('\\') ||
			entry.name.includes(':') ||
			entry.name.startsWith('/') ||
			entry.name.split('/').includes('..') ||
			(entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name)
		)
			throw new Error('Credential archive contains an unsafe entry name');
		if (entry.name.toLowerCase().endsWith('.c2pa'))
			throw new Error(
				'Existing archive credentials must be validated before archive preparation'
			);
		if (entry.dir) continue;
		const stream = new Readable().wrap(entry.nodeStream('nodebuffer'));
		try {
			for await (const chunk of stream) {
				if (!Buffer.isBuffer(chunk))
					throw new Error('Credential archive returned unsupported entry data');
				expanded += chunk.length;
				if (!Number.isSafeInteger(expanded) || expanded > maximum)
					throw new Error('Expanded credential archive exceeds the asset limit');
			}
		} finally {
			stream.destroy();
		}
	}
	// Bound expansion before JSZip's whole-archive CRC verification can start decompressing.
	await JSZip.loadAsync(bytes, { checkCRC32: true });
	const prepared = await archive.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
	if (prepared.length > maximum)
		throw new Error('Prepared credential archive exceeds the asset limit');
	return prepared;
}
