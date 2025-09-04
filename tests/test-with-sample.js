import { ScrivenerProject } from '../dist/scrivener-project.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('Testing with actual sample-project.scriv...\n');

async function runTests() {
  try {
    const projectPath = path.join(__dirname, 'sample-project.scriv');
    const project = new ScrivenerProject(projectPath);
    await project.loadProject();
    
    console.log('Test 1: Project Structure');
    const structure = await project.getProjectStructure();
    console.log(`  Root items: ${structure.length}`);
    if (structure[0]) {
      console.log(`  First item: "${structure[0].title}" (ID: ${structure[0].id}, Type: ${structure[0].type})`);
    }
    
    console.log('\nTest 2: Get All Documents');
    const allDocs = await project.getAllDocuments();
    console.log(`  Total documents: ${allDocs.length}`);
    const textDocs = allDocs.filter(d => d.type === 'Text');
    console.log(`  Text documents: ${textDocs.length}`);
    const folders = allDocs.filter(d => d.type === 'Folder');
    console.log(`  Folders: ${folders.length}`);
    
    console.log('\nTest 3: Read Document Content');
    if (textDocs.length > 0) {
      const firstDoc = textDocs[0];
      console.log(`  Reading: "${firstDoc.title}" (${firstDoc.id})`);
      
      try {
        const content = await project.readDocumentFormatted(firstDoc.id);
        console.log(`    Plain text: ${content.plainText.substring(0, 100)}...`);
        console.log(`    Formatted segments: ${content.formattedText.length}`);
        
        // Check for formatting
        const hasBold = content.formattedText.some(s => s.style?.bold);
        const hasItalic = content.formattedText.some(s => s.style?.italic);
        console.log(`    Has bold: ${hasBold}, Has italic: ${hasItalic}`);
      } catch (e) {
        console.log(`    Error reading: ${e.message}`);
      }
    }
    
    console.log('\nTest 4: Word Count');
    if (textDocs.length > 0) {
      const doc = textDocs[Math.min(2, textDocs.length - 1)];
      const stats = await project.getWordCount(doc.id);
      console.log(`  Document: "${doc.title}"`);
      console.log(`  Words: ${stats.words}, Characters: ${stats.characters}`);
    }
    
    console.log('\nTest 5: Search Content');
    const searchResults = await project.searchContent('test');
    console.log(`  Found "test" in ${searchResults.length} documents`);
    if (searchResults.length > 0) {
      searchResults.slice(0, 3).forEach(result => {
        console.log(`    - ${result.title}: ${result.matches.length} matches`);
      });
    }
    
    console.log('\nTest 6: Compile Documents');
    const toCompile = textDocs.slice(0, 3).map(d => d.id);
    if (toCompile.length > 0) {
      const compiled = await project.compileDocuments(toCompile, '\n\n---\n\n', 'text');
      console.log(`  Compiled ${toCompile.length} documents`);
      console.log(`  Total length: ${compiled.length} characters`);
      console.log(`  Preview: "${compiled.substring(0, 100)}..."`);
    }
    
    console.log('\nTest 7: Cache Performance');
    if (textDocs.length > 1) {
      const testDoc = textDocs[1];
      
      // First read (cold)
      const start1 = Date.now();
      await project.readDocumentFormatted(testDoc.id);
      const time1 = Date.now() - start1;
      
      // Second read (cached)
      const start2 = Date.now();
      await project.readDocumentFormatted(testDoc.id);
      const time2 = Date.now() - start2;
      
      console.log(`  First read: ${time1}ms`);
      console.log(`  Cached read: ${time2}ms`);
      console.log(`  Speedup: ${time1 > 0 ? Math.round(time1 / time2) : 0}x`);
    }
    
    console.log('\nTest 8: Document Hierarchy');
    const rootFolder = structure.find(d => d.type === 'Folder');
    if (rootFolder) {
      console.log(`  Root folder: "${rootFolder.title}"`);
      console.log(`  Children: ${rootFolder.children?.length || 0}`);
      
      if (rootFolder.children && rootFolder.children.length > 0) {
        const firstChild = rootFolder.children[0];
        console.log(`  First child: "${firstChild.title}" (${firstChild.type})`);
      }
    }
    
    console.log('\nTest 9: Refresh Project');
    const modifiedBefore = await project.isProjectModified();
    console.log(`  Modified before refresh: ${modifiedBefore}`);
    
    await project.refreshProject();
    console.log(`  Project refreshed successfully`);
    
    const modifiedAfter = await project.isProjectModified();
    console.log(`  Modified after refresh: ${modifiedAfter}`);
    
    console.log('\nAll tests completed successfully!');
    
  } catch (error) {
    console.error('Test failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

runTests();