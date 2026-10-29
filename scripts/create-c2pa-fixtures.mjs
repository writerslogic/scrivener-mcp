#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, KeyObject, randomBytes, webcrypto } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import JSZip from 'jszip';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const execute = promisify(execFile);

async function command(program, args) {
	try {
		const pending = execute(program, args, { timeout: 30_000, maxBuffer: 256 * 1024, windowsHide: true });
		pending.child.stdin.end();
		return await pending;
	} catch (error) {
		throw new Error(error.code === 'ENOENT' ? `${program} is required on PATH` : `${program} failed to generate a synthetic fixture`);
	}
}

export async function createC2paTestSigner(directory) {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	assert.deepEqual(await readdir(directory), [], 'Test signer directory must be empty');
	const password = randomBytes(32).toString('base64url');
	const privateKeyPath = join(directory, 'test-leaf-key.encrypted.pem');
	const trustAnchorsPath = join(directory, 'test-root.pem');
	const certificatePath = join(directory, 'test-chain.pem');
	await import('reflect-metadata');
	const x509 = await import('@peculiar/x509');
	const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
	const rootKeys = await webcrypto.subtle.generateKey(algorithm, false, ['sign', 'verify']);
	const leafKeys = await webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
	const now = Date.now();
	const rootName = 'CN=Scrivener MCP TEST ROOT - NOT PUBLICLY TRUSTED';
	const root = await x509.X509CertificateGenerator.createSelfSigned({
		name: rootName, keys: rootKeys, signingAlgorithm: algorithm,
		notBefore: new Date(now - 60000), notAfter: new Date(now + 2 * 86400000),
		extensions: [new x509.BasicConstraintsExtension(true, 0, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true), await x509.SubjectKeyIdentifierExtension.create(rootKeys.publicKey, false, webcrypto)],
	}, webcrypto);
	const leaf = await x509.X509CertificateGenerator.create({
		issuer: rootName, subject: 'CN=Scrivener MCP Synthetic Fixture Signer - TEST ONLY',
		publicKey: leafKeys.publicKey, signingKey: rootKeys.privateKey, signingAlgorithm: algorithm,
		notBefore: new Date(now - 60000), notAfter: new Date(now + 86400000),
		extensions: [new x509.BasicConstraintsExtension(false, undefined, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true), new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.emailProtection]), await x509.SubjectKeyIdentifierExtension.create(leafKeys.publicKey, false, webcrypto), await x509.AuthorityKeyIdentifierExtension.create(rootKeys.publicKey, false, webcrypto)],
	}, webcrypto);
	const encrypted = KeyObject.from(leafKeys.privateKey).export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: password });
	await writeFile(privateKeyPath, encrypted, { flag: 'wx', mode: 0o600 });
	await writeFile(trustAnchorsPath, root.toString('pem'), { flag: 'wx', mode: 0o600 });
	await writeFile(certificatePath, `${leaf.toString('pem')}\n${root.toString('pem')}\n`, { flag: 'wx', mode: 0o600 });
	return { certificatePath, privateKeyPath, password, trustAnchorsPath };
}

function crc32(buffer) {
	let value = 0xffffffff;
	for (const byte of buffer) {
		value ^= byte;
		for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
	}
	return (value ^ 0xffffffff) >>> 0;
}

function png() {
	const chunk = (name, data) => {
		const type = Buffer.from(name);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const checksum = Buffer.alloc(4);
		checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
		return Buffer.concat([length, type, data, checksum]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(16, 0);
	header.writeUInt32BE(16, 4);
	header[8] = 8;
	header[9] = 6;
	const rows = Buffer.alloc(16 * (1 + 16 * 4));
	for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
		const offset = y * 65 + 1 + x * 4;
		rows.set([x * 16, y * 16, 128, 255], offset);
	}
	return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

function wav() {
	const samples = 800;
	const result = Buffer.alloc(44 + samples * 2);
	result.write('RIFF', 0);
	result.writeUInt32LE(result.length - 8, 4);
	result.write('WAVEfmt ', 8);
	result.writeUInt32LE(16, 16);
	result.writeUInt16LE(1, 20);
	result.writeUInt16LE(1, 22);
	result.writeUInt32LE(8000, 24);
	result.writeUInt32LE(16000, 28);
	result.writeUInt16LE(2, 32);
	result.writeUInt16LE(16, 34);
	result.write('data', 36);
	result.writeUInt32LE(samples * 2, 40);
	for (let index = 0; index < samples; index++) result.writeInt16LE(Math.round(Math.sin(index * Math.PI / 20) * 1024), 44 + index * 2);
	return result;
}

function originalFonts() {
	const tables = new Map();
	const head = Buffer.alloc(54);
	head.writeUInt32BE(0x00010000, 0);
	head.writeUInt32BE(0x00010000, 4);
	head.writeUInt32BE(0x5f0f3cf5, 12);
	head.writeUInt16BE(1000, 18);
	head.writeUInt16BE(8, 46);
	head.writeInt16BE(2, 48);
	tables.set('head', head);
	const hhea = Buffer.alloc(36);
	hhea.writeUInt32BE(0x00010000, 0);
	hhea.writeInt16BE(800, 4);
	hhea.writeInt16BE(-200, 6);
	hhea.writeUInt16BE(500, 10);
	hhea.writeInt16BE(500, 14);
	hhea.writeInt16BE(1, 18);
	hhea.writeUInt16BE(2, 34);
	tables.set('hhea', hhea);
	const maxp = Buffer.alloc(32);
	maxp.writeUInt32BE(0x00010000, 0);
	maxp.writeUInt16BE(2, 4);
	maxp.writeUInt16BE(1, 14);
	tables.set('maxp', maxp);
	const hmtx = Buffer.alloc(8);
	hmtx.writeUInt16BE(500, 0);
	hmtx.writeUInt16BE(500, 4);
	tables.set('hmtx', hmtx);
	const loca = Buffer.alloc(6);
	loca.writeUInt16BE(6, 2);
	loca.writeUInt16BE(12, 4);
	tables.set('loca', loca);
	tables.set('glyf', Buffer.alloc(24));
	const cmap = Buffer.alloc(44);
	cmap.writeUInt16BE(1, 2);
	cmap.writeUInt16BE(3, 4);
	cmap.writeUInt16BE(1, 6);
	cmap.writeUInt32BE(12, 8);
	cmap.writeUInt16BE(4, 12);
	cmap.writeUInt16BE(32, 14);
	cmap.writeUInt16BE(4, 18);
	cmap.writeUInt16BE(4, 20);
	cmap.writeUInt16BE(1, 22);
	cmap.writeUInt16BE(32, 26);
	cmap.writeUInt16BE(0xffff, 28);
	cmap.writeUInt16BE(32, 32);
	cmap.writeUInt16BE(0xffff, 34);
	cmap.writeInt16BE(-31, 36);
	cmap.writeUInt16BE(1, 38);
	tables.set('cmap', cmap);
	const os2 = Buffer.alloc(78);
	os2.writeInt16BE(500, 2);
	os2.writeUInt16BE(400, 4);
	os2.writeUInt16BE(5, 6);
	os2.write('CC0 ', 58);
	os2.writeUInt16BE(0x40, 62);
	os2.writeUInt16BE(32, 64);
	os2.writeUInt16BE(32, 66);
	os2.writeInt16BE(800, 68);
	os2.writeInt16BE(-200, 70);
	os2.writeUInt16BE(800, 74);
	os2.writeUInt16BE(200, 76);
	tables.set('OS/2', os2);
	const names = [[1, 'Original CC0 Fixture'], [2, 'Regular'], [4, 'Original CC0 Fixture Regular'], [6, 'CC0Fixture-Regular']];
	const strings = names.map(([, value]) => Buffer.from(value, 'utf16le').swap16());
	const name = Buffer.alloc(6 + names.length * 12);
	name.writeUInt16BE(names.length, 2);
	name.writeUInt16BE(name.length, 4);
	let stringOffset = 0;
	names.forEach(([id], index) => {
		const offset = 6 + index * 12;
		[3, 1, 0x0409, id, strings[index].length, stringOffset].forEach((value, field) => name.writeUInt16BE(value, offset + field * 2));
		stringOffset += strings[index].length;
	});
	tables.set('name', Buffer.concat([name, ...strings]));
	const post = Buffer.alloc(32);
	post.writeUInt32BE(0x00030000, 0);
	tables.set('post', post);
	const checksum = (bytes) => {
		const padded = Buffer.alloc(Math.ceil(bytes.length / 4) * 4);
		bytes.copy(padded);
		let result = 0;
		for (let index = 0; index < padded.length; index += 4) result = (result + padded.readUInt32BE(index)) >>> 0;
		return result;
	};
	const entries = [...tables].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([tag, bytes]) => ({ tag, bytes, checksum: checksum(bytes) }));
	const directory = Buffer.alloc(12 + entries.length * 16);
	directory.writeUInt32BE(0x00010000, 0);
	directory.writeUInt16BE(entries.length, 4);
	directory.writeUInt16BE(128, 6);
	directory.writeUInt16BE(3, 8);
	directory.writeUInt16BE(entries.length * 16 - 128, 10);
	let offset = directory.length;
	const parts = [directory];
	entries.forEach((entry, index) => {
		entry.offset = offset;
		const row = 12 + index * 16;
		directory.write(entry.tag, row);
		directory.writeUInt32BE(entry.checksum, row + 4);
		directory.writeUInt32BE(offset, row + 8);
		directory.writeUInt32BE(entry.bytes.length, row + 12);
		const padded = Buffer.alloc(Math.ceil(entry.bytes.length / 4) * 4);
		entry.bytes.copy(padded);
		parts.push(padded);
		offset += padded.length;
	});
	const ttf = Buffer.concat(parts);
	ttf.writeUInt32BE((0xb1b0afba - checksum(ttf)) >>> 0, entries.find((entry) => entry.tag === 'head').offset + 8);
	const woffHeader = Buffer.alloc(44 + entries.length * 20);
	woffHeader.write('wOFF', 0);
	woffHeader.writeUInt32BE(0x00010000, 4);
	woffHeader.writeUInt16BE(entries.length, 12);
	woffHeader.writeUInt32BE(ttf.length, 16);
	woffHeader.writeUInt16BE(1, 20);
	offset = woffHeader.length;
	const compressedTables = [];
	entries.forEach((entry, index) => {
		const bytes = ttf.subarray(entry.offset, entry.offset + entry.bytes.length);
		const compressed = deflateSync(bytes);
		const stored = compressed.length < bytes.length ? compressed : bytes;
		const row = 44 + index * 20;
		woffHeader.write(entry.tag, row);
		[ offset, stored.length, bytes.length, entry.checksum ].forEach((value, field) => woffHeader.writeUInt32BE(value, row + 4 + field * 4));
		const padded = Buffer.alloc(Math.ceil(stored.length / 4) * 4);
		stored.copy(padded);
		compressedTables.push(padded);
		offset += padded.length;
	});
	woffHeader.writeUInt32BE(offset, 8);
	return { ttf, woff: Buffer.concat([woffHeader, ...compressedTables]) };
}

function triangle(binary = false) {
	const geometry = Buffer.alloc(44);
	[0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => geometry.writeFloatLE(value, index * 4));
	[0, 1, 2].forEach((value, index) => geometry.writeUInt16LE(value, 36 + index * 2));
	const definition = {
		asset: { version: '2.0', generator: 'Original CC0 Scrivener MCP fixture' },
		buffers: [{ byteLength: 42, ...(binary ? {} : { uri: `data:application/octet-stream;base64,${geometry.subarray(0, 42).toString('base64')}` }) }],
		bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 }, { buffer: 0, byteOffset: 36, byteLength: 6, target: 34963 }],
		accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }, { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }],
		meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
		nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
	};
	if (!binary) return Buffer.from(JSON.stringify(definition));
	const encoded = Buffer.from(JSON.stringify(definition));
	const json = Buffer.alloc(Math.ceil(encoded.length / 4) * 4, 0x20);
	encoded.copy(json);
	const header = Buffer.alloc(20);
	header.write('glTF', 0);
	header.writeUInt32LE(2, 4);
	header.writeUInt32LE(28 + json.length + geometry.length, 8);
	header.writeUInt32LE(json.length, 12);
	header.writeUInt32LE(0x4e4f534a, 16);
	const binHeader = Buffer.alloc(8);
	binHeader.writeUInt32LE(geometry.length, 0);
	binHeader.writeUInt32LE(0x004e4942, 4);
	return Buffer.concat([header, json, binHeader, geometry]);
}

async function officeArchive(parts, mimeType) {
	const archive = new JSZip();
	const date = new Date('2020-01-01T00:00:00Z');
	if (mimeType) archive.file('mimetype', mimeType, { compression: 'STORE', date });
	for (const [name, contents] of Object.entries(parts))
		archive.file(name, contents, { date, createFolders: false });
	return archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

function odfFixture(kind, mimeType) {
	const paragraph = '<text:p>Original CC0: Café — 東京 😀. A lantern shone.</text:p>';
	const frame = `<draw:frame draw:name="Original CC0" svg:x="1cm" svg:y="1cm" svg:width="12cm" svg:height="3cm"><draw:text-box>${paragraph}</draw:text-box></draw:frame>`;
	const page = `<draw:page draw:name="Original CC0" draw:style-name="OriginalDrawingPage" draw:master-page-name="Default">${frame}</draw:page>`;
	const bodies = {
		odt: `<office:text>${paragraph}</office:text>`,
		ods: `<office:spreadsheet><table:table table:name="Original CC0"><table:table-row><table:table-cell office:value-type="string">${paragraph}</table:table-cell><table:table-cell office:value-type="float" office:value="42"><text:p>42</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet>`,
		odp: `<office:presentation>${page}</office:presentation>`,
		odg: `<office:drawing>${page}</office:drawing>`,
	};
	assert.ok(bodies[kind], 'Unknown original ODF fixture');
	return officeArchive({
		'content.xml': `<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" office:version="1.3"><office:automatic-styles><style:style style:name="OriginalDrawingPage" style:family="drawing-page"/></office:automatic-styles><office:body>${bodies[kind]}</office:body></office:document-content>`,
		'styles.xml': '<?xml version="1.0" encoding="UTF-8"?><office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.3"><office:styles/><office:automatic-styles><style:page-layout style:name="OriginalPage"><style:page-layout-properties fo:page-width="28cm" fo:page-height="21cm" style:print-orientation="landscape"/></style:page-layout></office:automatic-styles><office:master-styles><style:master-page style:name="Default" style:page-layout-name="OriginalPage"/></office:master-styles></office:document-styles>',
		'meta.xml': '<?xml version="1.0" encoding="UTF-8"?><office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.3"><office:meta><meta:generator>Scrivener MCP synthetic fixture generator</meta:generator><dc:title>Original CC0 fixture</dc:title><dc:description>Original synthetic content dedicated to CC0-1.0.</dc:description></office:meta></office:document-meta>',
		'META-INF/manifest.xml': `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="${mimeType}" manifest:version="1.3"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/></manifest:manifest>`,
	}, mimeType);
}

const OOXML_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

function xlsxFixture() {
	return officeArchive({
		'[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
		'_rels/.rels': `<Relationships xmlns="${PACKAGE_REL}"><Relationship Id="rId1" Type="${OOXML_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
		'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${OOXML_REL}"><sheets><sheet name="Original CC0" sheetId="1" r:id="rId1"/></sheets></workbook>`,
		'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${PACKAGE_REL}"><Relationship Id="rId1" Type="${OOXML_REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
		'xl/worksheets/sheet1.xml': '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Original CC0: Café — 東京 😀.</t></is></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>',
	});
}

function presentationFixture(slideshow) {
	const presentation = 'http://schemas.openxmlformats.org/presentationml/2006/main';
	const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main';
	const namespaces = `xmlns:p="${presentation}" xmlns:a="${drawing}" xmlns:r="${OOXML_REL}"`;
	const group = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
	const shape = '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Original CC0"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="7315200" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Original CC0: Café — 東京 😀. A lantern shone.</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>';
	const relationships = (rows) => `<Relationships xmlns="${PACKAGE_REL}">${rows.map(([id, type, target]) => `<Relationship Id="${id}" Type="${OOXML_REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
	const overrides = [
		['presentation.xml', `application/vnd.openxmlformats-officedocument.presentationml.${slideshow ? 'slideshow' : 'presentation'}.main+xml`],
		['slides/slide1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'],
		['slideLayouts/slideLayout1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml'],
		['slideMasters/slideMaster1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml'],
		['theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml'],
		['presProps.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presProps+xml'],
		['viewProps.xml', 'application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml'],
	];
	const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
	const colors = [['dk1', '000000'], ['lt1', 'FFFFFF'], ['dk2', '222222'], ['lt2', 'EEEEEE'], ['accent1', '7155A0'], ['accent2', '008080'], ['accent3', '808000'], ['accent4', '800080'], ['accent5', '008000'], ['accent6', '800000'], ['hlink', '0000FF'], ['folHlink', '800080']];
	return officeArchive({
		'[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.map(([part, type]) => `<Override PartName="/ppt/${part}" ContentType="${type}"/>`).join('')}</Types>`,
		'_rels/.rels': relationships([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
		'ppt/presentation.xml': `<p:presentation ${namespaces}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000" type="screen4x3"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
		'ppt/_rels/presentation.xml.rels': relationships([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rId2', 'slide', 'slides/slide1.xml'], ['rId3', 'presProps', 'presProps.xml'], ['rId4', 'viewProps', 'viewProps.xml']]),
		'ppt/slides/slide1.xml': `<p:sld ${namespaces}><p:cSld name="Original CC0"><p:spTree>${group}${shape}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
		'ppt/slides/_rels/slide1.xml.rels': relationships([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]),
		'ppt/slideLayouts/slideLayout1.xml': `<p:sldLayout ${namespaces} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${group}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
		'ppt/slideLayouts/_rels/slideLayout1.xml.rels': relationships([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
		'ppt/slideMasters/slideMaster1.xml': `<p:sldMaster ${namespaces}><p:cSld name="Original CC0"><p:spTree>${group}</p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" tx1="dk1" tx2="dk2" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`,
		'ppt/slideMasters/_rels/slideMaster1.xml.rels': relationships([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']]),
		'ppt/theme/theme1.xml': `<a:theme xmlns:a="${drawing}" name="Original CC0"><a:themeElements><a:clrScheme name="Original CC0">${colors.map(([name, value]) => `<a:${name}><a:srgbClr val="${value}"/></a:${name}>`).join('')}</a:clrScheme><a:fontScheme name="Original CC0"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Original CC0"><a:fillStyleLst>${fill.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${[9525, 25400, 38100].map((width) => `<a:ln w="${width}">${fill}<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`).join('')}</a:lnStyleLst><a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${fill.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`,
		'ppt/presProps.xml': `<p:presentationPr xmlns:p="${presentation}"/>`,
		'ppt/viewProps.xml': `<p:viewPr xmlns:p="${presentation}"/>`,
	});
}

function checkImageContainer(mimeType, bytes) {
	if (mimeType === 'image/webp') {
		assert.ok(bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.readUInt32LE(4) + 8 === bytes.length && bytes.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16)), 'WebP fixture must contain an actual RIFF WebP stream');
	} else if (['image/avif', 'image/heic', 'image/heif'].includes(mimeType)) {
		assert.ok(bytes.length >= 16 && bytes.toString('ascii', 4, 8) === 'ftyp', 'HEIF-family fixture must contain an ISO BMFF file type box');
		const end = bytes.readUInt32BE(0);
		assert.ok(end >= 16 && end <= bytes.length && end % 4 === 0);
		const brands = [bytes.toString('ascii', 8, 12)];
		for (let offset = 16; offset < end; offset += 4) brands.push(bytes.toString('ascii', offset, offset + 4));
		const expected = mimeType === 'image/avif' ? ['avif', 'avis'] : mimeType === 'image/heic' ? ['heic', 'heix', 'hevc', 'hevx'] : ['mif1', 'msf1', 'heic', 'heix', 'hevc', 'hevx'];
		assert.ok(expected.some((brand) => brands.includes(brand)), 'Generated ISO BMFF image has an unexpected codec brand');
	} else if (mimeType === 'image/vnd.microsoft.icon') {
		assert.ok(bytes.length >= 22 && bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1 && bytes.readUInt16LE(4) > 0 && 6 + bytes.readUInt16LE(4) * 16 <= bytes.length, 'ICO fixture must contain an actual icon directory');
	}
}

export async function createC2paFixtures(outputDirectory) {
	const stage = await mkdtemp(join(tmpdir(), 'c2pa-assets-'));
	const envNames = ['SCRIVENER_LOCAL_ONLY', 'SCRIVENER_DISABLE_KEY_DISCOVERY', 'SCRIVENER_DATA_DIR'];
	const priorEnv = new Map(envNames.map((name) => [name, process.env[name]]));
	const fixtures = [];
	const unavailable = [];
	const generatedBytes = async (file) => {
		const info = await stat(file);
		assert.ok(info.isFile() && info.size > 0 && info.size <= 1024 * 1024, 'Generated fixture exceeds one MiB');
		return readFile(file);
	};
	const save = async (file, mimeType, bytes, source = 'Node builtins; original synthetic CC0 content') => {
		assert.ok(bytes.length > 0 && bytes.length <= 1024 * 1024, 'Fixture exceeds one MiB');
		await writeFile(join(stage, file), bytes, { mode: 0o644 });
		fixtures.push({ file, mimeType, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), source });
	};
	try {
		await save('image.png', 'image/png', png());
		await save('sound.wav', 'audio/wav', wav());
		const fonts = originalFonts();
		await save('original.ttf', 'font/ttf', fonts.ttf);
		await save('original.woff', 'font/woff', fonts.woff);
		await save('drawing.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#7155a0"/><circle cx="8" cy="8" r="4" fill="#ffffff"/></svg>'));
		for (const [file, mime, text] of [
			['story.txt', 'text/plain', 'Original CC0 fixture: Café — 東京 😀. A lantern shone.\n'],
			['story.md', 'text/markdown', '# Original CC0 story\n\nA lantern shone.\n'],
			['story.html', 'text/html', '<!doctype html><html lang="en"><meta charset="utf-8"><title>Original CC0 story</title><p>A lantern shone.</p></html>\n'],
			['story.json', 'application/json', '{"license":"CC0-1.0","story":"A lantern shone."}\n'],
			['story.csv', 'text/csv', 'title,text\r\n"Original CC0","Café, 東京 😀. A lantern shone."\r\n'],
			['story.tsv', 'text/tab-separated-values', 'title\ttext\nOriginal CC0\tCafé — 東京 😀. A lantern shone.\n'],
			['story.xml', 'application/xml', '<?xml version="1.0" encoding="UTF-8"?><story license="CC0-1.0"><title>Original CC0</title><p>Café — 東京 😀. A lantern shone.</p></story>\n'],
			['story.xhtml', 'application/xhtml+xml', '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en"><head><meta charset="utf-8"/><title>Original CC0</title></head><body><p>Café — 東京 😀. A lantern shone.</p></body></html>\n'],
			['triangle.obj', 'model/obj', '# Original CC0 triangle\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'],
			['triangle.stl', 'model/stl', 'solid original_cc0\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid original_cc0\n'],
		]) await save(file, mime, Buffer.from(text));
		await save('triangle.gltf', 'model/gltf+json', triangle());
		await save('triangle.glb', 'model/gltf-binary', triangle(true));
		await save('opaque.bin', 'application/octet-stream', Buffer.from('Original CC0 opaque fixture\0\x01\x02\x03'));
		for (const [kind, mime] of [
			['odt', 'application/vnd.oasis.opendocument.text'],
			['ods', 'application/vnd.oasis.opendocument.spreadsheet'],
			['odp', 'application/vnd.oasis.opendocument.presentation'],
			['odg', 'application/vnd.oasis.opendocument.graphics'],
		]) await save(`story.${kind}`, mime, await odfFixture(kind, mime), 'Existing JSZip; original synthetic CC0 OpenDocument 1.3 package');
		await save('story.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', await xlsxFixture(), 'Existing JSZip; original synthetic CC0 SpreadsheetML package');
		for (const [extension, type] of [['pptx', 'presentation'], ['ppsx', 'slideshow']])
			await save(`story.${extension}`, `application/vnd.openxmlformats-officedocument.presentationml.${type}`, await presentationFixture(extension === 'ppsx'), 'Existing JSZip; original synthetic CC0 PresentationML package');
		const ffmpeg = (await command('ffmpeg', ['-version'])).stdout.split(/\r?\n/, 1)[0];
		let magickVersion;
		const magickImage = async (file, mimeType) => {
			magickVersion ??= command('magick', ['-version']).then((result) => result.stdout.split(/\r?\n/, 1)[0]);
			const source = await magickVersion;
			const coder = { 'image/webp': 'WEBP', 'image/avif': 'AVIF', 'image/heic': 'HEIC', 'image/heif': 'HEIC', 'image/vnd.microsoft.icon': 'ICO' }[mimeType];
			assert.ok(coder, 'Unknown ImageMagick fixture encoder');
			await command('magick', ['-limit', 'thread', '1', join(stage, 'image.png'), '-strip', '-quality', '85', `${coder}:${join(stage, file)}`]);
			const bytes = await generatedBytes(join(stage, file));
			checkImageContainer(mimeType, bytes);
			await save(file, mimeType, bytes, source);
		};
		const media = [
			['image.jpg', 'image/jpeg', ['-i', join(stage, 'image.png'), '-frames:v', '1']],
			['image.gif', 'image/gif', ['-i', join(stage, 'image.png'), '-frames:v', '1']],
			['image.tiff', 'image/tiff', ['-i', join(stage, 'image.png'), '-frames:v', '1']],
			['image.webp', 'image/webp', ['-i', join(stage, 'image.png'), '-frames:v', '1', '-c:v', 'libwebp']],
			['image.bmp', 'image/bmp', ['-i', join(stage, 'image.png'), '-frames:v', '1']],
			['image.avif', 'image/avif', ['-i', join(stage, 'image.png'), '-frames:v', '1', '-c:v', 'libaom-av1', '-still-picture', '1']],
			['image.jxl', 'image/jxl', ['-i', join(stage, 'image.png'), '-frames:v', '1', '-c:v', 'libjxl']],
			...['mp4', 'mov', 'avi'].map((extension) => [`clip.${extension}`, extension === 'mov' ? 'video/quicktime' : extension === 'avi' ? 'video/x-msvideo' : 'video/mp4', ['-f', 'lavfi', '-i', 'color=c=0x7155a0:s=16x16:r=5', '-t', '0.2', '-an', '-c:v', 'mpeg4']]),
			['clip.webm', 'video/webm', ['-f', 'lavfi', '-i', 'color=c=0x7155a0:s=16x16:r=5', '-t', '0.2', '-an', '-c:v', 'libvpx-vp9']],
			['clip.mkv', 'video/x-matroska', ['-f', 'lavfi', '-i', 'color=c=0x7155a0:s=16x16:r=5', '-t', '0.2', '-an', '-c:v', 'ffv1']],
			...[
				['sound.flac', 'audio/flac', 'flac'], ['sound.mp3', 'audio/mpeg', 'libmp3lame'],
				['sound.m4a', 'audio/mp4', 'aac'], ['sound.aac', 'audio/aac', 'aac'],
				['sound.ogg', 'audio/ogg', 'libvorbis'], ['sound.opus', 'audio/ogg', 'libopus'],
				['sound.aiff', 'audio/aiff', 'pcm_s16be'],
			].map(([file, mime, codec]) => [file, mime, ['-i', join(stage, 'sound.wav'), '-c:a', codec]]),
		];
		for (const [file, mime, args] of media) {
			try {
				await command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, '-threads', '1', join(stage, file)]);
				const bytes = await generatedBytes(join(stage, file));
				checkImageContainer(mime, bytes);
				await save(file, mime, bytes, ffmpeg);
			} catch (error) {
				if (error instanceof assert.AssertionError) throw error;
				if (['image/webp', 'image/avif'].includes(mime)) {
					try { await magickImage(file, mime); continue; }
					catch (fallbackError) { if (fallbackError instanceof assert.AssertionError) throw fallbackError; }
				}
				unavailable.push({ file, mimeType: mime, reason: mime === 'image/jxl' ? 'Local FFmpeg could not produce JPEG XL; no substitute asset was created' : 'Local encoders could not produce this optional fixture' });
			}
		}
		for (const [file, mime] of [['image.heic', 'image/heic'], ['image.heif', 'image/heif'], ['image.ico', 'image/vnd.microsoft.icon']]) {
			try { await magickImage(file, mime); }
			catch (error) {
				if (error instanceof assert.AssertionError) throw error;
				unavailable.push({ file, mimeType: mime, reason: 'Installed ImageMagick could not produce this optional fixture' });
			}
		}
		Object.assign(process.env, { SCRIVENER_LOCAL_ONLY: 'true', SCRIVENER_DISABLE_KEY_DISCOVERY: '1', SCRIVENER_DATA_DIR: stage });
		const exporters = await import(pathToFileURL(join(ROOT, 'dist/services/export/manuscript-exporters.js')).href);
		const { validateExport } = await import(pathToFileURL(join(ROOT, 'dist/services/export/export-presets.js')).href);
		const sections = [{ title: 'Original CC0 chapter', text: 'A lantern shone.\nAn original synthetic fixture for content credential tests.', depth: 0, isFolder: false, sectionType: 'chapter' }];
		for (const [format, mime, fn, preset] of [
			['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'toDocx', 'submission-manuscript'],
			['epub', 'application/epub+zip', 'toEpub', 'ebook'], ['pdf', 'application/pdf', 'toPdf', 'beta-reader'],
		]) {
			const bytes = await exporters[fn](sections, { title: 'Original CC0 fixture', author: 'Scrivener MCP contributors', preset });
			await validateExport(bytes, format);
			await save(`story.${format}`, mime, bytes, 'Existing public manuscript exporter; original synthetic CC0 text');
		}
		await mkdir(outputDirectory, { recursive: true });
		for (const fixture of fixtures) await copyFile(join(stage, fixture.file), join(outputDirectory, fixture.file));
		const index = { schemaVersion: 1, license: 'CC0-1.0', generator: 'scripts/create-c2pa-fixtures.mjs', fixtures, unavailable };
		await writeFile(join(outputDirectory, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
		return index;
	} finally {
		for (const [name, value] of priorEnv) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		await rm(stage, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	assert.ok(process.argv.length === 2 || (process.argv.length === 4 && process.argv[2] === '--output'), 'Use optional --output <directory>');
	const output = resolve(process.argv[3] ?? join(ROOT, 'tests/fixtures/c2pa'));
	const index = await createC2paFixtures(output);
	process.stdout.write(`${JSON.stringify({ ok: true, fixtures: index.fixtures.length, unavailable: index.unavailable })}\n`);
}
