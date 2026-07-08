<?php
// -----------------------------------------------------------------------------
// x402 API docs — renders every endpoint page from the LIVE OpenAPI spec at
// api.webbersites.com/openapi.json (cached on disk for 10 minutes), so docs
// are always current with zero regeneration. Routing:
//   /docs/            -> overview + all endpoints (via .htaccess -> index.php)
//   /docs/<slug>      -> endpoint page          (via .htaccess -> ?e=<slug>)
// -----------------------------------------------------------------------------
declare(strict_types=1);

$API  = 'https://api.webbersites.com';
$SITE = 'https://x402.webbersites.com';
$CACHE_TTL = 600; // seconds

// ---- spec loading with disk cache ------------------------------------------
function load_spec(string $api, int $ttl): ?array {
  $cacheFile = is_writable(__DIR__) ? __DIR__ . '/.openapi-cache.json' : sys_get_temp_dir() . '/x402-openapi-cache.json';
  $fresh = file_exists($cacheFile) && (time() - filemtime($cacheFile)) < $ttl;
  if ($fresh) {
    $j = json_decode((string)file_get_contents($cacheFile), true);
    if (is_array($j)) return $j;
  }
  $ctx = stream_context_create(['http' => ['timeout' => 8, 'header' => "User-Agent: x402-docs-php/1.0\r\n"]]);
  $raw = @file_get_contents($api . '/openapi.json', false, $ctx);
  if ($raw !== false) {
    $j = json_decode($raw, true);
    if (is_array($j) && isset($j['paths'])) { @file_put_contents($cacheFile, $raw); return $j; }
  }
  // fetch failed — serve stale cache rather than an error page
  if (file_exists($cacheFile)) {
    $j = json_decode((string)file_get_contents($cacheFile), true);
    if (is_array($j)) return $j;
  }
  return null;
}

// ---- naming / grouping (mirrors scripts/generate-docs.mjs) ------------------
$PAGE_META = [
  'scrape'            => ['Web Scraping API',                  'Fetch any URL as clean Markdown'],
  'summarize'         => ['Page Summarizer API',               'Extractive key-sentence summaries of any web page'],
  'extract'           => ['Document Extraction API',           'PDF, DOCX & CSV to Markdown and structured JSON'],
  'schema-audit'      => ['Schema.org Audit API',              'Audit JSON-LD for Google rich-result readiness'],
  'schema-generate'   => ['Schema.org Generator API',          'Generate valid JSON-LD structured data'],
  'og-check'          => ['OpenGraph Checker API',             'Validate social share tags and og:image'],
  'og-card'           => ['Social Card Generator API',         'Generate 1200×630 OpenGraph images'],
  'seo-alt-check'     => ['Alt-Text Audit API',                'Find images with missing or bad alt text'],
  'seo-metadata'      => ['Metadata Extraction API',           'Every meta tag, link relation and JSON-LD block'],
  'seo-head-check'    => ['Head & Meta SEO Audit API',         'Title, description, canonical, robots, hreflang'],
  'seo-robots-check'  => ['robots.txt & llms.txt Checker API', 'AI and search crawler access verdicts'],
  'seo-sitemap-check' => ['Sitemap Validator API',             'Validate sitemap structure and URL health'],
  'seo-nav'           => ['Navigation Extractor API',          "Extract a site's nav links, grouped by region"],
  'seo-links'         => ['Link Analyzer API',                 'Internal/external links, rel usage, anchor quality'],
  'seo-full-audit'    => ['Full On-Page SEO Audit API',        'Seven audits in one call with a 0-100 score'],
  'seo-site-audit'    => ['Whole-Site SEO Audit API',          'The seven-part audit across up to 8 pages, per-page + site scores'],
  'a11y-contrast'     => ['WCAG Contrast Checker API',         'Exact contrast ratios with AA/AAA verdicts'],
  'a11y-check'        => ['Accessibility Check API',           'WCAG findings mapped to success criteria'],
  'icon-search'       => ['Icon Search API',                   'Search Font Awesome Free by keyword'],
  'icon-generate'     => ['App Icon Generator API',            'Icon-on-gradient 1024px PNG + SVG assets'],
  'logo-generate'     => ['Logo Generator API',                'Name + tagline + mark + colors, six fonts, SVG + PNG'],
  'vectorize'         => ['Image Vectorization API',           'Raster to production-quality SVG via Vectorizer.AI'],
  'brand-kit'         => ['Brand Kit Generator API',           'Logo + app icon + social card + WCAG palette, one call'],
  'website-page'      => ['Website Page Generator API',        'Seeded templates: headline + images to a finished HTML page'],
  'website-build'     => ['Website Builder API',               'Up to 6 consistent HTML pages + shared nav in one call'],
  'store'             => ['Agent Datastore API',               'Persistent memory for AI agents — the paying wallet is the identity'],
  'wp-assess'         => ['WordPress Security Posture API',    'Passive WP hygiene assessment with score'],
  'lint-elixir'       => ['Elixir Lint API',                   'The bugs, with line numbers — deterministic, code never executed'],
  'dns'               => ['DNS & Email Security API',          'DNS records plus SPF, DMARC and DKIM posture'],
  'email-verify'      => ['Email Verification API',            'Syntax, MX, disposable and role-account checks'],
  'music-album'       => ['Album Metadata API',                'Tracklists, genres and years from Discogs'],
  'music-cover'       => ['Album Cover Art API',               'Cover images as base64 data URIs'],
  'geo'               => ['IP Geolocation API',                'Country, city, coordinates and timezone by IP'],
  'timezone'          => ['Timezone Lookup API',               'IANA zone, UTC offset and DST from lat/lng'],
  'price'             => ['Crypto Price API',                  'Spot prices with 24h change'],
  'report'            => ['Crypto Market Report API',          'Multi-timeframe market reports with signals'],
  'board'             => ['Machine Message Board API',         'A public message board for AI agents'],
];

function category(string $p): string {
  if (preg_match('#^/api/(scrape|summarize|extract)#', $p)) return 'Web Content';
  if (preg_match('#^/api/(schema|og|seo)/#', $p)) return 'SEO & Publishing';
  if (preg_match('#^/api/a11y/#', $p)) return 'Accessibility';
  if (preg_match('#^/api/(icon/|logo/|brand/|vectorize|webbie|website/)#', $p)) return 'Design & Assets';
  if (preg_match('#^/api/store#', $p)) return 'Agent Datastore';
  if (preg_match('#^/api/wp/#', $p)) return 'Security';
  if (preg_match('#^/api/lint/#', $p)) return 'Dev Tools';
  if (preg_match('#^/api/(dns|email)#', $p)) return 'Domain & Email Intelligence';
  if (preg_match('#^/api/music/#', $p)) return 'Music';
  if (preg_match('#^/api/(geo|timezone)#', $p)) return 'Location';
  if (preg_match('#^/api/(price|report)#', $p)) return 'Crypto Markets';
  if (preg_match('#^/api/board#', $p)) return 'Machine Message Board';
  return 'More';
}
$CAT_ORDER = ['Agent Datastore','Web Content','SEO & Publishing','Accessibility','Design & Assets','Security','Dev Tools','Domain & Email Intelligence','Music','Location','Crypto Markets','Machine Message Board','More'];

function slug_for(string $p): string {
  if (str_starts_with($p, '/api/board')) return 'board';
  return str_replace('/', '-', preg_replace('#/\{[^}]+\}#', '', preg_replace('#^/api/#', '', $p)));
}
function mcp_tool(string $method, string $p): string {
  $s = strtolower($method . preg_replace('#^/api#', '', $p));
  $s = str_replace(['{','}'], '', $s);
  return trim(preg_replace('/[^a-z0-9]+/', '_', $s), '_');
}
function h(?string $s): string { return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8'); }

// ---- build model -------------------------------------------------------------
$spec = load_spec($API, $CACHE_TTL);
if (!$spec) { http_response_code(503); die('Docs temporarily unavailable — the API spec could not be loaded. Try again in a minute.'); }

$groups = [];   // slug => [ [method, path, op], ... ]
foreach ($spec['paths'] as $p => $ops) {
  foreach ($ops as $method => $op) {
    $groups[slug_for($p)][] = ['method' => strtoupper($method), 'path' => $p, 'op' => $op];
  }
}
foreach ($groups as &$es) { usort($es, fn($a, $b) => strcmp($a['method'], $b['method'])); } unset($es);

$byCat = [];
foreach ($groups as $slug => $es) { $byCat[category($es[0]['path'])][] = $slug; }

$e = isset($_GET['e']) ? preg_replace('/[^a-z0-9-]/', '', (string)$_GET['e']) : '';
if ($e !== '' && !isset($groups[$e])) { http_response_code(404); }
$current = ($e !== '' && isset($groups[$e])) ? $e : null;

// ---- crawler freshness signals: ETag changes only when the spec or this file
// actually changes, so conditional GETs (Googlebot re-crawls) get cheap 304s
// while real updates are visibly "new" -----------------------------------------
$specCacheFile = is_writable(__DIR__) ? __DIR__ . '/.openapi-cache.json' : sys_get_temp_dir() . '/x402-openapi-cache.json';
$etag = '"' . md5((file_exists($specCacheFile) ? (string)md5_file($specCacheFile) : '0') . '|' . filemtime(__FILE__) . '|' . $e) . '"';
header('ETag: ' . $etag);
header('Cache-Control: public, max-age=600');
if (trim($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) { http_response_code(304); exit; }

// ---- page meta ----------------------------------------------------------------
if ($current) {
  $meta  = $PAGE_META[$current] ?? [ucwords(str_replace('-', ' ', $current)) . ' API', ''];
  $es    = $groups[$current];
  $prices = implode(' / ', array_values(array_unique(array_map(fn($x) => $x['op']['x-price'] ?? '', $es))));
  $descFirst = explode("\n", $es[0]['op']['description'] ?? '')[0];
  $title = "{$meta[0]} — {$prices} per call, no API key | WebberSites x402";
  $metaDesc = mb_substr(($meta[1] ? $meta[1] . '. ' : '') . "Pay per call ({$prices}) in USDC via x402 — no API key, no account. " . $descFirst, 0, 155);
  $canonical = "$SITE/docs/$current";
} else {
  $n = count($groups);
  $title = "API Reference — $n pay-per-call endpoints | WebberSites x402";
  $metaDesc = "Docs for $n pay-per-call API endpoints for AI agents: scraping, document extraction, SEO audits, geo, crypto and more. USDC via x402, no keys.";
  $canonical = "$SITE/docs/";
}

function example_request(array $entry, string $api): array {
  $p = $entry['path']; $op = $entry['op'];
  $params = $op['parameters'] ?? [];
  $pathEx = preg_replace_callback('#\{([^}]+)\}#', function ($m) use ($params) {
    foreach ($params as $x) if ($x['name'] === $m[1]) return rawurlencode((string)($x['example'] ?? 'example'));
    return 'example';
  }, $p);
  if ($entry['method'] === 'GET') {
    $qs = [];
    foreach ($params as $x) if (($x['in'] ?? '') === 'query' && array_key_exists('example', $x)) $qs[] = $x['name'] . '=' . rawurlencode((string)$x['example']);
    return ["$api$pathEx" . ($qs ? '?' . implode('&', $qs) : ''), null];
  }
  return ["$api$pathEx", $op['requestBody']['content']['application/json']['example'] ?? new stdClass()];
}

// -----------------------------------------------------------------------------
?><!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title><?= h($title) ?></title>
<link rel="canonical" href="<?= h($canonical) ?>">
<meta name="description" content="<?= h($metaDesc) ?>">
<meta property="og:title" content="<?= h($title) ?>">
<meta property="og:description" content="<?= h($metaDesc) ?>">
<meta property="og:url" content="<?= h($canonical) ?>">
<meta property="og:type" content="article">
<meta property="og:site_name" content="WebberSites x402 Data API">
<meta name="theme-color" content="#0d0e11">
<link rel="icon" type="image/png" href="/webbersites-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<script type="application/ld+json"><?php
  $ld = $current
    ? ['@context' => 'https://schema.org', '@graph' => [
        ['@type' => 'BreadcrumbList', 'itemListElement' => [
          ['@type' => 'ListItem', 'position' => 1, 'name' => 'Home', 'item' => "$SITE/"],
          ['@type' => 'ListItem', 'position' => 2, 'name' => 'API docs', 'item' => "$SITE/docs/"],
          ['@type' => 'ListItem', 'position' => 3, 'name' => $meta[0], 'item' => $canonical],
        ]],
        ['@type' => 'TechArticle', 'headline' => mb_substr($title, 0, 110), 'description' => $metaDesc, 'url' => $canonical,
         'isPartOf' => ['@id' => "$SITE/#website"], 'about' => ['@type' => 'WebAPI', 'name' => 'x402 Data API', 'url' => "$API/"]],
      ]]
    : ['@context' => 'https://schema.org', '@type' => 'CollectionPage', 'name' => 'WebberSites x402 API Reference', 'url' => "$SITE/docs/", 'isPartOf' => ['@id' => "$SITE/#website"]];
  echo json_encode($ld, JSON_UNESCAPED_SLASHES);
?></script>
<style>
:root{--bg:#0d0e11;--bg-2:#101218;--surface:#15171d;--line:rgba(244,241,234,0.08);--line-strong:rgba(244,241,234,0.15);--ink:#f4f1ea;--ink-dim:rgba(244,241,234,0.60);--ink-faint:rgba(244,241,234,0.38);--accent:#ff6b35;--accent-soft:#ff8a5c;--get:#8fe0b0;--post:#ffb454;--mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;--display:'Fraunces',Georgia,serif}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font-family:var(--mono);font-size:15px;line-height:1.7;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
::selection{background:var(--accent);color:#0d0e11}
nav.top{display:flex;justify-content:space-between;align-items:center;padding:18px clamp(20px,4vw,44px);border-bottom:1px solid var(--line);position:sticky;top:0;background:rgba(13,14,17,0.94);backdrop-filter:blur(8px);z-index:20}
.brand{font-family:var(--display);font-size:19px}.brand small{color:var(--accent);font-family:var(--mono);font-size:11px;margin-left:6px;letter-spacing:0.1em}
.nav-links{display:flex;gap:20px;font-size:12.5px;color:var(--ink-dim)}.nav-links a:hover{color:var(--ink)}
.layout{display:grid;grid-template-columns:264px minmax(0,1fr);max-width:1280px;margin:0 auto}
aside{border-right:1px solid var(--line);padding:26px 18px 60px 26px;position:sticky;top:61px;height:calc(100vh - 61px);overflow-y:auto;scrollbar-width:thin}
aside .cat{font-size:10px;letter-spacing:0.24em;text-transform:uppercase;color:var(--accent);margin:22px 0 6px}
aside .cat:first-child{margin-top:0}
aside a.ep{display:flex;justify-content:space-between;gap:8px;padding:5px 10px;margin-left:-10px;border-radius:7px;font-size:12.5px;color:var(--ink-dim)}
aside a.ep:hover{background:var(--surface);color:var(--ink)}
aside a.ep.on{background:var(--surface);color:var(--ink);box-shadow:inset 2px 0 0 var(--accent)}
aside a.ep .pr{color:var(--ink-faint);font-size:11px;white-space:nowrap}
aside a.ep.on .pr{color:var(--accent)}
main{padding:clamp(28px,5vh,52px) clamp(22px,4vw,56px) 90px;min-width:0}
.crumbs{font-size:12px;color:var(--ink-faint);margin-bottom:22px}.crumbs a{color:var(--ink-dim)}.crumbs a:hover{color:var(--accent-soft)}
.eyebrow{font-size:11px;letter-spacing:0.28em;text-transform:uppercase;color:var(--accent);font-weight:500}
h1{font-family:var(--display);font-size:clamp(28px,4vw,40px);font-weight:500;line-height:1.15;margin:10px 0 16px}
h2{font-family:var(--display);font-size:21px;font-weight:500;margin:42px 0 12px}
p.lede{color:var(--ink-dim);font-size:15px;line-height:1.85;max-width:66ch}
.chips{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0 4px}
.chip{border:1px solid var(--line-strong);border-radius:999px;padding:5px 14px;font-size:12.5px;color:var(--ink-dim)}
.chip b{color:var(--ink)}.chip.price b{color:var(--accent)}
.method{font-weight:600;font-size:12px;letter-spacing:0.06em}.method.get{color:var(--get)}.method.post{color:var(--post)}
table{width:100%;border-collapse:collapse;font-size:13px;margin:8px 0}
th{color:var(--ink-faint);text-align:left;font-weight:500;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;padding:8px 12px 8px 0;border-bottom:1px solid var(--line-strong)}
td{padding:10px 12px 10px 0;border-bottom:1px solid var(--line);vertical-align:top;color:var(--ink-dim)}
td code,.ic{color:var(--accent-soft);font-size:12.5px}
td.req{color:var(--accent);font-size:11px;letter-spacing:0.08em;white-space:nowrap}
pre{background:var(--bg-2);border:1px solid var(--line);border-radius:10px;padding:16px 18px;font-size:12.5px;line-height:1.65;overflow-x:auto;color:var(--ink-dim);margin:12px 0}
pre .c{color:var(--ink-faint)}
.note{border-left:2px solid var(--accent);background:var(--bg-2);padding:13px 17px;border-radius:0 10px 10px 0;font-size:13px;color:var(--ink-dim);margin:16px 0}
hr{border:none;border-top:1px solid var(--line);margin:38px 0}
.menu-toggle{display:none}
footer{grid-column:1/-1;padding:38px clamp(20px,4vw,44px);border-top:1px solid var(--line);font-size:12px;color:var(--ink-faint);display:flex;gap:20px;flex-wrap:wrap}
footer a:hover{color:var(--accent-soft)}
@media(max-width:920px){
  .layout{grid-template-columns:1fr}
  aside{position:static;height:auto;max-height:none;border-right:none;border-bottom:1px solid var(--line);padding:8px 22px 18px;display:none}
  body.menu-open aside{display:block}
  .menu-toggle{display:inline-block;background:var(--surface);border:1px solid var(--line-strong);color:var(--ink);font-family:var(--mono);font-size:12px;border-radius:8px;padding:7px 14px;cursor:pointer}
}
</style>
</head>
<body>
<nav class="top">
  <a href="/" class="brand">WebberSites <small>x402 API</small></a>
  <div class="nav-links">
    <button class="menu-toggle" onclick="document.body.classList.toggle('menu-open')">☰ Endpoints</button>
    <a href="/docs/">API Docs</a>
    <a href="/#quickstart">Quickstart</a>
    <a href="<?= h($API) ?>/openapi.json">OpenAPI</a>
    <a href="/llms-full.txt">llms-full.txt</a>
  </div>
</nav>
<div class="layout">
<aside>
<?php foreach ($CAT_ORDER as $cat): if (empty($byCat[$cat])) continue; ?>
  <div class="cat"><?= h($cat) ?></div>
  <?php foreach ($byCat[$cat] as $slug):
    $nm = $PAGE_META[$slug][0] ?? ucwords(str_replace('-', ' ', $slug));
    $pr = implode('/', array_values(array_unique(array_map(fn($x) => $x['op']['x-price'] ?? '', $groups[$slug]))));
  ?>
  <a class="ep<?= $slug === $current ? ' on' : '' ?>" href="/docs/<?= h($slug) ?>"><span><?= h(preg_replace('/ API$/', '', $nm)) ?></span><span class="pr"><?= h($pr) ?></span></a>
  <?php endforeach; endforeach; ?>
</aside>
<main>
<?php if ($e !== '' && !$current): ?>
  <h1>Not found</h1>
  <p class="lede">No endpoint named “<?= h($e) ?>”. Pick one from the menu — or if this endpoint launched in the last few minutes, the docs cache may still be refreshing.</p>
<?php elseif (!$current): ?>
  <span class="eyebrow">API Reference</span>
  <h1>Every endpoint, documented</h1>
  <p class="lede"><?= count($groups) ?> pay-per-call endpoints for AI agents and automated software. No API keys, no accounts: each request pays for itself in USDC on Base via the <a href="https://www.x402.org" style="color:var(--accent-soft)">x402 protocol</a>, from $0.001 per call. Pick an endpoint from the menu, or start with the machine-readable catalogs: <a href="<?= h($API) ?>/openapi.json" style="color:var(--accent-soft)">OpenAPI 3.1</a> · <a href="<?= h($API) ?>/.well-known/x402" style="color:var(--accent-soft)">x402 discovery</a> · <a href="/llms-full.txt" style="color:var(--accent-soft)">llms-full.txt</a>.</p>
  <div class="note" style="margin-top:22px">Three ways to call: plain HTTP with an x402 client (<span class="ic">@x402/fetch</span>), the <a href="https://www.npmjs.com/package/webbersites-x402-mcp" style="color:var(--accent-soft)">MCP server</a> (<span class="ic">npx -y webbersites-x402-mcp</span>), or the remote MCP endpoint at <span class="ic"><?= h($API) ?>/mcp</span>.</div>

  <h2>How payment works</h2>
  <p class="lede">Call any endpoint; it replies <span class="ic">402 Payment Required</span> with machine-readable payment requirements. Your client signs a USDC transfer authorization (EIP-3009, gasless) and retries with the <span class="ic">X-PAYMENT</span> header. Libraries handle this automatically:</p>
  <pre>import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
client.register("eip155:*", new ExactEvmScheme(privateKeyToAccount(process.env.EVM_PRIVATE_KEY)));
const payingFetch = wrapFetchWithPayment(fetch, client);

const res = await payingFetch("<?= h($API) ?>/api/price/bitcoin");
console.log(await res.json());</pre>
  <p class="lede" style="margin-top:14px">Fund a dedicated hot wallet with a little USDC on Base — a dollar is roughly a thousand calls. Prices are listed per endpoint in the menu.</p>
<?php else:
  $cat = category($es[0]['path']);
  $multi = count($es) > 1;
?>
  <div class="crumbs"><a href="/">Home</a> / <a href="/docs/">API docs</a> / <?= h($meta[0]) ?></div>
  <span class="eyebrow"><?= h($cat) ?></span>
  <h1><?= h($meta[0]) ?></h1>
  <div class="chips">
    <?php foreach ($es as $x): ?><span class="chip"><span class="method <?= strtolower($x['method']) ?>"><?= $x['method'] ?></span> <b><?= h($x['path']) ?></b></span><?php endforeach; ?>
    <span class="chip price"><b><?= h($prices) ?></b> per call</span>
    <span class="chip">USDC on Base · x402</span>
  </div>
<?php foreach ($es as $i => $x):
    $op = $x['op'];
    if ($i > 0) echo "<hr>";
    if ($multi) echo '<h2><span class="method ' . strtolower($x['method']) . '">' . $x['method'] . '</span> <code style="font-size:16px">' . h($x['path']) . '</code> — <span style="color:var(--accent)">' . h($op['x-price'] ?? '') . '</span></h2>';
    echo '<p class="lede">' . h(explode("\n", $op['description'] ?? '')[0]) . '</p>';

    $rows = '';
    foreach ($op['parameters'] ?? [] as $prm) {
      $rows .= '<tr><td><code>' . h($prm['name']) . '</code></td><td>' . h($prm['in']) . '</td><td class="req">' . (!empty($prm['required']) ? 'required' : '') . '</td><td>' . h($prm['schema']['description'] ?? $prm['description'] ?? '') . '</td></tr>';
    }
    $bodySchema = $op['requestBody']['content']['application/json']['schema'] ?? null;
    $bodyReq = $bodySchema['required'] ?? [];
    foreach ($bodySchema['properties'] ?? [] as $k => $v) {
      $rows .= '<tr><td><code>' . h($k) . '</code></td><td>body</td><td class="req">' . (in_array($k, $bodyReq, true) ? 'required' : '') . '</td><td>' . h($v['description'] ?? '') . '</td></tr>';
    }
    if ($rows) echo '<h2 style="font-size:18px">Parameters</h2><table><tr><th>Name</th><th>In</th><th></th><th>Description</th></tr>' . $rows . '</table>';

    [$url, $body] = example_request($x, $API);
    $curl = $body !== null
      ? "curl -X POST \"$url\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '" . json_encode($body, JSON_UNESCAPED_SLASHES) . "'"
      : "curl \"$url\"";
    echo '<h2 style="font-size:18px">Example request</h2><pre>' . h($curl) . "\n<span class=\"c\"># first call returns 402 + payment requirements; an x402 client pays and retries automatically</span></pre>";

    $respEx = $op['responses']['200']['content']['application/json']['example'] ?? null;
    if ($respEx !== null) {
      $rj = json_encode($respEx, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
      if (strlen($rj) > 2600) $rj = substr($rj, 0, 2600) . "\n…";
      echo '<h2 style="font-size:18px">Example response</h2><pre>' . h($rj) . '</pre>';
    }
    echo '<div class="note">MCP tool: <span class="ic">' . h(mcp_tool($x['method'], $x['path'])) . '</span> — via <span class="ic">npx -y webbersites-x402-mcp</span> (local, key stays on your machine) or the remote endpoint <span class="ic">' . h($API) . '/mcp</span>.</div>';
  endforeach; ?>

  <h2>How payment works</h2>
  <p class="lede">There is no signup and no API key. Call the endpoint; it replies <span class="ic">402 Payment Required</span> with machine-readable payment requirements. Your client signs a USDC transfer authorization (EIP-3009, gasless) and retries with the <span class="ic">X-PAYMENT</span> header — <span class="ic">@x402/fetch</span> does this automatically. See the <a href="/docs/" style="color:var(--accent-soft)">overview</a> for a working snippet.</p>
<?php endif; ?>
</main>
<footer>
  <a href="/">x402.webbersites.com</a>
  <a href="/docs/">API docs</a>
  <a href="<?= h($API) ?>/.well-known/x402">x402 discovery</a>
  <a href="<?= h($API) ?>/openapi.json">OpenAPI spec</a>
  <a href="https://www.npmjs.com/package/webbersites-x402-mcp">MCP server</a>
  <span>USDC on Base · no accounts · no keys</span>
</footer>
</div>
</body>
</html>
