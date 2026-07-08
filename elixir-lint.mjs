// elixir-lint.mjs — deterministic Elixir linter for POST /api/lint/elixir.
//
// Pure static analysis: the source is tokenized and pattern-checked, never
// compiled or executed (Elixir compilation runs macros, so even `mix compile`
// on untrusted code would be code execution — this kit never goes there).
// No dependencies, no AI. Findings carry line numbers, severity, and a fix hint.

const BLOCK_KEYWORDS = new Set(["if", "unless", "case", "cond", "receive", "try", "defmodule"]);
const COND_KEYWORDS = new Set(["if", "unless", "case", "cond"]);
const KEYWORDS = new Set([
  "do", "end", "fn", "if", "unless", "else", "case", "cond", "for", "with",
  "receive", "try", "rescue", "catch", "after", "when", "and", "or", "not",
  "in", "def", "defp", "defmodule", "defmacro", "defmacrop", "defstruct",
  "defimpl", "defprotocol", "defdelegate", "defguard", "defguardp",
  "defexception", "defoverridable", "alias", "import", "require", "use",
  "quote", "unquote", "unquote_splicing", "super", "true", "false", "nil",
  "raise", "throw", "reraise", "spawn", "send", "self",
]);

// Longest-first so `===` wins over `==` wins over `=`.
const OPERATORS = [
  "<<<", ">>>", "|||", "&&&", "^^^", "~~~", "===", "!==", "<~>", "|~>", "<|>",
  "->", "<-", "=>", "<=", ">=", "==", "!=", "&&", "||", "++", "--", "<>",
  "|>", "::", "..", "=~", "\\\\", "**", "<<", ">>",
  "+", "-", "*", "/", "=", "<", ">", "!", "&", "|", "^", "%", ".", ",", ";", "@", "?",
];

const SIGIL_PAIRS = { "(": ")", "[": "]", "{": "}", "<": ">" };
const OPEN_PUNCS = new Set(["(", "[", "{", "<<"]);
const CLOSE_FOR = { "(": ")", "[": "]", "{": "}", "<<": ">>" };

function isIdentStart(c) { return /[a-zA-Z_]/.test(c); }
function isIdentChar(c) { return /[a-zA-Z0-9_]/.test(c); }
function isDigit(c) { return /[0-9]/.test(c); }

// ---------------------------------------------------------------------------
// Tokenizer. Emits {t, v, line} where t is one of:
//   id, key (kw-list key like `do:`), atom, str, chl (charlist), sigil,
//   num, charlit, op, punc
// String interpolation (#{...}) is tokenized inline so variables used inside
// strings still count as used. A context stack handles nesting.
// ---------------------------------------------------------------------------
function tokenize(src) {
  const tokens = [];
  const errors = []; // lexer-level problems (unterminated string, etc.)
  let i = 0;
  let line = 1;
  const n = src.length;
  // ctx: {type:"code", braces} | {type:"str", close, open, heredoc, interp, kind, depth, startLine}
  const ctxs = [{ type: "code", braces: 0 }];

  const push = (t, v) => tokens.push({ t, v, line });

  while (i < n) {
    const ctx = ctxs[ctxs.length - 1];
    const c = src[i];

    if (ctx.type === "str") {
      if (c === "\n") { line++; i++; continue; }
      if (!ctx.raw && c === "\\") { i += 2; continue; }
      if (ctx.interp && c === "#" && src[i + 1] === "{") {
        ctxs.push({ type: "code", braces: 0 });
        i += 2;
        continue;
      }
      if (ctx.open && c === ctx.open && ctx.open !== ctx.close) { ctx.depth++; i++; continue; }
      if (ctx.heredoc) {
        if (c === ctx.close[0] && src.startsWith(ctx.close, i)) {
          ctxs.pop();
          tokens.push({ t: ctx.kind, v: "", line: ctx.startLine });
          i += ctx.close.length;
          if (ctx.kind === "sigil") while (i < n && /[a-zA-Z0-9]/.test(src[i])) i++;
          continue;
        }
      } else if (c === ctx.close) {
        if (ctx.depth > 0) { ctx.depth--; i++; continue; }
        ctxs.pop();
        tokens.push({ t: ctx.kind, v: "", line: ctx.startLine });
        i++;
        if (ctx.kind === "sigil") while (i < n && /[a-zA-Z0-9]/.test(src[i])) i++;
        continue;
      }
      i++;
      continue;
    }

    // --- code context ---
    if (c === "\n") { line++; i++; continue; }
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }

    if (c === "#") { // comment to end of line
      while (i < n && src[i] !== "\n") i++;
      continue;
    }

    // strings / heredocs / charlists
    if (src.startsWith('"""', i)) {
      ctxs.push({ type: "str", close: '"""', heredoc: true, interp: true, kind: "str", depth: 0, startLine: line });
      i += 3; continue;
    }
    if (src.startsWith("'''", i)) {
      ctxs.push({ type: "str", close: "'''", heredoc: true, interp: true, kind: "chl", depth: 0, startLine: line });
      i += 3; continue;
    }
    if (c === '"') {
      ctxs.push({ type: "str", close: '"', interp: true, kind: "str", depth: 0, startLine: line });
      i++; continue;
    }
    if (c === "'") {
      ctxs.push({ type: "str", close: "'", interp: true, kind: "chl", depth: 0, startLine: line });
      i++; continue;
    }

    // sigils: ~r/.../, ~s(...), ~w[...]a, ~D"...", uppercase = raw
    if (c === "~" && /[a-zA-Z]/.test(src[i + 1] || "")) {
      let j = i + 1;
      const lower = /[a-z]/.test(src[j]);
      if (lower) j++; else while (j < n && /[A-Z]/.test(src[j])) j++;
      const open = src[j];
      if (open && "/|\"'([{<".includes(open)) {
        const heredoc = src.startsWith('"""', j) || src.startsWith("'''", j);
        const close = heredoc ? src.slice(j, j + 3) : (SIGIL_PAIRS[open] || open);
        ctxs.push({
          type: "str", kind: "sigil", startLine: line, depth: 0,
          open: SIGIL_PAIRS[open] ? open : null, close, heredoc,
          interp: lower, raw: !lower,
        });
        i = j + (heredoc ? 3 : 1);
        continue;
      }
      push("op", "~"); i++; continue;
    }

    // ? char literal (?a, ?\n). Identifiers ending in ? are lexed as idents below.
    if (c === "?") {
      if (src[i + 1] === "\\") { push("charlit", src.slice(i, i + 3)); i += 3; }
      else { push("charlit", src.slice(i, i + 2)); i += 2; }
      continue;
    }

    // atoms
    if (c === ":" && src[i + 1] === '"') {
      ctxs.push({ type: "str", close: '"', interp: true, kind: "atom", depth: 0, startLine: line });
      i += 2; continue;
    }
    if (c === ":" && isIdentStart(src[i + 1] || "")) {
      let j = i + 1;
      while (j < n && isIdentChar(src[j])) j++;
      if (src[j] === "?" || src[j] === "!") j++;
      push("atom", src.slice(i, j)); i = j; continue;
    }

    // identifiers / kw-list keys
    if (isIdentStart(c)) {
      let j = i;
      while (j < n && isIdentChar(src[j])) j++;
      if (src[j] === "?" || src[j] === "!") j++;
      const word = src.slice(i, j);
      if (src[j] === ":" && /[\s\n)\]}]/.test(src[j + 1] || " ") === false && /\s/.test(src[j + 1] || " ")) {
        push("key", word); i = j + 1; continue;
      }
      if (src[j] === ":" && /\s/.test(src[j + 1] || " ")) { push("key", word); i = j + 1; continue; }
      push("id", word); i = j; continue;
    }

    // numbers
    if (isDigit(c)) {
      let j = i;
      if (c === "0" && /[xbo]/.test(src[i + 1] || "")) {
        j = i + 2;
        while (j < n && /[0-9a-fA-F_]/.test(src[j])) j++;
      } else {
        while (j < n && /[0-9_]/.test(src[j])) j++;
        if (src[j] === "." && isDigit(src[j + 1] || "")) {
          j++;
          while (j < n && /[0-9_]/.test(src[j])) j++;
        }
        if (/[eE]/.test(src[j] || "") && /[0-9+-]/.test(src[j + 1] || "")) {
          j += 2;
          while (j < n && isDigit(src[j])) j++;
        }
      }
      push("num", src.slice(i, j)); i = j; continue;
    }

    // punctuation with interpolation-aware brace tracking
    if (c === "{") { ctx.braces++; push("punc", "{"); i++; continue; }
    if (c === "}") {
      if (ctx.braces > 0) { ctx.braces--; push("punc", "}"); i++; continue; }
      if (ctxs.length > 1) { ctxs.pop(); i++; continue; } // end of #{...}
      push("punc", "}"); i++; continue;
    }
    if ("()[]".includes(c)) { push("punc", c); i++; continue; }

    // operators (longest match first); << >> emitted as punc for balancing
    let matched = null;
    for (const op of OPERATORS) {
      if (src.startsWith(op, i)) { matched = op; break; }
    }
    if (matched) {
      if (matched === "<<" || matched === ">>") push("punc", matched);
      else push("op", matched);
      i += matched.length;
      continue;
    }

    i++; // unknown char — skip
  }

  for (const ctx of ctxs) {
    if (ctx.type === "str") {
      const what = ctx.kind === "chl" ? "charlist" : ctx.kind === "sigil" ? "sigil" : "string";
      errors.push({ line: ctx.startLine, message: `unterminated ${what} (opened here, never closed)` });
    }
  }
  return { tokens, lexErrors: errors };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------
export function lintElixir(source) {
  const issues = [];
  const add = (line, severity, rule, message, hint) => {
    issues.push({ line, severity, rule, message, ...(hint ? { hint } : {}) });
  };

  const { tokens, lexErrors } = tokenize(source);
  for (const e of lexErrors) add(e.line, "error", "syntax/unterminated", e.message, "check quotes and heredoc terminators");

  const sig = (k) => tokens[k]; // shorthand
  const prevSig = (k) => (k > 0 ? tokens[k - 1] : null);

  // --- block & bracket balance, plus scope frames for rebinding analysis ---
  const stack = [];
  let lastKeyword = null; // most recent construct keyword at code level
  const outerAssigned = new Map(); // var -> first line, assignments outside unbound-cond blocks
  const rebindWarned = new Set();

  const inUnboundCond = () => stack.some((f) => f.kind === "do" && f.unboundCond);

  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k];

    if (tk.t === "id" && BLOCK_KEYWORDS.has(tk.v)) {
      const p = prevSig(k);
      const bound = !!p && ((p.t === "op" && ["=", "|>", "->", "<-", "when", "++", "<>"].includes(p.v)) || (p.t === "punc" && ["(", "[", "{"].includes(p.v)) || (p.t === "op" && p.v === ",") || p.t === "key");
      lastKeyword = { v: tk.v, line: tk.line, bound, tokenIndex: k };
    }
    if (tk.t === "id" && (tk.v === "for" || tk.v === "with" || tk.v === "def" || tk.v === "defp" || tk.v === "fn")) {
      lastKeyword = { v: tk.v, line: tk.line, bound: true, tokenIndex: k };
    }

    if (tk.t === "punc" && OPEN_PUNCS.has(tk.v)) {
      stack.push({ kind: tk.v, line: tk.line });
      continue;
    }
    if (tk.t === "punc" && [")", "]", "}", ">>"].includes(tk.v)) {
      const top = stack[stack.length - 1];
      const expected = top && CLOSE_FOR[top.kind];
      if (top && expected === tk.v) stack.pop();
      else if (top && (top.kind === "do" || top.kind === "fn")) {
        add(tk.line, "error", "syntax/unbalanced", `'${tk.v}' found while a '${top.opener || top.kind}' block from line ${top.line} is still open`, "close the block with 'end' first");
      } else if (top) {
        add(tk.line, "error", "syntax/unbalanced", `'${tk.v}' does not match '${top.kind}' opened on line ${top.line}`);
        stack.pop();
      } else {
        add(tk.line, "error", "syntax/unbalanced", `'${tk.v}' has nothing to close`);
      }
      continue;
    }
    if (tk.t === "id" && tk.v === "do") {
      const opener = lastKeyword && lastKeyword.line <= tk.line ? lastKeyword : null;
      stack.push({
        kind: "do", line: tk.line,
        opener: opener ? opener.v : null,
        unboundCond: !!(opener && COND_KEYWORDS.has(opener.v) && !opener.bound),
      });
      lastKeyword = null;
      continue;
    }
    if (tk.t === "id" && tk.v === "fn") {
      stack.push({ kind: "fn", line: tk.line });
      continue;
    }
    if (tk.t === "id" && tk.v === "end") {
      const top = stack[stack.length - 1];
      if (!top) add(tk.line, "error", "syntax/unbalanced", "'end' with no matching 'do' or 'fn'");
      else if (top.kind === "do" || top.kind === "fn") stack.pop();
      else add(tk.line, "error", "syntax/unbalanced", `'end' found while '${top.kind}' from line ${top.line} is still open`, `close '${top.kind}' with '${CLOSE_FOR[top.kind]}' first`);
      continue;
    }

    // assignment detection: id '=' (single), with pin/field exclusions
    if (tk.t === "id" && !KEYWORDS.has(tk.v) && /^[a-z_]/.test(tk.v)) {
      const nx = tokens[k + 1];
      const pv = prevSig(k);
      const isAssign = nx && nx.t === "op" && nx.v === "=" && !(pv && pv.t === "op" && (pv.v === "." || pv.v === "^" || pv.v === "@"));
      if (isAssign) {
        if (inUnboundCond() && outerAssigned.has(tk.v) && !rebindWarned.has(tk.v)) {
          rebindWarned.add(tk.v);
          add(tk.line, "warning", "scope/rebind-in-block",
            `'${tk.v} = ...' inside this block does not change '${tk.v}' outside it (first bound on line ${outerAssigned.get(tk.v)})`,
            `bind the block's result instead: ${tk.v} = if ... do ... else ... end`);
        } else if (!inUnboundCond() && !outerAssigned.has(tk.v)) {
          outerAssigned.set(tk.v, tk.line);
        }
      }
    }
  }
  for (const f of stack) {
    if (f.kind === "do" || f.kind === "fn") {
      add(f.line, "error", "syntax/unbalanced", `'${f.opener ? f.opener + " " : ""}${f.kind === "fn" ? "fn" : "do"}' block opened here is never closed`, "add a matching 'end'");
    } else {
      add(f.line, "error", "syntax/unbalanced", `'${f.kind}' opened here is never closed`, `add a matching '${CLOSE_FOR[f.kind]}'`);
    }
  }

  // --- token-pattern checks ---
  const cmpOps = new Set(["==", "===", "!=", "!==", "<>"]);
  // vars bound directly to a charlist literal (name = 'bob') so the
  // charlist-vs-string check works through one level of indirection
  const chlVars = new Set();
  for (let k = 0; k + 2 < tokens.length; k++) {
    if (tokens[k].t === "id" && tokens[k + 1].t === "op" && tokens[k + 1].v === "=" && tokens[k + 2].t === "chl") {
      chlVars.add(tokens[k].v);
    }
  }
  const isChl = (t) => !!t && (t.t === "chl" || (t.t === "id" && chlVars.has(t.v)));
  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k];
    const nx = tokens[k + 1];
    const nx2 = tokens[k + 2];
    const pv = prevSig(k);

    // return
    if (tk.t === "id" && tk.v === "return" && !(nx && nx.t === "op" && nx.v === "=")) {
      add(tk.line, "error", "no-return", "Elixir has no 'return' — functions return their last expression", "restructure with if/case/cond so the desired value is the final expression");
    }
    // string concatenation with +
    if (tk.t === "op" && tk.v === "+" && ((pv && pv.t === "str") || (nx && nx.t === "str"))) {
      add(tk.line, "error", "string-concat-plus", "'+' cannot concatenate strings (ArithmeticError at runtime)", "use <> for binaries: \"a\" <> \"b\"");
    }
    // <> with a number or charlist
    if (tk.t === "op" && tk.v === "<>" && ((pv && (pv.t === "num" || pv.t === "chl")) || (nx && (nx.t === "num" || nx.t === "chl")))) {
      const which = (pv && pv.t === "num") || (nx && nx.t === "num") ? "a number" : "a charlist";
      add(tk.line, "error", "concat-non-binary", `'<>' with ${which} raises ArgumentError — it only joins binaries (double-quoted strings)`, which === "a number" ? "interpolate instead: \"...#{n}...\"" : "use double quotes to make it a String");
    }
    // charlist vs string comparison
    if (tk.t === "op" && cmpOps.has(tk.v) && pv && nx) {
      const pair = (a, b) => (isChl(a) && b.t === "str") || (a.t === "str" && isChl(b));
      if (pair(pv, nx)) {
        add(tk.line, "warning", "charlist-vs-string", "comparing a single-quoted charlist with a double-quoted String — 'abc' == \"abc\" is always false", "use double quotes on both sides");
      }
    }
    // field assignment x.y = v
    if (tk.t === "op" && tk.v === "." && pv && (pv.t === "id" || (pv.t === "punc" && pv.v === ")")) && nx && nx.t === "id" && nx2 && nx2.t === "op" && nx2.v === "=") {
      add(tk.line, "error", "immutable-field-assign", `cannot assign to '${pv.t === "id" ? pv.v : "…"}.${nx.v}' — Elixir data is immutable`, `build an updated copy: %{${pv.t === "id" ? pv.v : "map"} | ${nx.v}: value} or Map.put/3`);
    }
    // trailing comma
    if (tk.t === "op" && tk.v === "," && nx && nx.t === "punc" && [")", "]", "}"].includes(nx.v)) {
      add(tk.line, "error", "syntax/trailing-comma", `trailing comma before '${nx.v}' is a syntax error in Elixir`, "remove the comma");
    }
    // semicolons
    if (tk.t === "op" && tk.v === ";") {
      add(tk.line, "info", "style/semicolon", "';' is unidiomatic — write one expression per line");
    }
    // IO.inspect left in
    if (tk.t === "id" && tk.v === "IO" && nx && nx.t === "op" && nx.v === "." && nx2 && nx2.t === "id" && nx2.v === "inspect") {
      add(tk.line, "info", "debug/io-inspect", "IO.inspect looks like leftover debug output");
    }
    // length(x) compared to 0
    if (tk.t === "id" && tk.v === "length" && nx && nx.t === "punc" && nx.v === "(") {
      let depth = 0, m = k + 1;
      for (; m < tokens.length; m++) {
        if (tokens[m].t === "punc" && tokens[m].v === "(") depth++;
        if (tokens[m].t === "punc" && tokens[m].v === ")") { depth--; if (depth === 0) break; }
      }
      const cmp = tokens[m + 1], zero = tokens[m + 2];
      if (cmp && cmp.t === "op" && [">", "==", "<", ">=", "<=", "!="].includes(cmp.v) && zero && zero.t === "num" && zero.v === "0") {
        add(tk.line, "info", "perf/length-zero", "length/1 walks the whole list — O(n) just to check emptiness", "use list == [] or Enum.empty?(list)");
      }
    }
  }

  // --- condition-region checks: missing do, = in condition, = in guard ---
  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k];
    if (tk.t === "id" && (COND_KEYWORDS.has(tk.v) || tk.v === "receive" || tk.v === "try" || tk.v === "defmodule")) {
      // ignore when used as a plain atom/key or field: previous token '.' or ':'
      const pv = prevSig(k);
      if (pv && pv.t === "op" && (pv.v === "." || pv.v === "@")) continue;
      let depth = 0;
      let foundDo = false;
      let m = k + 1;
      for (; m < tokens.length; m++) {
        const t2 = tokens[m];
        if (t2.t === "punc" && ["(", "[", "{", "<<"].includes(t2.v)) depth++;
        if (t2.t === "punc" && [")", "]", "}", ">>"].includes(t2.v)) { if (depth === 0) break; depth--; }
        if (depth === 0 && ((t2.t === "id" && t2.v === "do") || (t2.t === "key" && t2.v === "do"))) { foundDo = true; break; }
        if (depth === 0 && t2.t === "id" && (t2.v === "end" || BLOCK_KEYWORDS.has(t2.v) || t2.v === "def" || t2.v === "defp")) break;
        // statement break: evaluated only at a line transition — the expression
        // continues when the previous line ends in an operator/open bracket or
        // the new line leads with an operator (|>, and, etc.)
        if (depth === 0 && t2.line > tk.line && tokens[m - 1] && t2.line > tokens[m - 1].line) {
          const before = tokens[m - 1];
          const wordOp = (t) => t.t === "id" && ["and", "or", "not", "when", "in"].includes(t.v);
          const continues = (before.t === "op" && before.v !== ";") || (before.t === "punc" && ["(", "[", "{", "<<"].includes(before.v)) || before.t === "key" || wordOp(before) || t2.t === "op" || wordOp(t2);
          if (!continues) break;
        }
        // = in condition region (single =, not inside parens of a call)
        if (COND_KEYWORDS.has(tk.v) && t2.t === "op" && t2.v === "=" && depth === 0) {
          const before = tokens[m - 1];
          const pinned = before && before.t === "op" && before.v === "^";
          if (!pinned) {
            add(t2.line, "warning", "assign-in-condition", `'=' in this ${tk.v} condition binds a value — did you mean '=='?`, "use == to compare; if the bind is intentional, wrap it in parentheses to make it explicit");
          }
        }
      }
      if (!foundDo) {
        add(tk.line, "error", "syntax/missing-do", `'${tk.v}' has no 'do' — its body will not parse`, `write: ${tk.v} ... do ... end (or the one-liner form: , do: ...)`);
      }
    }
    // when guard: = between 'when' and 'do'/'->'
    if (tk.t === "id" && tk.v === "when") {
      let depth = 0;
      for (let m = k + 1; m < tokens.length; m++) {
        const t2 = tokens[m];
        if (t2.t === "punc" && ["(", "[", "{", "<<"].includes(t2.v)) depth++;
        if (t2.t === "punc" && [")", "]", "}", ">>"].includes(t2.v)) { if (depth === 0) break; depth--; }
        if ((t2.t === "id" && t2.v === "do") || (t2.t === "key" && t2.v === "do") || (t2.t === "op" && t2.v === "->")) break;
        if (t2.t === "op" && t2.v === "=" && depth === 0) {
          add(t2.line, "error", "assign-in-guard", "'=' is not allowed in a guard — guards cannot bind variables", "use == to compare");
          break;
        }
      }
    }
  }

  // --- unused variables (mirrors the compiler warning) ---
  {
    const assigns = new Map(); // name -> {line, count}
    const uses = new Map(); // name -> count (non-assign occurrences)
    for (let k = 0; k < tokens.length; k++) {
      const tk = tokens[k];
      if (tk.t !== "id" || KEYWORDS.has(tk.v) || !/^[a-z_]/.test(tk.v)) continue;
      const nx = tokens[k + 1];
      const pv = prevSig(k);
      const isCall = nx && nx.t === "punc" && nx.v === "(";
      const isAssign = nx && nx.t === "op" && nx.v === "=" && !(pv && pv.t === "op" && (pv.v === "." || pv.v === "^"));
      const isFieldOrRemote = pv && pv.t === "op" && pv.v === ".";
      if (isAssign) {
        const a = assigns.get(tk.v) || { line: tk.line, count: 0 };
        a.count++;
        assigns.set(tk.v, a);
      } else if (!isCall && !isFieldOrRemote) {
        uses.set(tk.v, (uses.get(tk.v) || 0) + 1);
      }
    }
    for (const [name, a] of assigns) {
      if (!name.startsWith("_") && !uses.has(name)) {
        add(a.line, "warning", "unused-variable", `variable '${name}' is bound but never used (the compiler warns about this too)`, `prefix it with an underscore (_${name}) if intentional`);
      }
    }
  }

  // charlist presence note (only if nothing stronger fired about charlists)
  if (!issues.some((x) => x.rule === "charlist-vs-string" || x.rule === "concat-non-binary")) {
    const firstChl = tokens.find((t) => t.t === "chl");
    if (firstChl) {
      add(firstChl.line, "info", "charlist-note", "single quotes create a charlist, not a String — most string APIs expect double quotes");
    }
  }

  issues.sort((a, b) => a.line - b.line || (a.severity === "error" ? -1 : 1));

  const counts = { error: 0, warning: 0, info: 0 };
  for (const x of issues) counts[x.severity]++;
  const syntaxErrors = issues.filter((x) => x.rule.startsWith("syntax/"));
  const lines = source.split("\n").length;

  return {
    lines,
    bytes: Buffer.byteLength(source, "utf8"),
    structure: {
      modules: tokens.filter((t) => t.t === "id" && t.v === "defmodule").length,
      functions: tokens.filter((t) => t.t === "id" && (t.v === "def" || t.v === "defp")).length,
    },
    syntax: { ok: syntaxErrors.length === 0, errors: syntaxErrors },
    issues,
    counts,
    verdict: counts.error ? "errors" : counts.warning ? "warnings" : "clean",
  };
}
