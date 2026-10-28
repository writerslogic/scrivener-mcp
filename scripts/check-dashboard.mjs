import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const html = await readFile(
	new URL('../assets/manuscript-dashboard.html', import.meta.url),
	'utf8'
);
assert(!/https?:\/\//.test(html), 'dashboard must not load external resources');
assert(html.includes("connect-src 'none'"), 'dashboard must deny external connections');
const candidates = [
	process.env.CHROME_BIN,
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	'/usr/bin/google-chrome',
	'/usr/bin/chromium',
	'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
	'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
const chrome = candidates.find((file) => existsSync(file));
if (!chrome)
	throw new Error('Set CHROME_BIN to a Chromium browser to run dashboard interaction checks');
const profile = await mkdtemp(join(tmpdir(), 'scrivener-dashboard-browser-'));
const harness = `<!doctype html><html lang="en"><title>Dashboard test host</title><body><pre id="result">RUNNING</pre><iframe title="Manuscript dashboard test" style="width:100%;height:1600px;border:0" src="/dashboard"></iframe><script>
const frame=document.querySelector('iframe'),result=document.getElementById('result'),calls=[];
const scene={documentId:'10000000-0000-4000-8000-000000000003',title:'<img src=x onerror=alert(1)> Scene',path:'Manuscript/Scene',revision:'a'.repeat(64),words:12,pacing:{overall:'fast'},appearances:[{name:'Mara',mentions:[{start:0,end:4,quote:'Mara waited at the harbor.'}]}]};
const data={projectTitle:'The Lantern at Low Tide',projectId:'test-project',uiSupported:true,binder:[{id:scene.documentId,title:'Scene',type:'Text'}],scenes:[scene],findings:[{id:'finding',description:'Candidate eye-color mismatch',confidence:'inferred',evidence:[{projectId:'test-project',documentId:scene.documentId,title:'Scene',path:'Manuscript/Scene',revision:scene.revision,line:1,quote:'Mara waited.'}]}],proposals:[{id:'20000000-0000-4000-8000-000000000001',documentId:scene.documentId,title:'Sample proposal',edits:[{id:'20000000-0000-4000-8000-000000000002',start:0,end:4,text:'Maria',status:'pending'}]}],context:null,pagination:{offset:0,count:1,total:1}};
const send=(message)=>frame.contentWindow.postMessage({jsonrpc:'2.0',...message},location.origin);
const check=(value,message)=>{if(!value)throw Error(message);};
const until=async(test)=>{for(let n=0;n<200;n++){if(test())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Timed out awaiting dashboard state');};
const button=(label)=>[...frame.contentDocument.querySelectorAll('button')].find(node=>node.textContent===label);
async function verify(){await until(()=>frame.contentDocument.querySelectorAll('#scene-rows tr').length===1);const doc=frame.contentDocument;check(!doc.querySelector('img'),'manuscript titles must be escaped');const filter=doc.getElementById('binder-filter');filter.value='absent';filter.dispatchEvent(new Event('input'));check(doc.querySelectorAll('#binder button').length===0,'binder filtering must hide unmatched items');filter.value='';filter.dispatchEvent(new Event('input'));check(doc.querySelectorAll('#binder button').length===1,'binder filtering must restore matching navigation');check(doc.querySelector('nav[aria-label="Binder"]'),'binder needs an accessible name');check(doc.querySelectorAll('th[scope="col"]').length===4,'scene table must have column headers');check(button('Apply selected').disabled,'apply must require preview');button('Preview selected').closest('details').open=true;button('Preview selected').click();await until(()=>!button('Apply selected').disabled);check(doc.querySelectorAll('.pair pre').length===2,'preview needs before and after text');button('Apply selected').click();await until(()=>doc.getElementById('error').textContent.includes('Acknowledge'));check(!calls.some(call=>call.action==='apply'),'lossy edit must require acknowledgment');const acknowledgment=[...doc.querySelectorAll('#reviews label')].find(node=>node.textContent.includes('I accept'));acknowledgment.querySelector('input').checked=true;button('Apply selected').click();await until(()=>calls.some(call=>call.action==='apply'));await until(()=>button('Undo this application'));button('Undo this application').click();await until(()=>calls.some(call=>call.action==='undo'));button('Confirm').closest('details').open=true;button('Confirm').click();await until(()=>calls.some(call=>call.name==='continuity_findings'));button(scene.title).click();await until(()=>doc.getElementById('context').textContent.includes('Saved scene source'));check(calls.filter(call=>call.action==='preview').length===1,'preview should not apply a mutation');check(calls.filter(call=>call.action==='apply').length===1,'application must occur once');check(calls.find(call=>call.action==='apply').allowFormattingLoss===true,'application must forward formatting acknowledgment');result.textContent='PASS: Apps handshake, accessible navigation, escaped context, preview, formatting acknowledgment, apply, undo, finding review';}
window.addEventListener('message',event=>{if(event.source!==frame.contentWindow)return;const message=event.data;if(message.method==='ui/initialize'){check(message.params.protocolVersion==='2026-01-26','wrong Apps protocol');send({id:message.id,result:{protocolVersion:'2026-01-26',hostCapabilities:{serverTools:{}},hostContext:{theme:'light'}}});}else if(message.method==='ui/notifications/initialized'){send({method:'ui/notifications/tool-result',params:{structuredContent:data}});verify().catch(error=>result.textContent='FAIL: '+error.message);}else if(message.method==='tools/call'){const {name,arguments:args}=message.params;calls.push({name,...args});let content;if(name==='manuscript_dashboard')content={...data,context:args.documentId?{...scene,text:'Saved scene source with Mara.'}:null};else if(name==='review_changes'&&args.action==='preview')content={result:{before:'Mara waited.',after:'Maria waited.',fidelity:{atRisk:['sample annotation relocation']}}};else if(name==='review_changes'&&args.action==='apply')content={result:{id:'30000000-0000-4000-8000-000000000001',state:'committed'}};else content={result:{}};send({id:message.id,result:{content:[{type:'text',text:'Sample test result'}],structuredContent:content}});}});
</script></body></html>`;
const server = createServer((request, response) => {
	response.setHeader('Content-Type', 'text/html; charset=utf-8');
	response.end(request.url === '/dashboard' ? html : harness);
});
try {
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	const args = [
		'--headless',
		'--disable-gpu',
		'--disable-background-networking',
		'--no-first-run',
		'--no-default-browser-check',
		'--disable-dev-shm-usage',
		`--user-data-dir=${profile}`,
		'--dump-dom',
		'--virtual-time-budget=15000',
		`http://127.0.0.1:${address.port}`,
	];
	if (process.getuid?.() === 0) args.unshift('--no-sandbox');
	if (process.env.DASHBOARD_SCREENSHOT)
		args.unshift('--window-size=1280,1100', '--screenshot=' + process.env.DASHBOARD_SCREENSHOT);
	const { stdout } = await execute(chrome, args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
	const result = /<pre id="result">([^<]*)<\/pre>/.exec(stdout)?.[1];
	assert(result?.startsWith('PASS:'), result || 'browser produced no dashboard result');
	process.stdout.write(`${result}\n`);
} finally {
	await new Promise((resolve) => server.close(resolve));
	await rm(profile, { recursive: true, force: true });
}
