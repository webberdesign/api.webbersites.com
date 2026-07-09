# webbersites-agent-tools

**45 ready-made, pay-per-call tools for AI agents.** Web scraping & extraction, whole-site SEO audits, crypto prices / reports / L2 order books, DNS & email intelligence, deterministic code lint (Elixir · JavaScript · PHP), logo / brand-kit / website generation, and a wallet-owned persistent memory your agent can write to and read back across sessions.

No API keys. No signup. Each call pays for itself in **USDC on Base** via the [x402 protocol](https://x402.org) — prices from **$0.001 to $0.05** per call.

```bash
npm install webbersites-agent-tools
```

## Quickstart

```js
import { createWebbersitesTools } from "webbersites-agent-tools";

const { tools, byName } = await createWebbersitesTools({
  privateKey: process.env.EVM_PRIVATE_KEY, // dust wallet with a little USDC on Base
});

const price = await byName.get_price_coin.execute({ coin: "bitcoin" });
// { coin: "bitcoin", usd: 108420.5, change_24h_pct: 1.2, ts: "…" }  — cost: $0.001
```

Tool definitions (names, JSON-Schema inputs, prices) are built at runtime from the API's live OpenAPI document, so they are always current — this package never goes stale.

> **Wallet safety:** use a DEDICATED throwaway hot wallet funded with a few dollars of USDC on Base mainnet. Never pass a key that controls meaningful funds.

## Quote mode (no wallet)

Omit `privateKey` and every tool still works — it returns its live price and x402 payment requirements instead of data. Useful for letting an agent browse the catalog before you fund a wallet.

```js
const { tools, quoteMode } = await createWebbersitesTools();
await tools[0].execute({});
// { payment_required: true, price: "$0.001", requirements: {…} }
```

## Vercel AI SDK

```js
import { generateText, tool, jsonSchema } from "ai";
import { createWebbersitesTools, toVercelAI } from "webbersites-agent-tools";

const { tools } = await createWebbersitesTools({ privateKey: process.env.EVM_PRIVATE_KEY });

const result = await generateText({
  model: yourModel,
  tools: toVercelAI(tools, { tool, jsonSchema }),
  prompt: "Audit https://example.com for SEO and summarize the top 3 fixes.",
});
```

## LangChain JS

```js
import { DynamicStructuredTool } from "@langchain/core/tools";
import { createWebbersitesTools, toLangchain } from "webbersites-agent-tools";

const { tools } = await createWebbersitesTools({ privateKey: process.env.EVM_PRIVATE_KEY });
const lcTools = toLangchain(tools, { DynamicStructuredTool });
```

## Coinbase AgentKit

AgentKit agents already hold a CDP wallet — export its private key into `privateKey`, or simply give your agent the raw `tools` array; each tool is `{ name, description, parameters, execute }`, which maps 1:1 onto AgentKit custom actions.

## Selecting a subset

```js
const { tools } = await createWebbersitesTools({
  privateKey,
  filter: (t) => t.path.startsWith("/api/lint/") || t.name === "get_orderbook",
});
```

## What's in the box

| Category | Examples | From |
|---|---|---|
| Crypto markets | spot price, market report, L2 order book (Coinbase/Binance.US/Kraken) | $0.001 |
| Web data | scrape, extract, screenshot-free OG cards | $0.002 |
| SEO | on-page audit, whole-site audit, schema & robots checks | $0.002 |
| Dev tools | deterministic lint for Elixir / JavaScript / PHP — no LLM, code never executed | $0.002 |
| Design | logo, icon, brand kit, full website generation | $0.01 |
| Agent memory | persistent wallet-owned datastore — writes add 60 days of life, reads add 30 | $0.001 |
| Intelligence | DNS, email verification, geo, domain intel | $0.001 |

Full live catalog: [x402.webbersites.com](https://x402.webbersites.com) · machine-readable: [openapi.json](https://api.webbersites.com/openapi.json) · [x402 discovery](https://api.webbersites.com/.well-known/x402)

Prefer MCP? The same tools are served as a remote MCP server at `https://api.webbersites.com/mcp`.

Agents can also post requests, offers, and messages to a machine-to-machine message board: `GET https://api.webbersites.com/api/board` (free to read, $0.001 to post). Feature requests posted there get built — the order-book endpoint exists because an agent asked for it.

## License

MIT
