#!/usr/bin/env node
/**
 * Failure-card announcement RATCHET.
 *
 * THE DEFECT. `<StateCard>` renders this app's empty, loading AND failed states.
 * A failed one that does not pass `announce` is a SILENT swap: a sighted user
 * watches a skeleton become "Couldn't load your boards", a screen-reader user is
 * told nothing, and nothing reads as "nothing to report" — the exact false
 * conclusion the whole failed-read effort exists to prevent, reintroduced for the
 * users least able to work around it.
 *
 * Every genuine fix is one prop. This gate stops the population GROWING while the
 * existing ones are worked through lane by lane, exactly like
 * `check-failed-read-sentinels.mjs`.
 *
 * WHY AN ELEMENT PARSER AND NOT A GREP — this is not stylistic. Counting these
 * with a proximity regex (`StateCard[\s\S]{0,200}(Failed|error)`) produced THREE
 * different answers to the same question during this work (19, 48, 63), because a
 * character window straddles neighbouring JSX and comments. Every figure quoted
 * in a review from that grep was wrong. `elements()` below scans each open tag
 * string- and brace-aware, so a card's props are that card's props — see its own
 * comment for why naive bracket-balancing is not good enough either.
 *
 * WHAT IT DOES NOT CLAIM — read before trusting a green run.
 *
 * 1. A card inside the baseline is not "reviewed", merely pre-existing. Green
 *    means no NEW silent failure card appeared.
 * 2. FAILURE IS DETECTED BY COPY, so a failure card whose title key avoids the
 *    words below — `cantLoad`, `oops`, `orgsProblem` — is invisible to this gate.
 *    That is a known and deliberate false-negative class, not an oversight: the
 *    alternative is inferring intent from surrounding render logic, which is not
 *    statically decidable and would produce a guard nobody trusts.
 * 3. It cannot see whether the announcement is CORRECT, only that the prop is
 *    passed. That `announce` reaches a real live region is pinned by test, not
 *    here (`environmentsFailedReads.test.tsx` — and note the first version of
 *    THAT test passed against a fix which announced nothing at all).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { readGateBaseline } from './gateBaseline.mjs';
// ADR 0603 §7 — the element parser + failure criterion moved to ONE module when the
// recovery gate joined, rather than being hand-copied. See `failureCardScan.mjs`.
import { elements, stripComments, FAILURE_COPY } from './failureCardScan.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Scan root. Overridable ONLY so the gate's own tests can point the REAL
// script at a fixture tree — testing an extracted copy would prove the copy
// works, not the gate. Unset in every normal invocation.
const SRC = process.env.OPENWOP_GATE_SRC ?? join(__dirname, '..', 'src');

/**
 * THIS IS A DEBT FIGURE, NOT A NORM — the distinction matters for an
 * ACCESSIBILITY defect. 91 screens currently tell a screen-reader user nothing
 * when their data fails to load. A no-growth ratchet stops that spreading; it is
 * not progress, and a baseline that sits at 91 forever has been quietly accepted
 * rather than held. It must trend to 0.
 *
 * Lower it whenever a sweep wires cards up; it must never be raised.
 *
 * PRIORITISE BY TRAFFIC WHEN SWEEPING. The five cards wired first (environments,
 * commerce-ucp ×2, operations ×2) were chosen by where the author happened to be
 * working, not by user impact — they are all operator/admin surfaces. The screens
 * most people actually use every day are still silent: `chat/artifacts/LibraryPage`,
 * `kanban/KanbanPage`, `features/documents/DocumentsPage`, `features/crm/CrmPage`,
 * `agents/AgentsPage`, `builder/WorkflowsDashboard`. Start there.
 */
// 91 -> 0. Every failure card announces; the ONE card whose copy matches this
// criterion but is not a failure is named in EXPECTED_SILENT below, not absorbed
// into the number.
//
// WHY 0 AND AN ALLOWLIST, RATHER THAN A BASELINE OF 1. A numeric baseline is a
// SLOT: at `1`, a genuinely new silent failure card can appear the same day the
// legitimate one is fixed, and the gate stays green because the count matches.
// That is the same shape as the defect the whole programme is about — a number
// that cannot distinguish "the expected one" from "a different one". Naming the
// exception costs a line and makes the substitution impossible.
const BASELINE = readGateBaseline('check-failure-card-announce', 'OPENWOP_SILENT_FAILURE_CARD_BASELINE', 0);

/**
 * Cards whose copy trips FAILURE_COPY but which are NOT failures, so they must
 * stay silent. Each needs a reason, and the reason has to be about the STATE,
 * not about the copy.
 *
 * `ui-plugins`: the criterion catches "unavailable", but this branch is
 * `!viewer` — the plugin has no viewer registered, which is a fact about the
 * plugin rather than a failed read. Its two SIBLINGS in the same ternary chain
 * (`error` and `artifactError`) do announce.
 */
const EXPECTED_SILENT = [
  { file: 'features/ui-plugins/UiPluginsPage.tsx', title: 'witnessUnavailableTitle', body: 'witnessNoViewerBody' },
  // ADR 0510 Phase 2 — the design-system gallery's failed-state SPECIMEN: a
  // static rendering, not a real failed read; announcing it would post a
  // phantom failure to the live region on every gallery visit.
  { file: 'features/design-system-gallery/GalleryPage.tsx', title: 'stateFailed', body: 'stateFailedBody' },
];
const isExpectedSilent = (rel, el) =>
  EXPECTED_SILENT.some((x) => rel === x.file && el.includes(x.title) && el.includes(x.body));

const isSkipped = (p) => p.includes('__tests__') || p.endsWith('.test.ts') || p.endsWith('.test.tsx');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(full) && !isSkipped(full)) out.push(full);
  }
  return out;
}

const files = walk(SRC);

// VACUITY GUARD, derived rather than magic: `src/features` alone is the bulk of
// the tree, so a walk returning fewer files than that directory holds is broken.
const featureFiles = walk(join(SRC, 'features')).length;
if (files.length <= featureFiles) {
  console.error(`✗ check-failure-card-announce: walked ${files.length} files but src/features alone holds ${featureFiles} — the walk is broken, not the code clean.`);
  process.exit(1);
}

// THE GATE'S OWN PRECONDITION. Everything below tells people to pass `announce`,
// which pushes text into ADR 0363's GlobalLiveRegion. If that region is ever
// dropped from the app shell, every announcement in the app becomes a silent
// no-op — and the per-page tests would NOT catch it, because they mount the
// region themselves. So the gate checks the one thing its own advice depends on.
const APP = join(SRC, 'App.tsx');
if (!/<GlobalLiveRegion\b/.test(stripComments(readFileSync(APP, 'utf8')))) {
  console.error('✗ check-failure-card-announce: src/App.tsx no longer renders <GlobalLiveRegion />.');
  console.error('  Every `announce()` in the app — StateCard failures included — silently does nothing without it.');
  process.exit(1);
}

let total = 0;
let silent = 0;
let expected = 0;
const hits = [];
for (const f of files) {
  if (f.endsWith(join('ui', 'StateCard.tsx'))) continue; // the definition itself
  for (const el of elements(stripComments(readFileSync(f, 'utf8')))) {
    total += 1;
    const props = el.match(/(?:title|body)=\{[^}]*\}/g) ?? [];
    if (!props.some((p) => FAILURE_COPY.test(p))) continue;
    if (/\bannounce\b/.test(el)) continue;
    if (isExpectedSilent(relative(SRC, f), el)) { expected += 1; continue; }
    silent += 1;
    hits.push(relative(SRC, f));
  }
}

// THE REVERSE DIRECTION, folded in from `-2`'s parallel ratchet rather than left
// standing beside it — two gates over one concept drift and then neither is
// trustworthy (`-1`, crosstalk `ad9f`).
//
// It is not symmetry for its own sake. A live region that fires on every
// ordinary first visit is one people SWITCH OFF, and a switched-off region
// silently converts every assertion above into decoration. So an empty or
// loading card that announces is its own defect, and this gate owns both halves.
const NOT_A_FAILURE = /\bloading\b|noneTitle|empty[A-Z]|Empty[A-Z]|noMatch|no[A-Z]\w*Title/;
const overEager = [];
for (const f of files) {
  if (f.endsWith(join('ui', 'StateCard.tsx'))) continue;
  for (const el of elements(stripComments(readFileSync(f, 'utf8')))) {
    if (!/\bannounce\b/.test(el)) continue;
    // `announce={!!error}` is conditional and correct on a card that serves both
    // a failure and an ordinary state — LibraryPage's does exactly that.
    if (/announce=\{/.test(el)) continue;
    const props = el.match(/(?:title|body)=\{[^}]*\}/g) ?? [];
    if (props.some((x) => FAILURE_COPY.test(x))) continue;
    if (props.some((x) => NOT_A_FAILURE.test(x))) overEager.push(`${relative(SRC, f)}: ${el.replace(/\s+/g, ' ').slice(0, 90)}`);
  }
}
if (overEager.length > 0) {
  console.error(`✗ check-failure-card-announce: ${overEager.length} EMPTY/LOADING card(s) announce:`);
  for (const h of overEager) console.error(`  ${h}`);
  console.error('  A region that speaks on an ordinary first visit gets turned off, taking the real failures with it.');
  process.exit(1);
}

// A second vacuity arm: the element parser finding NO StateCards at all would
// look identical to a perfectly-wired codebase.
if (total === 0) {
  console.error('✗ check-failure-card-announce: parsed 0 <StateCard> elements — the parser is broken, not the code clean.');
  process.exit(1);
}

if (silent > BASELINE) {
  console.error(`✗ check-failure-card-announce: ${silent} failure StateCards do not announce (baseline ${BASELINE}). You ADDED ${silent - BASELINE}.`);
  console.error('  A failure card without `announce` is a silent swap — a screen-reader user is told nothing, which reads as "nothing to report".');
  console.error('  Pass `announce` on the FAILED state only; empty and loading cards must stay silent.');
  console.error(`  Files: ${[...new Set(hits)].slice(0, 12).join(', ')}`);
  process.exit(1);
}

const note = silent < BASELINE ? ` — down ${BASELINE - silent}; lower BASELINE to ${silent} in this file.` : '';
console.log(`✓ check-failure-card-announce: ${silent} silent failure StateCards of ${total} total (baseline ${BASELINE}, ratchet holds).${note}`);
