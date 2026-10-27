import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { RTFHandler } from '../../src/services/parsers/rtf-handler.js';

export const COMPATIBILITY_LAYOUTS = ['mac', 'windows-case', 'windows-renamed'] as const;
export type CompatibilityLayout = typeof COMPATIBILITY_LAYOUTS[number];
export const COMPATIBILITY_IDS = {
	draft: 'A0000000-0000-4000-8000-000000000001',
	chapter: 'A0000000-0000-4000-8000-000000000002',
	scene: 'A0000000-0000-4000-8000-000000000003',
	research: 'A0000000-0000-4000-8000-000000000004',
	image: 'A0000000-0000-4000-8000-000000000005',
	trash: 'A0000000-0000-4000-8000-000000000006',
};

function crc32(bytes: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const bytes = Buffer.alloc(data.length + 12);
	bytes.writeUInt32BE(data.length);
	bytes.write(type, 4, 4, 'ascii');
	data.copy(bytes, 8);
	bytes.writeUInt32BE(crc32(bytes.subarray(4, bytes.length - 4)), bytes.length - 4);
	return bytes;
}

function originalPixel(): Buffer {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(1, 0);
	header.writeUInt32BE(1, 4);
	header[8] = 8;
	header[9] = 6;
	return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(Buffer.from([0, 42, 121, 189, 255]))), pngChunk('IEND', Buffer.alloc(0))]);
}

export async function createCompatibilityProject(root: string, layout: CompatibilityLayout): Promise<{
	projectPath: string;
	scrivxPath: string;
	scenePath: string;
	imagePath: string;
	xml: string;
	raw: string;
	image: Buffer;
	preservedGroups: string[];
}> {
	const mac = layout === 'mac';
	const projectName = mac ? 'Café 東京 Mac' : 'Café 東京 Windows';
	const projectPath = join(root, `${projectName}.scriv`);
	const fileName = mac ? `${projectName}.scrivx` : layout === 'windows-case' ? `${projectName.toLowerCase()}.SCRIVX` : 'Renamed Manuscript.SCRIVX';
	const scrivxPath = join(projectPath, fileName);
	const scenePath = join(projectPath, 'Files', 'Data', COMPATIBILITY_IDS.scene, 'content.rtf');
	const imagePath = join(projectPath, 'Files', 'Data', COMPATIBILITY_IDS.image, 'content.png');
	const ids = COMPATIBILITY_IDS;
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ScrivenerProject Identifier="B0000000-0000-4000-8000-000000000001" Version="2.0" Creator="${mac ? 'SCRMAC-3' : 'SCRWIN-3'}" VendorFlag="keep">
 <Binder>
  <BinderItem UUID="${ids.draft}" Type="DraftFolder" Created="2026-01-01T00:00:00Z" Modified="2026-01-02T00:00:00Z"><Title>Manuscript — 東京</Title><Children>
   <BinderItem UUID="${ids.chapter}" Type="Folder"><Title>Chapter One 🌙</Title><MetaData><SectionType ChildDefault="scene">chapter</SectionType></MetaData><Children>
    <BinderItem UUID="${ids.scene}" Type="Text" VendorFlag="unknown"><Title>Café Żółć — arrival 🕯️</Title><MetaData><IncludeInCompile>Yes</IncludeInCompile><SectionType>scene</SectionType><LabelID>7</LabelID><StatusID>4</StatusID><Keywords><Keyword>harbor</Keyword><Keyword>東京</Keyword></Keywords><CustomMetaData><MetaDataItem ID="storyTime"><Value>2040-06-01</Value></MetaDataItem><MetaDataItem ID="pov"><Value>Mira</Value></MetaDataItem></CustomMetaData></MetaData><TextSettings><Selection Start="4" End="8"/></TextSettings></BinderItem>
   </Children></BinderItem>
  </Children></BinderItem>
  <BinderItem UUID="${ids.research}" Type="ResearchFolder"><Title>Research</Title><Children><BinderItem UUID="${ids.image}" Type="Image"><Title>Original pixel</Title><MetaData><IncludeInCompile>No</IncludeInCompile></MetaData></BinderItem></Children></BinderItem>
  <BinderItem UUID="${ids.trash}" Type="TrashFolder"><Title>Trash</Title></BinderItem>
 </Binder>
 <ProjectSettings><ProjectTitle>Lanterns — 東京 🌙</ProjectTitle><Author>Compatibility fixture contributors</Author></ProjectSettings>
 <SectionTypes><SectionType ID="chapter"><Name>Chapter</Name></SectionType><SectionType ID="scene"><Name>Scene</Name></SectionType></SectionTypes>
 <LabelSettings><Labels><Label ID="7" Color="0.2 0.3 0.4">Blue</Label></Labels></LabelSettings>
 <StatusSettings><Status ID="4">Draft</Status></StatusSettings>
 <VendorData Mode="attribute"><Mode>child</Mode><Entry Key="one">Café 東京 🌙</Entry><Entry Key="two"><Nested Preserve="yes">Żółć</Nested></Entry></VendorData>
</ScrivenerProject>`;
	const image = originalPixel();
	const preservedGroups = ['{\\Scrv_annot\\id7 reviewer}Check navigation{\\Scrv_annot_end}', '{\\Scrv_fn\\id9 source}Original fixture note{\\Scrv_fn_end}', `{\\pict\\pngblip\\picw1\\pich1 ${image.toString('hex')}}`, '{\\*\\FixtureVendor opaque-metadata}'];
	const handler = new RTFHandler();
	const body = handler.convertToRTF({ plainText: '', formattedText: [
		{ text: 'A quiet arrival at the harbor. ' },
		{ text: 'Bold lantern', style: { bold: true } },
		{ text: ' beside ' },
		{ text: 'italic water', style: { italic: true } },
		{ text: '. Café 東京 🌙 — Żółć.\nMira counted the boats.\n' },
	] });
	const raw = `${body.slice(0, -1)}${preservedGroups.join('')}}`;
	await mkdir(join(projectPath, 'Settings'), { recursive: true });
	await mkdir(join(projectPath, 'Files', 'Data', ids.scene), { recursive: true });
	await mkdir(join(projectPath, 'Files', 'Data', ids.image), { recursive: true });
	await writeFile(scrivxPath, xml);
	await writeFile(scenePath, raw);
	await writeFile(imagePath, image);
	await writeFile(join(projectPath, 'Files', 'version.txt'), '3');
	await writeFile(join(projectPath, 'Files', 'Data', 'docs.checksum'), `${ids.scene}/content.rtf=${createHash('sha1').update(raw).digest('hex')}\n`);
	await writeFile(join(projectPath, 'Files', 'Data', ids.scene, 'synopsis.txt'), `Arrival at the café 🌙.${mac ? '\n' : '\r\n'}Mira waits.`);
	await writeFile(join(projectPath, 'Files', 'Data', ids.scene, 'notes.rtf'), handler.convertToRTF('Discuss the harbor map 🗺️.'));
	await writeFile(join(projectPath, 'Settings', mac ? 'ui.plist' : 'ui.ini'), mac ? '<?xml version="1.0"?><plist><dict><key>Fixture</key><true/></dict></plist>' : '[Fixture]\r\nVersion=3\r\n');
	await writeFile(join(projectPath, 'LICENSE.txt'), 'CC0-1.0: original synthetic project, prose, metadata and generated PNG pixel; no third-party manuscript content.');
	return { projectPath, scrivxPath, scenePath, imagePath, xml, raw, image, preservedGroups };
}
