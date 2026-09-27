#!/usr/bin/env node
/**
 * Silent-WRITE-failure RATCHET — the mirror of `check-failed-read-sentinels`.
 *
 * THE ASYMMETRY THIS EXISTS TO CLOSE. That gate counts READS that swallow a
 * rejection and hand the render an empty value. A whole programme of work went
 * into that class — and three silent WRITE swallows sat untouched through all of
 * it, because every review looked where the instrument pointed. A failed write
 * is the same lie told the other way round: the UI shows the edit as applied,
 * the server never took it, and the user finds out on the next load, if ever.
 *
 * WHAT IT COUNTS. A `.catch(...)` with an EMPTY or comment-only body, attached
 * to a call whose name reads as a write (`put*`, `post*`, `save*`, `create*`,
 * `update*`, `delete*`, `patch*`, `upsert*`, `persist*`, `revoke*`, `assign*`).
 *
 * WHAT "WRITE-SHAPED" MEANS, PRECISELY. It is a HEURISTIC OVER CALL NAMES, not
 * a proof. A write helper named something else is invisible to it, and a read
 * helper called `updateView()` would be a false positive. Said plainly because
 * the failure mode of a gate is to be trusted beyond its evidence — the read
 * gate's own header spends a page on exactly this, and it was right to.
 *
 * THE SHAPE IT CANNOT SEE, and it is the bigger one. This matches the CHAINED
 * form (`write().catch(…)`) only. The STATEMENT form —
 * `try { await write(); } catch {}` — walks straight past, and there are ~265
 * statement-form empty catches in the frontend awaiting triage. Sabotage-proven
 * by /grade-data: of four restored silencing syntaxes it caught three. So read
 * "baseline 3" as "three in the shape this gate can see", never as three in the
 * codebase. Extending the matcher to the statement form is the obvious next
 * step and is filed as WRITE-G-1.
 *
 * WHY NOT COUNT ALL EMPTY CATCHES. There are ~190 of them. Most are legitimate
 * (a best-effort probe, a cleanup, a cache warm). A gate that flags all of them
 * is noise, and noise is how a gate gets ignored — which is worse than not
 * having one.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readGateBaseline } from './gateBaseline.mjs';

const SRC = new URL('../src/', import.meta.url).pathname;

/** Lower this whenever a silent write is given a voice; never raise it. */
/**
 * 3, not 0 — and the difference is the point. The first cut said 0, but its
 * statement anchor was defeated by the two commonest write syntaxes (an
 * object-literal argument, and a `.then().catch()` chain — the exact shape this
 * branch's own fix writes, so it could not have caught a regression of itself).
 * With that fixed the gate sees three PRE-EXISTING sites:
 *
 *   walkthroughs/useWalkthroughPlayer.ts:206,461 — a failed `cancelRun` leaves
 *     the UI saying "stopped"/"idle" while the run may still be going. Genuine
 *     instances of this class.
 *   chat/tabDeck/TabChatDeck.tsx:396 — removing STALE EMPTY sessions in a
 *     cleanup loop; nothing user-visible is claimed either way. Defensible.
 *
 * They are NOT fixed here: they belong to features whose failure semantics I
 * have not verified, and a confident wrong fix is worse than a named gap. A
 * baseline of 0 that only holds because the gate is blind is the failure this
 * whole file exists to prevent — so the number is honest and shrink-only.
 */
const BASELINE = readGateBaseline('check-silent-write-failures', 'OPENWOP_SILENT_WRITE_BASELINE', 3);

const WRITE_CALL = /\b(put|post|save|create|update|delete|patch|upsert|persist|revoke|assign|cancel|remove|archive|publish|submit)[A-Za-z0-9_]*\s*\(/;
/** `.catch(() => {})` / `.catch(() => { /* … *\/ })` — an empty or comment-only body. */
const SILENT_CATCH = new RegExp(
  // KNOWN MISS, stated rather than hidden: `set*` is NOT in the verb list.
  // `setMessageFeedback(...)` is a genuine write, but `setProvider(...)` inside a
  // `.then()` body is a React state setter, and no name-based rule separates
  // them. Including `set` produced false positives on read paths; this gate's
  // whole premise is that noise is how a gate gets ignored.
  // `.catch(` [async] `(` [ignored param] `) =>` then an empty/comment-only body
  // OR a bare `undefined`. The first cut required a ZERO-ARG arrow, so
  // `.catch((_e) => {})` walked straight past it — one character defeated the
  // gate. There are 0 such instances today; that is luck, not design.
  String.raw`\.catch\(\s*(?:async\s*)?\(\s*[A-Za-z_$][\w$]*\s*(?::[^)]*)?\s*\)\s*=>\s*(?:\{\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*\}|undefined|null|void 0)\s*\)`
  + '|'
  + String.raw`\.catch\(\s*(?:async\s*)?\(\s*\)\s*=>\s*(?:\{\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*\}|undefined|null|void 0)\s*\)`,
  'g',
);

const walk = (dir, acc = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__tests__') walk(p, acc); }
    else if (/\.tsx?$/.test(e.name) && !e.name.includes('.test.')) acc.push(p);
  }
  return acc;
};

const files = walk(SRC);
// VACUITY GUARD, derived rather than hardcoded. A floor of 200 against an actual
// ~1869 would let the walk break by 89% and still "pass". `src/features` alone is
// the bulk of the tree, so if the whole walk does not exceed it, the walk is
// broken — the same relative shape check-failed-read-sentinels uses.
const featureFiles = walk(join(SRC, 'features')).length;
if (files.length <= featureFiles) {
  console.error(`✗ check-silent-write-failures: walked ${files.length} files but src/features alone holds ${featureFiles} — the walk is broken, not the code clean.`);
  process.exit(1);
}

let count = 0;
const hits = [];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(SILENT_CATCH)) {
    // STATEMENT-SCOPED, not a fixed window. The first cut looked back
    // >=200 chars from a line boundary, which reached into the PRECEDING
    // statement — /code-review reproduced a false positive where a read helper
    // named `updateVisibleRowsFromScroll(...)` on the line above claimed a
    // legitimate best-effort `warmCache().catch(() => {})`. Anchor on the
    // nearest statement boundary instead.
    // Walk back over BALANCED parens/braces to the start of the expression, so
    // an object-literal argument (`putLayout({ … }).catch(…)` — nearly every PUT
    // body) and a `.then(…).catch(…)` chain are still attributed to their call.
    // The previous anchor stopped at the nearest `{`/`;`, so both of those —
    // including the exact shape this branch's own fix writes — were invisible.
    const head = src.slice(0, m.index);
    let depth = 0; let i = head.length - 1;
    for (; i >= 0; i -= 1) {
      const c = head[i];
      if (c === ')' || c === '}' || c === ']') depth += 1;
      else if (c === '(' || c === '{' || c === '[') {
        if (depth === 0) break;
        depth -= 1;
      } else if (depth === 0 && (c === ';' || c === '\n') && /^\s*$/.test(head.slice(i, i + 1))) {
        // a newline at depth 0 only ends the statement if the next non-space
        // char back is not a chain continuation
        const before = head.slice(Math.max(0, i - 80), i).trimEnd();
        if (!before.endsWith('.') && !before.endsWith('(') && !before.endsWith(',')) break;
      } else if (depth === 0 && c === ';') break;
    }
    const stmt = head.slice(Math.max(0, i + 1));
    if (!WRITE_CALL.test(stmt)) continue;
    count += 1;
    hits.push(`${relative(SRC, f)}:${src.slice(0, m.index).split('\n').length}`);
  }
}

if (count > BASELINE) {
  console.error(`✗ check-silent-write-failures: ${count} write(s) swallow their failure (baseline ${BASELINE}).`);
  console.error('  The UI shows the edit as applied and the server never took it. Surface it —');
  console.error("  `toast.error(t('…SaveFailed'))` is the house convention (<Toaster/> is app-level,");
  console.error('  so it reaches the user even from an unmount flush).');
  for (const h of hits.slice(0, 10)) console.error(`    ${h}`);
  process.exit(1);
}
const note = count < BASELINE ? ` — down ${BASELINE - count}; lower BASELINE to ${count}.` : '';
console.log(`✓ check-silent-write-failures: ${count} silent write failure(s) across ${files.length} files (baseline ${BASELINE}, ratchet holds).${note}`);
