// Exercise real stdio MCP writes against a disposable COPY, never the source.
// Optional argument: a closed Scrivener project's .scriv directory to copy.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseStringPromise } from 'xml2js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ProjectLoader } from '../dist/services/project-loader.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(process.argv[2] ?? path.join(repo, 'tests/sample-project.scriv'));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scrivener-mcp-save-check-'));
const projectPath = path.join(root, 'XML Save Verification.scriv');
await fs.cp(source, projectPath, { recursive: true, errorOnExist: true, force: false });
// A copied fixture may contain its author's old app lock. Only clear the COPY.
await fs.rm(path.join(projectPath, 'Files/user.lock'), { force: true });
const files = (await fs.readdir(projectPath)).filter((name) => /\.scrivx$/i.test(name));
assert.equal(files.length, 1);
const scrivxPath = path.join(projectPath, 'XML Save Verification.scrivx');
// Match the package name so Scrivener will not rename the manifest on close.
if (files[0] !== path.basename(scrivxPath)) {
	await fs.rename(path.join(projectPath, files[0]), scrivxPath);
}
const beforeBytes = await fs.readFile(scrivxPath);
const parse = (xml) => parseStringPromise(xml, { explicitArray: false });
const before = await parse(beforeBytes.toString('utf8'));
const loader = new ProjectLoader(projectPath);
await loader.loadProject();
await loader.saveProject();
assert.deepEqual(await parse(await fs.readFile(scrivxPath, 'utf8')), before);
const env = Object.fromEntries(
	Object.entries(process.env).filter(([key]) =>
		/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|HOME|APPDATA|LOCALAPPDATA)$/i.test(
			key
		)
	)
);
Object.assign(env, {
	SCRIVENER_MCP_EAGER_TOOLS: '1',
	SCRIVENER_SKIP_SETUP: 'true',
	SCRIVENER_QUIET: 'true',
	SCRIVENER_DISABLE_KEY_DISCOVERY: '1',
	LOG_LEVEL: 'ERROR',
});
const transport = new StdioClientTransport({
	command: process.execPath,
	args: [path.join(repo, 'scripts/codex-launcher.mjs')],
	cwd: root,
	env,
	stderr: 'pipe',
});
transport.stderr.on('data', () => {});
const client = new Client({ name: 'scrivener-save-regression', version: '1.0.0' });
const call = async (name, args = {}) => {
	const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
	assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`);
	return result;
};
const title = 'Codex XML 저장 검증';
const content = 'XML 속성과 한글 본문 저장을 검증합니다.\n\n두 번째 문단입니다.';
try {
	await client.connect(transport, { timeout: 60000 });
	const { tools } = await client.listTools();
	assert.ok(tools.some((tool) => tool.name === 'create_document'));
	await call('open_project', { path: projectPath });
	assert.deepEqual(
		await parse(await fs.readFile(scrivxPath, 'utf8')),
		before,
		'Unchanged save must preserve the XML tree'
	);
	const result = await call('create_document', { title, content, documentType: 'Text' });
	const documentId = result.structuredContent.documentId;
	assert.ok(documentId);
	const contentPath = path.join(projectPath, 'Files/Data', documentId, 'content.rtf');
	for (let attempt = 0; attempt < 60; attempt++) {
		try {
			await fs.access(contentPath);
			break;
		} catch {
			await delay(200);
		}
	}
	await fs.access(contentPath);
	await call('refresh_project');
	const read = await call('read_document', { documentId, format: 'plain' });
	assert.equal(
		read.content
			.filter((block) => block.type === 'text')
			.map((block) => block.text)
			.join('\n')
			.trim(),
		content
	);
	await loader.reloadProject();
	await loader.saveProject();
	const after = await parse(await fs.readFile(scrivxPath, 'utf8'));
	const items = after.ScrivenerProject.Binder.BinderItem;
	const added = items.find((item) => item.$?.UUID === documentId);
	assert.ok(added, 'New root document must have native UUID and Type attributes');
	assert.equal(added.$.Type, 'Text');
	assert.equal(added.Title, title);
	after.ScrivenerProject.Binder.BinderItem = items.filter((item) => item !== added);
	assert.deepEqual(after, before, 'Existing XML must be unchanged after document creation');
	assert.deepEqual(
		await fs.readFile(path.join(source, files[0])),
		beforeBytes,
		'Source project must remain unchanged'
	);
	const report = {
		status: 'SCRIVENER_FORK_MCP_SAVE_VERIFIED',
		projectPath,
		scrivxPath,
		documentId,
		title,
		toolCount: tools.length,
		unchangedSave: true,
		originalXmlPreserved: true,
		koreanBodyReadBack: true,
		sourceUnchanged: true,
	};
	await fs.writeFile(path.join(root, 'verification.json'), JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report, null, 2));
} finally {
	await client.close();
}
