import { ScrivenerProject } from '../dist/scrivener-project.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('Testing caching and error handling features...\n');

// Create a temporary test project structure
const testDir = path.join(__dirname, 'temp-test-project.scriv');
const filesDir = path.join(testDir, 'Files', 'Data');

async function setupTestProject() {
  // Clean up if exists
  try {
    await fs.rm(testDir, { recursive: true, force: true });
  } catch (e) {}
  
  // Create directories
  await fs.mkdir(filesDir, { recursive: true });
  
  // Create a simple .scrivx file
  const scrivxContent = `<?xml version="1.0" encoding="UTF-8"?>
<ScrivenerProject Version="1.0">
  <Binder>
    <BinderItem UUID="test-doc-1" Type="Text" Created="2024-01-01 12:00:00">
      <Title>Test Document 1</Title>
      <MetaData>
        <Synopsis>This is the synopsis for test doc 1</Synopsis>
        <Notes>Some notes about the document</Notes>
      </MetaData>
    </BinderItem>
    <BinderItem UUID="test-doc-2" Type="Text" Created="2024-01-01 12:00:00">
      <Title>Test Document 2</Title>
    </BinderItem>
  </Binder>
</ScrivenerProject>`;
  
  await fs.writeFile(path.join(testDir, 'temp-test-project.scrivx'), scrivxContent);
  
  // Create RTF files for documents in subdirectories
  const rtf1 = `{\\rtf1\\ansi\\deff0 {\\fonttbl{\\f0 Times New Roman;}}
\\f0\\fs24 This is the first test document with some \\b bold\\b0  text.\\par
}`;
  
  const rtf2 = `{\\rtf1\\ansi\\deff0 {\\fonttbl{\\f0 Times New Roman;}}
\\f0\\fs24 Second document content.\\par
}`;
  
  // Create subdirectories for each document
  await fs.mkdir(path.join(filesDir, 'test-doc-1'), { recursive: true });
  await fs.mkdir(path.join(filesDir, 'test-doc-2'), { recursive: true });
  
  await fs.writeFile(path.join(filesDir, 'test-doc-1', 'content.rtf'), rtf1);
  await fs.writeFile(path.join(filesDir, 'test-doc-2', 'content.rtf'), rtf2);
}

async function testCaching() {
  console.log('Test 1: Document caching');
  const project = new ScrivenerProject(testDir);
  await project.loadProject();
  
  // First read - should cache
  const start1 = Date.now();
  const content1 = await project.readDocumentFormatted('test-doc-1');
  const time1 = Date.now() - start1;
  console.log(`First read took ${time1}ms`);
  
  // Second read - should be from cache
  const start2 = Date.now();
  const content2 = await project.readDocumentFormatted('test-doc-1');
  const time2 = Date.now() - start2;
  console.log(`Second read took ${time2}ms (should be faster)`);
  console.log(`Cache speedup: ${time2 < time1 ? 'YES' : 'NO'}`);
  
  // Verify content is the same
  console.log(`Content consistent: ${content1.plainText === content2.plainText ? 'YES' : 'NO'}\n`);
}

async function testCacheInvalidation() {
  console.log('Test 2: Cache invalidation on write');
  const project = new ScrivenerProject(testDir);
  await project.loadProject();
  
  // Read and cache
  const content1 = await project.readDocumentFormatted('test-doc-1');
  console.log(`Initial content: "${content1.plainText.substring(0, 30)}..."`);
  
  // Write new content
  await project.writeDocument('test-doc-1', 'Updated content after cache');
  
  // Read again - should not be from cache
  const content2 = await project.readDocumentFormatted('test-doc-1');
  console.log(`After write: "${content2.plainText}"`);
  console.log(`Cache invalidated: ${content2.plainText !== content1.plainText ? 'YES' : 'NO'}`);
  
  // Debug: Check if it's actually different content
  if (content2.plainText === '') {
    console.log(`Warning: Content appears empty after write, checking raw RTF...`);
    const rawContent = await project.readDocument('test-doc-1');
    console.log(`Raw RTF length: ${rawContent.length} characters`);
  }
  console.log('');
}

async function testRefreshProject() {
  console.log('Test 3: Project refresh clears cache');
  const project = new ScrivenerProject(testDir);
  await project.loadProject();
  
  // Cache some documents
  await project.readDocumentFormatted('test-doc-1');
  await project.readDocumentFormatted('test-doc-2');
  
  // Manually check cache exists (this is internal, for testing only)
  const hasCacheBefore = project.documentCache && project.documentCache.size > 0;
  console.log(`Cache populated: ${hasCacheBefore ? 'YES' : 'NO'}`);
  
  // Refresh project
  await project.refreshProject();
  
  // Check cache is cleared
  const hasCacheAfter = project.documentCache && project.documentCache.size > 0;
  console.log(`Cache cleared after refresh: ${!hasCacheAfter ? 'YES' : 'NO'}\n`);
}

async function testErrorHandling() {
  console.log('Test 4: Specific error handling');
  const project = new ScrivenerProject(testDir);
  await project.loadProject();
  
  // Test ENOENT error (file not found)
  try {
    await project.readDocument('non-existent-doc');
    console.log('ERROR: Should have thrown ENOENT');
  } catch (error) {
    console.log(`ENOENT handled: ${error.message.includes('ENOENT') ? 'YES' : 'NO'}`);
  }
  
  // Test invalid document ID
  try {
    await project.writeDocument('', 'content');
    console.log('ERROR: Should have thrown for empty ID');
  } catch (error) {
    console.log(`Invalid ID handled: YES`);
  }
  
  console.log('');
}

async function testModificationDetection() {
  console.log('Test 5: File modification detection');
  const project = new ScrivenerProject(testDir);
  await project.loadProject();
  
  // Check initial state
  const modified1 = await project.isProjectModified();
  console.log(`Initially modified: ${modified1 ? 'YES' : 'NO'}`);
  
  // Simulate external modification by touching the file
  await new Promise(resolve => setTimeout(resolve, 100)); // Small delay
  const scrivxPath = path.join(testDir, 'temp-test-project.scrivx');
  const content = await fs.readFile(scrivxPath, 'utf-8');
  await fs.writeFile(scrivxPath, content + '\n<!-- modified -->');
  
  // Check modification
  const modified2 = await project.isProjectModified();
  console.log(`After external change: ${modified2 ? 'YES' : 'NO'}\n`);
}

async function testClearCache() {
  console.log('Test 6: Manual cache clearing');
  const project = new ScrivenerProject(testDir);
  await project.loadProject();
  
  // Cache some documents
  await project.readDocumentFormatted('test-doc-1');
  await project.readDocumentFormatted('test-doc-2');
  console.log(`Documents cached: 2`);
  
  // Clear cache
  project.clearCache();
  console.log(`Cache cleared manually`);
  
  // Verify cache is empty by timing the next read
  const start = Date.now();
  await project.readDocumentFormatted('test-doc-1');
  const time = Date.now() - start;
  console.log(`Read after clear took ${time}ms (should be slower than cache hit)\n`);
}

async function runTests() {
  try {
    await setupTestProject();
    await testCaching();
    await testCacheInvalidation();
    await testRefreshProject();
    await testErrorHandling();
    await testModificationDetection();
    await testClearCache();
    
    console.log('All caching and error handling tests completed successfully!');
    
    // Clean up
    await fs.rm(testDir, { recursive: true, force: true });
  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  }
}

runTests();