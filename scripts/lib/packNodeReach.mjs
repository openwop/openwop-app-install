/**
 * ADR 0572 P3 — "what does this pack node actually reach?", derived from code.
 *
 * Shared by BOTH generators (`gen-side-effect-floor.mjs` emits the served set,
 * `gen-served-set.mjs` reports the ratchet against it). They MUST agree: two
 * copies of this analysis drifting apart would let the ratchet report a shrink
 * the executor never made, or hide one it did.
 *
 * WHY THIS FILE EXISTS AT ALL. `replay.md` requirement 4 makes a manifest
 * `role: "side-effect"` binding, and requirement 2 says the host resolves such a
 * node's outcome from the SOURCE run's record. The ADR 0341 fast path does
 * exactly that — but it must NOT swallow the nodes whose discharge is the ADR
 * 0326 invocation log, because those run live and the log serves the provider
 * call underneath them (that is what preserves RFC 0041 §B divergence
 * detection). So the whole question is: which floor nodes reach an AI provider?
 *
 * THE DIRECTION THIS FAILS IN IS THE DESIGN. A node this file cannot read, or
 * can read but sees touching ANY opaque host AI capability, is reported as
 * NOT eligible for the fast path. It then stays UNDISCHARGED — safe at runtime
 * (it reaches an ADR 0531 seam and throws) and visible in the ratchet. The
 * opposite default — "the parser saw no AI, so fast-path it" — would silently
 * retire divergence detection for whatever the parser missed, and P2's own
 * history (unresolved 107 -> 62 -> 10 across three parser defects, ADR 0572
 * §"How the buckets are derived") says a fourth miss should be assumed, not
 * hoped against.
 */

import { readFileSync, readdirSync, existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * Capabilities whose reach means the node MUST NOT be fast-pathed, because it
 * may resolve through the INVOCATION-LOGGED path without this analysis being
 * able to see that it does. These are the §B protection set.
 *
 * The membership test is NOT "is it AI-ish". It is "does a SECOND discharge
 * exist that fast-pathing would destroy". Each entry is here for a reason read
 * out of `backend/typescript/src`, not from its name:
 *
 *   callAI            — THE invocation-logged path (`aiProvidersHost.ts`
 *                       :729-752 re-keys the lookup at
 *                       `replayInvocationsFromRunId`, i.e. the SOURCE run).
 *                       This is the one arm-2 membership actually means, and
 *                       fast-pathing it would retire RFC 0041 §B divergence
 *                       injection for the whole AI class.
 *   agentRuntime      — `core.agents.run` reaches AI through the HOST
 *                       (`host/agentRunnerNode.ts:181` passes
 *                       `callAI: ctx.callAI`), which NO pack-source parser can
 *                       see. It is the live counterexample to trusting this
 *                       analysis in the permissive direction, and the reason
 *                       this list exists at all rather than just the regex.
 *   aiEnvelope,
 *   promptLibrary     — `vendor.myndhyve.*`'s AI surface. Not bound as a
 *                       node-context capability in this host today, but
 *                       "currently inert" is not a replay guarantee, and if it
 *                       is ever bound it will route through `callAI`.
 *   guardrails        — `ctx.guardrails.evaluate`, host-implemented and unread
 *                       from here; same unknown-routing argument.
 *   subWorkflow       — a child run has its own classified nodes, including
 *                       invocation-log-served ones. Fast-pathing the PARENT
 *                       means the child never runs and its §B goes with it.
 *   ctx.ai., tryAiJson — the in-tree AI helper spellings P2 already knew.
 *
 * NOTE what is deliberately NOT here: the media providers and
 * `callAIWithTools`. See `NOT_INVOCATION_LOGGED_AI` below — they are AI-ish and
 * they are fast-path ELIGIBLE, and conflating "AI-ish" with "hold back" was a
 * real defect in the first cut of this file.
 */
export const OPAQUE_HOST_AI_CAPABILITIES = Object.freeze([
  'callAI',
  'aiEnvelope',
  'promptLibrary',
  'agentRuntime',
  'guardrails',
  'subWorkflow',
  'ctx.ai.',
  'tryAiJson',
]);

/**
 * AI-ish capabilities that are NOT invocation-logged, and are therefore
 * FAST-PATH ELIGIBLE rather than held back.
 *
 * CORRECTED 2026-08-17, mid-Phase-3, and the correction matters more than the
 * list. These were originally held back on a "might route to AI, so refuse to
 * decide" hedge. That hedge is wrong here, and reading `aiProvidersHost.ts`
 * shows why: holding a typeId back only makes sense when a SECOND discharge
 * exists to catch it. For `ctx.callAI` one does — the ADR 0326 invocation log,
 * which is why fast-pathing that class would destroy RFC 0041 §B. For these
 * there is NONE: `callImageGenerator` dispatches after a metered budget check,
 * `callAIWithTools` goes straight to `toolsRoundDispatcher`, and neither reads
 * or writes the log. So holding them back does not protect anything — it just
 * leaves a replay THROWING at the ADR 0531 backstop where `replay.md`
 * requirement 2 says it must reproduce, which is the spec's "safe and
 * non-conformant" posture exactly.
 *
 * Serving them is both the conformant answer and the one that stops a replay
 * re-firing a PAID media generation.
 *
 * If `callAIWithTools` is ever brought under the invocation log, move it to
 * the list above — at that point it acquires a second discharge and
 * fast-pathing it would start costing divergence detection.
 */
export const NOT_INVOCATION_LOGGED_AI = Object.freeze([
  'callAIWithTools',
  'callImageGenerator',
  'callImageEditor',
  'callImageUpscaler',
  'callVideoGenerator',
  'callSpeechSynthesizer',
  'callTranscriber',
  'callSpeechToText',
  'callTextToSpeech',
  'callReranker',
]);

/** `callAI` is a PREFIX of `callAIWithTools`; only the exact name is arm 2. */
const INVOCATION_LOGGED = /callAI(?![A-Za-z0-9_$])/;

/**
 * Does `text` reach capability `cap`? Boundary-aware, and that is not a detail:
 * a plain `includes` re-introduces the very prefix bug this phase was written to
 * fix, one layer down. It did — `'callAI'` matched `callAIWithTools` in the
 * opaque filter and parked `core.ai.toolCalling` as undischarged. Conservative
 * rather than dangerous that time, which is exactly how a prefix bug survives.
 */
function reaches(text, cap) {
  if (!/^[A-Za-z_$][\w$]*$/.test(cap)) return text.includes(cap); // 'ctx.ai.' etc
  return new RegExp(`${cap}(?![A-Za-z0-9_$])`).test(text);
}

/**
 * typeId -> { pack, src, fn }. Three mapping shapes, all present in-tree;
 * missing any one of them reads as "unmapped node" (P2's finding, kept).
 */
export function buildImplIndex(root) {
  const impl = new Map();
  const packs = join(root, 'packs');
  if (!existsSync(packs)) throw new Error(`no packs dir at ${packs}`);
  for (const dir of readdirSync(packs).sort()) {
    const index = join(packs, dir, 'index.mjs');
    if (!existsSync(index)) continue;
    const src = readFileSync(index, 'utf8');
    // ADR 1048 — `file` + `packDir` let the reach walk follow a node function
    // that index.mjs only IMPORTS (or re-exports) from a sibling module.
    const at = { pack: dir, src, file: index, packDir: join(packs, dir) };
    for (const m of src.matchAll(/['"]([\w.-]+)['"]\s*:\s*([A-Za-z_$][\w$]*)\s*[,}]/g)) impl.set(m[1], { ...at, fn: m[2] });
    for (const m of src.matchAll(/nodes\[\s*['"]([\w.-]+)['"]\s*\]\s*=\s*([A-Za-z_$][\w$]*)/g)) impl.set(m[1], { ...at, fn: m[2] });
    // `'core.db.nosql-find': delegate('nosql', 'find'),` — an inline factory
    // CALL, not an identifier. Omitting this shape left ~59 nodes "unmapped".
    for (const m of src.matchAll(/['"]([\w.-]+)['"]\s*:\s*([A-Za-z_$][\w$]*)\s*\(/g)) if (!impl.has(m[1])) impl.set(m[1], { ...at, fn: m[2] });
  }
  if (impl.size === 0) throw new Error('the impl index is EMPTY — every node would read as unresolvable');
  return impl;
}

/** Brace-match one declaration, following ONE factory indirection.
 *  `export const themeAnalyze = makeAiGenerator(…)` has no body of its own. */
export function bodyOf(src, name, depth = 2) {
  if (depth <= 0) return null;
  const factory = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*([A-Za-z_$][\\w$]*)\\s*\\(([^)]*)\\)`).exec(src);
  if (factory && factory[1] !== 'async') {
    const viaFactory = bodyOf(src, factory[1], depth - 1);
    // CORRECTED 2026-08-17 — carry the CALL-SITE ARGUMENTS, not just the
    // factory body. This was a blind spot that produced a right answer for the
    // wrong reason, which is worse than a wrong one because nothing looks off:
    //
    //   function delegateProvider(method) { const fn = ctx[method] ?? …; }
    //   export const imageGenerate = delegateProvider('callImageGenerator');
    //
    // The capability name is a STRING ARGUMENT and never appears in the
    // resolved body, so six `core.openwop.ai.*` media nodes scanned as
    // "touches no AI capability at all". They were served, which happens to be
    // the correct outcome — but by blindness, and the SAME blindness would hide
    // a `callAI` reach behind the same shape and fast-path a node that must
    // stay live. Appending the args closes it in the direction that matters.
    if (viaFactory) return `${viaFactory}\n/*factory-args*/ ${factory[2] ?? ''}`;
  }
  const decl = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*\\{`).exec(src)
    ?? new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  if (!decl) {
    // P3 — the EXPRESSION-BODIED arrow, which has no `{` to brace-match:
    //   export const metricCounter = (ctx) => recordMetric(ctx, 'counter');
    //   const decl = (kind) => (ctx) => ({ … });          // curried
    // P2 reported both shapes as `unresolved`, which is why `core.obs.metric-*`
    // and `core.agents.memory-*` sat in the residue list. Return the expression
    // text: the caller walks the identifiers it calls, so `recordMetric`'s own
    // body is still read and an AI reach inside it is still found. Resolving
    // these makes them ELIGIBLE, never automatically served — eligibility stays
    // positive (readable AND no AI reach), so a mistake here still lands on
    // "held back", not on "silently fast-pathed".
    const expr = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*(?!\\{)`).exec(src);
    if (!expr) return null;
    const from = expr.index + expr[0].length;
    // To the end of the statement. Deliberately coarse — this text is scanned
    // for identifiers, never parsed, so over-reading a line costs nothing and
    // under-reading would hide a call.
    const end = src.indexOf(';', from);
    return src.slice(from, end < 0 ? Math.min(src.length, from + 400) : end);
  }
  const open = src.indexOf('{', decl.index + (decl[0].endsWith('{') ? decl[0].length - 1 : 0));
  if (open < 0) return null;
  let depthCount = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depthCount++;
    else if (src[i] === '}' && --depthCount === 0) return src.slice(open, i + 1);
  }
  return null;
}

/**
 * ADR 1048 — where does `name` come from, when `src` (the module at `file`)
 * only IMPORTS it? Follows `import { a as b } from './x.mjs'` and
 * `export { a as b } from './x.mjs'` to the sibling module that declares it.
 *
 * Book AI's pack is the measured case: `index.mjs` does
 * `import { ask } from './ask.mjs'; export { ask } from './ask.mjs';`, so the
 * single-file read found no body for `ask` and reported all 16 of its
 * side-effect nodes `unresolved` ("fn ask not resolvable").
 *
 * BOUNDED IN THE SAFE DIRECTION. Only a RELATIVE specifier (`./`, `../`) is
 * followed, and only to a file that resolves (symlinks included) INSIDE
 * `packDir`. A bare specifier (`node:fs`, `some-lib`), an escaping path, a
 * namespace or default import, or a missing file returns null — the node stays
 * `unresolved` and therefore held, never silently "no AI reach".
 */
const NAMED_IMPORT = /\b(import|export)\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;

export function resolveImportedBinding(file, src, name, packDir) {
  if (!file || !packDir) return null;
  for (const m of src.matchAll(NAMED_IMPORT)) {
    for (const spec of m[2].split(',')) {
      const parts = spec.trim().split(/\s+as\s+/);
      const imported = parts[0]?.trim();
      const local = (parts[1] ?? parts[0])?.trim();
      if (!imported || local !== name) continue;
      const from = m[3];
      if (!from.startsWith('./') && !from.startsWith('../')) return null; // bare specifier: never followed
      const target = resolve(dirname(file), from);
      let real;
      let realRoot;
      try {
        if (!statSync(target).isFile()) return null;
        real = realpathSync(target);
        realRoot = realpathSync(packDir);
      } catch {
        return null;
      }
      const rel = relative(realRoot, real);
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null; // escapes the pack dir
      return { file: real, src: readFileSync(real, 'utf8'), name: imported };
    }
  }
  return null;
}

/**
 * The TRANSITIVE body text reachable from `name` inside one pack source.
 *
 * P2 read ONE body. A node whose export is a two-line wrapper around a local
 * `runPrompt(ctx, …)` helper therefore read as "no AI" — under-detection in
 * the arm where under-detection is dangerous. Measured on this tree: the
 * transitive walk moves `core.rag.{retriever-basic,vector-query,vector-upsert}`
 * into arm 2, which the single-body read missed.
 *
 * ADR 1048 — with `at = { file, packDir }` the walk also crosses into sibling
 * modules through relative named imports (`resolveImportedBinding`), for the
 * root AND for every helper it calls. Without `at` it is the single-file read
 * it always was.
 */
export function reachableText(src, rootFn, maxDepth = 5, at = null) {
  const locate = (name, fromSrc, fromFile) => {
    let curSrc = fromSrc;
    let curFile = fromFile;
    let curName = name;
    // A re-export chain (`index → a → b`) is followed a few hops, no further.
    for (let hop = 0; hop < 4; hop++) {
      const body = bodyOf(curSrc, curName);
      if (body !== null) return { body, src: curSrc, file: curFile };
      const next = at ? resolveImportedBinding(curFile, curSrc, curName, at.packDir) : null;
      if (!next) return null;
      ({ src: curSrc, file: curFile, name: curName } = next);
    }
    return null;
  };
  if (locate(rootFn, src, at?.file ?? null) === null) return { text: '', resolvable: false };
  const seen = new Set();
  let text = '';
  const walk = (name, fromSrc, fromFile, depth) => {
    if (depth > maxDepth) return;
    const key = `${fromFile ?? ''}#${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    const hit = locate(name, fromSrc, fromFile);
    if (hit === null) return;
    text += hit.body;
    for (const call of hit.body.matchAll(/\b([A-Za-z_$][\w$]{2,})\s*\(/g)) walk(call[1], hit.src, hit.file, depth + 1);
  };
  walk(rootFn, src, at?.file ?? null, 0);
  return { text, resolvable: true };
}

/**
 * Classify one typeId's replay discharge from its implementation.
 *
 *   { kind: 'unresolved',    why }  — cannot be read; a HUMAN must classify it.
 *   { kind: 'invocation-log' }      — reaches `ctx.callAI`; arm 2 serves the
 *                                     provider call from the SOURCE run, and
 *                                     the node MUST keep re-executing live.
 *   { kind: 'ai-opaque', caps }     — reaches a host capability that MAY route
 *                                     to the invocation-logged path without
 *                                     this analysis being able to see it
 *                                     (`agentRuntime` is the proven case).
 *                                     Held back: fast-pathing it could cost §B.
 *   { kind: 'no-ai-reach' }         — reaches no AI surface, or only surfaces
 *                                     that are NOT invocation-logged. Either
 *                                     way the ADR 0341 fast path is the only
 *                                     discharge available, and requirement 2
 *                                     says to use it.
 */
export function classifyNodeReach(typeId, impl) {
  const info = impl.get(typeId);
  if (!info) return { kind: 'unresolved', why: 'no index.mjs mapping' };
  const { text, resolvable } = reachableText(info.src, info.fn, 5, info.file ? { file: info.file, packDir: info.packDir } : null);
  if (!resolvable) return { kind: 'unresolved', why: `fn ${info.fn} not resolvable` };
  if (INVOCATION_LOGGED.test(text)) return { kind: 'invocation-log' };
  const caps = OPAQUE_HOST_AI_CAPABILITIES.filter((c) => reaches(text, c));
  if (caps.length > 0) return { kind: 'ai-opaque', caps };
  // NOT_INVOCATION_LOGGED_AI reaches deliberately fall through to the fast
  // path — see that list's header. Holding them back would protect nothing and
  // would leave the replay throwing where requirement 2 says it must reproduce.
  return { kind: 'no-ai-reach' };
}

/**
 * Roles whose fast-path semantics ADR 0572 records as UNRESOLVED, so they are
 * held back from the served set rather than guessed:
 *
 *   gate             — a gate suspends. What "serve the recorded outcome"
 *                      means for a node that did not reach a terminal outcome
 *                      in the source is the same question requirement 3
 *                      answers with `replay_source_missing`, and answering it
 *                      by fast-pathing every HITL gate changes suspend
 *                      semantics for the whole approvals surface.
 *   streaming-output — ADR 0572 §"The open question" names this one directly:
 *                      "working out what the fast path serves for a
 *                      `streaming-output` node". Serving only the terminal
 *                      outcome drops the stream frames the source emitted, so
 *                      the replay's event log is NOT byte-equivalent (§C.2) —
 *                      the fast path would trade one violation for another.
 *
 * Held back means UNDISCHARGED and counted, never exempt.
 */
export const DEFERRED_SEMANTICS_ROLES = Object.freeze(['gate', 'streaming-output']);
