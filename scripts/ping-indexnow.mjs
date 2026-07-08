#!/usr/bin/env node
// ----------------------------------------------------------------------------
// IndexNow ping for x402.webbersites.com — tells Bing, DuckDuckGo, Yandex,
// Seznam and Naver to re-crawl immediately after a deploy. (Google does not
// support IndexNow; for Google use Search Console → URL Inspection.)
//
//   node scripts/ping-indexnow.mjs            # pings every URL in sitemap.xml
//   node scripts/ping-indexnow.mjs /docs/store /docs/   # or specific paths
//
// Run AFTER uploading the changed pages, not before — engines fetch right away.
// Requires the key file (<KEY>.txt) to be live at the site root.
// ----------------------------------------------------------------------------
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SITE = "https://x402.webbersites.com";
const KEY = "92c77b5915b3617d0a71e51d0c3a9f51";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "x402.webbersites.com");

let urlList;
if (process.argv.length > 2) {
  urlList = process.argv.slice(2).map((p) => (p.startsWith("http") ? p : SITE + p));
} else {
  const xml = await readFile(path.join(ROOT, "sitemap.xml"), "utf8");
  urlList = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}

const res = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify({
    host: "x402.webbersites.com",
    key: KEY,
    keyLocation: `${SITE}/${KEY}.txt`,
    urlList,
  }),
});
console.log(`IndexNow: ${res.status} ${res.statusText} — ${urlList.length} urls submitted`);
if (!res.ok) console.log(await res.text());
