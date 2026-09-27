#!/usr/bin/env node
/**
 * Failure-card RECOVERY ratchet (ADR 0603 §7 / `PODU-2`).
 *
 * THE HOLE THIS FILLS, measured. On the feature-31 pass, all EIGHT read-only UX
 * gates exited 0 and not one of them could see `PODU-2`: `ShowsManager` rendered a
 * failure card that DID pass `announce` — so `check-failure-card-announce` was
 * satisfied, correctly, by its own criterion — above a skeleton that spun forever,
 * with the error never cleared and no way back except reloading the page. No gate in
 * the tree asked whether a failure card offers RECOVERY. This one does.
 *
 * A failure card is a dead end unless it carries a way out. In this codebase that is
 * the `action` prop (a Retry button, a "Check again", a link to the thing that can
 * explain it). A card that reports a failure and offers nothing is not a state, it is
 * a wall — and for the same reason `announce` matters, the users worst served are the
 * ones least able to improvise around it.
 *
 * DELIBERATELY BUILT ON THE SIBLING'S MACHINERY, not beside it. It reuses
 * `check-failure-card-announce`'s exported element parser and failure-copy criterion
 * rather than re-deriving them. Two gates that independently decide "what is a
 * failure card" drift, and then neither is trustworthy — the lesson that gate's own
 * header records about its `-2` predecessor.
 *
 * WHAT IT DOES NOT CLAIM — read before trusting a green run.
 *
 * 1. It inherits EVERY false-negative of the shared criterion: failure is detected
 *    by COPY, so a card whose title key avoids `failed|unavailable|couldn|error|…`
 *    is invisible here too. Same known class, one place.
 * 2. It cannot see whether the action WORKS. `action={<Button onClick={noop}/>}`
 *    passes. That an action re-runs the failed read is pinned by test
 *    (`podcastsFailureRecovery.test.tsx`), not here.
 * 3. A card inside the baseline is not "reviewed", merely pre-existing.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { readGateBaseline } from './gateBaseline.mjs';
import { elements, stripComments, hasRecoveryAction, FAILURE_COPY } from './failureCardScan.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = process.env.OPENWOP_GATE_SRC ?? join(__dirname, '..', 'src');

/**
 * A DEBT FIGURE, NOT A NORM. 48 failure cards in this app are dead ends: a user who
 * hits one can only reload the page. Lower it whenever a sweep wires cards up; never
 * raise it. It must trend to 0.
 *
 * The number is the MEASUREMENT at the moment this gate landed (48 of 170 failure
 * cards, 701 StateCards total), not a target. `PODU-2` was one of them, and is fixed
 * in the same commit — so this baseline already reflects that fix and cannot be
 * satisfied by re-breaking it.
 *
 * 48 → 46 (2026-09-03): CRM-UX-14 residue (feature loop 2026-09 it.4 fix-up) —
 * `features/crm/BookingTab.tsx` + `SignTab.tsx`'s failed-read StateCards gained
 * the Retry action when their raw-`e.message` error Notices were dropped (one
 * channel, with a recovery). Measured after the change: 46 dead ends.
 */
const BASELINE = readGateBaseline('check-failure-card-recovery', 'OPENWOP_FAILURE_CARD_NO_RECOVERY_BASELINE', 46);

/**
 * Failure cards that legitimately offer no action. Each needs a reason about the
 * STATE, not the copy — a numeric slot would let a genuinely new dead end appear the
 * day a listed one is fixed (the sibling gate's argument for naming, not counting).
 *
 * EMPTY, and deliberately so. The obvious candidate — the design-system gallery's
 * failed-state SPECIMEN — turned out to already carry a Retry button, so listing it
 * would have been a DECORATIVE exception: a line that looks like judgement and
 * excludes nothing. Verified by measurement (`0 named exception(s)` in the gate's own
 * output), not assumed. Add an entry only when the gate actually flags something that
 * is genuinely not a dead end.
 */
const EXPECTED_NO_ACTION = [];
const isExpected = (rel, el) => EXPECTED_NO_ACTION.some((x) => rel === x.file && el.includes(x.title));

const isSkipped = (p) => p.includes('__tests__') || p.endsWith('.test.ts') || p.endsWith('.test.tsx');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(full) && !isSkipped(full)) out.push(full);
  }
  return out;
}

const files = walk(SRC);

// VACUITY GUARD, derived rather than magic — the failure mode this whole batch is
// about is a check that RAN NOTHING and reported green.
const featureFiles = walk(join(SRC, 'features')).length;
if (files.length <= featureFiles) {
  console.error(`✗ check-failure-card-recovery: walked ${files.length} files but src/features alone holds ${featureFiles} — the walk is broken, not the code clean.`);
  process.exit(1);
}

let totalCards = 0;
let failureCards = 0;
let deadEnds = 0;
let expected = 0;
const hits = [];
for (const f of files) {
  if (f.endsWith(join('ui', 'StateCard.tsx'))) continue; // the definition itself
  const rel = relative(SRC, f);
  for (const el of elements(stripComments(readFileSync(f, 'utf8')))) {
    totalCards += 1;
    const props = el.match(/(?:title|body)=\{[^}]*\}/g) ?? [];
    if (!props.some((p) => FAILURE_COPY.test(p))) continue;
    failureCards += 1;
    // `L1` (ADR 0603 R1) — the test USED to be `/\baction=/`, i.e. a test for the
    // PROP. `action={undefined}`, `action={null}` and `action={cond && <Button/>}`
    // all satisfied it while rendering nothing, so a dead end could pass this gate
    // by NAMING the escape hatch it does not offer. The shared predicate requires
    // something actuatable in the action's subtree. Zero hits either way today —
    // the tightening moves no number, it closes the hole ahead of the first walker.
    if (hasRecoveryAction(el)) continue;
    if (isExpected(rel, el)) { expected += 1; continue; }
    deadEnds += 1;
    hits.push(rel);
  }
}

// SECOND VACUITY GUARD. `deadEnds === 0` is only meaningful if the scan actually
// classified cards. A criterion change that stops matching anything would otherwise
// read as "every failure card now offers recovery" — the empty-hits-reads-as-fixed
// shape this batch's ADR is named after.
if (failureCards < 100) {
  console.error(`✗ check-failure-card-recovery: only ${failureCards} failure card(s) matched of ${totalCards} StateCards — the CRITERION is broken, not the code clean.`);
  process.exit(1);
}

if (deadEnds > BASELINE) {
  console.error(`✗ check-failure-card-recovery: ${deadEnds} failure StateCard(s) offer no recovery action (baseline ${BASELINE}).`);
  const counts = new Map();
  for (const h of hits) counts.set(h, (counts.get(h) ?? 0) + 1);
  for (const [file, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.error(`    ${file}${n > 1 ? ` (${n})` : ''}`);
  }
  console.error('  A failure card with no way out is a dead end: the only recovery is reloading the page.');
  console.error('  Give it `action={<Button variant="secondary" onClick={retry}>{t(\'common:retry\')}</Button>}`,');
  console.error('  where `retry` re-runs the read that failed — and clear the error at the start of that read.');
  process.exit(1);
}

const trend = deadEnds < BASELINE ? ` — lower the baseline to ${deadEnds}` : ', ratchet holds';
console.log(`✓ check-failure-card-recovery: ${deadEnds} failure StateCard(s) without a recovery action of ${failureCards} failure cards (${totalCards} total), baseline ${BASELINE}${trend}. ${expected} named exception(s).`);
