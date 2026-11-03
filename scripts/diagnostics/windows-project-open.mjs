import { readFileSync, writeFileSync } from 'node:fs';

function edit(file, replacements, importPath) {
  let text = readFileSync(file, 'utf8');
  for (const [before, after] of replacements) {
    const count = text.split(before).length - 1;
    if (count !== 1) throw new Error(`${file}: expected one match, got ${count}: ${before}`);
    text = text.replace(before, after);
  }
  text = `import { mark, timed } from '${importPath}';\n` + text;
  writeFileSync(file, text);
}
const wrap = (expression, label, invocation = expression.slice(6)) => [expression, `await timed('${label}', () => ${invocation})`];
edit('src/handlers/project-handlers/lifecycle.ts', [
  ["\thandler: async (args, context): Promise<HandlerResult> => {\n\t\treturn withProjectLifecycle(context, async () => {\n\t\t\tvalidateInput(args, {", "\thandler: async (args, context): Promise<HandlerResult> => {\n\t\tmark('handler:received');\n\t\treturn withProjectLifecycle(context, async () => {\n\t\t\tmark('handler:admitted');\n\t\t\tvalidateInput(args, {"],
  wrap('await resolveScrivenerProjectPath(rawPath)', 'resolve-path'),
  ['await retireProject(context);\n\n\t\t\tconst project = new ScrivenerProject', "await timed('retire-project', () => retireProject(context));\n\n\t\t\tconst project = new ScrivenerProject"],
  wrap('await project.loadProject()', 'project-load'),
  wrap('await memoryManager.initialize()', 'memory-init', 'memoryManager!.initialize()'),
  wrap('await project.getProjectMetadata()', 'metadata'),
  ['\t\t\t\treturn result;', "\t\t\t\tmark('handler:completed');\n\t\t\t\treturn result;"]
], '../../diagnostic-phase.js');
edit('src/scrivener-project.ts', [
  wrap('await ensureProjectDataDirectory(this.projectPath)', 'data-directory'),
  wrap('await this.projectLoader.loadProject()', 'project-loader'),
  ['const documents = await this.getProjectStructure();\n\t\tawait documentIndexer.buildIndex(documents);', "const documents = await timed('get-structure', () => this.getProjectStructure());\n\t\tawait documentIndexer.buildIndex(documents);"],
  wrap('await documentIndexer.buildIndex(documents)', 'build-index'),
  wrap('await this.databaseService.initialize()', 'project-database'),
  ['await initializeAsyncServices({', "await timed('async-services', () => initializeAsyncServices({"],
  ["\t\t\topenaiApiKey: process.env.OPENAI_API_KEY,\n\t\t});", "\t\t\topenaiApiKey: process.env.OPENAI_API_KEY,\n\t\t}));"],
  wrap('await this.performInitialSync()', 'initial-sync')
], './diagnostic-phase.js');
edit('src/handlers/database/database-service.ts', [
  wrap('await ensureDir(this.paths.databaseDir)', 'database-ensure-dir'),
  wrap('await DatabaseSetup.getCredentials({ projectPath })', 'database-credentials'),
  wrap('await DatabaseSetup.checkNeo4jAvailability()', 'neo4j-discovery'),
  wrap('await this.saveConfig()', 'database-save-config'),
  wrap('await this.sqliteManager.initialize()', 'sqlite-init', 'this.sqliteManager!.initialize()'),
  wrap('await this.migrationManager.migrate()', 'database-migrations', 'this.migrationManager!.migrate()')
], '../../diagnostic-phase.js');
edit('src/handlers/database/database-setup.ts', [
  wrap("await execAsync('neo4j version 2>/dev/null')", 'neo4j-cli'),
  wrap("await execAsync('docker --version 2>/dev/null')", 'docker-version'),
  wrap("await execAsync('docker ps --format \"table {{.Names}}\" 2>/dev/null')", 'docker-ps'),
  wrap("await import('neo4j-driver')", 'neo4j-driver-import'),
  wrap('await driver.verifyConnectivity()', 'neo4j-connect'),
  wrap('await driver.close()', 'neo4j-close')
], '../../diagnostic-phase.js');
edit('src/handlers/database/sqlite-manager.ts', [
  wrap('await ensureDir(dir)', 'sqlite-ensure-dir'),
  ["\t\t\t\t\t\tthis.db = new Database(this.dbPath);", "\t\t\t\t\t\tmark('sqlite-open:start');\n\t\t\t\t\t\tthis.db = new Database(this.dbPath);\n\t\t\t\t\t\tmark('sqlite-open:end');"],
  ["\t\t\t\tthis.db!.exec('PRAGMA journal_mode = WAL;');", "\t\t\t\tmark('sqlite-pragmas:start');\n\t\t\t\tthis.db!.exec('PRAGMA journal_mode = WAL;');"],
  ["\t\t\t\tconst stats = fs.statSync(this.dbPath);", "\t\t\t\tmark('sqlite-pragmas:end');\n\t\t\t\tconst stats = fs.statSync(this.dbPath);"],
  wrap('await this.createTables()', 'sqlite-tables'),
  wrap('await this.cachedManager.initialize()', 'sqlite-cache', 'this.cachedManager!.initialize()')
], '../../diagnostic-phase.js');
edit('src/services/queue/job-queue.ts', [
  wrap('await realpath(this.projectPath)', 'queue-realpath', 'realpath(this.projectPath!)'),
  ["\t\t\t\tthis.embeddedStore = new PersistentStore(statePath);", "\t\t\t\tmark('queue-store:start');\n\t\t\t\tthis.embeddedStore = new PersistentStore(statePath);\n\t\t\t\tmark('queue-store:end');"],
  ['await detectConnection(\n\t\t\t\toptions.redisUrl !== undefined ? [options.redisUrl] : undefined\n\t\t\t)', "await timed('queue-detect-connection', () => detectConnection(\n\t\t\t\toptions.redisUrl !== undefined ? [options.redisUrl] : undefined\n\t\t\t))"],
  wrap('await this.databaseService.initialize()', 'queue-database', 'this.databaseService!.initialize()')
], '../../diagnostic-phase.js');
edit('tests/unit/handlers/tool-protocol.test.ts', [
  ["test('real stdio dispatch distinguishes", "process.env.SCRIVENER_DIAGNOSTIC_ENABLED = '1';\n\ntest('real stdio dispatch distinguishes"],
  ["\t\t\t...getDefaultEnvironment(),\n\t\t\tHOME: root,", "\t\t\t...getDefaultEnvironment(),\n\t\t\tSCRIVENER_DIAGNOSTIC_DIR: process.env.SCRIVENER_DIAGNOSTIC_DIR!,\n\t\t\tSCRIVENER_DIAGNOSTIC_ENABLED: '1',\n\t\t\tHOME: root,"],
  ["\t\t\t...getDefaultEnvironment(),\n\t\t\tSCRIVENER_LOCAL_ONLY: 'true',", "\t\t\t...getDefaultEnvironment(),\n\t\t\tSCRIVENER_DIAGNOSTIC_DIR: process.env.SCRIVENER_DIAGNOSTIC_DIR!,\n\t\t\tSCRIVENER_DIAGNOSTIC_ENABLED: '1',\n\t\t\tSCRIVENER_LOCAL_ONLY: 'true',"],
  ["\t\tconst result = await client.callTool({ name, arguments: args }, undefined, {\n\t\t\ttimeout: 10000,\n\t\t});", "\t\tconst result = await timed(name === 'open_project' ? 'client-open' : '', () => client.callTool({ name, arguments: args }, undefined, {\n\t\t\ttimeout: 10000,\n\t\t}));"],
  ["\t\tconst id = ++nextId;\n\t\tlet timeout:", "\t\tconst id = ++nextId;\n\t\tconst opening = method === 'tools/call' && params.name === 'open_project';\n\t\tif (opening) mark('modern-client-open:start');\n\t\tlet timeout:"],
  ["\t\t\tclearTimeout(timeout);\n\t\t\twaiting.delete(id);", "\t\t\tclearTimeout(timeout);\n\t\t\twaiting.delete(id);\n\t\t\tif (opening) mark('modern-client-open:end');"]
], '../../../src/diagnostic-phase.js');
writeFileSync('src/diagnostic-phase.ts', `import { appendFileSync } from 'node:fs';\nimport { join } from 'node:path';\nexport function mark(phase: string): void {\n  if (!phase || process.env.SCRIVENER_DIAGNOSTIC_ENABLED !== '1' || !process.env.SCRIVENER_DIAGNOSTIC_DIR) return;\n  appendFileSync(join(process.env.SCRIVENER_DIAGNOSTIC_DIR, process.pid + '.jsonl'), JSON.stringify({phase, pid: process.pid, wall: Date.now(), monotonic: Number(process.hrtime.bigint()) / 1e6}) + '\\n');\n}\nexport async function timed<T>(phase: string, fn: () => Promise<T>): Promise<T> {\n  if (!phase) return fn();\n  mark(phase + ':start');\n  try { return await fn(); } finally { mark(phase + ':end'); }\n}\n`);
