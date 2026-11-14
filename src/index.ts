#!/usr/bin/env node
// With no arguments this is the MCP server (what MCP clients run). Two subcommands add
// private mode for coding agents:
//   init    set up a key and point your coding agents at the local proxy
//   proxy   run the local OpenAI-compatible proxy that encrypts every request to the enclave
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { OffRouter } from './client.js';
import { loadConfig } from './config.js';
import { runInit } from './init.js';
import { createProxy, DEFAULT_PORT, listen } from './proxy.js';
import { createServer, VERSION } from './server.js';
import { readSaved, withSaved } from './store.js';

const HELP = `offrouter-mcp ${VERSION}

  npx -y @offrouter/mcp                 MCP server over stdio (for MCP clients)
  npx -y @offrouter/mcp init            set up private mode for your coding agents
  npx -y @offrouter/mcp proxy           run private mode: an OpenAI-compatible endpoint on
                                        127.0.0.1 that encrypts every request to the enclave

init options:   --key off_sk_...  --model <id>  --port <n>  --yes (no questions)
proxy options:  --port <n> (default ${DEFAULT_PORT})
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i !== -1) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  return eq?.slice(name.length + 3);
}

function portOf(v: string | undefined): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('--port should be a number from 1 to 65535');
  return n;
}

async function proxy(args: string[]) {
  const config = loadConfig(withSaved());
  const api = new OffRouter(config);
  const port = portOf(flag(args, 'port') ?? process.env.OFFROUTER_PROXY_PORT) ?? readSaved().port ?? DEFAULT_PORT;
  if (config.mode === 'demo') throw new Error('Private mode needs a prepaid key or a wallet. Run `npx -y @offrouter/mcp init` first, or set OFFROUTER_API_KEY.');
  if (config.e2ee) {
    process.stderr.write('Checking the enclave… ');
    const e = await api.enclave.get();
    process.stderr.write(`verified (Intel TDX quote, fresh nonce, measured launch${e.commit ? ` at ${e.commit.slice(0, 12)}` : ''}).\n`);
  }
  await listen(createProxy(api), port);
  const how = config.mode === 'wallet' ? `wallet ${api.wallet!.address} (cap $${config.maxUsd} per call)` : 'prepaid key';
  console.error(`OffRouter private mode on http://127.0.0.1:${port}/v1 · paying with ${how} · e2ee ${config.e2ee ? 'on' : 'OFF'}`);
  console.error('Point your agent here. Ctrl+C to stop.');
}

async function mcp() {
  const config = loadConfig(withSaved());
  const api = new OffRouter(config);
  const server = createServer(api);
  await server.connect(new StdioServerTransport());
  // stdout belongs to the protocol, so anything for humans goes to stderr.
  const how = config.mode === 'wallet' ? `wallet ${api.wallet!.address}` : config.mode === 'key' ? 'prepaid key' : 'free demo';
  console.error(`offrouter mcp ${config.baseUrl} · paying with ${how} · e2ee ${config.e2ee ? 'on' : 'off'}`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'init') {
    const r = await runInit({ key: flag(args, 'key'), model: flag(args, 'model'), port: portOf(flag(args, 'port')), yes: args.includes('--yes') || args.includes('-y') });
    if (r.start) await proxy(['--port', String(r.port)]);
    return;
  }
  if (cmd === 'proxy') return proxy(args);
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return void process.stdout.write(HELP);
  if (cmd === '--version' || cmd === '-v') return void process.stdout.write(VERSION + '\n');
  if (cmd) throw new Error(`Unknown command "${cmd}".\n\n${HELP}`);
  return mcp();
}

main().catch((e) => {
  console.error(`offrouter: ${(e as Error).message}`);
  process.exit(1);
});
