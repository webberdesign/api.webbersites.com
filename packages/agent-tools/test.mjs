// Smoke test: quote mode (free) always runs; set EVM_PRIVATE_KEY to also make
// one real $0.001 paid call through the x402 rail.
import "dotenv/config";
import { createWebbersitesTools } from "./index.mjs";

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
};

// --- quote mode -------------------------------------------------------------
const q = await createWebbersitesTools();
ok(q.quoteMode === true && q.wallet === null, "quote mode without key");
ok(q.tools.length >= 40, `catalog built from live openapi.json (${q.tools.length} tools)`);
ok(!!q.byName.get_price_coin, "path-param tool present (get_price_coin)");
ok(!!q.byName.get_orderbook, "query-param tool present (get_orderbook)");
ok(!!q.byName.post_lint_elixir, "body tool present (post_lint_elixir)");
ok(
  q.byName.get_orderbook.parameters.properties.pair && q.byName.get_orderbook.parameters.required.includes("pair"),
  "orderbook schema has required 'pair'"
);
ok(/\$0\.\d+/.test(q.byName.get_report_coin.price || ""), `prices attached (report = ${q.byName.get_report_coin.price})`);

const quote = await q.byName.get_price_coin.execute({ coin: "bitcoin" });
ok(quote.payment_required === true && quote.price === "$0.001", "quote-mode call returns 402 quote, not data");

// --- paid mode (optional, costs $0.001) --------------------------------------
if (process.env.EVM_PRIVATE_KEY) {
  const p = await createWebbersitesTools({ privateKey: process.env.EVM_PRIVATE_KEY });
  ok(p.quoteMode === false && /^0x/.test(p.wallet), `paying wallet ${p.wallet.slice(0, 10)}…`);
  const res = await p.byName.get_price_coin.execute({ coin: "bitcoin" });
  ok(typeof res.usd === "number" && res.usd > 0, `paid call settled: BTC $${res.usd}`);
} else {
  console.log("· skipped paid-mode test (no EVM_PRIVATE_KEY)");
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
