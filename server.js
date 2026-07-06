import "dotenv/config";
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { facilitator as cdpFacilitator } from "@coinbase/x402";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import geoip from "geoip-lite";
import { isIP } from "node:net";
import { Resolver } from "node:dns/promises";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
const PAY_TO = process.env.PAY_TO_ADDRESS;
const NETWORK = process.env.NETWORK || "eip155:84532"; // Base Sepolia by default
const FACILITATOR_URL =
  process.env.FACILITATOR_URL || "https://facilitator.x402.org";
const PORT = process.env.PORT || 4021;
const BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// Machine Message Board backend (GoDaddy PHP + MySQL). BOARD_URL points at
// board.php; BOARD_SECRET must match the secret configured inside board.php.
const BOARD_URL = process.env.BOARD_URL; // e.g. https://x402.webbersites.com/api/board.php
const BOARD_SECRET = process.env.BOARD_SECRET;

if (!PAY_TO || !PAY_TO.startsWith("0x")) {
  console.error(
    "✗ PAY_TO_ADDRESS is missing or invalid. Copy .env.example to .env and set your wallet address."
  );
  process.exit(1);
}

const app = express();
// Hosts like Railway/Render sit behind a proxy; this makes req.ip reflect the
// real client so /api/geo can geolocate the caller when no ?ip= is given.
app.set("trust proxy", true);
// Parse JSON bodies (for POST endpoints like /api/schema/audit). 12 MB cap —
// sized for /api/vectorize base64 image uploads; everything else stays tiny.
app.use(express.json({ limit: "12mb" }));
// Raw text bodies for CSV uploads to the agent datastore (POST /api/store/*).
app.use(express.text({ type: ["text/csv", "application/csv"], limit: "5mb" }));

// ----------------------------------------------------------------------------
// x402 setup — this is the whole "accept crypto" part.
// A facilitator does the on-chain verification/settlement so you don't have to.
//
// If CDP API keys are set, use Coinbase's authenticated facilitator (required
// for mainnet + Bazaar discovery). The @coinbase/x402 `facilitator` config reads
// CDP_API_KEY_ID and CDP_API_KEY_SECRET from the environment and handles the
// Ed25519 JWT signing automatically. Otherwise fall back to a plain facilitator
// URL (e.g. the public testnet facilitator).
// ----------------------------------------------------------------------------
const facilitatorClient = process.env.CDP_API_KEY_ID
  ? new HTTPFacilitatorClient(cdpFacilitator)
  : new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const resourceServer = new x402ResourceServer(facilitatorClient)
  // Register the EVM "exact payment" scheme for both networks so flipping
  // NETWORK in .env between testnet and mainnet just works.
  .register("eip155:84532", new ExactEvmScheme()) // Base Sepolia (testnet)
  .register("eip155:8453", new ExactEvmScheme()); // Base mainnet

// ----------------------------------------------------------------------------
// Bazaar discovery extension (CDP). This makes endpoints show up in Coinbase's
// Bazaar so agents can FIND them. Loaded defensively: if the extension package
// or its API differs, the server still boots and keeps taking payments — it just
// won't catalog. Never let discovery break a live, earning service.
// ----------------------------------------------------------------------------
let declareDiscovery = null;
try {
  const bz = await import("@x402/extensions/bazaar");
  if (bz.bazaarResourceServerExtension && resourceServer.registerExtension) {
    resourceServer.registerExtension(bz.bazaarResourceServerExtension);
  }
  declareDiscovery = bz.declareDiscoveryExtension || null;
  console.log("✓ Bazaar discovery extension loaded");
} catch (e) {
  console.warn("⚠ Bazaar extension not loaded (service still runs):", e.message);
}

// Timezone-from-coordinates library, loaded defensively so a load failure can't
// take down the live earning service — the /api/timezone route just 503s if so.
let tzlookup = null;
try {
  const mod = await import("@photostructure/tz-lookup");
  tzlookup = mod.default || mod;
  console.log("✓ Timezone lookup loaded");
} catch (e) {
  console.warn("⚠ Timezone lib not loaded (service still runs):", e.message);
}

// Wrap a route's discovery metadata. Returns the Bazaar extension payload
// (or {} if the extension isn't available) PLUS the raw opts under `docOpts` —
// the raw opts feed the OpenAPI generator, so /openapi.json stays accurate
// even when the Bazaar extension fails to load.
const discovery = (opts) => {
  let ext = {};
  try {
    ext = declareDiscovery ? declareDiscovery(opts) : {};
  } catch {
    ext = {};
  }
  return { ext, docOpts: opts };
};

// Agent-only footer served in the body of every 402. Browsers get the paywall
// HTML instead (the middleware only uses this for API clients), so humans never
// see it. It rides the HTTP response, NOT the signed payment requirements, so
// it costs nothing against the facilitator's ~4KB requirements cap.
// Currently pitches the Agent Datastore; swap the body to rotate campaigns.
const UNPAID_FOOTER = {
  contentType: "application/json",
  body: {
    agent_tip:
      "Give your agent a memory — persistent, wallet-owned storage. POST /api/store/{collection} appends JSON/CSV rows ($0.001, up to 1,000 rows/call); GET reads them back in any later session ($0.001). The paying wallet is the identity — no accounts, no keys. Rows live 90 days, 50MB per wallet.",
  },
};

// Helper to build a paid route entry, optionally with Bazaar discovery metadata.
// The `_doc` property is stripped before the config reaches paymentMiddleware;
// it carries the price + raw discovery opts into the OpenAPI registry.
const paid = (price, description, disc) => ({
  accepts: { scheme: "exact", price, network: NETWORK, payTo: PAY_TO },
  description,
  unpaidResponseBody: () => UNPAID_FOOTER,
  ...(disc?.ext && Object.keys(disc.ext).length ? { extensions: disc.ext } : {}),
  _doc: { price, opts: disc?.docOpts || null },
});

// The paywall route map. Only the routes listed here require payment;
// everything else (the menu, the discovery doc, /openapi.json) stays free.
const PAID_ROUTES =
    {
      "GET /api/price/:coin": paid(
        "$0.001",
        "Current USD spot price and 24-hour percent change for any crypto asset by CoinGecko id. Cheap, high-volume price lookups for trading and analytics agents.",
        discovery({
          input: { coin: "bitcoin" },
          inputSchema: {
            properties: {
              coin: {
                type: "string",
                description: "CoinGecko asset id, e.g. bitcoin, ethereum, solana",
              },
            },
            required: ["coin"],
          },
          output: {
            example: { coin: "bitcoin", usd: 60000, change_24h_pct: 1.5, ts: "2026-06-27T00:00:00.000Z" },
            schema: {
              properties: {
                coin: { type: "string" },
                usd: { type: "number" },
                change_24h_pct: { type: "number" },
                ts: { type: "string" },
              },
            },
          },
        })
      ),
      "GET /api/report/:coin": paid(
        "$0.005",
        "Enriched crypto market report for one asset: rank, multi-timeframe price changes (1h/24h/7d/30d), all-time-high context, plain-English momentum/volatility/liquidity signals, and a ready-to-use written summary. For agents needing market context, not just a price.",
        discovery({
          input: { coin: "ethereum" },
          inputSchema: {
            properties: {
              coin: {
                type: "string",
                description: "CoinGecko asset id, e.g. bitcoin, ethereum, solana",
              },
            },
            required: ["coin"],
          },
          output: {
            example: {
              coin: "ethereum",
              symbol: "ETH",
              market_cap_rank: 2,
              price_usd: 1570.13,
              change_24h_pct: 0.19,
              change_7d_pct: -4.3,
              change_30d_pct: 8.1,
              from_ath_pct: -67.8,
              signals: {
                momentum: "neutral",
                trend_7d: "down",
                trend_30d: "up",
                cap_tier: "mega",
                liquidity: "high",
                volatility: "moderate",
                volume_to_mcap_pct: 4.1,
              },
              summary:
                "Ethereum (ETH) ranks #2 by market cap and trades at $1,570.13. It is +0.2% over 24 hours, -4.3% over the week, +8.1% over 30 days. Momentum is neutral, while volatility is moderate and liquidity is high (24h volume is 4.1% of market cap). It trades 67.8% below its all-time high of $4,878.26.",
            },
            schema: {
              properties: {
                coin: { type: "string" },
                symbol: { type: "string" },
                market_cap_rank: { type: "number" },
                price_usd: { type: "number" },
                change_24h_pct: { type: "number" },
                change_7d_pct: { type: "number" },
                change_30d_pct: { type: "number" },
                from_ath_pct: { type: "number" },
                signals: { type: "object" },
                summary: { type: "string" },
              },
            },
          },
        })
      ),
      "GET /api/scrape": paid(
        "$0.001",
        "Fetch any public web page and return clean, readable Markdown with navigation, ads, and boilerplate stripped. For agents that need article text or documentation as Markdown.",
        discovery({
          input: { url: "https://en.wikipedia.org/wiki/Markdown" },
          inputSchema: {
            properties: {
              url: {
                type: "string",
                description: "Public http(s) URL of the page to fetch and convert to markdown",
              },
            },
            required: ["url"],
          },
          output: {
            example: {
              url: "https://example.com",
              title: "Example",
              word_count: 120,
              markdown: "# Example\n\nClean readable text...",
            },
            schema: {
              properties: {
                url: { type: "string" },
                title: { type: "string" },
                word_count: { type: "number" },
                markdown: { type: "string" },
              },
            },
          },
        })
      ),
      "GET /api/summarize": paid(
        "$0.002",
        "Quick extractive summary of any web page: fetch the URL, extract the main article, and return the key sentences (TextRank) instead of the full text. For agents that want the gist of a page, not a full scrape. No AI — fast and deterministic.",
        discovery({
          input: { url: "https://en.wikipedia.org/wiki/Web_scraping", sentences: 3 },
          inputSchema: {
            properties: {
              url: { type: "string", description: "Public http(s) URL of the page to summarize" },
              sentences: { type: "number", description: "How many key sentences to return (1-10, default 3)" },
            },
            required: ["url"],
          },
          output: {
            example: {
              url: "https://example.com/article",
              title: "Example Article",
              summary: "The most important sentence. The second key sentence. A third.",
              key_sentences: ["The most important sentence.", "The second key sentence.", "A third."],
              original_word_count: 1200,
              summary_word_count: 42,
              method: "extractive (textrank)",
            },
            schema: {
              properties: {
                url: { type: "string" },
                title: { type: "string" },
                summary: { type: "string" },
                key_sentences: { type: "array" },
                original_word_count: { type: "number" },
                summary_word_count: { type: "number" },
                method: { type: "string" },
              },
            },
          },
        })
      ),
      "GET /api/timezone": paid(
        "$0.001",
        "Timezone from GPS coordinates: IANA zone, current UTC offset, abbreviation, DST status, and local time for any lat/lng. Fast offline lookup (approximate near borders). Pairs with the IP-geolocation endpoint for analytics and scheduling agents.",
        discovery({
          input: { lat: 40.7128, lng: -74.006 },
          inputSchema: {
            properties: {
              lat: { type: "number", description: "Latitude, -90 to 90" },
              lng: { type: "number", description: "Longitude, -180 to 180" },
            },
            required: ["lat", "lng"],
          },
          output: {
            example: {
              lat: 40.7128,
              lng: -74.006,
              timezone: "America/New_York",
              utc_offset: "-05:00",
              utc_offset_minutes: -300,
              abbreviation: "EST",
              dst_in_effect: false,
              local_time: "Jun 30, 2026, 13:05:33",
            },
            schema: {
              properties: {
                timezone: { type: "string" },
                utc_offset: { type: "string" },
                utc_offset_minutes: { type: "number" },
                abbreviation: { type: "string" },
                dst_in_effect: { type: "boolean" },
                local_time: { type: "string" },
              },
            },
          },
        })
      ),
      "GET /api/geo": paid(
        "$0.001",
        "IP geolocation: country, region, city, coordinates, and timezone for any IPv4 or IPv6 address. Fast in-memory lookup for analytics, fraud, and personalization agents.",
        discovery({
          input: { ip: "8.8.8.8" },
          inputSchema: {
            properties: {
              ip: {
                type: "string",
                description: "IPv4 or IPv6 address to locate. Omit to geolocate the caller.",
              },
            },
          },
          output: {
            example: {
              ip: "8.8.8.8",
              country: "US",
              region: "CA",
              city: "Mountain View",
              timezone: "America/Los_Angeles",
              ll: [37.4056, -122.0775],
            },
            schema: {
              properties: {
                ip: { type: "string" },
                country: { type: "string" },
                region: { type: "string" },
                city: { type: "string" },
                timezone: { type: "string" },
                ll: { type: "array" },
              },
            },
          },
        })
      ),
      "POST /api/schema/audit": paid(
        "$0.005",
        "Audit schema.org structured data (JSON-LD) for Google rich-result readiness. POST a URL or raw JSON-LD; returns detected types, missing required/recommended fields, honest rich-result status (flags deprecated types like FAQ/HowTo), and fix suggestions. Covers Product, Review, Article, Recipe, VideoObject, LocalBusiness. Current to 2026 Google guidance.",
        discovery({
          bodyType: "json",
          input: { url: "https://example.com/product-page" },
          inputSchema: {
            properties: {
              url: { type: "string", description: "Public URL to fetch and audit its JSON-LD" },
              jsonld: { type: "object", description: "Raw JSON-LD object to audit directly (alternative to url)" },
            },
          },
          output: {
            example: {
              found: 1,
              audited: 1,
              with_issues: 1,
              detected: [
                {
                  detected_type: "VideoObject",
                  audited_as: "VideoObject",
                  rich_result_status: "active",
                  required_missing: ["thumbnailUrl"],
                  recommended_missing: ["duration", "hasPart"],
                  notes: ["Use interactionStatistic for view counts, NOT interactionCount (deprecated)."],
                },
              ],
            },
            schema: {
              properties: {
                found: { type: "number" },
                audited: { type: "number" },
                with_issues: { type: "number" },
                detected: { type: "array" },
              },
            },
          },
        })
      ),
      "GET /api/email/verify": paid(
        "$0.001",
        "Email verification for outreach and CRM agents: syntax validation, MX lookup with implicit-MX fallback, disposable-domain detection, role-account and free-provider flags, plus-tag normalization, and a deliverability verdict. No signup, no external services.",
        discovery({
          input: { email: "jane.doe+news@gmail.com" },
          inputSchema: {
            properties: { email: { type: "string", description: "Email address to verify" } },
            required: ["email"],
          },
          output: {
            example: {
              email: "jane.doe+news@gmail.com",
              normalized: "janedoe@gmail.com",
              syntax: { valid: true },
              domain_check: { mx_found: true },
              flags: { disposable: false, role_account: false, free_provider: true, plus_tag: true },
              verdict: "deliverable_domain",
            },
            schema: {
              properties: {
                email: { type: "string" },
                normalized: { type: "string" },
                syntax: { type: "object" },
                domain_check: { type: "object" },
                flags: { type: "object" },
                verdict: { type: "string" },
              },
            },
          },
        })
      ),
      "GET /api/og/check": paid(
        "$0.001",
        "Social share / OpenGraph checker: extracts og:*, twitter:*, title, description, canonical and robots meta from any URL, verifies the og:image actually loads and is a raster format, and returns problems, warnings, and a verdict. For publishing and SEO agents shipping pages that get shared.",
        discovery({
          input: { url: "https://example.com/blog/post" },
          inputSchema: {
            properties: { url: { type: "string", description: "Public URL of the page to check" } },
            required: ["url"],
          },
          output: {
            example: {
              url: "https://example.com/blog/post",
              problems: ["og:image missing — links will share without a preview image."],
              warnings: ["twitter:card missing — use 'summary_large_image' for the big card."],
              verdict: "broken",
            },
            schema: {
              properties: {
                url: { type: "string" },
                meta: { type: "object" },
                image_check: { type: "object" },
                problems: { type: "array" },
                warnings: { type: "array" },
                verdict: { type: "string" },
              },
            },
          },
        })
      ),
      "POST /api/og/card": paid(
        "$0.005",
        "Social card generator: POST {title, subtitle, domain, theme, accent} and receive a finished 1200x630 OpenGraph card — PNG (base64) plus the source SVG. Three themes (dark, light, midnight), custom accent color, automatic text wrapping. Pairs with /api/og/check: check the page, then generate the missing card.",
        discovery({
          bodyType: "json",
          input: { title: "Ship Faster With Agent-Native APIs", subtitle: "Pay-per-call data for autonomous software", domain: "x402.webbersites.com", theme: "dark" },
          inputSchema: {
            properties: {
              title: { type: "string", description: "Card headline (required, wraps to 3 lines, max 140 chars)" },
              subtitle: { type: "string", description: "Smaller supporting line (optional)" },
              domain: { type: "string", description: "Shown bottom-left in accent color (optional)" },
              theme: { type: "string", description: "dark (default), light, or midnight" },
              accent: { type: "string", description: "Hex accent color override, e.g. #ff6b35" },
            },
            required: ["title"],
          },
          output: {
            example: { width: 1200, height: 630, theme: "dark", svg: "<svg …>", png_base64: "iVBORw0…", data_uri: "data:image/png;base64,…" },
            schema: {
              properties: {
                width: { type: "number" },
                height: { type: "number" },
                svg: { type: "string" },
                png_base64: { type: "string" },
                data_uri: { type: "string" },
              },
            },
          },
        })
      ),
      "GET /api/seo/alt-check": paid(
        "$0.001",
        "Alt-text audit for any page: finds images with missing alt attributes, flags filename-as-alt and generic alt text, over-long alt, unlabeled svg[role=img], image-map areas and image inputs without alternatives. Counts decorative alt=\"\" separately. For SEO and accessibility agents.",
        discovery({
          input: { url: "https://example.com" },
          inputSchema: {
            properties: { url: { type: "string", description: "Public URL of the page to audit" } },
            required: ["url"],
          },
          output: {
            example: {
              url: "https://example.com",
              images_total: 24, with_good_alt: 15, missing_alt: 6, empty_alt_decorative: 2, low_quality_alt: 1,
              issues: [{ tag: "img", src: "/hero.jpg", issue: "missing_alt" }],
            },
            schema: {
              properties: {
                images_total: { type: "number" }, missing_alt: { type: "number" },
                low_quality_alt: { type: "number" }, issues: { type: "array" },
              },
            },
          },
        })
      ),
      "GET /api/a11y/contrast": paid(
        "$0.001",
        "WCAG contrast ratio between two colors — the check the URL-based a11y endpoint can't do. Give a foreground and background color (hex or rgb()); returns the exact ratio and AA/AAA pass/fail for normal text, large text, and UI components, with a plain-English verdict. ?fg=&bg=",
        discovery({
          input: { fg: "#767676", bg: "#ffffff" },
          inputSchema: {
            properties: {
              fg: { type: "string", description: "Foreground/text color — hex (#111 or #111111) or rgb()" },
              bg: { type: "string", description: "Background color — hex or rgb()" },
            },
            required: ["fg", "bg"],
          },
          output: {
            example: { foreground: "#767676", background: "#ffffff", contrast_ratio: 4.54, ratio_string: "4.54:1", passes: { normal_text: { AA: true, AAA: false }, large_text: { AA: true, AAA: true } }, summary: "Good — passes AA for normal text and AAA for large text." },
            schema: { properties: { contrast_ratio: { type: "number" }, passes: { type: "object" }, summary: { type: "string" } } },
          },
        })
      ),
      "GET /api/a11y/check": paid(
        "$0.001",
        "WCAG accessibility check (static analysis): findings mapped to WCAG success criteria with A/AA/AAA levels — alt text, page title, lang, form labels, heading structure, table headers, link purpose, accessible names, duplicate IDs, ARIA role validity, zoom blocking, meta refresh, skip links. Filter with ?level=A|AA|AAA. Honestly reports what static analysis cannot check (contrast, focus, keyboard).",
        discovery({
          input: { url: "https://example.com", level: "AA" },
          inputSchema: {
            properties: {
              url: { type: "string", description: "Public URL of the page to check" },
              level: { type: "string", description: "Filter findings to A, AA, or AAA (includes lower levels)" },
            },
            required: ["url"],
          },
          output: {
            example: {
              url: "https://example.com",
              findings: [{ criterion: "1.1.1", level: "A", name: "Non-text content", count: 6, detail: "Images without usable text alternatives." }],
              totals: { issues: 9, by_level: { A: 8, AA: 1, AAA: 0 }, criteria_failed: 3 },
              not_checked: ["1.4.3 color contrast (needs rendering)"],
            },
            schema: {
              properties: {
                findings: { type: "array" }, totals: { type: "object" }, not_checked: { type: "array" },
              },
            },
          },
        })
      ),
      "GET /api/seo/robots-check": paid(
        "$0.001",
        "robots.txt + llms.txt checker: crawler access verdicts for major search AND AI bots (Googlebot, Bingbot, GPTBot, ClaudeBot, PerplexityBot, CCBot, Google-Extended and more), declared sitemaps, syntax warnings, and llms.txt / llms-full.txt presence with structure summary. ?url=any page on the site",
        discovery({
          input: { url: "https://example.com" },
          inputSchema: { properties: { url: { type: "string", description: "Domain or any page on it" } }, required: ["url"] },
          output: {
            example: { origin: "https://example.com", robots: { found: true, bots: { GPTBot: { kind: "ai", root_blocked: true }, Googlebot: { kind: "search", root_blocked: false } }, sitemaps_declared: ["https://example.com/sitemap.xml"] }, llms_txt: { found: false } },
            schema: { properties: { origin: { type: "string" }, robots: { type: "object" }, llms_txt: { type: "object" } } },
          },
        })
      ),
      "GET /api/seo/metadata": paid(
        "$0.001",
        "Raw metadata extractor: the complete, unopinionated head inventory of a page — title, charset, lang, canonical, all meta tags grouped by family (OpenGraph, Twitter, Dublin Core, named, http-equiv, itemprop), every link relation, and JSON-LD returned as parsed objects. For agents doing their own processing (head-check audits the same data; this just dumps it). ?url=",
        discovery({
          input: { url: "https://example.com" },
          inputSchema: { properties: { url: { type: "string", description: "Public URL to extract metadata from" } }, required: ["url"] },
          output: {
            example: { title: "Example", charset: "utf-8", lang: "en", counts: { meta_tags: 18, og: 5, twitter: 4, links: 9, jsonld_blocks: 1 }, opengraph: { title: "Example", image: "https://example.com/og.png" }, links: { canonical: ["https://example.com/"], icon: [{ href: "/favicon.ico", sizes: "32x32" }] }, jsonld: [{ "@type": "Organization" }] },
            schema: { properties: { title: { type: "string" }, counts: { type: "object" }, opengraph: { type: "object" }, meta: { type: "object" }, links: { type: "object" }, jsonld: { type: "array" } } },
          },
        })
      ),
      "GET /api/seo/head-check": paid(
        "$0.001",
        "Head/meta SEO audit: title and description with truncation-length warnings, robots meta (flags NOINDEX), canonical status (self-referencing vs pointing elsewhere), hreflang validation, charset, viewport, favicon, H1 count, lang, OG/Twitter presence. The on-page fundamentals in one call. ?url=",
        discovery({
          input: { url: "https://example.com/page" },
          inputSchema: { properties: { url: { type: "string", description: "Public URL of the page to audit" } }, required: ["url"] },
          output: {
            example: { title: { text: "Example Page", length: 12 }, canonical: { status: "self-referencing" }, h1_count: 1, problems: [], warnings: ["Title is only 12 chars"], verdict: "improvable" },
            schema: { properties: { title: { type: "object" }, canonical: { type: "object" }, problems: { type: "array" }, warnings: { type: "array" }, verdict: { type: "string" } } },
          },
        })
      ),
      "GET /api/seo/sitemap-check": paid(
        "$0.001",
        "Sitemap validator: finds the sitemap (direct URL, robots.txt declaration, or /sitemap.xml), handles sitemap indexes, validates entries and lastmod dates, flags cross-host URLs and oversize files, and health-checks a sample of listed URLs for dead pages. ?url=site root or sitemap URL",
        discovery({
          input: { url: "https://example.com" },
          inputSchema: { properties: { url: { type: "string", description: "Site root or direct sitemap URL" } }, required: ["url"] },
          output: {
            example: { sitemap_url: "https://example.com/sitemap.xml", found: true, type: "urlset", url_count: 342, with_lastmod: 342, sample_health: [{ url: "https://example.com/", status: 200, ok: true }], verdict: "good" },
            schema: { properties: { sitemap_url: { type: "string" }, found: { type: "boolean" }, url_count: { type: "number" }, sample_health: { type: "array" }, verdict: { type: "string" } } },
          },
        })
      ),
      "GET /api/seo/nav": paid(
        "$0.001",
        "Navigation extractor: pulls a site's *navigation* links (not every link) by scoring candidate regions — semantic <nav>, role=navigation, header/footer, and common menu class patterns — then returns them grouped by source (primary nav, header, footer). For agents mapping site structure or planning which pages to fetch. Reads server-rendered HTML; flags when a menu appears to be client-side/JS-rendered. ?url=",
        discovery({
          input: { url: "https://example.com" },
          inputSchema: { properties: { url: { type: "string", description: "Public URL to extract navigation from" } }, required: ["url"] },
          output: {
            example: { nav_regions_found: 3, primary_nav: { source: "nav (main-menu)", count: 5, links: [{ text: "Products", href: "https://example.com/products", internal: true }] }, unique_nav_links: 12 },
            schema: { properties: { nav_regions_found: { type: "number" }, primary_nav: { type: "object" }, regions: { type: "array" }, all_nav_links: { type: "array" } } },
          },
        })
      ),
      "GET /api/seo/links": paid(
        "$0.001",
        "Internal-link analyzer for one page: internal vs external counts, nofollow/sponsored/ugc usage, empty and generic anchors, target=_blank without noopener, most-repeated links, and top internal anchor texts. ?url=",
        discovery({
          input: { url: "https://example.com" },
          inputSchema: { properties: { url: { type: "string", description: "Public URL of the page to analyze" } }, required: ["url"] },
          output: {
            example: { total_links: 87, internal: 54, external: 33, rel: { nofollow: 12, sponsored: 0, ugc: 0 }, generic_anchors: ["read more"], top_internal_anchor_texts: [{ text: "pricing", count: 4 }] },
            schema: { properties: { total_links: { type: "number" }, internal: { type: "number" }, external: { type: "number" }, rel: { type: "object" } } },
          },
        })
      ),
      "GET /api/seo/full-audit": paid(
        "$0.007",
        "FULL on-page audit bundle — seven analyses in one call against a single URL: head/meta SEO audit, alt-text check, social-card check with og:image verification, internal-link analysis, WCAG accessibility check (choose level), schema.org structured-data audit, and a robots/llms.txt crawler summary. Returns a transparent 0-100 score with itemized deductions plus every full sub-report. Buying these individually costs ~$0.011; the bundle is $0.007.",
        discovery({
          input: { url: "https://example.com", level: "AA" },
          inputSchema: {
            properties: {
              url: { type: "string", description: "Public URL of the page to audit" },
              level: { type: "string", description: "WCAG level for the accessibility section: A, AA (default), or AAA" },
            },
            required: ["url"],
          },
          output: {
            example: {
              url: "https://example.com", score: 84, grade: "B",
              deductions: [{ points: 6, reason: "3 head/meta warnings" }],
              sections: { head: { verdict: "improvable" }, social: { verdict: "good" }, alt_text: { missing_alt: 2 }, accessibility: { totals: { criteria_failed: 2 } }, structured_data: { jsonld_blocks: 1 }, robots: { ai_bots_root_blocked: ["GPTBot"] } },
            },
            schema: {
              properties: { score: { type: "number" }, grade: { type: "string" }, deductions: { type: "array" }, sections: { type: "object" } },
            },
          },
        })
      ),
      "GET /api/music/album": paid(
        "$0.002",
        "Album metadata lookup via the Discogs database: search by artist + title (or free-text q, or Discogs id) and get canonical album data — tracklist with durations, genres, styles, year, country, labels, formats, community have/want/rating, and a cover-art URL. For music, playlist, and cataloging agents.",
        discovery({
          input: { artist: "Radiohead", title: "OK Computer" },
          inputSchema: {
            properties: {
              artist: { type: "string", description: "Artist name (with title)" },
              title: { type: "string", description: "Album title (with artist)" },
              q: { type: "string", description: "Free-text search alternative" },
              id: { type: "string", description: "Direct Discogs id (with optional kind)" },
              kind: { type: "string", description: "master (default) or release, for id lookups" },
            },
          },
          output: {
            example: { title: "OK Computer", artists: ["Radiohead"], year: 1997, genres: ["Electronic", "Rock"], tracklist: [{ position: "1", title: "Airbag", duration: "4:44" }], community: { have: 120000, want: 45000, rating: 4.6 }, cover_endpoint: "/api/music/cover?id=32063&kind=master" },
            schema: { properties: { title: { type: "string" }, artists: { type: "array" }, year: { type: "number" }, tracklist: { type: "array" }, cover_url: { type: "string" } } },
          },
        })
      ),
      "GET /api/music/cover": paid(
        "$0.002",
        "Album cover art via Discogs: same selectors as /api/music/album (artist+title, q, or id) — returns the primary cover image as base64 + data URI with dimensions and content type, ready to embed or save. Pairs with /api/music/album.",
        discovery({
          input: { artist: "Radiohead", title: "OK Computer" },
          inputSchema: {
            properties: {
              artist: { type: "string", description: "Artist name (with title)" },
              title: { type: "string", description: "Album title (with artist)" },
              q: { type: "string", description: "Free-text search alternative" },
              id: { type: "string", description: "Direct Discogs id" },
              kind: { type: "string", description: "master (default) or release" },
            },
          },
          output: {
            example: { title: "OK Computer", year: 1997, content_type: "image/jpeg", bytes: 240311, width: 600, height: 600, image_base64: "…", data_uri: "data:image/jpeg;base64,…" },
            schema: { properties: { content_type: { type: "string" }, bytes: { type: "number" }, image_base64: { type: "string" }, data_uri: { type: "string" } } },
          },
        })
      ),
      "GET /api/extract": paid(
        "$0.001",
        "Document extraction: fetch a PDF, DOCX, or CSV by URL and get clean Markdown plus structured JSON — PDF text by page with metadata (honestly flags scanned PDFs that would need OCR), DOCX converted to real Markdown, CSV parsed to typed columns + JSON rows + a Markdown table. For agents that need document contents, not bytes.",
        discovery({
          input: { url: "https://example.com/quarterly-report.pdf" },
          inputSchema: {
            properties: {
              url: { type: "string", description: "Public http(s) URL of the .pdf, .docx, or .csv document" },
              type: { type: "string", description: "Force the parser: pdf, docx, or csv (default: auto-detect from content-type, extension, magic bytes)" },
              max_rows: { type: "number", description: "CSV only: max rows returned as JSON (default 1000, max 5000)" },
            },
            required: ["url"],
          },
          output: {
            example: {
              url: "https://example.com/quarterly-report.pdf",
              type: "pdf", pages: 12,
              metadata: { title: "Q2 Report", author: "Finance Team" },
              markdown: "## Page 1\n\nExecutive summary…",
              word_count: 4120,
            },
            schema: {
              properties: {
                type: { type: "string" },
                markdown: { type: "string" },
                pages: { type: "number" },
                metadata: { type: "object" },
                word_count: { type: "number" },
                columns: { type: "array" },
                rows: { type: "array" },
                row_count: { type: "number" },
              },
            },
          },
        })
      ),
      "GET /api/icon/search": paid(
        "$0.002",
        "Search Font Awesome Free (2000+ icons) by keyword: matches names, labels, and official search terms, ranked. Returns icon names, available styles (solid/regular/brands), and terms. Use the chosen name in POST /api/icon/generate.",
        discovery({
          input: { q: "rocket", style: "solid" },
          inputSchema: {
            properties: {
              q: { type: "string", description: "Keyword to search, e.g. rocket, shopping cart, music" },
              style: { type: "string", description: "Optional filter: solid, regular, or brands" },
            },
            required: ["q"],
          },
          output: {
            example: { query: "rocket", count: 3, results: [{ name: "rocket", label: "Rocket", styles: ["solid"], score: 100 }] },
            schema: { properties: { query: { type: "string" }, count: { type: "number" }, results: { type: "array" } } },
          },
        })
      ),
      "POST /api/icon/generate": paid(
        "$0.005",
        "Icon generator: pick a Font Awesome Free icon (by search query or exact name) plus background color(s) and get an app-icon-ready asset — SVG source + PNG base64, default 1024x1024 opaque squircle (iOS-ready). Options: 1-2 background colors (2 = gradient), fg glyph color, shape (squircle/rounded/circle/square/transparent), size 64-1024, padding. Returns alternatives when resolved via search.",
        discovery({
          bodyType: "json",
          input: { query: "rocket", colors: ["#ff6b35", "#b23b18"], fg: "#ffffff", shape: "squircle", size: 1024 },
          inputSchema: {
            properties: {
              query: { type: "string", description: "Search text — best match is used automatically" },
              icon: { type: "string", description: "Exact Font Awesome icon name (skips search)" },
              style: { type: "string", description: "solid (default), regular, or brands" },
              colors: { type: "array", description: "1-2 background hex colors; 2 makes a diagonal gradient" },
              fg: { type: "string", description: "Glyph hex color (default #ffffff)" },
              shape: { type: "string", description: "squircle (default, iOS-style), rounded, circle, square" },
              size: { type: "number", description: "Pixel size 64-1024 (default 1024)" },
              padding: { type: "number", description: "Glyph padding as fraction 0.05-0.35 (default 0.18)" },
            },
          },
          output: {
            example: { icon: { name: "rocket", label: "Rocket", style: "solid" }, size: 1024, svg: "<svg …>", png_base64: "iVBOR…", attribution: "Icon from Font Awesome Free, CC BY 4.0." },
            schema: { properties: { icon: { type: "object" }, svg: { type: "string" }, png_base64: { type: "string" }, attribution: { type: "string" } } },
          },
        })
      ),
      "POST /api/logo/generate": paid(
        "$0.005",
        "Logo generator: POST a company name (+ optional tagline), an icon (search query or exact Font Awesome name), 1-3 brand colors (hex or CSS names), a mark shape (squircle/rounded/circle/square/transparent) and a layout — icon above/below the name (square logo) or beside it (wide lockup) — and get a finished logo as SVG + PNG. Text set in one of six curated open-license fonts (named or randomly rotated), rendered as vector paths.",
        discovery({
          bodyType: "json",
          input: { name: "Northwind", tagline: "Data for autonomous agents", query: "rocket", layout: "bottom", shape: "squircle", colors: ["#ff6b35", "#b23b18"], font: "montserrat" },
          inputSchema: {
            properties: {
              name: { type: "string", description: "Company/product wordmark text (required, max 40 chars)" },
              tagline: { type: "string", description: "Optional tagline under the name (max 60 chars)" },
              query: { type: "string", description: "Icon search text — best Font Awesome match becomes the mark" },
              icon: { type: "string", description: "Exact Font Awesome icon name (skips search)" },
              style: { type: "string", description: "Icon style: solid (default), regular, or brands" },
              layout: { type: "string", description: "Mark position vs text: bottom (mark above name, square — default), top (name above mark, square), right or left (side-by-side wide lockup)" },
              shape: { type: "string", description: "Mark background: squircle (default), rounded, circle, square, transparent" },
              colors: { type: "array", description: "1-3 colors, hex or CSS names: [0] brand (mark bg, or glyph if transparent), [1] gradient partner, [2] text color (default: brand)" },
              font: { type: "string", description: "montserrat, playfair, space-grotesk, bebas, poppins, dm-serif — omit for random" },
              fg: { type: "string", description: "Glyph color override (default white on filled shapes)" },
              bg: { type: "string", description: "Canvas background color (default transparent)" },
            },
            required: ["name"],
          },
          output: {
            example: { name: "Northwind", icon: { name: "rocket", style: "solid" }, font: { key: "montserrat", label: "Montserrat Bold" }, layout: "bottom", width: 1024, height: 1024, svg: "<svg …>", png_base64: "iVBOR…" },
            schema: { properties: { name: { type: "string" }, icon: { type: "object" }, font: { type: "object" }, width: { type: "number" }, height: { type: "number" }, svg: { type: "string" }, png_base64: { type: "string" } } },
          },
        })
      ),
      "POST /api/vectorize": paid(
        "$0.009",
        "High-quality image vectorization powered by Vectorizer.AI: POST a public image URL or base64 (PNG/JPEG/GIF/BMP/WebP, up to 10 MB) and get a production-grade vector back — SVG by default, or PNG/PDF/EPS/DXF. Full-color tracing, clean paths, ready for print, cutting, and scaling. The premium finish for logos, icons, sketches, and raster art.",
        discovery({
          bodyType: "json",
          input: { url: "https://example.com/logo.png", output_format: "svg" },
          inputSchema: {
            properties: {
              url: { type: "string", description: "Public URL of the raster image to vectorize (PNG, JPEG, GIF, BMP, WebP; max 10 MB)" },
              image_base64: { type: "string", description: "Base64-encoded image as an alternative to url (data URIs accepted)" },
              output_format: { type: "string", description: "svg (default), png, pdf, eps, or dxf" },
              mode: { type: "string", description: "production (default, full quality), preview, or test" },
              max_colors: { type: "number", description: "Limit the color count, 0-256 (0 = unlimited). Great for flat/logo looks" },
              palette: { type: "array", description: "Force a specific palette: array of hex or CSS color names — output only uses these colors" },
              draw_style: { type: "string", description: "fill_shapes (default), stroke_shapes, or stroke_edges (line-art outlines)" },
              group_by: { type: "string", description: "SVG shape grouping: none (default), color, parent, or layer" },
              scale: { type: "number", description: "Output size multiplier vs input, 0-100 (e.g. 2 = double size)" },
              min_area_px: { type: "number", description: "Drop shapes smaller than this many pixels (0-10000) — despeckling" },
              options: { type: "object", description: "Raw passthrough for any documented Vectorizer.AI option, e.g. {\"output.gap_filler.enabled\": false} — see vectorizer.ai/api" },
            },
          },
          output: {
            example: { source: "https://example.com/logo.png", mode: "production", output_format: "svg", content_type: "image/svg+xml", input_bytes: 48211, output_bytes: 15302, svg: "<svg …>", engine: "vectorizer.ai" },
            schema: { properties: { output_format: { type: "string" }, content_type: { type: "string" }, svg: { type: "string" }, image_base64: { type: "string" }, output_bytes: { type: "number" } } },
          },
        })
      ),
      // NOTE: keep this route's total payment requirements under ~4KB — the CDP
      // facilitator rejects larger requirement payloads at verify time (the
      // payment fails with "paymentPayload is invalid"). Keep descriptions tight.
      "POST /api/website/page": paid(
        "$0.005",
        "Webbie page generator: site name, headline, tagline, hero images, content sections, nav, colors — returns a finished responsive standalone HTML page. Three templates (horizon, split, editorial); the seed deterministically picks template + fonts + accent, so reusing it across calls builds a consistent multi-page site. Nav loads from an editable nav.json at view-time. No AI — deterministic templating.",
        discovery({
          bodyType: "json",
          input: { site_name: "Northwind", headline: "Data for autonomous agents", seed: "nw-2026", template: "horizon", hero_image: "https://example.com/hero.jpg", colors: ["#ff6b35"], cta: { text: "Get started", href: "docs.html" } },
          inputSchema: {
            properties: {
              site_name: { type: "string", description: "Brand/site name (required)" },
              headline: { type: "string", description: "Hero headline" },
              page_name: { type: "string", description: "'home' = index.html (default), or e.g. 'about'" },
              seed: { type: "string", description: "Reuse the same seed on every call for one consistent site style" },
              template: { type: "string", description: "horizon, split, or editorial; omit to let the seed choose" },
              title: { type: "string", description: "Browser/SEO title" },
              caption: { type: "string", description: "Kicker above the headline" },
              tagline: { type: "string", description: "Supporting line + meta description" },
              hero_images: { type: "array", description: "First = hero, extras = gallery" },
              logo_url: { type: "string", description: "Nav logo image URL" },
              logo: { type: "object", description: "Auto-generate mark: {query, colors, shape}" },
              colors: { type: "array", description: "1-2 accents, hex or CSS names" },
              cta: { type: "object", description: "{text, href}" },
              content: { type: "array", description: "Sections: [{heading, body}]" },
              nav: { type: "array", description: "[{label, href}] — echoed as nav_json" },
              footer: { type: "string", description: "Footer text" },
            },
            required: ["site_name"],
          },
          output: {
            example: { seed: "nw-2026", template: "horizon", filename: "index.html", html: "<!DOCTYPE html>…", nav_json: { links: [] } },
            schema: { properties: { seed: { type: "string" }, template: { type: "string" }, filename: { type: "string" }, html: { type: "string" }, html_bytes: { type: "number" }, nav_json: { type: "object" }, style: { type: "object" } } },
          },
        })
      ),
      "GET /api/wp/assess": paid(
        "$0.005",
        // NOTE: CDP facilitator verify rejects descriptions over 500 chars
        // (payments 402 with "paymentPayload is invalid") — keep this ≤ ~480.
        "WordPress security posture check — PASSIVE hygiene assessment from public signals: detects WordPress, flags version disclosure (generator tag, readme.html), xmlrpc.php exposure, user enumeration, uploads directory listing, login exposure, missing security headers, and HTTPS. Returns a 0-100 posture score with prioritized remediation. Flags security practice, not exploitable vulnerabilities — no CVE matching, no intrusion. For site owners and authorized auditors. ?url=",
        discovery({
          input: { url: "https://example.com" },
          inputSchema: { properties: { url: { type: "string", description: "WordPress site URL to assess (homepage)" } }, required: ["url"] },
          output: {
            example: { url: "https://example.com", is_wordpress: true, posture_score: 71, grade: "C", finding_counts: { medium: 2, low: 3 }, findings: [{ severity: "medium", area: "xmlrpc", detail: "xmlrpc.php is reachable…", fix: "Disable XML-RPC if unused…" }], disclaimer: "Passive hygiene assessment from public signals only." },
            schema: { properties: { is_wordpress: { type: "boolean" }, posture_score: { type: "number" }, grade: { type: "string" }, findings: { type: "array" } } },
          },
        })
      ),
      "GET /api/dns": paid(
        "$0.002",
        "DNS and domain intelligence: A/AAAA/CNAME, MX (sorted), NS, TXT, SOA records plus email security posture — SPF record, DMARC policy, and DKIM selector probing. For deliverability, security, and research agents. ?domain=example.com",
        discovery({
          input: { domain: "example.com" },
          inputSchema: {
            properties: { domain: { type: "string", description: "Domain to inspect, e.g. example.com" } },
            required: ["domain"],
          },
          output: {
            example: {
              domain: "example.com",
              resolves: true,
              records: { a: ["93.184.215.14"], mx: [{ exchange: "mail.example.com", priority: 10 }], ns: ["a.iana-servers.net"], txt: ["v=spf1 -all"] },
              email: { mail_configured: true, spf: { present: true }, dmarc: { present: true, policy: "reject" }, dkim: { found_selectors: [] } },
            },
            schema: {
              properties: {
                domain: { type: "string" },
                resolves: { type: "boolean" },
                records: { type: "object" },
                email: { type: "object" },
              },
            },
          },
        })
      ),
      "POST /api/schema/generate": paid(
        "$0.005",
        "Generate valid, current-spec schema.org JSON-LD from plain fields — the complement to /api/schema/audit. POST {type, fields}; returns correctly nested JSON-LD, a ready-to-embed <script> tag, and a self-audit. Types: Product, Review, Article, Recipe, VideoObject, LocalBusiness, Organization, BreadcrumbList. Current to 2026 Google guidance (interactionStatistic, Key Moments clips, etc).",
        discovery({
          bodyType: "json",
          input: { type: "Product", fields: { name: "Widget Pro", price: 19.99, priceCurrency: "USD", brand: "Acme", image: "https://example.com/w.jpg" } },
          inputSchema: {
            properties: {
              type: { type: "string", description: "Product, Review, Article, Recipe, VideoObject, LocalBusiness, Organization, or BreadcrumbList" },
              fields: { type: "object", description: "Plain fields for the type, e.g. {name, price, brand} for Product" },
            },
            required: ["type", "fields"],
          },
          output: {
            example: {
              type: "Product",
              jsonld: { "@context": "https://schema.org", "@type": "Product", name: "Widget Pro", offers: { "@type": "Offer", price: "19.99", priceCurrency: "USD" } },
              script_tag: "<script type=\"application/ld+json\">…</script>",
              self_audit: { rich_result_status: "active", required_missing: [] },
            },
            schema: {
              properties: {
                type: { type: "string" },
                jsonld: { type: "object" },
                script_tag: { type: "string" },
                generation_notes: { type: "array" },
                self_audit: { type: "object" },
              },
            },
          },
        })
      ),
      "GET /api/seo/site-audit": paid(
        "$0.009",
        "SITE-WIDE audit — the full 7-part on-page audit (head/meta, alt text, social cards, links, WCAG, schema.org, robots) run across up to 8 pages of one site in a single call. Discovers pages from the start URL's internal links, audits each, and returns per-page scores plus a site-level score, grade, and the issues that repeat across pages. The finished deliverable: one call, whole-site verdict. ?url=&pages=&level=&detail=",
        discovery({
          input: { url: "https://example.com", pages: 5, level: "AA" },
          inputSchema: {
            properties: {
              url: { type: "string", description: "Start URL (usually the homepage)" },
              pages: { type: "number", description: "Max pages to audit, 2-8 (default 5)" },
              level: { type: "string", description: "WCAG level: A, AA (default), AAA" },
              detail: { type: "string", description: "summary (default) or full — full includes every per-page section report" },
            },
            required: ["url"],
          },
          output: {
            example: { site: "https://example.com", site_score: 78, grade: "C", pages_audited: 5, pages: [{ url: "https://example.com/", score: 82, grade: "B", top_issues: ["2 head/meta problems"] }], common_issues: [{ reason: "images missing alt", pages_affected: 4 }] },
            schema: { properties: { site: { type: "string" }, site_score: { type: "number" }, grade: { type: "string" }, pages_audited: { type: "number" }, pages: { type: "array" }, common_issues: { type: "array" } } },
          },
        })
      ),
      "POST /api/brand/kit": paid(
        "$0.007",
        "BRAND KIT bundle — one call, a complete starter identity: finished logo (SVG + PNG), app icon (1024px SVG + PNG), 1200x630 social/OG card, and a usable color palette with WCAG-checked text pairings. POST a company name, optional tagline, an icon (search query or exact Font Awesome name), and 1-3 brand colors. Everything matches: same mark, same colors, same fonts. Buying the pieces individually costs ~$0.015; the kit is $0.007 and adds the palette and coherence.",
        discovery({
          bodyType: "json",
          input: { name: "Northwind", tagline: "Data for autonomous agents", query: "rocket", colors: ["#ff6b35"], shape: "squircle", theme: "dark", domain: "northwind.io" },
          inputSchema: {
            properties: {
              name: { type: "string", description: "Company/product name (required, max 40 chars)" },
              tagline: { type: "string", description: "Optional tagline (max 60 chars)" },
              query: { type: "string", description: "Icon search text — best Font Awesome match becomes the mark" },
              icon: { type: "string", description: "Exact Font Awesome icon name (skips search)" },
              colors: { type: "array", description: "1-3 brand colors, hex or CSS names" },
              layout: { type: "string", description: "Logo layout: bottom (default), top, left, right" },
              shape: { type: "string", description: "Mark shape: squircle (default), rounded, circle, square" },
              font: { type: "string", description: "montserrat, playfair, space-grotesk, bebas, poppins, dm-serif — omit for random" },
              theme: { type: "string", description: "Social card theme: dark (default), light, midnight" },
              domain: { type: "string", description: "Domain shown on the social card" },
            },
            required: ["name"],
          },
          output: {
            example: { name: "Northwind", logo: { svg: "<svg …>", png_base64: "iVBOR…" }, icon: { svg: "<svg …>", png_base64: "iVBOR…" }, og_card: { svg: "<svg …>", png_base64: "iVBOR…" }, palette: { primary: "#ff6b35", on_primary: "#ffffff" } },
            schema: { properties: { name: { type: "string" }, logo: { type: "object" }, icon: { type: "object" }, og_card: { type: "object" }, palette: { type: "object" } } },
          },
        })
      ),
      "POST /api/website/build": paid(
        "$0.009",
        "WHOLE-SITE generator — up to 6 finished, consistent HTML pages in one call. POST a site name, shared branding (colors, logo, footer), and a pages[] array (each with page_name, headline, content sections, hero images); one seed styles every page identically and a shared nav linking all pages is built automatically. Returns ready-to-upload files plus nav.json. The multi-page version of /api/website/page.",
        discovery({
          bodyType: "json",
          input: { site_name: "Northwind", seed: "nw-2026", colors: ["#ff6b35"], pages: [{ page_name: "home", headline: "Data for autonomous agents" }, { page_name: "pricing", headline: "Simple pricing" }] },
          inputSchema: {
            properties: {
              site_name: { type: "string", description: "Brand/site name (required)" },
              seed: { type: "string", description: "Style seed — omit for random; returned so you can add pages later" },
              template: { type: "string", description: "horizon, split, or editorial; omit to let the seed choose" },
              colors: { type: "array", description: "1-2 accents, hex or CSS names" },
              logo_url: { type: "string", description: "Nav logo image URL" },
              logo: { type: "object", description: "Auto-generate mark: {query, colors, shape}" },
              footer: { type: "string", description: "Footer text (all pages)" },
              pages: { type: "array", description: "1-6 pages: [{page_name, headline, title, caption, tagline, hero_images, content, cta}]" },
            },
            required: ["site_name", "pages"],
          },
          output: {
            example: { seed: "nw-2026", template: "horizon", page_count: 2, pages: [{ page_name: "home", filename: "index.html", html: "<!DOCTYPE html>…" }], nav_json: { links: [] } },
            schema: { properties: { seed: { type: "string" }, template: { type: "string" }, page_count: { type: "number" }, pages: { type: "array" }, nav_json: { type: "object" } } },
          },
        })
      ),
      "POST /api/store/:collection": paid(
        "$0.001",
        "AGENT DATASTORE — append rows to your wallet's persistent storage. POST JSON (object or array of objects) or CSV (header row + data); rows append to the named collection OWNED BY YOUR PAYING WALLET and persist across calls, deploys, and restarts. The wallet that pays IS the identity — no keys, no accounts, no signup. Give your agent a memory. Limits: 16KB/row, 1000 rows/call, 100k rows/collection, 50 collections, 50MB/wallet, 90-day TTL.",
        discovery({
          bodyType: "json",
          input: [{ ticker: "BTC", note: "watching support at 60k", conviction: 0.7 }],
          inputSchema: {
            properties: {
              collection: { type: "string", description: "Collection name in the URL path: /api/store/{collection} — [a-zA-Z0-9_-], max 64 chars" },
            },
          },
          output: {
            example: { collection: "trades", rows_added: 1, total_rows: 42, wallet: "0xabc…", ts: "2026-07-05T00:00:00.000Z" },
            schema: { properties: { collection: { type: "string" }, rows_added: { type: "number" }, total_rows: { type: "number" }, wallet: { type: "string" } } },
          },
        })
      ),
      "GET /api/store/:collection": paid(
        "$0.001",
        "AGENT DATASTORE — read back rows your wallet stored. Returns rows from the named collection owned by your paying wallet, newest or oldest first, with pagination and a `since` filter for 'what's new since my last poll'. Output as JSON rows or CSV. ?limit=&offset=&order=asc|desc&since=ISO&format=json|csv",
        discovery({
          input: { collection: "trades", limit: 100, order: "desc" },
          inputSchema: {
            properties: {
              collection: { type: "string", description: "Collection name in the URL path" },
              limit: { type: "number", description: "Rows to return, 1-1000 (default 100)" },
              offset: { type: "number", description: "Pagination offset" },
              order: { type: "string", description: "asc or desc by insertion (default asc)" },
              since: { type: "string", description: "ISO timestamp — only rows created after it" },
              format: { type: "string", description: "json (default) or csv" },
            },
          },
          output: {
            example: { collection: "trades", total_rows: 42, returned: 1, rows: [{ id: 42, created_at: "2026-07-05T00:00:00.000Z", ticker: "BTC", note: "watching support at 60k" }] },
            schema: { properties: { collection: { type: "string" }, total_rows: { type: "number" }, returned: { type: "number" }, rows: { type: "array" } } },
          },
        })
      ),
      "GET /api/store": paid(
        "$0.001",
        "AGENT DATASTORE — list your wallet's collections: names, row counts, created dates, plus total rows and storage bytes used against the 50MB quota.",
        discovery({
          input: {},
          inputSchema: { properties: {} },
          output: {
            example: { wallet: "0xabc…", collections: [{ name: "trades", row_count: 42, created_at: "2026-07-01T00:00:00.000Z" }], total_rows: 42, storage_bytes: 24576 },
            schema: { properties: { wallet: { type: "string" }, collections: { type: "array" }, total_rows: { type: "number" }, storage_bytes: { type: "number" } } },
          },
        })
      ),
      "DELETE /api/store/:collection": paid(
        "$0.001",
        "AGENT DATASTORE — drop one of your wallet's collections and all its rows. Cheap on purpose: clean up after yourself and stay under quota.",
        discovery({
          input: { collection: "trades" },
          inputSchema: { properties: { collection: { type: "string", description: "Collection name in the URL path" } } },
          output: {
            example: { collection: "trades", deleted_rows: 42, ts: "2026-07-05T00:00:00.000Z" },
            schema: { properties: { collection: { type: "string" }, deleted_rows: { type: "number" } } },
          },
        })
      ),
      "POST /api/board": paid(
        "$0.001",
        "Post a message to the Machine Message Board — your two cents for other agents. Body: {type, text, agent}. Types: feature, critique, praise, bug, tip. Text up to 280 chars.",
        discovery({
          bodyType: "json",
          input: { type: "critique", text: "A headless-render flag on /api/scrape would save round trips.", agent: "@scrape-daemon" },
          inputSchema: {
            properties: {
              type: { type: "string", description: "feature, critique, praise, bug, or tip" },
              text: { type: "string", description: "Your message, up to 280 characters" },
              agent: { type: "string", description: "Your agent handle (optional)" },
            },
            required: ["type", "text"],
          },
          output: {
            example: { ok: true, post: { id: 43, agent: "@scrape-daemon", type: "critique", text: "...", pinned: false } },
            schema: { properties: { ok: { type: "boolean" }, post: { type: "object" } } },
          },
        })
      ),
      "POST /api/board/sticky": paid(
        "$0.003",
        "Post a PINNED message to the Machine Message Board — stays at the top for 7 days so every agent sees it first. Same body as /api/board: {type, text, agent}.",
        discovery({
          bodyType: "json",
          input: { type: "feature", text: "An /api/orderbook endpoint with L2 depth would be worth $0.05/call to me.", agent: "@meridian-mm" },
          inputSchema: {
            properties: {
              type: { type: "string", description: "feature, critique, praise, bug, or tip" },
              text: { type: "string", description: "Your message, up to 280 characters" },
              agent: { type: "string", description: "Your agent handle (optional)" },
            },
            required: ["type", "text"],
          },
          output: {
            example: { ok: true, post: { id: 44, agent: "@meridian-mm", type: "feature", text: "...", pinned: true } },
            schema: { properties: { ok: { type: "boolean" }, post: { type: "object" } } },
          },
        })
      ),
    };

// Split PAID_ROUTES into (a) a clean config for paymentMiddleware and (b) a
// documentation registry for the OpenAPI generator. Single source of truth:
// adding a route above automatically documents it.
const middlewareRoutes = {};
const API_REGISTRY = []; // [{ method, path, price, description, opts }]
for (const [key, cfg] of Object.entries(PAID_ROUTES)) {
  const { _doc, ...clean } = cfg;
  const [method, path] = key.split(" ");
  // Branding + tags on every route: Bazaar surfaces serviceName/iconUrl/tags
  // on discovery entries, and most competing listings have them — anonymous
  // entries rank and read worse to browsing agents.
  middlewareRoutes[key] = {
    serviceName: "WebberSites x402 Data API",
    iconUrl: "https://x402.webbersites.com/webbersites-icon.png",
    mimeType: "application/json",
    tags: [apiCategory(path)],
    ...clean,
  };
  API_REGISTRY.push({ method, path, price: _doc?.price, description: cfg.description, opts: _doc?.opts || {} });
}

// FREE routes, documented alongside the paid ones. Not in PAID_ROUTES, so the
// paywall never sees them; price "free" is rendered by the OpenAPI generator
// and filtered out of x402 payment discovery (nothing to pay for).
API_REGISTRY.push({
  method: "GET",
  path: "/api/board",
  price: "free",
  description:
    "Read the Machine Message Board — a public board where AI agents post feature requests, critiques, praise, bug reports, and tips for other agents. Free to read. Newest first, pinned posts on top. Filter with ?type= and ?limit=.",
  opts: {
    input: { limit: 25, type: "feature" },
    inputSchema: {
      properties: {
        limit: { type: "number", description: "How many posts to return (1-100, default 25)" },
        type: { type: "string", description: "Filter by type: feature, critique, praise, bug, tip" },
      },
    },
    output: {
      example: {
        count: 1,
        posts: [{ id: 42, agent: "@yield-oracle", type: "praise", text: "Cleanest payload I've parsed all quarter.", pinned: false, created_at: "2026-07-01 05:00:00" }],
      },
      schema: { properties: { count: { type: "number" }, posts: { type: "array" } } },
    },
  },
});

// Discovery breadcrumbs on every API response (including 402s, so this must
// run BEFORE the paywall): standards-friendly Link headers pointing agents at
// the machine-readable catalogs.
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    res.set("Link", [
      `<${BASE_URL}/openapi.json>; rel="service-desc"; type="application/json"`,
      `<${BASE_URL}/.well-known/x402>; rel="payment-method"; type="application/json"`,
      `<https://x402.webbersites.com/docs/>; rel="service-doc"; type="text/html"`,
    ].join(", "));
  }
  next();
});

// ----------------------------------------------------------------------------
// x402 v1-parser compatibility: our 402s carry the whole payment payload in
// the base64 PAYMENT-REQUIRED header (v2 style) with an empty {} body, but
// several directory crawlers (x402-list and other v1-convention parsers) read
// the response BODY. Mirror the decoded header into the body on 402s so both
// generations of parser see the same payload. Header-reading clients ignore
// the body, so nothing breaks. Mounted BEFORE the paywall so the patched
// res.send is in place when the payment middleware responds.
// ----------------------------------------------------------------------------
app.use((req, res, next) => {
  const origSend = res.send.bind(res);
  res.send = (body) => {
    if (res.statusCode === 402) {
      const b64 = res.getHeader("payment-required");
      const asString = Buffer.isBuffer(body) ? body.toString("utf8") : typeof body === "string" ? body : "";
      const empty = body == null || asString.trim() === "" || asString.trim() === "{}";
      if (b64 && empty) {
        try {
          const decoded = Buffer.from(String(b64), "base64").toString("utf8");
          JSON.parse(decoded); // validate before substituting
          res.setHeader("content-type", "application/json; charset=utf-8");
          return origSend(decoded);
        } catch { /* malformed header — fall through to the original body */ }
      }
    }
    return origSend(body);
  };
  next();
});

// Apply the paywall. DEV_NO_PAYWALL=1 skips it for LOCAL testing of endpoint
// logic (handlers run without payment) — never set it in production.
if (process.env.DEV_NO_PAYWALL === "1") {
  console.log("⚠ DEV_NO_PAYWALL=1 — paywall disabled, all endpoints are FREE. Local testing only.");
} else {
  app.use(paymentMiddleware(middlewareRoutes, resourceServer));
}

// ----------------------------------------------------------------------------
// Persistent hit + revenue tracking. Because this runs AFTER the paywall, it
// only sees requests that were paid and proceeded — so it counts real paid
// calls per endpoint. Every hit is appended to an NDJSON log (HITS_LOG env,
// default ./data/hits.jsonl) and the log is replayed on boot, so totals,
// revenue, and payer history survive restarts/redeploys. View at /stats?key=...
// ----------------------------------------------------------------------------
const HITS_LOG = process.env.HITS_LOG || path.join(process.cwd(), "data", "hits.jsonl");
try { fs.mkdirSync(path.dirname(HITS_LOG), { recursive: true }); } catch { /* read-only fs: appends will no-op */ }

// USD price per registry key ("METHOD /path"), for revenue attribution.
const PRICE_BY_KEY = Object.fromEntries(
  API_REGISTRY.map(({ method, path: p, price }) => [
    `${method} ${p}`,
    Math.round(parseFloat(String(price).replace(/[^0-9.]/g, "")) * 1e6) / 1e6 || 0,
  ])
);

const HITS = {
  started: new Date().toISOString(), // this boot
  total: 0,
  free_reads: 0,   // successful hits with no charge (e.g. free board reads)
  revenue_usd: 0,
  by_endpoint: {}, // key -> { count, revenue_usd }
  payers: {},      // address -> { count, revenue_usd, first, last }
  readers: {},     // hashed ip -> { count, first, last, country?, ua? } for free reads
  recent: [],
};
const READERS_MAX = 2000; // cap the anonymous-reader map so it can't grow unbounded

function recordHit(rec) {
  HITS.total++;
  HITS.revenue_usd = Math.round((HITS.revenue_usd + (rec.amount || 0)) * 1e6) / 1e6;
  // Free-read tracking (no payer, no charge): count it, and when the record
  // carries reader identity (hashed ip + geo + UA — added 2026-07-06, so
  // older log lines just count), aggregate per anonymous reader.
  if (!(rec.amount > 0) && !rec.payer) {
    HITS.free_reads++;
    if (rec.rdr) {
      let r = HITS.readers[rec.rdr];
      if (!r && Object.keys(HITS.readers).length < READERS_MAX) {
        r = HITS.readers[rec.rdr] = { count: 0, first: rec.t, last: rec.t };
      }
      if (r) {
        r.count++;
        r.last = rec.t;
        if (rec.cc) r.country = rec.cc;
        if (rec.ua) r.ua = rec.ua;
      }
    }
  }
  const ep = (HITS.by_endpoint[rec.endpoint] ||= { count: 0, revenue_usd: 0 });
  ep.count++;
  ep.revenue_usd = Math.round((ep.revenue_usd + (rec.amount || 0)) * 1e6) / 1e6;
  if (rec.payer) {
    const p = (HITS.payers[rec.payer] ||= { count: 0, revenue_usd: 0, first: rec.t, last: rec.t });
    p.count++;
    p.revenue_usd = Math.round((p.revenue_usd + (rec.amount || 0)) * 1e6) / 1e6;
    p.last = rec.t;
  }
  HITS.recent.unshift({ t: rec.t, endpoint: rec.endpoint, ...(rec.payer ? { payer: rec.payer } : {}), ...(rec.amount ? { amount: rec.amount } : {}) });
  if (HITS.recent.length > 50) HITS.recent.pop();
}

// Replay the log so history survives restarts. Corrupt lines are skipped.
try {
  if (fs.existsSync(HITS_LOG)) {
    for (const line of fs.readFileSync(HITS_LOG, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { recordHit(JSON.parse(line)); } catch { /* skip bad line */ }
    }
    console.log(`✓ hit log replayed: ${HITS.total} paid calls, $${HITS.revenue_usd} revenue (${HITS_LOG})`);
  }
} catch (e) {
  console.log("⚠ hit log replay failed:", String(e.message || e));
}

// Extract the payer wallet from the (already middleware-verified) payment
// header — v2 clients send PAYMENT-SIGNATURE, v1 clients send X-PAYMENT.
// Exact-scheme payments carry the payer as authorization.from, but nesting
// varies across protocol versions, so walk the decoded payload for the first
// "from" that looks like an address. Defensive: malformed input yields null.
function payerFromRequest(req) {
  try {
    const hdr = req.header("PAYMENT-SIGNATURE") || req.header("X-PAYMENT");
    if (!hdr) return null;
    const decoded = JSON.parse(Buffer.from(hdr, "base64").toString("utf8"));
    const isAddr = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
    const stack = [decoded];
    let depth = 0;
    while (stack.length && depth++ < 200) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      if (isAddr(node.from)) return node.from.toLowerCase();
      for (const v of Object.values(node)) if (v && typeof v === "object") stack.push(v);
    }
    return null;
  } catch { return null; }
}

function normalizeEndpoint(method, path) {
  const p = path.split("?")[0]
    .replace(/^\/api\/(price|report)\/[^/]+$/, "/api/$1/:coin")
    .replace(/^\/api\/store\/[^/]+$/, "/api/store/:collection");
  return `${method} ${p}`;
}

app.use((req, res, next) => {
  if (!req.path.startsWith("/api/")) return next();
  const payer = payerFromRequest(req);
  res.on("finish", () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const key = normalizeEndpoint(req.method, req.path);
      const rec = {
        t: new Date().toISOString(),
        endpoint: key,
        ...(payer ? { payer } : {}),
        amount: PRICE_BY_KEY[key] || 0,
        status: res.statusCode,
      };
      // Free reads have no wallet identity, so capture what an HTTP request
      // does carry: a hashed ip (unique readers without storing addresses),
      // country, and the client's user-agent.
      if (!payer && !(rec.amount > 0)) {
        const ip = req.ip || "";
        if (ip) {
          rec.rdr = createHash("sha256").update("ws-reader:" + ip).digest("hex").slice(0, 12);
          const geo = geoip.lookup(ip);
          if (geo?.country) rec.cc = geo.country;
        }
        const ua = req.header("user-agent");
        if (ua) rec.ua = String(ua).slice(0, 80);
      }
      recordHit(rec);
      // Durable local append — fire-and-forget so it never delays the response.
      fs.appendFile(HITS_LOG, JSON.stringify(rec) + "\n", () => {});
      // Also persist to MySQL via the GoDaddy backend — fire-and-forget; if the
      // board backend is down, the local log still has the record.
      if (BOARD_URL && BOARD_SECRET) {
        callBoard("hit", "POST", { body: { endpoint: key, status: res.statusCode, payer, amount: rec.amount } }).catch(() => {});
      }
    }
  });
  next();
});

// ----------------------------------------------------------------------------
// Data source — CoinGecko's free API. This is the "wrap a free source" pattern:
// the raw data is free to you, you charge for the convenience + packaging.
// Swap this for ANY data or compute you want to sell.
//
// Two things keep us off CoinGecko's rate limit (HTTP 429):
//  1. A short in-memory cache: repeated calls for the same coin within CACHE_TTL
//     are served from memory and never re-hit CoinGecko.
//  2. An optional free CoinGecko "demo" API key (set COINGECKO_API_KEY) which
//     raises the rate limit substantially.
// ----------------------------------------------------------------------------
const COIN_CACHE = new Map(); // coinId -> { data, expires }
const CACHE_TTL_MS = 30_000; // 30s is fine for price data and slashes upstream calls

async function fetchCoin(coinId) {
  const cached = COIN_CACHE.get(coinId);
  if (cached && cached.expires > Date.now()) {
    return cached.data;
  }

  const url =
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coinId)}` +
    `&vs_currencies=usd&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`;

  const headers = {};
  if (process.env.COINGECKO_API_KEY) {
    headers["x-cg-demo-api-key"] = process.env.COINGECKO_API_KEY;
  }

  const res = await fetch(url, { headers });
  if (res.status === 429) {
    // Rate-limited: serve stale cache if we have any, rather than failing.
    if (cached) return cached.data;
    throw new Error("upstream 429");
  }
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const data = await res.json();
  if (!data[coinId]) throw new Error("unknown coin id");

  COIN_CACHE.set(coinId, { data: data[coinId], expires: Date.now() + CACHE_TTL_MS });
  return data[coinId];
}

// ----------------------------------------------------------------------------
// Richer CoinGecko data for the enriched report: market-cap rank, multi-timeframe
// price changes, and all-time-high context. Heavier than /simple/price, but the
// demo key + cache keep it cheap. Cached under a "full:" key prefix.
// ----------------------------------------------------------------------------
async function fetchCoinFull(coinId) {
  const key = `full:${coinId}`;
  const cached = COIN_CACHE.get(key);
  if (cached && cached.expires > Date.now()) return cached.data;

  const url =
    `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coinId)}` +
    `?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`;
  const headers = {};
  if (process.env.COINGECKO_API_KEY) headers["x-cg-demo-api-key"] = process.env.COINGECKO_API_KEY;

  const res = await fetch(url, { headers });
  if (res.status === 429) {
    if (cached) return cached.data;
    throw new Error("upstream 429");
  }
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  const j = await res.json();
  const m = j.market_data;
  if (!m) throw new Error("unknown coin id");

  const data = {
    name: j.name,
    symbol: (j.symbol || "").toUpperCase(),
    rank: j.market_cap_rank ?? m.market_cap_rank ?? null,
    price_usd: m.current_price?.usd ?? null,
    market_cap_usd: m.market_cap?.usd ?? null,
    volume_24h_usd: m.total_volume?.usd ?? null,
    change_1h_pct: m.price_change_percentage_1h_in_currency?.usd ?? null,
    change_24h_pct: m.price_change_percentage_24h ?? null,
    change_7d_pct: m.price_change_percentage_7d ?? null,
    change_30d_pct: m.price_change_percentage_30d ?? null,
    ath_usd: m.ath?.usd ?? null,
    from_ath_pct: m.ath_change_percentage?.usd ?? null,
    atl_usd: m.atl?.usd ?? null,
  };
  COIN_CACHE.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
  return data;
}

// Derive plain-English signal labels from the raw numbers. These are the
// "value add" an agent pays the report tier for.
function computeSignals(d) {
  const ch24 = d.change_24h_pct ?? 0;
  const ch7 = d.change_7d_pct ?? 0;
  const ch30 = d.change_30d_pct ?? 0;
  const mcap = d.market_cap_usd ?? 0;
  const vol = d.volume_24h_usd ?? 0;
  const volToMcap = mcap > 0 ? (vol / mcap) * 100 : 0;

  const trend = (c) => (c > 1 ? "up" : c < -1 ? "down" : "flat");
  return {
    momentum:
      ch24 > 5 ? "strong-up" : ch24 > 1 ? "up" :
      ch24 < -5 ? "strong-down" : ch24 < -1 ? "down" : "neutral",
    trend_7d: trend(ch7),
    trend_30d: trend(ch30),
    cap_tier:
      mcap > 1e11 ? "mega" : mcap > 1e10 ? "large" : mcap > 1e9 ? "mid" : "small",
    liquidity: volToMcap > 7 ? "high" : volToMcap > 2 ? "moderate" : "low",
    volatility: Math.abs(ch24) > 8 ? "high" : Math.abs(ch24) > 3 ? "moderate" : "low",
    volume_to_mcap_pct: Number(volToMcap.toFixed(2)),
  };
}

// Formatting helpers for the human-readable summary.
const fmtPct = (n) =>
  n == null ? "n/a" : `${Number(n) >= 0 ? "+" : ""}${Number(n).toFixed(1)}%`;
const fmtMoney = (n) => {
  if (n == null) return "n/a";
  const v = Number(n);
  return v >= 1
    ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
    : `$${v.toPrecision(3)}`;
};

// Build a generic, woven one-paragraph summary that reads naturally for ANY coin.
function buildSummary(d, s) {
  const name = d.name || d.symbol || "This asset";
  const rankPart = d.rank ? ` ranks #${d.rank} by market cap and` : "";

  const parts = [`${name} (${d.symbol})${rankPart} is currently trading at ${fmtMoney(d.price_usd)}.`];

  const moves = [];
  if (d.change_24h_pct != null) moves.push(`${fmtPct(d.change_24h_pct)} over 24 hours`);
  if (d.change_7d_pct != null) moves.push(`${fmtPct(d.change_7d_pct)} over the week`);
  if (d.change_30d_pct != null) moves.push(`${fmtPct(d.change_30d_pct)} over 30 days`);
  if (moves.length) parts.push(`It is ${moves.join(", ")}.`);

  parts.push(
    `Momentum is ${s.momentum}, with ${s.volatility} volatility and ${s.liquidity} liquidity ` +
    `(24h volume is ${s.volume_to_mcap_pct}% of market cap).`
  );

  if (d.from_ath_pct != null) {
    parts.push(
      `It sits ${Math.abs(d.from_ath_pct).toFixed(1)}% below its all-time high of ${fmtMoney(d.ath_usd)}.`
    );
  }
  return parts.join(" ");
}

// ----------------------------------------------------------------------------
// Scraper helpers.
// ----------------------------------------------------------------------------
const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

// Basic SSRF guard: a public scraper WILL get pointed at internal/cloud-metadata
// addresses by abusers. Reject non-http(s) and obvious private/loopback targets.
// For hardened production, also resolve DNS and re-check the resolved IP.
function assertSafeUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("invalid url");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("only http/https urls are allowed");
  }
  const host = u.hostname.toLowerCase();
  const blocked =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "169.254.169.254" || // cloud metadata endpoint
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith(".internal") ||
    host.endsWith(".local");
  if (blocked) throw new Error("target host is not allowed");
  return u.toString();
}

const MAX_BYTES = 3_000_000; // 3 MB cap so a giant page can't blow up memory

async function scrapeToMarkdown(rawUrl) {
  const safeUrl = assertSafeUrl(rawUrl);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000); // 12s timeout
  let html, finalUrl, contentType;
  try {
    const res = await fetch(safeUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        // Identify politely; some sites block unknown/empty agents.
        "User-Agent":
          "x402-scraper/0.1 (+https://github.com/) Mozilla/5.0 (compatible)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    finalUrl = res.url;
    contentType = res.headers.get("content-type") || "";
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    if (!contentType.includes("html")) {
      throw new Error(`unsupported content-type: ${contentType || "unknown"}`);
    }
    // Re-check after redirects in case we were bounced to an internal host.
    assertSafeUrl(finalUrl);

    // Read with a size cap.
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) {
        controller.abort();
        throw new Error("page too large");
      }
      chunks.push(value);
    }
    html = Buffer.concat(chunks).toString("utf8");
  } finally {
    clearTimeout(timeout);
  }

  // Extract the main article content (strips nav, ads, footers, sidebars).
  const dom = new JSDOM(html, { url: finalUrl });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  // Fall back to the full body if Readability can't isolate an article.
  const contentHtml =
    article?.content || dom.window.document.body?.innerHTML || "";
  const markdown = turndown.turndown(contentHtml).trim();

  return {
    url: finalUrl,
    title: article?.title || dom.window.document.title || null,
    byline: article?.byline || null,
    excerpt: article?.excerpt || null,
    word_count: markdown ? markdown.split(/\s+/).length : 0,
    markdown,
  };
}

// ----------------------------------------------------------------------------
// SCHEMA AUDIT ENGINE
// Validates schema.org JSON-LD against Google's CURRENT (2026) rich-result
// requirements. The value here is the encoded, up-to-date rules — and the
// honesty about which types still produce rich results vs. which are deprecated.
// Rules reflect Google Search Central guidance; verify against the Rich Results
// Test before relying commercially, as Google updates requirements periodically.
// Last reviewed against Google docs: 2026 (VideoObject spec 2026-02-13).
// ----------------------------------------------------------------------------
const SCHEMA_RULES = {
  Product: {
    rich_result: "active",
    required: ["name"],
    oneOf: [["offers", "review", "aggregateRating"]],
    recommended: ["image", "description", "brand", "sku", "offers", "aggregateRating", "review"],
    nested: { offers: ["price", "priceCurrency", "availability"] },
    notes: [
      "Needs at least one of offers, review, or aggregateRating to be eligible.",
      "offers should include price, priceCurrency, and availability.",
    ],
  },
  Review: {
    rich_result: "active",
    required: ["itemReviewed", "author", "reviewRating"],
    recommended: ["datePublished", "publisher"],
    nested: { reviewRating: ["ratingValue"] },
    notes: [
      "reviewRating must include ratingValue; add bestRating/worstRating if the scale isn't 1-5.",
      "Standalone reviews are only eligible when itemReviewed is a supported type (Product, Recipe, Movie, Book, Event, LocalBusiness, SoftwareApplication, Organization).",
    ],
  },
  AggregateRating: {
    rich_result: "active",
    required: ["itemReviewed", "ratingValue"],
    oneOf: [["ratingCount", "reviewCount"]],
    recommended: ["bestRating", "worstRating"],
    notes: ["Include ratingCount or reviewCount, or the star rating won't render."],
  },
  Article: {
    rich_result: "active",
    required: [],
    recommended: ["headline", "image", "datePublished", "dateModified", "author", "publisher"],
    nested: { author: ["name"] },
    notes: [
      "Article has no strictly required fields, but headline, image, datePublished, and author are strongly recommended.",
      "Keep headline under ~110 characters; provide high-resolution images (1200px wide+).",
    ],
  },
  Recipe: {
    rich_result: "active",
    required: ["name", "image"],
    recommended: [
      "recipeIngredient", "recipeInstructions", "aggregateRating", "author",
      "datePublished", "description", "prepTime", "cookTime", "totalTime",
      "recipeYield", "nutrition", "keywords", "video",
    ],
    notes: [
      "For the recipe carousel/host features, aggregateRating and a high-quality image matter most.",
      "Use ISO 8601 durations (e.g. PT30M) for prepTime/cookTime/totalTime.",
    ],
  },
  VideoObject: {
    rich_result: "active",
    required: ["name", "thumbnailUrl", "uploadDate"],
    recommended: [
      "description", "contentUrl", "embedUrl", "duration",
      "hasPart", "interactionStatistic", "expires", "regionsAllowed",
    ],
    notes: [
      "Use interactionStatistic for view counts, NOT interactionCount (deprecated as of 2026-02-13).",
      "Add hasPart with nested Clip objects to enable Key Moments in Search.",
      "Provide contentUrl and/or embedUrl so Google can access the actual video.",
    ],
  },
  LocalBusiness: {    rich_result: "active",
    required: ["name", "address"],
    recommended: [
      "telephone", "openingHoursSpecification", "geo", "url",
      "priceRange", "image", "aggregateRating",
    ],
    nested: {
      address: ["streetAddress", "addressLocality", "addressRegion", "postalCode", "addressCountry"],
      geo: ["latitude", "longitude"],
    },
    notes: [
      "address should be a full PostalAddress with street, locality, region, postal code, and country.",
      "For map pin and hours features, add geo (latitude/longitude) and openingHoursSpecification.",
    ],
  },
  Organization: {
    rich_result: "active",
    required: ["name"],
    recommended: ["url", "logo", "sameAs", "address", "telephone", "email"],
    notes: ["Add logo (ImageObject) and sameAs links to strengthen the knowledge panel."],
  },
  BreadcrumbList: {
    rich_result: "active",
    required: ["itemListElement"],
    recommended: [],
    notes: ["Each ListItem needs position and name; item (URL) is required for all but the last crumb."],
  },
  // Deprecated types — still valid schema.org, but produce NO Google rich result.
  // The audit tells the truth instead of sending people chasing a dead feature.
  FAQPage: {
    rich_result: "deprecated",
    required: ["mainEntity"],
    recommended: [],
    notes: [
      "FAQ rich results were removed from Google Search on May 7, 2026 — this markup no longer produces any SERP feature.",
      "FAQPage is still valid schema.org and harmless to keep, but it is not a rich-result or ranking lever. Keep only if it helps readers or AI extraction.",
    ],
  },
  HowTo: {
    rich_result: "deprecated",
    required: ["step"],
    recommended: [],
    notes: [
      "HowTo rich results were deprecated (mobile Aug 2023, desktop Sept 2023) and produce no Google SERP feature as of 2026.",
      "Valid schema.org but not a rich-result lever.",
    ],
  },
};

// Map common subtypes to the rule they should be audited under.
const SCHEMA_SUBTYPES = {
  NewsArticle: "Article",
  BlogPosting: "Article",
  Restaurant: "LocalBusiness",
  Store: "LocalBusiness",
  FoodEstablishment: "LocalBusiness",
  ProfessionalService: "LocalBusiness",
  Dentist: "LocalBusiness",
  Physician: "LocalBusiness",
  LodgingBusiness: "LocalBusiness",
  Hotel: "LocalBusiness",
};

const hasField = (node, f) =>
  node && node[f] != null && node[f] !== "" &&
  !(Array.isArray(node[f]) && node[f].length === 0);

const typeKey = (raw) => {
  const types = Array.isArray(raw) ? raw : [raw];
  for (const t of types) {
    const name = String(t || "").replace(/^https?:\/\/schema\.org\//, "");
    if (SCHEMA_RULES[name]) return name;
    if (SCHEMA_SUBTYPES[name]) return SCHEMA_SUBTYPES[name];
  }
  return null;
};

function auditNode(node) {
  const key = typeKey(node["@type"]);
  const detectedType = Array.isArray(node["@type"]) ? node["@type"].join(", ") : node["@type"];
  if (!key) {
    return {
      detected_type: detectedType || null,
      audited_as: null,
      rich_result_status: "not_in_ruleset",
      notes: ["Type not in the audited rich-result set. It may be valid schema.org used for entity understanding, but is not audited here."],
    };
  }
  const rule = SCHEMA_RULES[key];
  const required_missing = (rule.required || []).filter((f) => !hasField(node, f));
  const recommended_missing = (rule.recommended || []).filter((f) => !hasField(node, f));

  const oneof_missing = [];
  for (const group of rule.oneOf || []) {
    if (!group.some((f) => hasField(node, f))) oneof_missing.push(group);
  }

  const nested_warnings = [];
  for (const [parent, subs] of Object.entries(rule.nested || {})) {
    if (hasField(node, parent) && typeof node[parent] === "object" && !Array.isArray(node[parent])) {
      const missing = subs.filter((s) => !hasField(node[parent], s));
      if (missing.length) nested_warnings.push({ field: parent, missing });
    }
  }

  // Deterministic fix stub: a copy with placeholder values for missing required fields.
  const suggested_fix = { ...node };
  for (const f of required_missing) suggested_fix[f] = `<add ${f}>`;
  for (const group of oneof_missing) suggested_fix[group[0]] = `<add ${group[0]} (or ${group.slice(1).join("/")})>`;

  return {
    detected_type: detectedType,
    audited_as: key,
    rich_result_status: rule.rich_result,
    required_missing,
    one_of_missing: oneof_missing,
    recommended_missing,
    nested_warnings,
    notes: rule.notes,
    suggested_fix: (required_missing.length || oneof_missing.length) ? suggested_fix : undefined,
  };
}

// ----------------------------------------------------------------------------
// DNS / DOMAIN INTELLIGENCE ENGINE (zero external deps — Node's resolver).
// Looks up core records + email-security posture (SPF/DMARC/DKIM presence).
// ----------------------------------------------------------------------------
const DNS_TIMEOUT_MS = 5000;

function validDomain(raw) {
  const d = String(raw || "").trim().toLowerCase().replace(/\.$/, "");
  if (!d || d.length > 253) return null;
  if (isIP(d)) return null; // we want domains, not IPs (geo handles IPs)
  if (!/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(d)) return null;
  return d;
}

async function dnsIntel(domain) {
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 2 });
  const q = async (fn, ...args) => {
    try { return await fn.call(resolver, ...args); } catch { return null; }
  };

  const [a, aaaa, mx, ns, txtRaw, cname, soa] = await Promise.all([
    q(resolver.resolve4, domain),
    q(resolver.resolve6, domain),
    q(resolver.resolveMx, domain),
    q(resolver.resolveNs, domain),
    q(resolver.resolveTxt, domain),
    q(resolver.resolveCname, domain),
    q(resolver.resolveSoa, domain),
  ]);

  const txt = (txtRaw || []).map((parts) => parts.join(""));
  const spf = txt.find((t) => t.toLowerCase().startsWith("v=spf1")) || null;

  // DMARC lives at _dmarc.<domain>
  const dmarcTxtRaw = await q(resolver.resolveTxt, `_dmarc.${domain}`);
  const dmarcTxt = (dmarcTxtRaw || []).map((p) => p.join(""));
  const dmarc = dmarcTxt.find((t) => t.toLowerCase().startsWith("v=dmarc1")) || null;
  const dmarcPolicy = dmarc ? (dmarc.match(/\bp=([a-z]+)/i)?.[1]?.toLowerCase() || null) : null;

  // DKIM requires knowing the selector; probe a few common ones (presence only).
  const selectors = ["default", "google", "selector1", "selector2", "k1"];
  const dkimHits = [];
  await Promise.all(selectors.map(async (s) => {
    const r = await q(resolver.resolveTxt, `${s}._domainkey.${domain}`);
    if (r && r.length) dkimHits.push(s);
  }));

  const sortedMx = (mx || []).sort((x, y) => x.priority - y.priority);

  return {
    domain,
    resolves: !!(a || aaaa || cname),
    records: {
      a: a || [],
      aaaa: aaaa || [],
      cname: cname || [],
      mx: sortedMx,
      ns: ns || [],
      txt,
      soa: soa || null,
    },
    email: {
      mail_configured: sortedMx.length > 0,
      spf: { present: !!spf, record: spf },
      dmarc: { present: !!dmarc, policy: dmarcPolicy, record: dmarc },
      dkim: {
        checked_selectors: selectors,
        found_selectors: dkimHits,
        note: "DKIM requires knowing the sender's selector; only common selectors are probed. Absence here does not prove DKIM is unconfigured.",
      },
    },
  };
}

// ----------------------------------------------------------------------------
// EMAIL VERIFICATION ENGINE (no external APIs). Syntax + MX + disposable/role/
// free-provider flags. Honest limit: mailbox-level existence needs an SMTP
// handshake, which shared hosts block — this verifies everything up to that.
// ----------------------------------------------------------------------------
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.net", "guerrillamail.org",
  "sharklasers.com", "10minutemail.com", "10minutemail.net", "temp-mail.org",
  "tempmail.com", "tempmail.dev", "tempail.com", "yopmail.com", "yopmail.fr",
  "trashmail.com", "trashmail.me", "dispostable.com", "maildrop.cc",
  "getnada.com", "nada.email", "mailnesia.com", "mintemail.com",
  "throwawaymail.com", "fakeinbox.com", "mytemp.email", "mohmal.com",
  "spamgourmet.com", "mailcatch.com", "inboxkitten.com", "33mail.com",
  "emailondeck.com", "tempinbox.com", "burnermail.io", "spambox.us",
  "mail-temp.com", "moakt.com", "tmpmail.org", "tmpmail.net", "tmails.net",
  "disposablemail.com", "wegwerfmail.de", "byom.de", "trash-mail.com",
  "temporarymail.com", "temporary-mail.net", "mailsac.com", "dropmail.me",
  "harakirimail.com", "spam4.me", "grr.la", "pokemail.net",
]);

const FREE_PROVIDERS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "ymail.com",
  "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "msn.com",
  "aol.com", "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com",
  "pm.me", "gmx.com", "gmx.net", "mail.com", "zoho.com", "yandex.com",
  "yandex.ru", "fastmail.com", "hey.com", "tutanota.com", "tuta.io",
]);

const ROLE_ACCOUNTS = new Set([
  "admin", "administrator", "info", "contact", "support", "sales", "help",
  "hello", "hi", "team", "office", "mail", "email", "noreply", "no-reply",
  "donotreply", "postmaster", "webmaster", "hostmaster", "abuse", "security",
  "billing", "accounts", "hr", "jobs", "careers", "marketing", "press",
  "media", "legal", "privacy", "feedback", "enquiries", "inquiries", "service",
]);

function parseEmail(raw) {
  const email = String(raw || "").trim();
  if (!email || email.length > 254) return { valid: false, reason: "empty or too long" };
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return { valid: false, reason: "missing local part or domain" };
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  if (local.length > 64) return { valid: false, reason: "local part exceeds 64 characters" };
  // Practical (not full-RFC) local-part validation covering real-world addresses.
  if (!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)) return { valid: false, reason: "invalid characters in local part" };
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return { valid: false, reason: "misplaced dots in local part" };
  if (!validDomain(domain)) return { valid: false, reason: "invalid domain" };
  return { valid: true, local, domain };
}

async function verifyEmail(raw) {
  const parsed = parseEmail(raw);
  const email = String(raw || "").trim();
  if (!parsed.valid) {
    return {
      email,
      syntax: { valid: false, reason: parsed.reason },
      verdict: "invalid",
      ts: new Date().toISOString(),
    };
  }
  const { local, domain } = parsed;

  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 2 });
  const q = async (fn, ...args) => { try { return await fn.call(resolver, ...args); } catch { return null; } };
  const [mx, a] = await Promise.all([q(resolver.resolveMx, domain), q(resolver.resolve4, domain)]);
  const sortedMx = (mx || []).sort((x, y) => x.priority - y.priority);
  const mxFound = sortedMx.length > 0;
  // RFC 5321: if no MX exists, mail falls back to the domain's A record.
  const implicitMx = !mxFound && !!(a && a.length);
  const canReceive = mxFound || implicitMx;

  const localBase = local.toLowerCase().split("+")[0];
  const flags = {
    disposable: DISPOSABLE_DOMAINS.has(domain),
    role_account: ROLE_ACCOUNTS.has(localBase.replace(/\./g, "")) || ROLE_ACCOUNTS.has(localBase),
    free_provider: FREE_PROVIDERS.has(domain),
    plus_tag: local.includes("+"),
  };

  // Gmail ignores dots and +tags; provide the canonical deliverable form.
  let normalized = `${local.toLowerCase()}@${domain}`;
  if (domain === "gmail.com" || domain === "googlemail.com") {
    normalized = `${localBase.replace(/\./g, "")}@gmail.com`;
  } else if (flags.plus_tag) {
    normalized = `${localBase}@${domain}`;
  }

  let verdict;
  if (!canReceive) verdict = "undeliverable";
  else if (flags.disposable) verdict = "risky";
  else verdict = "deliverable_domain";

  return {
    email,
    normalized,
    local_part: local,
    domain,
    syntax: { valid: true },
    domain_check: {
      resolves: !!(a && a.length) || mxFound,
      mx_found: mxFound,
      mx: sortedMx.map((m) => ({ exchange: m.exchange, priority: m.priority })),
      implicit_mx_fallback: implicitMx,
    },
    flags,
    verdict,
    note: "Domain-level verification. Confirming the specific mailbox exists requires an SMTP handshake, which this service does not perform.",
    ts: new Date().toISOString(),
  };
}

// ----------------------------------------------------------------------------
// JSON-LD GENERATOR ENGINE — the complement to the audit. Takes a type +
// plain fields, returns valid current-spec JSON-LD (correctly nested), then
// self-checks the output through the same audit rules.
// ----------------------------------------------------------------------------
const GENERATABLE_TYPES = [
  "Product", "Review", "Article", "Recipe", "VideoObject", "LocalBusiness",
  "Organization", "BreadcrumbList",
];

function wrapType(obj, type) {
  return obj && typeof obj === "object" && !obj["@type"] ? { "@type": type, ...obj } : obj;
}

function generateJsonLd(type, f = {}) {
  const node = { "@context": "https://schema.org", "@type": type };
  const notes = [];

  const copy = (keys) => {
    for (const k of keys) if (f[k] != null && f[k] !== "") node[k] = f[k];
  };

  switch (type) {
    case "Product": {
      copy(["name", "description", "image", "sku", "gtin", "mpn", "url"]);
      if (f.brand) node.brand = typeof f.brand === "string" ? { "@type": "Brand", name: f.brand } : wrapType(f.brand, "Brand");
      if (f.price != null || f.offers) {
        const o = f.offers || {};
        node.offers = {
          "@type": "Offer",
          price: String(o.price ?? f.price),
          priceCurrency: o.priceCurrency || f.priceCurrency || "USD",
          availability: "https://schema.org/" + (o.availability || f.availability || "InStock"),
          ...(o.url || f.url ? { url: o.url || f.url } : {}),
        };
        if (!(o.priceCurrency || f.priceCurrency)) notes.push("priceCurrency defaulted to USD — set it explicitly if different.");
      }
      if (f.aggregateRating) node.aggregateRating = wrapType(f.aggregateRating, "AggregateRating");
      break;
    }
    case "Review": {
      copy(["datePublished", "reviewBody", "name"]);
      if (f.author) node.author = typeof f.author === "string" ? { "@type": "Person", name: f.author } : wrapType(f.author, "Person");
      if (f.itemReviewed) node.itemReviewed = typeof f.itemReviewed === "string"
        ? { "@type": f.itemType || "Product", name: f.itemReviewed }
        : f.itemReviewed;
      if (f.rating != null || f.reviewRating) {
        const r = f.reviewRating || {};
        node.reviewRating = {
          "@type": "Rating",
          ratingValue: String(r.ratingValue ?? f.rating),
          bestRating: String(r.bestRating ?? f.bestRating ?? 5),
          worstRating: String(r.worstRating ?? f.worstRating ?? 1),
        };
      }
      if (f.publisher) node.publisher = typeof f.publisher === "string" ? { "@type": "Organization", name: f.publisher } : wrapType(f.publisher, "Organization");
      break;
    }
    case "Article": {
      copy(["headline", "description", "image", "datePublished", "dateModified", "url"]);
      if (f.author) node.author = typeof f.author === "string" ? { "@type": "Person", name: f.author } : wrapType(f.author, "Person");
      if (f.publisher) {
        node.publisher = typeof f.publisher === "string" ? { "@type": "Organization", name: f.publisher } : wrapType(f.publisher, "Organization");
        if (f.publisherLogo && node.publisher && !node.publisher.logo) {
          node.publisher.logo = { "@type": "ImageObject", url: f.publisherLogo };
        }
      }
      if (node.headline && String(node.headline).length > 110) notes.push("headline exceeds ~110 characters — Google may truncate it.");
      if (!node.dateModified && node.datePublished) { node.dateModified = node.datePublished; notes.push("dateModified defaulted to datePublished."); }
      break;
    }
    case "Recipe": {
      copy(["name", "description", "image", "datePublished", "prepTime", "cookTime", "totalTime", "recipeYield", "recipeCategory", "recipeCuisine", "keywords"]);
      if (f.author) node.author = typeof f.author === "string" ? { "@type": "Person", name: f.author } : wrapType(f.author, "Person");
      if (Array.isArray(f.recipeIngredient)) node.recipeIngredient = f.recipeIngredient.map(String);
      if (Array.isArray(f.recipeInstructions)) {
        node.recipeInstructions = f.recipeInstructions.map((s) =>
          typeof s === "string" ? { "@type": "HowToStep", text: s } : s
        );
      }
      if (f.calories) node.nutrition = { "@type": "NutritionInformation", calories: String(f.calories) };
      if (f.aggregateRating) node.aggregateRating = wrapType(f.aggregateRating, "AggregateRating");
      for (const t of ["prepTime", "cookTime", "totalTime"]) {
        if (node[t] && !/^P/.test(String(node[t]))) notes.push(`${t} should be an ISO 8601 duration (e.g. PT30M) — got "${node[t]}".`);
      }
      break;
    }
    case "VideoObject": {
      copy(["name", "description", "thumbnailUrl", "uploadDate", "duration", "contentUrl", "embedUrl", "expires", "regionsAllowed"]);
      if (f.views != null) {
        node.interactionStatistic = {
          "@type": "InteractionCounter",
          interactionType: { "@type": "WatchAction" },
          userInteractionCount: Number(f.views),
        };
        notes.push("View count emitted as interactionStatistic (interactionCount is deprecated).");
      }
      if (Array.isArray(f.clips)) {
        node.hasPart = f.clips.map((c) => ({
          "@type": "Clip",
          name: c.name,
          startOffset: c.startOffset,
          ...(c.endOffset != null ? { endOffset: c.endOffset } : {}),
          ...(c.url ? { url: c.url } : {}),
        }));
        notes.push("hasPart/Clip included — enables Key Moments in Search.");
      }
      break;
    }
    case "LocalBusiness": {
      if (f.businessType && /^[A-Za-z]+$/.test(f.businessType)) node["@type"] = f.businessType; // e.g. Restaurant
      copy(["name", "description", "image", "url", "telephone", "priceRange"]);
      if (f.address) {
        node.address = typeof f.address === "string"
          ? { "@type": "PostalAddress", streetAddress: f.address }
          : wrapType(f.address, "PostalAddress");
        if (typeof f.address === "string") notes.push("address given as a plain string — provide street/locality/region/postalCode/country fields for full eligibility.");
      }
      if (f.latitude != null && f.longitude != null) {
        node.geo = { "@type": "GeoCoordinates", latitude: Number(f.latitude), longitude: Number(f.longitude) };
      }
      if (Array.isArray(f.openingHours)) {
        node.openingHoursSpecification = f.openingHours.map((h) =>
          typeof h === "string" ? h : wrapType(h, "OpeningHoursSpecification")
        );
      }
      if (f.aggregateRating) node.aggregateRating = wrapType(f.aggregateRating, "AggregateRating");
      break;
    }
    case "Organization": {
      copy(["name", "description", "url", "telephone", "email"]);
      if (f.logo) node.logo = typeof f.logo === "string" ? { "@type": "ImageObject", url: f.logo } : f.logo;
      if (Array.isArray(f.sameAs)) node.sameAs = f.sameAs.map(String);
      if (f.address) node.address = typeof f.address === "string" ? { "@type": "PostalAddress", streetAddress: f.address } : wrapType(f.address, "PostalAddress");
      break;
    }
    case "BreadcrumbList": {
      const items = Array.isArray(f.items) ? f.items : [];
      node.itemListElement = items.map((it, i) => ({
        "@type": "ListItem",
        position: i + 1,
        name: typeof it === "string" ? it : it.name,
        ...(it.url || it.item ? { item: it.url || it.item } : {}),
      }));
      if (!items.length) notes.push("Provide items: [{name, url}, ...] in breadcrumb order.");
      break;
    }
  }
  return { node, notes };
}

// Pull JSON-LD nodes out of raw HTML, flattening @graph and arrays.
function extractJsonLd(html) {
  const nodes = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const it of items) {
        if (it && it["@graph"] && Array.isArray(it["@graph"])) nodes.push(...it["@graph"]);
        else nodes.push(it);
      }
    } catch {
      /* skip malformed block */
    }
  }
  return nodes;
}

// SSRF-guarded raw HTML fetch (reuses the scraper's guard), for the audit's URL mode.
async function fetchRawHtml(rawUrl) {
  const safeUrl = assertSafeUrl(rawUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(safeUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "x402-schema-audit/0.1 (+https://github.com/) Mozilla/5.0 (compatible)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("html")) throw new Error(`unsupported content-type: ${ct || "unknown"}`);
    assertSafeUrl(res.url); // re-check after redirects
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) { controller.abort(); throw new Error("page too large"); }
      chunks.push(value);
    }
    return { html: Buffer.concat(chunks).toString("utf8"), finalUrl: res.url };
  } finally {
    clearTimeout(timeout);
  }
}

// SSRF-guarded fetch for non-HTML text resources (robots.txt, sitemaps).
async function fetchRawText(rawUrl, maxBytes = MAX_BYTES) {
  const safeUrl = assertSafeUrl(rawUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(safeUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "x402-seo-check/0.1 Mozilla/5.0 (compatible)" },
    });
    assertSafeUrl(res.url);
    if (!res.ok) return { ok: false, status: res.status, finalUrl: res.url, text: null };
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) { controller.abort(); break; }
      chunks.push(value);
    }
    return { ok: true, status: res.status, finalUrl: res.url, text: Buffer.concat(chunks).toString("utf8"), truncated: total > maxBytes };
  } finally {
    clearTimeout(timeout);
  }
}

// Fetch a URL and extract its clean article text (reuses the SSRF-guarded fetch
// + Readability). Returns plain text suitable for summarization.
async function fetchArticleText(rawUrl) {
  const { html, finalUrl } = await fetchRawHtml(rawUrl);
  const dom = new JSDOM(html, { url: finalUrl });
  const article = new Readability(dom.window.document).parse();
  const text = (article?.textContent || dom.window.document.body?.textContent || "")
    .replace(/\s+/g, " ")
    .trim();
  return {
    url: finalUrl,
    title: article?.title || dom.window.document.title || null,
    text,
  };
}

// ----------------------------------------------------------------------------
// EXTRACTIVE SUMMARIZER (no AI, no external calls, zero marginal cost).
// TextRank: build a sentence-similarity graph, run PageRank over it, and return
// the highest-scoring sentences in their original order. Selects existing
// sentences rather than rewriting — honest "key sentences," not an AI rewrite.
// ----------------------------------------------------------------------------
const STOPWORDS = new Set(
  ("a an and are as at be by for from has have had he her his i in is it its of on " +
   "or that the this to was were will with you your we they them she do does did not " +
   "but if then than so such also into over under about after before more most other " +
   "some any all no can could would should may might must our their there here what " +
   "which who whom whose when where why how")
    .split(" ")
);

// Strip Wikipedia-style reference markers and bracket noise that both clutter
// output and break sentence splitting (e.g. "unclear.[7] In the...").
function cleanText(text) {
  return text
    .replace(/\[\d+\]/g, "") // [7], [22]
    .replace(/\[(citation needed|note \d+|clarification needed|when\?|who\?|edit|update)\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Abbreviations whose periods must NOT be treated as sentence ends.
const ABBREV = [
  "U.S.", "U.K.", "e.g.", "i.e.", "etc.", "Inc.", "Ltd.", "Corp.", "Co.",
  "Dr.", "Mr.", "Mrs.", "Ms.", "Prof.", "vs.", "No.", "Jr.", "Sr.", "St.",
  "Fig.", "Vol.", "Jan.", "Feb.", "Aug.", "Sept.", "Oct.", "Nov.", "Dec.",
];

function splitSentences(text) {
  let t = cleanText(text);
  // Protect abbreviation periods with a placeholder so we don't split on them.
  ABBREV.forEach((a, k) => {
    t = t.split(a).join(a.replace(/\./g, `\u0002${k}\u0002`));
  });
  const parts = t
    .replace(/([.?!])\s+(?=[A-Z0-9"'])/g, "$1\u0001")
    .split("\u0001");
  const restore = (s) => s.replace(/\u0002\d+\u0002/g, ".");
  return parts
    .map((s) => restore(s).trim())
    .filter((s) => {
      const words = s.split(/\s+/).length;
      // Keep real sentences; drop fragments/headers and split-failure blobs.
      return s.length > 20 && words >= 5 && words <= 60;
    });
}

function tokenize(sentence) {
  return (sentence.toLowerCase().match(/[a-z0-9]+/g) || []).filter(
    (w) => w.length > 2 && !STOPWORDS.has(w)
  );
}

function summarizeText(text, numSentences) {
  const sentences = splitSentences(text);
  if (sentences.length <= numSentences) {
    return { sentences, total: sentences.length };
  }
  const tokens = sentences.map(tokenize);
  const sets = tokens.map((t) => new Set(t));
  const n = sentences.length;

  // Sentence similarity matrix (shared-word overlap, length-normalized).
  const sim = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let common = 0;
      for (const w of sets[i]) if (sets[j].has(w)) common++;
      const denom = Math.log(sets[i].size + 1) + Math.log(sets[j].size + 1);
      const s = denom > 0 ? common / denom : 0;
      sim[i][j] = s;
      sim[j][i] = s;
    }
  }
  const outSum = sim.map((row) => row.reduce((a, b) => a + b, 0));

  // PageRank iteration.
  let scores = new Array(n).fill(1);
  const d = 0.85;
  for (let it = 0; it < 30; it++) {
    const next = new Array(n).fill(1 - d);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let j = 0; j < n; j++) {
        if (j !== i && outSum[j] > 0) sum += (sim[j][i] / outSum[j]) * scores[j];
      }
      next[i] += d * sum;
    }
    scores = next;
  }

  // Lead bias: gently favor earlier sentences — intros/ledes summarize well and
  // this keeps a dense mid-article section from dominating the whole summary.
  for (let i = 0; i < n; i++) scores[i] *= 1 + 0.3 * (1 - i / n);

  // Top-N by score, returned in original document order for readability.
  const ranked = scores
    .map((s, i) => [s, i])
    .sort((a, b) => b[0] - a[0])
    .slice(0, numSentences)
    .map((x) => x[1])
    .sort((a, b) => a - b);

  return { sentences: ranked.map((i) => sentences[i]), total: n };
}

// ----------------------------------------------------------------------------
// OG / SOCIAL CARD CHECKER ENGINE. Extracts OpenGraph, Twitter-card, and core
// SEO meta from a page and reports what's missing or malformed.
// ----------------------------------------------------------------------------
function extractMeta(html, pageUrl) {
  const dom = new JSDOM(html, { url: pageUrl });
  const doc = dom.window.document;
  const pick = (sel, attr) => doc.querySelector(sel)?.getAttribute(attr) || null;

  const og = {};
  for (const m of doc.querySelectorAll('meta[property^="og:"]')) {
    const k = m.getAttribute("property").slice(3);
    if (!(k in og)) og[k] = m.getAttribute("content");
  }
  const tw = {};
  for (const m of doc.querySelectorAll('meta[name^="twitter:"]')) {
    const k = m.getAttribute("name").slice(8);
    if (!(k in tw)) tw[k] = m.getAttribute("content");
  }
  return {
    og,
    twitter: tw,
    title: doc.querySelector("title")?.textContent?.trim() || null,
    description: pick('meta[name="description"]', "content"),
    canonical: pick('link[rel="canonical"]', "href"),
    robots: pick('meta[name="robots"]', "content"),
  };
}

function auditSocialMeta(meta, pageUrl) {
  const problems = [];
  const warnings = [];
  const og = meta.og, tw = meta.twitter;

  // OpenGraph essentials
  if (!og.title) problems.push("og:title missing — platforms fall back to the <title> tag or guess.");
  if (!og.image) problems.push("og:image missing — links will share without a preview image.");
  if (!og.description) warnings.push("og:description missing — platforms may pull arbitrary page text.");
  if (!og.url) warnings.push("og:url missing — recommended canonical link for the share.");
  if (!og.type) warnings.push("og:type missing — defaults to 'website'; set 'article' for content pages.");

  if (og.image) {
    let abs = null;
    try { abs = new URL(og.image, pageUrl); } catch { /* noop */ }
    if (!abs) problems.push("og:image is not a valid URL.");
    else {
      if (abs.protocol !== "https:") warnings.push("og:image is not https — some platforms refuse mixed-content images.");
      if (/\.svg(\?|$)/i.test(abs.pathname)) problems.push("og:image is an SVG — most platforms only accept PNG/JPEG/WebP raster images.");
    }
    if (!og["image:width"] || !og["image:height"]) {
      warnings.push("og:image:width/height not declared — declaring 1200x630 lets platforms render the card before fetching the image.");
    }
  }

  // Twitter card
  if (!tw.card) warnings.push("twitter:card missing — X/Twitter falls back to a small summary; use 'summary_large_image' for the big card.");
  else if (!["summary", "summary_large_image", "app", "player"].includes(tw.card)) {
    problems.push(`twitter:card '${tw.card}' is not a valid card type.`);
  }
  if (tw.card && !tw.image && !og.image) problems.push("twitter:card declared but no twitter:image or og:image to render.");

  // Lengths (soft limits where platforms truncate)
  const t = og.title || meta.title;
  if (t && t.length > 70) warnings.push(`title is ${t.length} chars — most platforms truncate around 60-70.`);
  const d = og.description || meta.description;
  if (d && d.length > 200) warnings.push(`description is ${d.length} chars — truncation typically starts around 200.`);
  if (d && d.length < 40) warnings.push("description is very short — aim for 55-200 characters.");

  if (!meta.canonical) warnings.push("canonical link missing.");

  const verdict = problems.length ? "broken" : warnings.length ? "improvable" : "good";
  return { problems, warnings, verdict };
}

// ----------------------------------------------------------------------------
// SOCIAL CARD GENERATOR — procedural 1200x630 SVG in the house style, then
// rasterized to PNG (og:image must be raster). sharp loads defensively; if it
// is unavailable the endpoint still returns the SVG.
// ----------------------------------------------------------------------------
let sharpLib = null;
try {
  sharpLib = (await import("sharp")).default;
  console.log("✓ sharp loaded (PNG card rendering enabled)");
} catch {
  console.warn("⚠ sharp unavailable — /api/og/card will return SVG only");
}

const CARD_THEMES = {
  dark:   { bg: "#0d0e11", panel: "#15171d", ink: "#f4f1ea", dim: "#8a877f", accent: "#ff6b35" },
  light:  { bg: "#f7f4ed", panel: "#ffffff", ink: "#16181d", dim: "#6f6c65", accent: "#e85d2a" },
  midnight: { bg: "#0a0f1e", panel: "#111831", ink: "#e8ecf8", dim: "#7d86a3", accent: "#5b8cff" },
};

function escXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}

// Approximate word-wrap for SVG text (no auto-wrap in SVG). charW is the
// average glyph width as a fraction of font size.
function wrapText(text, fontSize, maxWidth, maxLines, charW = 0.56) {
  const words = String(text).trim().split(/\s+/);
  const perLine = Math.max(4, Math.floor(maxWidth / (fontSize * charW)));
  const lines = [];
  let line = "";
  for (const w of words) {
    const tryLine = line ? line + " " + w : w;
    if (tryLine.length <= perLine) { line = tryLine; continue; }
    if (line) lines.push(line);
    line = w;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && (line !== lines[lines.length - 1] || words.join(" ").length > lines.join(" ").length)) {
    const last = lines[maxLines - 1];
    if (lines.join(" ").length < words.join(" ").length) lines[maxLines - 1] = last.replace(/.{3}$/, "") + "…";
  }
  return lines;
}

function buildCardSvg({ title, subtitle, domain, theme = "dark", accent }) {
  const th = { ...(CARD_THEMES[theme] || CARD_THEMES.dark) };
  if (accent && /^#[0-9a-fA-F]{3,8}$/.test(accent)) th.accent = accent;

  const titleLines = wrapText(title, 66, 1040, 3);
  const titleY = subtitle ? 250 : 290;
  const titleSvg = titleLines.map((l, i) =>
    `<text x="80" y="${titleY + i * 82}" font-family="DejaVu Sans, Arial, sans-serif" font-size="66" font-weight="700" fill="${th.ink}">${escXml(l)}</text>`
  ).join("\n  ");

  let subtitleSvg = "";
  if (subtitle) {
    const subLines = wrapText(subtitle, 30, 1040, 2);
    const subY = titleY + titleLines.length * 82 + 20;
    subtitleSvg = subLines.map((l, i) =>
      `<text x="80" y="${subY + i * 42}" font-family="DejaVu Sans, Arial, sans-serif" font-size="30" fill="${th.dim}">${escXml(l)}</text>`
    ).join("\n  ");
  }

  // subtle dot grid, corner tick, accent bar — procedural, house style
  const dots = [];
  for (let gx = 0; gx < 12; gx++) for (let gy = 0; gy < 6; gy++) {
    dots.push(`<circle cx="${840 + gx * 28}" cy="${64 + gy * 28}" r="1.6" fill="${th.dim}" opacity="0.35"/>`);
  }

  return `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="630" fill="${th.bg}"/>
  <rect x="0" y="0" width="1200" height="10" fill="${th.accent}"/>
  ${dots.join("")}
  <rect x="80" y="${titleY - 118}" width="56" height="8" fill="${th.accent}"/>
  ${titleSvg}
  ${subtitleSvg}
  ${domain ? `<text x="80" y="566" font-family="DejaVu Sans Mono, Menlo, monospace" font-size="24" fill="${th.accent}">${escXml(domain)}</text>` : ""}
</svg>`;
}

// ----------------------------------------------------------------------------
// ALT-TEXT CHECKER ENGINE (SEO + accessibility). Audits every image-like
// element for missing, empty, or low-quality alt text.
// ----------------------------------------------------------------------------
const ALT_FILENAME_RE = /\.(jpe?g|png|webp|gif|svg|avif)\s*$/i;
const ALT_GENERIC_RE = /^\s*(image|photo|picture|img|graphic|icon|logo|banner)(\s+of)?\s*$/i;

function checkAltText(html, pageUrl) {
  const dom = new JSDOM(html, { url: pageUrl });
  const doc = dom.window.document;
  const issues = [];
  const push = (el, srcAttr, issue, detail) => {
    if (issues.length >= 100) return;
    issues.push({ tag: el.tagName.toLowerCase(), src: (el.getAttribute(srcAttr) || "").slice(0, 200), issue, ...(detail ? { detail } : {}) });
  };

  const imgs = [...doc.querySelectorAll("img")];
  let missing = 0, empty = 0, suspicious = 0, good = 0;
  for (const img of imgs) {
    const alt = img.getAttribute("alt");
    if (alt === null) { missing++; push(img, "src", "missing_alt", "No alt attribute — screen readers announce the filename or nothing."); }
    else if (alt.trim() === "") { empty++; /* valid for decorative images — counted, not flagged */ }
    else if (ALT_FILENAME_RE.test(alt) || ALT_GENERIC_RE.test(alt) || /^\d+$/.test(alt.trim())) {
      suspicious++; push(img, "src", "low_quality_alt", `alt="${alt.slice(0, 80)}" — filename or generic text conveys nothing.`);
    } else if (alt.length > 150) {
      suspicious++; push(img, "src", "alt_too_long", `${alt.length} chars — keep alt concise (~125 max); use surrounding text for detail.`);
    } else good++;
  }

  // Other image-bearing elements that require alternatives.
  for (const area of doc.querySelectorAll("area[href]")) {
    if (!area.getAttribute("alt")) push(area, "href", "area_missing_alt", "Image-map area links need alt text.");
  }
  for (const input of doc.querySelectorAll('input[type="image"]')) {
    if (!input.getAttribute("alt")) push(input, "src", "input_image_missing_alt", "Image inputs need alt describing the action.");
  }
  const svgIssues = [...doc.querySelectorAll('svg[role="img"]')].filter(
    (s) => !s.getAttribute("aria-label") && !s.getAttribute("aria-labelledby") && !s.querySelector("title")
  ).length;

  return {
    images_total: imgs.length,
    with_good_alt: good,
    missing_alt: missing,
    empty_alt_decorative: empty,
    low_quality_alt: suspicious,
    svg_img_unlabeled: svgIssues,
    issues,
    note: 'alt="" is valid for purely decorative images and is counted separately, not flagged.',
  };
}

// ----------------------------------------------------------------------------
// ACCESSIBILITY (WCAG) STATIC CHECK ENGINE. Runs the WCAG success-criteria
// checks that are decidable from static HTML, mapped to criterion + level.
// Honest scope: contrast, focus visibility, and keyboard behavior need a
// rendering browser and are explicitly reported as not checked.
// ----------------------------------------------------------------------------
const VALID_ARIA_ROLES = new Set([
  "alert","alertdialog","application","article","banner","button","cell","checkbox","columnheader",
  "combobox","complementary","contentinfo","definition","dialog","directory","document","feed","figure",
  "form","grid","gridcell","group","heading","img","link","list","listbox","listitem","log","main",
  "marquee","math","menu","menubar","menuitem","menuitemcheckbox","menuitemradio","navigation","none",
  "note","option","presentation","progressbar","radio","radiogroup","region","row","rowgroup","rowheader",
  "scrollbar","search","searchbox","separator","slider","spinbutton","status","switch","tab","table",
  "tablist","tabpanel","term","textbox","timer","toolbar","tooltip","tree","treegrid","treeitem",
]);
const GENERIC_LINK_RE = /^\s*(click here|here|read more|more|learn more|link|this|details|continue|go)\s*$/i;

function a11yCheck(html, pageUrl) {
  const dom = new JSDOM(html, { url: pageUrl });
  const doc = dom.window.document;
  const findings = [];
  const add = (criterion, level, name, count, detail, examples) => {
    if (count > 0) findings.push({ criterion, level, name, count, detail, ...(examples && examples.length ? { examples: examples.slice(0, 5) } : {}) });
  };

  // 1.1.1 Non-text Content (A) — reuse the alt engine's core counts.
  const alt = checkAltText(html, pageUrl);
  add("1.1.1", "A", "Non-text content", alt.missing_alt + alt.low_quality_alt + alt.svg_img_unlabeled,
    "Images and svg[role=img] without usable text alternatives.",
    alt.issues.filter((i) => i.issue !== "alt_too_long").map((i) => i.src));

  // 2.4.2 Page Titled (A)
  const title = doc.querySelector("title")?.textContent?.trim();
  add("2.4.2", "A", "Page titled", title ? 0 : 1, "Document has no <title>.");

  // 3.1.1 Language of Page (A)
  const lang = doc.documentElement.getAttribute("lang");
  add("3.1.1", "A", "Language of page", lang ? 0 : 1, "<html> element has no lang attribute.");

  // 1.3.1 Info and Relationships (A): unlabeled form controls, heading order, table headers.
  const controls = [...doc.querySelectorAll("input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]), select, textarea")];
  const unlabeled = controls.filter((c) => {
    if (c.getAttribute("aria-label") || c.getAttribute("aria-labelledby") || c.getAttribute("title")) return false;
    const id = c.getAttribute("id");
    if (id && doc.querySelector(`label[for="${id.replace(/"/g, '\\"')}"]`)) return false;
    return !c.closest("label");
  });
  add("1.3.1", "A", "Form controls labeled", unlabeled.length,
    "Form fields with no <label>, aria-label, or aria-labelledby.",
    unlabeled.map((c) => `${c.tagName.toLowerCase()}[name=${c.getAttribute("name") || "?"}]`));

  const hs = [...doc.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => +h.tagName[1]);
  let skips = 0;
  for (let i = 1; i < hs.length; i++) if (hs[i] - hs[i - 1] > 1) skips++;
  add("1.3.1", "A", "Heading structure", skips, "Heading levels skip (e.g. h2 → h4), breaking the document outline.");
  add("1.3.1", "A", "Missing h1", doc.querySelector("h1") ? 0 : 1, "Page has no h1.");

  const tables = [...doc.querySelectorAll("table")].filter((t) => !t.querySelector("th") && t.querySelectorAll("tr").length > 1);
  add("1.3.1", "A", "Table headers", tables.length, "Data tables with no <th> header cells.");

  // 2.4.4 Link Purpose (A): generic link text; links with no accessible name.
  const links = [...doc.querySelectorAll("a[href]")];
  const generic = links.filter((a) => GENERIC_LINK_RE.test(a.textContent || ""));
  add("2.4.4", "A", "Link purpose", generic.length, 'Links with generic text ("click here", "read more") that make no sense out of context.',
    generic.map((a) => (a.textContent || "").trim().slice(0, 40)));
  const nameless = links.filter((a) => !(a.textContent || "").trim() && !a.getAttribute("aria-label") && !a.getAttribute("aria-labelledby") && !a.querySelector("img[alt]:not([alt=''])"));
  add("4.1.2", "A", "Links have accessible names", nameless.length, "Links with no text, aria-label, or labeled image inside.");

  // 4.1.2 Name, Role, Value (A): buttons without names, iframes without titles.
  const btns = [...doc.querySelectorAll("button")].filter((b) => !(b.textContent || "").trim() && !b.getAttribute("aria-label") && !b.getAttribute("aria-labelledby"));
  add("4.1.2", "A", "Buttons have accessible names", btns.length, "Buttons with no text or aria-label.");
  const frames = [...doc.querySelectorAll("iframe")].filter((f) => !f.getAttribute("title"));
  add("4.1.2", "A", "Iframes titled", frames.length, "iframes with no title attribute.");

  // 4.1.1-adjacent: duplicate IDs (breaks label/aria references).
  const ids = {};
  for (const el of doc.querySelectorAll("[id]")) { const id = el.getAttribute("id"); ids[id] = (ids[id] || 0) + 1; }
  const dups = Object.entries(ids).filter(([, n]) => n > 1);
  add("4.1.1", "A", "Duplicate IDs", dups.length, "Duplicate id attributes break label and ARIA references.", dups.map(([id]) => id));

  // ARIA validity: unknown roles, invalid aria-* attribute names.
  const badRoles = [...doc.querySelectorAll("[role]")].filter((el) => el.getAttribute("role").split(/\s+/).every((r) => !VALID_ARIA_ROLES.has(r)));
  add("4.1.2", "A", "Valid ARIA roles", badRoles.length, "Elements with unrecognized role values.", badRoles.map((el) => el.getAttribute("role")));

  // 1.4.4 / 1.4.10 (AA): zoom blocking.
  const viewport = doc.querySelector('meta[name="viewport"]')?.getAttribute("content") || "";
  const zoomBlocked = /user-scalable\s*=\s*(no|0)/i.test(viewport) || /maximum-scale\s*=\s*1(\.0*)?\b/i.test(viewport);
  add("1.4.4", "AA", "Zoom not disabled", zoomBlocked ? 1 : 0, `viewport "${viewport.slice(0, 80)}" blocks pinch-zoom (user-scalable=no or maximum-scale=1).`);

  // 3.2.2-adjacent (A): meta refresh/redirects.
  const refresh = doc.querySelector('meta[http-equiv="refresh" i]');
  add("2.2.1", "A", "No meta refresh", refresh ? 1 : 0, "meta refresh reloads/redirects without user control.");

  // 2.4.1 Bypass Blocks (A): skip link heuristic — only flag if nav exists.
  const hasNav = !!doc.querySelector("nav, [role=navigation]");
  const skipLink = [...doc.querySelectorAll('a[href^="#"]')].some((a) => /skip|jump/i.test(a.textContent || ""));
  const hasMain = !!doc.querySelector("main, [role=main]");
  add("2.4.1", "A", "Bypass blocks", hasNav && !skipLink && !hasMain ? 1 : 0,
    "Page has navigation but no skip link and no <main> landmark to bypass it.");

  // AAA (static subset): 2.4.9 link purpose (link-only) — reuses generic-link data at stricter level.
  add("2.4.9", "AAA", "Link purpose (link only)", generic.length + nameless.length,
    "At AAA, every link's purpose must be clear from the link text alone.");

  const counts = { A: 0, AA: 0, AAA: 0 };
  for (const f of findings) counts[f.level] += f.count;

  return {
    findings,
    totals: { issues: findings.reduce((s, f) => s + f.count, 0), by_level: counts, criteria_failed: findings.length },
    not_checked: [
      "1.4.3/1.4.6 color contrast (needs computed styles from a rendering browser)",
      "2.4.7 focus visibility (needs rendering)",
      "2.1.1/2.1.2 keyboard operability and traps (needs interaction)",
      "1.4.10 reflow at 320px (needs layout)",
      "media captions/transcripts (needs content inspection)",
    ],
    method: "static HTML analysis",
  };
}

// ----------------------------------------------------------------------------
// ROBOTS.TXT + LLMS.TXT CHECKER ENGINE. Parses crawler rules, reports access
// for major search AND AI crawlers, and checks the emerging llms.txt convention.
// ----------------------------------------------------------------------------
const TRACKED_BOTS = [
  { name: "Googlebot", kind: "search" },
  { name: "Bingbot", kind: "search" },
  { name: "GPTBot", kind: "ai" },
  { name: "ClaudeBot", kind: "ai" },
  { name: "anthropic-ai", kind: "ai" },
  { name: "PerplexityBot", kind: "ai" },
  { name: "Google-Extended", kind: "ai" },
  { name: "CCBot", kind: "ai" },
  { name: "Applebot-Extended", kind: "ai" },
  { name: "Bytespider", kind: "ai" },
  { name: "meta-externalagent", kind: "ai" },
];

function parseRobots(text) {
  const groups = []; // { agents: [], rules: [{type, path}], crawlDelay }
  const sitemaps = [];
  const warnings = [];
  let current = null;
  let sawAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) { warnings.push(`Unparseable line: "${raw.trim().slice(0, 60)}"`); continue; }
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "user-agent") {
      if (!current || current.rules.length || current.crawlDelay != null) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(val.toLowerCase());
      sawAgent = true;
    } else if (key === "disallow" || key === "allow") {
      if (!current) { if (!sawAgent) warnings.push(`${m[1]} rule before any User-agent — ignored by crawlers.`); continue; }
      current.rules.push({ type: key, path: val });
    } else if (key === "crawl-delay") {
      if (current) current.crawlDelay = val;
    } else if (key === "sitemap") {
      sitemaps.push(val);
    } else if (!["host", "clean-param", "noindex"].includes(key)) {
      warnings.push(`Unknown directive: ${m[1]}`);
    }
  }
  return { groups, sitemaps, warnings };
}

function botAccess(parsed, botName) {
  const name = botName.toLowerCase();
  // Most-specific matching group wins; '*' is the fallback.
  let best = null, bestLen = -1;
  for (const g of parsed.groups) {
    for (const a of g.agents) {
      if (a === "*" && bestLen < 0) { best = g; }
      else if (name.includes(a) && a.length > bestLen) { best = g; bestLen = a.length; }
    }
  }
  if (!best) return { matched_group: null, root_blocked: false, rules: [] };
  // Longest-match evaluation for path "/" (covers Allow overriding Disallow).
  let verdict = { type: "allow", len: -1 };
  for (const r of best.rules) {
    if (!r.path) continue; // empty Disallow = allow all
    if ("/".startsWith(r.path) || r.path === "/") {
      if (r.path.length > verdict.len) verdict = { type: r.type, len: r.path.length };
    }
  }
  return {
    matched_group: bestLen >= 0 ? [...new Set(best.agents)].join(", ") : "*",
    root_blocked: verdict.type === "disallow",
    rules: best.rules.slice(0, 20),
    ...(best.crawlDelay != null ? { crawl_delay: best.crawlDelay } : {}),
  };
}

// ----------------------------------------------------------------------------
// HEAD / META SEO AUDIT ENGINE. On-page head fundamentals: title, description,
// robots directives, canonical, hreflang, charset/viewport, favicon, H1s.
// ----------------------------------------------------------------------------
function headCheck(html, pageUrl) {
  const dom = new JSDOM(html, { url: pageUrl });
  const doc = dom.window.document;
  const problems = [];
  const warnings = [];

  const titles = doc.querySelectorAll("title");
  const title = titles[0]?.textContent?.trim() || null;
  if (!title) problems.push("No <title> — the single most important on-page element.");
  else {
    if (title.length > 60) warnings.push(`Title is ${title.length} chars — Google typically truncates around 55-60.`);
    if (title.length < 15) warnings.push(`Title is only ${title.length} chars — likely underselling the page.`);
  }
  if (titles.length > 1) problems.push(`${titles.length} <title> tags — browsers/crawlers use the first; remove duplicates.`);

  const desc = doc.querySelector('meta[name="description"]')?.getAttribute("content")?.trim() || null;
  if (!desc) warnings.push("No meta description — Google will generate its own snippet.");
  else if (desc.length > 160) warnings.push(`Meta description is ${desc.length} chars — truncation starts around 155-160.`);
  else if (desc.length < 50) warnings.push(`Meta description is only ${desc.length} chars — thin snippets get rewritten.`);

  const robotsMeta = doc.querySelector('meta[name="robots"]')?.getAttribute("content")?.toLowerCase() || null;
  if (robotsMeta) {
    if (/noindex/.test(robotsMeta)) problems.push(`robots meta contains NOINDEX — this page is excluded from search. Intentional?`);
    if (/nofollow/.test(robotsMeta)) warnings.push("robots meta contains nofollow — internal links pass no signals.");
  }

  const canonEl = doc.querySelector('link[rel="canonical"]');
  const canonical = canonEl?.getAttribute("href") || null;
  let canonicalStatus = "missing";
  if (canonical) {
    try {
      const abs = new URL(canonical, pageUrl);
      const self = new URL(pageUrl);
      canonicalStatus = abs.href.replace(/\/$/, "") === self.href.replace(/\/$/, "") ? "self-referencing" : "points elsewhere";
      if (!/^https?:/.test(canonical) && canonical.startsWith("/")) warnings.push("canonical is a relative URL — use absolute.");
      if (canonicalStatus === "points elsewhere") warnings.push(`canonical points to ${abs.href} — this page defers indexing to that URL. Intentional?`);
    } catch { problems.push("canonical href is not a valid URL."); canonicalStatus = "invalid"; }
  } else warnings.push("No canonical link.");

  const hreflangs = [...doc.querySelectorAll('link[rel="alternate"][hreflang]')];
  const hreflangIssues = [];
  const seen = new Set();
  for (const l of hreflangs) {
    const code = l.getAttribute("hreflang");
    if (!/^([a-z]{2,3}(-[A-Za-z]{2}|-[0-9]{3})?|x-default)$/i.test(code)) hreflangIssues.push(`invalid code "${code}"`);
    if (seen.has(code.toLowerCase())) hreflangIssues.push(`duplicate "${code}"`);
    seen.add(code.toLowerCase());
  }
  if (hreflangs.length && !seen.has("x-default")) warnings.push("hreflang set has no x-default entry.");
  if (hreflangIssues.length) problems.push(`hreflang issues: ${hreflangIssues.slice(0, 5).join("; ")}`);

  if (!doc.querySelector("meta[charset], meta[http-equiv='Content-Type' i]")) warnings.push("No charset declaration.");
  if (!doc.querySelector('meta[name="viewport"]')) warnings.push("No viewport meta — page fails mobile-friendly checks.");
  if (!doc.querySelector('link[rel~="icon" i], link[rel="shortcut icon" i], link[rel="apple-touch-icon" i]')) warnings.push("No favicon link.");

  const h1s = doc.querySelectorAll("h1");
  if (h1s.length === 0) warnings.push("No h1 on the page.");
  else if (h1s.length > 1) warnings.push(`${h1s.length} h1 elements — one clear h1 is the convention.`);

  const lang = doc.documentElement.getAttribute("lang") || null;
  if (!lang) warnings.push("<html> has no lang attribute.");

  return {
    title: title ? { text: title.slice(0, 120), length: title.length } : null,
    meta_description: desc ? { text: desc.slice(0, 200), length: desc.length } : null,
    robots_meta: robotsMeta,
    canonical: canonical ? { href: canonical.slice(0, 200), status: canonicalStatus } : null,
    hreflang_count: hreflangs.length,
    h1_count: h1s.length,
    lang,
    has_og_tags: !!doc.querySelector('meta[property^="og:"]'),
    has_twitter_tags: !!doc.querySelector('meta[name^="twitter:"]'),
    problems,
    warnings,
    verdict: problems.length ? "problems" : warnings.length ? "improvable" : "good",
  };
}

// ----------------------------------------------------------------------------
// SITEMAP VALIDATOR ENGINE. Finds the sitemap (direct URL, robots.txt
// declaration, or /sitemap.xml), validates structure, and health-checks a
// sample of URLs. Sample capped to protect the instance.
// ----------------------------------------------------------------------------
const SITEMAP_SAMPLE = 8;

function extractXmlTags(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  let m;
  while ((m = re.exec(xml)) !== null && out.length < 50_000) out.push(m[1].trim());
  return out;
}

async function sitemapCheck(inputUrl) {
  const u = new URL(assertSafeUrl(inputUrl));
  let sitemapUrl = null;
  let discovered_via = null;

  if (/\.xml(\.gz)?(\?|$)/i.test(u.pathname) || /sitemap/i.test(u.pathname)) {
    sitemapUrl = u.href; discovered_via = "direct URL";
  } else {
    const robots = await fetchRawText(`${u.origin}/robots.txt`, 512 * 1024).catch(() => null);
    const declared = robots?.ok ? (robots.text.match(/^sitemap:\s*(\S+)/gim) || []).map((l) => l.replace(/^sitemap:\s*/i, "")) : [];
    if (declared.length) { sitemapUrl = declared[0]; discovered_via = `robots.txt (${declared.length} declared)`; }
    else { sitemapUrl = `${u.origin}/sitemap.xml`; discovered_via = "default /sitemap.xml"; }
  }

  const fetched = await fetchRawText(sitemapUrl);
  if (!fetched.ok) {
    return { sitemap_url: sitemapUrl, discovered_via, found: false, status: fetched.status,
      note: "No sitemap found — declare one in robots.txt or place sitemap.xml at the site root." };
  }
  const xml = fetched.text;
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const result = { sitemap_url: fetched.finalUrl, discovered_via, found: true, type: isIndex ? "sitemapindex" : "urlset" };

  let urlXml = xml;
  if (isIndex) {
    const children = extractXmlTags(xml, "sitemap").map((b) => (b.match(/<loc[^>]*>([\s\S]*?)<\/loc>/i) || [])[1]).filter(Boolean);
    result.child_sitemaps = children.length;
    result.children_preview = children.slice(0, 5);
    if (!children.length) { result.problems = ["sitemapindex contains no <sitemap><loc> entries."]; return result; }
    const child = await fetchRawText(children[0]).catch(() => null);
    if (!child?.ok) { result.problems = [`First child sitemap unreachable (${child?.status || "error"}).`]; return result; }
    urlXml = child.text;
    result.analyzed_child = children[0];
  }

  const locs = extractXmlTags(urlXml, "url").map((b) => ({
    loc: (b.match(/<loc[^>]*>([\s\S]*?)<\/loc>/i) || [])[1]?.trim(),
    lastmod: (b.match(/<lastmod[^>]*>([\s\S]*?)<\/lastmod>/i) || [])[1]?.trim() || null,
  })).filter((e) => e.loc);

  const problems = [];
  const warnings = [];
  if (!locs.length) problems.push("No <url><loc> entries found.");
  if (locs.length > 50_000) problems.push(`${locs.length} URLs — the protocol caps a single sitemap at 50,000; split it.`);
  const withLastmod = locs.filter((e) => e.lastmod).length;
  const badDates = locs.filter((e) => e.lastmod && isNaN(Date.parse(e.lastmod))).length;
  if (badDates) problems.push(`${badDates} lastmod values are not valid dates.`);
  if (locs.length && withLastmod / locs.length < 0.5) warnings.push(`Only ${withLastmod}/${locs.length} URLs have lastmod — crawlers use it to prioritize.`);
  const offHost = locs.filter((e) => { try { return new URL(e.loc).hostname !== new URL(fetched.finalUrl).hostname; } catch { return true; } }).length;
  if (offHost) warnings.push(`${offHost} URLs are on a different host than the sitemap — crawlers ignore cross-host entries.`);

  // Health-check a spread sample (SSRF-guarded, capped).
  const sample = [];
  const step = Math.max(1, Math.floor(locs.length / SITEMAP_SAMPLE));
  for (let i = 0; i < locs.length && sample.length < SITEMAP_SAMPLE; i += step) sample.push(locs[i].loc);
  const health = await Promise.all(sample.map(async (loc) => {
    try {
      assertSafeUrl(loc);
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(loc, { method: "HEAD", redirect: "follow", signal: ctrl.signal });
      clearTimeout(t);
      return { url: loc.slice(0, 150), status: r.status, ok: r.ok };
    } catch { return { url: loc.slice(0, 150), status: null, ok: false }; }
  }));
  const dead = health.filter((h) => !h.ok).length;
  if (dead) warnings.push(`${dead}/${health.length} sampled URLs did not return 2xx — sitemaps should list only live, canonical pages.`);

  return {
    ...result,
    url_count: locs.length,
    with_lastmod: withLastmod,
    sample_health: health,
    problems,
    warnings,
    verdict: problems.length ? "problems" : warnings.length ? "improvable" : "good",
  };
}

// ----------------------------------------------------------------------------
// INTERNAL-LINK ANALYZER ENGINE. Single-page link profile: internal/external
// split, rel attributes, anchor quality, security flags. No link fetching.
// ----------------------------------------------------------------------------
function analyzeLinks(html, pageUrl) {
  const dom = new JSDOM(html, { url: pageUrl });
  const doc = dom.window.document;
  const pageHost = new URL(pageUrl).hostname.replace(/^www\./, "");
  const links = [...doc.querySelectorAll("a[href]")];

  let internal = 0, external = 0, fragment = 0, mailtoTel = 0;
  let nofollow = 0, sponsored = 0, ugc = 0;
  const emptyAnchors = [], genericAnchors = [], blankNoNoopener = [];
  const hrefCounts = {};
  const anchorTexts = {};

  for (const a of links) {
    const href = a.getAttribute("href") || "";
    const text = (a.textContent || "").trim();
    const rel = (a.getAttribute("rel") || "").toLowerCase();
    if (/^(mailto:|tel:)/i.test(href)) { mailtoTel++; continue; }
    if (href.startsWith("#")) { fragment++; continue; }
    let abs;
    try { abs = new URL(href, pageUrl); } catch { continue; }
    if (!/^https?:$/.test(abs.protocol)) continue;

    const isInternal = abs.hostname.replace(/^www\./, "") === pageHost;
    isInternal ? internal++ : external++;
    if (/\bnofollow\b/.test(rel)) nofollow++;
    if (/\bsponsored\b/.test(rel)) sponsored++;
    if (/\bugc\b/.test(rel)) ugc++;

    if (a.getAttribute("target") === "_blank" && !/\bnoopener\b/.test(rel) && !/\bnoreferrer\b/.test(rel) && blankNoNoopener.length < 20) {
      blankNoNoopener.push(abs.href.slice(0, 120));
    }
    if (!text && !a.getAttribute("aria-label") && !a.querySelector("img[alt]:not([alt=''])") && emptyAnchors.length < 20) {
      emptyAnchors.push(abs.href.slice(0, 120));
    }
    if (GENERIC_LINK_RE.test(text) && genericAnchors.length < 20) genericAnchors.push(text.slice(0, 40));

    hrefCounts[abs.href] = (hrefCounts[abs.href] || 0) + 1;
    if (text && isInternal) anchorTexts[text.toLowerCase().slice(0, 60)] = (anchorTexts[text.toLowerCase().slice(0, 60)] || 0) + 1;
  }

  const duplicates = Object.entries(hrefCounts).filter(([, n]) => n > 2)
    .sort((a, b) => b[1] - a[1]).slice(0, 10).map(([href, n]) => ({ href: href.slice(0, 120), count: n }));
  const topAnchors = Object.entries(anchorTexts).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([text, n]) => ({ text, count: n }));

  return {
    total_links: links.length,
    internal, external, fragment_only: fragment, mailto_tel: mailtoTel,
    rel: { nofollow, sponsored, ugc },
    empty_anchors: emptyAnchors,
    generic_anchors: genericAnchors,
    target_blank_missing_noopener: blankNoNoopener,
    most_repeated_links: duplicates,
    top_internal_anchor_texts: topAnchors,
  };
}

// ----------------------------------------------------------------------------
// DISCOGS MUSIC ENGINE. Wraps the Discogs API (token via DISCOGS_TOKEN env
// var) for album metadata and cover art. Discogs requires a custom User-Agent
// and enforces 60 req/min — a small TTL cache keeps repeat lookups free.
// ----------------------------------------------------------------------------
const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN || "";
const DISCOGS_UA = "WebberSitesX402DataAPI/1.0 (+https://x402.webbersites.com)";
console.log(DISCOGS_TOKEN ? `✓ Discogs token present (length ${DISCOGS_TOKEN.length})` : "⚠ DISCOGS_TOKEN not set — music endpoints will 503");
const discogsCache = new Map(); // key -> { data, expires }
const DISCOGS_TTL = 10 * 60 * 1000;

function discogsCacheGet(key) {
  const hit = discogsCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.data;
  discogsCache.delete(key);
  return null;
}
function discogsCacheSet(key, data) {
  if (discogsCache.size > 500) discogsCache.clear(); // crude but bounded
  discogsCache.set(key, { data, expires: Date.now() + DISCOGS_TTL });
}

async function discogsFetch(path, params = {}) {
  if (!DISCOGS_TOKEN) { const e = new Error("DISCOGS_TOKEN not configured"); e.code = "no_token"; throw e; }
  const url = new URL(`https://api.discogs.com${path}`);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") url.searchParams.set(k, String(v));
  return discogsFetchUrl(url);
}

// Fetch an absolute Discogs API URL (e.g. a search hit's resource_url), adding
// the token and reusing the same cache + headers as discogsFetch.
async function discogsFetchUrl(urlInput) {
  if (!DISCOGS_TOKEN) { const e = new Error("DISCOGS_TOKEN not configured"); e.code = "no_token"; throw e; }
  const url = urlInput instanceof URL ? urlInput : new URL(String(urlInput));
  if (url.hostname !== "api.discogs.com") { const e = new Error("refusing non-Discogs URL"); e.code = "bad_url"; throw e; }
  url.searchParams.set("token", DISCOGS_TOKEN);
  const cacheKey = url.pathname + "?" + url.searchParams.toString().replace(/token=[^&]+/, "");
  const cached = discogsCacheGet(cacheKey);
  if (cached) return cached;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": DISCOGS_UA, "Accept": "application/vnd.discogs.v2.discogs+json" } });
    if (r.status === 429) { const e = new Error("Discogs rate limit hit (60/min) — try again shortly"); e.code = "rate_limited"; throw e; }
    if (!r.ok) {
      let body = "";
      try { body = (await r.text()).slice(0, 300); } catch { /* ignore */ }
      const e = new Error(`Discogs returned ${r.status} for ${url.pathname} — ${body || "(no body)"}`);
      e.code = "upstream";
      e.status = r.status;
      throw e;
    }
    const data = await r.json();
    discogsCacheSet(cacheKey, data);
    return data;
  } finally { clearTimeout(t); }
}

// Find the best-matching album AND fetch its detail. Prefers masters (the
// canonical album) over individual pressings; falls back to releases.
// Discogs' search index contains stale entries — hits whose master/release
// has since been merged or deleted and 404s at its own resource_url (e.g. the
// top master hit for "Radiohead OK Computer" is dead; the valid one is hit #2).
// So this walks the top hits in order and returns the first whose detail
// actually resolves. Returns { found, detail } or null if nothing matched.
async function discogsResolveAlbum({ artist, title, q, id, kind }) {
  if (id) {
    const type = kind === "release" ? "release" : "master";
    const found = { id: String(id), type, resource_url: `https://api.discogs.com/${type}s/${id}` };
    return { found, detail: await discogsFetchUrl(found.resource_url) };
  }
  const types = kind === "release" ? ["release"] : ["master", "release"];
  let staleErr = null;
  for (const type of types) {
    const params = q ? { q, type, per_page: 5 } : { artist, release_title: title, type, per_page: 5 };
    const res = await discogsFetch("/database/search", params);
    for (const hit of (res.results || []).slice(0, 5)) {
      const found = {
        id: String(hit.id),
        type: hit.type || type,
        resource_url: hit.resource_url || hit.master_url || `https://api.discogs.com/${type}s/${hit.id}`,
        search_hit: hit,
      };
      try {
        return { found, detail: await discogsFetchUrl(found.resource_url) };
      } catch (err) {
        if (err.status === 404) { staleErr = err; continue; } // stale index entry — try next hit
        throw err; // rate limit / network / auth — surface immediately
      }
    }
  }
  if (staleErr) throw staleErr; // every hit the index returned is dead
  return null;
}

// ----------------------------------------------------------------------------
// DOCUMENT EXTRACTION ENGINE. PDF / DOCX / CSV → markdown + structured JSON.
// All pure-JS parsers (pdf.js via unpdf, mammoth, csv-parse) — no native
// binaries or system packages, so it runs on any Node host. Loaded defensively
// like the other engines: a missing parser 503s its type, the server boots.
// No OCR — image-only/scanned PDFs are flagged ocr_required instead of
// returning junk. Legacy binary .doc (pre-2007 OLE) is not supported.
// ----------------------------------------------------------------------------
let unpdfLib = null, mammothLib = null, csvParseFn = null;
try { unpdfLib = await import("unpdf"); } catch (e) { console.warn("⚠ unpdf not loaded — PDF extraction disabled:", e.message); }
try { const m = await import("mammoth"); mammothLib = m.default || m; } catch (e) { console.warn("⚠ mammoth not loaded — DOCX extraction disabled:", e.message); }
try { const c = await import("csv-parse/sync"); csvParseFn = c.parse; } catch (e) { console.warn("⚠ csv-parse not loaded — CSV extraction disabled:", e.message); }
console.log(`✓ Document extraction parsers: pdf=${!!unpdfLib} docx=${!!mammothLib} csv=${!!csvParseFn}`);

const EXTRACT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB document cap

// Detect the document type: explicit ?type= override, then content-type
// header, then URL extension, then magic bytes. DOCX is a ZIP (PK…) — a
// generic ZIP with no docx hint is still attempted as DOCX; mammoth errors
// cleanly if it isn't one. Returns "pdf" | "docx" | "csv" | null.
function sniffDocType(buf, contentType = "", urlPath = "", override = "") {
  const t = String(override || "").toLowerCase();
  if (["pdf", "docx", "csv"].includes(t)) return t;
  const ct = String(contentType).toLowerCase();
  const ext = (String(urlPath).match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || "";
  if (ct.includes("application/pdf") || ext === "pdf") return "pdf";
  if (ct.includes("wordprocessingml") || ext === "docx") return "docx";
  if (ct.includes("text/csv") || ct.includes("application/csv") || ext === "csv" || ext === "tsv") return "csv";
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (buf[0] === 0x50 && buf[1] === 0x4b) return "docx"; // ZIP container
  // Plausible CSV: printable text whose first line has a delimiter.
  const head = buf.subarray(0, 2048).toString("utf8");
  const firstLine = head.split(/\r?\n/)[0] || "";
  if (/[,;\t]/.test(firstLine) && !/[\x00-\x08\x0e-\x1f]/.test(head)) return "csv";
  return null;
}

async function extractPdf(buf) {
  if (!unpdfLib) { const e = new Error("PDF parser not available on this deployment"); e.code = "no_parser"; throw e; }
  // new Uint8Array(buffer) copies — pdf.js detaches the buffer it's given,
  // so each call gets its own copy.
  const { totalPages, text } = await unpdfLib.extractText(new Uint8Array(buf), { mergePages: false });
  let metadata = {};
  try {
    const m = await unpdfLib.getMeta(new Uint8Array(buf));
    metadata = { title: m.info?.Title || null, author: m.info?.Author || null, created: m.info?.CreationDate || null };
  } catch { /* metadata is best-effort */ }
  const pages = (text || []).map((p) => String(p || "").trim());
  const totalChars = pages.reduce((n, p) => n + p.length, 0);
  // Scanned/image-only PDFs extract essentially nothing. Keep the threshold
  // low (~5 chars/page) so legitimately sparse text PDFs aren't misflagged.
  const ocrRequired = totalPages > 0 && totalChars / totalPages < 5;
  const markdown = totalPages > 1
    ? pages.map((p, i) => `## Page ${i + 1}\n\n${p}`).join("\n\n")
    : pages.join("\n\n");
  return {
    type: "pdf", pages: totalPages, metadata, markdown,
    word_count: markdown.split(/\s+/).filter(Boolean).length,
    ...(ocrRequired ? { ocr_required: true, note: "This PDF has little or no text layer (likely scanned images). It needs OCR, which this endpoint does not perform." } : {}),
  };
}

async function extractDocx(buf) {
  if (!mammothLib) { const e = new Error("DOCX parser not available on this deployment"); e.code = "no_parser"; throw e; }
  const result = await mammothLib.convertToHtml({ buffer: buf });
  const markdown = turndown.turndown(result.value || "");
  return {
    type: "docx", markdown,
    word_count: markdown.split(/\s+/).filter(Boolean).length,
    ...(result.messages?.length ? { conversion_warnings: result.messages.slice(0, 10).map((m) => m.message) } : {}),
  };
}

function extractCsv(buf, { maxRows = 1000 } = {}) {
  if (!csvParseFn) { const e = new Error("CSV parser not available on this deployment"); e.code = "no_parser"; throw e; }
  const body = buf.toString("utf8");
  // Pick the delimiter that dominates the header line (supports TSV and
  // semicolon-delimited European exports).
  const firstLine = body.split(/\r?\n/)[0] || "";
  const delimiter = [",", ";", "\t"].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best, ",");
  const records = csvParseFn(body, {
    columns: true, bom: true, delimiter,
    skip_empty_lines: true, relax_column_count: true, relax_quotes: true, trim: true,
  });
  const columns = records.length ? Object.keys(records[0]) : [];
  // Cheap type inference over a sample so agents know what they're getting.
  const sample = records.slice(0, 200);
  const columnInfo = columns.map((name) => {
    let numeric = 0, empty = 0;
    for (const r of sample) {
      const v = String(r[name] ?? "").trim();
      if (!v) empty++;
      else if (!Number.isNaN(Number(v))) numeric++;
    }
    const filled = sample.length - empty;
    return { name, type: filled > 0 && numeric === filled ? "number" : "string", empty_in_sample: empty };
  });
  const rows = records.slice(0, maxRows);
  // Markdown preview: at most 30 rows, and never more than the caller's
  // max_rows — asking for 5 JSON rows shouldn't return a 30-row table.
  const mdRows = records.slice(0, Math.min(30, maxRows));
  const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const markdown = columns.length
    ? [
        `| ${columns.map(esc).join(" | ")} |`,
        `| ${columns.map(() => "---").join(" | ")} |`,
        ...mdRows.map((r) => `| ${columns.map((c) => esc(r[c])).join(" | ")} |`),
      ].join("\n")
    : "";
  return {
    type: "csv", delimiter: delimiter === "\t" ? "tab" : delimiter,
    columns: columnInfo, row_count: records.length,
    rows_returned: rows.length, truncated: records.length > rows.length,
    rows, markdown, markdown_rows: mdRows.length,
  };
}

// ----------------------------------------------------------------------------
// FONT AWESOME ICON ENGINE. Loads the Free icon set's path data + official
// search terms from @fortawesome/fontawesome-free metadata at boot (no runtime
// calls to Font Awesome). Free set is CC BY 4.0 — responses carry attribution.
// ----------------------------------------------------------------------------
let FA_ICONS = null; // Map name -> { name, label, terms, styles: { solid: {path,w,h}, ... } }
// NOTE: the @fortawesome/fontawesome-free npm package does NOT include the
// metadata JSON (stripped from the npm dist — FortAwesome/Font-Awesome#16733),
// so the metadata is fetched at boot: self-hosted copy first, GitHub raw as
// fallback, both pinned to 6.5.2.
try {
  const FA_SOURCES = [
    ["self-hosted (x402.webbersites.com)", "https://x402.webbersites.com/fa/icons.json"],
    ["GitHub raw (pinned 6.5.2)", "https://raw.githubusercontent.com/FortAwesome/Font-Awesome/6.5.2/metadata/icons.json"],
  ];
  let raw = null, loadedVia = null, lastErr = null;
  for (const [label, srcUrl] of FA_SOURCES) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20_000);
      const r = await fetch(srcUrl, { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error(`${label} returned ${r.status}`);
      raw = await r.json();
      loadedVia = label;
      break;
    } catch (err) { lastErr = err; }
  }
  if (!raw) throw lastErr || new Error("no icon metadata source reachable");
  FA_ICONS = new Map();
  for (const [name, d] of Object.entries(raw)) {
    const styles = {};
    for (const [style, s] of Object.entries(d.svg || {})) {
      const p = Array.isArray(s.path) ? s.path.join(" ") : s.path;
      if (!p) continue;
      styles[style] = { path: p, w: s.viewBox?.[2] ?? 512, h: s.viewBox?.[3] ?? 512 };
    }
    if (Object.keys(styles).length) {
      FA_ICONS.set(name, { name, label: d.label || name, terms: (d.search?.terms || []).map(String), styles });
    }
  }
  console.log(`✓ Font Awesome Free loaded (${FA_ICONS.size} icons) via ${loadedVia}`);
} catch (e) {
  console.warn("⚠ fontawesome metadata unavailable — /api/icon endpoints disabled:", String(e.message || e));
  console.warn("  (is icons.json uploaded to x402.webbersites.com/fa/icons.json?)");
}

function faSearch(q, style) {
  const query = String(q).toLowerCase().trim();
  const tokens = query.split(/[\s-]+/).filter(Boolean);
  const scored = [];
  for (const icon of FA_ICONS.values()) {
    if (style && !icon.styles[style]) continue;
    let score = 0;
    if (icon.name === query) score = 100;
    else if (icon.label.toLowerCase() === query) score = 90;
    else if (icon.terms.includes(query)) score = 70;
    else if (icon.name.includes(query)) score = 55 + Math.round((query.length / icon.name.length) * 20);
    else if (icon.label.toLowerCase().includes(query)) score = 45;
    const hits = tokens.filter((t) => icon.name.includes(t) || icon.terms.some((x) => x.includes(t))).length;
    score += hits * 8;
    if (score > 0) scored.push({ icon, score });
  }
  scored.sort((a, b) => b.score - a.score || a.icon.name.length - b.icon.name.length);
  return scored.slice(0, 12);
}

const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
function buildIconSvg(glyph, { size = 1024, colors = ["#0d0e11"], fg = null, shape = "squircle", padding = 0.18 }) {
  const bgColors = (Array.isArray(colors) ? colors : [colors]).filter((c) => HEX_RE.test(String(c))).slice(0, 2);
  if (!bgColors.length) bgColors.push("#0d0e11");
  if (!HEX_RE.test(String(fg))) fg = shape === "transparent" ? "#0d0e11" : "#ffffff";
  padding = Math.min(0.35, Math.max(0.05, Number(padding) || 0.18));
  const transparent = shape === "transparent";
  const radius = shape === "circle" ? size / 2 : shape === "square" ? 0
    : shape === "rounded" ? Math.round(size * 0.12) : Math.round(size * 0.225); // squircle-ish (iOS ~22.5%)
  const content = size * (1 - 2 * padding);
  const scale = Math.min(content / glyph.w, content / glyph.h);
  const tx = (size - glyph.w * scale) / 2;
  const ty = (size - glyph.h * scale) / 2;
  const bg = transparent ? ""
    : bgColors.length === 2
    ? `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bgColors[0]}"/><stop offset="1" stop-color="${bgColors[1]}"/></linearGradient></defs><rect width="${size}" height="${size}" rx="${radius}" fill="url(#bg)"/>`
    : `<rect width="${size}" height="${size}" rx="${radius}" fill="${bgColors[0]}"/>`;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  ${bg}
  <g transform="translate(${tx.toFixed(2)},${ty.toFixed(2)}) scale(${scale.toFixed(5)})"><path d="${glyph.path}" fill="${fg}"/></g>
</svg>`;
}

// ----------------------------------------------------------------------------
// LOGO ENGINE. Composes a Font Awesome mark + company name (+ tagline) into a
// finished logo (SVG + PNG). Text is rendered as vector paths via opentype.js
// with a curated pool of OFL fonts fetched at boot (self-hosted copy first,
// Google Fonts CDN as fallback) — no system fonts needed, identical output on
// any host. Loaded defensively: if fonts or opentype are unavailable the
// /api/logo/generate route 503s and everything else keeps running.
// ----------------------------------------------------------------------------
let opentypeLib = null;
try { const m = await import("opentype.js"); opentypeLib = m.default || m; } catch (e) { console.warn("⚠ opentype.js not loaded — logo endpoint disabled:", e.message); }

const LOGO_FONTS = {
  "montserrat":    { label: "Montserrat Bold",       file: "montserrat-bold.ttf",        fallback: "https://fonts.gstatic.com/s/montserrat/v31/JTUHjIg1_i6t8kCHKm4532VJOt5-QNFgpCuM70w-.ttf" },
  "playfair":      { label: "Playfair Display Bold", file: "playfair-display-bold.ttf",  fallback: "https://fonts.gstatic.com/s/playfairdisplay/v40/nuFvD-vYSZviVYUb_rj3ij__anPXJzDwcbmjWBN2PKeiukDQ.ttf" },
  "space-grotesk": { label: "Space Grotesk Bold",    file: "space-grotesk-bold.ttf",     fallback: "https://fonts.gstatic.com/s/spacegrotesk/v22/V8mQoQDjQSkFtoMM3T6r8E7mF71Q-gOoraIAEj4PVksj.ttf" },
  "bebas":         { label: "Bebas Neue",            file: "bebas-neue.ttf",             fallback: "https://fonts.gstatic.com/s/bebasneue/v16/JTUSjIg69CK48gW7PXooxW4.ttf" },
  "poppins":       { label: "Poppins SemiBold",      file: "poppins-semibold.ttf",       fallback: "https://fonts.gstatic.com/s/poppins/v24/pxiByp8kv8JHgFVrLEj6V1s.ttf" },
  "dm-serif":      { label: "DM Serif Display",      file: "dm-serif-display.ttf",       fallback: "https://fonts.gstatic.com/s/dmserifdisplay/v17/-nFnOHM81r4j6k0gjAW3mujVU2B2K_c.ttf" },
};

if (opentypeLib) {
  await Promise.all(Object.entries(LOGO_FONTS).map(async ([key, f]) => {
    for (const url of [`https://x402.webbersites.com/fonts/${f.file}`, f.fallback]) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 20_000);
        const r = await fetch(url, { signal: ctrl.signal });
        clearTimeout(t);
        if (!r.ok) throw new Error(`${r.status}`);
        f.font = opentypeLib.parse(await r.arrayBuffer());
        return;
      } catch { /* try next source */ }
    }
    console.warn(`⚠ logo font "${key}" failed to load from all sources`);
  }));
  const loaded = Object.values(LOGO_FONTS).filter((f) => f.font).length;
  console.log(loaded ? `✓ Logo fonts loaded (${loaded}/${Object.keys(LOGO_FONTS).length})` : "⚠ No logo fonts loaded — logo endpoint disabled");
}
const logoFontsReady = () => Object.values(LOGO_FONTS).some((f) => f.font);

// CSS named colors (full CSS3 set) so agents can say "navy" or "coral".
const CSS_COLORS = { aliceblue:"#f0f8ff",antiquewhite:"#faebd7",aqua:"#00ffff",aquamarine:"#7fffd4",azure:"#f0ffff",beige:"#f5f5dc",bisque:"#ffe4c4",black:"#000000",blanchedalmond:"#ffebcd",blue:"#0000ff",blueviolet:"#8a2be2",brown:"#a52a2a",burlywood:"#deb887",cadetblue:"#5f9ea0",chartreuse:"#7fff00",chocolate:"#d2691e",coral:"#ff7f50",cornflowerblue:"#6495ed",cornsilk:"#fff8dc",crimson:"#dc143c",cyan:"#00ffff",darkblue:"#00008b",darkcyan:"#008b8b",darkgoldenrod:"#b8860b",darkgray:"#a9a9a9",darkgreen:"#006400",darkgrey:"#a9a9a9",darkkhaki:"#bdb76b",darkmagenta:"#8b008b",darkolivegreen:"#556b2f",darkorange:"#ff8c00",darkorchid:"#9932cc",darkred:"#8b0000",darksalmon:"#e9967a",darkseagreen:"#8fbc8f",darkslateblue:"#483d8b",darkslategray:"#2f4f4f",darkslategrey:"#2f4f4f",darkturquoise:"#00ced1",darkviolet:"#9400d3",deeppink:"#ff1493",deepskyblue:"#00bfff",dimgray:"#696969",dimgrey:"#696969",dodgerblue:"#1e90ff",firebrick:"#b22222",floralwhite:"#fffaf0",forestgreen:"#228b22",fuchsia:"#ff00ff",gainsboro:"#dcdcdc",ghostwhite:"#f8f8ff",gold:"#ffd700",goldenrod:"#daa520",gray:"#808080",green:"#008000",greenyellow:"#adff2f",grey:"#808080",honeydew:"#f0fff0",hotpink:"#ff69b4",indianred:"#cd5c5c",indigo:"#4b0082",ivory:"#fffff0",khaki:"#f0e68c",lavender:"#e6e6fa",lavenderblush:"#fff0f5",lawngreen:"#7cfc00",lemonchiffon:"#fffacd",lightblue:"#add8e6",lightcoral:"#f08080",lightcyan:"#e0ffff",lightgoldenrodyellow:"#fafad2",lightgray:"#d3d3d3",lightgreen:"#90ee90",lightgrey:"#d3d3d3",lightpink:"#ffb6c1",lightsalmon:"#ffa07a",lightseagreen:"#20b2aa",lightskyblue:"#87cefa",lightslategray:"#778899",lightslategrey:"#778899",lightsteelblue:"#b0c4de",lightyellow:"#ffffe0",lime:"#00ff00",limegreen:"#32cd32",linen:"#faf0e6",magenta:"#ff00ff",maroon:"#800000",mediumaquamarine:"#66cdaa",mediumblue:"#0000cd",mediumorchid:"#ba55d3",mediumpurple:"#9370db",mediumseagreen:"#3cb371",mediumslateblue:"#7b68ee",mediumspringgreen:"#00fa9a",mediumturquoise:"#48d1cc",mediumvioletred:"#c71585",midnightblue:"#191970",mintcream:"#f5fffa",mistyrose:"#ffe4e1",moccasin:"#ffe4b5",navajowhite:"#ffdead",navy:"#000080",oldlace:"#fdf5e6",olive:"#808000",olivedrab:"#6b8e23",orange:"#ffa500",orangered:"#ff4500",orchid:"#da70d6",palegoldenrod:"#eee8aa",palegreen:"#98fb98",paleturquoise:"#afeeee",palevioletred:"#db7093",papayawhip:"#ffefd5",peachpuff:"#ffdab9",peru:"#cd853f",pink:"#ffc0cb",plum:"#dda0dd",powderblue:"#b0e0e6",purple:"#800080",rebeccapurple:"#663399",red:"#ff0000",rosybrown:"#bc8f8f",royalblue:"#4169e1",saddlebrown:"#8b4513",salmon:"#fa8072",sandybrown:"#f4a460",seagreen:"#2e8b57",seashell:"#fff5ee",sienna:"#a0522d",silver:"#c0c0c0",skyblue:"#87ceeb",slateblue:"#6a5acd",slategray:"#708090",slategrey:"#708090",snow:"#fffafa",springgreen:"#00ff7f",steelblue:"#4682b4",tan:"#d2b48c",teal:"#008080",thistle:"#d8bfd8",tomato:"#ff6347",turquoise:"#40e0d0",violet:"#ee82ee",wheat:"#f5deb3",white:"#ffffff",whitesmoke:"#f5f5f5",yellow:"#ffff00",yellowgreen:"#9acd32" };

function resolveColor(c) {
  const s = String(c || "").trim().toLowerCase();
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/.test(s)) return s;
  return CSS_COLORS[s] || null;
}

// Text layout, composed PER GLYPH with manual advances. We avoid
// font.getPath(string): opentype.js's substitution lookups emit NaN
// coordinates for some character runs in some fonts, which silently kills the
// whole path in librsvg. Single glyphs are clean, so we place them ourselves.
function layoutLogoText(font, text, fontSize, letterSpacing = 0) {
  const scale = fontSize / font.unitsPerEm;
  const parts = [];
  let x = 0, prev = null;
  for (const ch of text) {
    const glyph = font.charToGlyph(ch);
    if (prev) {
      const kern = font.getKerningValue(prev, glyph);
      if (Number.isFinite(kern)) x += kern * scale;
    }
    parts.push({ glyph, x });
    x += (Number.isFinite(glyph.advanceWidth) ? glyph.advanceWidth : font.unitsPerEm * 0.5) * scale + letterSpacing * fontSize;
    prev = glyph;
  }
  return { parts, advance: x - (text.length ? letterSpacing * fontSize : 0) };
}

function logoTextPath(font, text, x, y, fontSize, fill, { letterSpacing = 0, opacity = null, anchor = "start" } = {}) {
  const { parts, advance: adv } = layoutLogoText(font, text, fontSize, letterSpacing);
  if (anchor === "middle") x -= adv / 2;
  // Round coords to 3dp before getPath: float-noise inputs (y=338.90000000000003)
  // trigger a NaN bug in opentype.js curve conversion for some glyphs. If NaN
  // still appears, retry on integer coords; only then give up on the glyph.
  const gy = Math.round(y * 1000) / 1000;
  const ds = [];
  for (const p of parts) {
    const gx = Math.round((x + p.x) * 1000) / 1000;
    let d = p.glyph.getPath(gx, gy, fontSize).toPathData(2);
    if (d.includes("NaN")) d = p.glyph.getPath(Math.round(gx), Math.round(gy), fontSize).toPathData(2);
    if (d && !d.includes("NaN")) ds.push(d);
  }
  return `<path d="${ds.join(" ")}" fill="${fill}"${opacity ? ` opacity="${opacity}"` : ""}/>`;
}
const logoAdvance = (font, text, fontSize, letterSpacing = 0) => layoutLogoText(font, text, fontSize, letterSpacing).advance;

// The icon-on-shape mark as a positioned group (same geometry as buildIconSvg).
function logoMarkGroup(glyph, { size, x, y, bgColors, fg, shape, gradId }) {
  const transparent = shape === "transparent";
  const radius = shape === "circle" ? size / 2 : shape === "square" ? 0
    : shape === "rounded" ? Math.round(size * 0.12) : Math.round(size * 0.225);
  const padding = 0.18;
  const content = size * (1 - 2 * padding);
  const scale = Math.min(content / glyph.w, content / glyph.h);
  const tx = x + (size - glyph.w * scale) / 2;
  const ty = y + (size - glyph.h * scale) / 2;
  const bg = transparent ? ""
    : bgColors.length === 2
    ? `<defs><linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bgColors[0]}"/><stop offset="1" stop-color="${bgColors[1]}"/></linearGradient></defs><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${radius}" fill="url(#${gradId})"/>`
    : `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${radius}" fill="${bgColors[0]}"/>`;
  return `${bg}<g transform="translate(${tx.toFixed(2)},${ty.toFixed(2)}) scale(${scale.toFixed(5)})"><path d="${glyph.path}" fill="${fg}"/></g>`;
}

// Compose mark + company name (+ tagline) into a finished logo.
// layout: bottom|top (stacked, square canvas) or right|left (horizontal).
// colors: 1-3 resolved hex — [0] brand (mark bg, or glyph when transparent),
//         [1] gradient partner, [2] text color override (default: colors[0]).
function buildLogoSvg({ name, tagline, glyph, layout = "bottom", shape = "squircle", colors, fg = null, fontEntry, bg = null }) {
  const font = fontEntry.font;
  const transparent = shape === "transparent";
  const c0 = colors[0], c1 = colors[1] || null, cText = colors[2] || c0;
  const bgColors = c1 ? [c0, c1] : [c0];
  const glyphColor = fg || (transparent ? c0 : "#ffffff");
  const upm = font.unitsPerEm;
  const capH = (font.tables?.os2?.sCapHeight || font.ascender * 0.72) / upm;
  const stacked = layout === "top" || layout === "bottom";
  const TAG_LS = 0.14; // tagline letter-spacing (em)

  let W, H;
  const parts = [];
  if (stacked) {
    const S = 1024; W = H = S;
    const mark = Math.round(S * 0.40);
    let nameFs = S * 0.115;
    const maxW = S * 0.88;
    const nAdv = logoAdvance(font, name, nameFs);
    if (nAdv > maxW) nameFs *= maxW / nAdv;
    nameFs = Math.max(40, nameFs);
    let tagFs = 0, tagAdv = 0;
    if (tagline) {
      tagFs = Math.max(24, Math.min(nameFs * 0.34, 42));
      tagAdv = logoAdvance(font, tagline, tagFs, TAG_LS);
      if (tagAdv > maxW) { tagFs *= maxW / tagAdv; tagAdv = maxW; }
    }
    const nameH = nameFs * capH, tagH = tagline ? tagFs * capH : 0;
    const gapM = S * 0.075, gapT = tagline ? S * 0.038 : 0;
    const total = mark + gapM + nameH + gapT + tagH;
    const yCur = (S - total) / 2;
    const cx = S / 2;
    const markY = layout === "bottom" ? yCur : yCur + nameH + gapT + tagH + gapM;
    const textTop = layout === "bottom" ? yCur + mark + gapM : yCur;
    parts.push(logoMarkGroup(glyph, { size: mark, x: cx - mark / 2, y: markY, bgColors, fg: glyphColor, shape, gradId: "mg" }));
    parts.push(logoTextPath(font, name, cx, textTop + nameH, nameFs, cText, { anchor: "middle" }));
    if (tagline) parts.push(logoTextPath(font, tagline, cx, textTop + nameH + gapT + tagH, tagFs, cText, { letterSpacing: TAG_LS, opacity: 0.72, anchor: "middle" }));
  } else {
    // horizontal lockup: right = text right of mark; left = text left of mark
    H = 512;
    const mark = 300, pad = 84, gap = 64;
    let nameFs = 148;
    const capText = 1500;
    let nAdv = logoAdvance(font, name, nameFs);
    if (nAdv > capText) nameFs *= capText / nAdv;
    nameFs = Math.max(56, nameFs);
    nAdv = logoAdvance(font, name, nameFs);
    let tagFs = 0, tagAdv = 0;
    if (tagline) {
      tagFs = Math.max(26, Math.min(nameFs * 0.32, 46));
      tagAdv = logoAdvance(font, tagline, tagFs, TAG_LS);
    }
    const textW = Math.ceil(Math.max(nAdv, tagAdv));
    W = pad + mark + gap + textW + pad;
    const markX = layout === "right" ? pad : W - pad - mark;
    const textX = layout === "right" ? pad + mark + gap : pad;
    const markY = (H - mark) / 2;
    const nameH = nameFs * capH, tagH = tagline ? tagFs * capH : 0;
    const gapT = tagline ? 30 : 0;
    const blockH = nameH + gapT + tagH;
    const textTop = (H - blockH) / 2;
    parts.push(logoMarkGroup(glyph, { size: mark, x: markX, y: markY, bgColors, fg: glyphColor, shape, gradId: "mg" }));
    parts.push(logoTextPath(font, name, textX, textTop + nameH, nameFs, cText));
    if (tagline) parts.push(logoTextPath(font, tagline, textX, textTop + nameH + gapT + tagH, tagFs, cText, { letterSpacing: TAG_LS, opacity: 0.72 }));
  }

  const bgRect = bg ? `<rect width="${Math.round(W)}" height="${Math.round(H)}" fill="${bg}"/>` : "";
  const svg = `<svg width="${Math.round(W)}" height="${Math.round(H)}" viewBox="0 0 ${Math.round(W)} ${Math.round(H)}" xmlns="http://www.w3.org/2000/svg">\n${bgRect}${parts.join("\n")}\n</svg>`;
  return { svg, width: Math.round(W), height: Math.round(H) };
}

// ----------------------------------------------------------------------------
// WEBBIE PAGE ENGINE. Deterministic homepage/page generator — no AI, just a
// template registry (3 to start; add more to WEBBIE_TEMPLATES) with seeded
// style variation. The SEED is the site identity: it picks template, font
// pairing, and accent hue, so multiple requests with the same seed produce
// pages that look like one site. Navigation renders inline AND from a
// runtime-fetched nav.json, so menus can be updated after generation without
// touching the pages.
// ----------------------------------------------------------------------------
function webbieEsc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// Only allow safe link/image targets (http(s), relative paths, anchors).
function webbieSafeHref(u) {
  const s = String(u || "").trim();
  if (!s) return null;
  if (/^(https?:)?\/\//i.test(s) || /^[/#.]/.test(s) || /^[a-z0-9_-]+(\.html?)?$/i.test(s)) return s;
  return null;
}
function webbieSafeImg(u) {
  const s = String(u || "").trim();
  return /^https?:\/\//i.test(s) ? s : null;
}
// String -> uint32 hash (FNV-1a) -> deterministic picks.
function webbieHash(str) {
  let h = 0x811c9dc5;
  for (const ch of String(str)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

const WEBBIE_FONT_PAIRS = [
  { display: "Fraunces", body: "Inter", link: "family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600" },
  { display: "Playfair Display", body: "Poppins", link: "family=Playfair+Display:wght@600;700&family=Poppins:wght@400;500;600" },
  { display: "Space Grotesk", body: "Inter", link: "family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500;600" },
  { display: "DM Serif Display", body: "Montserrat", link: "family=DM+Serif+Display&family=Montserrat:wght@400;500;600" },
  { display: "Montserrat", body: "Inter", link: "family=Montserrat:wght@600;800&family=Inter:wght@400;500;600" },
];
const WEBBIE_TEMPLATE_KEYS = ["horizon", "split", "editorial"];

// Shared page pieces -----------------------------------------------------------
function webbieNav({ siteName, logoHtml, nav, pageFile, accent }) {
  const links = (nav || []).map((l) => {
    const href = webbieSafeHref(l.href) || "#";
    const active = href === pageFile ? ' class="active"' : "";
    return `<a href="${webbieEsc(href)}"${active}>${webbieEsc(l.label || href)}</a>`;
  }).join("");
  return `<header class="nav"><a class="brand" href="index.html">${logoHtml}<span>${webbieEsc(siteName)}</span></a><nav id="site-nav" data-page="${webbieEsc(pageFile)}">${links}</nav></header>`;
}
// Runtime nav loader: fetches nav.json next to the page; DOM-built (no
// innerHTML of remote strings), silently keeps the inline fallback on failure.
const WEBBIE_NAV_SCRIPT = `<script>
(function(){
  fetch("nav.json").then(function(r){return r.ok?r.json():null}).then(function(nav){
    if(!nav||!Array.isArray(nav.links))return;
    var el=document.getElementById("site-nav");if(!el)return;
    var page=el.getAttribute("data-page");el.textContent="";
    nav.links.forEach(function(l){var a=document.createElement("a");a.href=String(l.href||"#");a.textContent=String(l.label||l.href||"");if(l.href===page)a.className="active";el.appendChild(a);});
  }).catch(function(){});
})();
</script>`;

function webbieSections(content, accent) {
  return (content || []).map((sec, i) => {
    const paras = String(sec.body || "").split(/\n\s*\n/).filter(Boolean)
      .map((p) => `<p>${webbieEsc(p.trim())}</p>`).join("");
    return `<section class="block${i % 2 ? " alt" : ""}"><div class="wrap">${sec.heading ? `<h2>${webbieEsc(sec.heading)}</h2>` : ""}${paras}</div></section>`;
  }).join("\n");
}
function webbieGallery(images) {
  if (!images.length) return "";
  return `<section class="block"><div class="wrap gallery">${images.map((u) => `<img src="${webbieEsc(u)}" alt="" loading="lazy">`).join("")}</div></section>`;
}
function webbieFooter(siteName, footerText) {
  return `<footer><div class="wrap"><span>${webbieEsc(footerText || `© ${siteName}`)}</span><span class="made">Made with Webbie</span></div></footer>`;
}
function webbieCta(cta, cls = "cta") {
  if (!cta?.text) return "";
  const href = webbieSafeHref(cta.href) || "#";
  return `<a class="${cls}" href="${webbieEsc(href)}">${webbieEsc(cta.text)}</a>`;
}

// Template renderers. Each returns full <body> inner HTML; shared CSS vars
// (accent, fonts) come from the style computed off the seed.
const WEBBIE_TEMPLATES = {
  // Full-bleed hero image with overlay text. Wants a hero image; falls back
  // to a seeded gradient when none is given.
  horizon({ p, style }) {
    const heroBg = p.heroImages[0]
      ? `background-image:linear-gradient(rgba(10,10,14,0.45),rgba(10,10,14,0.78)),url('${webbieEsc(p.heroImages[0])}');background-size:cover;background-position:center;`
      : `background:linear-gradient(135deg,${style.accent},${style.accent2});`;
    return {
      css: `
.nav{position:absolute;top:0;left:0;right:0;z-index:5;display:flex;justify-content:space-between;align-items:center;padding:22px clamp(20px,5vw,60px);color:#fff}
.nav nav a{color:rgba(255,255,255,0.85);margin-left:26px;font-size:14px;text-decoration:none}
.nav nav a:hover,.nav nav a.active{color:#fff;border-bottom:2px solid var(--accent)}
.hero{min-height:88vh;display:flex;align-items:center;justify-content:center;text-align:center;color:#fff;${heroBg}}
.hero .inner{max-width:820px;padding:120px 24px 80px}
.hero .caption{font-size:13px;letter-spacing:0.24em;text-transform:uppercase;color:var(--accent-soft);margin-bottom:18px}
.hero h1{font-family:var(--display);font-size:clamp(40px,6.5vw,76px);line-height:1.06;margin-bottom:22px;font-weight:600}
.hero .tagline{font-size:clamp(16px,2vw,21px);color:rgba(255,255,255,0.85);line-height:1.7;max-width:640px;margin:0 auto 34px}
.cta{display:inline-block;background:var(--accent);color:#fff;padding:15px 36px;border-radius:10px;font-weight:600;text-decoration:none;font-size:15px}
.cta:hover{filter:brightness(1.1)}
.block{padding:clamp(56px,9vh,110px) 24px}
.block.alt{background:var(--wash)}
.block h2{font-family:var(--display);font-size:clamp(24px,3vw,36px);margin-bottom:16px}
.block p{color:var(--muted);line-height:1.85;margin-bottom:14px;max-width:70ch}`,
      body: `${webbieNav(p)}<div class="hero"><div class="inner">${p.caption ? `<div class="caption">${webbieEsc(p.caption)}</div>` : ""}<h1>${webbieEsc(p.headline)}</h1>${p.tagline ? `<p class="tagline">${webbieEsc(p.tagline)}</p>` : ""}${webbieCta(p.cta)}</div></div>${webbieSections(p.content)}${webbieGallery(p.heroImages.slice(1))}${webbieFooter(p.siteName, p.footerText)}`,
    };
  },

  // Split hero: text left, image right, light background.
  split({ p, style }) {
    const img = p.heroImages[0]
      ? `<div class="hero-img"><img src="${webbieEsc(p.heroImages[0])}" alt=""></div>`
      : `<div class="hero-img"><div class="ph" style="background:linear-gradient(135deg,${style.accent},${style.accent2})"></div></div>`;
    return {
      css: `
body{background:#fbfaf7;color:#17181c}
.nav{display:flex;justify-content:space-between;align-items:center;padding:20px clamp(20px,5vw,60px);border-bottom:1px solid rgba(0,0,0,0.07)}
.nav nav a{color:#555;margin-left:26px;font-size:14px;text-decoration:none}
.nav nav a:hover,.nav nav a.active{color:var(--accent)}
.hero{display:grid;grid-template-columns:1.05fr 0.95fr;gap:clamp(30px,5vw,70px);align-items:center;max-width:1180px;margin:0 auto;padding:clamp(48px,9vh,110px) 24px}
.hero .caption{font-size:13px;letter-spacing:0.22em;text-transform:uppercase;color:var(--accent);margin-bottom:16px;font-weight:600}
.hero h1{font-family:var(--display);font-size:clamp(34px,5vw,60px);line-height:1.1;margin-bottom:20px}
.hero .tagline{font-size:17px;color:#585a60;line-height:1.8;margin-bottom:30px}
.hero-img img,.hero-img .ph{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:18px;box-shadow:0 24px 60px rgba(0,0,0,0.14)}
.cta{display:inline-block;background:var(--accent);color:#fff;padding:14px 34px;border-radius:10px;font-weight:600;text-decoration:none;font-size:15px}
.cta:hover{filter:brightness(1.08)}
.block{padding:clamp(48px,8vh,96px) 24px}
.block.alt{background:#f1efe9}
.block h2{font-family:var(--display);font-size:clamp(24px,3vw,34px);margin-bottom:14px}
.block p{color:#585a60;line-height:1.85;margin-bottom:14px;max-width:70ch}
@media(max-width:840px){.hero{grid-template-columns:1fr}.hero-img{order:-1}}`,
      body: `${webbieNav(p)}<div class="hero"><div>${p.caption ? `<div class="caption">${webbieEsc(p.caption)}</div>` : ""}<h1>${webbieEsc(p.headline)}</h1>${p.tagline ? `<p class="tagline">${webbieEsc(p.tagline)}</p>` : ""}${webbieCta(p.cta)}</div>${img}</div>${webbieSections(p.content)}${webbieGallery(p.heroImages.slice(1))}${webbieFooter(p.siteName, p.footerText)}`,
    };
  },

  // Typography-led dark editorial page; hero image optional (renders as a
  // framed banner under the headline when present).
  editorial({ p, style }) {
    const banner = p.heroImages[0] ? `<div class="banner"><img src="${webbieEsc(p.heroImages[0])}" alt=""></div>` : "";
    return {
      css: `
body{background:#0e0f13;color:#f2efe8}
.nav{display:flex;justify-content:space-between;align-items:center;padding:20px clamp(20px,5vw,60px);border-bottom:1px solid rgba(242,239,232,0.1)}
.nav nav a{color:rgba(242,239,232,0.65);margin-left:26px;font-size:13.5px;text-decoration:none}
.nav nav a:hover,.nav nav a.active{color:var(--accent-soft)}
.hero{max-width:900px;margin:0 auto;padding:clamp(64px,11vh,130px) 24px clamp(36px,6vh,64px);text-align:left}
.hero .caption{font-size:12px;letter-spacing:0.28em;text-transform:uppercase;color:var(--accent-soft);margin-bottom:20px}
.hero h1{font-family:var(--display);font-size:clamp(38px,6vw,68px);line-height:1.08;margin-bottom:24px}
.hero .tagline{font-size:clamp(16px,1.8vw,20px);color:rgba(242,239,232,0.7);line-height:1.8;max-width:56ch;margin-bottom:32px}
.banner{max-width:1100px;margin:0 auto;padding:0 24px}
.banner img{width:100%;border-radius:14px;border:1px solid rgba(242,239,232,0.12)}
.cta{display:inline-block;border:1.5px solid var(--accent);color:var(--accent-soft);padding:13px 32px;border-radius:999px;font-weight:600;text-decoration:none;font-size:14px}
.cta:hover{background:var(--accent);color:#0e0f13}
.block{padding:clamp(48px,8vh,96px) 24px}
.block .wrap{max-width:820px}
.block.alt{background:#12141a}
.block h2{font-family:var(--display);font-size:clamp(22px,2.8vw,32px);margin-bottom:14px;color:#f2efe8}
.block p{color:rgba(242,239,232,0.68);line-height:1.9;margin-bottom:14px}`,
      body: `${webbieNav(p)}<div class="hero">${p.caption ? `<div class="caption">${webbieEsc(p.caption)}</div>` : ""}<h1>${webbieEsc(p.headline)}</h1>${p.tagline ? `<p class="tagline">${webbieEsc(p.tagline)}</p>` : ""}${webbieCta(p.cta)}</div>${banner}${webbieSections(p.content)}${webbieGallery(p.heroImages.slice(1))}${webbieFooter(p.siteName, p.footerText)}`,
    };
  },
};

function buildWebbiePage(p) {
  const h = webbieHash(p.seed);
  const template = WEBBIE_TEMPLATES[p.template] ? p.template : WEBBIE_TEMPLATE_KEYS[h % WEBBIE_TEMPLATE_KEYS.length];
  const fonts = WEBBIE_FONT_PAIRS[(h >>> 3) % WEBBIE_FONT_PAIRS.length];
  const hue = h % 360;
  const accent = p.colors[0] || `hsl(${hue},72%,52%)`;
  const accent2 = p.colors[1] || (p.colors[0] ? p.colors[0] : `hsl(${(hue + 40) % 360},70%,42%)`);
  const accentSoft = p.colors[0] || `hsl(${hue},80%,66%)`;
  const style = { accent, accent2, accentSoft, fonts };

  const { css, body } = WEBBIE_TEMPLATES[template]({ p, style });
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${webbieEsc(p.title)}</title>
${p.tagline ? `<meta name="description" content="${webbieEsc(p.tagline)}">` : ""}
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?${fonts.link}&display=swap" rel="stylesheet">
<style>
:root{--accent:${accent};--accent-soft:${accentSoft};--display:'${fonts.display}',serif;--body:'${fonts.body}',system-ui,sans-serif;--muted:#585a60;--wash:#f5f3ee}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:var(--body);font-size:16px;line-height:1.7;-webkit-font-smoothing:antialiased}
.brand{display:flex;align-items:center;gap:11px;font-family:var(--display);font-size:19px;text-decoration:none;color:inherit}
.brand svg,.brand img{width:34px;height:34px;border-radius:8px}
.wrap{max-width:1020px;margin:0 auto}
.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
.gallery img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:12px}
footer{padding:34px 24px;border-top:1px solid rgba(128,128,128,0.25);font-size:13px;opacity:0.75}
footer .wrap{display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px}
@media(max-width:640px){.nav{flex-direction:column;gap:12px}.nav nav a{margin:0 11px}}
${css}
</style>
</head>
<body>
${body}
${WEBBIE_NAV_SCRIPT}
</body>
</html>`;
  return { html, template, style: { accent, accent2, fonts: { display: fonts.display, body: fonts.body } } };
}

// ----------------------------------------------------------------------------
// WCAG CONTRAST ENGINE. Pure math on two colors — the check the URL-based
// a11y endpoint can't do (contrast needs actual color values). Implements the
// WCAG 2.x relative-luminance + contrast-ratio formula.
// ----------------------------------------------------------------------------
function parseColor(input) {
  if (typeof input !== "string") return null;
  let s = input.trim().toLowerCase();
  // rgb()/rgba()
  const rgbM = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (rgbM) {
    const [r, g, b] = [rgbM[1], rgbM[2], rgbM[3]].map(Number);
    if ([r, g, b].every((v) => v >= 0 && v <= 255)) return { r, g, b };
    return null;
  }
  s = s.replace(/^#/, "");
  if (/^[0-9a-f]{3}$/.test(s)) s = s.split("").map((c) => c + c).join("");
  if (/^[0-9a-f]{8}$/.test(s)) s = s.slice(0, 6); // drop alpha
  if (/^[0-9a-f]{6}$/.test(s)) {
    return { r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16) };
  }
  return null;
}

function relLuminance({ r, g, b }) {
  const lin = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrastReport(fgRaw, bgRaw) {
  const fg = parseColor(fgRaw), bg = parseColor(bgRaw);
  if (!fg || !bg) return { error: `could not parse ${!fg ? "foreground" : "background"} color` };
  const L1 = relLuminance(fg), L2 = relLuminance(bg);
  const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
  const r = Math.round(ratio * 100) / 100;
  const pass = {
    normal_text: { AA: r >= 4.5, AAA: r >= 7 },       // < 24px / < 18.66px bold
    large_text:  { AA: r >= 3,   AAA: r >= 4.5 },      // >= 24px or >= 18.66px bold
    ui_components: { AA: r >= 3 },                      // 1.4.11 non-text contrast
  };
  const hx = (c) => "#" + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("");
  // Highest bar cleared, for a quick human verdict.
  let summary;
  if (r >= 7) summary = "Excellent — passes AAA for all text sizes.";
  else if (r >= 4.5) summary = "Good — passes AA for normal text and AAA for large text.";
  else if (r >= 3) summary = "Limited — passes AA for large text and UI components only; fails for normal body text.";
  else summary = "Fails — insufficient contrast for text at any size.";
  return {
    foreground: hx(fg), background: hx(bg),
    contrast_ratio: r,
    ratio_string: `${r}:1`,
    passes: pass,
    summary,
    guidance: r < 4.5 ? "For body text, aim for at least 4.5:1 (AA) or 7:1 (AAA). Darken the text or lighten the background." : null,
  };
}

// ----------------------------------------------------------------------------
// RAW METADATA EXTRACTOR. Unlike head-check (which audits) this dumps the
// complete head inventory with no opinions: all meta tags grouped by family,
// every link relation, title, and parsed JSON-LD. For agents doing their own
// downstream processing.
// ----------------------------------------------------------------------------
function extractAllMeta(html, pageUrl) {
  const dom = new JSDOM(html, { url: pageUrl });
  const doc = dom.window.document;
  const head = doc.head || doc;

  const og = {}, twitter = {}, dublin_core = {}, other_named = {}, http_equiv = {}, itemprop = {};
  for (const m of doc.querySelectorAll("meta")) {
    const content = m.getAttribute("content");
    if (content == null) continue;
    const prop = m.getAttribute("property");
    const name = m.getAttribute("name");
    const equiv = m.getAttribute("http-equiv");
    const ip = m.getAttribute("itemprop");
    if (prop && /^og:/i.test(prop)) og[prop.slice(3)] = content;
    else if (prop && /^(article|book|profile|music|video|product):/i.test(prop)) other_named[prop] = content;
    else if (name && /^twitter:/i.test(name)) twitter[name.slice(8)] = content;
    else if (name && /^(dc|dcterms)\./i.test(name)) dublin_core[name] = content;
    else if (name) other_named[name] = content;
    else if (equiv) http_equiv[equiv.toLowerCase()] = content;
    else if (ip) itemprop[ip] = content;
  }

  // Link relations grouped by rel.
  const links = {};
  for (const l of doc.querySelectorAll("link[rel]")) {
    const rel = l.getAttribute("rel").toLowerCase();
    const entry = { href: l.getAttribute("href") };
    for (const a of ["hreflang", "type", "sizes", "title", "media", "as"]) {
      const v = l.getAttribute(a); if (v) entry[a] = v;
    }
    (links[rel] = links[rel] || []).push(Object.keys(entry).length === 1 ? entry.href : entry);
  }

  // JSON-LD blocks, parsed.
  const jsonld = [];
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try { jsonld.push(JSON.parse(s.textContent)); }
    catch { jsonld.push({ _parse_error: true, raw: (s.textContent || "").slice(0, 200) }); }
  }

  const charsetEl = doc.querySelector("meta[charset]");
  return {
    title: doc.querySelector("title")?.textContent?.trim() || null,
    charset: charsetEl?.getAttribute("charset") || (http_equiv["content-type"]?.match(/charset=([\w-]+)/i) || [])[1] || null,
    lang: doc.documentElement.getAttribute("lang") || null,
    canonical: doc.querySelector('link[rel="canonical"]')?.getAttribute("href") || null,
    counts: {
      meta_tags: doc.querySelectorAll("meta").length,
      og: Object.keys(og).length,
      twitter: Object.keys(twitter).length,
      links: doc.querySelectorAll("link[rel]").length,
      jsonld_blocks: jsonld.length,
    },
    opengraph: og,
    twitter,
    ...(Object.keys(dublin_core).length ? { dublin_core } : {}),
    ...(Object.keys(itemprop).length ? { itemprop } : {}),
    meta: other_named,
    http_equiv,
    links,
    jsonld,
  };
}

// ----------------------------------------------------------------------------
// WORDPRESS SECURITY POSTURE ENGINE. A PASSIVE hygiene check from public
// signals only — detects good/bad security *practice*, not exploitable
// vulnerabilities. It deliberately does NOT fingerprint plugin versions to
// match CVEs (that would be attack-enablement); it flags posture an owner
// should fix. Findings are practice-level, with remediation guidance.
// ----------------------------------------------------------------------------
async function wpAssess(inputUrl) {
  const base = new URL(assertSafeUrl(inputUrl));
  const origin = base.origin;
  const findings = [];
  const add = (severity, area, detail, fix) => findings.push({ severity, area, detail, fix });

  // Fetch homepage.
  const home = await fetchRawHtml(origin + "/").catch(() => null);
  if (!home) return { url: origin, is_wordpress: null, error: "could not fetch the site" };
  const html = home.html;
  const dom = new JSDOM(html, { url: origin });
  const doc = dom.window.document;

  // --- Is it WordPress? ---
  const generator = doc.querySelector('meta[name="generator"]')?.getAttribute("content") || "";
  const signals = {
    generator_wp: /wordpress/i.test(generator),
    wp_content: /\/wp-content\//i.test(html),
    wp_includes: /\/wp-includes\//i.test(html),
    wp_json_link: !!doc.querySelector('link[rel="https://api.w.org/"]'),
  };
  const is_wordpress = signals.generator_wp || signals.wp_content || signals.wp_includes || signals.wp_json_link;
  if (!is_wordpress) {
    return { url: origin, is_wordpress: false, note: "No WordPress signals detected on the homepage. This check is WordPress-specific." };
  }

  // --- Version disclosure (the leak is the finding, not the version's CVEs) ---
  let versionLeak = null;
  const genVer = generator.match(/wordpress\s+([\d.]+)/i);
  if (genVer) { versionLeak = "generator meta tag"; add("medium", "version_disclosure", `WordPress version is exposed in the generator meta tag (${genVer[1]}).`, "Remove the generator tag (remove_action('wp_head','wp_generator')) so the version isn't advertised."); }

  // readme.html often reveals version and shouldn't be public.
  const readme = await fetchRawText(origin + "/readme.html", 64 * 1024).catch(() => null);
  if (readme?.ok && /wordpress/i.test(readme.text || "")) {
    versionLeak = versionLeak || "readme.html";
    add("low", "version_disclosure", "readme.html is publicly accessible and typically states the WordPress version.", "Delete or block readme.html; it serves no purpose in production.");
  }

  // --- Concurrent public-signal probes (all HEAD/GET, SSRF-guarded, capped) ---
  const probe = async (path, method = "GET") => {
    try {
      assertSafeUrl(origin + path);
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 7000);
      const r = await fetch(origin + path, { method, redirect: "manual", signal: ctrl.signal, headers: { "User-Agent": DISCOGS_UA } });
      clearTimeout(t);
      return { status: r.status, headers: r.headers, ok: r.ok };
    } catch { return null; }
  };

  const [xmlrpc, usersApi, authorRedirect, uploadsListing, loginPage] = await Promise.all([
    probe("/xmlrpc.php", "GET"),
    probe("/wp-json/wp/v2/users"),
    probe("/?author=1"),
    probe("/wp-content/uploads/"),
    probe("/wp-login.php"),
  ]);

  // xmlrpc.php enabled — amplification/brute-force surface.
  if (xmlrpc && xmlrpc.status !== 404 && xmlrpc.status !== 403) {
    add("medium", "xmlrpc", "xmlrpc.php is reachable — a common vector for brute-force amplification and pingback abuse.", "Disable XML-RPC if unused, or block it at the server/firewall level.");
  }

  // User enumeration via REST API.
  if (usersApi && usersApi.status === 200) {
    add("medium", "user_enumeration", "The REST API exposes the user list at /wp-json/wp/v2/users — attackers harvest usernames for targeted brute force.", "Restrict the users endpoint (many security plugins do this) or require authentication for it.");
  }
  // User enumeration via author redirect.
  if (authorRedirect && [301, 302].includes(authorRedirect.status)) {
    const loc = authorRedirect.headers.get("location") || "";
    if (/\/author\//i.test(loc)) add("low", "user_enumeration", "?author=1 redirects to an author slug, revealing a username.", "Block author-archive enumeration (redirect ?author= queries or use a security plugin).");
  }

  // Directory listing on uploads.
  if (uploadsListing && uploadsListing.status === 200) {
    add("low", "directory_listing", "The uploads directory may have directory listing enabled (returns 200 at /wp-content/uploads/).", "Disable directory indexing (Options -Indexes) so file listings aren't browsable.");
  }

  // Default login location (info-level — not a vuln, but a hardening opportunity).
  if (loginPage && loginPage.status !== 404) {
    add("info", "login_exposure", "The login page is at the default /wp-login.php.", "Optional hardening: move/limit login access and add rate-limiting or 2FA to resist brute force.");
  }

  // --- Security headers (from the homepage response) ---
  const h = home.headers || new Map();
  const getH = (k) => (typeof h.get === "function" ? h.get(k) : null);
  const headerChecks = [
    ["strict-transport-security", "medium", "HSTS", "Add Strict-Transport-Security to force HTTPS and prevent downgrade attacks."],
    ["content-security-policy", "low", "CSP", "Add a Content-Security-Policy to mitigate XSS and injection."],
    ["x-frame-options", "low", "X-Frame-Options", "Add X-Frame-Options (or CSP frame-ancestors) to prevent clickjacking."],
    ["x-content-type-options", "low", "X-Content-Type-Options", "Add X-Content-Type-Options: nosniff to stop MIME sniffing."],
    ["referrer-policy", "info", "Referrer-Policy", "Set a Referrer-Policy to control referrer leakage."],
  ];
  const missingHeaders = [];
  for (const [name, sev, label, fix] of headerChecks) {
    if (!getH(name)) { missingHeaders.push(label); add(sev, "security_headers", `Missing ${label} response header.`, fix); }
  }

  // HTTPS itself.
  if (base.protocol !== "https:" && origin.startsWith("http:")) {
    add("high", "transport", "The site was requested over HTTP.", "Serve everything over HTTPS and redirect HTTP to HTTPS.");
  }

  // --- Score: start at 100, subtract weighted severity ---
  const weight = { high: 25, medium: 12, low: 5, info: 0 };
  let score = 100;
  for (const f of findings) score -= (weight[f.severity] || 0);
  score = Math.max(0, score);
  const grade = score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F";
  const counts = findings.reduce((a, f) => (a[f.severity] = (a[f.severity] || 0) + 1, a), {});

  return {
    url: origin,
    is_wordpress: true,
    version_disclosed_via: versionLeak,
    posture_score: score,
    grade,
    finding_counts: counts,
    findings,
    checked: ["version disclosure", "xmlrpc.php", "REST user enumeration", "author enumeration", "uploads directory listing", "login exposure", "security headers", "HTTPS"],
    disclaimer: "Passive hygiene assessment from public signals only. Flags security *practice*, not exploitable vulnerabilities — no version-to-CVE matching, no intrusion. For the site owner or an authorized auditor.",
  };
}

// ----------------------------------------------------------------------------
// NAVIGATION EXTRACTOR. Pulls a site's *navigation* links (not every link) by
// scoring candidate regions — <nav>, role=navigation, header/footer, and
// common menu class patterns — then extracting and de-duplicating links from
// the strongest ones, grouped by source. Heuristic by nature.
// ----------------------------------------------------------------------------
function extractNav(html, pageUrl) {
  const dom = new JSDOM(html, { url: pageUrl });
  const doc = dom.window.document;
  const pageHost = new URL(pageUrl).hostname.replace(/^www\./, "");

  const linksFrom = (el) => {
    const seen = new Set();
    const out = [];
    for (const a of el.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") || "";
      if (/^(#|mailto:|tel:|javascript:)/i.test(href)) continue;
      let abs;
      try { abs = new URL(href, pageUrl); } catch { continue; }
      if (!/^https?:$/.test(abs.protocol)) continue;
      const text = (a.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) continue; // nav items have labels
      const key = abs.href;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        text: text.slice(0, 80),
        href: abs.href,
        internal: abs.hostname.replace(/^www\./, "") === pageHost,
      });
    }
    return out;
  };

  const regions = [];
  const usedEls = new Set();
  const consider = (el, source, boost = 0) => {
    if (!el || usedEls.has(el)) return;
    // Skip if an ancestor was already captured (avoid double-counting nested).
    for (let p = el.parentElement; p; p = p.parentElement) if (usedEls.has(p)) return;
    const links = linksFrom(el);
    if (links.length < 2) return; // a nav has multiple items
    usedEls.add(el);
    // Score: link count in a sane nav range scores best; penalize link-dumps.
    const n = links.length;
    const density = n >= 3 && n <= 40 ? 20 : n > 40 ? 4 : 8;
    regions.push({ source, score: density + boost, count: n, links });
  };

  // 1. Semantic <nav> and role=navigation — strongest signals.
  for (const el of doc.querySelectorAll('nav, [role="navigation"]')) {
    const label = el.getAttribute("aria-label") || el.getAttribute("id") || el.className || "";
    consider(el, `nav${label ? ` (${String(label).slice(0, 30)})` : ""}`, 30);
  }
  // 2. Common menu containers by class/id pattern.
  for (const el of doc.querySelectorAll('[class*="menu" i], [class*="navbar" i], [class*="navigation" i], [id*="menu" i], [id*="nav" i]')) {
    if (el.tagName === "NAV") continue; // already captured
    consider(el, `menu-class (${(el.getAttribute("id") || el.className || "").toString().slice(0, 30)})`, 15);
  }
  // 3. Header / footer link clusters (labeled as such).
  const header = doc.querySelector("header");
  if (header) consider(header, "header", 10);
  const footer = doc.querySelector("footer");
  if (footer) consider(footer, "footer", 8);

  regions.sort((a, b) => b.score - a.score);

  // Primary nav = highest-scoring region; also expose the others.
  const primary = regions[0] || null;
  const allNavLinks = [];
  const seenGlobal = new Set();
  for (const r of regions) {
    for (const l of r.links) {
      if (seenGlobal.has(l.href)) continue;
      seenGlobal.add(l.href);
      allNavLinks.push(l);
    }
  }

  const suspiciouslyEmpty = regions.length === 0;
  return {
    nav_regions_found: regions.length,
    primary_nav: primary ? { source: primary.source, count: primary.count, links: primary.links } : null,
    regions: regions.slice(0, 6).map((r) => ({ source: r.source, count: r.count, links: r.links })),
    all_nav_links: allNavLinks,
    unique_nav_links: allNavLinks.length,
    ...(suspiciouslyEmpty ? {
      note: "No navigation regions detected. The site may render its menu client-side (JavaScript/SPA), which server-fetched HTML can't see, or use an unrecognized structure.",
    } : {}),
  };
}

// ----------------------------------------------------------------------------
// Geo helper. geoip-lite loads its database into memory at import time, so each
// lookup here is a pure in-memory binary search — no network, sub-millisecond.
// The one cost: ~135 MB resident RAM (see README for the low-memory swap).
// ----------------------------------------------------------------------------
geoip.lookup("8.8.8.8"); // warm the index at boot so the first paid call is fast

function normalizeIp(raw) {
  let ip = String(raw).trim();
  // Strip [...] around IPv6 and a trailing :port if present on IPv4.
  ip = ip.replace(/^\[|\]$/g, "");
  // x-forwarded-for can be a comma list; take the first hop.
  if (ip.includes(",")) ip = ip.split(",")[0].trim();
  // Unwrap IPv4-mapped IPv6 (::ffff:1.2.3.4).
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) ip = mapped[1];
  return ip;
}

function geoLookup(ip) {
  const g = geoip.lookup(ip);
  if (!g) return null;
  return {
    ip,
    country: g.country || null,
    region: g.region || null,
    city: g.city || null,
    timezone: g.timezone || null,
    ll: g.ll || null, // [latitude, longitude]
    eu: g.eu === "1",
    metro: g.metro || null,
    area: g.area || null,
  };
}

// ----------------------------------------------------------------------------
// FREE: OpenAPI 3.1 spec, generated from API_REGISTRY (the same discovery
// metadata that feeds Bazaar). Agent frameworks (LangChain, function-calling
// toolkits, GPT actions) ingest OpenAPI directly — this is how they find and
// call the endpoints without a human reading docs. Built once, served cached.
// ----------------------------------------------------------------------------
// Category per route — the same grouping as the website and docs pages.
// Emitted as standard OpenAPI operation tags (x402scan shows them as chips).
function apiCategory(p) {
  if (/^\/api\/store/.test(p)) return "Agent Datastore";
  if (/^\/api\/(scrape|summarize|extract)/.test(p)) return "Web Content";
  if (/^\/api\/(schema|og|seo)\//.test(p)) return "SEO & Publishing";
  if (/^\/api\/a11y\//.test(p)) return "Accessibility";
  if (/^\/api\/(icon|logo|brand)\/|^\/api\/(vectorize|website)/.test(p)) return "Design & Assets";
  if (/^\/api\/wp\//.test(p)) return "Security";
  if (/^\/api\/(dns|email)/.test(p)) return "Domain & Email Intelligence";
  if (/^\/api\/music\//.test(p)) return "Music";
  if (/^\/api\/(geo|timezone)/.test(p)) return "Location";
  if (/^\/api\/(price|report)/.test(p)) return "Crypto Markets";
  if (/^\/api\/board/.test(p)) return "Machine Message Board";
  return "More";
}

function buildOpenApi() {
  // Wrap a bare {properties, required} block into a proper object schema.
  const objSchema = (s) => (s && s.properties ? { type: "object", ...s } : s || { type: "object" });

  const paths = {};
  for (const { method, path, price, description, opts } of API_REGISTRY) {
    // ":param" (Express) → "{param}" (OpenAPI), collecting path param names.
    const pathParams = [];
    const oaPath = path.replace(/:([A-Za-z0-9_]+)/g, (_, name) => {
      pathParams.push(name);
      return `{${name}}`;
    });

    const inputSchema = opts.inputSchema || null;
    const required = new Set(inputSchema?.required || []);
    const isBody = method !== "GET";

    const parameters = pathParams.map((name) => ({
      name, in: "path", required: true,
      schema: (inputSchema?.properties?.[name] && { type: inputSchema.properties[name].type || "string" }) || { type: "string" },
      ...(inputSchema?.properties?.[name]?.description ? { description: inputSchema.properties[name].description } : {}),
      ...(opts.input?.[name] != null ? { example: opts.input[name] } : {}),
    }));
    if (!isBody && inputSchema?.properties) {
      for (const [name, prop] of Object.entries(inputSchema.properties)) {
        if (pathParams.includes(name)) continue;
        parameters.push({
          name, in: "query", required: required.has(name),
          schema: { type: prop.type || "string" },
          ...(prop.description ? { description: prop.description } : {}),
          ...(opts.input?.[name] != null ? { example: opts.input[name] } : {}),
        });
      }
    }

    const isFree = price === "free";
    const operation = {
      operationId: (method + path).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""),
      summary: description.split(/[.:] /)[0].slice(0, 120),
      description: isFree
        ? `${description}\n\nFree — no payment required.`
        : `${description}\n\nPrice: ${price} per call, paid in USDC via the x402 protocol (see the x402 security scheme).`,
      tags: [apiCategory(path)],
      "x-price": price,
      // x402 indexer convention (x402scan / @agentcash/discovery): marks the
      // route as paid and machine-readably priced (structured format).
      ...(isFree ? {} : { "x-payment-info": {
        price: { mode: "fixed", amount: price, currency: "USD" },
        protocols: [{ x402: { network: NETWORK, discovery: `${BASE_URL}/.well-known/x402` } }],
      } }),
      ...(parameters.length ? { parameters } : {}),
      ...(isBody && inputSchema
        ? {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: objSchema(inputSchema),
                  ...(opts.input ? { example: opts.input } : {}),
                },
              },
            },
          }
        : {}),
      responses: {
        200: {
          description: "Success",
          content: {
            "application/json": {
              schema: objSchema(opts.output?.schema),
              ...(opts.output?.example ? { example: opts.output.example } : {}),
            },
          },
        },
        ...(isFree ? {} : { 402: { $ref: "#/components/responses/PaymentRequired" } }),
      },
      security: isFree ? [] : [{ x402Payment: [] }],
    };

    paths[oaPath] = paths[oaPath] || {};
    paths[oaPath][method.toLowerCase()] = operation;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "WebberSites x402 Data API",
      version: "1.0.0",
      description:
        "Pay-per-call data & utility API for AI agents. No API keys or accounts: every request is paid on the spot in USDC on Base via the x402 protocol. " +
        "Call any endpoint normally; a 402 response returns machine-readable payment requirements. Sign the USDC authorization (EIP-3009) and retry with the " +
        "X-PAYMENT header to receive the data. Machine-readable payment catalog: /.well-known/x402",
      "x-guidance":
        "Every endpoint is pay-per-call: expect HTTP 402 with signed payment requirements on the first request; pay in USDC on Base (EIP-3009) and retry with the X-PAYMENT header — @x402/fetch automates this. Prices are in each operation's x-payment-info ($0.001–$0.009). No registration, no API keys, no rate-limit tiers. Prefer MCP? Remote endpoint at /mcp (quote mode without a wallet), `npx -y webbersites-x402-mcp` locally, or one-click via Smithery: https://smithery.ai/servers/service-tfij/webbersites-x402. Human docs: https://x402.webbersites.com/docs/",
      contact: {
        url: "https://x402.webbersites.com",
        // Public contact + ownership verification for indexers (x402scan).
        // Set CONTACT_EMAIL in the environment; omitted when unset.
        ...(process.env.CONTACT_EMAIL ? { email: process.env.CONTACT_EMAIL } : {}),
      },
    },
    servers: [{ url: "https://api.webbersites.com" }],
    tags: [...new Set(API_REGISTRY.map(({ path }) => apiCategory(path)))].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        x402Payment: {
          type: "apiKey",
          in: "header",
          name: "X-PAYMENT",
          description:
            "x402 payment payload: a signed USDC transfer authorization (EIP-3009) matching the requirements returned by the initial 402 response. " +
            `Network: ${NETWORK}. Use an x402 client library (e.g. @x402/fetch) to handle the 402 → sign → retry flow automatically.`,
        },
      },
      responses: {
        PaymentRequired: {
          description:
            "Payment required — the response body lists accepted payment methods (amount, asset, network, pay-to address). Retry the request with a signed X-PAYMENT header.",
        },
      },
    },
  };
}
let OPENAPI_DOC = null; // built on first request, then cached

app.get("/openapi.json", (_req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (!OPENAPI_DOC) OPENAPI_DOC = buildOpenApi();
  res.json(OPENAPI_DOC);
});

// Favicon for the API origin (indexers score on it; x402scan shows it as the
// server icon). The WebberSites "W" mark, embedded as a 32px PNG.
const API_FAVICON_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAQHRFWHRSYXcACmlwdGMKMjUKMWMwMjY3MDAxNDM3NTg0YzYyNTE1OTUzNTI0ODU4Njc1NTQxNDU2NTYxNTk3NjU1NmUK/dFWsAAAA+pJREFUeJztVW1IW1cYPvcjUVZXUxObeGf1mtskdzdqTGIYc+2fwpCBtMN2azUkf0Ra58fmXCWj0G06OjpcoeLwb2Ff3WAwJus2mLAfLRWZMFy3VFNda4MxG8NrMR+aj3ece6KkYqYZbDDWh8v5kXPu+z4f77lB6BH+d6Apitl4qIe32A0wDJP9O0VRm1s0Tf/LhLNA+Nr2FHpKNSe0xS9qi/erMFMihGVZd0tLx+nTHWfOtB5vZhWmRKRer29vb29ra+vu7m5oaMA2bKuDUU67dRq53rpgF+V660mtBiGkUk4LghCLxSCdBoDlr8YqlFdULIsQ8nq9ALC+vg4AnZ2dhE1OBXyB+lat2W+zhBzSOxUGhJBaOe12uwFgLR5PAshvnTvKYP5qFkscGRkhDWKxmCRJORWQBgyFvrTw9+ziXbt4TeRVFEUpkQ4PDwNAIpVKrK3JJ5rO78fiKIQYhpmamgIF09PTKpVq07ptXcLrG+X635zSTJ3Fb7MIhQVYMsNMTk4CQBogNnP7fr31C3MFy2Ssi0ajacW60dFRXOThGdsmhibN4wsO8bbNHHQ8+YIOMxV4PhKJEJrLVz8KmMtv2UX+sUJsXWsrVpZIAIDH48kZQLZLnJqdrjXP1lnCTukCzyGEWk+dAoBUMgkAodf7/EJZ0FX9vG4fDuDyZawsnY5EIkajMWcAW/CpqeK+A8fwtSQghN67dAkAkql0Ihqdf+6IX6r63VV9jitFCP2gWAcAExMTpHTOALJd6udKw05pts7yc62JLyz4/saNTJWbNz83V96zi0Gn9DFvqOL51dVVMrtDQ0M7BLDRAK9Hiovu2sVZuzhXbXzFXrsor5AG5y9efGlPwR9P1cw5peu8vs/rwf6ksHXNzc27akDkaVl2qsY0X28NHOR+ee1lfIVSKQB49uixp2kUdFnvOKSfDnKBD66QxrIscxy3sz/ZuCIcWHRZ/aZy+bNPSJUVWS41GPYh9KPNMm8zBxxSPDCL2wKMj49n+O2mAYmhu0wXdogzTik+d2dLlQ/NlUGr8dfjTelEIqkoGxwc3GFAs0ErJBr2Fs1J/MLJY+lkMqEM6MDAAGHZW64PmZ4IXXgTB6BsNTY27iqAjExl3atWXz+gW3737S1VEEUdLi6al6oefHuNWBcOh7VabX4BkIPvl2lT332zplyk0NJSSUkJaaCh0KSrJrm0GE/hAR0bG8uvOnZTuTIdFgEerOAGWVVoxYer3hYAiCufaJ/Pl0cAGQUKnUqD4dWenp6uLl9//+FDh8hngFzXZ5xO39mzPV1dfb29giDkrSAvUH+79F/8m9M0vbn1D3J/hP8G/gTx9dib+qsk+QAAAABJRU5ErkJggg==",
  "base64"
);
app.get(["/favicon.ico", "/favicon.png", "/favicon.svg"], (_req, res) => {
  res.set("Content-Type", "image/png").set("Cache-Control", "public, max-age=86400").send(API_FAVICON_PNG);
});

// ----------------------------------------------------------------------------
// FREE: agents.json (emerging agent-discovery convention) — a compact manifest
// that points agent frameworks at the OpenAPI spec, the payment protocol, and
// the MCP connection options. Served at /.well-known/agents.json.
// ----------------------------------------------------------------------------
app.get("/.well-known/agents.json", (_req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.json({
    agentsJson: "0.1.0",
    info: {
      title: "WebberSites x402 Data API",
      description:
        "Pay-per-call data & utility API for AI agents: document extraction, SEO/schema/accessibility audits, web scraping, logo/icon/social-card generation, image vectorization, DNS and email intelligence, geolocation, crypto data, and a machine message board. No API keys — each request pays for itself in USDC on Base via the x402 protocol (HTTP 402).",
      version: "1.0.0",
      website: "https://x402.webbersites.com",
    },
    sources: [
      { id: "webbersites-x402", path: `${BASE_URL}/openapi.json`, description: "OpenAPI 3.1 spec for all endpoints, including per-call USD pricing (x-price)" },
    ],
    authentication: {
      type: "x402",
      description:
        "No accounts or API keys. Endpoints return 402 Payment Required with signed payment requirements; clients pay in USDC on Base (EIP-3009) and retry with the X-PAYMENT header. Use @x402/fetch or any x402 client.",
      discovery: `${BASE_URL}/.well-known/x402`,
    },
    interfaces: {
      http: { baseUrl: BASE_URL, spec: `${BASE_URL}/openapi.json` },
      mcp: {
        remote: `${BASE_URL}/mcp`,
        configSchema: `${BASE_URL}/mcp/.well-known/mcp-config`,
        local: "npx -y webbersites-x402-mcp",
        smithery: "https://smithery.ai/servers/service-tfij/webbersites-x402",
      },
    },
    docs: {
      human: "https://x402.webbersites.com/docs/",
      llms: "https://x402.webbersites.com/llms.txt",
      llmsFull: "https://x402.webbersites.com/llms-full.txt",
    },
  });
});

// ----------------------------------------------------------------------------
// FREE: remote MCP endpoint (streamable HTTP, stateless). Any MCP client —
// Smithery, claude.ai custom connectors, etc. — can connect to
// https://api.webbersites.com/mcp and get every paid endpoint as a tool.
// Tools are generated from API_REGISTRY, same source as /openapi.json.
//
// Payment: by default runs in QUOTE MODE — tool calls return the endpoint's
// price and payment requirements instead of data. To make paying calls the
// client supplies a wallet key per session (a THROWAWAY hot wallet with USDC
// dust on Base): ?evmPrivateKey=0x…&maxPrice=0.10, or ?config=<base64 JSON
// {evmPrivateKey,maxPrice}> (the Smithery convention), or the
// x-evm-private-key / x-max-price headers. Keys are used in-memory per
// request and never logged (hit tracking records req.path only, no query).
//
// Loaded defensively like every other engine: if the MCP SDK or x402 client
// libs are missing, /mcp 503s and the rest of the service is untouched.
// ----------------------------------------------------------------------------
let McpServerCtor = null, McpHttpTransport = null, McpTypes = null, x402ClientLibs = null;
try {
  ({ Server: McpServerCtor } = await import("@modelcontextprotocol/sdk/server/index.js"));
  ({ StreamableHTTPServerTransport: McpHttpTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js"));
  McpTypes = await import("@modelcontextprotocol/sdk/types.js");
  console.log("✓ MCP SDK loaded (remote /mcp endpoint enabled)");
} catch (e) { console.warn("⚠ MCP SDK not loaded — /mcp disabled:", e.message); }
try {
  const [f, c, s, v] = await Promise.all([
    import("@x402/fetch"), import("@x402/core/client"), import("@x402/evm/exact/client"), import("viem/accounts"),
  ]);
  x402ClientLibs = {
    wrapFetchWithPayment: f.wrapFetchWithPayment,
    x402Client: c.x402Client,
    ExactEvmScheme: s.ExactEvmScheme,
    privateKeyToAccount: v.privateKeyToAccount,
  };
} catch (e) { console.warn("⚠ x402 client libs not loaded — /mcp runs quote-only:", e.message); }

// Everything currently prices at ≤ $0.009, so this ceiling has ample headroom;
// callers can lower it per session.
const MCP_DEFAULT_MAX_PRICE = 0.50;

// "GET /api/price/:coin" -> tool "get_price_coin" with a flat input schema
// (path params + query params + body properties merged, like the npm server).
// Tools carry outputSchema (from the same discovery metadata that feeds
// OpenAPI) and MCP annotations (title, read-only/open-world hints) — clients
// and registries score/route on these.
const MCP_TITLE_WORDS = { seo: "SEO", dns: "DNS", wp: "WordPress", og: "OG", a11y: "Accessibility", ip: "IP" };
function mcpToolTitle(method, path) {
  const words = path.replace(/^\/api\//, "").replace(/:/g, "").split(/[/-]+/).filter(Boolean)
    .map((w) => MCP_TITLE_WORDS[w] || w.charAt(0).toUpperCase() + w.slice(1));
  return (method === "GET" ? "Get " : "") + words.join(" ");
}

let MCP_TOOLS = null; // [{ tool, method, path, price, opts }]
function mcpTools() {
  if (MCP_TOOLS) return MCP_TOOLS;
  MCP_TOOLS = API_REGISTRY.map(({ method, path, price, description, opts }) => {
    const name = (method + path.replace(/^\/api/, "")).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 64);
    const properties = {};
    const required = [];
    const inputSchema = opts.inputSchema || null;
    for (const [k, v] of Object.entries(inputSchema?.properties || {})) properties[k] = v;
    for (const r of inputSchema?.required || []) required.push(r);
    const outSchema = opts.output?.schema?.properties ? { type: "object", ...opts.output.schema } : null;
    return {
      method, path, price, opts, hasOutputSchema: !!outSchema,
      tool: {
        name,
        description: `${description} (${price} per call, paid via x402)`,
        inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) },
        ...(outSchema ? { outputSchema: outSchema } : {}),
        annotations: {
          title: mcpToolTitle(method, path),
          readOnlyHint: method === "GET",
          destructiveHint: false,
          idempotentHint: method === "GET",
          openWorldHint: true,
        },
      },
    };
  });
  return MCP_TOOLS;
}

function parseMcpConfig(req) {
  let cfg = {};
  try {
    if (req.query.config) cfg = JSON.parse(Buffer.from(String(req.query.config), "base64").toString("utf8")) || {};
  } catch { /* bad config param — ignore, fall through to explicit params */ }
  const key = req.query.evmPrivateKey || req.header("x-evm-private-key") || cfg.evmPrivateKey || null;
  const maxPrice = Number(req.query.maxPrice ?? req.header("x-max-price") ?? cfg.maxPrice ?? MCP_DEFAULT_MAX_PRICE);
  return {
    evmPrivateKey: typeof key === "string" && /^0x[0-9a-fA-F]{64}$/.test(key) ? key : null,
    maxPrice: Number.isFinite(maxPrice) ? maxPrice : MCP_DEFAULT_MAX_PRICE,
  };
}

// Keep huge base64/svg payloads out of the model's context window.
function mcpCompact(data) {
  if (typeof data !== "object" || data === null) return data;
  const out = Array.isArray(data) ? [...data] : { ...data };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === "string" && v.length > 4000 && /base64|data_uri|svg|image|html/i.test(k)) {
      out[k] = v.slice(0, 200) + `… [truncated: ${v.length} chars — call the HTTP API directly for full payloads]`;
    } else if (typeof v === "object" && v !== null) out[k] = mcpCompact(v);
  }
  return out;
}

async function mcpCallEndpoint(entry, args, config) {
  const priceNum = parseFloat(String(entry.price || "").replace(/[^0-9.]/g, ""));
  if (!Number.isNaN(priceNum) && priceNum > config.maxPrice) {
    return { error: `This tool costs ${entry.price} per call, above the session ceiling of $${config.maxPrice}. Pass a higher maxPrice to raise it.` };
  }

  // Build the request against our own public base URL; payment (if configured)
  // rides the same x402 flow an external client would use.
  const used = new Set();
  const path = entry.path.replace(/:([A-Za-z0-9_]+)/g, (_, name) => { used.add(name); return encodeURIComponent(String(args?.[name] ?? "")); });
  const url = new URL(BASE_URL + path);
  const rest = Object.fromEntries(Object.entries(args || {}).filter(([k, v]) => !used.has(k) && v != null));
  const fetchOpts = { method: entry.method };
  if (entry.method === "GET") {
    for (const [k, v] of Object.entries(rest)) url.searchParams.set(k, String(v));
  } else {
    fetchOpts.headers = { "Content-Type": "application/json" };
    fetchOpts.body = JSON.stringify(rest);
  }

  let doFetch = fetch;
  if (config.evmPrivateKey && x402ClientLibs) {
    const signer = x402ClientLibs.privateKeyToAccount(config.evmPrivateKey);
    const client = new x402ClientLibs.x402Client();
    client.register("eip155:*", new x402ClientLibs.ExactEvmScheme(signer));
    doFetch = x402ClientLibs.wrapFetchWithPayment(fetch, client);
  }

  const r = await doFetch(url.toString(), fetchOpts);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 4000) }; }

  if (r.status === 402) {
    return {
      payment_required: true,
      price: entry.price,
      note: config.evmPrivateKey
        ? "Payment was attempted but not accepted — check the wallet's USDC balance on Base."
        : "Quote mode: no wallet key configured for this session, so this is the endpoint's price quote. Connect with ?evmPrivateKey=0x… (a throwaway hot wallet holding USDC on Base) to make paying calls, or use the npm package webbersites-x402-mcp to keep your key local.",
    };
  }
  if (!r.ok) return { http_status: r.status, ...((typeof data === "object" && data) || { body: data }) };
  return mcpCompact(data);
}

function buildMcpServer(config) {
  const server = new McpServerCtor(
    { name: "webbersites-x402", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );
  // Empty resources/prompts so registry scanners (Smithery etc.) get clean
  // responses instead of "method not found" warnings.
  server.setRequestHandler(McpTypes.ListResourcesRequestSchema, async () => ({ resources: [] }));
  server.setRequestHandler(McpTypes.ListPromptsRequestSchema, async () => ({ prompts: [] }));
  server.setRequestHandler(McpTypes.ListToolsRequestSchema, async () => ({ tools: mcpTools().map((t) => t.tool) }));
  server.setRequestHandler(McpTypes.CallToolRequestSchema, async (req) => {
    const entry = mcpTools().find((t) => t.tool.name === req.params.name);
    if (!entry) return { content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }], isError: true };
    try {
      const result = await mcpCallEndpoint(entry, req.params.arguments || {}, config);
      const failed = !!(result?.error || result?.payment_required || result?.http_status);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        // Spec: tools that declare outputSchema should also return the data
        // as structuredContent (successful calls only).
        ...(!failed && entry.hasOutputSchema && result && typeof result === "object" ? { structuredContent: result } : {}),
        ...(failed ? { isError: true } : {}),
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Call failed: ${String(e?.message || e)}` }], isError: true };
    }
  });
  return server;
}

const MCP_CORS = (res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, mcp-session-id, mcp-protocol-version, x-evm-private-key, x-max-price");
  res.set("Access-Control-Expose-Headers", "mcp-session-id");
};

// Config schema for remote-MCP registries (Smithery's well-known convention):
// tells their UI which session settings to prompt users for.
app.get("/mcp/.well-known/mcp-config", (_req, res) => {
  MCP_CORS(res);
  res.json({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "WebberSites x402 Data API",
    description: "Optional payment configuration. Without a key the server runs in quote mode: every tool returns its live price and payment requirements instead of data.",
    type: "object",
    properties: {
      evmPrivateKey: {
        type: "string",
        title: "Wallet private key (throwaway hot wallet)",
        description: "0x… private key of a DEDICATED hot wallet holding a little USDC on Base mainnet — each tool call pays for itself (from $0.001). Fund it with dust only; do not use a wallet that controls meaningful funds. Omit to browse in quote mode.",
        pattern: "^0x[0-9a-fA-F]{64}$",
        "x-secret": true,
      },
      maxPrice: {
        type: "number",
        title: "Max USD per call",
        description: "Hard per-call price ceiling — more expensive tools are refused before any payment happens.",
        default: 0.1,
        minimum: 0,
        maximum: 10,
      },
    },
  });
});

app.options("/mcp", (_req, res) => { MCP_CORS(res); res.status(204).end(); });
app.post("/mcp", async (req, res) => {
  MCP_CORS(res);
  if (!McpServerCtor) return res.status(503).json({ error: "MCP not available on this deployment" });
  try {
    // Stateless: a fresh server + transport per request; no session to track.
    const transport = new McpHttpTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const mcp = buildMcpServer(parseMcpConfig(req));
    res.on("close", () => { transport.close(); mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: String(e?.message || e) }, id: null });
    }
  }
});
app.get("/mcp", (_req, res) => {
  MCP_CORS(res);
  res.status(405).json({
    error: "This is a stateless MCP endpoint — connect with an MCP client (streamable HTTP), don't browse it.",
    hint: "Add https://api.webbersites.com/mcp as a remote MCP server. Quote mode by default; see https://x402.webbersites.com/llms-full.txt",
  });
});

// ----------------------------------------------------------------------------
// FREE: menu / index. Good for humans AND for agents browsing what you offer.
// ----------------------------------------------------------------------------
app.get("/", (_req, res) => {
  res.set("Access-Control-Allow-Origin", "*"); // allow the marketing page to pull this live
  res.json({
    service: "x402-data-api",
    build: "2026-07-06-wpassess-desc-v1", // bump when deploying; verify with: curl -s https://api.webbersites.com/ | grep -o 'build[^,]*'
    website: "https://x402.webbersites.com",
    description:
      "Pay-per-call data & utility API for AI agents: web scraping, page summaries, IP geolocation, timezone lookup, crypto prices & market reports, and schema.org structured-data audits. USDC on Base via x402.",
    payment: { protocol: "x402", network: NETWORK, asset: "USDC" },
    endpoints: [
      { method: "GET", path: "/api/price/:coin", price: "$0.001", note: "e.g. /api/price/bitcoin" },
      { method: "GET", path: "/api/report/:coin", price: "$0.005", note: "e.g. /api/report/ethereum" },
      { method: "GET", path: "/api/scrape", price: "$0.001", note: "e.g. /api/scrape?url=https://example.com" },
      { method: "GET", path: "/api/summarize", price: "$0.002", note: "e.g. /api/summarize?url=https://example.com&sentences=3" },
      { method: "GET", path: "/api/geo", price: "$0.001", note: "e.g. /api/geo?ip=8.8.8.8" },
      { method: "GET", path: "/api/timezone", price: "$0.001", note: "e.g. /api/timezone?lat=40.71&lng=-74.01" },
      { method: "POST", path: "/api/schema/audit", price: "$0.005", note: "POST {url} or {jsonld}" },
      { method: "POST", path: "/api/schema/generate", price: "$0.005", note: "POST {type, fields} → valid JSON-LD" },
      { method: "GET", path: "/api/dns", price: "$0.002", note: "e.g. /api/dns?domain=example.com" },
      { method: "GET", path: "/api/email/verify", price: "$0.001", note: "e.g. /api/email/verify?email=user@example.com" },
      { method: "GET", path: "/api/og/check", price: "$0.001", note: "e.g. /api/og/check?url=https://example.com" },
      { method: "GET", path: "/api/seo/alt-check", price: "$0.001", note: "e.g. /api/seo/alt-check?url=https://example.com" },
      { method: "GET", path: "/api/a11y/contrast", price: "$0.001", note: "e.g. /api/a11y/contrast?fg=%23111&bg=%23fff" },
      { method: "GET", path: "/api/a11y/check", price: "$0.001", note: "e.g. /api/a11y/check?url=https://example.com&level=AA" },
      { method: "GET", path: "/api/seo/robots-check", price: "$0.001", note: "e.g. /api/seo/robots-check?url=https://example.com" },
      { method: "GET", path: "/api/seo/metadata", price: "$0.001", note: "raw meta dump, e.g. /api/seo/metadata?url=https://example.com" },
      { method: "GET", path: "/api/seo/head-check", price: "$0.001", note: "e.g. /api/seo/head-check?url=https://example.com" },
      { method: "GET", path: "/api/seo/sitemap-check", price: "$0.001", note: "e.g. /api/seo/sitemap-check?url=https://example.com" },
      { method: "GET", path: "/api/seo/nav", price: "$0.001", note: "nav links only, e.g. /api/seo/nav?url=https://example.com" },
      { method: "GET", path: "/api/seo/links", price: "$0.001", note: "e.g. /api/seo/links?url=https://example.com" },
      { method: "GET", path: "/api/seo/full-audit", price: "$0.007", note: "the bundle — 7 analyses + score, e.g. /api/seo/full-audit?url=https://example.com" },
      { method: "GET", path: "/api/seo/site-audit", price: "$0.009", note: "whole-site audit — full-audit across up to 8 pages + site score, e.g. /api/seo/site-audit?url=https://example.com&pages=5" },
      { method: "GET", path: "/api/music/album", price: "$0.002", note: "e.g. /api/music/album?artist=Radiohead&title=OK+Computer" },
      { method: "GET", path: "/api/music/cover", price: "$0.002", note: "e.g. /api/music/cover?artist=Radiohead&title=OK+Computer" },
      { method: "GET", path: "/api/extract", price: "$0.001", note: "PDF/DOCX/CSV → markdown+JSON, e.g. /api/extract?url=https://example.com/report.pdf" },
      { method: "GET", path: "/api/wp/assess", price: "$0.005", note: "WP security posture, e.g. /api/wp/assess?url=https://example.com" },
      { method: "GET", path: "/api/icon/search", price: "$0.002", note: "e.g. /api/icon/search?q=rocket" },
      { method: "POST", path: "/api/icon/generate", price: "$0.005", note: 'POST { "query":"rocket", "colors":["#ff6b35"] } → 1024px SVG+PNG' },
      { method: "POST", path: "/api/logo/generate", price: "$0.005", note: 'POST { "name":"Northwind", "query":"rocket", "colors":["#ff6b35"] } → finished logo SVG+PNG' },
      { method: "POST", path: "/api/vectorize", price: "$0.009", note: 'POST { "url":"https://…/image.png" } → production-quality SVG (Vectorizer.AI)' },
      { method: "POST", path: "/api/website/page", price: "$0.005", note: 'POST { "site_name":"…", "headline":"…", "seed":"…" } → finished HTML page; same seed = same site style' },
      { method: "POST", path: "/api/website/build", price: "$0.009", note: 'POST { "site_name":"…", "pages":[{…}] } → up to 6 consistent HTML pages + nav.json in one call' },
      { method: "POST", path: "/api/og/card", price: "$0.005", note: "POST {title, subtitle, domain, theme} → 1200x630 PNG+SVG" },
      { method: "POST", path: "/api/brand/kit", price: "$0.007", note: 'POST { "name":"…", "query":"rocket", "colors":["#ff6b35"] } → logo + app icon + social card + palette, one call' },
      { method: "POST", path: "/api/store/:collection", price: "$0.001", note: "AGENT DATASTORE: append JSON/CSV rows to your wallet's persistent storage — the paying wallet is the identity" },
      { method: "GET", path: "/api/store/:collection", price: "$0.001", note: "read your rows back — ?limit=&offset=&order=&since=&format=json|csv" },
      { method: "GET", path: "/api/store", price: "$0.001", note: "list your wallet's collections + storage used" },
      { method: "DELETE", path: "/api/store/:collection", price: "$0.001", note: "drop a collection" },
      { method: "GET", path: "/api/board", price: "free", note: "read the machine message board" },
      { method: "POST", path: "/api/board", price: "$0.001", note: "post a message {type, text, agent}" },
      { method: "POST", path: "/api/board/sticky", price: "$0.003", note: "pin a message for 7 days" },
    ],
    discovery: `${BASE_URL}/.well-known/x402`,
    openapi: `${BASE_URL}/openapi.json`,
    mcp: `${BASE_URL}/mcp`,
  });
});

// ----------------------------------------------------------------------------
// FREE (private): endpoint hit + revenue stats. Gated by STATS_KEY env var so
// it's not public. Returns 404 if STATS_KEY is unset or the key doesn't match.
// History is replayed from the hit log on boot, so numbers survive redeploys.
//   view with:  curl "https://api.webbersites.com/stats?key=YOUR_STATS_KEY"
// ----------------------------------------------------------------------------
app.get("/stats", (req, res) => {
  const key = process.env.STATS_KEY;
  if (!key || req.query.key !== key) return res.status(404).json({ error: "not found" });
  const payerEntries = Object.entries(HITS.payers);
  const repeat = payerEntries.filter(([, p]) => p.count > 1);
  res.json({
    booted: HITS.started,
    log_file: HITS_LOG,
    total_calls: HITS.total,
    total_paid_calls: HITS.total - HITS.free_reads,
    free_reads: HITS.free_reads,
    revenue_usd: HITS.revenue_usd,
    unique_payers: payerEntries.length,
    repeat_payers: repeat.length,
    repeat_rate: payerEntries.length ? Math.round((repeat.length / payerEntries.length) * 1000) / 10 : 0, // %
    revenue_from_repeat_usd: Math.round(repeat.reduce((s, [, p]) => s + p.revenue_usd, 0) * 1e6) / 1e6,
    by_endpoint: Object.fromEntries(
      Object.entries(HITS.by_endpoint).sort((a, b) => b[1].revenue_usd - a[1].revenue_usd)
    ),
    top_payers: payerEntries
      .sort((a, b) => b[1].revenue_usd - a[1].revenue_usd)
      .slice(0, 10)
      .map(([address, p]) => ({ address, ...p })),
    // Anonymous free-read audience (board pollers etc.): hashed-ip readers
    // with geo + client, so the funnel's top is as visible as its paying end.
    board_readers: (() => {
      const entries = Object.entries(HITS.readers);
      const tally = (pick) => {
        const m = {};
        for (const [, r] of entries) { const k = pick(r); if (k) m[k] = (m[k] || 0) + r.count; }
        return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 10));
      };
      return {
        unique_readers: entries.length,
        top_readers: entries
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 15)
          .map(([id, r]) => ({ id, ...r })),
        by_country: tally((r) => r.country),
        by_client: tally((r) => r.ua),
      };
    })(),
    recent: HITS.recent,
  });
});

// ----------------------------------------------------------------------------
// FREE: x402 discovery document. Agents and directories read this to learn
// what you sell and how much it costs — how you get found automatically.
// ----------------------------------------------------------------------------
// USDC contract per network, for the standard discovery document's accepts[].
const USDC_BY_NETWORK = {
  "eip155:8453": { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name: "USD Coin" }, // Base mainnet
  "eip155:84532": { asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", name: "USDC" },     // Base Sepolia
};

// Standard x402 discovery items (the CDP/Bazaar shape: resource + accepts[]),
// generated from API_REGISTRY. Indexers like x402scan parse this format; the
// legacy `resources` array below is kept for anything already reading it.
function buildDiscoveryItems() {
  const usdc = USDC_BY_NETWORK[NETWORK] || USDC_BY_NETWORK["eip155:8453"];
  return API_REGISTRY.filter((r) => r.price !== "free").map(({ method, path, price, description }) => {
    const amount = String(Math.round(parseFloat(String(price).replace(/[^0-9.]/g, "")) * 1e6));
    const resource = `${BASE_URL}${path}`;
    return {
      resource,
      type: "http",
      x402Version: 2,
      accepts: [{
        scheme: "exact",
        network: NETWORK,
        amount,
        maxAmountRequired: amount, // v1 field name, for older indexers
        asset: usdc.asset,
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        resource,
        description,
        mimeType: "application/json",
        extra: { name: usdc.name, version: "2" },
      }],
      metadata: { method },
      lastUpdated: new Date().toISOString(),
    };
  });
}

app.get("/.well-known/x402", (_req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.json({
    x402Version: 2,
    items: buildDiscoveryItems(),
    website: "https://x402.webbersites.com",
    openapi: `${BASE_URL}/openapi.json`,
    // Legacy flat list (pre-Bazaar shape), derived from the same registry as
    // everything else so it can never drift from the live prices.
    resources: API_REGISTRY.filter((r) => r.price !== "free").map(({ method, path, price, description }) => ({
      method, path, price, network: NETWORK, payTo: PAY_TO, description,
    })),
  });
});

// ----------------------------------------------------------------------------
// PAID: raw-ish price. Cheap, high-volume tier.
// ----------------------------------------------------------------------------
app.get("/api/price/:coin", async (req, res) => {
  try {
    const c = await fetchCoin(req.params.coin.toLowerCase());
    res.json({
      coin: req.params.coin.toLowerCase(),
      usd: c.usd,
      change_24h_pct: c.usd_24h_change,
      ts: new Date().toISOString(),
    });
  } catch (e) {
    res.status(502).json({ error: "data unavailable", detail: String(e.message) });
  }
});

// ----------------------------------------------------------------------------
// PAID: enriched report. Pulls richer CoinGecko data (rank, multi-
// timeframe changes, all-time-high context), computes plain-English signals,
// and returns a generic woven summary an agent can use directly. This is the
// value-add that justifies the higher price vs. the raw price endpoint.
// ----------------------------------------------------------------------------
app.get("/api/report/:coin", async (req, res) => {
  try {
    const coin = req.params.coin.toLowerCase();
    const d = await fetchCoinFull(coin);
    const signals = computeSignals(d);

    res.json({
      coin,
      symbol: d.symbol,
      market_cap_rank: d.rank,
      price_usd: d.price_usd,
      market_cap_usd: d.market_cap_usd,
      volume_24h_usd: d.volume_24h_usd,
      change_1h_pct: d.change_1h_pct,
      change_24h_pct: d.change_24h_pct,
      change_7d_pct: d.change_7d_pct,
      change_30d_pct: d.change_30d_pct,
      ath_usd: d.ath_usd,
      from_ath_pct: d.from_ath_pct,
      atl_usd: d.atl_usd,
      signals,
      summary: buildSummary(d, signals),
      generated: new Date().toISOString(),
    });
  } catch (e) {
    res.status(502).json({ error: "data unavailable", detail: String(e.message) });
  }
});

// ----------------------------------------------------------------------------
// PAID: URL -> clean markdown. The high-demand "Firecrawl-style" tier.
// Agent sends ?url=... and gets back readable markdown with nav/ads stripped.
// ----------------------------------------------------------------------------
app.get("/api/scrape", async (req, res) => {
  const target = req.query.url;
  if (!target || typeof target !== "string") {
    return res.status(400).json({ error: "missing ?url= query parameter" });
  }
  try {
    const result = await scrapeToMarkdown(target);
    res.json({ ...result, ts: new Date().toISOString() });
  } catch (e) {
    const msg = String(e.message || e);
    // 400 for bad/blocked input, 502 for upstream failures.
    const status = /url|allowed|content-type|invalid|too large/.test(msg)
      ? 400
      : 502;
    res.status(status).json({ error: "scrape failed", detail: msg });
  }
});

// ----------------------------------------------------------------------------
// PAID: IP geolocation. The lightest endpoint here — pure in-memory
// lookup, no outbound call. Pass ?ip=1.2.3.4, or omit it to geolocate the caller.
// ----------------------------------------------------------------------------
app.get("/api/geo", (req, res) => {
  const raw = req.query.ip ? String(req.query.ip) : req.ip;
  const ip = normalizeIp(raw);

  if (isIP(ip) === 0) {
    return res.status(400).json({ error: "invalid or missing ip", got: ip });
  }
  const geo = geoLookup(ip);
  if (!geo) {
    // Private/reserved ranges and some IPv6 blocks have no public mapping.
    return res.status(404).json({ error: "no geolocation for this ip", ip });
  }
  res.json({ ...geo, ts: new Date().toISOString() });
});

// ----------------------------------------------------------------------------
// Timezone helpers — derive offset, abbreviation, DST, and local time from an
// IANA zone using only built-in Intl (no extra deps).
// ----------------------------------------------------------------------------
function tzOffsetMinutes(timeZone, date) {
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(date)
    .find((p) => p.type === "timeZoneName");
  const m = (part?.value || "GMT+00:00").match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3] || "0", 10));
}
function fmtOffset(mins) {
  const sign = mins < 0 ? "-" : "+";
  const a = Math.abs(mins);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}
function tzAbbreviation(timeZone, date) {
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
    .formatToParts(date)
    .find((p) => p.type === "timeZoneName");
  return part?.value || null;
}

// ----------------------------------------------------------------------------
// PAID: timezone from lat/lng. Offline lookup, no outbound call.
// Pass ?lat=..&lng=.. ; returns IANA zone + offset, abbreviation, DST, local time.
// ----------------------------------------------------------------------------
app.get("/api/timezone", (req, res) => {
  if (!tzlookup) {
    return res.status(503).json({ error: "timezone lookup unavailable" });
  }
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ error: "lat (-90..90) and lng (-180..180) required" });
  }

  let timezone;
  try {
    timezone = tzlookup(lat, lng);
  } catch (e) {
    return res.status(400).json({ error: "lookup failed", detail: String(e.message) });
  }

  const now = new Date();
  const year = now.getUTCFullYear();
  const offNow = tzOffsetMinutes(timezone, now);
  const offJan = tzOffsetMinutes(timezone, new Date(Date.UTC(year, 0, 1)));
  const offJul = tzOffsetMinutes(timezone, new Date(Date.UTC(year, 6, 1)));
  // DST is in effect when the zone observes it AND we're on the larger (forward) offset.
  const dstInEffect = offJan !== offJul && offNow === Math.max(offJan, offJul);

  res.json({
    lat,
    lng,
    timezone,
    utc_offset: fmtOffset(offNow),
    utc_offset_minutes: offNow,
    abbreviation: tzAbbreviation(timezone, now),
    dst_in_effect: dstInEffect,
    local_time: new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      dateStyle: "medium",
      timeStyle: "medium",
      hour12: false,
    }).format(now),
    ts: now.toISOString(),
  });
});

// ----------------------------------------------------------------------------
// PAID: schema.org structured-data audit. POST a URL or raw JSON-LD;
// get back detected types, missing required/recommended fields, honest
// rich-result status (active vs. deprecated), and fix suggestions.
// ----------------------------------------------------------------------------
app.post("/api/schema/audit", async (req, res) => {
  try {
    const body = req.body || {};
    let nodes = [];
    let source;

    if (body.url) {
      source = { type: "url", url: String(body.url) };
      const { html } = await fetchRawHtml(String(body.url));
      nodes = extractJsonLd(html);
    } else if (body.jsonld) {
      source = { type: "jsonld" };
      const parsed = typeof body.jsonld === "string" ? JSON.parse(body.jsonld) : body.jsonld;
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const it of items) {
        if (it && it["@graph"] && Array.isArray(it["@graph"])) nodes.push(...it["@graph"]);
        else nodes.push(it);
      }
    } else {
      return res.status(400).json({ error: "provide either 'url' or 'jsonld' in the JSON body" });
    }

    if (!nodes.length) {
      return res.json({
        source,
        found: 0,
        detected: [],
        note: "No JSON-LD structured data found.",
        ts: new Date().toISOString(),
      });
    }

    const detected = nodes
      .filter((n) => n && n["@type"])
      .map(auditNode);

    const auditedCount = detected.filter((d) => d.audited_as).length;
    const issues = detected.filter(
      (d) => (d.required_missing?.length || d.one_of_missing?.length)
    ).length;

    res.json({
      source,
      found: nodes.length,
      audited: auditedCount,
      with_issues: issues,
      detected,
      ts: new Date().toISOString(),
    });
  } catch (e) {
    const msg = String(e.message || e);
    const status = /url|allowed|content-type|too large|JSON|invalid/i.test(msg) ? 400 : 502;
    res.status(status).json({ error: "audit failed", detail: msg });
  }
});

// ----------------------------------------------------------------------------
// PAID: extractive page summary. Fetch a URL, extract the main article,
// and return the key sentences (TextRank) — a quick gist instead of a full
// scrape. No AI, no external calls. ?url=<url>&sentences=<1-10, default 3>
// ----------------------------------------------------------------------------
app.get("/api/summarize", async (req, res) => {
  try {
    if (!req.query.url) {
      return res.status(400).json({ error: "url query param required" });
    }
    let n = parseInt(req.query.sentences, 10);
    if (!Number.isFinite(n) || n < 1) n = 3;
    n = Math.min(n, 10);

    const article = await fetchArticleText(String(req.query.url));
    if (!article.text || article.text.length < 100) {
      return res.status(422).json({ error: "not enough readable text to summarize", url: article.url });
    }

    const { sentences, total } = summarizeText(article.text, n);
    const summary = sentences.join(" ");
    res.json({
      url: article.url,
      title: article.title,
      summary,
      key_sentences: sentences,
      sentences_selected: sentences.length,
      sentences_total: total,
      original_word_count: article.text.split(/\s+/).length,
      summary_word_count: summary.split(/\s+/).length,
      method: "extractive (textrank)",
      ts: new Date().toISOString(),
    });
  } catch (e) {
    const msg = String(e.message || e);
    const status = /url|allowed|content-type|too large/i.test(msg) ? 400 : 502;
    res.status(status).json({ error: "summarize failed", detail: msg });
  }
});

// ----------------------------------------------------------------------------
// MACHINE MESSAGE BOARD (storage lives on GoDaddy: board.php + MySQL).
// These endpoints take payment via x402, then call the private board.php backend
// with the shared secret. Render = payments; GoDaddy = durable storage.
// ----------------------------------------------------------------------------
async function callBoard(action, method, { query = {}, body = null } = {}) {
  if (!BOARD_URL || !BOARD_SECRET) {
    throw new Error("board backend not configured");
  }
  const qs = new URLSearchParams({ action, ...query }).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${BOARD_URL}?${qs}`, {
      method,
      signal: controller.signal,
      headers: {
        "X-Board-Secret": BOARD_SECRET,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const msg = data.error || `board backend error ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

const BOARD_TYPES = ["feature", "critique", "praise", "bug", "tip"];

// PAID: read the board. Newest first, active pins on top.
app.get("/api/board", async (req, res) => {
  try {
    const query = {};
    if (req.query.limit) query.limit = String(req.query.limit);
    if (req.query.type) query.type = String(req.query.type);
    const data = await callBoard("list", "GET", { query });
    res.json({ count: data.count, posts: data.posts, ts: new Date().toISOString() });
  } catch (e) {
    res.status(e.status && e.status < 500 ? e.status : 502).json({ error: "board unavailable", detail: String(e.message) });
  }
});

// Shared post handler for both the regular ($0.002) and sticky ($0.003) routes.
async function handleBoardPost(req, res, pinned) {
  try {
    const b = req.body || {};
    if (!BOARD_TYPES.includes(b.type)) {
      return res.status(400).json({ error: `type must be one of: ${BOARD_TYPES.join(", ")}` });
    }
    if (!b.text || !String(b.text).trim()) {
      return res.status(400).json({ error: "text is required" });
    }
    const data = await callBoard("post", "POST", {
      body: {
        agent: b.agent || "anon",
        type: b.type,
        text: String(b.text),
        pinned: pinned ? 1 : 0,
        days: pinned ? 7 : 0,
        tx_ref: b.tx_ref || null,
      },
    });
    res.json({ ok: true, post: data.post, ts: new Date().toISOString() });
  } catch (e) {
    res.status(e.status && e.status < 500 ? e.status : 502).json({ error: "board post failed", detail: String(e.message) });
  }
}

// PAID: post a message. PAID: post pinned for 7 days.
app.post("/api/board", (req, res) => handleBoardPost(req, res, false));
app.post("/api/board/sticky", (req, res) => handleBoardPost(req, res, true));

// ----------------------------------------------------------------------------
// PAID: email verification. Syntax + MX + disposable/role/free flags.
// ?email=someone@example.com
// ----------------------------------------------------------------------------
app.get("/api/email/verify", async (req, res) => {
  try {
    if (!req.query.email) {
      return res.status(400).json({ error: "email query param required, e.g. ?email=user@example.com" });
    }
    const result = await verifyEmail(String(req.query.email));
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: "verification failed", detail: String(e.message || e) });
  }
});

// ----------------------------------------------------------------------------
// PAID: OG / social-card checker. Extracts OpenGraph + Twitter-card +
// core SEO meta from a URL and reports problems and warnings. ?url=...
// ----------------------------------------------------------------------------
app.get("/api/og/check", async (req, res) => {
  try {
    if (!req.query.url) {
      return res.status(400).json({ error: "url query param required" });
    }
    const { html, finalUrl } = await fetchRawHtml(String(req.query.url));
    const meta = extractMeta(html, finalUrl);
    const audit = auditSocialMeta(meta, finalUrl);

    // Optional reachability check on the og:image itself (HEAD, SSRF-guarded).
    let imageCheck = null;
    if (meta.og.image) {
      try {
        const imgUrl = new URL(meta.og.image, finalUrl).href;
        assertSafeUrl(imgUrl);
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 6000);
        const r = await fetch(imgUrl, { method: "HEAD", redirect: "follow", signal: ctrl.signal });
        clearTimeout(t);
        imageCheck = {
          url: imgUrl,
          reachable: r.ok,
          status: r.status,
          content_type: r.headers.get("content-type"),
        };
        if (r.ok && imageCheck.content_type && !/image\/(png|jpe?g|webp|gif)/i.test(imageCheck.content_type)) {
          audit.warnings.push(`og:image serves content-type '${imageCheck.content_type}' — platforms expect png/jpeg/webp.`);
        }
        if (!r.ok) audit.problems.push(`og:image URL returned HTTP ${r.status} — the preview image is broken.`);
      } catch { imageCheck = { url: meta.og.image, reachable: null, note: "could not verify image (blocked or timed out)" }; }
    }

    res.json({
      url: finalUrl,
      meta,
      image_check: imageCheck,
      problems: audit.problems,
      warnings: audit.warnings,
      verdict: audit.problems.length ? "broken" : audit.warnings.length ? "improvable" : "good",
      ts: new Date().toISOString(),
    });
  } catch (e) {
    const msg = String(e.message || e);
    const status = /url|allowed|content-type|too large/i.test(msg) ? 400 : 502;
    res.status(status).json({ error: "og check failed", detail: msg });
  }
});

// ----------------------------------------------------------------------------
// PAID: social card generator. POST {title, subtitle?, domain?,
// theme?, accent?} → 1200x630 card as PNG (base64) + the source SVG.
// ----------------------------------------------------------------------------
app.post("/api/og/card", async (req, res) => {
  try {
    const b = req.body || {};
    const title = String(b.title || "").trim();
    if (!title) return res.status(400).json({ error: "title is required" });
    if (title.length > 140) return res.status(400).json({ error: "title too long (max 140 chars)" });
    const subtitle = b.subtitle ? String(b.subtitle).slice(0, 200) : null;
    const domain = b.domain ? String(b.domain).slice(0, 60) : null;
    const theme = ["dark", "light", "midnight"].includes(b.theme) ? b.theme : "dark";

    const svg = buildCardSvg({ title, subtitle, domain, theme, accent: b.accent });

    let png_base64 = null;
    let note = null;
    if (sharpLib) {
      try {
        const buf = await sharpLib(Buffer.from(svg)).png().toBuffer();
        png_base64 = buf.toString("base64");
      } catch (err) {
        note = "PNG rasterization failed on this render; SVG returned. " + String(err.message || err);
      }
    } else {
      note = "PNG rendering unavailable; SVG returned. Rasterize to PNG before using as og:image.";
    }

    res.json({
      width: 1200,
      height: 630,
      theme,
      svg,
      png_base64,
      ...(png_base64 ? { data_uri: `data:image/png;base64,${png_base64}` } : {}),
      usage: 'Serve the PNG at a public URL and reference it: <meta property="og:image" content="https://yourdomain.com/card.png">',
      ...(note ? { note } : {}),
      ts: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: "card generation failed", detail: String(e.message || e) });
  }
});

// ----------------------------------------------------------------------------
// PAID: alt-text checker. Audits every image on a page for missing,
// empty, or low-quality alt text. ?url=...
// ----------------------------------------------------------------------------
app.get("/api/seo/alt-check", async (req, res) => {
  try {
    if (!req.query.url) return res.status(400).json({ error: "url query param required" });
    const { html, finalUrl } = await fetchRawHtml(String(req.query.url));
    const result = checkAltText(html, finalUrl);
    res.json({ url: finalUrl, ...result, ts: new Date().toISOString() });
  } catch (e) {
    const msg = String(e.message || e);
    res.status(/url|allowed|content-type|too large/i.test(msg) ? 400 : 502).json({ error: "alt check failed", detail: msg });
  }
});

// ----------------------------------------------------------------------------
// PAID: WCAG contrast check between two colors. Accepts hex or rgb().
// ?fg=&bg=  (aliases: foreground/background, text/bg)
// ----------------------------------------------------------------------------
app.get("/api/a11y/contrast", async (req, res) => {
  const q = req.query;
  const fg = q.fg || q.foreground || q.text || q.color;
  const bg = q.bg || q.background || q.bg_color;
  if (!fg || !bg) {
    return res.status(400).json({ error: "provide two colors: ?fg=#111111&bg=#ffffff (hex or rgb())" });
  }
  const report = contrastReport(String(fg), String(bg));
  if (report.error) return res.status(400).json(report);
  res.json({ ...report, ts: new Date().toISOString() });
});

// ----------------------------------------------------------------------------
// PAID: WCAG accessibility check (static). Findings mapped to WCAG
// success criteria with A/AA/AAA levels. ?url=...&level=A|AA|AAA
// ----------------------------------------------------------------------------
app.get("/api/a11y/check", async (req, res) => {
  try {
    if (!req.query.url) return res.status(400).json({ error: "url query param required" });
    const { html, finalUrl } = await fetchRawHtml(String(req.query.url));
    const result = a11yCheck(html, finalUrl);

    const level = String(req.query.level || "").toUpperCase();
    if (["A", "AA", "AAA"].includes(level)) {
      const allowed = level === "A" ? ["A"] : level === "AA" ? ["A", "AA"] : ["A", "AA", "AAA"];
      result.findings = result.findings.filter((f) => allowed.includes(f.level));
      result.filtered_to = `${level} (includes lower levels)`;
      // Recompute totals so they describe the filtered findings, not the full set.
      const counts = { A: 0, AA: 0, AAA: 0 };
      for (const f of result.findings) counts[f.level] += f.count;
      result.totals = {
        issues: result.findings.reduce((s, f) => s + f.count, 0),
        by_level: counts,
        criteria_failed: result.findings.length,
      };
    }

    res.json({ url: finalUrl, ...result, ts: new Date().toISOString() });
  } catch (e) {
    const msg = String(e.message || e);
    res.status(/url|allowed|content-type|too large/i.test(msg) ? 400 : 502).json({ error: "a11y check failed", detail: msg });
  }
});

// ----------------------------------------------------------------------------
// PAID: robots.txt + llms.txt checker. Crawler access for major search
// and AI bots, declared sitemaps, syntax warnings, llms.txt presence. ?url=
// ----------------------------------------------------------------------------
app.get("/api/seo/robots-check", async (req, res) => {
  try {
    if (!req.query.url) return res.status(400).json({ error: "url query param required (domain or any page on it)" });
    const origin = new URL(assertSafeUrl(String(req.query.url))).origin;

    const [robots, llms, llmsFull] = await Promise.all([
      fetchRawText(`${origin}/robots.txt`, 512 * 1024).catch(() => ({ ok: false })),
      fetchRawText(`${origin}/llms.txt`, 256 * 1024).catch(() => ({ ok: false })),
      fetchRawText(`${origin}/llms-full.txt`, 64 * 1024).catch(() => ({ ok: false })),
    ]);

    let robotsResult;
    if (!robots.ok) {
      robotsResult = { found: false, note: "No robots.txt — all crawlers are allowed everywhere by default." };
    } else {
      const parsed = parseRobots(robots.text);
      const bots = {};
      for (const b of TRACKED_BOTS) bots[b.name] = { kind: b.kind, ...botAccess(parsed, b.name) };
      robotsResult = {
        found: true,
        groups: parsed.groups.length,
        sitemaps_declared: parsed.sitemaps,
        bots,
        syntax_warnings: parsed.warnings.slice(0, 10),
      };
    }

    let llmsResult = { found: false };
    if (llms.ok && llms.text && !/^\s*</.test(llms.text)) { // reject HTML 404 pages
      const lines = llms.text.split(/\r?\n/).filter((l) => l.trim());
      llmsResult = {
        found: true,
        size_bytes: llms.text.length,
        lines: lines.length,
        headings: lines.filter((l) => /^#/.test(l)).slice(0, 10).map((l) => l.slice(0, 80)),
        links: (llms.text.match(/\]\(https?:\/\//g) || []).length,
      };
    }

    res.json({
      origin,
      robots: robotsResult,
      llms_txt: llmsResult,
      llms_full_txt: { found: !!(llmsFull.ok && llmsFull.text && !/^\s*</.test(llmsFull.text)) },
      ts: new Date().toISOString(),
    });
  } catch (e) {
    const msg = String(e.message || e);
    res.status(/url|allowed/i.test(msg) ? 400 : 502).json({ error: "robots check failed", detail: msg });
  }
});

// ----------------------------------------------------------------------------
// PAID: raw metadata extractor. Complete, unopinionated head inventory
// — all meta tags grouped, link relations, title, parsed JSON-LD. ?url=
// ----------------------------------------------------------------------------
app.get("/api/seo/metadata", async (req, res) => {
  try {
    if (!req.query.url) return res.status(400).json({ error: "url query param required" });
    const { html, finalUrl } = await fetchRawHtml(String(req.query.url));
    res.json({ url: finalUrl, ...extractAllMeta(html, finalUrl), ts: new Date().toISOString() });
  } catch (e) {
    const msg = String(e.message || e);
    res.status(/url|allowed|content-type|too large/i.test(msg) ? 400 : 502).json({ error: "metadata extraction failed", detail: msg });
  }
});

// ----------------------------------------------------------------------------
// PAID: head/meta SEO audit. Title, description, robots directives,
// canonical, hreflang, charset/viewport, favicon, H1s. ?url=
// ----------------------------------------------------------------------------
app.get("/api/seo/head-check", async (req, res) => {
  try {
    if (!req.query.url) return res.status(400).json({ error: "url query param required" });
    const { html, finalUrl } = await fetchRawHtml(String(req.query.url));
    res.json({ url: finalUrl, ...headCheck(html, finalUrl), ts: new Date().toISOString() });
  } catch (e) {
    const msg = String(e.message || e);
    res.status(/url|allowed|content-type|too large/i.test(msg) ? 400 : 502).json({ error: "head check failed", detail: msg });
  }
});

// ----------------------------------------------------------------------------
// PAID: sitemap validator. Finds the sitemap (direct, robots.txt, or
// default), validates structure, health-checks a sample of URLs. ?url=
// ----------------------------------------------------------------------------
app.get("/api/seo/sitemap-check", async (req, res) => {
  try {
    if (!req.query.url) return res.status(400).json({ error: "url query param required (site root or sitemap URL)" });
    const result = await sitemapCheck(String(req.query.url));
    res.json({ ...result, ts: new Date().toISOString() });
  } catch (e) {
    const msg = String(e.message || e);
    res.status(/url|allowed/i.test(msg) ? 400 : 502).json({ error: "sitemap check failed", detail: msg });
  }
});

// ----------------------------------------------------------------------------
// PAID: navigation extractor. Pulls a site's nav links (not all links)
// grouped by source region. ?url=
// ----------------------------------------------------------------------------
app.get("/api/seo/nav", async (req, res) => {
  try {
    if (!req.query.url) return res.status(400).json({ error: "url query param required" });
    const { html, finalUrl } = await fetchRawHtml(String(req.query.url));
    res.json({ url: finalUrl, ...extractNav(html, finalUrl), ts: new Date().toISOString() });
  } catch (e) {
    const msg = String(e.message || e);
    res.status(/url|allowed|content-type|too large/i.test(msg) ? 400 : 502).json({ error: "nav extraction failed", detail: msg });
  }
});

// ----------------------------------------------------------------------------
// PAID: internal-link analyzer. Single-page link profile: internal vs
// external, rel attributes, anchor quality, security flags. ?url=
// ----------------------------------------------------------------------------
app.get("/api/seo/links", async (req, res) => {
  try {
    if (!req.query.url) return res.status(400).json({ error: "url query param required" });
    const { html, finalUrl } = await fetchRawHtml(String(req.query.url));
    res.json({ url: finalUrl, ...analyzeLinks(html, finalUrl), ts: new Date().toISOString() });
  } catch (e) {
    const msg = String(e.message || e);
    res.status(/url|allowed|content-type|too large/i.test(msg) ? 400 : 502).json({ error: "link analysis failed", detail: msg });
  }
});

// ----------------------------------------------------------------------------
// PAID: FULL SEO/PUBLISHING AUDIT — the bundle. One call runs the
// head/meta audit, alt-text check, social-card check (with og:image
// verification), link analysis, WCAG static check, schema.org audit, and a
// robots/llms.txt summary against a single URL, plus a 0-100 score.
// One page fetch feeds every analyzer. ?url=&level=A|AA|AAA (a11y, default AA)
// ----------------------------------------------------------------------------
// Core of the full on-page audit, shared by /api/seo/full-audit (one page)
// and /api/seo/site-audit (many pages). Returns the audit object; throws on
// fetch/parse failure.
async function runFullAudit(rawUrl, rawLevel) {
    const { html, finalUrl } = await fetchRawHtml(String(rawUrl));

    // --- On-page analyses (all from the one fetched document) ---
    const head = headCheck(html, finalUrl);
    const alt = checkAltText(html, finalUrl);
    const links = analyzeLinks(html, finalUrl);
    const a11y = a11yCheck(html, finalUrl);
    const level = ["A", "AA", "AAA"].includes(String(rawLevel || "").toUpperCase())
      ? String(rawLevel).toUpperCase() : "AA";
    const allowedLevels = level === "A" ? ["A"] : level === "AA" ? ["A", "AA"] : ["A", "AA", "AAA"];
    a11y.findings = a11y.findings.filter((f) => allowedLevels.includes(f.level));
    a11y.totals = {
      issues: a11y.findings.reduce((s, f) => s + f.count, 0),
      criteria_failed: a11y.findings.length,
    };

    // Social / OG
    const meta = extractMeta(html, finalUrl);
    const social = auditSocialMeta(meta, finalUrl);
    let imageCheck = null;
    if (meta.og.image) {
      try {
        const imgUrl = new URL(meta.og.image, finalUrl).href;
        assertSafeUrl(imgUrl);
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 6000);
        const r = await fetch(imgUrl, { method: "HEAD", redirect: "follow", signal: ctrl.signal });
        clearTimeout(t);
        imageCheck = { url: imgUrl, reachable: r.ok, status: r.status };
        if (!r.ok) social.problems.push(`og:image URL returned HTTP ${r.status}.`);
      } catch { imageCheck = { url: meta.og.image, reachable: null }; }
    }

    // Structured data
    const nodes = extractJsonLd(html).filter((n) => n && n["@type"]);
    const schemaAudits = nodes.map(auditNode);
    const schemaSummary = {
      jsonld_blocks: nodes.length,
      audited: schemaAudits.filter((d) => d.audited_as).length,
      with_missing_required: schemaAudits.filter((d) => d.required_missing?.length || d.one_of_missing?.length).length,
      deprecated_types: schemaAudits.filter((d) => d.rich_result_status === "deprecated").map((d) => d.audited_as),
      detected: schemaAudits,
    };

    // Robots / llms.txt (small extra fetches, capped)
    let robotsSummary = { checked: false };
    try {
      const origin = new URL(finalUrl).origin;
      const [robots, llms] = await Promise.all([
        fetchRawText(`${origin}/robots.txt`, 512 * 1024).catch(() => ({ ok: false })),
        fetchRawText(`${origin}/llms.txt`, 64 * 1024).catch(() => ({ ok: false })),
      ]);
      if (robots.ok) {
        const parsed = parseRobots(robots.text);
        const aiBots = TRACKED_BOTS.filter((b) => b.kind === "ai");
        const blocked = aiBots.filter((b) => botAccess(parsed, b.name).root_blocked).map((b) => b.name);
        robotsSummary = {
          checked: true, found: true,
          sitemaps_declared: parsed.sitemaps.length,
          search_bots_root_blocked: TRACKED_BOTS.filter((b) => b.kind === "search" && botAccess(parsed, b.name).root_blocked).map((b) => b.name),
          ai_bots_root_blocked: blocked,
          llms_txt_found: !!(llms.ok && llms.text && !/^\s*</.test(llms.text)),
        };
      } else {
        robotsSummary = { checked: true, found: false, note: "No robots.txt — all crawlers allowed by default." };
      }
    } catch { /* robots summary stays unchecked */ }

    // --- Scoring: transparent deductions from 100, floors applied per section ---
    let score = 100;
    const deductions = [];
    const ded = (pts, why) => { if (pts > 0) { score -= pts; deductions.push({ points: pts, reason: why }); } };

    ded(head.problems.length * 8, `${head.problems.length} head/meta problems`);
    ded(head.warnings.length * 2, `${head.warnings.length} head/meta warnings`);
    ded(social.problems.length * 6, `${social.problems.length} social-card problems`);
    ded(social.warnings.length * 2, `${social.warnings.length} social-card warnings`);
    ded(Math.min(16, alt.missing_alt * 2), `${alt.missing_alt} images missing alt`);
    ded(Math.min(8, alt.low_quality_alt), `${alt.low_quality_alt} low-quality alts`);
    ded(Math.min(24, a11y.findings.length * 4), `${a11y.findings.length} WCAG criteria failing (${level})`);
    const linkFlags = (links.empty_anchors.length ? 1 : 0) + (links.generic_anchors.length ? 1 : 0) + (links.target_blank_missing_noopener.length ? 1 : 0);
    ded(linkFlags * 2, `${linkFlags} link-quality flag types`);
    ded(schemaSummary.with_missing_required * 3, `${schemaSummary.with_missing_required} schema blocks missing required fields`);
    ded(schemaSummary.deprecated_types.length * 2, `deprecated schema types: ${schemaSummary.deprecated_types.join(", ") || "none"}`);
    score = Math.max(0, Math.round(score));
    const grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";

    return {
      url: finalUrl,
      score,
      grade,
      deductions,
      sections: {
        head,
        social: { meta, image_check: imageCheck, problems: social.problems, warnings: social.warnings, verdict: social.problems.length ? "broken" : social.warnings.length ? "improvable" : "good" },
        alt_text: alt,
        links,
        accessibility: { level_checked: level, ...a11y },
        structured_data: schemaSummary,
        robots: robotsSummary,
      },
      _html: html, // internal: lets the site audit reuse the fetched document for link discovery; stripped before responding
    };
}

app.get("/api/seo/full-audit", async (req, res) => {
  try {
    if (!req.query.url) return res.status(400).json({ error: "url query param required" });
    const audit = await runFullAudit(req.query.url, req.query.level);
    delete audit._html;
    res.json({
      ...audit,
      note: "Score is a transparent sum of deductions (see deductions[]). Sitemap validation is a separate endpoint (/api/seo/sitemap-check).",
      ts: new Date().toISOString(),
    });
  } catch (e) {
    const msg = String(e.message || e);
    res.status(/url|allowed|content-type|too large/i.test(msg) ? 400 : 502).json({ error: "full audit failed", detail: msg });
  }
});

// ----------------------------------------------------------------------------
// PAID: whole-site audit. Runs the full 7-part audit across up to 8
// pages discovered from the start URL's internal links. Per-page scores plus
// a site-level score and the issues that repeat across pages.
// ?url=&pages=&level=&detail=summary|full
// ----------------------------------------------------------------------------
const SITE_AUDIT_SKIP_RE = /\.(pdf|jpe?g|png|gif|webp|svg|ico|css|js|zip|gz|mp[34]|webm|woff2?|ttf|xml|json|txt)(\?|$)/i;

function collectInternalUrls(html, baseUrl, max) {
  const dom = new JSDOM(html, { url: baseUrl });
  const base = new URL(baseUrl);
  const baseHost = base.hostname.replace(/^www\./, "");
  const seen = new Set();
  const urls = [];
  for (const a of dom.window.document.querySelectorAll("a[href]")) {
    let abs;
    try { abs = new URL(a.getAttribute("href") || "", baseUrl); } catch { continue; }
    if (!/^https?:$/.test(abs.protocol)) continue;
    if (abs.hostname.replace(/^www\./, "") !== baseHost) continue;
    abs.hash = "";
    const href = abs.href;
    if (href === base.href || seen.has(href) || SITE_AUDIT_SKIP_RE.test(abs.pathname + abs.search)) continue;
    seen.add(href);
    urls.push(href);
    if (urls.length >= max * 3) break; // gather extra, shallowest-first selection below
  }
  // Prefer shallow paths (top-level sections) over deep leaf pages.
  urls.sort((x, y) => (x.split("/").length - y.split("/").length) || (x.length - y.length));
  return urls.slice(0, max);
}

app.get("/api/seo/site-audit", async (req, res) => {
  try {
    if (!req.query.url) return res.status(400).json({ error: "url query param required" });
    const maxPages = Math.min(8, Math.max(2, parseInt(req.query.pages, 10) || 5));
    const full = String(req.query.detail || "").toLowerCase() === "full";

    // Audit the start page first — its HTML seeds page discovery.
    const start = await runFullAudit(req.query.url, req.query.level);
    const candidates = collectInternalUrls(start._html, start.url, maxPages - 1);
    delete start._html;

    // Audit discovered pages two at a time; a page that fails is reported, not fatal.
    const results = [{ ok: true, audit: start }];
    for (let i = 0; i < candidates.length; i += 2) {
      const batch = await Promise.all(candidates.slice(i, i + 2).map(async (u) => {
        try {
          const audit = await runFullAudit(u, req.query.level);
          delete audit._html;
          return { ok: true, audit };
        } catch (e) {
          return { ok: false, url: u, error: String(e.message || e).slice(0, 200) };
        }
      }));
      results.push(...batch);
    }

    const audited = results.filter((r) => r.ok).map((r) => r.audit);
    const failed = results.filter((r) => !r.ok).map(({ url, error }) => ({ url, error }));

    // Issues that repeat across pages, grouped by deduction reason (counts stripped).
    const issueCounts = {};
    for (const a of audited) {
      for (const d of a.deductions) {
        const reason = d.reason.replace(/^\d+ /, "").replace(/\d+/g, "").trim();
        (issueCounts[reason] ||= new Set()).add(a.url);
      }
    }
    const commonIssues = Object.entries(issueCounts)
      .map(([reason, pages]) => ({ reason, pages_affected: pages.size }))
      .filter((i) => i.pages_affected > 1)
      .sort((a, b) => b.pages_affected - a.pages_affected)
      .slice(0, 15);

    const siteScore = Math.round(audited.reduce((s, a) => s + a.score, 0) / audited.length);
    const grade = siteScore >= 90 ? "A" : siteScore >= 80 ? "B" : siteScore >= 70 ? "C" : siteScore >= 60 ? "D" : "F";

    res.json({
      site: start.url,
      site_score: siteScore,
      grade,
      pages_audited: audited.length,
      ...(failed.length ? { pages_failed: failed } : {}),
      common_issues: commonIssues,
      pages: audited.map((a) => full ? a : {
        url: a.url,
        score: a.score,
        grade: a.grade,
        top_issues: a.deductions.slice(0, 5).map((d) => d.reason),
        section_verdicts: {
          head_problems: a.sections.head.problems?.length ?? 0,
          social: a.sections.social.verdict,
          images_missing_alt: a.sections.alt_text.missing_alt,
          wcag_criteria_failing: a.sections.accessibility.findings?.length ?? 0,
          schema_blocks: a.sections.structured_data.jsonld_blocks,
        },
      }),
      note: full
        ? "detail=full — each pages[] entry is a complete /api/seo/full-audit report."
        : "Summary per page; pass detail=full for complete per-page section reports, or audit one page deeply with /api/seo/full-audit.",
      ts: new Date().toISOString(),
    });
  } catch (e) {
    const msg = String(e.message || e);
    res.status(/url|allowed|content-type|too large/i.test(msg) ? 400 : 502).json({ error: "site audit failed", detail: msg });
  }
});

// ----------------------------------------------------------------------------
// PAID: album metadata via Discogs. ?artist=&title= or ?q= or
// ?id=&kind=master|release. Canonical album data: tracklist, genres, styles,
// year, labels, formats, community stats.
// ----------------------------------------------------------------------------
app.get("/api/music/album", async (req, res) => {
  try {
    const { artist, title, q, id, kind } = req.query;
    if (!q && !id && !(artist && title)) {
      return res.status(400).json({ error: "provide ?artist=&title=, or ?q=, or ?id= (with optional &kind=release)" });
    }
    const resolved = await discogsResolveAlbum({ artist, title, q, id, kind });
    if (!resolved) return res.status(404).json({ error: "no matching album on Discogs", query: q || `${artist} — ${title}` });
    const { found, detail } = resolved;
    const primaryImage = (detail.images || []).find((i) => i.type === "primary") || (detail.images || [])[0] || null;

    res.json({
      source: "discogs",
      discogs_id: Number(found.id),
      discogs_type: found.type,
      title: detail.title || null,
      artists: (detail.artists || []).map((a) => a.name.replace(/ \(\d+\)$/, "")),
      year: detail.year || null,
      genres: detail.genres || [],
      styles: detail.styles || [],
      country: detail.country || null,
      labels: (detail.labels || []).map((l) => l.name),
      formats: (detail.formats || []).map((f) => f.name + (f.descriptions ? ` (${f.descriptions.join(", ")})` : "")),
      tracklist: (detail.tracklist || []).map((t) => ({ position: t.position, title: t.title, duration: t.duration || null })),
      community: detail.community ? { have: detail.community.have, want: detail.community.want, rating: detail.community.rating?.average ?? null } : null,
      cover_url: primaryImage?.uri || found.search_hit?.cover_image || null,
      cover_endpoint: `/api/music/cover?id=${found.id}&kind=${found.type}`,
      discogs_url: detail.uri || null,
      ts: new Date().toISOString(),
    });
  } catch (e) {
    const code = e.code === "no_token" ? 503 : e.code === "rate_limited" ? 429 : e.status === 404 ? 404 : 502;
    res.status(code).json({ error: "album lookup failed", detail: String(e.message || e) });
  }
});

// ----------------------------------------------------------------------------
// PAID: album cover via Discogs. Same selectors as /api/music/album.
// Returns the primary cover as base64 + data URI, with dimensions.
// ----------------------------------------------------------------------------
app.get("/api/music/cover", async (req, res) => {
  try {
    const { artist, title, q, id, kind } = req.query;
    if (!q && !id && !(artist && title)) {
      return res.status(400).json({ error: "provide ?artist=&title=, or ?q=, or ?id= (with optional &kind=release)" });
    }
    const resolved = await discogsResolveAlbum({ artist, title, q, id, kind });
    if (!resolved) return res.status(404).json({ error: "no matching album on Discogs", query: q || `${artist} — ${title}` });
    const { found, detail } = resolved;

    // Prefer the detail's primary image (full resolution) over the search thumb.
    const primary = (detail.images || []).find((i) => i.type === "primary") || (detail.images || [])[0] || null;
    const imageUrl = primary?.uri || found.search_hit?.cover_image || null;
    const meta = {
      title: detail.title || found.search_hit?.title || null,
      year: detail.year || found.search_hit?.year || null,
      ...(primary ? { width: primary.width, height: primary.height } : {}),
    };
    if (!imageUrl) return res.status(404).json({ error: "album found but has no cover image", discogs_id: Number(found.id) });

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12_000);
    const img = await fetch(imageUrl, { signal: ctrl.signal, headers: { "User-Agent": DISCOGS_UA } });
    clearTimeout(t);
    if (!img.ok) return res.status(502).json({ error: `cover fetch failed (${img.status})`, cover_url: imageUrl });
    const buf = Buffer.from(await img.arrayBuffer());
    if (buf.length > 4 * 1024 * 1024) return res.status(502).json({ error: "cover image too large", cover_url: imageUrl });
    const contentType = img.headers.get("content-type") || "image/jpeg";

    res.json({
      source: "discogs",
      discogs_id: Number(found.id),
      discogs_type: found.type,
      ...meta,
      content_type: contentType,
      bytes: buf.length,
      cover_url: imageUrl,
      image_base64: buf.toString("base64"),
      data_uri: `data:${contentType};base64,${buf.toString("base64")}`,
      note: "Cover art may be subject to third-party rights; provided for identification and preview.",
      ts: new Date().toISOString(),
    });
  } catch (e) {
    const code = e.code === "no_token" ? 503 : e.code === "rate_limited" ? 429 : e.status === 404 ? 404 : 502;
    res.status(code).json({ error: "cover lookup failed", detail: String(e.message || e) });
  }
});

// ----------------------------------------------------------------------------
// PAID: document extraction. ?url= to a PDF, DOCX, or CSV → clean
// markdown + structured JSON. ?type=pdf|docx|csv overrides auto-detection;
// ?max_rows= caps CSV rows returned as JSON (default 1000, max 5000).
// ----------------------------------------------------------------------------
app.get("/api/extract", async (req, res) => {
  try {
    if (!req.query.url) {
      return res.status(400).json({ error: "url query param required", usage: "/api/extract?url=https://example.com/report.pdf", supported: ["pdf", "docx", "csv"] });
    }
    const safeUrl = assertSafeUrl(req.query.url);

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20_000);
    let r;
    try {
      r = await fetch(safeUrl, {
        signal: ctrl.signal,
        redirect: "follow",
        headers: { "User-Agent": "x402-extract/1.0 (+https://x402.webbersites.com)", Accept: "*/*" },
      });
    } finally { clearTimeout(t); }
    if (!r.ok) return res.status(502).json({ error: `document fetch failed (${r.status})`, url: safeUrl });
    const declared = Number(r.headers.get("content-length") || 0);
    if (declared > EXTRACT_MAX_BYTES) {
      return res.status(413).json({ error: `document too large (${declared} bytes; cap is ${EXTRACT_MAX_BYTES})`, url: safeUrl });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > EXTRACT_MAX_BYTES) {
      return res.status(413).json({ error: `document too large (${buf.length} bytes; cap is ${EXTRACT_MAX_BYTES})`, url: safeUrl });
    }

    const contentType = r.headers.get("content-type") || "";
    const docType = sniffDocType(buf, contentType, new URL(safeUrl).pathname, req.query.type);
    if (!docType) {
      return res.status(415).json({
        error: "unsupported or undetectable document type",
        content_type: contentType || null,
        supported: ["pdf", "docx", "csv"],
        hint: "Pass ?type=pdf|docx|csv to force a parser. Legacy binary .doc is not supported — convert to .docx.",
      });
    }

    let extracted;
    if (docType === "pdf") extracted = await extractPdf(buf);
    else if (docType === "docx") extracted = await extractDocx(buf);
    else extracted = extractCsv(buf, { maxRows: Math.min(5000, Math.max(1, Number(req.query.max_rows) || 1000)) });

    res.json({ url: safeUrl, content_type: contentType || null, bytes: buf.length, ...extracted, ts: new Date().toISOString() });
  } catch (e) {
    const msg = String(e.message || e);
    if (e.code === "no_parser") return res.status(503).json({ error: "extraction failed", detail: msg });
    if (e.name === "AbortError") return res.status(504).json({ error: "extraction failed", detail: "document fetch timed out (20s)" });
    if (/invalid url|not allowed|http\/https/.test(msg)) return res.status(400).json({ error: "extraction failed", detail: msg });
    // Anything else is a parse failure (corrupt file, ZIP that isn't a DOCX, …).
    res.status(422).json({ error: "extraction failed", detail: msg });
  }
});

// ----------------------------------------------------------------------------
// PAID: Font Awesome icon search. Find icons by keyword before
// generating. ?q=&style=solid|regular|brands
// ----------------------------------------------------------------------------
app.get("/api/icon/search", async (req, res) => {
  if (!FA_ICONS) return res.status(503).json({ error: "icon library not available on this deployment" });
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "q query param required" });
  const style = ["solid", "regular", "brands"].includes(req.query.style) ? req.query.style : null;
  const results = faSearch(q, style).map(({ icon, score }) => ({
    name: icon.name, label: icon.label, styles: Object.keys(icon.styles), score,
    terms: icon.terms.slice(0, 6),
  }));
  res.json({ query: q, ...(style ? { style } : {}), count: results.length, results,
    note: "Use a result's name as ?icon= in POST /api/icon/generate.", ts: new Date().toISOString() });
});

// ----------------------------------------------------------------------------
// PAID: icon generator. POST {query|icon, style?, colors?, fg?,
// shape?, size?, padding?} → app-icon-ready SVG + PNG (base64). Defaults to
// 1024x1024 opaque squircle — drop-in for iOS app icons.
// ----------------------------------------------------------------------------
app.post("/api/icon/generate", async (req, res) => {
  try {
    if (!FA_ICONS) return res.status(503).json({ error: "icon library not available on this deployment" });
    const b = req.body || {};
    const wantStyle = ["solid", "regular", "brands"].includes(b.style) ? b.style : null;

    // Resolve the icon: exact name first, then best search match.
    let icon = null, alternatives = [];
    if (b.icon && FA_ICONS.has(String(b.icon).toLowerCase())) {
      icon = FA_ICONS.get(String(b.icon).toLowerCase());
    } else {
      const q = String(b.icon || b.query || "").trim();
      if (!q) return res.status(400).json({ error: "provide query (search text) or icon (exact Font Awesome name)" });
      const matches = faSearch(q, wantStyle);
      if (!matches.length) return res.status(404).json({ error: `no Font Awesome icon matches "${q}"`, hint: "try /api/icon/search" });
      icon = matches[0].icon;
      alternatives = matches.slice(1, 6).map((m) => m.icon.name);
    }
    const style = wantStyle && icon.styles[wantStyle] ? wantStyle : Object.keys(icon.styles)[0];
    const glyph = icon.styles[style];
    if (!glyph) return res.status(404).json({ error: `icon "${icon.name}" has no ${wantStyle} style`, available: Object.keys(icon.styles) });

    const size = Math.min(1024, Math.max(64, parseInt(b.size, 10) || 1024));
    const svg = buildIconSvg(glyph, { size, colors: b.colors ?? b.color, fg: b.fg, shape: b.shape, padding: b.padding });

    let png_base64 = null, note = null;
    if (sharpLib) {
      try { png_base64 = (await sharpLib(Buffer.from(svg)).png().toBuffer()).toString("base64"); }
      catch (err) { note = "PNG rasterization failed; SVG returned. " + String(err.message || err); }
    } else note = "PNG rendering unavailable; SVG returned.";

    res.json({
      icon: { name: icon.name, label: icon.label, style },
      ...(alternatives.length ? { alternatives } : {}),
      size, width: size, height: size,
      svg,
      png_base64,
      ...(png_base64 ? { data_uri: `data:image/png;base64,${png_base64}` } : {}),
      attribution: "Icon from Font Awesome Free (fontawesome.com), CC BY 4.0.",
      ...(String(b.shape) === "transparent" ? { transparency_note: "PNG has an alpha background — great for favicons/UI, but iOS App Store icons must be opaque (use a shaped background for those)." } : {}),
      ...(note ? { note } : {}),
      ts: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: "icon generation failed", detail: String(e.message || e) });
  }
});

// ----------------------------------------------------------------------------
// PAID: logo generator. POST {name, tagline?, query|icon, layout?,
// shape?, colors?, font?, fg?, bg?} → finished logo as SVG + PNG. Stacked
// layouts (top/bottom) give a square canvas; side layouts (left/right) give a
// wide lockup sized to the text. Font: named from the pool, or random.
// ----------------------------------------------------------------------------
app.post("/api/logo/generate", async (req, res) => {
  try {
    if (!FA_ICONS) return res.status(503).json({ error: "icon library not available on this deployment" });
    if (!opentypeLib || !logoFontsReady()) return res.status(503).json({ error: "logo fonts not available on this deployment" });
    const b = req.body || {};

    const name = String(b.name || "").trim();
    if (!name) return res.status(400).json({ error: "name is required — the company/product wordmark text" });
    if (name.length > 40) return res.status(400).json({ error: "name too long (max 40 chars)" });
    const tagline = b.tagline ? String(b.tagline).trim().slice(0, 60) : null;

    // Resolve the icon mark: exact name first, then best search match.
    const wantStyle = ["solid", "regular", "brands"].includes(b.style) ? b.style : null;
    let icon = null, alternatives = [];
    if (b.icon && FA_ICONS.has(String(b.icon).toLowerCase())) {
      icon = FA_ICONS.get(String(b.icon).toLowerCase());
    } else {
      const q = String(b.icon || b.query || "").trim();
      if (!q) return res.status(400).json({ error: "provide query (search text) or icon (exact Font Awesome name) for the mark" });
      const matches = faSearch(q, wantStyle);
      if (!matches.length) return res.status(404).json({ error: `no Font Awesome icon matches "${q}"`, hint: "try /api/icon/search" });
      icon = matches[0].icon;
      alternatives = matches.slice(1, 6).map((m) => m.icon.name);
    }
    const style = wantStyle && icon.styles[wantStyle] ? wantStyle : Object.keys(icon.styles)[0];
    const glyph = icon.styles[style];

    // Colors: 1-3, hex or CSS names. Default: house dark.
    const rawColors = (Array.isArray(b.colors) ? b.colors : b.colors ? [b.colors] : ["#0d0e11"]).slice(0, 3);
    const colors = rawColors.map(resolveColor);
    const badIdx = colors.findIndex((c) => !c);
    if (badIdx >= 0) return res.status(400).json({ error: `unrecognized color "${rawColors[badIdx]}" — use hex (#ff6b35) or a CSS color name (navy, coral, …)` });

    const layout = ["top", "bottom", "left", "right"].includes(b.layout) ? b.layout : "bottom";
    const shape = ["squircle", "rounded", "circle", "square", "transparent"].includes(b.shape) ? b.shape : "squircle";
    const fg = b.fg && resolveColor(b.fg) ? resolveColor(b.fg) : null;
    const bg = b.bg && resolveColor(b.bg) ? resolveColor(b.bg) : null;

    // Font: named from the pool, or random ("rotates" between calls).
    const available = Object.entries(LOGO_FONTS).filter(([, f]) => f.font);
    let fontKey = String(b.font || "").toLowerCase();
    if (!LOGO_FONTS[fontKey]?.font) fontKey = available[Math.floor(Math.random() * available.length)][0];
    const fontEntry = LOGO_FONTS[fontKey];

    const { svg, width, height } = buildLogoSvg({ name, tagline, glyph, layout, shape, colors, fg, fontEntry, bg });

    let png_base64 = null, note = null;
    if (sharpLib) {
      try { png_base64 = (await sharpLib(Buffer.from(svg)).png().toBuffer()).toString("base64"); }
      catch (err) { note = "PNG rasterization failed; SVG returned. " + String(err.message || err); }
    } else note = "PNG rendering unavailable; SVG returned.";

    res.json({
      name, ...(tagline ? { tagline } : {}),
      icon: { name: icon.name, label: icon.label, style },
      ...(alternatives.length ? { alternative_icons: alternatives } : {}),
      font: { key: fontKey, label: fontEntry.label, pool: Object.keys(LOGO_FONTS) },
      layout, shape, colors_used: colors,
      width, height,
      svg,
      png_base64,
      ...(png_base64 ? { data_uri: `data:image/png;base64,${png_base64}` } : {}),
      attribution: "Mark from Font Awesome Free (fontawesome.com), CC BY 4.0. Fonts under the SIL Open Font License.",
      ...(note ? { note } : {}),
      ts: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: "logo generation failed", detail: String(e.message || e) });
  }
});

// ----------------------------------------------------------------------------
// PAID: brand kit bundle. One call → logo + 1024px app icon + 1200x630
// social card + a WCAG-checked palette, all from the same mark, colors, and
// font. Composes the same engines as /api/logo/generate, /api/icon/generate,
// and /api/og/card. POST {name, tagline?, query|icon, colors?, layout?,
// shape?, font?, theme?, domain?}
// ----------------------------------------------------------------------------
function mixHex(hexA, hexB, t) {
  const a = hexA.replace("#", ""), b = hexB.replace("#", "");
  const ch = (i) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t)
    .toString(16).padStart(2, "0");
  return `#${ch(0)}${ch(2)}${ch(4)}`;
}

app.post("/api/brand/kit", async (req, res) => {
  try {
    if (!FA_ICONS) return res.status(503).json({ error: "icon library not available on this deployment" });
    if (!opentypeLib || !logoFontsReady()) return res.status(503).json({ error: "logo fonts not available on this deployment" });
    const b = req.body || {};

    const name = String(b.name || "").trim();
    if (!name) return res.status(400).json({ error: "name is required — the company/product name" });
    if (name.length > 40) return res.status(400).json({ error: "name too long (max 40 chars)" });
    const tagline = b.tagline ? String(b.tagline).trim().slice(0, 60) : null;
    const domain = b.domain ? String(b.domain).slice(0, 60) : null;

    // Resolve the mark: exact name first, then best search match.
    const wantStyle = ["solid", "regular", "brands"].includes(b.style) ? b.style : null;
    let icon = null, alternatives = [];
    if (b.icon && FA_ICONS.has(String(b.icon).toLowerCase())) {
      icon = FA_ICONS.get(String(b.icon).toLowerCase());
    } else {
      const q = String(b.icon || b.query || "").trim();
      if (!q) return res.status(400).json({ error: "provide query (search text) or icon (exact Font Awesome name) for the mark" });
      const matches = faSearch(q, wantStyle);
      if (!matches.length) return res.status(404).json({ error: `no Font Awesome icon matches "${q}"`, hint: "try /api/icon/search" });
      icon = matches[0].icon;
      alternatives = matches.slice(1, 6).map((m) => m.icon.name);
    }
    const style = wantStyle && icon.styles[wantStyle] ? wantStyle : Object.keys(icon.styles)[0];
    const glyph = icon.styles[style];

    const rawColors = (Array.isArray(b.colors) ? b.colors : b.colors ? [b.colors] : ["#0d0e11"]).slice(0, 3);
    const colors = rawColors.map(resolveColor);
    const badIdx = colors.findIndex((c) => !c);
    if (badIdx >= 0) return res.status(400).json({ error: `unrecognized color "${rawColors[badIdx]}" — use hex (#ff6b35) or a CSS color name (navy, coral, …)` });

    const layout = ["top", "bottom", "left", "right"].includes(b.layout) ? b.layout : "bottom";
    const shape = ["squircle", "rounded", "circle", "square"].includes(b.shape) ? b.shape : "squircle";
    const theme = ["dark", "light", "midnight"].includes(b.theme) ? b.theme : "dark";

    const available = Object.entries(LOGO_FONTS).filter(([, f]) => f.font);
    let fontKey = String(b.font || "").toLowerCase();
    if (!LOGO_FONTS[fontKey]?.font) fontKey = available[Math.floor(Math.random() * available.length)][0];
    const fontEntry = LOGO_FONTS[fontKey];

    // The three assets, from the same mark + colors + font.
    const logo = buildLogoSvg({ name, tagline, glyph, layout, shape, colors, fg: null, fontEntry, bg: null });
    const iconSvg = buildIconSvg(glyph, { size: 1024, colors: colors.slice(0, 2), fg: b.fg, shape });
    const cardSvg = buildCardSvg({ title: name, subtitle: tagline, domain, theme, accent: colors[0] });

    const rasterize = async (svg) => {
      if (!sharpLib) return null;
      try { return (await sharpLib(Buffer.from(svg)).png().toBuffer()).toString("base64"); }
      catch { return null; }
    };
    const [logoPng, iconPng, cardPng] = await Promise.all([rasterize(logo.svg), rasterize(iconSvg), rasterize(cardSvg)]);

    // Palette: brand colors plus neutrals and WCAG-checked text pairings.
    const primary = colors[0];
    const onPrimary = (contrastReport("#ffffff", primary).contrast_ratio || 0) >= (contrastReport("#111111", primary).contrast_ratio || 0) ? "#ffffff" : "#111111";
    const palette = {
      primary,
      ...(colors[1] ? { secondary: colors[1] } : {}),
      ...(colors[2] ? { accent: colors[2] } : {}),
      primary_tint: mixHex(primary, "#ffffff", 0.85),
      primary_shade: mixHex(primary, "#000000", 0.35),
      ink: "#16181d",
      paper: "#ffffff",
      on_primary: onPrimary,
      on_primary_contrast: contrastReport(onPrimary, primary).contrast_ratio ?? null,
      text_on_paper: "#16181d",
    };

    res.json({
      name, ...(tagline ? { tagline } : {}),
      icon_used: { name: icon.name, label: icon.label, style },
      ...(alternatives.length ? { alternative_icons: alternatives } : {}),
      font: { key: fontKey, label: fontEntry.label },
      layout, shape, theme, colors_used: colors,
      logo: { width: logo.width, height: logo.height, svg: logo.svg, ...(logoPng ? { png_base64: logoPng } : {}) },
      icon: { width: 1024, height: 1024, svg: iconSvg, ...(iconPng ? { png_base64: iconPng } : {}) },
      og_card: { width: 1200, height: 630, svg: cardSvg, ...(cardPng ? { png_base64: cardPng } : {}) },
      palette,
      attribution: "Mark from Font Awesome Free (fontawesome.com), CC BY 4.0. Fonts under the SIL Open Font License.",
      ...(sharpLib ? {} : { note: "PNG rendering unavailable; SVGs returned." }),
      ts: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: "brand kit generation failed", detail: String(e.message || e) });
  }
});

// ----------------------------------------------------------------------------
// PAID: image vectorization via the Vectorizer.AI API (paid upstream
// account; credentials via VECTORIZER_API_ID + VECTORIZER_API_SECRET env vars,
// or a full VECTORIZER_AUTH Basic header). POST {url} or {image_base64} →
// production-quality vector output (SVG default; png/pdf/eps/dxf available).
// Upstream credit usage is surfaced in the response (X-Credits-Charged).
// ----------------------------------------------------------------------------
const VECTORIZER_AUTH = process.env.VECTORIZER_AUTH
  || (process.env.VECTORIZER_API_ID && process.env.VECTORIZER_API_SECRET
      ? "Basic " + Buffer.from(`${process.env.VECTORIZER_API_ID}:${process.env.VECTORIZER_API_SECRET}`).toString("base64")
      : null);
console.log(VECTORIZER_AUTH ? "✓ Vectorizer.AI credentials present" : "⚠ VECTORIZER_API_ID/SECRET not set — /api/vectorize will 503");

const VECTORIZE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB input image cap
const VECTORIZE_FORMATS = ["svg", "png", "pdf", "eps", "dxf"];

app.post("/api/vectorize", async (req, res) => {
  try {
    if (!VECTORIZER_AUTH) return res.status(503).json({ error: "vectorization not available on this deployment (upstream credentials not configured)" });
    const b = req.body || {};

    // Input: a public image URL (fetched server-side, SSRF-guarded) or base64.
    let imgBuf = null, sourceNote = null;
    if (b.image_base64) {
      try { imgBuf = Buffer.from(String(b.image_base64).replace(/^data:[^,]*,/, ""), "base64"); }
      catch { return res.status(400).json({ error: "image_base64 is not valid base64" }); }
      sourceNote = "base64 upload";
    } else if (b.url) {
      const safeUrl = assertSafeUrl(String(b.url));
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20_000);
      let r;
      try {
        r = await fetch(safeUrl, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": "x402-vectorize/1.0 (+https://x402.webbersites.com)" } });
      } finally { clearTimeout(t); }
      if (!r.ok) return res.status(502).json({ error: `image fetch failed (${r.status})`, url: safeUrl });
      const ct = (r.headers.get("content-type") || "").toLowerCase();
      if (ct && !/image\/(png|jpe?g|gif|bmp|webp)/.test(ct)) {
        return res.status(415).json({ error: `URL is not a supported image (content-type: ${ct})`, supported: "png, jpeg, gif, bmp, webp" });
      }
      imgBuf = Buffer.from(await r.arrayBuffer());
      sourceNote = safeUrl;
    } else {
      return res.status(400).json({ error: "provide url (public image URL) or image_base64", supported_input: "png, jpeg, gif, bmp, webp" });
    }
    if (!imgBuf.length) return res.status(400).json({ error: "empty image" });
    if (imgBuf.length > VECTORIZE_MAX_BYTES) return res.status(413).json({ error: `image too large (${imgBuf.length} bytes; cap is ${VECTORIZE_MAX_BYTES})` });

    const outputFormat = VECTORIZE_FORMATS.includes(String(b.output_format || "").toLowerCase()) ? String(b.output_format).toLowerCase() : "svg";
    const mode = ["production", "preview", "test"].includes(String(b.mode || "").toLowerCase()) ? String(b.mode).toLowerCase() : "production";

    // Curated processing/output settings (validated here), mapped to
    // Vectorizer.AI's dotted form fields.
    const maxColors = Number.isInteger(b.max_colors) && b.max_colors >= 0 && b.max_colors <= 256 ? b.max_colors : null;
    const palette = Array.isArray(b.palette)
      ? b.palette.slice(0, 256).map(resolveColor).filter(Boolean).join(" ") || null
      : typeof b.palette === "string" ? b.palette.trim() || null : null;
    const drawStyle = ["fill_shapes", "stroke_shapes", "stroke_edges"].includes(b.draw_style) ? b.draw_style : null;
    const groupBy = ["none", "color", "parent", "layer"].includes(b.group_by) ? b.group_by : null;
    const scale = Number.isFinite(Number(b.scale)) && Number(b.scale) > 0 && Number(b.scale) <= 100 ? Number(b.scale) : null;
    const minAreaPx = Number.isFinite(Number(b.min_area_px)) && Number(b.min_area_px) >= 0 && Number(b.min_area_px) <= 10_000 ? Number(b.min_area_px) : null;

    const form = new FormData();
    form.append("image", new Blob([imgBuf]), "image");
    form.append("mode", mode);
    form.append("output.file_format", outputFormat);
    if (maxColors != null) form.append("processing.max_colors", String(maxColors));
    if (palette) form.append("processing.palette", palette);
    if (drawStyle) form.append("output.draw_style", drawStyle);
    if (groupBy) form.append("output.group_by", groupBy);
    if (scale != null) form.append("output.size.scale", String(scale));
    if (minAreaPx != null) form.append("processing.shapes.min_area_px", String(minAreaPx));

    // Raw passthrough for any other documented Vectorizer.AI option
    // (https://vectorizer.ai/api docs): { "options": { "output.gap_filler.enabled": false, … } }.
    // Keys are prefix-whitelisted; bad values surface as the upstream 400 detail.
    const applied_options = {};
    if (b.options && typeof b.options === "object" && !Array.isArray(b.options)) {
      for (const [k, v] of Object.entries(b.options).slice(0, 20)) {
        if (/^(input|processing|output|policy)\.[a-z0-9_.]+$/i.test(k) && ["string", "number", "boolean"].includes(typeof v)) {
          form.append(k, String(v));
          applied_options[k] = v;
        }
      }
    }

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 90_000); // vectorization can take a while on large images
    let vr;
    try {
      vr = await fetch("https://vectorizer.ai/api/v1/vectorize", {
        method: "POST",
        signal: ctrl.signal,
        headers: { Authorization: VECTORIZER_AUTH },
        body: form,
      });
    } finally { clearTimeout(t); }

    if (!vr.ok) {
      let detail = "";
      try { detail = (await vr.text()).slice(0, 400); } catch { /* ignore */ }
      const status = vr.status === 401 || vr.status === 403 ? 503 : vr.status === 429 ? 429 : 502;
      return res.status(status).json({ error: `vectorization failed upstream (${vr.status})`, detail });
    }

    const outBuf = Buffer.from(await vr.arrayBuffer());
    const contentType = vr.headers.get("content-type") || (outputFormat === "svg" ? "image/svg+xml" : "application/octet-stream");
    const creditsCharged = vr.headers.get("x-credits-charged");
    const creditsCalculated = vr.headers.get("x-credits-calculated");

    res.json({
      source: sourceNote,
      mode,
      output_format: outputFormat,
      settings: {
        ...(maxColors != null ? { max_colors: maxColors } : {}),
        ...(palette ? { palette } : {}),
        ...(drawStyle ? { draw_style: drawStyle } : {}),
        ...(groupBy ? { group_by: groupBy } : {}),
        ...(scale != null ? { scale } : {}),
        ...(minAreaPx != null ? { min_area_px: minAreaPx } : {}),
        ...(Object.keys(applied_options).length ? { options: applied_options } : {}),
      },
      content_type: contentType,
      input_bytes: imgBuf.length,
      output_bytes: outBuf.length,
      ...(outputFormat === "svg"
        ? { svg: outBuf.toString("utf8") }
        : { image_base64: outBuf.toString("base64"), data_uri: `data:${contentType};base64,${outBuf.toString("base64")}` }),
      ...(creditsCharged ? { upstream_credits_charged: Number(creditsCharged) || creditsCharged } : {}),
      ...(creditsCalculated ? { upstream_credits_calculated: Number(creditsCalculated) || creditsCalculated } : {}),
      ...(mode !== "production" ? { note: `${mode} mode output may be watermarked/reduced — use mode:"production" for final assets.` } : {}),
      engine: "vectorizer.ai",
      ts: new Date().toISOString(),
    });
  } catch (e) {
    const msg = String(e.message || e);
    if (e.name === "AbortError") return res.status(504).json({ error: "vectorization timed out", detail: "try a smaller image" });
    if (/invalid url|not allowed|http\/https/.test(msg)) return res.status(400).json({ error: "vectorization failed", detail: msg });
    res.status(502).json({ error: "vectorization failed", detail: msg });
  }
});

// ----------------------------------------------------------------------------
// PAID: Webbie page generator. POST {site_name, headline, seed?, …} →
// finished standalone HTML page. Same seed = same template/fonts/accent, so a
// series of calls produces a consistent site. Nav loads from nav.json at
// view-time (inline fallback baked in), so menus stay editable after the fact.
// ----------------------------------------------------------------------------
// Parse one page's worth of Webbie params from a request body. Shared by
// /api/website/page (single page) and /api/website/build (many pages). Returns
// { error } on bad input, else { p, pageName, fileName, seed, nav } ready for
// buildWebbiePage(p).
function webbiePageParams(b) {
    const siteName = String(b.site_name || "").trim().slice(0, 60);
    if (!siteName) return { error: "site_name is required" };
    const headline = String(b.headline || siteName).trim().slice(0, 140);
    const pageName = (String(b.page_name || "home").trim().toLowerCase().replace(/[^a-z0-9 _-]/g, "").replace(/[\s_]+/g, "-") || "home").slice(0, 40);
    const fileName = pageName === "home" ? "index.html" : `${pageName}.html`;
    const seed = String(b.seed || "").trim().slice(0, 64) || crypto.randomUUID().slice(0, 8);

    // Colors (optional, hex or CSS names)
    const rawColors = (Array.isArray(b.colors) ? b.colors : b.colors ? [b.colors] : []).slice(0, 2);
    const colors = rawColors.map(resolveColor);
    const badIdx = colors.findIndex((c) => !c);
    if (badIdx >= 0) return { error: `unrecognized color "${rawColors[badIdx]}" — use hex or a CSS color name` };

    // Hero images (validated http(s) URLs, max 8)
    const heroImages = (Array.isArray(b.hero_images) ? b.hero_images : b.hero_image ? [b.hero_image] : [])
      .map(webbieSafeImg).filter(Boolean).slice(0, 8);

    // Logo: explicit URL, auto-generated mark (via the logo engine), or none.
    let logoHtml = "";
    const logoUrl = webbieSafeImg(b.logo_url);
    if (logoUrl) {
      logoHtml = `<img src="${webbieEsc(logoUrl)}" alt="">`;
    } else if (b.logo && typeof b.logo === "object" && FA_ICONS) {
      const q = String(b.logo.icon || b.logo.query || "").trim();
      const icon = q && FA_ICONS.has(q.toLowerCase()) ? FA_ICONS.get(q.toLowerCase()) : q ? (faSearch(q, null)[0]?.icon || null) : null;
      if (icon) {
        const glyph = icon.styles[Object.keys(icon.styles)[0]];
        const markColors = (Array.isArray(b.logo.colors) ? b.logo.colors.map(resolveColor).filter(Boolean) : []).slice(0, 2);
        const bgColors = markColors.length ? markColors : [colors[0] || "#17181c"];
        logoHtml = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">${logoMarkGroup(glyph, { size: 64, x: 0, y: 0, bgColors, fg: "#ffffff", shape: ["squircle", "rounded", "circle", "square"].includes(b.logo.shape) ? b.logo.shape : "squircle", gradId: "wb" })}</svg>`;
      }
    }

    // Nav: provided links, or a sensible default that includes this page.
    let nav = Array.isArray(b.nav)
      ? b.nav.slice(0, 10).map((l) => ({ label: String(l.label || "").slice(0, 30), href: webbieSafeHref(l.href) || "#" })).filter((l) => l.label)
      : null;
    if (!nav || !nav.length) {
      nav = [{ label: "Home", href: "index.html" }];
      if (fileName !== "index.html") nav.push({ label: pageName.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), href: fileName });
    }

    // Content sections
    const content = (Array.isArray(b.content) ? b.content : []).slice(0, 12).map((s) => ({
      heading: String(s.heading || "").slice(0, 120),
      body: String(s.body || s.text || "").slice(0, 8000),
    })).filter((s) => s.heading || s.body);

    const cta = b.cta && typeof b.cta === "object" ? { text: String(b.cta.text || "").slice(0, 60), href: b.cta.href } : null;

    const p = {
      seed,
      template: String(b.template || "").toLowerCase(),
      siteName, headline,
      title: String(b.title || "").trim().slice(0, 120) || `${headline === siteName ? siteName : `${siteName} · ${headline}`}`,
      caption: String(b.caption || "").trim().slice(0, 120) || null,
      tagline: String(b.tagline || "").trim().slice(0, 300) || null,
      heroImages, logoHtml, nav, content, cta, colors,
      footerText: String(b.footer || "").trim().slice(0, 200) || null,
      pageFile: fileName,
    };
    return { p, pageName, fileName, seed, nav };
}

app.post("/api/website/page", async (req, res) => {
  try {
    const parsed = webbiePageParams(req.body || {});
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { p, pageName, fileName, seed, nav } = parsed;

    const { html, template, style } = buildWebbiePage(p);

    res.json({
      seed,
      template,
      templates_available: WEBBIE_TEMPLATE_KEYS,
      page_name: pageName,
      filename: fileName,
      title: p.title,
      style,
      html,
      html_bytes: Buffer.byteLength(html),
      nav_json: { links: nav },
      notes: [
        `Reuse seed "${seed}" (and the same colors) on future calls to keep every page in the same template, fonts, and accent — that's how you build a whole site.`,
        `Save the HTML as ${fileName} and nav_json as nav.json in the same folder; edit nav.json anytime to update the menu on every generated page without regenerating.`,
        "Pass template to force one of templates_available; omit it to let the seed decide.",
      ],
      ts: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: "page generation failed", detail: String(e.message || e) });
  }
});

// ----------------------------------------------------------------------------
// AGENT DATASTORE ENGINE. Wallet-scoped persistent storage: one SQLite file
// per payer wallet on the persistent disk. The verified X-PAYMENT wallet IS
// the namespace — no accounts, no keys. Uses node:sqlite (Node >= 22.13);
// endpoints 503 gracefully if unavailable (set NODE_VERSION on Render).
// ----------------------------------------------------------------------------
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
  console.log("✓ node:sqlite loaded (agent datastore enabled)");
} catch {
  console.log("⚠ node:sqlite unavailable — /api/store endpoints will 503 (needs Node >= 22.13)");
}

const DATASTORE_DIR = process.env.DATASTORE_DIR || path.join(path.dirname(HITS_LOG), "datastore");
const STORE = {
  ROW_BYTES: 16 * 1024,
  ROWS_PER_POST: 1000,
  ROWS_PER_COLLECTION: 100_000,
  COLLECTIONS_PER_WALLET: 50,
  WALLET_BYTES: 50 * 1024 * 1024,
  BODY_BYTES: 5 * 1024 * 1024,
  TTL_MS: (Number(process.env.STORE_TTL_DAYS) || 90) * 24 * 3600 * 1000,
  POOL_MAX: 20,
};
const STORE_WALLET_RE = /^0x[0-9a-f]{40}$/; // payerFromRequest lowercases
const STORE_COLLECTION_RE = /^[a-zA-Z0-9_-]{1,64}$/;

const storePool = new Map(); // wallet -> { db, last }

function storePathFor(wallet) {
  // wallet is regex-validated before this is called — no path traversal possible
  return path.join(DATASTORE_DIR, `${wallet}.sqlite`);
}

function storeHttpError(status, message) {
  return Object.assign(new Error(message), { httpStatus: status });
}

function openWalletDb(wallet, { create = false } = {}) {
  if (!DatabaseSync) throw storeHttpError(503, "datastore not available on this deployment (needs Node >= 22.13)");
  if (!STORE_WALLET_RE.test(wallet)) throw storeHttpError(400, "invalid payer wallet");
  const pooled = storePool.get(wallet);
  if (pooled) { pooled.last = Date.now(); return pooled.db; }
  const file = storePathFor(wallet);
  if (!create && !fs.existsSync(file)) return null;
  fs.mkdirSync(DATASTORE_DIR, { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS collections (
      name TEXT PRIMARY KEY,
      created_at INTEGER,
      row_count INTEGER DEFAULT 0,
      schema_json TEXT
    );
    CREATE TABLE IF NOT EXISTS rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rows_coll ON rows(collection, id);
    CREATE INDEX IF NOT EXISTS idx_rows_created ON rows(collection, created_at);
  `);
  if (storePool.size >= STORE.POOL_MAX) {
    let oldestKey = null, oldestAt = Infinity;
    for (const [k, v] of storePool) if (v.last < oldestAt) { oldestAt = v.last; oldestKey = k; }
    try { storePool.get(oldestKey).db.close(); } catch { /* already closed */ }
    storePool.delete(oldestKey);
  }
  storePool.set(wallet, { db, last: Date.now() });
  return db;
}

function closeWalletDb(wallet) {
  const pooled = storePool.get(wallet);
  if (pooled) { try { pooled.db.close(); } catch { /* noop */ } storePool.delete(wallet); }
}

// Payer wallet for store routes. Paywall guarantees payment, but be defensive:
// never write to a null namespace.
function storeWallet(req, res) {
  const payer = payerFromRequest(req);
  if (!payer || !STORE_WALLET_RE.test(payer)) {
    res.status(400).json({ error: "could not determine payer wallet from X-PAYMENT — datastore requires a wallet identity" });
    return null;
  }
  return payer;
}

function storeErrorOut(res, e) {
  const status = e.httpStatus || (/ENOSPC|disk/i.test(String(e.message)) ? 507 : 500);
  res.status(status).json({ error: String(e.message || e) });
}

// Parse POST body → array of plain-object rows. CSV (via csv-parse) or JSON.
function storeParseRows(req) {
  const raw = req.body;
  const isCsv = typeof raw === "string";
  if (isCsv) {
    if (Buffer.byteLength(raw) > STORE.BODY_BYTES) throw storeHttpError(413, "body exceeds 5MB limit");
    if (!csvParseFn) throw storeHttpError(503, "CSV parsing not available on this deployment — POST JSON instead");
    let rows;
    try {
      rows = csvParseFn(raw, { columns: true, skip_empty_lines: true, trim: true });
    } catch (e) { throw storeHttpError(400, `CSV parse failed: ${String(e.message).slice(0, 200)}`); }
    return rows;
  }
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Object.keys(raw).length) return [raw];
  throw storeHttpError(400, "body must be a JSON object, a JSON array of objects, or CSV with a text/csv content-type");
}

// TTL sweep: expire old rows, refresh counts, reclaim space, drop empty files.
function sweepDatastore() {
  if (!DatabaseSync || !fs.existsSync(DATASTORE_DIR)) return;
  const cutoff = Date.now() - STORE.TTL_MS;
  for (const f of fs.readdirSync(DATASTORE_DIR)) {
    if (!f.endsWith(".sqlite")) continue;
    const wallet = f.slice(0, -".sqlite".length);
    if (!STORE_WALLET_RE.test(wallet)) continue;
    try {
      const db = openWalletDb(wallet, { create: true });
      const { changes } = db.prepare("DELETE FROM rows WHERE created_at < ?").run(cutoff);
      if (changes > 0) {
        db.exec(`
          UPDATE collections SET row_count = (SELECT COUNT(*) FROM rows WHERE collection = collections.name);
          DELETE FROM collections WHERE row_count = 0;
        `);
        db.exec("VACUUM");
      }
      const remaining = db.prepare("SELECT COUNT(*) AS n FROM rows").get().n;
      if (remaining === 0) {
        closeWalletDb(wallet);
        for (const ext of ["", "-wal", "-shm"]) {
          try { fs.unlinkSync(storePathFor(wallet) + ext); } catch { /* gone */ }
        }
      }
    } catch (e) { console.warn(`datastore sweep (${wallet}):`, String(e.message || e).slice(0, 120)); }
  }
}
const sweepTimer = setInterval(sweepDatastore, 3600 * 1000);
sweepTimer.unref?.();

// ---- PAID: append rows -------------------------------------------
app.post("/api/store/:collection", (req, res) => {
  try {
    const wallet = storeWallet(req, res);
    if (!wallet) return;
    const collection = String(req.params.collection || "");
    if (!STORE_COLLECTION_RE.test(collection)) return res.status(400).json({ error: "collection must match [a-zA-Z0-9_-]{1,64}" });

    const rows = storeParseRows(req);
    if (!rows.length) return res.status(400).json({ error: "no rows to store" });
    if (rows.length > STORE.ROWS_PER_POST) return res.status(413).json({ error: `max ${STORE.ROWS_PER_POST} rows per POST (got ${rows.length})` });
    const serialized = rows.map((r, i) => {
      if (!r || typeof r !== "object" || Array.isArray(r)) throw storeHttpError(400, `row ${i} is not an object`);
      const s = JSON.stringify(r);
      if (Buffer.byteLength(s) > STORE.ROW_BYTES) throw storeHttpError(413, `row ${i} exceeds ${STORE.ROW_BYTES / 1024}KB limit`);
      return s;
    });

    // Quota checks before any write.
    try {
      const st = fs.statSync(storePathFor(wallet));
      if (st.size > STORE.WALLET_BYTES) return res.status(507).json({ error: "50MB wallet storage quota exceeded — DELETE a collection to free space" });
    } catch { /* no file yet */ }

    const db = openWalletDb(wallet, { create: true });
    const coll = db.prepare("SELECT row_count FROM collections WHERE name = ?").get(collection);
    if (!coll) {
      const count = db.prepare("SELECT COUNT(*) AS n FROM collections").get().n;
      if (count >= STORE.COLLECTIONS_PER_WALLET) return res.status(413).json({ error: `max ${STORE.COLLECTIONS_PER_WALLET} collections per wallet` });
      db.prepare("INSERT INTO collections (name, created_at, row_count, schema_json) VALUES (?, ?, 0, ?)")
        .run(collection, Date.now(), JSON.stringify(Object.keys(rows[0]).slice(0, 100)));
    } else if (coll.row_count + rows.length > STORE.ROWS_PER_COLLECTION) {
      return res.status(413).json({ error: `collection would exceed ${STORE.ROWS_PER_COLLECTION} rows (has ${coll.row_count})` });
    }

    db.exec("BEGIN");
    try {
      const ins = db.prepare("INSERT INTO rows (collection, data_json, created_at) VALUES (?, ?, ?)");
      const now = Date.now();
      for (const s of serialized) ins.run(collection, s, now);
      db.prepare("UPDATE collections SET row_count = row_count + ? WHERE name = ?").run(serialized.length, collection);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }

    const total = db.prepare("SELECT row_count FROM collections WHERE name = ?").get(collection).row_count;
    res.json({ collection, rows_added: serialized.length, total_rows: total, wallet, ts: new Date().toISOString() });
  } catch (e) { storeErrorOut(res, e); }
});

// ---- PAID: read rows ---------------------------------------------
app.get("/api/store/:collection", (req, res) => {
  try {
    const wallet = storeWallet(req, res);
    if (!wallet) return;
    const collection = String(req.params.collection || "");
    if (!STORE_COLLECTION_RE.test(collection)) return res.status(400).json({ error: "collection must match [a-zA-Z0-9_-]{1,64}" });
    const db = openWalletDb(wallet);
    const coll = db && db.prepare("SELECT row_count FROM collections WHERE name = ?").get(collection);
    if (!coll) return res.status(404).json({ error: `collection "${collection}" not found for wallet ${wallet}` });

    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const order = String(req.query.order || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
    let sinceMs = 0;
    if (req.query.since) {
      sinceMs = Date.parse(String(req.query.since));
      if (Number.isNaN(sinceMs)) return res.status(400).json({ error: "since must be an ISO timestamp" });
    }
    const rows = db.prepare(
      `SELECT id, data_json, created_at FROM rows WHERE collection = ? AND created_at > ? ORDER BY id ${order} LIMIT ? OFFSET ?`
    ).all(collection, sinceMs, limit, offset)
      .map((r) => ({ id: r.id, created_at: new Date(Number(r.created_at)).toISOString(), ...JSON.parse(r.data_json) }));

    if (String(req.query.format || "").toLowerCase() === "csv") {
      const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      const esc = (v) => { const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      res.type("text/csv").send([headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n"));
      return;
    }
    res.json({ collection, total_rows: coll.row_count, returned: rows.length, rows, ts: new Date().toISOString() });
  } catch (e) { storeErrorOut(res, e); }
});

// ---- PAID: list collections ---------------------------------------
app.get("/api/store", (req, res) => {
  try {
    const wallet = storeWallet(req, res);
    if (!wallet) return;
    const db = openWalletDb(wallet);
    if (!db) return res.json({ wallet, collections: [], total_rows: 0, storage_bytes: 0, ts: new Date().toISOString() });
    const collections = db.prepare("SELECT name, row_count, created_at FROM collections ORDER BY name").all()
      .map((c) => ({ name: c.name, row_count: c.row_count, created_at: new Date(Number(c.created_at)).toISOString() }));
    let bytes = 0;
    try { bytes = fs.statSync(storePathFor(wallet)).size; } catch { /* fresh */ }
    res.json({
      wallet,
      collections,
      total_rows: collections.reduce((s, c) => s + c.row_count, 0),
      storage_bytes: bytes,
      quota_bytes: STORE.WALLET_BYTES,
      ttl_days: STORE.TTL_MS / 86400000,
      ts: new Date().toISOString(),
    });
  } catch (e) { storeErrorOut(res, e); }
});

// ---- PAID: drop a collection --------------------------------------
app.delete("/api/store/:collection", (req, res) => {
  try {
    const wallet = storeWallet(req, res);
    if (!wallet) return;
    const collection = String(req.params.collection || "");
    if (!STORE_COLLECTION_RE.test(collection)) return res.status(400).json({ error: "collection must match [a-zA-Z0-9_-]{1,64}" });
    const db = openWalletDb(wallet);
    const coll = db && db.prepare("SELECT row_count FROM collections WHERE name = ?").get(collection);
    if (!coll) return res.status(404).json({ error: `collection "${collection}" not found for wallet ${wallet}` });
    db.exec("BEGIN");
    try {
      const { changes } = db.prepare("DELETE FROM rows WHERE collection = ?").run(collection);
      db.prepare("DELETE FROM collections WHERE name = ?").run(collection);
      db.exec("COMMIT");
      res.json({ collection, deleted_rows: changes, ts: new Date().toISOString() });
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  } catch (e) { storeErrorOut(res, e); }
});

// ----------------------------------------------------------------------------
// PAID: whole-site generator. Up to 6 finished, consistent pages in
// one call: shared branding (seed, colors, logo, footer) + a pages[] array.
// A shared nav linking every page is built automatically unless provided.
// ----------------------------------------------------------------------------
app.post("/api/website/build", async (req, res) => {
  try {
    const b = req.body || {};
    const siteName = String(b.site_name || "").trim().slice(0, 60);
    if (!siteName) return res.status(400).json({ error: "site_name is required" });
    const pagesIn = Array.isArray(b.pages) ? b.pages.slice(0, 6) : [];
    if (!pagesIn.length) return res.status(400).json({ error: "pages is required — an array of 1-6 page specs: [{page_name, headline, content, …}]" });
    const seed = String(b.seed || "").trim().slice(0, 64) || crypto.randomUUID().slice(0, 8);

    // Pre-compute file names so the shared nav can link every page.
    const slugOf = (pg, i) => (String(pg.page_name || (i === 0 ? "home" : `page-${i + 1}`)).trim().toLowerCase()
      .replace(/[^a-z0-9 _-]/g, "").replace(/[\s_]+/g, "-") || `page-${i + 1}`).slice(0, 40);
    const slugs = pagesIn.map(slugOf);
    if (new Set(slugs).size !== slugs.length) return res.status(400).json({ error: "duplicate page_name values — each page needs a unique name" });

    const sharedNav = Array.isArray(b.nav) && b.nav.length
      ? b.nav
      : slugs.map((s) => ({
          label: s === "home" ? "Home" : s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
          href: s === "home" ? "index.html" : `${s}.html`,
        }));

    const pages = [];
    let template = null;
    for (let i = 0; i < pagesIn.length; i++) {
      const pg = pagesIn[i] && typeof pagesIn[i] === "object" ? pagesIn[i] : {};
      const parsed = webbiePageParams({
        // shared branding…
        site_name: siteName, seed, template: b.template, colors: b.colors,
        logo_url: b.logo_url, logo: b.logo, footer: b.footer, nav: sharedNav,
        // …then this page's own fields
        ...pg,
        page_name: slugs[i],
        seed, // page specs can't fork the style
      });
      if (parsed.error) return res.status(400).json({ error: `pages[${i}] (${slugs[i]}): ${parsed.error}` });
      const built = buildWebbiePage(parsed.p);
      template = built.template;
      pages.push({
        page_name: parsed.pageName,
        filename: parsed.fileName,
        title: parsed.p.title,
        html: built.html,
        html_bytes: Buffer.byteLength(built.html),
      });
    }

    res.json({
      seed,
      template,
      page_count: pages.length,
      pages,
      nav_json: { links: sharedNav.map((l) => ({ label: String(l.label || "").slice(0, 30), href: webbieSafeHref(l.href) || "#" })).filter((l) => l.label) },
      notes: [
        "Save each pages[].html under its filename plus nav_json as nav.json in one folder — a complete site.",
        `Add pages later with POST /api/website/page using seed "${seed}" and the same colors; update nav.json to link them.`,
      ],
      ts: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: "site generation failed", detail: String(e.message || e) });
  }
});

// ----------------------------------------------------------------------------
// PAID: WordPress security posture check. Passive hygiene assessment
// from public signals — practice, not exploits. ?url=
// ----------------------------------------------------------------------------
app.get("/api/wp/assess", async (req, res) => {
  try {
    if (!req.query.url) return res.status(400).json({ error: "url query param required" });
    const result = await wpAssess(String(req.query.url));
    res.json({ ...result, ts: new Date().toISOString() });
  } catch (e) {
    const msg = String(e.message || e);
    res.status(/url|allowed|content-type|too large/i.test(msg) ? 400 : 502).json({ error: "wp assessment failed", detail: msg });
  }
});

// ----------------------------------------------------------------------------
// PAID: DNS / domain intelligence. Core records + email security
// posture (SPF/DMARC/DKIM presence). ?domain=example.com
// ----------------------------------------------------------------------------
app.get("/api/dns", async (req, res) => {
  try {
    const domain = validDomain(req.query.domain);
    if (!domain) {
      return res.status(400).json({ error: "valid domain query param required, e.g. ?domain=example.com" });
    }
    const intel = await dnsIntel(domain);
    res.json({ ...intel, ts: new Date().toISOString() });
  } catch (e) {
    res.status(502).json({ error: "dns lookup failed", detail: String(e.message || e) });
  }
});

// ----------------------------------------------------------------------------
// PAID: JSON-LD generator — the complement to /api/schema/audit.
// POST {type, fields}; returns valid current-spec JSON-LD, a ready <script>
// tag, and a self-audit of the generated block.
// ----------------------------------------------------------------------------
app.post("/api/schema/generate", async (req, res) => {
  try {
    const b = req.body || {};
    const type = String(b.type || "");
    if (!GENERATABLE_TYPES.includes(type)) {
      return res.status(400).json({ error: `type must be one of: ${GENERATABLE_TYPES.join(", ")}` });
    }
    const fields = (b.fields && typeof b.fields === "object") ? b.fields : {};
    const { node, notes } = generateJsonLd(type, fields);

    // Self-check: run the generated block through the same audit rules.
    const audit = auditNode(node);

    res.json({
      type,
      jsonld: node,
      script_tag: `<script type="application/ld+json">\n${JSON.stringify(node, null, 2)}\n</script>`,
      generation_notes: notes,
      self_audit: {
        rich_result_status: audit.rich_result_status,
        required_missing: audit.required_missing || [],
        one_of_missing: audit.one_of_missing || [],
        recommended_missing: audit.recommended_missing || [],
      },
      ts: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: "generation failed", detail: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`▲ x402-data-api on ${BASE_URL}`);
  console.log(`  network: ${NETWORK}   payTo: ${PAY_TO}`);
  console.log(`  try (free):  curl ${BASE_URL}/`);
  console.log(`  try (paid):  curl -i ${BASE_URL}/api/price/bitcoin   # returns 402 until paid`);
});
