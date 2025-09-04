import { ScrivenerProject } from '../dist/scrivener-project.js';
import path from 'path';
import { fileURLToPath } from 'url';
import xml2js from 'xml2js';
import fs from 'fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function debug() {
  const projectPath = path.join(__dirname, 'sample-project.scriv');
  
  // Load and parse XML directly
  const xmlPath = path.join(projectPath, 'sample-project.scrivx');
  const xmlContent = await fs.readFile(xmlPath, 'utf-8');
  
  const parser = new xml2js.Parser();
  const result = await new Promise((resolve, reject) => {
    parser.parseString(xmlContent, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
  
  console.log('Direct XML parse:');
  const firstItem = result.ScrivenerProject?.Binder?.[0]?.BinderItem?.[0];
  console.log('First item:');
  console.log('  Attributes ($):', firstItem?.['$']);
  console.log('  Title:', firstItem?.Title);
  console.log('  Title[0]:', firstItem?.Title?.[0]);
  
  // Now test through ScrivenerProject
  console.log('\nThrough ScrivenerProject:');
  const project = new ScrivenerProject(projectPath);
  
  // Add temporary debug logging
  const originalParse = project.parseBinderItem.bind(project);
  project.parseBinderItem = function(item) {
    console.log('\nDEBUG parseBinderItem called with:');
    console.log('  item keys:', Object.keys(item || {}));
    console.log('  item[@]:', item?.['@']);
    console.log('  item[$]:', item?.['$']);
    console.log('  item.Title:', item?.Title);
    const result = originalParse(item);
    console.log('  Result ID:', result.id, 'Title:', result.title);
    return result;
  };
  
  await project.loadProject();
  
  const structure = await project.getProjectStructure();
  console.log('First parsed item:');
  console.log('  ID:', structure[0]?.id);
  console.log('  Title:', structure[0]?.title);
  console.log('  Type:', structure[0]?.type);
  
  // Check the actual path that would be used
  if (structure[0]?.id) {
    console.log('  Path:', structure[0]?.path);
  }
}

debug().catch(console.error);