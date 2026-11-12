import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const script = pathToFileURL(resolve(__dirname, '../../../scripts/coverage-ledger.mjs')).href;
const fixture = `
import { createHash } from 'node:crypto';
import { attachConformanceReceipt, buildCoverageLedger, inspectConformancePlan } from ${JSON.stringify(script)};
const hash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const tools = [
 {name:'review',inputSchema:{properties:{action:{enum:['apply','list','undo']},limit:{minimum:1,maximum:100},modes:{items:{enum:['raw','configured']}}}},outputSchema:{type:'object'}},
 {name:'get_structure',inputSchema:{type:'object'},outputSchema:{type:'object'}},
 {name:'open_project',inputSchema:{type:'object'}},
 {name:'close_project',inputSchema:{type:'object'}},
 {name:'untested',inputSchema:{type:'object'},outputSchema:{type:'object'}}
];
const plan=inspectConformancePlan("const PLAN = [['review', {action:'apply'}, {id:'review.apply',after: () => {}}], ['review', {action:'list',limit:0}, {id:'review.refuse.zero',expectError:'limit must be'}]];");
const ledger=buildCoverageLedger(tools,plan);
const manifest=[{path:'src/review.ts',sha256:hash('source')},{path:'dist/review.js',sha256:hash('build')}];
const identity={revision:'a'.repeat(40),receiptSha256:hash('receipt'),executionInputs:Object.fromEntries(manifest.map(x=>[x.path,x.sha256])),inventoryInputs:{'src/review.ts':hash('source'),'docs/unrelated.md':hash('different inventory-only document')}};
const cases=[
 {id:'review.apply',tool:'review',status:'PASS',expectedOutcome:'success',expectedError:null,inputSchemaSha256:hash(tools[0].inputSchema),outputSchemaSha256:hash(tools[0].outputSchema),inputSha256:hash({action:'apply'}),inputSelector:{action:'apply'},outcome:'success',schema:'valid',resultSha256:hash({}),postcondition:'passed'},
 {id:'review.refuse.zero',tool:'review',status:'PASS',expectedOutcome:'refusal',expectedError:'limit must be',inputSchemaSha256:hash(tools[0].inputSchema),outputSchemaSha256:hash(tools[0].outputSchema),inputSha256:hash({action:'list',limit:0}),inputSelector:{action:'list',limit:0},outcome:'thrown-error',schema:'not-returned',detail:'limit must be >= 1'},
 {id:'project.structure.nonempty',tool:'get_structure',status:'PASS',inputSha256:hash({}),inputSelector:{},outputSchemaSha256:hash(tools[1].outputSchema),outcome:'success',schema:'valid',resultSha256:hash({})},
 ...[['lifecycle.open','open_project'],['lifecycle.close','close_project']].map(([id,tool])=>({id,tool,status:'PASS',outcome:'success',schema:'not-advertised',assertion:'Fixture lifecycle assertion'}))
];
const receipt={version:1,repositoryRevision:identity.revision,startedAt:'2026-11-11T00:00:00.000Z',finishedAt:'2026-11-11T00:00:01.000Z',boundary:'Direct registered handlers in one local process; fixture',runtime:{node:'v26.12.1',platform:'darwin',arch:'arm64'},provenance:{files:manifest,sha256:hash(manifest)},registry:tools.map(t=>({name:t.name,outputSchemaSha256:t.outputSchema?hash(t.outputSchema):null})),cases,summary:{cases:5,pass:5,fail:0,schemaValidatedSuccesses:2,expectedRefusals:1}};
`;

async function inspect(mutation = '', projection = 'result') {
	const { stdout } = await execute(process.execPath, [
		'--input-type=module',
		'-e',
		fixture +
			mutation +
			`
const before=JSON.stringify(ledger);
const result=attachConformanceReceipt(ledger,tools,plan,receipt,identity);
if(JSON.stringify(ledger)!==before)throw Error('Original inventory mutated');
process.stdout.write(JSON.stringify(${projection}));
`,
	]);
	return JSON.parse(stdout);
}

it('links actual success/refusal cases while leaving complete coverage, bounds and transports unknown', async () => {
	const result = await inspect();
	expect(result.summary).toMatchObject({
		verifiedRuntimeCases: 3,
		observedSuccess: 2,
		observedRefusal: 1,
		nonqualifyingAcknowledgments: 2,
	});
	const review = result.tools.find((entry: { tool: string }) => entry.tool === 'review');
	expect(review.observedSuccess).toEqual([
		expect.objectContaining({ id: 'review.apply', inputSelector: { action: 'apply' } }),
	]);
	expect(review.observedRefusal).toEqual([
		expect.objectContaining({ id: 'review.refuse.zero', schema: 'not-returned' }),
	]);
	expect(Object.values(review.coverage).every((value) => value === 'U')).toBe(true);
	expect(
		review.inputBranches.find((entry: { value?: string }) => entry.value === 'apply')
	).toMatchObject({ status: 'U', observedSuccess: ['review.apply'], observedRefusal: [] });
	expect(
		review.inputBranches.find((entry: { value?: string }) => entry.value === 'list')
	).toMatchObject({ status: 'U', observedSuccess: [], observedRefusal: ['review.refuse.zero'] });
	for (const branch of review.inputBranches.filter(
		(entry: { value?: string; kind: string }) =>
			entry.value === 'undo' || entry.kind === 'boundary'
	))
		expect(branch).toMatchObject({ status: 'U', observedSuccess: [], observedRefusal: [] });
	expect(result.tools.find((entry: { tool: string }) => entry.tool === 'untested')).toMatchObject(
		{ observedSuccess: [], observedRefusal: [] }
	);
	expect(result.receiptEvidence.nonqualifying).toHaveLength(2);
});

it.each([
	['source hash changed', "identity.executionInputs['src/review.ts']=hash('changed');", 'stale'],
	['build hash changed', "identity.executionInputs['dist/review.js']=hash('changed');", 'stale'],
	[
		'inventory source diverged',
		"identity.inventoryInputs['src/review.ts']=hash('changed');",
		'inventory source differs',
	],
	['manifest omitted input', "identity.executionInputs['dist/new.js']=hash('new');", 'omits'],
	[
		'manifest duplicate',
		'receipt.provenance.files.push(receipt.provenance.files[0]);receipt.provenance.sha256=hash(receipt.provenance.files);',
		'duplicate manifest',
	],
	[
		'manifest traversal',
		"receipt.provenance.files[0].path='../outside';receipt.provenance.sha256=hash(receipt.provenance.files);",
		'manifest entry',
	],
	['manifest digest corrupted', "receipt.provenance.sha256='0'.repeat(64);", 'manifest digest'],
	['revision changed', "receipt.repositoryRevision='b'.repeat(40);", 'revision differs'],
	[
		'registry schema changed',
		"receipt.registry[0].outputSchemaSha256='0'.repeat(64);",
		'output schema',
	],
	[
		'case input schema changed',
		"receipt.cases[0].inputSchemaSha256='0'.repeat(64);",
		'input schema',
	],
	['failed case', "receipt.cases[0].status='FAIL';", 'did not pass'],
	['failed summary', 'receipt.summary.fail=1;', 'summary'],
	['duplicate case', 'receipt.cases[1]=receipt.cases[0];', 'duplicate'],
	['unknown case', "receipt.cases[0].id='not.in.plan';", 'unknown case'],
	['wrong tool', "receipt.cases[0].tool='untested';", 'tool differs'],
	[
		'changed actual selector',
		"receipt.cases[0].inputSelector.action='undo';",
		'literal selector',
	],
	['unexpected refusal', "receipt.cases[0].outcome='returned-error';", 'success lacks'],
	['unrelated thrown refusal', "receipt.cases[1].detail='disk full';", 'reason differs'],
	['malformed schema receipt', "receipt.cases[0].schema='invalid';", 'success lacks'],
	[
		'failed postcondition',
		"receipt.cases[0].postcondition='failed-or-not-run';",
		'postcondition',
	],
	['misrepresented transport', "receipt.boundary='Modern MCP stdio';", 'boundary'],
])('rejects %s without attaching evidence', async (_label, mutation, message) => {
	await expect(inspect(mutation)).rejects.toThrow(message);
});

it('qualifies returned provider refusals separately even when their error payload is schema-valid', async () => {
	const result = await inspect(
		"receipt.cases[1].outcome='returned-error';receipt.cases[1].schema='valid';receipt.cases[1].resultSha256=hash({unavailable:true});"
	);
	expect(result.summary).toMatchObject({ observedSuccess: 2, observedRefusal: 1 });
	expect(
		result.tools.find((entry: { tool: string }) => entry.tool === 'review').observedRefusal[0]
	).toMatchObject({ outcome: 'returned-error', schema: 'valid' });
});

it('does not infer array, nested or defaulted selections from a plan or tool name', async () => {
	const result = await inspect(
		"plan[0].inputs.modes=['raw'];receipt.cases[0].inputSelector.nested={characters:250,sha256:hash('hidden')};"
	);
	const branches = result.tools.find(
		(entry: { tool: string }) => entry.tool === 'review'
	).inputBranches;
	for (const branch of branches.filter((entry: { path: string }) => entry.path === '$.modes[]'))
		expect(branch).toMatchObject({ status: 'U', observedSuccess: [], observedRefusal: [] });
});

it('checks literal inputs with the producer redactor and never promotes masked selectors', async () => {
	const result = await inspect(`
identity.redactDiagnostics = value => Object.fromEntries(Object.entries(value).map(([key,item]) => [key,key==='content'?'[redacted]':item]));
plan[0].inputs.content='Synthetic prose';
receipt.cases[0].inputSelector.content='[redacted]';
ledger.tools.find(item=>item.tool==='review').inputBranches.push({kind:'enum',path:'$.content',value:'[redacted]',status:'U'});
`);
	const review = result.tools.find((entry: { tool: string }) => entry.tool === 'review');
	expect(review.observedSuccess[0].unavailableSelectors).toEqual(['content']);
	expect(
		review.inputBranches.find((entry: { path: string }) => entry.path === '$.content')
	).toMatchObject({ status: 'U', observedSuccess: [], observedRefusal: [] });
});

it('bounds receipt reads at 8 MiB and refuses malformed UTF-8', async () => {
	const root = await mkdtemp(resolve(tmpdir(), 'receipt-read-'));
	const file = resolve(root, 'receipt.json');
	const read = () =>
		execute(process.execPath, [
			'--input-type=module',
			'-e',
			`import {readConformanceReceipt} from ${JSON.stringify(script)}; await readConformanceReceipt(process.argv[1]);`,
			file,
		]);
	try {
		for (const size of [8 * 1024 * 1024 - 1, 8 * 1024 * 1024]) {
			await writeFile(file, '{}' + ' '.repeat(size - 2));
			await expect(read()).resolves.toBeDefined();
		}
		await writeFile(file, '{}' + ' '.repeat(8 * 1024 * 1024 - 1));
		await expect(read()).rejects.toThrow('8 MiB');
		await writeFile(file, Buffer.from([0xff, 0xfe]));
		await expect(read()).rejects.toThrow();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('captures execution inputs without following symlinks', async () => {
	const root = await mkdtemp(resolve(tmpdir(), 'receipt-manifest-'));
	try {
		await mkdir(resolve(root, 'elsewhere'));
		await symlink(resolve(root, 'elsewhere'), resolve(root, 'src'));
		await expect(
			execute(process.execPath, [
				'--input-type=module',
				'-e',
				`import {captureReceiptInputs} from ${JSON.stringify(script)}; await captureReceiptInputs(process.argv[1]);`,
				root,
			])
		).rejects.toThrow('must not be a symlink');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

async function readBoundary(file: string, attack?: 'replace' | 'touch') {
	const { stdout } = await execute(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			`
import {readConformanceReceipt} from ${JSON.stringify(script)};
import fs from 'node:fs/promises';
const file=process.argv[1], attack=process.argv[2];
if (attack) {
 const originalOpen=fs.open;
 fs.open=async (path,...options)=>{
  const handle=await originalOpen(path,...options);
  if(path!==file)return handle;
  try {
   if(attack==='replace') {
    await fs.rename(file,file+'.opened');
    await fs.copyFile(file+'.opened',file);
   } else {
    const originalRead=handle.read.bind(handle);
    let changed=false;
    handle.read=async (...args)=>{
     const result=await originalRead(...args);
     if(!changed){changed=true;const stat=await handle.stat();await fs.utimes(file,stat.atime,new Date(stat.mtimeMs+1000));}
     return result;
    };
   }
   return handle;
  } catch(error){await handle.close();throw error;}
 };
}
try { await readConformanceReceipt(file);process.stdout.write(JSON.stringify({ok:true})); }
catch(error){process.stdout.write(JSON.stringify({ok:false,message:error.message,code:error.code??null}));}
`,
			file,
			attack ?? '',
		],
		{ timeout: 5000, killSignal: 'SIGKILL' }
	);
	return JSON.parse(stdout);
}

(process.platform === 'win32' ? it.skip : it)(
	'receipt reader rejects a FIFO without waiting for a writer',
	async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'receipt-fifo-'));
		try {
			const file = resolve(root, 'receipt.fifo');
			await execute('mkfifo', [file]);
			expect(await readBoundary(file)).toMatchObject({
				ok: false,
				message: expect.stringMatching(/regular.*file/),
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
	10000
);

it('receipt reader rejects a terminal symlink while preserving the target', async () => {
	const root = await mkdtemp(resolve(tmpdir(), 'receipt-symlink-'));
	try {
		const target = resolve(root, 'target.json'),
			file = resolve(root, 'receipt.json');
		await writeFile(target, '{}');
		await symlink(target, file, 'file');
		expect(await readBoundary(file)).toMatchObject({
			ok: false,
			message: expect.stringMatching(/ELOOP|symlink|changed while opening/),
		});
		const { readFile } = await import('node:fs/promises');
		expect(await readFile(target, 'utf8')).toBe('{}');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it.each(['replace', 'touch'] as const)(
	'receipt reader rejects same-byte %s during read',
	async (attack) => {
		const root = await mkdtemp(resolve(tmpdir(), 'receipt-race-'));
		try {
			const file = resolve(root, 'receipt.json');
			await writeFile(file, '{}');
			expect(await readBoundary(file, attack)).toMatchObject({
				ok: false,
				message: expect.stringMatching(/changed while/),
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
);
