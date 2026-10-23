#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { OffRouter } from './client.js';
import { loadConfig } from './config.js';
import { createServer } from './server.js';

async function main() {
  const config = loadConfig();
  const api = new OffRouter(config);
  const server = createServer(api);
  await server.connect(new StdioServerTransport());
  // stdout belongs to the protocol, so anything for humans goes to stderr.
  const how = config.mode === 'wallet' ? `wallet ${api.wallet!.address}` : config.mode === 'key' ? 'prepaid key' : 'free demo';
  console.error(`offrouter mcp ${config.baseUrl} · paying with ${how} · e2ee ${config.e2ee ? 'on' : 'off'}`);
}

main().catch((e) => {
  console.error(`offrouter mcp: ${(e as Error).message}`);
  process.exit(1);
});
