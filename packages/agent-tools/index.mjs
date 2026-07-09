// webbersites-agent-tools — pay-per-call tools for AI agents, powered by x402.
//
// Tool definitions are built at runtime from the API's live OpenAPI document,
// so names, schemas, and prices are always current — nothing in this package
// goes stale when the API adds endpoints or reprices.
//
// With a funded hot-wallet key, every tool call pays for itself in USDC on
// Base (from $0.001). Without a key the tools run in "quote mode": each call
// returns its live price and x402 payment requirements instead of data.

import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const DEFAULT_BASE = "https://api.webbersites.com";
const CLIENT_UA = "webbersites-agent-tools/0.1.1 (+https://x402.webbersites.com)";

/**
 * Build the tool set from the live API.
 *
 * @param {object} [opts]
 * @param {string} [opts.privateKey]  0x… key of a DEDICATED dust wallet holding
 *   a little USDC on Base mainnet. Never use a wallet with meaningful funds.
 *   Omit to run in quote mode (calls return price + payment requirements).
 * @param {string} [opts.apiBase]     API origin, default https://api.webbersites.com
 * @param {function} [opts.filter]    (tool) => boolean, to keep a subset
 * @param {function} [opts.fetch]     custom fetch implementation
 * @returns {Promise<{tools: Tool[], byName: Object, wallet: string|null, quoteMode: boolean}>}
 *
 * Each Tool is { name, description, price, method, path, parameters, execute }
 * where parameters is a JSON Schema object and execute(args) returns the
 * endpoint's JSON response.
 */
export async function createWebbersitesTools(opts = {}) {
  const base = (opts.apiBase || DEFAULT_BASE).replace(/\/+$/, "");
  const rawFetch = opts.fetch || globalThis.fetch;

  let payingFetch = rawFetch;
  let wallet = null;
  if (opts.privateKey) {
    const signer = privateKeyToAccount(opts.privateKey);
    const client = new x402Client();
    client.register("eip155:*", new ExactEvmScheme(signer));
    payingFetch = wrapFetchWithPayment(rawFetch, client);
    wallet = signer.address;
  }

  const res = await rawFetch(`${base}/openapi.json`);
  if (!res.ok) throw new Error(`Could not load ${base}/openapi.json (HTTP ${res.status})`);
  const spec = await res.json();

  const tools = [];
  for (const [path, ops] of Object.entries(spec.paths || {})) {
    for (const method of ["get", "post", "delete"]) {
      const op = ops[method];
      if (!op || !op.operationId) continue;
      const tool = buildTool({ base, path, method, op, payingFetch, quoteMode: !wallet });
      if (!opts.filter || opts.filter(tool)) tools.push(tool);
    }
  }
  tools.sort((a, b) => a.name.localeCompare(b.name));

  return {
    tools,
    byName: Object.fromEntries(tools.map((t) => [t.name, t])),
    wallet,
    quoteMode: !wallet,
  };
}

function buildTool({ base, path, method, op, payingFetch, quoteMode }) {
  const name = op.operationId.replace(/^(get|post|delete)_api_/, "$1_");
  const price = op["x-price"] || null;

  const properties = {};
  const required = [];
  const location = {}; // arg name -> "path" | "query" | "body"

  for (const p of op.parameters || []) {
    properties[p.name] = { ...(p.schema || { type: "string" }), ...(p.description ? { description: p.description } : {}) };
    if (p.required) required.push(p.name);
    location[p.name] = p.in;
  }
  const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
  if (bodySchema?.properties) {
    for (const [k, v] of Object.entries(bodySchema.properties)) {
      if (!(k in properties)) {
        properties[k] = v;
        location[k] = "body";
      }
    }
    for (const k of bodySchema.required || []) if (!required.includes(k)) required.push(k);
  }

  const summary = op.summary || op.operationId;
  const description = price
    ? `${summary}. Costs ${price} per call, paid automatically in USDC via x402.`
    : `${summary}.`;

  async function execute(args = {}) {
    let urlPath = path.replace(/\{([^}]+)\}/g, (_, k) => {
      if (args[k] === undefined) throw new Error(`Missing required argument: ${k}`);
      return encodeURIComponent(String(args[k]));
    });

    const qs = new URLSearchParams();
    const body = {};
    let hasBody = false;
    for (const [k, v] of Object.entries(args)) {
      if (v === undefined || v === null || location[k] === "path") continue;
      if (location[k] === "query") qs.set(k, String(v));
      else if (location[k] === "body") { body[k] = v; hasBody = true; }
    }
    const url = `${base}${urlPath}${qs.size ? `?${qs}` : ""}`;

    const res = await payingFetch(url, {
      method: method.toUpperCase(),
      headers: { "User-Agent": CLIENT_UA, ...(hasBody ? { "Content-Type": "application/json" } : {}) },
      body: hasBody ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }

    if (res.status === 402) {
      return {
        payment_required: true,
        price,
        note: quoteMode
          ? "Quote mode: no wallet key configured. Pass privateKey (a funded dust wallet on Base) to createWebbersitesTools() and this call will pay for itself."
          : "Payment was not accepted — check the wallet's USDC balance on Base.",
        requirements: json ?? text.slice(0, 2000),
      };
    }
    if (!res.ok) {
      throw new Error(`${name} failed (HTTP ${res.status}): ${text.slice(0, 500)}`);
    }
    return json ?? text;
  }

  return {
    name,
    description,
    price,
    method: method.toUpperCase(),
    path,
    parameters: { type: "object", properties, ...(required.length ? { required } : {}) },
    execute,
  };
}

/**
 * Adapter for the Vercel AI SDK. Pass the `tool` and `jsonSchema` helpers from
 * the "ai" package so this library needs no dependency on it:
 *
 *   import { tool, jsonSchema } from "ai";
 *   const { tools } = await createWebbersitesTools({ privateKey });
 *   const aiTools = toVercelAI(tools, { tool, jsonSchema });
 */
export function toVercelAI(tools, { tool, jsonSchema }) {
  return Object.fromEntries(
    tools.map((t) => [
      t.name,
      tool({
        description: t.description,
        inputSchema: jsonSchema(t.parameters),
        execute: (args) => t.execute(args),
      }),
    ])
  );
}

/**
 * Adapter for LangChain JS. Pass the DynamicStructuredTool class so this
 * library needs no dependency on LangChain. Schemas are plain JSON Schema,
 * which DynamicStructuredTool accepts.
 *
 *   import { DynamicStructuredTool } from "@langchain/core/tools";
 *   const lcTools = toLangchain(tools, { DynamicStructuredTool });
 */
export function toLangchain(tools, { DynamicStructuredTool }) {
  return tools.map(
    (t) =>
      new DynamicStructuredTool({
        name: t.name,
        description: t.description,
        schema: t.parameters,
        func: async (args) => JSON.stringify(await t.execute(args)),
      })
  );
}
