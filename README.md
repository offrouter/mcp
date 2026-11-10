# OffRouter MCP

An MCP server for [OffRouter](https://offrouter.org), private inference for agents.

Every model on OffRouter runs inside a GPU TEE (Intel TDX plus an NVIDIA confidential GPU). Nothing is cached or logged, and every answer comes back with a signed receipt. This server goes one step further: it encrypts your prompt on your own machine, to a key the enclave proves it holds, before anything goes over the network. OffRouter's gateway sits in the middle and only ever sees ciphertext.

That is the main reason to run this locally instead of using the hosted endpoint at `https://offrouter.org/mcp`. A remote MCP server has to read your prompt to build the request. This one never sends it in the clear.

## Quick start

You don't need an account to try it. With no configuration it uses OffRouter's free demo (one model, a few calls a day).

**Claude Code**

```bash
claude mcp add offrouter -- npx -y @offrouter/mcp
```

**Claude Desktop, Cursor, Windsurf and other clients**

```json
{
  "mcpServers": {
    "offrouter": {
      "command": "npx",
      "args": ["-y", "@offrouter/mcp"],
      "env": {
        "OFFROUTER_API_KEY": "off_sk_..."
      }
    }
  }
}
```

Then ask your agent something like "use offrouter to verify the enclave" or "ask deepseek-v4-flash on offrouter to review this contract".

**Nothing to install.** If you'd rather not run anything locally, add the hosted server at `https://offrouter.org/mcp` with your key as an `Authorization: Bearer off_sk_...` header. It has the same models, but your prompt reaches the gateway in the clear, and it can't pay per call from a wallet.

## Three ways to pay

Pick one by setting an environment variable. If you set both, the key is used.

| Setup | How it pays | Good for |
| --- | --- | --- |
| nothing | Free demo, limited to one model and 5 calls a day | Trying it out |
| `OFFROUTER_API_KEY` | A prepaid key, billed per token | Everyday use |
| `OFFROUTER_WALLET_KEY` | Pay per call with x402 from your own wallet | Agents that hold their own funds |

**Prepaid key.** Sign in with a wallet at [offrouter.org/dashboard](https://offrouter.org/dashboard), fund a key, and copy the `off_sk_...` value. Each call is charged the exact token cost.

**Wallet.** Every call is paid on its own with a signed USDC transfer on Base, or USDG on Robinhood Chain. The private key stays in this process and is only used to sign the payment. OffRouter quotes each call as a ceiling (your whole input plus `max_tokens` of output) and refunds the unused part to the same wallet afterwards. This server won't sign anything above `OFFROUTER_MAX_USD`, whatever the server asks for. Use a dedicated wallet with a small balance, not your main one.

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `OFFROUTER_API_KEY` | | Prepaid key, starts with `off_sk_` |
| `OFFROUTER_WALLET_KEY` | | Private key of a wallet to pay per call from |
| `OFFROUTER_MAX_USD` | `0.10` | Most a single wallet payment can be, in USD |
| `OFFROUTER_NETWORK` | both | Only pay on `base` or only on `robinhood` |
| `OFFROUTER_MAX_TOKENS` | `2048` | Output budget when the agent doesn't set one |
| `OFFROUTER_E2EE` | `on` | Set to `off` to send prompts to the gateway in the clear |
| `OFFROUTER_IMAGE_DIR` | a temp folder | Where `generate_image` saves its images |
| `OFFROUTER_BASE_URL` | `https://offrouter.org` | API to talk to |

## Tools

- **list_models** lists the models with context length and price per million tokens, and the image models with their price per image.
- **ask** sends a prompt to one model and returns the answer, what it cost, and a link to its signed receipt.
- **generate_image** makes 1 to 4 images from a text prompt on a private image model (like `flux-2-klein`), priced per image. The images come back inline and are saved as files. Image models don't take end to end encryption yet, so the prompt reaches the gateway in the clear; it's still served in the TEE and nothing is stored. Needs a key or a wallet.
- **compare** runs the same prompt on 2 to 4 models in parallel, so you can see the answers and costs side by side.
- **account** shows the key balance and recent spend, the wallet address and cap, or what's left on the demo.
- **verify_enclave** checks the enclave from your machine right now and shows the key your prompts are encrypted to.
- **list_agents** lists the agents published on [OffRouter Studio](https://offrouter.org/studio): what each does, its model, how its runs have gone and whether it has a ready standing. Filter by a search term or to ready agents only.
- **get_agent** shows one Studio agent in full: its example tasks, latest evaluation, wallet and config hash.

The same calls are on the client, `listAgents()` and `getAgent(id)`, and need no key or wallet: the Studio directory is public.

## How the encryption works

Before the first call, the server fetches an attestation report for a random nonce it just generated and checks it with the enclave gateway's reference verifier:

1. The Intel TDX quote verifies all the way up to Intel's root certificate.
2. The report covers our nonce, so it was made just now and is not a replay, and it binds the enclave's key set.
3. The boot log replays to the measured launch file, which pins the open source [enclave gateway](https://github.com/Dstack-TEE/private-ai-gateway) at a specific commit.

If any of these fail, nothing is sent. If they pass, each message is encrypted to the enclave's X25519 key (HKDF-SHA256, then AES-256-GCM, with a fresh ephemeral key for every field). Each ciphertext is bound to the request's nonce and timestamp and to the model, so it can't be replayed or redirected to a different model. The answer comes back encrypted to a one-time key this server made for that request, and it's decrypted here. If the answer doesn't decrypt, it wasn't made by the enclave for your request, and the server throws it away.

The verified key is cached until shortly before it expires. If the enclave rejects a request, usually because its key rotated, the server checks the enclave again and retries once.

## What stays visible

To be clear about what this does and doesn't hide:

- The gateway can't read your messages or the answers.
- The gateway still sees which model you picked, settings like `max_tokens` and `temperature`, the size of the ciphertext, the token counts the enclave reports, timing, your IP address, and who paid.
- With a wallet, the payment itself is a normal onchain transfer, so it's public.
- Your MCP client (Claude, Cursor and so on) sees the prompt and the answer, because that's where they come from and go to. This server protects the hop from your machine to the model.

## Development

```bash
npm install
npm test
npm run build
OFFROUTER_API_KEY=off_sk_... npm run dev
```

Requires Node 20 or newer.

## License

MIT
