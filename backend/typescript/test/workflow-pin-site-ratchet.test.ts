/**
 * WF-KB-2 — the ORIGIN ratchet for `registerWorkflow` call sites.
 *
 * WHY THIS FILE EXISTS. `builtin-workflow-ratchet.test.ts` is the ADR 0472
 * ratchet, and its entire notion of "a code-pinned workflow" is one array:
 *
 *   function currentBuiltinIds() { return LEGACY_PINNED_WORKFLOWS.map(...) }
 *
 * That polices a SPELLING, not the invariant. A feature that never enrolled in
 * `LEGACY_PINNED_WORKFLOWS` and instead calls `registerWorkflow({...})` directly
 * on a boot path is STRUCTURALLY INVISIBLE to it — the quarantine is empty, the
 * baseline is zero, every assertion is green, and a hard-coded, UI-unreachable,
 * ownership-less workflow ships anyway.
 *
 * The companion whole-app scan was blind for a second, independent reason: it
 * matched the `: WorkflowDefinition` TYPE ANNOTATION. An inline object literal
 * passed straight to `registerWorkflow(` carries no annotation and matched
 * nothing, so a pass reported "GEN-1 CLEAN" over SIX live pin sites.
 *
 * WHAT THIS GATE BINDS INSTEAD — the DEFINITION'S ORIGIN, not its syntax.
 * Every `registerWorkflow(` / `registerWorkflowDurable(` call site in `src/` is
 * resolved to where its definition CAME FROM:
 *
 *   DERIVED   — a request body, `expandChain(...)`, or the agent-composition
 *               pipeline. The sanctioned runtime lane; paired with
 *               `recordOwnership` so the result is tenant-owned, builder-visible
 *               and reclaimed by tenant teardown.
 *   IN-TREE   — an object literal written in this repo (inline, a module `const`,
 *               or a module-local factory — `function` OR arrow — that returns one).
 *
 * A registration of an IN-TREE literal that is not paired with `recordOwnership`
 * is a PIN SITE: invisible to `/builder` + the `/` picker (both list only the
 * tenant ownership index), not user-editable, unreachable by
 * `purgeTenantOwnedWorkflowDefs` at account deletion, and re-registered
 * unconditionally on every cold boot.
 *
 * ── R2 REVIEW (F5): THREE WAYS THIS GATE COULD BE LAUNDERED, AND WHAT CHANGED ──
 *
 * 1. OWNERSHIP WAS A FILE-WIDE FLAG. `recordsOwnership = /recordOwnership\(/.test(src)`
 *    meant that adding a genuine boot-path `registerWorkflow({workflowId:'…',nodes:[…]})`
 *    to ANY of the nine sanctioned modules stayed green — the module's UNRELATED
 *    ownership call, in an unrelated function, suppressed it. Ownership is now paired
 *    at the REGISTRATION SITE: `recordOwnership` must appear inside the innermost
 *    enclosing FUNCTION of that call. (File-wide is still computed, but only to
 *    answer the separate question "does this sanctioned lane record ownership at all".)
 *
 * 2. A SPREAD OF A DERIVED PRODUCT READ AS AN IN-TREE LITERAL, so the docblock's
 *    claim that the resolver "answers true only when it can actually SEE the literal"
 *    was FALSE on this branch: `{ ...expandChain(…), workflowId }` starts with `{`,
 *    and that was the whole test. MEASURED before the fix: 16 sites, 7 pinned, and
 *    THREE modules classified IN-TREE *and* ownership-recording —
 *    `features/strategy/cadence.ts`, `features/crm/gmailSyncService.ts`,
 *    `host/collab/workflowCollabResource.ts` — i.e. three live false positives whose
 *    only reason for not being red was the file-wide flag in (1). Fixing (1) without
 *    (2) would have turned all three red. An object literal is now resolved THROUGH
 *    its top-level spreads.
 *
 * 3. THREE SHAPES NEVER ENTERED THE SCAN AT ALL, so no ledger could fire:
 *    an ARROW factory (`const mk = () => ({…})` — the house style; the old lookup
 *    only matched `function <name>`), an ALIASED import (`registerWorkflow as reg`
 *    — which `routes/workflows.ts:34` ALREADY uses, hiding the real
 *    `reRegisterWorkflow(patched)` registration at :561), and a POINT-FREE pass
 *    (`defs.forEach(registerWorkflow)`). Aliases are now resolved and scanned as
 *    call sites; a registrar used as a VALUE is ledgered separately
 *    (`VALUE_REFERENCES`) because the scanner cannot follow it to the call.
 *
 * Plus two precision bugs in the resolver itself: the declaration lookup took the
 * FIRST `const <name> =` anywhere in the file rather than the nearest one preceding
 * the call (`gmailSyncService.ts` has two `const def`; it was correct only by luck),
 * and `argumentAt` counted `(`/`{`/`[` inside string literals, so
 * `registerWorkflow({ name: 'a) b' })` truncated the argument.
 *
 * ── STATED RESIDUALS (an honest limit is fine; a silent one is not) ──
 *
 *   R1  INDIRECT REGISTRATION. A module that takes an injected registrar
 *       (`SubChainDeps.register: (def: WorkflowDefinition) => void`,
 *       `host/workflowChainPackLoader.ts`) registers definitions the scanner
 *       cannot attribute — it sees a call to `deps.register`, not to
 *       `registerWorkflow`. NOT statically resolvable here without following the
 *       injection across modules. Detected as a SEAM and held in the exact-match
 *       `INDIRECT_REGISTRATION_SEAMS` ledger: a new one fails red and must state
 *       who supplies the registrar.
 *   R2  VALUE REFERENCES. A registrar passed as a value (`forEach(registerWorkflow)`,
 *       re-exported, stored on an object) is DETECTED but not FOLLOWED: the
 *       definition's origin at the eventual call is unknown. Ledgered exact-match
 *       in `VALUE_REFERENCES`, empty today.
 *   R3  ASSIGNMENT-ONLY BINDINGS. `let def: WorkflowDefinition;` followed by
 *       `def = …` is not resolved (no initializer on the declaration) and reports
 *       DERIVED. Conservative direction; the tier-3 module fallback and the
 *       exact-match ledgers are what cover it.
 *   R4  A literal that spreads a derived product AND ALSO writes `workflowId:` +
 *       `nodes:` of its own is deliberately classified IN-TREE — the substance of
 *       the definition is written in this repo, whatever it is layered on.
 *   R5  CROSS-MODULE ORIGIN. The resolver is single-file: a definition imported
 *       from a sibling module reports DERIVED. Covered only by tier 3 + the ledgers.
 *   R6  NO TOKENIZER. Comments and string/template literals are handled; REGEX
 *       literals are not, so an unbalanced `{`/`}` inside one (`/\d{2/` cannot
 *       occur, but `/[{]/` can) would shift the enclosing-function region for a
 *       later call in that file. This is a regex scanner, not a parser; the cure
 *       if it ever bites is a real parse, not a bigger regex.
 *
 * ── MEASURED, NOT ASSERTED (each sabotage applied to REAL source, then reverted) ──
 * Each shape below was appended to `features/crm/gmailSyncService.ts` — a SANCTIONED
 * module, i.e. the best available laundering host — and both gates were run:
 *
 *   sabotage appended to gmailSyncService.ts        OLD gate   THIS gate
 *   ------------------------------------------------------------------------------
 *   registerWorkflowDurable({workflowId,nodes,edges})  10/10 ✅  RED (quarantine)
 *   const mkPin = (id) => ({workflowId,nodes,edges})   10/10 ✅  RED (quarantine)
 *   defs.forEach(registerWorkflowDurable)              10/10 ✅  RED (R2 ledger)
 *   interface PinDeps { register: (def: WD) => void }  10/10 ✅  RED (R1 ledger)
 *   import {registerWorkflow as regAlias}; regAlias({…})10/10 ✅  RED (quarantine)
 *
 * NEGATIVE CONTROL — a legitimate `expandChain → {...expanded, workflowId} →
 * registerWorkflowDurable → recordOwnership` function appended to the same module
 * stays GREEN, so the gate is not simply refusing everything.
 *
 * THE LEDGERS BELOW ARE EXACT-MATCH, both directions:
 *   - a NEW pin site (a file the scanner classifies as pinned and the quarantine
 *     does not list) fails RED — this is the guard the old ratchet could not give;
 *   - a pin site that has been FIXED and left in the quarantine also fails RED, so
 *     the list can never become a stale claim;
 *   - the quarantine is SHRINK-ONLY (`PIN_SITE_CEILING`), so it can be drained but
 *     never quietly grown. (A prior ratchet in this repo allowed exactly that.)
 *
 * See docs/adr/0581-kb-detectors-and-vector-isolation.md §D1,
 * docs/adr/0472-retire-builtin-workflows-seam.md, and CLAUDE.md
 * § "Workflows — never hard-code (chains or stacks)".
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(__dirname, '..', 'src');

/** The registry module itself declares the functions; it is not a call site. */
const REGISTRY_MODULE = 'host/workflowsRegistry.ts';

/** The registrar names as IMPORTED. Aliases are resolved per file (see `callNamesFor`). */
const REGISTRAR_NAMES = ['registerWorkflow', 'registerWorkflowDurable'] as const;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.includes('__tests__')) out.push(p);
  }
  return out;
}

const rel = (file: string): string => file.slice(SRC_ROOT.length + 1).split('\\').join('/');

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Strip comments BEFORE scanning. This repo has been bitten by ratchet gates that
 * counted comments as code — and this one would have been the next: the very
 * docblock that explains a migration away from `registerWorkflow({...})` quotes the
 * call, so the fixed module kept reading as a pin site. Block comments first, then
 * line comments (guarded against `://` in a URL literal).
 */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/**
 * Index of the closing quote of the string literal starting at `i`.
 * Template literals skip their `${…}` interpolations (which may nest strings).
 * F5: `argumentAt` previously counted brackets inside string literals, so
 * `registerWorkflow({ name: 'a) b' })` truncated the argument mid-expression.
 */
export function skipString(src: string, i: number): number {
  const q = src[i]!;
  for (let j = i + 1; j < src.length; j += 1) {
    const c = src[j]!;
    if (c === '\\') { j += 1; continue; }
    if (q === '`' && c === '$' && src[j + 1] === '{') {
      let d = 0;
      let k = j + 1;
      for (; k < src.length; k += 1) {
        const e = src[k]!;
        if (e === '"' || e === "'" || e === '`') { k = skipString(src, k); continue; }
        if (e === '{') d += 1;
        else if (e === '}') { d -= 1; if (d === 0) break; }
      }
      j = k;
      continue;
    }
    if (c === q) return j;
  }
  return src.length;
}

/** The balanced argument text of a call whose `(` sits at `open`. String-literal aware. */
export function argumentAt(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
    if (c === '(' || c === '{' || c === '[') depth += 1;
    else if (c === ')' || c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1, Math.min(src.length, open + 2000));
}

/** Top-level `...spread` expressions of an object-literal expression. */
export function topLevelSpreads(lit: string): string[] {
  const out: string[] = [];
  let depth = 0;
  for (let i = 0; i < lit.length; i += 1) {
    const c = lit[i]!;
    if (c === '"' || c === "'" || c === '`') { i = skipString(lit, i); continue; }
    if (c === '{' || c === '(' || c === '[') { depth += 1; continue; }
    if (c === '}' || c === ')' || c === ']') { depth -= 1; continue; }
    if (depth === 1 && c === '.' && lit.startsWith('...', i)) {
      let j = i + 3;
      let d = 0;
      for (; j < lit.length; j += 1) {
        const e = lit[j]!;
        if (e === '"' || e === "'" || e === '`') { j = skipString(lit, j); continue; }
        if (e === '{' || e === '(' || e === '[') d += 1;
        else if (e === '}' || e === ')' || e === ']') { if (d === 0) break; d -= 1; }
        else if (e === ',' && d === 0) break;
      }
      out.push(lit.slice(i + 3, j).trim());
      i = j - 1;
    }
  }
  return out;
}

/** Does this object-literal expression write the SUBSTANCE of a definition itself
 *  (`workflowId:` AND `nodes:` as its own top-level keys)? See residual R4. */
export function writesDefinitionBody(lit: string): boolean {
  let depth = 0;
  const keys = new Set<string>();
  for (let i = 0; i < lit.length; i += 1) {
    const c = lit[i]!;
    if (c === '"' || c === "'" || c === '`') { i = skipString(lit, i); continue; }
    if (c === '{' || c === '(' || c === '[') { depth += 1; continue; }
    if (c === '}' || c === ')' || c === ']') { depth -= 1; continue; }
    if (depth === 1) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(lit.slice(i, i + 40));
      if (m && !/[\w$.]/.test(lit[i - 1] ?? ' ')) { keys.add(m[1]!); i += m[0].length - 1; }
    }
  }
  return keys.has('workflowId') && keys.has('nodes');
}

/**
 * The initializer text of the declaration of `name` NEAREST-PRECEDING `at`.
 * F5 precision bug: this used to `.exec(src)` and take the FIRST declaration
 * anywhere in the file. `features/crm/gmailSyncService.ts` has two `const def`;
 * it resolved correctly only by luck.
 */
function declarationInitializer(src: string, name: string, at: number): string | null {
  const re = new RegExp(`\\b(?:const|let|var)\\s+${escapeRe(name)}\\b[^=;]*=\\s*`, 'g');
  let before: RegExpExecArray | null = null;
  let after: RegExpExecArray | null = null;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m.index < at) before = m;
    else if (!after) after = m;
  }
  // A module-level `const` may be declared BELOW the function that uses it, so an
  // only-after declaration is still the right one; a preceding one always wins.
  const chosen = before ?? after;
  if (!chosen) return null;
  const from = chosen.index + chosen[0].length;
  return src.slice(from, from + 800);
}

/**
 * The body text of a module-local factory named `name`, whether written as a
 * `function` declaration OR — F5 — an arrow/function expression bound to a
 * `const`, which is this repo's house style and was entirely invisible before.
 */
function factoryBody(src: string, name: string, at: number): string | null {
  const n = escapeRe(name);
  const decl = new RegExp(`\\bfunction\\s+${n}\\s*[(<]`, 'g');
  let fn: RegExpExecArray | null = null;
  for (let m = decl.exec(src); m; m = decl.exec(src)) { if (!fn || (m.index < at)) fn = m; }
  if (fn) return src.slice(fn.index, fn.index + 6000);

  const arrow = new RegExp(
    `\\b(?:const|let|var)\\s+${n}\\b[^=;]*=\\s*(?:async\\s+)?`
    + '(?:function\\b[^{]*\\{|(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*(?::[^=;]*?)?=>)\\s*',
    'g',
  );
  let best: RegExpExecArray | null = null;
  for (let m = arrow.exec(src); m; m = arrow.exec(src)) { if (!best || m.index < at) best = m; }
  if (!best) return null;
  const from = best.index + best[0].length;
  return src.slice(from, from + 6000);
}

/** Origins that are, by construction, NOT an in-tree literal. `expandChain` is a
 *  chain-pack product; `buildChainBackedDefinition` wraps it; the compose/author
 *  pipelines build from model output or a request body. */
const DERIVED_FACTORIES = /^(expandChain|buildChainBackedDefinition|withLifecycle)$/;

/**
 * Does this argument expression resolve to a definition WRITTEN IN THIS REPO?
 *
 * High-precision by design: it answers `true` only when it can actually SEE the
 * literal — inline, a module `const`, a module-local factory (`function` or arrow)
 * whose body returns an object with a `workflowId` key, or a literal that layers on
 * one of those. A literal that merely SPREADS a value resolves through that value
 * (F5 defect #2), so `{ ...expandChain(…), workflowId }` is DERIVED, not IN-TREE.
 * Anything it cannot resolve is reported as DERIVED, so the ledger — not this
 * heuristic — is what makes an unclassified file fail. That asymmetry is deliberate:
 * a false "pinned" verdict would make the gate untrustworthy, while a missed one
 * still trips the exact-match ledger the moment the file appears.
 *
 * `at` is the offset of the call being resolved; declarations are matched
 * nearest-preceding rather than first-in-file.
 */
export function resolvesToInTreeLiteral(src: string, arg: string, at = src.length, depth = 0): boolean {
  const a = arg.trim();
  if (depth > 4) return false;

  if (a.startsWith('{')) {
    const spreads = topLevelSpreads(a);
    if (spreads.length === 0) return true;
    if (writesDefinitionBody(a)) return true; // R4 — the substance is written HERE
    return spreads.some((s) => resolvesToInTreeLiteral(src, s, at, depth + 1));
  }

  const ident = /^([A-Za-z_$][\w$]*)$/.exec(a);
  if (ident) {
    const init = declarationInitializer(src, ident[1]!, at);
    if (init === null) return false;
    return resolvesToInTreeLiteral(src, init, at, depth + 1);
  }

  const call = /^([A-Za-z_$][\w$.]*)\s*\(/.exec(a);
  if (call) {
    const fname = call[1]!.split('.').pop()!;
    if (DERIVED_FACTORIES.test(fname)) return false;
    const body = factoryBody(src, fname, at);
    if (body === null) return false;
    return /return\s*\{[\s\S]{0,6000}?\bworkflowId\s*:/.test(body)
      || /^\s*\(?\s*\{[\s\S]{0,6000}?\bworkflowId\s*:/.test(body);
  }
  return false;
}

// ─────────────────────────── enclosing-function scoping (F5 defect #1) ──────────

// `await` is here for `for await (const x of y) {`, whose head also ends in `)`.
const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'do', 'with', 'await']);

/** Positions of the `{` of every block enclosing `at`, outermost first. */
function enclosingBraceOpens(src: string, at: number): number[] {
  const stack: number[] = [];
  for (let i = 0; i < at && i < src.length; i += 1) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
    if (c === '{') stack.push(i);
    else if (c === '}') stack.pop();
  }
  return stack;
}

function matchParenBack(src: string, rparen: number): number {
  let d = 0;
  for (let i = rparen; i >= 0; i -= 1) {
    const c = src[i]!;
    if (c === ')') d += 1;
    else if (c === '(') { d -= 1; if (d === 0) return i; }
  }
  return -1;
}

/** Is the block opening at `open` a FUNCTION body (as opposed to `if`/`for`/`try`/
 *  an object literal)? Arrow bodies, `function` declarations, methods and
 *  `async (req, res) => {` handlers all qualify. */
export function isFunctionBodyOpen(src: string, open: number): boolean {
  const head = src.slice(Math.max(0, open - 400), open);
  if (/=>\s*$/.test(head)) return true;
  const m = /\)\s*(?::\s*[A-Za-z_$][\w$<>,.[\]| ]*\s*)?$/.exec(head);
  if (!m) return false;
  const rparen = Math.max(0, open - 400) + m.index;
  const lparen = matchParenBack(src, rparen);
  if (lparen < 0) return false;
  const name = /([A-Za-z_$][\w$]*)\s*$/.exec(src.slice(0, lparen));
  if (name && CONTROL_KEYWORDS.has(name[1]!)) return false;
  return true;
}

/**
 * The innermost enclosing FUNCTION body of `at` — the region in which
 * `recordOwnership` must appear for a registration to count as paired.
 * Falls back to the whole module for a top-level registration (there is no
 * tighter honest answer, and a top-level literal registration is a pin site
 * regardless).
 */
export function enclosingFunctionRegion(src: string, at: number): string {
  const opens = enclosingBraceOpens(src, at);
  for (let i = opens.length - 1; i >= 0; i -= 1) {
    const open = opens[i]!;
    if (!isFunctionBodyOpen(src, open)) continue;
    let d = 0;
    for (let j = open; j < src.length; j += 1) {
      const c = src[j]!;
      if (c === '"' || c === "'" || c === '`') { j = skipString(src, j); continue; }
      if (c === '{') d += 1;
      else if (c === '}') { d -= 1; if (d === 0) return src.slice(open, j + 1); }
    }
    return src.slice(open);
  }
  return src;
}

// ────────────────────────────── the scan ────────────────────────────────────────

/** `import { registerWorkflow as reRegisterWorkflow }` — F5 defect #3. Live in
 *  `routes/workflows.ts:34`, and the alias's call at :561 was invisible. */
function aliasesFor(src: string): string[] {
  const re = new RegExp(`\\b(?:${REGISTRAR_NAMES.join('|')})\\s+as\\s+([A-Za-z_$][\\w$]*)`, 'g');
  return [...src.matchAll(re)].map((m) => m[1]!);
}

/** Regions where a registrar name is a BINDING, not a value use: an import
 *  specifier list and a destructuring declaration (`const { registerWorkflow } =
 *  await import(...)`, which `routes/artifactTypeSeam.ts` really does). */
function maskBindings(src: string): string {
  const blank = (s: string): string => s.replace(/[^\n]/g, ' ');
  return src
    .replace(/\bimport\s*(?:type\s*)?\{[^}]*\}\s*from\s*['"][^'"]*['"]/g, blank)
    .replace(/\bexport\s*\{[^}]*\}(?:\s*from\s*['"][^'"]*['"])?/g, blank)
    .replace(/\b(?:const|let|var)\s*\{[^}]*\}\s*=/g, blank);
}

/**
 * Registrar names (incl. per-file aliases) used as a VALUE rather than called —
 * residual R2. THE SCAN AND THE SABOTAGE PROBE CALL THIS SAME FUNCTION, so a probe
 * cannot pass against a predicate the scan does not use.
 */
export function valueReferenceNames(src: string): string[] {
  const names = [...REGISTRAR_NAMES, ...aliasesFor(src)];
  const masked = maskBindings(src);
  const re = new RegExp(`\\b(${names.map(escapeRe).join('|')})\\b(?!\\s*\\()`, 'g');
  return [...new Set([...masked.matchAll(re)].map((m) => m[1]!))].sort();
}

/** A `register…: (def: WorkflowDefinition) => …` field — an INJECTED registrar
 *  the scanner cannot attribute (residual R1). */
const INJECTED_REGISTRAR_RE = /\bregister\w*\s*\??\s*:\s*\(\s*[A-Za-z_$][\w$]*\s*:\s*WorkflowDefinition\b/;

interface CallSite { name: string; inTreeLiteral: boolean; pairedWithOwnership: boolean }
interface Site {
  file: string;
  calls: CallSite[];
  /** ANY in-tree-literal registration not paired with `recordOwnership` at its site. */
  inTreeLiteral: boolean;
  /** Does the module call `recordOwnership` anywhere at all? (sanctioned-lane liveness) */
  recordsOwnership: boolean;
  tier3: boolean;
  aliases: string[];
}

/**
 * TIER 3 — the module-level fallback, for an argument expression no per-call
 * resolver can follow: a member of a loop variable (`s.definition` from
 * `for (const s of ARR) registerWorkflow(s.definition)`) resolves to nothing, yet
 * the literals are right there in the file. Exercised by the synthetic probe in
 * the sabotage test (case 6) — no live tier-3 site is required for its coverage.
 *
 * `host/workflowAuthorSeed.ts` USED to be the live tier-3 case, but WFAWF-6
 * (ADR 0596 R2) drained it to the owned-seed lane: it now pairs the same
 * `registerWorkflow(s.definition)` with `recordOwnership`, so tier-3 no longer
 * fires there — the fallback requires a module with NO `recordOwnership`.
 *
 * The fallback is deliberately narrow: it applies ONLY to a module that already
 * has neither of the two sanctioned-lane markers (`recordOwnership`, `expandChain`),
 * i.e. one that is a pin-site candidate on every other axis, AND that visibly
 * declares a definition literal (`workflowId: '…'` next to a `nodes: [`). Widening
 * it further would trade the resolver's high precision for reach it has not needed.
 */
export function declaresDefinitionLiteral(src: string): boolean {
  return /\bworkflowId\s*:\s*['"`]/.test(src) && /\bnodes\s*:\s*\[/.test(src);
}

/**
 * Classify ONE (comment-stripped) source's registration sites by definition
 * ORIGIN. Pure over the source string, so a synthetic probe can drive the FULL
 * classification — including the tier-3 fallback ACTIVATION — without a live file
 * (WFAWF-6 drained this repo's only live tier-3 site, so its activation path would
 * otherwise be witnessed by nothing).
 */
function classifyRegistrationSource(src: string): { calls: CallSite[]; inTreeLiteral: boolean; recordsOwnership: boolean; tier3: boolean; aliases: string[] } {
  const aliases = aliasesFor(src);
  const names = [...REGISTRAR_NAMES, ...aliases];
  const callRe = new RegExp(`\\b(?:${names.map(escapeRe).join('|')})\\s*\\(`, 'g');
  const calls: CallSite[] = [];
  for (const m of src.matchAll(callRe)) {
    const open = m.index! + m[0].length - 1;
    const inTreeLiteral = resolvesToInTreeLiteral(src, argumentAt(src, open), open);
    const pairedWithOwnership = /\brecordOwnership\s*\(/.test(enclosingFunctionRegion(src, open));
    calls.push({ name: m[0].slice(0, -1).trim(), inTreeLiteral, pairedWithOwnership });
  }
  const recordsOwnership = /\brecordOwnership\s*\(/.test(src);
  let inTreeLiteral = calls.some((c) => c.inTreeLiteral && !c.pairedWithOwnership);
  let tier3 = false;
  if (!calls.some((c) => c.inTreeLiteral) && !recordsOwnership
    && !/\bexpandChain\s*\(/.test(src) && declaresDefinitionLiteral(src)) {
    inTreeLiteral = true;
    tier3 = true;
  }
  return { calls, inTreeLiteral, recordsOwnership, tier3, aliases };
}

function scanRegistrationSites(): { sites: Map<string, Site>; valueRefs: string[]; injectedSeams: string[] } {
  const sites = new Map<string, Site>();
  const valueRefs: string[] = [];
  const injectedSeams: string[] = [];

  for (const file of walk(SRC_ROOT)) {
    const r = rel(file);
    const raw = readFileSync(file, 'utf8');
    const src = stripComments(raw);

    if (r !== REGISTRY_MODULE && INJECTED_REGISTRAR_RE.test(src)) injectedSeams.push(r);
    if (r === REGISTRY_MODULE) continue;

    // A registrar used as a VALUE (point-free / stored / re-exported) — residual R2.
    if (valueReferenceNames(src).length > 0) valueRefs.push(r);

    const { calls, inTreeLiteral, recordsOwnership, tier3, aliases } = classifyRegistrationSource(src);
    if (calls.length === 0) continue;
    sites.set(r, { file: r, calls, inTreeLiteral, recordsOwnership, tier3, aliases });
  }
  return { sites, valueRefs: valueRefs.sort(), injectedSeams: injectedSeams.sort() };
}

/**
 * SANCTIONED — the definition's origin is a request body, `expandChain`, or the
 * agent-composition pipeline, and the module records ownership so the result is
 * tenant-owned and builder-visible. Each entry states the ORIGIN, because that is
 * what this gate classifies on.
 */
const SANCTIONED_ORIGINS = new Map<string, string>([
  ['routes/workflows.ts', 'Request body (POST/PUT /workflows) and `expandChain` (from-chain, incl. co-registered sub-chains). Every lane pairs with `recordOwnership` — including the ALIASED `registerWorkflow as reRegisterWorkflow` promote lane, which only became visible to this scan in R2.'],
  ['host/workflowComposeTool.ts', 'The agent-composition pipeline (model-authored draft → validate → persist), `registerWorkflowDurable` + `recordOwnership`.'],
  ['host/seedWorkflows.ts', '`expandChain(chain, { deferred: true })` over loaded chain packs; each seeded id is `recordOwnership`-ed to the tenant.'],
  ['host/demoWalkthroughsSeed.ts', 'Re-registers definitions already produced by the seeder lane and records ownership (the archive/unarchive lifecycle flip).'],
  ['host/workflowAuthorSeed.ts', 'WFAWF-6 (ADR 0596 R2) — the AI-author showcase seed, same owned-in-tree-def lane as demoWalkthroughsSeed: registers the shared def (ids unchanged for replay) and records per-tenant ownership so each showcase lists in that tenant\'s builder gallery. Was quarantined; drained by pairing with `recordOwnership`.'],
  ['host/collab/workflowCollabResource.ts', 'The RFC 0056 collab resource applies a peer-authored definition off the wire (`{ ...candidate }`, candidate = the parsed Y snapshot), then `recordOwnership`.'],
  ['features/strategy/cadence.ts', '`expandChain` product of the strategy cadence chain (`{ ...expanded, workflowId }`) + `recordOwnership` (the reference shape for a per-tenant runtime instance).'],
  ['features/crm/gmailSyncService.ts', '`expandChain(chain, { params: { gmailSyncId } })` + `recordOwnership` + `recordRevision` (WF-CRM-1 fix, #3326).'],
  ['features/knowledge-sync/knowledgeSyncService.ts', 'WF-KB-3 / KSWF-1 — `ensureKnowledgeSyncWorkflow`: `expandChain(chain, { params: { sourceId } })` + `registerWorkflowDurable` + `recordRevision` + `recordOwnership` (the gmailSyncService twin — the per-source scheduled sync workflow that replaced the deleted daemon).'],
  ['features/kb/kbService.ts', 'ADR 0643 D1b — `ensureKbReindexDriver`: `expandChain(chain, { params: { orgId, collectionId } })` + `registerWorkflowDurable` + `recordRevision` + `recordOwnership` (the knowledgeSyncService twin — the per-collection scheduled reindex-drain workflow that replaced the SPA\'s `for (i < 10000) drain()` loop as the driver). UNLIKE its twin the workflow is EPHEMERAL: `reapKbReindexDriverIfTerminal` removes the ownership record and the registry row the moment the job goes terminal, so a tenant does not accumulate one `/builder` gallery entry per reindex ever run.'],
  ['features/workflow-author/workflowAuthorService.ts', 'Model-authored draft validated then persisted with `recordOwnership` — the A+ reference authoring lane.'],
  ['features/walkthroughs/walkthroughAuthorTool.ts', 'Author-tool product (transient) + `recordOwnership`.'],
]);

/**
 * SHRINK-ONLY QUARANTINE — in-tree `WorkflowDefinition` literals registered with no
 * `recordOwnership`. Each entry says what is actually true today; none is a
 * coverage claim. The cure in every case is the same and is in-doctrine: ship the
 * definition as a chain pack and register it with
 * `registerChainBackedWorkflow(chainId)` (same id ⇒ ignition and replay unchanged).
 *
 * `features/agent-knowledge/feature.ts` was the SEVENTH entry and is GONE — it is
 * the one WF-KB-1 drove to zero: the auto-ingest workflow now ships as
 * `core.openwop.workflows.agent-knowledge` and is registered chain-backed under
 * its original id.
 *
 * WF-COS-1 (2026-08-19) — the TWO assistant entries are GONE for the same
 * reason. `features/assistant/loops.ts` (three perception loops) and
 * `features/assistant/actionExecution.ts` (three approved-action executions)
 * shipped six in-tree literals from module-local `loopDefinition()` /
 * `execDefinition()` factories. All six now ship as
 * `core.openwop.workflows.assistant`
 * (`examples/workflow-chain-packs/assistant/pack.json`) and are registered
 * chain-backed under their ORIGINAL workflowIds, so the per-tenant scheduler job
 * rows, the `EXEC_WORKFLOW_BY_KIND` dispatch and every existing run stamp keep
 * resolving. Both modules now contain no `registerWorkflow` call of any kind, so
 * the scanner no longer produces a site for them — which is what makes removing
 * them from this map correct rather than a concealment; the "ledger entries are
 * not stale" case below would fail on a stale entry, and the exact-equality case
 * would fail if either were still detected.
 */
const PIN_SITE_QUARANTINE = new Map<string, string>([
  ['features/kicktodo-core/conveneTurnWorkflow.ts', 'Boot path: a module `const DEF` (the convene-turn workflow), same shape as the channels one.'],
  ['routes/artifactTypeSeam.ts', 'FOUND BY THIS WIDENING. The RFC 0142 leg-B conformance witness registers an in-tree literal per artifact type on a request path. Test-seam surface rather than product surface, but it is a real unowned `wfreg:` row and is recorded rather than excused.'],
  // WFAWF-6 (ADR 0596 R2) — `host/workflowAuthorSeed.ts` DRAINED: the showcase
  // seeder now pairs `registerWorkflow` with `recordOwnership` per tenant (the
  // owned-in-tree-def lane `demoWalkthroughsSeed.ts` uses), so its registration is
  // no longer an unowned literal. It moved to SANCTIONED_ORIGINS.
]);

/** NO-GROWTH. Draining an entry lowers this; raising it is the smell the gate forbids.
 *  WF-COS-1: 7 -> 5. Two entries drained (`features/assistant/loops.ts`,
 *  `features/assistant/actionExecution.ts`), zero added.
 *  WFAWF-6 (ADR 0596 R2): 5 -> 4. One entry drained (`host/workflowAuthorSeed.ts`
 *  now pairs registration with `recordOwnership` and moved to SANCTIONED_ORIGINS),
 *  zero added.
 *  ADR 0701: 4 -> 3. One entry drained
 *  (`features/scheduled-agent-chats/scheduledChatTurnWorkflow.ts` now ships its graph
 *  as `core.openwop.workflows.scheduled-chat-turn` and registers CHAIN-BACKED under
 *  the same workflowId — the WF-COS-1 drain, applied to the third turn-workflow),
 *  zero added. The two remaining are `channels/channelTurnWorkflow.ts` and
 *  `kicktodo-core/conveneTurnWorkflow.ts`, the same shape and now with a third
 *  precedent for draining them.
 *  ADR 0703: 3 -> 2. One entry drained
 *  (`features/channels/channelTurnWorkflow.ts` — instance #3 of the same class, the
 *  same single agent-runner shape, now `core.openwop.workflows.channel-turn`
 *  registered chain-backed under the same workflowId), zero added. The ONE remaining
 *  product entry is `kicktodo-core/conveneTurnWorkflow.ts`; `routes/artifactTypeSeam.ts`
 *  is a test seam.
 *  The ratchet is exact-match in BOTH directions, so leaving a fixed
 *  site listed is red too — which is why the ceiling and the map move in the same
 *  commit. */
const PIN_SITE_CEILING = 2;

/**
 * RESIDUAL R1 — modules that accept an INJECTED registrar. The definitions they
 * register are attributed to whoever supplies the injection, which this single-file
 * scanner cannot follow. Exact-match: a new one is red until it states its supplier.
 */
const INDIRECT_REGISTRATION_SEAMS = new Map<string, string>([
  ['host/workflowChainPackLoader.ts', '`SubChainDeps.register: (def: WorkflowDefinition) => void` (RFC 0133 sub-chain co-registration). The ONLY supplier today is `routes/workflows.ts:830`, whose closure calls the real `registerWorkflow` and whose enclosing from-chain handler records ownership for every co-registered child — so the lane is sanctioned. It is ledgered because the scanner sees `deps.register(...)`, not `registerWorkflow(...)`: a second supplier that skipped ownership would be invisible here.'],
]);

/**
 * RESIDUAL R2 — modules that use a registrar as a VALUE rather than calling it.
 * Empty today, and it must stay that way: the scanner cannot resolve the origin of
 * a definition at a call it cannot see.
 */
const VALUE_REFERENCES = new Map<string, string>([]);

const { sites, valueRefs, injectedSeams } = scanRegistrationSites();
const pinned = [...sites.values()].filter((s) => s.inTreeLiteral).map((s) => s.file).sort();

describe('WF-KB-2 — registerWorkflow call sites are classified by definition ORIGIN', () => {
  it('the scan is NON-VACUOUS (a broken walker would pass everything)', () => {
    // If the walker or the call regex ever breaks, every assertion below is
    // hollow. Anchor on the real corpus size and on one site of EACH origin.
    expect(sites.size).toBeGreaterThanOrEqual(14);
    expect(sites.has('routes/workflows.ts'), 'the request-body lane').toBe(true);
    expect(sites.has('features/strategy/cadence.ts'), 'the expandChain lane').toBe(true);
    // ADR 0703 — this anchored on `features/channels/channelTurnWorkflow.ts` until that
    // file was DRAINED to a chain pack, at which point the anti-vacuity anchor pointed
    // at a site that no longer exists and this leg went red. Re-anchored on the one
    // remaining product pin site. NOTE FOR WHOEVER DRAINS IT: when
    // `conveneTurnWorkflow.ts` goes, the class is empty and this line cannot be
    // re-pointed — replace it with a FIXTURE the walker must detect, so the
    // non-vacuity property survives the success of the migration it polices.
    expect(sites.has('features/kicktodo-core/conveneTurnWorkflow.ts'), 'a module-const literal pin site').toBe(true);
    // `host/workflowAuthorSeed.ts` is the owned-seed lane (WFAWF-6 / ADR 0596 R2):
    // it iterates a module array and pairs `registerWorkflow(s.definition)` with
    // `recordOwnership`, so it is a SANCTIONED site (recordsOwnership), NOT a pin
    // and NOT tier-3 (the fallback requires no recordOwnership). Assert all three
    // facts so a regression that drops the ownership pairing — reopening the retired
    // anti-pattern — turns this red HERE, not only in the count. Draining this live
    // site is not vacuous: the tier-3 fallback ACTIVATION path is now witnessed by a
    // synthetic probe that composes through the real classifier (sabotage test, case
    // 6b), which goes red if the tier-3 branch is neutralized.
    expect(sites.has('host/workflowAuthorSeed.ts'), 'the owned-seed lane is scanned').toBe(true);
    expect(sites.get('host/workflowAuthorSeed.ts')!.recordsOwnership, 'owned-seed pairs registration with recordOwnership').toBe(true);
    expect(sites.get('host/workflowAuthorSeed.ts')!.inTreeLiteral, 'owned-seed is not a pin').toBe(false);
    // …and the drained pair must NOT come back. Asserted by name because "the
    // count went down" is satisfiable by draining a different site.
    expect(sites.has('features/assistant/loops.ts'), 'WF-COS-1 — drained, must not regress').toBe(false);
    expect(sites.has('features/assistant/actionExecution.ts'), 'WF-COS-1 — drained, must not regress').toBe(false);
    // …and the ALIAS lane really is resolved on live code, not just in a probe:
    // `routes/workflows.ts` imports `registerWorkflow as reRegisterWorkflow` and
    // calls it at the promote lane. Before R2 that call was in NO site's call list.
    expect(sites.get('routes/workflows.ts')!.aliases).toContain('reRegisterWorkflow');
    expect(
      sites.get('routes/workflows.ts')!.calls.some((c) => c.name === 'reRegisterWorkflow'),
      'the aliased registration must appear as a call site',
    ).toBe(true);
  });

  it('the ORIGIN resolver actually discriminates (sabotage probe, one assertion each)', () => {
    // 1. an inline literal — the shape the `: WorkflowDefinition` scan could never see
    expect(resolvesToInTreeLiteral('', "{ workflowId: 'x', nodes: [], edges: [] }")).toBe(true);
    // 2. a module const holding a literal
    const constSrc = "const DEF: WorkflowDefinition = { workflowId: 'x', nodes: [], edges: [] };\nregisterWorkflow(DEF);";
    expect(resolvesToInTreeLiteral(constSrc, 'DEF')).toBe(true);
    // 3. a module-local factory that RETURNS a literal
    const factorySrc = "function mk(l: L): WorkflowDefinition {\n  return { workflowId: l.id, nodes: [], edges: [] };\n}\n";
    expect(resolvesToInTreeLiteral(factorySrc, 'mk(loop)')).toBe(true);
    // 4. the sanctioned chain product is NOT a literal
    const chainSrc = 'const expanded = expandChain(found.chain, {});';
    expect(resolvesToInTreeLiteral(chainSrc, 'expanded')).toBe(false);
    // 5. an unresolved (request-body) definition is NOT a literal
    expect(resolvesToInTreeLiteral('', 'defToPersist')).toBe(false);
    // 6. TIER 3 — the member-of-a-loop-variable case the resolver cannot follow,
    //    caught at module level instead. Both halves asserted: the resolver misses
    //    it (so the fallback is doing real work, not shadowing tier 1/2) and the
    //    fallback predicate sees it.
    const seedSrc = "const SHOWCASE = [{ definition: { workflowId: 'x', nodes: [{ nodeId: 'a' }], edges: [] } }];\n"
      + 'for (const s of SHOWCASE) registerWorkflow(s.definition);';
    expect(resolvesToInTreeLiteral(seedSrc, 's.definition')).toBe(false);
    expect(declaresDefinitionLiteral(seedSrc)).toBe(true);
    // …and it does NOT fire on a module with no definition literal at all.
    expect(declaresDefinitionLiteral('const def = expandChain(c, {}); registerWorkflow(def);')).toBe(false);
    // 6b. TIER 3 ACTIVATION — compose the predicates through the REAL classifier,
    //     not just in isolation. WFAWF-6 drained this repo's only LIVE tier-3 site
    //     (`host/workflowAuthorSeed.ts`, now owned), so without this the fallback's
    //     activation path would be witnessed by nothing: neutralizing the tier-3
    //     branch in `classifyRegistrationSource` would leave the whole suite green.
    //     This turns that regression RED.
    const t3unowned = classifyRegistrationSource(seedSrc);
    expect(t3unowned.tier3, 'an unowned module-array pin ACTIVATES the tier-3 fallback').toBe(true);
    expect(t3unowned.inTreeLiteral, '…and is therefore pinned').toBe(true);
    // …and the WFAWF-6 drain mechanism: pairing `recordOwnership` removes it from tier-3.
    const t3owned = classifyRegistrationSource(seedSrc + '\nawait recordOwnership(t, id, {});');
    expect(t3owned.tier3, 'pairing recordOwnership drains the tier-3 pin (the WFAWF-6 mechanism)').toBe(false);
    expect(t3owned.inTreeLiteral, '…so it is no longer pinned').toBe(false);
    // 7. COMMENTS ARE NOT CODE. A docblock quoting the retired call must not keep
    //    a fixed module reading as a pin site (this exact trap fired once here).
    const commented = "/** was: registerWorkflow({ workflowId: 'x' }) */\nregisterChainBackedWorkflow('x');";
    const anyCall = /\bregisterWorkflow(?:Durable)?\s*\(/g;
    expect([...stripComments(commented).matchAll(anyCall)]).toHaveLength(0);
    expect([...commented.matchAll(anyCall)], 'un-stripped, the comment DOES match').toHaveLength(1);
  });

  // ── F5 defect #2: a SPREAD of a derived product is not an in-tree literal ──
  it('a spread of an expandChain product is DERIVED, not an in-tree literal', () => {
    // This is the exact shape of all three live false positives measured on this
    // branch (cadence / gmailSync / collab). Sabotage direction asserted too: the
    // OLD rule was `a.startsWith('{') ⇒ true`, which this first assertion falsifies.
    const cadence = "const expanded = expandChain(found.chain, {});\n"
      + 'registerWorkflow({ ...expanded, workflowId, metadata: { ...expanded.metadata, name } });';
    expect(resolvesToInTreeLiteral(cadence, '{ ...expanded, workflowId, metadata: { ...expanded.metadata, name } }'))
      .toBe(false);
    // an UNRESOLVABLE spread source is DERIVED as well (the collab `let candidate;` shape)
    expect(resolvesToInTreeLiteral('let candidate: WorkflowDefinition;', '{ ...candidate, metadata: m }')).toBe(false);
    // …but layering on a spread must NOT become a laundering trick: a literal that
    // writes the definition BODY itself is in-tree whatever it spreads (residual R4).
    expect(resolvesToInTreeLiteral(
      'const expanded = expandChain(c, {});',
      "{ ...expanded, workflowId: 'feature.laundered.pin', nodes: [{ nodeId: 'a' }], edges: [] }",
    )).toBe(true);
    // …and spreading an in-tree const is still in-tree.
    expect(resolvesToInTreeLiteral(
      "const BASE = { workflowId: 'x', nodes: [], edges: [] };",
      '{ ...BASE, workflowId: y }',
    )).toBe(true);
  });

  // ── F5 defect #3a: the arrow factory, this repo's house style ──
  it('an ARROW-function factory is resolved (it was completely invisible before)', () => {
    const concise = "const mk = (l: L): WorkflowDefinition => ({ workflowId: l.id, nodes: [], edges: [] });";
    expect(resolvesToInTreeLiteral(concise, 'mk(loop)')).toBe(true);
    const block = 'const mk2 = (l) => {\n  const x = 1;\n  return { workflowId: l.id, nodes: [], edges: [] };\n};';
    expect(resolvesToInTreeLiteral(block, 'mk2(loop)')).toBe(true);
    // NON-VACUITY: an arrow factory that does NOT build a definition stays derived.
    expect(resolvesToInTreeLiteral('const mk3 = (l) => ({ nope: 1 });', 'mk3(l)')).toBe(false);
    // …and the OLD lookup, `function <name>` only, genuinely could not see it.
    expect(/\bfunction\s+mk\s*[(<]/.test(concise), 'the shape the old resolver required').toBe(false);
  });

  // ── F5 defect #1: ownership must pair at the SITE, not anywhere in the file ──
  it('a fresh literal registration in a SANCTIONED module is NOT laundered by the file flag', () => {
    // The laundering path: add a genuine boot-path pin to any module that already
    // records ownership somewhere else. File-wide, this was green.
    const launder = [
      'export function bootFeature(): void {',
      "  registerWorkflow({ workflowId: 'feature.crm.new-pin', nodes: [{ nodeId: 'a' }], edges: [] });",
      '}',
      'export async function instantiate(tenantId: string): Promise<void> {',
      '  const expanded = expandChain(found.chain, {});',
      '  const def = { ...expanded, workflowId };',
      '  registerWorkflow(def);',
      "  await recordOwnership(tenantId, workflowId, { name: 'x', nodeCount: 1 });",
      '}',
    ].join('\n');
    const calls = [...launder.matchAll(/\bregisterWorkflow\s*\(/g)];
    expect(calls).toHaveLength(2);

    const pin = calls[0]!.index! + calls[0]![0].length - 1;
    const legit = calls[1]!.index! + calls[1]![0].length - 1;

    // The OLD, file-wide flag cannot tell these apart — assert that directly, so
    // this test would have been GREEN before the fix and is meaningful now.
    expect(/\brecordOwnership\s*\(/.test(launder), 'file-wide: indistinguishable').toBe(true);

    // Site-scoped, they are opposites.
    expect(resolvesToInTreeLiteral(launder, argumentAt(launder, pin), pin)).toBe(true);
    expect(/\brecordOwnership\s*\(/.test(enclosingFunctionRegion(launder, pin)), 'the pin is NOT paired').toBe(false);
    expect(resolvesToInTreeLiteral(launder, argumentAt(launder, legit), legit)).toBe(false);
    expect(/\brecordOwnership\s*\(/.test(enclosingFunctionRegion(launder, legit)), 'the real lane IS paired').toBe(true);
  });

  it('enclosingFunctionRegion stops at the FUNCTION, not the first block or the module', () => {
    // A route file wraps every handler in one `registerXRoutes(app)` function; if the
    // region walked out to that, site-scoping would be file-scoping with extra steps.
    const routes = [
      'export function registerRoutes(app) {',
      "  app.post('/a', async (req, res) => {",
      '    if (x) {',
      '      registerWorkflow(DEF);',
      '    }',
      '  });',
      "  app.post('/b', async (req, res) => {",
      '    await recordOwnership(t, id, {});',
      '  });',
      '}',
    ].join('\n');
    const at = routes.indexOf('registerWorkflow(');
    const region = enclosingFunctionRegion(routes, at);
    expect(region).toContain("registerWorkflow(DEF)");
    expect(region, 'the sibling handler is a DIFFERENT function').not.toContain('recordOwnership');
    // The `if (x) {` block is skipped (a control block is not a function body) —
    // otherwise a `registerWorkflow` + `recordOwnership` pair straddling an `if`
    // would read as unpaired.
    expect(region.startsWith('{\n    if (x)'), 'walked out past the if-block').toBe(true);
  });

  it('argumentAt does not count brackets inside string literals', () => {
    const src = "registerWorkflow({ workflowId: 'a) b', nodes: [] });";
    const open = src.indexOf('(');
    expect(argumentAt(src, open)).toBe("{ workflowId: 'a) b', nodes: [] }");
    // Sabotage: the OLD, string-blind walker truncated at the `)` inside the string.
    expect(argumentAt(src, open).includes('nodes'), 'the argument is not truncated').toBe(true);
  });

  it('the declaration lookup takes the NEAREST PRECEDING const, not the first in the file', () => {
    const two = [
      'function derived() {',
      '  const def = expandChain(c, {});',
      '  registerWorkflow(def);',
      '}',
      'function pinned() {',
      "  const def = { workflowId: 'x', nodes: [{ nodeId: 'a' }], edges: [] };",
      '  registerWorkflow(def);',
      '}',
    ].join('\n');
    const calls = [...two.matchAll(/\bregisterWorkflow\s*\(/g)];
    const first = calls[0]!.index! + calls[0]![0].length - 1;
    const second = calls[1]!.index! + calls[1]![0].length - 1;
    expect(resolvesToInTreeLiteral(two, 'def', first)).toBe(false);
    expect(resolvesToInTreeLiteral(two, 'def', second), 'the SECOND const is the one in scope').toBe(true);
  });

  it('a FRESH boot-path literal is detected (the guard the old ratchet could not give)', () => {
    // The exact shape that shipped past the ADR 0472 ratchet for months: a feature
    // module calling registerWorkflow with an inline object literal, no ownership.
    const fresh = [
      "import { registerWorkflow } from '../../host/workflowsRegistry.js';",
      'export const someFeature = {',
      '  registerRoutes: () => {',
      "    registerWorkflow({ workflowId: 'feature.brand-new.pin', nodes: [{ nodeId: 'a', typeId: 't' }], edges: [] });",
      '  },',
      '};',
    ].join('\n');
    const m = [...fresh.matchAll(/\bregisterWorkflow\s*\(/g)];
    expect(m).toHaveLength(1);
    const open = m[0]!.index! + m[0]![0].length - 1;
    expect(resolvesToInTreeLiteral(fresh, argumentAt(fresh, open), open)).toBe(true);
    expect(/\brecordOwnership\s*\(/.test(enclosingFunctionRegion(fresh, open))).toBe(false);
    // ⇒ pinned, and NOT in the quarantine ⇒ the exact-match assertion below goes red.
    expect(PIN_SITE_QUARANTINE.has('features/brand-new/feature.ts')).toBe(false);
  });

  it('every registration site is CLASSIFIED (sanctioned origin or quarantined pin site)', () => {
    const unclassified = [...sites.keys()]
      .filter((f) => !SANCTIONED_ORIGINS.has(f) && !PIN_SITE_QUARANTINE.has(f))
      .sort();
    expect(
      unclassified,
      'These modules call registerWorkflow/registerWorkflowDurable and are classified by nobody. '
      + 'Either the definition comes from a request body / expandChain / the composition pipeline and is '
      + 'paired with recordOwnership (add it to SANCTIONED_ORIGINS with the origin stated), or it is an '
      + 'in-tree literal — in which case ship a chain pack and use registerChainBackedWorkflow(chainId). '
      + 'Do NOT add a new entry to PIN_SITE_QUARANTINE; it is shrink-only.',
    ).toEqual([]);
  });

  it('the quarantine EXACTLY equals the detected pin sites (no new pins, no stale claims)', () => {
    expect(pinned, 'detected in-tree-literal registrations with no recordOwnership').toEqual(
      [...PIN_SITE_QUARANTINE.keys()].sort(),
    );
  });

  it('a SANCTIONED module really does record ownership — at the registration SITE', () => {
    const lying = [...SANCTIONED_ORIGINS.keys()].filter((f) => sites.get(f)?.recordsOwnership === false).sort();
    expect(
      lying,
      'Classified as the sanctioned runtime lane but the module never calls recordOwnership — '
      + 'an unowned definition is invisible in /builder + the `/` picker and survives tenant teardown.',
    ).toEqual([]);
    // And the pairing is exercised on REAL code, not only in the probes above: every
    // sanctioned module has at least one registration whose own enclosing function
    // records ownership. (Not "every call": the archive/unarchive lifecycle flips
    // re-register an ALREADY-owned id, and demanding a second ownership write there
    // would be a false red.)
    const unpaired = [...SANCTIONED_ORIGINS.keys()]
      .filter((f) => !(sites.get(f)?.calls ?? []).some((c) => c.pairedWithOwnership)).sort();
    expect(unpaired, 'no registration in this sanctioned module pairs with recordOwnership in its own function').toEqual([]);
  });

  it('the quarantine is SHRINK-ONLY, and the ceiling is EXACT', () => {
    // ADR 0701 — this was `toBeLessThanOrEqual`, i.e. the ceiling was an upper BOUND
    // and nothing stopped it being RAISED. MEASURED while draining the scheduled-chat
    // entry: setting the ceiling back to 4 with only 3 entries left this suite GREEN,
    // so the one number the gate exists to hold could be moved without adding a site.
    // The docblock above already claims "exact-match in BOTH directions … which is why
    // the ceiling and the map move in the same commit" — that was true of the MAP and
    // not of the ceiling. Exact equality makes the claim true: draining without
    // lowering is red, and raising without draining is red.
    expect(
      PIN_SITE_QUARANTINE.size,
      `Pin sites may only be DRAINED, and the ceiling must MATCH the map (ceiling ${PIN_SITE_CEILING}). `
        + 'Ship a chain pack instead of adding one; when you drain, lower the ceiling in the same commit.',
    ).toBe(PIN_SITE_CEILING);
  });

  it('no module is classified twice (a double entry hides which claim is live)', () => {
    expect([...PIN_SITE_QUARANTINE.keys()].filter((f) => SANCTIONED_ORIGINS.has(f))).toEqual([]);
  });

  it('ledger entries are not stale — every classified module still registers a workflow', () => {
    const stale = [...SANCTIONED_ORIGINS.keys(), ...PIN_SITE_QUARANTINE.keys()].filter((f) => !sites.has(f)).sort();
    expect(stale, 'Classified module no longer calls registerWorkflow — remove the entry so the ledger stays honest.').toEqual([]);
  });

  // ── residual R2: a registrar used as a VALUE is detected, not silently missed ──
  it('no registrar is used POINT-FREE / as a value (residual R2 ledger, exact match)', () => {
    expect(
      valueRefs,
      'A registrar passed as a value (`defs.forEach(registerWorkflow)`, re-exported, stored on an object) '
      + 'is a registration this scanner cannot attribute to an origin. Call it directly, or record it in '
      + 'VALUE_REFERENCES with what supplies the definitions.',
    ).toEqual([...VALUE_REFERENCES.keys()].sort());
  });

  it('the point-free detector is NON-VACUOUS (it sees the shape, and ignores imports)', () => {
    // `valueReferenceNames` is the SAME predicate the scan runs — a probe against a
    // private copy would prove nothing about the ledger above.
    const pointFree = "import { registerWorkflow } from '../host/workflowsRegistry.js';\ndefs.forEach(registerWorkflow);";
    expect(valueReferenceNames(stripComments(pointFree)), 'the forEach pass is seen').toEqual(['registerWorkflow']);
    // …an ALIASED point-free pass is seen too (the alias is resolved first).
    const aliased = "import { registerWorkflow as reg } from '../host/workflowsRegistry.js';\ndefs.forEach(reg);";
    expect(valueReferenceNames(stripComments(aliased))).toEqual(['reg']);
    // …and the import specifier ALONE is not a false positive (every site file has one).
    const importOnly = "import { registerWorkflow } from '../host/workflowsRegistry.js';\nregisterWorkflow(DEF);";
    expect(valueReferenceNames(stripComments(importOnly))).toEqual([]);
    // …nor is the dynamic-import destructure `routes/artifactTypeSeam.ts` really uses.
    const dyn = "const { registerWorkflow } = await import('../host/workflowsRegistry.js');\nregisterWorkflow(DEF);";
    expect(valueReferenceNames(stripComments(dyn))).toEqual([]);
    // …nor an aliased import that IS called (that is a call site, not a value use —
    // and `routes/workflows.ts` is the live instance of exactly this).
    const aliasCalled = "import { registerWorkflow as reg } from '../host/workflowsRegistry.js';\nreg(DEF);";
    expect(valueReferenceNames(stripComments(aliasCalled))).toEqual([]);
  });

  // ── residual R1: injected registrars are named, not invisible ──
  it('every INDIRECT registration seam is acknowledged (residual R1 ledger, exact match)', () => {
    expect(
      injectedSeams,
      'A module accepts an injected `register: (def: WorkflowDefinition) => …`. The definitions it registers '
      + 'are attributed to whoever supplies the injection, which this scanner cannot follow. Record it in '
      + 'INDIRECT_REGISTRATION_SEAMS naming every supplier and whether they record ownership.',
    ).toEqual([...INDIRECT_REGISTRATION_SEAMS.keys()].sort());
  });

  it('the injected-registrar detector is NON-VACUOUS', () => {
    expect(INJECTED_REGISTRAR_RE.test('export interface D { register: (def: WorkflowDefinition) => void; }')).toBe(true);
    expect(INJECTED_REGISTRAR_RE.test('registerChild?: (d: WorkflowDefinition) => Promise<void>;')).toBe(true);
    // It does NOT fire on the unrelated `postProcess` mutators that take the same
    // type (`host/chainBackedWorkflows.ts`, `features/creative-briefs/reelWorkflow.ts`) —
    // measured: an unnamed `(def: WorkflowDefinition) => void` test would have
    // ledgered two modules that register nothing.
    expect(INJECTED_REGISTRAR_RE.test('postProcess?: (def: WorkflowDefinition) => void;')).toBe(false);
  });

  it('WF-KB-1: agent-knowledge no longer pins a definition at all', () => {
    // The one this change drove to zero. Asserted by NAME (not just by the
    // exact-match above) so a re-introduction reads as the regression it is.
    expect(sites.has('features/agent-knowledge/feature.ts')).toBe(false);
    expect(PIN_SITE_QUARANTINE.has('features/agent-knowledge/feature.ts')).toBe(false);
  });
});
