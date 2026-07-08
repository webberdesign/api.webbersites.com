#!/usr/bin/env node
// ----------------------------------------------------------------------------
// Sitemap generator for x402.webbersites.com. The docs pages themselves are
// rendered live by docs/index.php (which reads the API's OpenAPI spec), so
// the only build artifact is sitemap.xml — one URL per endpoint page.
//
//   node scripts/generate-docs.mjs
//
// Re-run after adding endpoints, then upload sitemap.xml.
// ----------------------------------------------------------------------------
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SITE = "https://x402.webbersites.com";
const OPENAPI_URL = process.env.OPENAPI_URL || "https://api.webbersites.com/openapi.json";
const LASTMOD = process.env.LASTMOD || new Date().toISOString().slice(0, 10);
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "x402.webbersites.com");

const slugFor = (p) => p.startsWith("/api/board") ? "board"
  : p.replace(/^\/api\//, "").replace(/\/\{[^}]+\}/g, "").replace(/\//g, "-");

const res = await fetch(OPENAPI_URL);
if (!res.ok) throw new Error(`spec fetch failed: ${res.status}`);
const spec = await res.json();

const slugs = [...new Set(Object.keys(spec.paths).map(slugFor))];
const urls = [
  { loc: `${SITE}/`, pri: "1.0", freq: "daily" },
  { loc: `${SITE}/docs/`, pri: "0.9", freq: "daily" },
  ...slugs.map((s) => ({ loc: `${SITE}/docs/${s}`, pri: "0.8", freq: "weekly" })),
];

await writeFile(path.join(OUT, "sitemap.xml"),
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u.loc}</loc><lastmod>${LASTMOD}</lastmod><changefreq>${u.freq}</changefreq><priority>${u.pri}</priority></url>`).join("\n")}
</urlset>
`);
console.log(`✓ sitemap.xml — ${urls.length} urls (${slugs.length} endpoint pages)`);
