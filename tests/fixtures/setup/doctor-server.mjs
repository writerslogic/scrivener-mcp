import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';

const mode = process.argv[2] ?? 'success';
const trace = (event) => appendFileSync(process.env.DOCTOR_TRACE, `${JSON.stringify(event)}\n`);
writeFileSync(process.env.DOCTOR_PID, String(process.pid));
trace({
	event: 'started',
	pid: process.pid,
	localOnly: process.env.SCRIVENER_LOCAL_ONLY,
	discovery: process.env.SCRIVENER_DISABLE_KEY_DISCOVERY,
	skipSetup: process.env.SCRIVENER_SKIP_SETUP,
	ambient: process.env.DOCTOR_AMBIENT_MARKER !== undefined,
});
if (mode === 'stubborn') {
	process.on('SIGTERM', () => trace({ event: 'sigterm' }));
	setInterval(() => {}, 1000);
}
process.stdin.on('end', () => {
	if (mode !== 'stubborn') process.exit(0);
});
if (mode === 'stderr-cut') {
	process.stderr.write(`${process.env.DOCTOR_SECRET}\nActionable final line\n`, () =>
		process.exit(17)
	);
} else if (mode === 'early-exit') {
	process.stderr.write(
		`${'x'.repeat(256 * 1024)}\nTail startup cause ${process.env.DOCTOR_SECRET} https://reader:password@example.test/config ${process.env.HOME ?? process.env.USERPROFILE}/private\n`,
		() => process.exit(17)
	);
} else {
	const send = (message) => {
		const line = `${JSON.stringify(message)}\n`;
		if (mode === 'fragmented') {
			process.stdout.write(line.slice(0, 11));
			setTimeout(() => process.stdout.write(line.slice(11)), 5);
		} else process.stdout.write(line);
	};
	const tool = (name) => ({ name, inputSchema: { type: 'object' } });
	createInterface({ input: process.stdin }).on('line', (line) => {
		const request = JSON.parse(line);
		trace({
			event: 'request',
			method: request.method,
			cursor: request.params?.cursor ?? null,
			protocolVersion: request.params?.protocolVersion,
		});
		if (request.id === undefined) return;
		const reply = (result) => send({ jsonrpc: '2.0', id: request.id, result });
		if (request.method === 'initialize') {
			if (mode === 'stubborn') return;
			if (mode === 'malformed-json') {
				process.stdout.write('invalid protocol JSON\n');
				return;
			}
			if (mode === 'stdout-overflow') {
				process.stdout.write('x'.repeat(1024 * 1024 + 1));
				return;
			}
			reply({
				protocolVersion:
					mode === 'unsupported'
						? '1900-01-01'
						: mode === 'legacy'
							? SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1]
							: request.params.protocolVersion,
				capabilities: { tools: {} },
				serverInfo: { name: 'diagnostic-fixture', version: 'fixture-1' },
			});
		} else if (request.method === 'tools/list') {
			if (mode === 'hold-list') return;
			if (mode === 'rpc-error') {
				send({
					jsonrpc: '2.0',
					id: request.id,
					error: {
						code: -32603,
						message: `catalog failed ${process.env.DOCTOR_SECRET} https://reader:password@example.test/rpc`,
					},
				});
				return;
			}
			if (mode === 'malformed-result') {
				reply({ tools: 'not an array' });
				return;
			}
			if (mode === 'malformed-tool') {
				reply({ tools: [{ name: 'broken', inputSchema: { type: 'array' } }] });
				return;
			}
			if (mode === 'empty') {
				reply({ tools: [] });
				return;
			}
			if (mode.startsWith('tools-')) {
				reply({
					tools: Array.from({ length: Number(mode.slice(6)) }, (_, index) =>
						tool(`tool-${index}`)
					),
				});
				return;
			}
			const page = Number(request.params?.cursor ?? 0);
			if (mode.startsWith('pages-')) {
				reply({
					tools: [tool(`tool-${page}`)],
					...(page < Number(mode.slice(6)) - 1 ? { nextCursor: String(page + 1) } : {}),
				});
				return;
			}
			if (mode.startsWith('cursor-')) {
				reply({
					tools: [tool(request.params?.cursor === undefined ? 'first' : 'last')],
					...(request.params?.cursor === undefined
						? { nextCursor: 'c'.repeat(Number(mode.slice(7))) }
						: {}),
				});
				return;
			}
			if (mode === 'pagination') {
				reply({
					tools: [tool(`tool-${page}`)],
					...(page < 2 ? { nextCursor: String(page + 1) } : {}),
				});
				return;
			}
			if (mode === 'repeat-cursor') {
				reply({ tools: [tool(`tool-${page}`)], nextCursor: '1' });
				return;
			}
			if (mode === 'duplicate-tools') {
				reply({ tools: [tool('repeated')], ...(page === 0 ? { nextCursor: '1' } : {}) });
				return;
			}
			if (mode === 'many-pages' || mode === 'slow-pages') {
				const result = { tools: [tool(`tool-${page}`)], nextCursor: String(page + 1) };
				if (mode === 'slow-pages') setTimeout(() => reply(result), 400);
				else reply(result);
				return;
			}
			reply({ tools: [tool('fixture-tool')] });
		}
	});
}
