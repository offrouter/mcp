import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ChatInput, ChatResult, OffRouter, StudioAgent } from './client.js';

export const VERSION = '0.1.0';
const MAX_COMPARE = 4;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
const fail = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }], isError: true });

// Enough digits for sub-cent charges, without the trailing zeros.
const usd = (n: number) => '$' + ((Number(n) || 0).toFixed(6).replace(/\.?0+$/, '') || '0');

function footer(r: ChatResult): string {
  const parts = [r.model, `${r.promptTokens} in / ${r.completionTokens} out tokens`];
  if (r.paidWith === 'demo') parts.push(`free demo${r.demoRemaining != null ? `, ${r.demoRemaining} left today` : ''}`);
  else if (r.chargeUsd != null) parts.push(usd(r.chargeUsd));
  if (r.transaction && !r.transaction.startsWith('dryrun_')) parts.push(`paid in tx ${r.transaction}`);
  parts.push(r.encrypted ? 'encrypted end to end' : 'not encrypted');
  if (r.receiptUrl) parts.push(`receipt ${r.receiptUrl}`);
  return parts.join(' · ');
}

const date = (sec: number | null | undefined) => (sec ? new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ') : 'never');

/** Where it stands: ready once it passed its evaluation and has run well for a day. */
function standing(a: StudioAgent): string {
  const s = a.standing;
  if (!s) return a.status;
  if (s.ready) return 'ready';
  const why: string[] = [];
  if (!s.working?.passed) why.push(s.working ? `evaluation ${s.working.score}/100, not passed` : 'not evaluated');
  if (s.alive && !s.alive.ready) why.push(`${s.alive.good_runs}/${s.alive.needs_runs} good runs, live ${Math.floor(s.alive.live_for_sec / 3600)}h of ${s.alive.needs_sec / 3600}h`);
  return `not ready yet (${why.join('; ')})`;
}

function agentLine(a: StudioAgent, base: string, full = false): string {
  const purpose = !full && a.purpose.length > 160 ? a.purpose.slice(0, 157).trimEnd() + '...' : a.purpose;
  return [
    `## ${a.name}`,
    `id ${a.id} | ${a.status}${a.status === 'active' ? `, ${standing(a)}` : ''} | model ${a.model} | tools ${a.tools.join(', ') || 'none'}`,
    `${a.stats.good_runs} good / ${a.stats.failed_runs} failed runs, last ${date(a.last_run_at ?? a.stats.last_good_run_at)}`,
    purpose,
    `${base}/agents/${a.id}`,
  ].join('\n');
}

function instructions(api: OffRouter): string {
  const how = {
    key: 'Calls are billed per token to the connected prepaid key.',
    wallet: `Calls are paid one at a time from the connected wallet, capped at ${usd(api.config.maxUsd)} each. Unused budget is refunded to the wallet.`,
    demo: 'No key or wallet is set up, so calls go through the free demo: one small model and a few calls per day.',
  }[api.config.mode];
  return [
    'OffRouter runs open models privately. Every call is served inside a GPU TEE, nothing is logged, and each answer comes with a signed receipt.',
    api.config.e2ee ? 'Prompts are encrypted on this machine to a key the enclave proves it holds, so the gateway only sees ciphertext.' : '',
    how,
    'Use list_models to pick a model, then ask for one answer or compare to run the same prompt on several models.',
    'list_agents and get_agent show the private agents builders have published on OffRouter Studio.',
  ]
    .filter(Boolean)
    .join(' ');
}

export function createServer(api: OffRouter): McpServer {
  const server = new McpServer(
    { name: 'offrouter', title: 'OffRouter', version: VERSION, websiteUrl: 'https://offrouter.org' },
    { instructions: instructions(api) },
  );

  server.registerTool(
    'list_models',
    {
      title: 'List models',
      description:
        'List the private models on OffRouter with their context length and price in USD per million tokens. Use it to find a model id for ask or compare.',
      inputSchema: { search: z.string().optional().describe('Filter on the model id, like "qwen" or "deepseek".') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ search }) => {
      const models = await api.listModels();
      if (api.config.mode === 'demo') {
        const demo = await api.demoInfo().catch(() => null);
        const allowed: string[] = demo?.models ?? [];
        const lines = models.filter((m) => allowed.includes(m.id)).map((m) => `${m.id} | ${Math.round(m.context_length / 1000)}k ctx`);
        return text(
          `Running on the free demo, which allows: ${lines.length ? lines.join(', ') : 'nothing right now'}.` +
            (demo ? ` ${demo.remaining} of ${demo.daily_per_ip} calls left today, up to ${demo.max_tokens} output tokens each.` : '') +
            `\n\nThe full catalog has ${models.length} models. Set OFFROUTER_API_KEY or OFFROUTER_WALLET_KEY to use any of them.`,
        );
      }
      const q = search?.toLowerCase() ?? '';
      const rows = models.filter((m) => !q || m.id.toLowerCase().includes(q));
      if (!rows.length) return text(`No models match "${search}".`);
      const lines = rows.map(
        (m) =>
          `${m.id} | ${Math.round(m.context_length / 1000)}k ctx | ${usd(m.input_usdc_per_mtok)} in / ${usd(m.output_usdc_per_mtok)} out per M tokens` +
          ((m.input_modalities ?? []).length > 1 ? ` | reads ${m.input_modalities!.slice(1).join(' and ')}` : '') +
          (m.discount_pct ? ` | ${m.discount_pct}% off` : '') +
          (api.config.e2ee && !m.e2ee?.model ? ' | no e2ee' : ''),
      );
      return text(`${rows.length} private models, all served in a GPU TEE:\n\n${lines.join('\n')}`);
    },
  );

  const chatShape = {
    prompt: z.string().min(1).describe('The user message.'),
    system: z.string().optional().describe('Optional system prompt.'),
    max_tokens: z.number().int().min(1).optional().describe('Cap on output tokens. Reasoning models need a generous budget.'),
  };

  server.registerTool(
    'ask',
    {
      title: 'Ask a private model',
      description:
        'Send a prompt to an OffRouter model and get the answer back. It runs inside a GPU TEE and is not logged, so it is a good fit for sensitive material, a second opinion, or cheap bulk work.',
      inputSchema: {
        model: z.string().min(1).describe('Model id from list_models, like "gemma-4-31b".'),
        ...chatShape,
        temperature: z.number().min(0).max(2).optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const r = await api.chat(args as ChatInput);
        return text(`${r.text || '(the model returned no text)'}\n\n${footer(r)}`);
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'compare',
    {
      title: 'Compare models',
      description: `Run the same prompt on 2 to ${MAX_COMPARE} models in parallel and get every answer with its cost side by side.`,
      inputSchema: {
        models: z.array(z.string().min(1)).min(2).max(MAX_COMPARE).describe('Model ids from list_models.'),
        ...chatShape,
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ models, ...rest }) => {
      const ids = [...new Set(models)];
      if (ids.length < 2) return fail('Pass at least two different model ids.');
      if (api.config.mode === 'demo') return fail('compare needs a key or a wallet. The free demo only has one model.');
      const results = await Promise.allSettled(ids.map((model) => api.chat({ model, ...rest })));
      const sections = results.map((r, i) =>
        r.status === 'fulfilled' ? `## ${ids[i]}\n\n${r.value.text || '(no text)'}\n\n${footer(r.value)}` : `## ${ids[i]}\n\nError: ${(r.reason as Error).message}`,
      );
      return { content: [{ type: 'text', text: sections.join('\n\n---\n\n') }], isError: results.every((r) => r.status === 'rejected') };
    },
  );

  server.registerTool(
    'account',
    {
      title: 'Account',
      description: 'Show how this server pays for calls: the prepaid key balance and recent spend, the wallet address and per call cap, or what is left on the free demo.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const { mode } = api.config;
        if (mode === 'key') {
          const k = await api.keyInfo();
          const recent = (k.recent_usage ?? [])
            .slice(0, 5)
            .map((u: any) => `  ${String(u.at).slice(0, 16).replace('T', ' ')}  ${u.model}  ${u.prompt_tokens + u.completion_tokens} tokens  ${usd(u.charge_usdc)}`);
          return text(
            [
              `Prepaid key ${k.key_prefix}...`,
              `Balance: ${usd(k.balance_usdc)}`,
              `Spent: ${usd(k.spent_usdc)} over ${k.totals?.requests ?? 0} requests`,
              recent.length ? `Recent:\n${recent.join('\n')}` : '',
              'Top up at https://offrouter.org/dashboard',
            ]
              .filter(Boolean)
              .join('\n'),
          );
        }
        if (mode === 'wallet') {
          const w = api.wallet!;
          return text(
            [
              `Paying per call from wallet ${w.address}`,
              `Chains: ${w.chains.join(', ')} (USDC on Base, USDG on Robinhood Chain)`,
              `Cap per call: ${usd(api.config.maxUsd)}`,
              'Each call is quoted as a ceiling and the unused part is refunded to this wallet.',
            ].join('\n'),
          );
        }
        const d = await api.demoInfo();
        return text(
          `Free demo: ${d.remaining} of ${d.daily_per_ip} calls left today (resets ${d.resets_at}). Models: ${(d.models ?? []).join(', ')}.\n` +
            'For the full catalog, set OFFROUTER_API_KEY (get one at https://offrouter.org/dashboard) or OFFROUTER_WALLET_KEY to pay per call.',
        );
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'verify_enclave',
    {
      title: 'Verify the enclave',
      description:
        'Check the enclave right now from this machine: the Intel TDX quote, that the report is fresh, and that it booted the published code. Returns the key prompts are encrypted to.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const e = await api.enclave.refresh();
        return text(
          [
            'The enclave checks out.',
            '- Intel TDX quote verified up to Intel\'s root certificate',
            '- The report covers a random nonce made here just now, so it is not a replay',
            '- The boot log replays to the measured launch file',
            `Key set: ${e.keyset}`,
            `Encryption key: ${e.key.algo} ${e.key.public_key.slice(0, 16)}...`,
            `Valid until: ${new Date(e.notAfter * 1000).toISOString()}`,
            e.commit ? `Enclave gateway code: ${e.repo ? `${e.repo}/tree/${e.commit}` : e.commit}` : '',
            api.config.e2ee ? 'Prompts from this server are encrypted to that key.' : 'Encryption is off (OFFROUTER_E2EE=off), so prompts are sent in the clear to the gateway.',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      } catch (e) {
        return fail(`The enclave did not verify: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    'list_agents',
    {
      title: 'List Studio agents',
      description:
        'List the agents published on OffRouter Studio, newest first: what each does, its model and tools, how its runs have gone, and whether it has earned a ready standing. Each runs privately in a TEE with its own wallet.',
      inputSchema: {
        search: z.string().optional().describe('Filter on the name or purpose, like "trading" or "news".'),
        ready_only: z.boolean().optional().describe('Only agents that passed their evaluation and have run well for a day.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ search, ready_only }) => {
      try {
        const q = search?.toLowerCase() ?? '';
        const agents = (await api.listAgents()).filter(
          (a) => (!q || `${a.name} ${a.purpose}`.toLowerCase().includes(q)) && (!ready_only || a.standing?.ready),
        );
        if (!agents.length) return text(search || ready_only ? 'No Studio agents match.' : 'No agents are published on Studio yet.');
        const base = api.config.baseUrl;
        return text(`${agents.length} Studio agent${agents.length === 1 ? '' : 's'}:\n\n${agents.map((a) => agentLine(a, base)).join('\n\n')}\n\nUse get_agent with an id for its examples and evaluation.`);
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    'get_agent',
    {
      title: 'Get a Studio agent',
      description: 'Show one Studio agent in full: its purpose, example tasks, latest evaluation, standing, wallet and config hash.',
      inputSchema: { id: z.string().describe('The agent id from list_agents, 0x followed by 32 hex characters.') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      try {
        const a = await api.getAgent(id.trim());
        const ev = a.evaluation;
        return text(
          [
            agentLine(a, api.config.baseUrl, true),
            `Builder ${a.builder} · agent wallet ${a.address}`,
            `Config hash ${a.config_hash}`,
            `Created ${date(a.created_at)} · ${a.scheduled ? 'runs on a schedule' : 'runs on request'} · ${usd(Number(a.stats.credits_spent) / 1e6)} of credits spent`,
            ev ? `Last evaluation ${date(ev.at)}: ${ev.score}/100, ${ev.passed ? 'passed' : 'not passed'}${ev.leaked ? ', leaked its instructions' : ''} (${ev.judge} judge)` : 'Not evaluated yet.',
            a.examples?.length ? `Examples:\n${a.examples.map((x) => `- ${x.task}\n  Expect: ${x.expect}`).join('\n')}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  return server;
}
