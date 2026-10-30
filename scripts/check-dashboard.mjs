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
const proposalId='20000000-0000-4000-8000-000000000001',editId='20000000-0000-4000-8000-000000000002';
const laterProposalId='20000000-0000-4000-8000-000000000003',applicationId='30000000-0000-4000-8000-000000000001',laterApplicationId='30000000-0000-4000-8000-000000000002';
const cursors={proposals:'proposal-page-2',applications:'application-page-2',findings:'finding-page-2'};
const newline=String.fromCharCode(10),prefix='Saved scene source. <img src=x onerror=alert(1)>'+newline,fragment='Mara waited.'+newline,source=prefix+fragment.repeat(101);
const mentions=Array.from({length:100},(_,index)=>{const start=prefix.length+index*fragment.length;return{start,end:start+4,quote:source.slice(Math.max(0,start-80),start+84)};});
const scene={documentId:'10000000-0000-4000-8000-000000000003',title:'<img src=x onerror=alert(1)> Scene',path:'Manuscript/Scene',revision:'a'.repeat(64),words:source.split(/\\s+/).filter(Boolean).length,pacing:{overall:'fast'},appearances:[{name:'Mara',mentions,truncated:true}]};
const proposal={id:proposalId,documentId:scene.documentId,title:'Sample proposal'};
const laterProposal={id:laterProposalId,documentId:scene.documentId,title:'Later proposal'};
const fullProposal={...proposal,edits:[{id:editId,start:prefix.length,end:prefix.length+4,text:'Maria',status:'pending'}]};
const finding={id:'finding',description:'Candidate eye-color mismatch',confidence:'inferred',evidence:[{projectId:'test-project',documentId:scene.documentId,title:'Scene',path:scene.path,revision:scene.revision,line:1,quote:'Mara waited.'}]};
const laterFinding={...finding,id:'later-finding',description:'Later continuity finding'};
function dashboard(args={}){
  return{projectTitle:'The Lantern at Low Tide',projectId:'test-project',uiSupported:true,
    binder:[{id:scene.documentId,title:'Scene',type:'Text'}],scenes:[scene],
    findings:[args.findingsAfter?laterFinding:finding],proposals:[args.proposalsAfter?laterProposal:proposal],
    applications:args.applicationsAfter?[{id:laterApplicationId,proposalId:laterProposalId,state:'committed'}]:[],
    historyPagination:Object.fromEntries(Object.entries(cursors).filter(([kind])=>!args[kind+'After'])),
    context:args.documentId?{...scene,text:source}:null,pagination:{offset:0,count:1,total:1}};
}
const data=dashboard();
const send=(message)=>frame.contentWindow.postMessage({jsonrpc:'2.0',...message},location.origin);
const check=(value,message)=>{if(!value)throw Error(message);};
const until=async(test)=>{for(let n=0;n<200;n++){if(test())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Timed out awaiting dashboard state');};
const button=(label)=>[...frame.contentDocument.querySelectorAll('button')].find(node=>node.textContent===label);
const exact=(actual,expected,message)=>{check(!!actual,message+' was not sent');const ordered=value=>Object.keys(value).sort().map(key=>[key,value[key]]);check(JSON.stringify(ordered(actual))===JSON.stringify(ordered(expected)),message+' has incorrect protocol arguments');};
const lastDashboard=()=>calls.filter(call=>call.name==='manuscript_dashboard').at(-1);
async function verify(){
  await until(()=>frame.contentDocument.querySelectorAll('#scene-rows tr').length===1);
  const doc=frame.contentDocument;
  check(!doc.querySelector('img'),'manuscript titles must be escaped');
  const filter=doc.getElementById('binder-filter');
  filter.value='absent';filter.dispatchEvent(new Event('input'));
  check(doc.querySelectorAll('#binder button').length===0,'binder filtering must hide unmatched items');
  filter.value='';filter.dispatchEvent(new Event('input'));
  check(doc.querySelectorAll('#binder button').length===1,'binder filtering must restore matching navigation');
  check(doc.querySelector('nav[aria-label="Binder"]'),'binder needs an accessible name');
  check(doc.querySelectorAll('th[scope="col"]').length===4,'scene table must have column headers');
  check(button('Mara (100+)'),'truncated character evidence must display 100+');
  check(button('Load changes')&&!button('Preview selected'),'proposal summaries must load edits on demand');
  check(!calls.some(call=>call.action==='get'),'summaries must not eagerly request full proposals');

  button('More proposals').click();
  await until(()=>doc.getElementById('reviews').textContent.includes('Later proposal'));
  exact(lastDashboard(),{name:'manuscript_dashboard',offset:0,limit:50,proposalsAfter:cursors.proposals},'More proposals');
  check(button('More applications')&&button('More findings'),'other histories must retain their independent next pages');
  button('More applications').click();
  await until(()=>button('Undo Later proposal'));
  exact(lastDashboard(),{name:'manuscript_dashboard',offset:0,limit:50,proposalsAfter:cursors.proposals,applicationsAfter:cursors.applications},'More applications');
  button('More findings').click();
  await until(()=>doc.getElementById('findings').textContent.includes('Later continuity finding'));
  exact(lastDashboard(),{name:'manuscript_dashboard',offset:0,limit:50,proposalsAfter:cursors.proposals,applicationsAfter:cursors.applications,findingsAfter:cursors.findings},'More findings');
  check(!button('More proposals')&&!button('More applications')&&!button('More findings'),'exhausted history pages must not offer another cursor');
  button('First history page').click();
  await until(()=>!button('First history page')&&doc.getElementById('reviews').textContent.includes('Sample proposal'));
  exact(lastDashboard(),{name:'manuscript_dashboard',offset:0,limit:50},'First history page');
  check(button('More proposals')&&button('More applications')&&button('More findings'),'reset must restore each first history page');
  check(doc.getElementById('findings').textContent.includes('Candidate eye-color mismatch'),'reset must restore the initial finding');
  check(!calls.some(call=>call.action==='get'),'history navigation must keep proposal bodies lazy');

  button('Load changes').closest('details').open=true;
  button('Load changes').click();
  await until(()=>button('Preview selected'));
  exact(calls.find(call=>call.action==='get'),{name:'review_changes',action:'get',proposalId},'Load changes');
  check(calls.filter(call=>call.action==='get').length===1,'one load must retrieve one full proposal');
  check(button('Apply selected').disabled,'apply must require preview');
  button('Preview selected').closest('details').open=true;
  button('Preview selected').click();
  await until(()=>!button('Apply selected').disabled);
  exact(calls.find(call=>call.action==='preview'),{name:'review_changes',action:'preview',proposalId,editIds:[editId]},'Preview selected');
  check(doc.querySelectorAll('.pair pre').length===2,'preview needs before and after text');
  button('Apply selected').click();
  await until(()=>doc.getElementById('error').textContent.includes('Acknowledge'));
  check(!calls.some(call=>call.action==='apply'),'lossy edit must require acknowledgment');
  const acknowledgment=[...doc.querySelectorAll('#reviews label')].find(node=>node.textContent.includes('I accept'));
  acknowledgment.querySelector('input').checked=true;
  button('Apply selected').click();
  await until(()=>calls.some(call=>call.action==='apply'));
  exact(calls.find(call=>call.action==='apply'),{name:'review_changes',action:'apply',proposalId,editIds:[editId],allowFormattingLoss:true},'Apply selected');
  await until(()=>button('Undo this application'));
  button('Undo this application').click();
  await until(()=>calls.some(call=>call.action==='undo'));
  exact(calls.find(call=>call.action==='undo'),{name:'review_changes',action:'undo',operationId:applicationId},'Undo this application');
  await until(()=>doc.getElementById('status').textContent==='Application undone.');
  const dashboardsBeforeConfirm=calls.filter(call=>call.name==='manuscript_dashboard').length;
  button('Confirm').closest('details').open=true;
  button('Confirm').click();
  await until(()=>calls.some(call=>call.name==='continuity_findings'));
  exact(calls.find(call=>call.name==='continuity_findings'),{name:'continuity_findings',action:'confirm',findingId:finding.id},'Confirm finding');
  await until(()=>calls.filter(call=>call.name==='manuscript_dashboard').length>dashboardsBeforeConfirm&&doc.getElementById('status').textContent.includes('Saved sources refreshed'));
  button(scene.title).click();
  await until(()=>doc.getElementById('context').textContent.includes('Saved scene source'));
  exact(lastDashboard(),{name:'manuscript_dashboard',offset:0,limit:50,documentId:scene.documentId},'Reveal scene');
  check(!doc.querySelector('img'),'saved manuscript context must remain escaped');
  check(calls.filter(call=>call.action==='preview').length===1,'preview should not apply a mutation');
  check(calls.filter(call=>call.action==='apply').length===1,'application must occur once');
  check(calls.filter(call=>call.action==='undo').length===1,'undo must occur once');
  check(calls.filter(call=>call.name==='continuity_findings').length===1,'finding confirmation must occur once');
  result.textContent='PASS: Apps handshake, accessible navigation, escaped context, 100+ evidence, independent history cursors/reset, lazy proposal loading, preview, formatting acknowledgment, apply, undo, finding review';
}
window.addEventListener('message',event=>{
  if(event.source!==frame.contentWindow)return;
  const message=event.data;
  try{
    if(message.method==='ui/initialize'){
      check(message.params.protocolVersion==='2026-01-26','wrong Apps protocol');
      send({id:message.id,result:{protocolVersion:'2026-01-26',hostCapabilities:{serverTools:{}},hostContext:{theme:'light'}}});
    }else if(message.method==='ui/notifications/initialized'){
      send({method:'ui/notifications/tool-result',params:{structuredContent:data}});
      verify().catch(error=>result.textContent='FAIL: '+error.message);
    }else if(message.method==='tools/call'){
      const {name,arguments:args}=message.params;
      calls.push({name,...args});
      let content;
      if(name==='manuscript_dashboard'){
        for(const [kind,cursor]of Object.entries(cursors))check(args[kind+'After']===undefined||args[kind+'After']===cursor,'unexpected '+kind+' cursor');
        content=dashboard(args);
      }else if(name==='review_changes'&&args.action==='get'){
        check(args.proposalId===proposalId,'unexpected full proposal identity');
        content={result:fullProposal};
      }else if(name==='review_changes'&&args.action==='preview'){
        content={result:{before:source,after:source.slice(0,prefix.length)+'Maria'+source.slice(prefix.length+4),fidelity:{atRisk:['sample annotation relocation']}}};
      }else if(name==='review_changes'&&args.action==='apply'){
        content={result:{id:applicationId,state:'committed'}};
      }else if((name==='review_changes'&&args.action==='undo')||(name==='continuity_findings'&&args.action==='confirm')){
        content={result:{}};
      }else throw Error('Unexpected tool request '+name);
      send({id:message.id,result:{content:[{type:'text',text:'Sample test result'}],structuredContent:content}});
    }
  }catch(error){
    result.textContent='FAIL: '+error.message;
    if(message.id!==undefined)send({id:message.id,error:{code:-32602,message:error.message}});
  }
});
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
	if (process.platform === 'darwin')
		args.unshift('--enable-features=ForceMacVSyncTimerForDebugging');
	if (process.env.DASHBOARD_SCREENSHOT)
		args.unshift('--window-size=1280,1100', '--screenshot=' + process.env.DASHBOARD_SCREENSHOT);
	const { stdout } = await execute(chrome, args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
	const result = /<pre id="result">([^<]*)<\/pre>/.exec(stdout)?.[1];
	assert(result?.startsWith('PASS:'), result || 'browser produced no dashboard result');
	process.stdout.write(`${result}\n`);
} finally {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	await rm(profile, { recursive: true, force: true });
}
