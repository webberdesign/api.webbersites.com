// js-lint.mjs — JavaScript/Node linter for POST /api/lint/javascript.
//
// Syntax checking is real, not heuristic: V8 parses the source via new
// vm.Script(...), which compiles WITHOUT executing — untrusted code never
// runs. ESM import/export statements are blanked (newlines preserved, so
// line numbers stay exact) before the script-mode parse. Everything else is
// deterministic token/pattern checks. No dependencies, no AI.

import vm from "node:vm";

const JS_KEYWORDS = new Set([
  "var", "let", "const", "function", "return", "if", "else", "for", "while",
  "do", "switch", "case", "default", "break", "continue", "new", "delete",
  "typeof", "instanceof", "in", "of", "this", "class", "extends", "super",
  "import", "export", "from", "try", "catch", "finally", "throw", "async",
  "await", "yield", "static", "get", "set", "void", "null", "undefined",
  "true", "false", "NaN", "Infinity",
]);

// Blank ESM syntax so vm.Script (script mode) can parse the rest. Every
// replaced character becomes a space; newlines survive, so error lines match.
function blankModuleSyntax(src) {
  const blank = (m) => m.replace(/[^\n]/g, " ");
  return src
    .replace(/(^|\n)\s*import\s+[\s\S]*?from\s*(['"])[^'"]*\2\s*;?/g, blank)
    .replace(/(^|\n)\s*import\s*(['"])[^'"]*\2\s*;?/g, blank)
    .replace(/(^|\n)\s*export\s+default\s/g, (m) => blank(m.slice(0, -1)) + " ")
    .replace(/(^|\n)\s*export\s*\{[^}]*\}\s*(from\s*(['"])[^'"]*\3)?\s*;?/g, blank)
    .replace(/(^|\n)(\s*)export\s+(?=(const|let|var|function|class|async)\b)/g, (m, nl, ws) => nl + ws + "       ");
}

// Strip comments, strings, template literals, and regex literals — replaced
// by spaces (newlines kept) so pattern checks never fire inside them.
// Template ${...} interpolations are kept as code.
function stripLiterals(src) {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  let prevSig = ""; // last significant char, to distinguish regex from division
  const blankRange = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " "; };
  const stack = []; // template-literal nesting: {type:'tpl'|'brace'}

  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const j = src.indexOf("\n", i);
      const end = j === -1 ? n : j;
      blankRange(i, end); i = end; continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const j = src.indexOf("*/", i + 2);
      const end = j === -1 ? n : j + 2;
      blankRange(i, end); i = end; continue;
    }
    if (c === '"' || c === "'") {
      const start = i; i++;
      while (i < n && src[i] !== c && src[i] !== "\n") { if (src[i] === "\\") i++; i++; }
      i++; blankRange(start, Math.min(i, n)); prevSig = c; continue;
    }
    if (c === "`") {
      const start = i; i++;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "`") { i++; break; }
        if (src[i] === "$" && src[i + 1] === "{") { // keep interpolation as code
          blankRange(start, i);
          stack.push("tpl"); i += 2; prevSig = "{";
          break;
        }
        i++;
      }
      if (stack[stack.length - 1] !== "tpl") { blankRange(start, Math.min(i, n)); prevSig = "`"; }
      continue;
    }
    if (c === "{" && stack.length) { stack.push("brace"); i++; prevSig = c; continue; }
    if (c === "}" && stack.length) {
      const top = stack.pop();
      if (top === "tpl") { // resume template literal
        const start = i; i++;
        while (i < n) {
          if (src[i] === "\\") { i += 2; continue; }
          if (src[i] === "`") { i++; break; }
          if (src[i] === "$" && src[i + 1] === "{") { blankRange(start, i); stack.push("tpl"); i += 2; break; }
          i++;
        }
        if (stack[stack.length - 1] !== "tpl") blankRange(start, Math.min(i, n));
        prevSig = "`";
        continue;
      }
      i++; prevSig = c; continue;
    }
    if (c === "/" && "=([{,;!&|?:+-*%<>~^".includes(prevSig || "(")) { // regex literal position
      const start = i; i++;
      let inClass = false;
      while (i < n && src[i] !== "\n") {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) { i++; break; }
        i++;
      }
      while (i < n && /[a-z]/i.test(src[i])) i++;
      blankRange(start, Math.min(i, n)); prevSig = "/";
      continue;
    }
    if (!/\s/.test(c)) prevSig = c;
    i++;
  }
  return out.join("");
}

export function lintJavascript(source) {
  const issues = [];
  const add = (line, severity, rule, message, hint) => {
    issues.push({ line, severity, rule, message, ...(hint ? { hint } : {}) });
  };

  // --- real syntax check (parse only, never executed) ---
  let syntaxOk = true;
  try {
    new vm.Script(blankModuleSyntax(source), { filename: "lint.js" });
  } catch (e) {
    syntaxOk = false;
    // V8 reports "lint.js:LINE" on the first stack line
    const m = String(e.stack).match(/lint\.js:(\d+)/);
    add(m ? Number(m[1]) : 1, "error", "syntax/parse", `${e.message}`, "V8 parser error — fix this before anything else");
  }

  const clean = stripLiterals(source);
  const lines = clean.split("\n");

  // --- pattern checks on literal-stripped code ---
  const declared = new Map(); // name -> {line, kind}
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    const no = ln + 1;

    // loose equality (== / != but not === / !==)
    const loose = line.match(/[^=!<>]==(?!=)|!=(?!=)/);
    if (loose && !/[=!]==/.test(line.slice(Math.max(0, loose.index - 1), loose.index + 4))) {
      add(no, "warning", "loose-equality", "'==' / '!=' coerce types (0 == '' is true)", "use === / !==");
    }
    // comparison with NaN
    if (/[=!]=+\s*NaN|NaN\s*[=!]=+/.test(line)) {
      add(no, "error", "nan-compare", "nothing is ever == NaN — this comparison is always false", "use Number.isNaN(x)");
    }
    // assignment in condition
    const cond = line.match(/\b(if|while)\s*\(([^)]*)\)/);
    if (cond && /[^=!<>+\-*/%&|^]=(?![=>])/.test(cond[2])) {
      add(no, "warning", "assign-in-condition", `'=' inside this ${cond[1]} condition assigns — did you mean '=='?`, "use === to compare; wrap in extra parens if the assignment is intentional");
    }
    // var
    if (/\bvar\s+[a-zA-Z_$]/.test(line)) {
      add(no, "info", "no-var", "'var' is function-scoped and hoisted — a common source of bugs", "use const (or let when reassigned)");
    }
    // console.log leftover
    if (/\bconsole\.log\s*\(/.test(line)) {
      add(no, "info", "debug/console-log", "console.log looks like leftover debug output");
    }
    // declarations for unused/const-reassign analysis
    const declRe = /\b(const|let|var)\s+([a-zA-Z_$][\w$]*)/g;
    let dm;
    while ((dm = declRe.exec(line))) {
      if (!declared.has(dm[2])) declared.set(dm[2], { line: no, kind: dm[1] });
    }
  }

  // usage counts + const reassignment (scope-naive but effective for snippets)
  const constReassigned = new Set();
  for (const [name, info] of declared) {
    if (JS_KEYWORDS.has(name)) continue;
    const uses = clean.match(new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`, "g")) || [];
    if (uses.length <= 1 && !name.startsWith("_")) {
      add(info.line, "warning", "unused-variable", `'${name}' is declared but never used`, "remove it, or prefix with _ if intentional");
    }
    if (info.kind === "const") {
      const re = new RegExp(`(^|[^.\\w$])${name.replace(/\$/g, "\\$")}\\s*(=(?![=>])|\\+\\+|--|[+\\-*/%]=)`, "g");
      let m2, count = 0;
      while ((m2 = re.exec(clean))) count++;
      if (count > 1 && !constReassigned.has(name)) { // first hit is the declaration itself
        constReassigned.add(name);
        const idx = clean.split("\n").findIndex((l, i2) => i2 + 1 > info.line && re.source && new RegExp(`(^|[^.\\w$])${name.replace(/\$/g, "\\$")}\\s*(=(?![=>])|\\+\\+|--|[+\\-*/%]=)`).test(l));
        add(idx >= 0 ? idx + 1 : info.line, "error", "const-reassign", `'${name}' is const (declared line ${info.line}) but reassigned — TypeError at runtime`, "declare it with let, or stop reassigning");
      }
    }
  }

  issues.sort((a, b) => a.line - b.line || (a.severity === "error" ? -1 : 1));
  const counts = { error: 0, warning: 0, info: 0 };
  for (const x of issues) counts[x.severity]++;

  return {
    lines: source.split("\n").length,
    bytes: Buffer.byteLength(source, "utf8"),
    syntax: { ok: syntaxOk, errors: issues.filter((x) => x.rule === "syntax/parse") },
    issues,
    counts,
    verdict: counts.error ? "errors" : counts.warning ? "warnings" : "clean",
  };
}
