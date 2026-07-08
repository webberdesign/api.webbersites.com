// orderbook.mjs — L2 order-book depth for GET /api/orderbook.
//
// Fetches the live bid/ask ladder from public exchange APIs (no keys),
// normalizes it to one shape, and computes the analytics a trading agent
// actually wants: spread, mid, book liquidity, and slippage estimates for
// standard notionals. Deterministic — no AI; the only inputs are the books.

const UA = "webbersites-x402-orderbook/1.0 (+https://api.webbersites.com)";
const PAIR_RE = /^[A-Z0-9]{2,10}-[A-Z0-9]{2,6}$/;
const SLIPPAGE_NOTIONALS = [1_000, 10_000, 100_000];

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    const err = new Error(`upstream ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const toLevels = (rows, depth) =>
  rows.slice(0, depth).map(([p, s]) => [Number(p), Number(s)]).filter(([p, s]) => p > 0 && s > 0);

// Each source resolves a BASE-QUOTE pair to its own symbol and returns
// { bids: [[price, size]...], asks: [...], source_pair }.
export const ORDERBOOK_SOURCES = {
  coinbase: async (base, quote, depth) => {
    const sp = `${base}-${quote}`;
    const d = await getJson(`https://api.exchange.coinbase.com/products/${sp}/book?level=2`);
    return { bids: toLevels(d.bids, depth), asks: toLevels(d.asks, depth), source_pair: sp };
  },
  binance: async (base, quote, depth) => {
    // binance.us, not binance.com — the global API 451-blocks US server IPs.
    const sp = `${base}${quote}`;
    const limit = depth <= 5 ? 5 : depth <= 10 ? 10 : depth <= 20 ? 20 : depth <= 50 ? 50 : 100;
    const d = await getJson(`https://api.binance.us/api/v3/depth?symbol=${sp}&limit=${limit}`);
    return { bids: toLevels(d.bids, depth), asks: toLevels(d.asks, depth), source_pair: sp };
  },
  kraken: async (base, quote, depth) => {
    const sp = `${base === "BTC" ? "XBT" : base}${quote}`;
    const d = await getJson(`https://api.kraken.com/0/public/Depth?pair=${sp}&count=${Math.min(depth, 500)}`);
    if (d.error?.length) { const e = new Error(d.error.join("; ")); e.status = 404; throw e; }
    const book = Object.values(d.result || {})[0];
    if (!book) { const e = new Error("pair not found"); e.status = 404; throw e; }
    return { bids: toLevels(book.bids, depth), asks: toLevels(book.asks, depth), source_pair: sp };
  },
};

// Walk one side of the book with a quote-currency budget; returns the average
// fill price, or null when the visible book is too thin to fill the order.
export function walkBook(levels, notional) {
  let spent = 0, got = 0;
  for (const [price, size] of levels) {
    const cost = price * size;
    if (spent + cost >= notional) {
      got += (notional - spent) / price;
      return { avg_price: notional / got, filled_base: got, exhausted: false };
    }
    spent += cost;
    got += size;
  }
  return got > 0 ? { avg_price: spent / got, filled_base: got, exhausted: true } : null;
}

// Pure analytics over a normalized book.
export function analyzeBook(bids, asks) {
  if (!bids.length || !asks.length) return null;
  const bestBid = bids[0], bestAsk = asks[0];
  const mid = (bestBid[0] + bestAsk[0]) / 2;
  const spread = bestAsk[0] - bestBid[0];
  const round = (x, dp = 8) => Number(x.toFixed(dp));
  const slippage = (levels, best) => SLIPPAGE_NOTIONALS.map((notional) => {
    const fill = walkBook(levels, notional);
    if (!fill) return { notional, fillable: false };
    return {
      notional,
      fillable: !fill.exhausted,
      avg_price: round(fill.avg_price, 2),
      vs_best_bps: round(Math.abs(fill.avg_price - best) / best * 10_000, 2),
      filled_base: round(fill.filled_base),
    };
  });
  return {
    mid: round(mid, 2),
    spread: round(spread, 8),
    spread_bps: round(spread / mid * 10_000, 3),
    best_bid: { price: bestBid[0], size: bestBid[1] },
    best_ask: { price: bestAsk[0], size: bestAsk[1] },
    liquidity_quote: {
      bids: round(bids.reduce((s, [p, q]) => s + p * q, 0), 2),
      asks: round(asks.reduce((s, [p, q]) => s + p * q, 0), 2),
    },
    // buy walks the asks (you lift sellers); sell walks the bids
    slippage: { buy: slippage(asks, bestAsk[0]), sell: slippage(bids, bestBid[0]) },
  };
}

// Public entry: fetch + normalize + analyze. source "auto" tries coinbase,
// then binance, then kraken, and reports which one answered.
export async function fetchOrderbook(pair, { depth = 50, source = "auto" } = {}) {
  const p = String(pair || "").toUpperCase();
  if (!PAIR_RE.test(p)) {
    const e = new Error("pair must look like BTC-USD (BASE-QUOTE)");
    e.status = 400;
    throw e;
  }
  const [base, quote] = p.split("-");
  const order = source === "auto" ? ["coinbase", "binance", "kraken"] : [source];
  if (!order.every((s) => ORDERBOOK_SOURCES[s])) {
    const e = new Error(`source must be one of: auto, ${Object.keys(ORDERBOOK_SOURCES).join(", ")}`);
    e.status = 400;
    throw e;
  }
  const errors = [];
  for (const name of order) {
    try {
      const { bids, asks, source_pair } = await ORDERBOOK_SOURCES[name](base, quote, depth);
      const analytics = analyzeBook(bids, asks);
      if (!analytics) throw Object.assign(new Error("empty book"), { status: 502 });
      return { pair: p, source: name, source_pair, depth: Math.min(depth, Math.max(bids.length, asks.length)), ...analytics, bids, asks };
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
      if (order.length === 1) { e.upstreamErrors = errors; throw e; }
    }
  }
  const e = new Error(`no source could serve ${p} — ${errors.join(" · ")}`);
  e.status = 404;
  throw e;
}
