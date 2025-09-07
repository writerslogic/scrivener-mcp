import { ScrivenerProject } from '../dist/scrivener-project.js';
import { RTFHandler } from '../dist/services/parsers/rtf-handler.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('Testing with sample-project.scriv file...\n');

async function createSampleProjectDirectory() {
  // The sample-project.scriv is an XML file, we need to create a proper project structure
  const projectDir = path.join(__dirname, 'test-sample.scriv');
  const filesDir = path.join(projectDir, 'Files', 'Docs');
  
  // Clean up if exists
  try {
    await fs.rm(projectDir, { recursive: true, force: true });
  } catch (e) {}
  
  // Create directories
  await fs.mkdir(filesDir, { recursive: true });
  
  // Copy the XML content to the correct location
  const xmlContent = await fs.readFile(path.join(__dirname, 'sample-project.scriv'), 'utf-8');
  await fs.writeFile(path.join(projectDir, 'test-sample.scrivx'), xmlContent);
  
  // Create sample RTF files for the documents in the XML
  const rtfHandler = new RTFHandler();
  
  // Chapter 1
  await rtfHandler.writeRTF(
    path.join(filesDir, '0A8D9F2B-B597-400D-96EF-1A8A2F226019.rtf'),
    {
      plainText: 'The old lighthouse keeper squinted at the horizon, watching the storm clouds gather with practiced eyes. He had seen many storms in his forty years at this post, but something about this one felt different.',
      formattedText: [
        { text: 'The old lighthouse keeper squinted at the horizon, watching the storm clouds gather with practiced eyes. ', style: {} },
        { text: 'He had seen many storms in his forty years at this post, ', style: { italic: true } },
        { text: 'but something about this one felt different.', style: {} }
      ]
    }
  );
  
  // Chapter 2
  await rtfHandler.writeRTF(
    path.join(filesDir, '5D7E8B8B-F69C-4D78-A68C-C78C9E23B10A.rtf'),
    'When the letter arrived, Marcus knew his quiet life was over. The seal bore the mark of the High Council, and such summons were never refused.'
  );
  
  // Chapter 3
  await rtfHandler.writeRTF(
    path.join(filesDir, '5C2A5954-A61F-4B9F-8468-B7C501B646D0.rtf'),
    {
      plainText: 'Elias stood at the threshold, his packed bag heavy on his shoulder. Behind him lay everything he had ever known; ahead, only uncertainty.',
      formattedText: [
        { text: 'Elias stood at the threshold, ', style: {} },
        { text: 'his packed bag heavy on his shoulder', style: { bold: true } },
        { text: '. Behind him lay everything he had ever known; ahead, only uncertainty.', style: {} }
      ]
    }
  );
  
  // Research Notes
  await rtfHandler.writeRTF(
    path.join(filesDir, '87C6A67D-F0B5-4FED-B08D-F42B6B8C9E2A.rtf'),
    `Research on medieval lighthouse construction:
- Stone towers were most common
- Oil lamps used before electric lights
- Keeper families often lived on-site
- Storm signals were crucial for nearby villages`
  );
  
  return projectDir;
}

async function runTests() {
  try {
    // Setup the project directory
    const projectDir = await createSampleProjectDirectory();
    const project = new ScrivenerProject(projectDir);
    await project.loadProject();
    
    console.log('Test 1: Project Structure');
    const allDocs = await project.getAllDocuments();
    console.log(`  Total documents found: ${allDocs.length}`);
    console.log(`  Document types: ${[...new Set(allDocs.map(d => d.type))].join(', ')}`);
    
    console.log('\nTest 2: Reading Document Metadata');
    console.log('  Available documents:');
    allDocs.slice(0, 5).forEach(d => console.log(`    - "${d.title}" (${d.id})`));
    
    const chapter1 = allDocs.find(d => d.title === 'Chapter 1: The Call');
    if (chapter1) {
      console.log(`  Chapter 1 ID: ${chapter1.id}`);
      console.log(`  Chapter 1 metadata:`, chapter1.metadata || 'No metadata');
    } else {
      console.log('  Chapter 1 not found');
    }
    
    console.log('\nTest 3: Document Content');
    if (chapter1) {
      const content = await project.readDocumentFormatted(chapter1.id);
      console.log(`  Plain text length: ${content.plainText.length} characters`);
      console.log(`  Formatted segments: ${content.formattedText.length}`);
      console.log(`  First 100 chars: "${content.plainText.substring(0, 100)}..."`);
    }
    
    console.log('\nTest 4: Document Hierarchy');
    const manuscript = allDocs.find(d => d.title === 'Manuscript');
    if (manuscript) {
      console.log(`  Manuscript has ${manuscript.children?.length || 0} children`);
      const act1 = manuscript.children?.find(c => c.title === 'Act I');
      if (act1) {
        console.log(`  Act I has ${act1.children?.length || 0} chapters`);
      }
    }
    
    console.log('\nTest 5: Compiling Documents');
    const textDocs = allDocs.filter(d => d.type === 'Text').map(d => d.id);
    const compiled = await project.compileDocuments(textDocs.slice(0, 3), '\n\n---\n\n', 'text');
    console.log(`  Compiled text length: ${compiled.length} characters`);
    console.log(`  Preview: "${compiled.substring(0, 150)}..."`);
    
    console.log('\nTest 6: Word Count');
    if (chapter1) {
      const stats = await project.getStatistics(chapter1.id);
      console.log(`  Chapter 1 word count: ${stats.words}`);
      console.log(`  Chapter 1 character count: ${stats.characters}`);
    }
    
    console.log('\nTest 7: Search Content');
    const searchResults = await project.searchContent('storm', { caseSensitive: false });
    console.log(`  Found "storm" in ${searchResults.length} documents`);
    searchResults.forEach(result => {
      console.log(`    - ${result.title}: ${result.matches.length} matches`);
    });
    
    console.log('\nTest 8: Cache Performance');
    if (chapter1) {
      const start1 = Date.now();
      await project.readDocumentFormatted(chapter1.id);
      const time1 = Date.now() - start1;
      
      const start2 = Date.now();
      await project.readDocumentFormatted(chapter1.id);
      const time2 = Date.now() - start2;
      
      console.log(`  First read: ${time1}ms`);
      console.log(`  Cached read: ${time2}ms`);
      console.log(`  Cache effective: ${time2 < time1 ? 'YES' : 'NO'}`);
    }
    
    console.log('\nTest 9: Creating New Document');
    const newDoc = await project.createDocument(
      manuscript?.id || null,
      'New Test Chapter',
      'Text',
      'This is a test chapter created by the test suite.'
    );
    console.log(`  Created document ID: ${newDoc.id}`);
    console.log(`  Document saved to project`);
    
    console.log('\nTest 10: Project Metadata');
    const projectMeta = await project.getProjectMetadata();
    console.log(`  Custom metadata items: ${Object.keys(projectMeta.customMetadata || {}).length}`);
    console.log(`  Labels defined: ${projectMeta.labels?.length || 0}`);
    console.log(`  Status values defined: ${projectMeta.statusValues?.length || 0}`);
    
    console.log('\nAll tests completed successfully!');
    
    // Clean up
    await fs.rm(projectDir, { recursive: true, force: true });
    
  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  }
}

runTests();