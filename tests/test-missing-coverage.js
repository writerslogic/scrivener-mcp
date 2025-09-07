import { ScrivenerProject } from '../dist/scrivener-project.js';
import { RTFHandler } from '../dist/services/parsers/rtf-handler.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('Testing missing coverage areas...\n');

// Create a test project
const testDir = path.join(__dirname, 'coverage-test.scriv');
const filesDir = path.join(testDir, 'Files', 'Data');

async function setupTestProject() {
  try {
    await fs.rm(testDir, { recursive: true, force: true });
  } catch {}
  
  await fs.mkdir(filesDir, { recursive: true });
  
  const scrivxContent = `<?xml version="1.0" encoding="UTF-8"?>
<ScrivenerProject Version="1.0">
  <ProjectSettings>
    <ProjectTitle>Test Project</ProjectTitle>
    <FullName>Test Author</FullName>
  </ProjectSettings>
  <ProjectTargets>
    <DraftTarget>50000</DraftTarget>
    <SessionTarget>1000</SessionTarget>
    <Deadline>2024-12-31</Deadline>
  </ProjectTargets>
  <Binder>
    <BinderItem UUID="root-folder" Type="Folder">
      <Title>Root Folder</Title>
      <Children>
        <BinderItem UUID="doc-1" Type="Text">
          <Title>Document One</Title>
          <MetaData>
            <Synopsis>This is document one synopsis</Synopsis>
            <Notes>Notes for document one</Notes>
            <Label>Important</Label>
            <Status>Draft</Status>
            <Keywords>test;sample;document</Keywords>
            <CustomMetaData>
              <MetaDataItem ID="priority">High</MetaDataItem>
              <MetaDataItem ID="reviewer">John Doe</MetaDataItem>
            </CustomMetaData>
          </MetaData>
        </BinderItem>
        <BinderItem UUID="doc-2" Type="Text">
          <Title>Document Two</Title>
          <MetaData>
            <IncludeInCompile>No</IncludeInCompile>
          </MetaData>
        </BinderItem>
        <BinderItem UUID="subfolder" Type="Folder">
          <Title>Subfolder</Title>
          <Children>
            <BinderItem UUID="doc-3" Type="Text">
              <Title>Document Three</Title>
            </BinderItem>
          </Children>
        </BinderItem>
      </Children>
    </BinderItem>
    <BinderItem UUID="doc-4" Type="Text">
      <Title>Root Document</Title>
    </BinderItem>
  </Binder>
</ScrivenerProject>`;
  
  await fs.writeFile(path.join(testDir, 'coverage-test.scrivx'), scrivxContent);
  
  // Create RTF files
  const rtfHandler = new RTFHandler();
  
  // Document 1 with annotations
  const doc1Dir = path.join(filesDir, 'doc-1');
  await fs.mkdir(doc1Dir, { recursive: true });
  const rtf1 = `{\\rtf1\\ansi\\deff0 {\\fonttbl{\\f0 Times New Roman;}}
\\f0\\fs24 Document one content with \\b bold\\b0  text.
{\\Scrv_annot\\id1}This is an annotation{\\Scrv_annot_end}
{\\Scrv_comm\\id2}This is a comment{\\Scrv_comm_end}
\\par
}`;
  await fs.writeFile(path.join(doc1Dir, 'content.rtf'), rtf1);
  
  // Document 2
  const doc2Dir = path.join(filesDir, 'doc-2');
  await fs.mkdir(doc2Dir, { recursive: true });
  await rtfHandler.writeRTF(path.join(doc2Dir, 'content.rtf'), 'Document two content');
  
  // Document 3
  const doc3Dir = path.join(filesDir, 'doc-3');
  await fs.mkdir(doc3Dir, { recursive: true });
  await rtfHandler.writeRTF(path.join(doc3Dir, 'content.rtf'), 'Document three in subfolder');
  
  // Document 4
  const doc4Dir = path.join(filesDir, 'doc-4');
  await fs.mkdir(doc4Dir, { recursive: true });
  await rtfHandler.writeRTF(path.join(doc4Dir, 'content.rtf'), 'Root level document');
}

async function testDeleteDocument() {
  console.log('Test 1: Delete Document');
  const project = new ScrivenerProject(testDir);
  await project.loadProject();
  
  const initialDocs = await project.getAllDocuments();
  const initialCount = initialDocs.length;
  console.log(`  Initial document count: ${initialCount}`);
  console.log(`  Available docs: ${initialDocs.map(d => d.id).slice(0, 3).join(', ')}`);
  
  // Delete a document
  await project.deleteDocument('doc-2');
  
  const afterDocs = await project.getAllDocuments();
  const afterCount = afterDocs.length;
  console.log(`  After deletion count: ${afterCount}`);
  console.log(`  Document deleted: ${initialCount - afterCount === 1 ? 'YES' : 'NO'}`);
  
  // Check file is deleted
  const doc2Path = path.join(filesDir, 'doc-2', 'content.rtf');
  try {
    await fs.access(doc2Path);
    console.log(`  File removed: NO`);
  } catch {
    console.log(`  File removed: YES`);
  }
  
  // Try to delete non-existent document
  try {
    await project.deleteDocument('non-existent');
    console.log(`  Non-existent deletion handled: NO`);
  } catch (error) {
    console.log(`  Non-existent deletion handled: YES`);
  }
  
  console.log('');
}

async function testMoveDocument() {
  console.log('Test 2: Move Document');
  const project = new ScrivenerProject(testDir);
  await project.loadProject();
  
  // Check initial parent
  const structure = await project.getProjectStructure();
  const rootFolder = structure.find(d => d.id === 'root-folder');
  const hasDoc1Initially = rootFolder?.children?.some(c => c.id === 'doc-1');
  console.log(`  Document in root folder initially: ${hasDoc1Initially ? 'YES' : 'NO'}`);
  
  // Move doc-1 to subfolder
  await project.moveDocument('doc-1', 'subfolder');
  
  // Reload and check
  await project.loadProject();
  const newStructure = await project.getProjectStructure();
  const newRootFolder = newStructure.find(d => d.id === 'root-folder');
  const subfolder = newRootFolder?.children?.find(c => c.id === 'subfolder');
  const hasDoc1InSubfolder = subfolder?.children?.some(c => c.id === 'doc-1');
  
  console.log(`  Document moved to subfolder: ${hasDoc1InSubfolder ? 'YES' : 'NO'}`);
  
  // Move to root
  await project.moveDocument('doc-1', null);
  await project.loadProject();
  const finalStructure = await project.getProjectStructure();
  const atRoot = finalStructure.some(d => d.id === 'doc-1');
  console.log(`  Document moved to root: ${atRoot ? 'YES' : 'NO'}`);
  
  // Try to move to non-folder
  try {
    await project.moveDocument('doc-1', 'doc-4');
    console.log(`  Move to non-folder prevented: NO`);
  } catch {
    console.log(`  Move to non-folder prevented: YES`);
  }
  
  console.log('');
}

async function testRenameDocument() {
  console.log('Test 3: Rename Document');
  const project = new ScrivenerProject(testDir);
  await project.loadProject();
  
  // Get original title
  const docs = await project.getAllDocuments();
  const doc = docs.find(d => d.id === 'doc-3');
  const originalTitle = doc?.title;
  console.log(`  Original title: "${originalTitle}"`);
  
  // Rename
  const newTitle = 'Renamed Document Three';
  await project.renameDocument('doc-3', newTitle);
  
  // Reload and check
  await project.loadProject();
  const newDocs = await project.getAllDocuments();
  const renamedDoc = newDocs.find(d => d.id === 'doc-3');
  console.log(`  New title: "${renamedDoc?.title}"`);
  console.log(`  Rename successful: ${renamedDoc?.title === newTitle ? 'YES' : 'NO'}`);
  
  // Try to rename non-existent
  try {
    await project.renameDocument('non-existent', 'New Name');
    console.log(`  Non-existent rename handled: NO`);
  } catch {
    console.log(`  Non-existent rename handled: YES`);
  }
  
  console.log('');
}

async function testSaveProject() {
  console.log('Test 4: Save Project');
  const project = new ScrivenerProject(testDir);
  await project.loadProject();
  
  // Modify project (create new document)
  const newId = await project.createDocument('root-folder', 'New Document', 'Text');
  console.log(`  Created document: ${newId}`);
  
  // Save explicitly
  await project.saveProject();
  console.log(`  Project saved`);
  
  // Create new project instance and verify changes persist
  const project2 = new ScrivenerProject(testDir);
  await project2.loadProject();
  const docs = await project2.getAllDocuments();
  const hasNewDoc = docs.some(d => d.id === newId);
  console.log(`  Changes persisted: ${hasNewDoc ? 'YES' : 'NO'}`);
  
  console.log('');
}

async function testUpdateMetadata() {
  console.log('Test 5: Update Metadata');
  const project = new ScrivenerProject(testDir);
  await project.loadProject();
  
  // Get original metadata
  const docs = await project.getAllDocuments();
  const doc = docs.find(d => d.id === 'doc-1');
  console.log(`  Original label: "${doc?.label}"`);
  console.log(`  Original custom data:`, doc?.customMetadata);
  
  // Update metadata
  await project.updateMetadata('doc-1', {
    title: 'Updated Title',
    keywords: ['new', 'updated', 'keywords'],
    customFields: {
      priority: 'Low',
      reviewer: 'Jane Smith',
      newField: 'New Value'
    }
  });
  
  // Reload and check
  await project.loadProject();
  const updatedDocs = await project.getAllDocuments();
  const updatedDoc = updatedDocs.find(d => d.id === 'doc-1');
  console.log(`  Updated title: "${updatedDoc?.title}"`);
  console.log(`  Updated keywords:`, updatedDoc?.keywords);
  console.log(`  Updated custom data:`, updatedDoc?.customMetadata);
  
  const hasNewField = updatedDoc?.customMetadata?.newField === 'New Value';
  console.log(`  New field added: ${hasNewField ? 'YES' : 'NO'}`);
  
  console.log('');
}

async function testGetDocumentAnnotations() {
  console.log('Test 6: Get Document Annotations');
  const project = new ScrivenerProject(testDir);
  await project.loadProject();
  
  // Get annotations from doc-1
  const annotations = await project.getDocumentAnnotations('doc-1');
  console.log(`  Annotations found: ${annotations.size}`);
  
  for (const [key, value] of annotations) {
    console.log(`    - ${key}: "${value}"`);
  }
  
  const hasAnnot = annotations.has('annot_1');
  const hasComm = annotations.has('comm_2');
  console.log(`  Has annotation: ${hasAnnot ? 'YES' : 'NO'}`);
  console.log(`  Has comment: ${hasComm ? 'YES' : 'NO'}`);
  
  // Try document without annotations
  const noAnnotations = await project.getDocumentAnnotations('doc-4');
  console.log(`  Document without annotations: ${noAnnotations.size === 0 ? 'EMPTY' : 'NOT EMPTY'}`);
  
  console.log('');
}

async function testMergeRTFFiles() {
  console.log('Test 7: Merge RTF Files');
  const handler = new RTFHandler();
  
  // Create test RTF files
  const file1 = path.join(__dirname, 'test1.rtf');
  const file2 = path.join(__dirname, 'test2.rtf');
  const file3 = path.join(__dirname, 'test3.rtf');
  
  await handler.writeRTF(file1, {
    plainText: 'First document content',
    formattedText: [
      { text: 'First ', style: {} },
      { text: 'document', style: { bold: true } },
      { text: ' content', style: {} }
    ]
  });
  
  await handler.writeRTF(file2, 'Second document plain text');
  
  await handler.writeRTF(file3, {
    plainText: 'Third document',
    formattedText: [
      { text: 'Third ', style: { italic: true } },
      { text: 'document', style: {} }
    ]
  });
  
  // Merge files
  const merged = await handler.mergeRTFFiles([file1, file2, file3]);
  console.log(`  Merged RTF length: ${merged.length} characters`);
  
  // Parse merged to verify
  const parsed = await handler.parseRTF(merged);
  console.log(`  Merged plain text length: ${parsed.plainText.length}`);
  console.log(`  Contains all content: ${parsed.plainText.includes('First') && parsed.plainText.includes('Second') && parsed.plainText.includes('Third') ? 'YES' : 'NO'}`);
  
  // Clean up
  await fs.unlink(file1);
  await fs.unlink(file2);
  await fs.unlink(file3);
  
  console.log('');
}

async function testCreateFolder() {
  console.log('Test 8: Create Folder');
  const project = new ScrivenerProject(testDir);
  await project.loadProject();
  
  // Create a new folder
  const folderId = await project.createDocument(null, 'New Test Folder', 'Folder');
  console.log(`  Created folder ID: ${folderId}`);
  
  // Verify it's a folder
  const docs = await project.getAllDocuments();
  const folder = docs.find(d => d.id === folderId);
  console.log(`  Is folder type: ${folder?.type === 'Folder' ? 'YES' : 'NO'}`);
  
  // Add document to folder
  const docId = await project.createDocument(folderId, 'Document in New Folder', 'Text');
  
  // Reload and verify hierarchy
  await project.loadProject();
  const structure = await project.getProjectStructure();
  const newFolder = structure.find(d => d.id === folderId);
  const hasChild = newFolder?.children?.some(c => c.id === docId);
  console.log(`  Child document added: ${hasChild ? 'YES' : 'NO'}`);
  
  console.log('');
}

async function testErrorScenarios() {
  console.log('Test 9: Error Handling Scenarios');
  const project = new ScrivenerProject(testDir);
  await project.loadProject();
  
  // Test moving non-existent document
  try {
    await project.moveDocument('fake-id', null);
    console.log(`  Move non-existent: NOT CAUGHT`);
  } catch (e) {
    console.log(`  Move non-existent: CAUGHT`);
  }
  
  // Test creating document with invalid parent
  try {
    await project.createDocument('invalid-parent', 'Test Doc');
    console.log(`  Invalid parent: NOT CAUGHT`);
  } catch (e) {
    console.log(`  Invalid parent: CAUGHT`);
  }
  
  // Test updating metadata for non-existent document
  try {
    await project.updateMetadata('fake-id', { title: 'Test' });
    console.log(`  Update non-existent: NOT CAUGHT`);
  } catch (e) {
    console.log(`  Update non-existent: CAUGHT`);
  }
  
  // Test getting annotations for non-existent document
  try {
    await project.getDocumentAnnotations('fake-id');
    console.log(`  Annotations non-existent: NOT CAUGHT`);
  } catch (e) {
    console.log(`  Annotations non-existent: CAUGHT`);
  }
  
  console.log('');
}

async function testEdgeCases() {
  console.log('Test 10: Edge Cases');
  const project = new ScrivenerProject(testDir);
  
  // Test saving without loading
  try {
    const emptyProject = new ScrivenerProject(testDir);
    await emptyProject.saveProject();
    console.log(`  Save without load: NOT CAUGHT`);
  } catch (e) {
    console.log(`  Save without load: CAUGHT`);
  }
  
  await project.loadProject();
  
  // Test empty metadata update
  await project.updateMetadata('doc-1', {});
  console.log(`  Empty metadata update: PASSED`);
  
  // Test moving document to itself (should be no-op)
  const beforeStructure = JSON.stringify(await project.getProjectStructure());
  await project.moveDocument('subfolder', 'subfolder');
  const afterStructure = JSON.stringify(await project.getProjectStructure());
  console.log(`  Self-move is no-op: ${beforeStructure === afterStructure ? 'YES' : 'NO'}`);
  
  // Test creating document with empty title
  const emptyTitleId = await project.createDocument(null, '', 'Text');
  const docs = await project.getAllDocuments();
  const emptyDoc = docs.find(d => d.id === emptyTitleId);
  console.log(`  Empty title document created: ${emptyDoc ? 'YES' : 'NO'}`);
  
  console.log('');
}

async function runTests() {
  try {
    await setupTestProject();
    
    await testDeleteDocument();
    await testMoveDocument();
    await testRenameDocument();
    await testSaveProject();
    await testUpdateMetadata();
    await testGetDocumentAnnotations();
    await testMergeRTFFiles();
    await testCreateFolder();
    await testErrorScenarios();
    await testEdgeCases();
    
    console.log('All missing coverage tests completed successfully!');
    
    // Clean up
    await fs.rm(testDir, { recursive: true, force: true });
  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  }
}

runTests();