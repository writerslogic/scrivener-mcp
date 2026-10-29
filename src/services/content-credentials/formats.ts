import { extname } from 'node:path';
import type { CredentialFormat } from './types.js';

function format(
	mimeType: string,
	extensions: string[],
	category: CredentialFormat['category'],
	embedded: CredentialFormat['embedded'] = 'unsupported',
	notes?: string,
	sidecar = true
): CredentialFormat {
	return Object.freeze({ mimeType, extensions: Object.freeze(extensions), category, embedded, sidecar, ...(notes ? { notes } : {}) });
}

const TEXT_FEATURE = 'Embedded text signing requires non-default experimental Rust SDK features; the pinned Node binary may not include them.';
const DETACHED = 'Detached credentials bind the original file bytes; no embedded signing support is claimed.';

export const CREDENTIAL_FORMATS: readonly CredentialFormat[] = Object.freeze([
	format('image/jpeg', ['jpg', 'jpeg', 'jpe'], 'image', 'supported'),
	format('image/png', ['png'], 'image', 'supported'),
	format('image/gif', ['gif'], 'image', 'supported'),
	format('image/tiff', ['tif', 'tiff'], 'image', 'supported'),
	format('image/webp', ['webp'], 'image', 'supported'),
	format('image/avif', ['avif'], 'image', 'supported'),
	format('image/heic', ['heic'], 'image', 'supported'),
	format('image/heif', ['heif'], 'image', 'supported'),
	format('image/jxl', ['jxl'], 'image', 'supported'),
	format('image/x-adobe-dng', ['dng'], 'image', 'supported'),
	format('image/svg+xml', ['svg'], 'image', 'supported'),
	format('image/bmp', ['bmp', 'dib'], 'image', 'unsupported', DETACHED),
	format('image/vnd.microsoft.icon', ['ico', 'cur'], 'image', 'unsupported', DETACHED),
	format('image/vnd.adobe.photoshop', ['psd'], 'image', 'unsupported', DETACHED),
	format('image/x-canon-cr2', ['cr2'], 'image', 'unsupported', DETACHED),
	format('image/x-nikon-nef', ['nef'], 'image', 'unsupported', DETACHED),
	format('video/mp4', ['mp4', 'm4v'], 'video', 'supported', 'Ordinary BMFF MP4 files; fragmented MP4 operations are not exposed by the Node signing flow.'),
	format('video/quicktime', ['mov', 'qt'], 'video', 'supported'),
	format('video/x-msvideo', ['avi'], 'video', 'supported'),
	format('video/3gpp', ['3gp', '3gpp'], 'video', 'experimental', 'BMFF brand support must be demonstrated with the pinned Node binary.'),
	format('video/3gpp2', ['3g2'], 'video', 'experimental', 'BMFF brand support must be demonstrated with the pinned Node binary.'),
	format('video/webm', ['webm'], 'video', 'unsupported', DETACHED),
	format('video/x-matroska', ['mkv'], 'video', 'unsupported', DETACHED),
	format('video/mpeg', ['mpeg', 'mpg'], 'video', 'unsupported', DETACHED),
	format('video/x-ms-asf', ['asf'], 'video', 'unsupported', DETACHED),
	format('video/x-ms-wmv', ['wmv'], 'video', 'unsupported', DETACHED),
	format('audio/wav', ['wav', 'wave'], 'audio', 'supported'),
	format('audio/mpeg', ['mp3'], 'audio', 'supported', 'MP3 embedding is verified. Native detached signing rewrites ID3 data and cannot bind unchanged source bytes; use embedded credentials.', false),
	format('audio/flac', ['flac'], 'audio', 'supported', 'Embedding is verified. Native detached signing rewrites metadata and cannot bind unchanged source bytes; use embedded credentials.', false),
	format('audio/mp4', ['m4a', 'm4b'], 'audio', 'supported'),
	format('audio/aac', ['aac'], 'audio', 'unsupported', DETACHED),
	format('audio/ogg', ['ogg', 'oga', 'opus'], 'audio', 'unsupported', DETACHED),
	format('audio/opus', [], 'audio', 'unsupported', 'Opus RTP payload MIME; .opus files normally use the Ogg container and audio/ogg.'),
	format('audio/aiff', ['aif', 'aiff', 'aifc'], 'audio', 'unsupported', DETACHED),
	format('audio/basic', ['au', 'snd'], 'audio', 'unsupported', DETACHED),
	format('application/pdf', ['pdf'], 'document', 'supported', 'Embedding is verified. Native detached signing rewrites the PDF and cannot bind unchanged source bytes; use embedded credentials.', false),
	format('application/epub+zip', ['epub'], 'document', 'supported', 'Unsigned DEFLATE archives are prepared as uncompressed ZIP copies for embedded signing, preserving entry contents and recording the original SHA-256. Existing DEFLATE credentials cannot be read by this SDK build; detached signing cannot bind unchanged originals.', false),
	format('application/vnd.openxmlformats-officedocument.wordprocessingml.document', ['docx'], 'document', 'supported', 'Unsigned DEFLATE archives are prepared as uncompressed ZIP copies for embedded signing, preserving entry contents and recording the original SHA-256. Existing DEFLATE credentials cannot be read by this SDK build; detached signing cannot bind unchanged originals.', false),
	format('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ['xlsx'], 'document', 'unsupported', DETACHED),
	format('application/vnd.openxmlformats-officedocument.presentationml.presentation', ['pptx'], 'document', 'unsupported', DETACHED),
	format('application/vnd.ms-word.document.macroenabled.12', ['docm'], 'document', 'unsupported', DETACHED),
	format('application/vnd.ms-excel.sheet.macroenabled.12', ['xlsm'], 'document', 'unsupported', DETACHED),
	format('application/vnd.ms-powerpoint.presentation.macroenabled.12', ['pptm'], 'document', 'unsupported', DETACHED),
	format('application/msword', ['doc'], 'document', 'unsupported', DETACHED),
	format('application/vnd.ms-excel', ['xls'], 'document', 'unsupported', DETACHED),
	format('application/vnd.ms-powerpoint', ['ppt'], 'document', 'unsupported', DETACHED),
	format('application/vnd.oasis.opendocument.text', ['odt'], 'document', 'unsupported', DETACHED),
	format('application/vnd.oasis.opendocument.spreadsheet', ['ods'], 'document', 'unsupported', DETACHED),
	format('application/vnd.oasis.opendocument.presentation', ['odp'], 'document', 'unsupported', DETACHED),
	format('application/rtf', ['rtf'], 'document', 'unsupported', DETACHED),
	format('application/postscript', ['ps', 'eps'], 'document', 'unsupported', DETACHED),
	format('text/plain', ['txt', 'text'], 'text', 'experimental', TEXT_FEATURE),
	format('text/markdown', ['md', 'markdown'], 'text', 'experimental', TEXT_FEATURE),
	format('text/html', ['html', 'htm'], 'text', 'experimental', TEXT_FEATURE),
	format('text/css', ['css'], 'text', 'experimental', TEXT_FEATURE),
	format('text/javascript', ['js', 'mjs', 'cjs'], 'text', 'experimental', TEXT_FEATURE),
	format('text/x-python', ['py'], 'text', 'experimental', TEXT_FEATURE),
	format('text/csv', ['csv'], 'text', 'unsupported', DETACHED),
	format('application/json', ['json'], 'text', 'unsupported', DETACHED),
	format('application/xml', ['xml'], 'text', 'unsupported', DETACHED),
	format('application/atom+xml', ['atom'], 'text', 'experimental', TEXT_FEATURE),
	format('application/rss+xml', ['rss'], 'text', 'experimental', TEXT_FEATURE),
	format('application/sql', ['sql'], 'text', 'experimental', TEXT_FEATURE),
	format('application/x-tex', ['tex'], 'text', 'experimental', TEXT_FEATURE),
	format('application/toml', ['toml'], 'text', 'experimental', TEXT_FEATURE),
	format('application/yaml', ['yaml', 'yml'], 'text', 'experimental', TEXT_FEATURE),
	format('application/x-ini', ['ini'], 'text', 'experimental', 'Experimental structured-text support is extension-based and may be absent from the pinned Node binary.'),
	format('text/vtt', ['vtt'], 'text', 'experimental', TEXT_FEATURE),
	format('font/ttf', ['ttf'], 'font', 'unsupported', DETACHED),
	format('font/otf', ['otf'], 'font', 'unsupported', DETACHED),
	format('font/woff', ['woff'], 'font', 'unsupported', DETACHED),
	format('font/woff2', ['woff2'], 'font', 'unsupported', DETACHED),
	format('model/gltf+json', ['gltf'], 'model', 'unsupported', DETACHED),
	format('model/gltf-binary', ['glb'], 'model', 'unsupported', DETACHED),
	format('model/obj', ['obj'], 'model', 'unsupported', DETACHED),
	format('model/stl', ['stl'], 'model', 'unsupported', DETACHED),
	format('model/vnd.usdz+zip', ['usdz'], 'model', 'unsupported', DETACHED),
	format('model/vrml', ['wrl', 'vrml'], 'model', 'unsupported', DETACHED),
	format('model/x3d+xml', ['x3d'], 'model', 'unsupported', DETACHED),
	format('application/zip', ['zip'], 'other', 'unsupported', DETACHED),
	format('application/octet-stream', [], 'other', 'unsupported', 'Explicit generic detached files only; credentials bind the original whole-file bytes.'),
	format('application/x-c2pa-manifest-store', ['c2pa'], 'other', 'unsupported', 'A detached credential container, not an asset-signing preset.', false),
]);

const aliases: Readonly<Record<string, string>> = Object.freeze({
	'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg', 'image/x-png': 'image/png',
	'image/x-tiff': 'image/tiff', 'image/x-icon': 'image/vnd.microsoft.icon',
	'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/vnd.wave': 'audio/wav',
	'audio/mp3': 'audio/mpeg', 'audio/x-flac': 'audio/flac', 'audio/x-aiff': 'audio/aiff',
	'audio/x-m4a': 'audio/mp4', 'audio/m4a': 'audio/mp4',
	'video/msvideo': 'video/x-msvideo', 'video/avi': 'video/x-msvideo',
	'application/x-troff-msvideo': 'video/x-msvideo', 'application/mp4': 'video/mp4',
	'video/x-m4v': 'video/mp4', 'text/rtf': 'application/rtf',
	'application/docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'application/x-docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'application/xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'application/pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	'application/javascript': 'text/javascript', 'text/x-javascript': 'text/javascript',
	'application/x-yaml': 'application/yaml', 'text/yaml': 'application/yaml', 'text/x-yaml': 'application/yaml',
	'text/xml': 'application/xml', 'application/font-woff': 'font/woff',
	'application/x-font-ttf': 'font/ttf', 'application/x-font-opentype': 'font/otf',
	'application/c2pa': 'application/x-c2pa-manifest-store',
	'model/vnd.pixar.usd': 'model/vnd.usdz+zip',
});
const byMime = new Map(CREDENTIAL_FORMATS.map((entry) => [entry.mimeType, entry]));
const byExtension = new Map(CREDENTIAL_FORMATS.flatMap((entry) => entry.extensions.map((extension) => [extension, entry] as const)));

export function resolveCredentialFormat(mimeType?: string, assetPath?: string): CredentialFormat {
	let selected: CredentialFormat | undefined;
	if (mimeType !== undefined) {
		if (typeof mimeType !== 'string' || !mimeType.trim() || mimeType.length > 255)
			throw new Error('Content Credentials MIME type must contain 1 to 255 characters');
		const normalized = mimeType.trim().toLowerCase();
		if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(normalized))
			throw new Error('Content Credentials MIME type must be a bare media type without parameters');
		selected = byMime.get(aliases[normalized] ?? normalized);
		if (!selected) throw new Error('Unknown Content Credentials MIME type; select a listed type or explicitly use application/octet-stream for a detached file');
	}
	if (assetPath !== undefined) {
		if (typeof assetPath !== 'string' || !assetPath || assetPath.length > 4096 || assetPath.includes('\0'))
			throw new Error('Content Credentials asset path must contain 1 to 4096 characters without null bytes');
		const extension = extname(assetPath).slice(1).toLowerCase();
		if (extension && !/^[a-z0-9][a-z0-9_-]{0,15}$/.test(extension))
			throw new Error('Content Credentials file extension is invalid');
		const inferred = byExtension.get(extension);
		if (selected && inferred && selected.mimeType !== inferred.mimeType &&
			selected.mimeType !== 'application/octet-stream' && !(extension === 'mp4' && selected.mimeType === 'audio/mp4'))
			throw new Error('Content Credentials MIME type conflicts with the file extension');
		selected ??= inferred;
	}
	if (!selected) throw new Error('Cannot infer a Content Credentials format; supply a listed MIME type or explicitly use application/octet-stream for a detached file');
	return selected;
}
