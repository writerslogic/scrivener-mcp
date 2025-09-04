import { ScrivenerProject } from '../dist/scrivener-project.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const testDir = path.join(__dirname, 'debug-test-project.scriv');
const filesDir = path.join(testDir, 'Files', 'Docs');

async function setup() {
  try { await fs.rm(testDir, { recursive: true }); } catch {}
  await fs.mkdir(filesDir, { recursive: true });

  const scrivxContent = `<?xml version="1.0"?>
<ScrivenerProject Version="1.0">
  <Binder>
    <BinderItem ID="test-doc" Type="Text" Created="2024-01-01 12:00:00">
      <Title>Test Doc</Title>
    </BinderItem>
  </Binder>
</ScrivenerProject>`;

  await fs.writeFile(path.join(testDir, 'debug-test-project.scrivx'), scrivxContent);

  const rtf = `{\\rtf1\\ansi\\deff0 {\\fonttbl{\\f0 Times;}}
\\f0 Initial content\\par
}`;

  await fs.writeFile(path.join(filesDir, 'test-doc.rtf'), rtf);
}

async function test() {
  await setup();

  const project = new ScrivenerProject(testDir);
  await project.loadProject();

  // Read initial
  console.log('1. Reading initial content...');
  const content1 = await project.readDocumentFormatted('test-doc');
  console.log(`   Plain text: "${content1.plainText}"`);
  console.log(`   Formatted segments: ${content1.formattedText.length}`);

  // Check raw RTF
  console.log('\n2. Reading raw RTF...');
  const raw1 = await project.readDocument('test-doc');
  console.log(`   Raw RTF length: ${raw1.length}`);
  console.log(`   Raw preview: ${raw1.substring(0, 50)}...`);

  // Write new content
  console.log('\n3. Writing new content...');
  await project.writeDocument('test-doc', 'New content after write');

  // Read after write
  console.log('\n4. Reading after write...');
  const raw2 = await project.readDocument('test-doc');
  console.log(`   Raw RTF length: ${raw2.length}`);
  console.log(`   Raw preview: ${raw2.substring(0, 50)}...`);

  const content2 = await project.readDocumentFormatted('test-doc');
  console.log(`   Plain text: "${content2.plainText}"`);
  console.log(`   Formatted segments: ${content2.formattedText.length}`);

  // Check file directly
  console.log('\n5. Checking file directly...');
  const filePath = path.join(filesDir, 'test-doc.rtf');
  const fileContent = await fs.readFile(filePath, 'utf-8');
  console.log(`   File length: ${fileContent.length}`);
  console.log(`   File preview: ${fileContent.substring(0, 50)}...`);

  await fs.rm(testDir, { recursive: true });
}

test().catch(console.error);