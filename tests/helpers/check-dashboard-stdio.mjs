import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const chrome = [
	process.env.CHROME_BIN,
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	'/usr/bin/google-chrome',
	'/usr/bin/chromium',
].find((file) => file && existsSync(file));
assert(chrome, 'Set CHROME_BIN to a Chromium executable');
const root = await mkdtemp(join(tmpdir(), 'scrivener-apps-wire-'));
const documentId = '10000000-0000-4000-8000-000000000003';
const project = join(root, 'Welcome.scriv');
const rawPath = join(project, 'Files/Data', documentId, 'content.rtf');
const originalRtf = '{\\rtf1\\ansi Mara waited.}';
const metadata = {
	'io.modelcontextprotocol/protocolVersion': '2026-07-28',
	'io.modelcontextprotocol/clientInfo': { name: 'disposable-browser-stdio-host', version: '1' },
	'io.modelcontextprotocol/clientCapabilities': {
		extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } },
	},
};
const transport = new StdioClientTransport({
	command: process.execPath,
	args: ['--import', import.meta.resolve('tsx'), join(sourceRoot, 'src/index.ts')],
	cwd: root,
	stderr: 'pipe',
	env: {
		...getDefaultEnvironment(),
		HOME: root,
		USERPROFILE: root,
		APPDATA: root,
		LOCALAPPDATA: root,
		XDG_CONFIG_HOME: root,
		XDG_DATA_HOME: root,
		SCRIVENER_DATA_DIR: join(root, 'state'),
		SCRIVENER_LOCAL_ONLY: 'true',
		SCRIVENER_DISABLE_KEY_DISCOVERY: '1',
		SCRIVENER_SKIP_SETUP: 'true',
		SCRIVENER_HMS_ENGINE: 'fallback',
		LOG_LEVEL: 'INFO',
	},
});
let nextId = 0;
let stderr = '';
const waiting = new Map();
transport.onmessage = (message) => {
	if ('id' in message) waiting.get(message.id)?.(message);
};
async function request(method, params = {}) {
	const id = ++nextId;
	let timer;
	try {
		const response = new Promise((done, reject) => {
			waiting.set(id, done);
			timer = setTimeout(
				() => reject(new Error(`${method} timed out: ${stderr}`)),
				id === 1 ? 60_000 : 15_000
			);
		});
		await transport.send({
			jsonrpc: '2.0',
			id,
			method,
			params: { ...params, _meta: metadata },
		});
		const reply = await response;
		if (reply.error) throw new Error(JSON.stringify(reply.error));
		return reply.result;
	} finally {
		clearTimeout(timer);
		waiting.delete(id);
	}
}
function successful(result) {
	assert(!result.isError, JSON.stringify(result.content));
	return result;
}
const call = async (name, args) =>
	successful(await request('tools/call', { name, arguments: args }));
const bridgeCalls = [];
let browser;
let server;
let deadline;
try {
	await cp(join(sourceRoot, 'assets/sample-project/Welcome.scriv'), project, { recursive: true });
	await writeFile(rawPath, originalRtf);
	await transport.start();
	transport.stderr?.on('data', (chunk) => {
		stderr = (stderr + String(chunk)).slice(-8192);
	});
	await request('server/discover');
	const opened = await call('open_project', { path: project });
	const projectHandle = opened.structuredContent.projectHandle;
	assert.equal(typeof projectHandle, 'string');
	await call('manuscript_dashboard', { projectHandle, documentId });
	const read = (await call('read_document', { projectHandle, documentId })).structuredContent;
	assert.equal(read.text, 'Mara waited.');
	await call('review_changes', {
		projectHandle,
		action: 'propose',
		documentId,
		expectedRevision: read.revision,
		title: 'Browser fixture correction',
		edits: [{ start: 0, end: 4, text: 'Maria' }],
	});
	const initial = await call('manuscript_dashboard', { projectHandle, documentId });
	let html = (await request('resources/read', { uri: 'ui://scrivener/manuscript-dashboard' }))
		.contents[0].text;
	const dashboardArg = process.argv.indexOf('--dashboard');
	if (dashboardArg >= 0) html = await readFile(resolve(process.argv[dashboardArg + 1]), 'utf8');
	const initialJson = JSON.stringify(initial).replace(/</g, '\\u003c');
	const host = `<!doctype html><html><title>Disposable real stdio Apps host</title><iframe sandbox="allow-scripts allow-same-origin" src="/dashboard"></iframe><script>
const frame = document.querySelector('iframe');
const initial = ${initialJson};
const send = value => frame.contentWindow.postMessage({jsonrpc:'2.0',...value},location.origin);
const finish = result => fetch('/done',{method:'POST',body:JSON.stringify(result)});
const until = async condition => { const end=Date.now()+20000; while(!condition()){const error=frame.contentDocument.getElementById('error').textContent;if(error)throw Error(error);if(Date.now()>end)throw Error('Dashboard condition timed out: '+frame.contentDocument.getElementById('error').textContent);await new Promise(r=>setTimeout(r,30));} };
async function verify(){
 const doc=frame.contentDocument;
 const button=text=>[...doc.querySelectorAll('button')].find(node=>node.textContent===text);
 await until(()=>doc.getElementById('context').textContent.includes('Mara waited.'));
 doc.getElementById('refresh').click();
 await until(()=>doc.getElementById('status').textContent.includes('Saved sources refreshed'));
 button('Load changes').closest('details').open=true;
 button('Load changes').click();
 await until(()=>button('Preview selected'));
 button('Preview selected').click();
 await until(()=>!button('Apply selected').disabled);
 button('Apply selected').click();
 await until(()=>button('Undo this application'));
 const applied=await (await fetch('/check?state=applied')).json();
 if(!applied.ok)throw Error(applied.error);
 button('Undo this application').click();
 await until(()=>doc.getElementById('status').textContent==='Application undone.');
 const undone=await (await fetch('/check?state=undone')).json();
 if(!undone.ok)throw Error(undone.error);
 await finish({ok:true,flow:['open','dashboard','read','propose','preview','apply','undo'],restoredExactRtf:true});
}
window.addEventListener('message',async event=>{
 if(event.source!==frame.contentWindow||event.origin!==location.origin)return;
 const message=event.data;
 try{
  if(message.method==='ui/initialize')send({id:message.id,result:{protocolVersion:'2026-01-26',hostCapabilities:{serverTools:{}},hostContext:{theme:'light'}}});
  else if(message.method==='ui/notifications/initialized'){send({method:'ui/notifications/tool-result',params:initial});verify().catch(error=>finish({ok:false,error:error.message}));}
  else if(message.method==='tools/call'){
   const result=await (await fetch('/tool',{method:'POST',body:JSON.stringify(message.params)})).json();
   send({id:message.id,result});
  }
 }catch(error){send({id:message.id,error:{code:-32603,message:error.message}});finish({ok:false,error:error.message});}
});</script></html>`;
	let complete;
	const done = new Promise((resolve, reject) => {
		complete = resolve;
		deadline = setTimeout(() => reject(new Error('Browser workflow timed out')), 45_000);
	});
	server = createServer(async (req, res) => {
		try {
			if (req.url === '/dashboard') {
				res.setHeader('Content-Type', 'text/html');
				res.end(html);
				return;
			}
			if (req.method === 'POST') {
				const chunks = [];
				let size = 0;
				for await (const chunk of req) {
					size += chunk.length;
					if (size > 256 * 1024) throw new Error('Test-host input limit exceeded');
					chunks.push(chunk);
				}
				const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
				if (req.url === '/done') {
					complete(value);
					res.end('{}');
					return;
				}
				assert.equal(req.url, '/tool');
				assert(['manuscript_dashboard', 'review_changes'].includes(value.name));
				bridgeCalls.push({
					name: value.name,
					action: value.arguments?.action,
					suppliedHandle: value.arguments?.projectHandle === projectHandle,
				});
				const result = await request('tools/call', value);
				res.setHeader('Content-Type', 'application/json');
				res.end(JSON.stringify(result));
				return;
			}
			if (req.url?.startsWith('/check?')) {
				const state = new URL(req.url, 'http://localhost').searchParams.get('state');
				const current = (await call('read_document', { projectHandle, documentId }))
					.structuredContent;
				assert.equal(current.text, state === 'applied' ? 'Maria waited.' : 'Mara waited.');
				if (state === 'undone') assert.equal(await readFile(rawPath, 'utf8'), originalRtf);
				res.setHeader('Content-Type', 'application/json');
				res.end('{"ok":true}');
				return;
			}
			res.setHeader('Content-Type', 'text/html');
			res.end(host);
		} catch (error) {
			res.setHeader('Content-Type', 'application/json');
			res.end(
				JSON.stringify({
					ok: false,
					isError: true,
					error: error.message,
					content: [{ type: 'text', text: error.message }],
				})
			);
		}
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	browser = spawn(
		chrome,
		[
			'--headless',
			'--disable-gpu',
			'--no-sandbox',
			'--no-first-run',
			'--no-default-browser-check',
			`--user-data-dir=${join(root, 'chrome')}`,
			`http://127.0.0.1:${server.address().port}`,
		],
		{ stdio: 'ignore' }
	);
	browser.once('error', (error) => complete({ ok: false, error: error.message }));
	const result = await done;
	const evidence = {
		...result,
		bridgeCalls,
		protocol: '2026-07-28',
		node: process.version,
		host: 'disposable test host with Chromium, actual stdio server; commercial hosts unverified',
	};
	console.log(JSON.stringify(evidence, null, 2));
	assert(result.ok, result.error);
	assert(bridgeCalls.length >= 5);
	assert(bridgeCalls.every((call) => call.suppliedHandle));
} finally {
	clearTimeout(deadline);
	if (browser && browser.exitCode === null && browser.signalCode === null) {
		const closed = new Promise((resolve) => browser.once('close', resolve));
		browser.kill('SIGTERM');
		const killTimer = setTimeout(() => browser.kill('SIGKILL'), 5000);
		try {
			await closed;
		} finally {
			clearTimeout(killTimer);
		}
	}
	if (server)
		await new Promise((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve()))
		);
	await transport.close();
	await rm(root, { recursive: true, force: true });
}
