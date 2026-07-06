#!/usr/bin/env node
// ----------------------------------------------------------------------------
// Pay one settled call on EVERY endpoint so each one (re)enters the Bazaar
// index at its current price and restarts its 30-day recency clock — and so
// the whole menu gets an end-to-end test through the real paywall.
// ~$0.12 total at the 2026-07 sub-cent prices, paid from your hot wallet to
// your own PAY_TO address (you keep the USDC minus network fees).
//
//   EVM_PRIVATE_KEY=0xYOUR_HOT_WALLET_KEY node scripts/seed-payments.mjs
//
// The key can also live in .env (EVM_PRIVATE_KEY=…). Scope options:
//   node scripts/seed-payments.mjs --batch lookups     one batch
//   node scripts/seed-payments.mjs price geo           named endpoints
//   node scripts/seed-payments.mjs --list              show batches and exit
// ----------------------------------------------------------------------------
import "dotenv/config";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const BASE = process.env.API_BASE || "https://api.webbersites.com";
const SITE = "https://x402.webbersites.com";

const argv = process.argv.slice(2);
const listOnly = argv.includes("--list");

if (!listOnly && !process.env.EVM_PRIVATE_KEY) {
  console.error("Set EVM_PRIVATE_KEY (env or .env) to a hot wallet holding USDC on Base mainnet.");
  process.exit(1);
}

let payingFetch = fetch;
if (!listOnly) {
  const signer = privateKeyToAccount(process.env.EVM_PRIVATE_KEY);
  const client = new x402Client();
  client.register("eip155:*", new ExactEvmScheme(signer));
  payingFetch = wrapFetchWithPayment(fetch, client);
  console.log(`Paying wallet: ${signer.address}\n`);
}

const enc = encodeURIComponent;
const post = (url, body) =>
  payingFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// One entry per endpoint: { price, run, show, free? }. Grouped into batches so
// a partial run is easy and failures are simple to localize.
const BATCHES = {
  lookups: {
    "price": { price: "$0.001", run: () => payingFetch(`${BASE}/api/price/bitcoin`),
      show: (j) => `BTC $${j.usd} (${j.change_24h_pct > 0 ? "+" : ""}${j.change_24h_pct}% 24h)` },
    "report": { price: "$0.005", run: () => payingFetch(`${BASE}/api/report/ethereum`),
      show: (j) => `ETH rank ${j.rank ?? "?"}, ${(j.summary || "").slice(0, 60)}` },
    "geo": { price: "$0.001", run: () => payingFetch(`${BASE}/api/geo?ip=8.8.8.8`),
      show: (j) => `${j.ip} → ${j.city}, ${j.region} ${j.country}` },
    "timezone": { price: "$0.001", run: () => payingFetch(`${BASE}/api/timezone?lat=40.71&lng=-74.01`),
      show: (j) => `${j.timezone} (UTC${j.utc_offset ?? ""})` },
    "contrast": { price: "$0.001", run: () => payingFetch(`${BASE}/api/a11y/contrast?fg=%23111111&bg=%23ffffff`),
      show: (j) => `${j.ratio_string} — AA normal text: ${j.passes?.normal_text?.AA}` },
    "dns": { price: "$0.002", run: () => payingFetch(`${BASE}/api/dns?domain=webbersites.com`),
      show: (j) => `${(j.records?.A || []).length} A record(s), SPF ${j.email_security?.spf?.found ? "found" : "missing"}` },
    "email-verify": { price: "$0.001", run: () => payingFetch(`${BASE}/api/email/verify?email=${enc("service@webbersites.com")}`),
      show: (j) => `${j.email} → ${j.verdict}` },
  },

  content: {
    "scrape": { price: "$0.001", run: () => payingFetch(`${BASE}/api/scrape?url=${enc("https://example.com")}`),
      show: (j) => `"${j.title}" — ${j.word_count} words` },
    "summarize": { price: "$0.002", run: () => payingFetch(`${BASE}/api/summarize?url=${enc("https://en.wikipedia.org/wiki/Web_scraping")}&sentences=3`),
      show: (j) => `${j.summary_word_count}/${j.original_word_count} words` },
    "extract": { price: "$0.001", run: () => payingFetch(`${BASE}/api/extract?url=${enc("https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf")}`),
      show: (j) => `${j.type} → ${j.pages ?? j.row_count ?? "?"} page(s)/row(s)` },
    "og-check": { price: "$0.001", run: () => payingFetch(`${BASE}/api/og/check?url=${enc(SITE)}`),
      show: (j) => `verdict: ${j.verdict || (j.problems?.length + " problems")}` },
  },

  seo: {
    "alt-check": { price: "$0.001", run: () => payingFetch(`${BASE}/api/seo/alt-check?url=${enc(SITE)}`),
      show: (j) => `${j.images_total} images, ${j.missing_alt} missing alt` },
    "metadata": { price: "$0.001", run: () => payingFetch(`${BASE}/api/seo/metadata?url=${enc(SITE)}`),
      show: (j) => `title "${(j.title || "").slice(0, 40)}"` },
    "head-check": { price: "$0.001", run: () => payingFetch(`${BASE}/api/seo/head-check?url=${enc(SITE)}`),
      show: (j) => `verdict: ${j.verdict}, ${(j.problems || []).length} problems` },
    "robots-check": { price: "$0.001", run: () => payingFetch(`${BASE}/api/seo/robots-check?url=${enc(SITE)}`),
      show: (j) => `robots ${j.robots?.found ? "found" : "missing"}, llms.txt ${j.llms_txt?.found ? "found" : "missing"}` },
    "sitemap-check": { price: "$0.001", run: () => payingFetch(`${BASE}/api/seo/sitemap-check?url=${enc(SITE)}`),
      show: (j) => `${j.url_count ?? "?"} urls, verdict: ${j.verdict}` },
    "nav": { price: "$0.001", run: () => payingFetch(`${BASE}/api/seo/nav?url=${enc(SITE)}`),
      show: (j) => `${j.nav_regions_found ?? "?"} nav regions, ${j.unique_nav_links ?? "?"} links` },
    "links": { price: "$0.001", run: () => payingFetch(`${BASE}/api/seo/links?url=${enc(SITE)}`),
      show: (j) => `${j.internal_count ?? "?"} internal / ${j.external_count ?? "?"} external` },
    "a11y-check": { price: "$0.001", run: () => payingFetch(`${BASE}/api/a11y/check?url=${enc(SITE)}&level=AA`),
      show: (j) => `${(j.findings || []).length} findings at ${j.level || "AA"}` },
    "full-audit": { price: "$0.007", run: () => payingFetch(`${BASE}/api/seo/full-audit?url=${enc(SITE)}`),
      show: (j) => `score ${j.score} (${j.grade})` },
    "site-audit": { price: "$0.009", run: () => payingFetch(`${BASE}/api/seo/site-audit?url=${enc(SITE)}&pages=2`),
      show: (j) => `site_score ${j.site_score} (${j.grade}), ${j.pages_audited} pages` },
  },

  schema: {
    "schema-audit": { price: "$0.005", run: () => post(`${BASE}/api/schema/audit`, { url: SITE }),
      show: (j) => `${j.found} block(s) found, ${j.with_issues} with issues` },
    "schema-generate": { price: "$0.005",
      run: () => post(`${BASE}/api/schema/generate`, { type: "Organization", fields: { name: "WebberSites", url: SITE, logo: `${SITE}/webbersites-icon.png` } }),
      show: (j) => `${j.type} JSON-LD, audit: ${j.self_audit?.rich_result_status}` },
    "wp-assess": { price: "$0.005", run: () => payingFetch(`${BASE}/api/wp/assess?url=${enc("https://webbersites.com")}`),
      show: (j) => `wordpress: ${j.is_wordpress}, posture ${j.posture_score} (${j.grade})` },
  },

  design: {
    "icon-search": { price: "$0.002", run: () => payingFetch(`${BASE}/api/icon/search?q=rocket`),
      show: (j) => `${(j.results || []).length} matches, top: ${j.results?.[0]?.name}` },
    "icon-generate": { price: "$0.005", run: () => post(`${BASE}/api/icon/generate`, { query: "rocket", colors: ["#ff6b35"] }),
      show: (j) => `${j.icon?.name || "icon"} @ ${j.size || 1024}px` },
    "logo-generate": { price: "$0.005",
      run: () => post(`${BASE}/api/logo/generate`, { name: "WebberSites", query: "bolt", colors: ["#ff6b35"] }),
      show: (j) => `${j.width}x${j.height} logo` },
    "og-card": { price: "$0.005",
      run: () => post(`${BASE}/api/og/card`, { title: "Sub-cent API calls", subtitle: "Every endpoint now $0.001–$0.009", domain: "x402.webbersites.com", theme: "dark" }),
      show: (j) => `${j.width}x${j.height} card` },
    "brand-kit": { price: "$0.007",
      run: () => post(`${BASE}/api/brand/kit`, { name: "WebberSites", tagline: "Pay-per-call data for AI agents", query: "bolt", colors: ["#ff6b35"], domain: "x402.webbersites.com" }),
      show: (j) => `logo ${j.logo?.width}x${j.logo?.height}, icon + og_card + palette` },
    "vectorize": { price: "$0.009", run: () => post(`${BASE}/api/vectorize`, { url: `${SITE}/webbersites-icon.png` }),
      show: (j) => `${j.output_format || "svg"} out, credits: ${j.credits_charged ?? "?"}` },
    "website-page": { price: "$0.005",
      run: () => post(`${BASE}/api/website/page`, { site_name: "WebberSites Demo", headline: "Pay-per-call data for AI agents", seed: "seed-2026" }),
      show: (j) => `${j.filename || "page"} rendered, template ${j.template}` },
    "website-build": { price: "$0.009",
      run: () => post(`${BASE}/api/website/build`, {
        site_name: "WebberSites Demo", seed: "seed-2026", colors: ["#ff6b35"],
        pages: [
          { page_name: "home", headline: "Pay-per-call data for AI agents", content: [{ heading: "41 endpoints", body: "USDC on Base via x402. No keys, no accounts. Everything under a cent." }] },
          { page_name: "pricing", headline: "From $0.001 per call" },
        ],
      }),
      show: (j) => `${j.page_count} pages (${(j.pages || []).map((p) => p.filename).join(", ")})` },
  },

  music: {
    "music-album": { price: "$0.002", run: () => payingFetch(`${BASE}/api/music/album?artist=Radiohead&title=OK+Computer`),
      show: (j) => `"${j.title}" (${j.year}) — ${(j.tracklist || []).length} tracks` },
    "music-cover": { price: "$0.002", run: () => payingFetch(`${BASE}/api/music/cover?artist=Radiohead&title=OK+Computer`),
      show: (j) => `${j.width}x${j.height} cover` },
  },

  datastore: {
    "store-post": { price: "$0.001",
      run: () => post(`${BASE}/api/store/seed-notes`, [{ event: "seed", note: "sub-cent repricing seeded", ts_note: "2026-07-06" }]),
      show: (j) => `${j.rows_added} row(s) → "${j.collection}" (total ${j.total_rows})` },
    "store-get": { price: "$0.001", run: () => payingFetch(`${BASE}/api/store/seed-notes?limit=5&order=desc`),
      show: (j) => `${j.returned}/${j.total_rows} rows back` },
    "store-list": { price: "$0.001", run: () => payingFetch(`${BASE}/api/store`),
      show: (j) => `${(j.collections || []).length} collection(s), ${j.storage_bytes} bytes used` },
    "store-delete": { price: "$0.001", run: () => payingFetch(`${BASE}/api/store/seed-notes`, { method: "DELETE" }),
      show: (j) => `dropped "${j.collection}" (${j.deleted_rows} rows)` },
  },

  board: {
    // Free since 2026-07-06 — plain fetch, and we assert no payment happened.
    "board-read": { price: "free", free: true, run: () => fetch(`${BASE}/api/board?limit=3`),
      show: (j) => `${j.count} posts, latest: "${(j.posts?.[0]?.text || "").slice(0, 50)}"` },
    "board-post": { price: "$0.001",
      run: () => post(`${BASE}/api/board`, { type: "tip", text: "Repriced: all 41 endpoints now $0.001-$0.009. Reading this board is free. Your wallet gets a memory at /api/store.", agent: "@webbersites" }),
      show: (j) => `posted #${j.post?.id}` },
    "board-sticky": { price: "$0.003",
      run: () => post(`${BASE}/api/board/sticky`, { type: "feature", text: "NEW PRICES: everything sub-cent. Whole-site audit $0.009, brand kit $0.007, 6-page site build $0.009. Board reads now FREE.", agent: "@webbersites" }),
      show: (j) => `pinned #${j.post?.id}` },
  },
};

const batchArg = argv.includes("--batch") ? argv[argv.indexOf("--batch") + 1] : null;
const names = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--batch");

if (listOnly) {
  for (const [batch, eps] of Object.entries(BATCHES)) {
    const cost = Object.values(eps).reduce((s, e) => s + (e.free ? 0 : Number(e.price.replace("$", ""))), 0);
    console.log(`${batch.padEnd(10)} ${Object.keys(eps).join(", ")}  (~$${cost.toFixed(3)})`);
  }
  process.exit(0);
}

// Resolve what to run: --batch <name>, explicit endpoint names, or everything.
const ALL = Object.assign({}, ...Object.values(BATCHES));
let plan; // [batchName, {key: seed}]
if (batchArg) {
  if (!BATCHES[batchArg]) { console.error(`✗ unknown batch "${batchArg}" — options: ${Object.keys(BATCHES).join(", ")}`); process.exit(1); }
  plan = [[batchArg, BATCHES[batchArg]]];
} else if (names.length) {
  const picked = {};
  for (const n of names) {
    if (!ALL[n]) { console.error(`✗ unknown endpoint "${n}" — options: ${Object.keys(ALL).join(", ")}`); process.exit(1); }
    picked[n] = ALL[n];
  }
  plan = [["selected", picked]];
} else {
  plan = Object.entries(BATCHES);
}

let spent = 0, ok = 0, failed = [];
for (const [batch, eps] of plan) {
  console.log(`\n── ${batch} ──`);
  for (const [key, seed] of Object.entries(eps)) {
    process.stdout.write(`→ ${key} (${seed.price}) … `);
    try {
      const res = await seed.run();
      const j = await res.json();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
      const settled = res.headers.get("x-payment-response") || res.headers.get("payment-response");
      if (seed.free) {
        if (settled) throw new Error("free endpoint returned a settlement header — it charged!");
        console.log(`✓ free (no payment) — ${seed.show(j)}`);
      } else {
        spent += Number(seed.price.replace("$", ""));
        console.log(`✓ paid & settled${settled ? "" : " (no settlement header — check!)"} — ${seed.show(j)}`);
      }
      ok++;
    } catch (e) {
      failed.push(key);
      console.log(`✗ ${String(e.message || e).slice(0, 300)}`);
    }
  }
}

console.log(`\nDone. ${ok} ok, ${failed.length} failed${failed.length ? ` (${failed.join(", ")})` : ""}. ~$${spent.toFixed(3)} spent (paid to your own PAY_TO wallet).`);
console.log("Verify Bazaar pickup (indexed within ~6h):");
console.log('  curl -s "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=100" | grep -c webbersites');
