// php-lint.mjs — deterministic PHP linter for POST /api/lint/php.
//
// Pure static analysis: PHP regions are extracted, literals stripped, and the
// remaining code is pattern-checked. Nothing is ever executed or eval'd.
// No dependencies, no AI. Findings carry line numbers, severity, and fix hints.

const SUPERGLOBAL_RE = /\$_(GET|POST|REQUEST|COOKIE|SERVER|FILES)\b/;
const SQL_RE = /\b(select|insert|update|delete|union)\b[\s\S]*\b(from|into|set|where)\b/i;
// The mysql_* API was removed in PHP 7.0 — calls fatal on any modern PHP.
const MYSQL_RE = /\bmysql_(query|connect|pconnect|select_db|fetch_(assoc|array|row|object)|num_rows|real_escape_string|insert_id|error|close)\s*\(/;

// Extract PHP code regions: inside <?php|<?= ... ?> when tags exist, else the
// whole input. HTML outside tags is blanked (newlines kept).
function phpRegions(src) {
  if (!/<\?/.test(src)) return { code: src, hadTags: false, shortTags: false };
  const out = src.split("");
  let shortTags = false;
  let i = 0, inPhp = false;
  while (i < src.length) {
    if (!inPhp) {
      const open = src.indexOf("<?", i);
      const end = open === -1 ? src.length : open;
      for (let k = i; k < end; k++) if (out[k] !== "\n") out[k] = " ";
      if (open === -1) break;
      const isFull = src.startsWith("<?php", open) || src.startsWith("<?=", open);
      if (!isFull) shortTags = true;
      const tagLen = src.startsWith("<?php", open) ? 5 : src.startsWith("<?=", open) ? 3 : 2;
      for (let k = open; k < open + tagLen; k++) if (out[k] !== "\n") out[k] = " ";
      i = open + tagLen;
      inPhp = true;
    } else {
      const close = src.indexOf("?>", i);
      if (close === -1) { i = src.length; break; }
      out[close] = " "; out[close + 1] = " ";
      i = close + 2;
      inPhp = false;
    }
  }
  return { code: out.join(""), hadTags: true, shortTags };
}

// Strip comments and strings. String CONTENTS become spaces but the quote
// characters stay (so `== ''` remains detectable). Double-quoted strings and
// heredocs report their raw content + interpolated $vars via the callback.
function stripLiterals(src, onString) {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  let line = 1;
  const blank = (a, b) => { for (let k = a; k < b && k < n; k++) if (out[k] !== "\n") out[k] = " "; };
  const countNl = (a, b) => { for (let k = a; k < b && k < n; k++) if (src[k] === "\n") line++; };

  while (i < n) {
    const c = src[i];
    if (c === "\n") { line++; i++; continue; }
    if (c === "/" && src[i + 1] === "/") { const j = src.indexOf("\n", i); const e = j === -1 ? n : j; blank(i, e); i = e; continue; }
    if (c === "#") { const j = src.indexOf("\n", i); const e = j === -1 ? n : j; blank(i, e); i = e; continue; }
    if (c === "/" && src[i + 1] === "*") { const j = src.indexOf("*/", i + 2); const e = j === -1 ? n : j + 2; countNl(i, e); blank(i, e); i = e; continue; }
    if (c === "'") {
      const start = i; i++;
      while (i < n && src[i] !== "'") { if (src[i] === "\\") i++; i++; }
      i++;
      blank(start + 1, Math.min(i - 1, n));
      continue;
    }
    if (c === '"') {
      const start = i; i++;
      while (i < n && src[i] !== '"') { if (src[i] === "\\") i++; i++; }
      i++;
      onString?.(src.slice(start + 1, Math.min(i - 1, n)), line);
      countNl(start, i);
      blank(start + 1, Math.min(i - 1, n));
      continue;
    }
    if (c === "<" && src.startsWith("<<<", i)) {
      const m = src.slice(i).match(/^<<<\s*'?([A-Za-z_][A-Za-z0-9_]*)'?\r?\n/);
      if (m) {
        const nowdoc = src.slice(i).startsWith("<<<'");
        const start = i + m[0].length;
        const endRe = new RegExp(`\\n\\s*${m[1]}\\b`);
        const rel = src.slice(start).search(endRe);
        const end = rel === -1 ? n : start + rel;
        if (!nowdoc) onString?.(src.slice(start, end), line);
        countNl(i, end);
        blank(start, end);
        i = end;
        continue;
      }
    }
    i++;
  }
  return out.join("");
}

export function lintPhp(source) {
  const issues = [];
  const add = (line, severity, rule, message, hint) => {
    issues.push({ line, severity, rule, message, ...(hint ? { hint } : {}) });
  };

  const { code, hadTags, shortTags } = phpRegions(source);
  if (!hadTags && /(\$[a-zA-Z_]|->|function\s+\w+\s*\()/.test(source)) {
    add(1, "info", "style/no-open-tag", "no <?php tag — treated the whole input as PHP code");
  }
  if (shortTags) {
    add(1, "info", "style/short-open-tag", "short open tag '<?' depends on short_open_tag ini — many hosts disable it", "use <?php (or <?= for output)");
  }

  // collect interpolated variables + SQL-injection scan from string contents
  const interpolatedVars = new Set();
  const clean = stripLiterals(code, (content, line) => {
    let m;
    const varRe = /\$([a-zA-Z_][a-zA-Z0-9_]*)|\{\$([a-zA-Z_][a-zA-Z0-9_]*)/g;
    while ((m = varRe.exec(content))) interpolatedVars.add(m[1] || m[2]);
    if (SQL_RE.test(content) && SUPERGLOBAL_RE.test(content)) {
      add(line, "error", "security/sql-injection", "request data ($_GET/$_POST/...) interpolated directly into an SQL string", "use prepared statements with bound parameters (PDO/mysqli)");
    }
  });

  const lines = clean.split("\n");

  // --- bracket/brace balance ---
  const stack = [];
  const OPEN = { "(": ")", "[": "]", "{": "}" };
  for (let ln = 0; ln < lines.length; ln++) {
    for (const ch of lines[ln]) {
      if (OPEN[ch]) stack.push({ ch, line: ln + 1 });
      else if (ch === ")" || ch === "]" || ch === "}") {
        const top = stack[stack.length - 1];
        if (top && OPEN[top.ch] === ch) stack.pop();
        else add(ln + 1, "error", "syntax/unbalanced", `'${ch}' has no matching '${Object.keys(OPEN).find((k) => OPEN[k] === ch)}'${top ? ` ('${top.ch}' from line ${top.line} is still open)` : ""}`);
      }
    }
  }
  for (const f of stack) add(f.line, "error", "syntax/unbalanced", `'${f.ch}' opened here is never closed`, `add a matching '${OPEN[f.ch]}'`);

  // --- line-pattern checks ---
  const assigned = new Map(); // $var -> line
  const NON_VARS = new Set(["this", "GLOBALS"]);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    const no = ln + 1;

    if (MYSQL_RE.test(line)) {
      add(no, "error", "removed/mysql-api", "the mysql_* API was removed in PHP 7.0 — this is a fatal 'undefined function' on any modern PHP", "use mysqli_* or PDO");
    }
    // JS-ism: + with a string literal (PHP concatenates with .)
    if (/(['"])\s*\+|\+\s*(['"])/.test(line) && !/\+\+/.test(line)) {
      add(no, "error", "string-concat-plus", "'+' does not join strings in PHP (TypeError on PHP 8 for non-numeric strings)", "concatenate with . : $a . $b");
    }
    // assignment in condition
    const cond = line.match(/\b(if|while|elseif)\s*\(([^)]*)\)/);
    if (cond && /[^=!<>+\-*/.%&|]=(?![=>])/.test(cond[2])) {
      add(no, "warning", "assign-in-condition", `'=' inside this ${cond[1]} condition assigns — did you mean '=='?`, "use == or === to compare");
    }
    // loose comparison against juggling-prone literals
    if (/[^=!]==(?!=)\s*(0\b|null\b|false\b|true\b|''|"")/.test(line) || /(\b(0|null|false|true)|''|"")\s*==(?!=)[^=]/.test(line)) {
      add(no, "warning", "loose-equality", "loose '==' against 0/''/null/false type-juggles ('abc' == 0 was true before PHP 8)", "use === / !==");
    }
    if (/\beval\s*\(/.test(line)) add(no, "warning", "security/eval", "eval() executes arbitrary code — almost never necessary");
    if (/\bextract\s*\(\s*\$_/.test(line)) add(no, "warning", "security/extract-request", "extract() on request data lets callers create arbitrary variables", "read the specific keys you need instead");
    if (/\b(var_dump|print_r)\s*\(/.test(line)) add(no, "info", "debug/dump", "var_dump/print_r looks like leftover debug output");

    // variable assignments for unused analysis
    const assignRe = /\$([a-zA-Z_][a-zA-Z0-9_]*)\s*=(?![=>])/g;
    let am;
    while ((am = assignRe.exec(line))) {
      const name = am[1];
      if (!NON_VARS.has(name) && !name.startsWith("_") && !assigned.has(name)) assigned.set(name, no);
    }
  }

  // unused variables: assigned once, never read (interpolation counts as a read)
  for (const [name, lineNo] of assigned) {
    if (interpolatedVars.has(name)) continue;
    const uses = (clean.match(new RegExp(`\\$${name}\\b`, "g")) || []).length;
    const assignsCount = (clean.match(new RegExp(`\\$${name}\\s*=(?![=>])`, "g")) || []).length;
    if (uses <= assignsCount) {
      add(lineNo, "warning", "unused-variable", `$${name} is assigned but never used`, "remove it if it's dead code");
    }
  }

  issues.sort((a, b) => a.line - b.line || (a.severity === "error" ? -1 : 1));
  const counts = { error: 0, warning: 0, info: 0 };
  for (const x of issues) counts[x.severity]++;
  const syntaxErrors = issues.filter((x) => x.rule.startsWith("syntax/"));

  return {
    lines: source.split("\n").length,
    bytes: Buffer.byteLength(source, "utf8"),
    syntax: { ok: syntaxErrors.length === 0, errors: syntaxErrors },
    issues,
    counts,
    verdict: counts.error ? "errors" : counts.warning ? "warnings" : "clean",
  };
}
