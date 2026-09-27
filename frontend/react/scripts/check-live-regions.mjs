#!/usr/bin/env node
/**
 * Hand-rolled state-backed polite live region — RATCHET gate (`ANN-UX-2`).
 *
 * THE DEFECT. A live region only speaks when its text MUTATES. A region that
 * renders a `useState` string as a bare text child is therefore SILENT on a
 * repeat: React bails on `Object.is`-equal state before the DOM is touched, and
 * even on a forced render the reconciler skips an equal text update. Setting the
 * same message twice announces once.
 *
 *     const [msg, setMsg] = useState('');
 *     …
 *     setMsg(t('resetAnnounce'));      // press reset  -> spoken
 *     setMsg(t('resetAnnounce'));      // press again  -> SILENT
 *     …
 *     <span aria-live="polite" className="sr-only">{msg}</span>
 *
 * The moment it bites is the worst possible one: a user who is not sure the
 * keypress worked presses it again, and hears nothing. Silence reads as
 * "nothing to report", which is the opposite of what happened.
 *
 * THE FIX is `ui/announce.tsx`'s `useLiveRegion()` — same `[text, set]` shape,
 * but repeats alternate an invisible zero-width marker so the DOM genuinely
 * changes while the SPOKEN text stays identical. Ambient churn (a flapping peer
 * connection) opts out with `set(msg, { collapseRepeats: true })`, because a
 * polite region queues and re-announcing noise backs the queue up.
 *
 * THE GOAL IS NOT ZERO — read this before "fixing" the count to 0.
 *
 * This app has 53 polite `aria-live` sites outside tests (a raw grep says 58 —
 * five are inside comments, which this script strips). 46 of them render
 * DERIVED text inline (`{loading ? t('busy') : ''}`, a constant, a `useMemo`)
 * where the repeat bug CANNOT bite, because the value changes whenever the
 * condition does. Two more render a variable that no setter writes (the global
 * announcer's `useSyncExternalStore` value; a `const x = cond ? a : b`). Only the
 * setter-written `useState` shape is a defect, so only that shape is counted.
 * A gate that flagged all 58 would be flagging correct code, the baseline would
 * never meaningfully shrink, and people would learn to ignore it.
 *
 * WHY A COUNT AND NOT A BAN. Whether a given announcer can genuinely repeat is a
 * judgement about the call sites — `AgentInstallPage`'s single one-shot install
 * message interpolates the pack name and its button is gone after the install, so
 * it cannot repeat identically and is deliberately left alone. That judgement is
 * not statically decidable, so this gate asserts only what it can see: THE SHAPE
 * DOES NOT SPREAD. Every genuine migration lowers the baseline; it must never be
 * raised. Same contract as `check-failed-read-sentinels.mjs`, deliberately.
 *
 * WHAT IT DOES NOT CLAIM.
 *  1. A region inside the baseline is not "audited", merely pre-existing.
 *  2. Only the `>{bareVariable}<` child shape is judged. A region whose child is
 *     an expression (`{a ?? b}`, `{fn(x)}`) is skipped even if `a` is state,
 *     because the surrounding expression usually is what makes it change. That
 *     is the deliberate trade: narrow enough to be trustworthy.
 *  3. Only a variable declared IN THE SAME FILE as `const [v, setV] = useState`
 *     counts. One arriving by prop or context is invisible here.
 *
 * The self-checks below are what make a green run mean anything: a scanner that
 * silently matches nothing looks exactly like a clean codebase.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { readGateBaseline } from './gateBaseline.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'src');

/**
 * Lower this whenever a region migrates to `useLiveRegion`; never raise it.
 *
 * Pinned EXACTLY at the post-migration count, with no slack — slack in a ratchet
 * is silent capacity for regression, which is the failure mode the sibling
 * sentinel gate documents (it sat at 100 while the real count was 81, tolerating
 * 19 regressions before it would have said a word).
 *
 * The 1 is `agents/AgentInstallPage.tsx`: one call site, message interpolates the
 * pack name, and a successful install removes the control that produced it — so
 * it cannot emit the same string twice. Migrating it would be harmless but would
 * assert nothing, and the honest thing is to say why it stayed rather than to
 * bank a 0 that overstates the coverage.
 */
// A TYPO IN THE OVERRIDE USED TO DISABLE THE GATE. `Number('one')` is `NaN`, and
// every comparison against `NaN` is false — including `bare > BASELINE` — so an
// unparseable value did not raise the bar or lower it, it removed it, and the run
// still printed a tick (with "baseline NaN" in small type). An override that
// cannot be read is an operator MISTAKE, not permission to assert nothing.
//
// That reasoning is now the SHARED rule (ADR 0598 §Correction 3): it was written
// here and NOT applied to the sibling gate extended in the same commit, which is
// the argument for one resolver over N hand-written copies.
const BASELINE = readGateBaseline('check-live-regions', 'OPENWOP_LIVE_REGION_BASELINE', 1);

/**
 * WHICH bare region is permitted, by path — not merely HOW MANY.
 *
 * The count alone let the permitted one be swapped for a different one and stay
 * green: migrate `AgentInstallPage`, add a genuinely repeatable announcer
 * somewhere else, and `bare` is still 1. The identity is the thing the paragraph
 * above actually argues for ("one call site, message interpolates the pack name,
 * a successful install removes the control"), so the identity is what is pinned.
 * The count check below stays as well — it is what catches a SECOND one.
 */
const ALLOWED = new Set(['agents/AgentInstallPage.tsx']);

/**
 * The IMPLICIT-`role="status"` population gets its OWN baseline and its OWN
 * allowlist, deliberately — it is NOT folded into the two above.
 *
 * When ADR 0598 taught this gate to see `role="status"`, five bare regions that
 * had been invisible since they were written appeared at once. Absorbing them by
 * raising `BASELINE` 1 -> 6 would have destroyed what that number means: it is
 * pinned "EXACTLY at the post-migration count, with no slack" precisely so a
 * regression cannot hide in it, and five newly-VISIBLE pre-existing sites are not
 * a migration. Two ratchets keep the accounting honest — the old population still
 * cannot grow past 1, and the new one cannot grow past 5 — and neither can launder
 * the other.
 *
 * These five are NOT audited, merely pre-existing, and they belong to five other
 * features' surfaces; fixing them inside a strategy PR would have hidden the count
 * inside an unrelated change (the PR-A precedent: measure, enumerate, leave open).
 * Every one is filed in ADR 0598. Lower this as they migrate; never raise it.
 */
const IMPLICIT_BASELINE = readGateBaseline('check-live-regions', 'OPENWOP_IMPLICIT_LIVE_REGION_BASELINE', 5);
const IMPLICIT_ALLOWED = new Set([
  'builder/BuilderShell.tsx',              // debugNotice
  'builder/HistoryDrawer.tsx',             // notice
  'builder/inspector/NodeConnections.tsx', // added
  'chat/ChatInput.tsx',                    // phaseAnnounce
  'features/document-editor/DocumentToolbarExtras.tsx', // status
]);
/**
 * A polite region whose only child is a bare variable reference.
 *
 * `[^>]*` spans the remaining attributes (and newlines — it is a negated class,
 * not `.`), so both attribute orders and multi-line JSX match. Attributes are
 * literal `aria-live="polite"` only: a computed `aria-live={x ? 'polite' : 'off'}`
 * is out of scope by construction.
 */
const REGION = /aria-live="polite"[^>]*>\s*\{\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\}/g;

/**
 * THE SAME SHAPE, SPELLED IMPLICITLY (added by ADR 0598, feature 26 `SPU-1`).
 *
 * `role="status"` carries an IMPLICIT `aria-live="polite"` (ARIA 1.2 §status), so
 *
 *     <span role="status">{result}</span>
 *
 * is a polite live region in every respect that matters — including the repeat
 * defect above — and the literal-attribute key made it INVISIBLE to this gate.
 * That is not hypothetical: a `/grade-ux` pass ran all three a11y gates against
 * `features/strategy` and got three green ticks while a bare `<span role="status">`
 * held the CSV import result, i.e. the one channel that told a screen-reader user
 * how many objectives were created. `check-notice-announce.mjs` inspects only
 * `<Notice>` and `check-failure-card-announce.mjs` only `<StateCard>`, so a bare
 * `<span>` fell between all three.
 *
 * Matched SEPARATELY rather than by widening `REGION`, so the pre-existing
 * population, its baseline and the guards below all keep their exact meaning; a
 * tag carrying BOTH spellings is attributed to `REGION` alone (see `tagOf`).
 */
const IMPLICIT_REGION = /role="status"[^>]*>\s*\{\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\}/g;

/**
 * The opening tag a match sits in: back to the nearest `<`, forward to the `>`
 * that ended the match. Used to decide whether an implicit hit ALSO carries an
 * explicit `aria-live` — either because `REGION` already counted it (double
 * count) or because that attribute says something other than `polite`
 * (`aria-live="off"` on a `role="status"` is not a polite region).
 */
function tagOf(src, matchIndex, matchText) {
  const open = src.lastIndexOf('<', matchIndex);
  const close = src.lastIndexOf('>', matchIndex + matchText.length);
  return open === -1 || close <= open ? matchText : src.slice(open, close + 1);
}

/** Any `aria-live="polite"`, used purely as the "did the walk see JSX at all" floor. */
const ANY_POLITE = /aria-live="polite"/g;

/** The implicit spelling's own floor — see VACUITY GUARD 5. */
const ANY_STATUS_ROLE = /role="status"/g;

/** Tests legitimately hand-roll the broken shape to sabotage-probe the fix. */
const isSkipped = (p) => p.includes('__tests__') || p.endsWith('.test.tsx') || p.endsWith('.test.ts');

/**
 * How `v` was produced, judged from its declaration in the same file.
 *
 *   `useState`        -> BARE, the defect this gate bounds
 *   `useLiveRegion`   -> migrated (`ui/announce.tsx`)
 *   `useSurfaceChrome`-> the canvas chassis announcer, which owns its own region
 *   anything else     -> derived/unknown; NOT counted (see "what it does not claim")
 */
function originOf(src, v) {
  const pair = new RegExp(`(?:const|let)\\s*\\[\\s*${v}\\s*,\\s*[A-Za-z0-9_$]+\\s*\\]\\s*=\\s*((?:React\\.)?[A-Za-z0-9_$]+)`).exec(src);
  if (!pair) return 'derived';
  const hook = pair[1].replace(/^React\./, '');
  if (hook === 'useState') return 'bare';
  return hook; // useLiveRegion, useSurfaceChrome, a local wrapper, …
}

/** Comments describing the defect are not instances of it (the lesson the
 *  sentinel gate learned the hard way — it reddened a build for the commit that
 *  FIXED four of them and explained why). */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const t = line.trimStart();
      if (t.startsWith('//') || t.startsWith('*')) return '';
      return line.replace(/(^|[^:])\/\/.*$/, '$1');
    })
    .join('\n');
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(full) && !isSkipped(full)) out.push(full);
  }
  return out;
}

const files = walk(SRC);

// VACUITY GUARD 1 — the walk. Derived, not a magic number: `src/features` alone
// is the bulk of the tree, so a walk returning no more than that is broken.
const featureFiles = walk(join(SRC, 'features')).length;
if (files.length <= featureFiles) {
  console.error(`✗ check-live-regions: walked ${files.length} files but src/features alone holds ${featureFiles} — the walk is broken, not the code clean.`);
  process.exit(1);
}

let politeSites = 0;
let statusRoleSites = 0;
let varRegions = 0;
let implicitVarRegions = 0;
let bare = 0;
let bareImplicit = 0;
const hits = [];
const implicitHits = [];
const bareFiles = [];
const bareImplicitFiles = [];
const migrated = [];

for (const f of files) {
  const src = stripComments(readFileSync(f, 'utf8'));
  politeSites += (src.match(ANY_POLITE) ?? []).length;
  statusRoleSites += (src.match(ANY_STATUS_ROLE) ?? []).length;
  const classify = (name, implicit) => {
    const origin = originOf(src, name);
    if (origin === 'bare') {
      if (implicit) { bareImplicit += 1; bareImplicitFiles.push(relative(SRC, f)); }
      else { bare += 1; bareFiles.push(relative(SRC, f)); }
      (implicit ? implicitHits : hits).push(`${relative(SRC, f)} (${name})`);
    } else if (origin === 'useLiveRegion') {
      migrated.push(relative(SRC, f));
    }
  };
  for (const m of src.matchAll(REGION)) {
    varRegions += 1;
    classify(m[1], false);
  }
  for (const m of src.matchAll(IMPLICIT_REGION)) {
    // Attribute a tag carrying BOTH spellings to `REGION` alone, and skip a
    // `role="status"` whose explicit `aria-live` is something other than polite.
    if (/aria-live=/.test(tagOf(src, m.index, m[0]))) continue;
    implicitVarRegions += 1;
    varRegions += 1;
    classify(m[1], true);
  }
}

// VACUITY GUARD 2 — the JSX pattern. If no polite region exists anywhere, the
// attribute spelling changed (or the walk found no JSX) and this gate is
// asserting nothing while printing a tick.
if (politeSites === 0) {
  console.error(`✗ check-live-regions: found 0 \`aria-live="polite"\` sites across ${files.length} files — the pattern drifted, so this gate is asserting nothing.`);
  process.exit(1);
}

// VACUITY GUARD 3 — the SHAPE this gate actually judges. Guard 2 alone is not
// enough: the regions could all still be there while the `>{variable}<` child
// shape stopped matching (a formatter change, a wrapper component), and with a
// low baseline a count of 0 would then sail through as "clean". A gate whose
// subject has vanished must go red, not green.
if (varRegions === 0) {
  console.error(`✗ check-live-regions: ${politeSites} polite regions exist but 0 render a bare \`{variable}\` child — the shape this gate judges drifted, so the count below means nothing.`);
  process.exit(1);
}

// VACUITY GUARD 5 — the IMPLICIT spelling, which guards 2 and 3 cannot protect:
// they are both keyed on the literal `aria-live="polite"`, so `role="status"`
// could vanish from the codebase (renamed, wrapped in a component, reformatted so
// the child is no longer a bare `{variable}`) and this half of the gate would
// assert nothing while the totals above stayed healthy. That is exactly how the
// gate came to be extended: a green tick over an unseen population. `role="status"`
// is a fixture of this app's chrome (`ui/Notice`, `ui/toast`, `ui/announce` and
// every hand-rolled status line), so a count of ZERO means the pattern drifted.
if (statusRoleSites === 0) {
  console.error(`✗ check-live-regions: found 0 \`role="status"\` sites across ${files.length} files — the implicit-polite spelling drifted, so that half of this gate is asserting nothing.`);
  process.exit(1);
}

// VACUITY GUARD 4 — the ORIGIN CLASSIFIER, which the three guards above do not
// touch: they protect the region SHAPE, and a region can match `REGION` perfectly
// while `originOf` answers 'derived' for every one of them. Break a single
// character in that declaration regex and this gate prints
// `0 bare … 0 on useLiveRegion` — a GREEN run that invites lowering the baseline
// to 0 and banking coverage that was never measured. (That is not hypothetical:
// it is how this guard was found.) The migrated set is the only population whose
// size we know independently, so it is the floor: four regions are on
// `useLiveRegion` today, and a classifier that cannot find them is broken.
// HONESTY NOTE (a `/grade-code` finding, recorded rather than quietly fixed):
// this floor of 4 is propped up by three migrations that CANNOT currently engage
// the repeat mechanism they migrated for — `challenge-outline` clears its region
// to '' before every message so `prev` is always empty; `territories`
// interpolates a count that changes every action; `BuilderShell`'s status path
// fires from an effect keyed on change. Only `DashboardPage` can emit the same
// string twice. The migrations are still correct (they cost nothing and remove
// the hazard if those call sites ever change), but this guard proves the
// CLASSIFIER still works, NOT that the mechanism is exercised — that is what
// `ui/__tests__/useLiveRegion.test.tsx` proves, against a real MutationObserver.
// Do not read a green tick here as "repeats are audible app-wide".
if (migrated.length < 4) {
  console.error(`✗ check-live-regions: classified only ${migrated.length} region(s) as \`useLiveRegion\` (expected at least 4) across ${varRegions} variable-backed regions.`);
  console.error('  The ORIGIN classifier (`originOf`) is broken, so every region is falling through to "derived" and the');
  console.error('  bare count below is meaningless. Do NOT lower the baseline to match it — fix the declaration regex.');
  process.exit(1);
}

// IDENTITY, not just count. A permitted bare region that migrates while a NEW one
// appears elsewhere leaves the count untouched, so the count alone would report
// the swap as no change at all.
const unexpected = bareFiles.filter((f) => !ALLOWED.has(f));
if (unexpected.length > 0) {
  console.error(`✗ check-live-regions: bare \`useState\` polite region(s) in file(s) that are not on the allowlist: ${[...new Set(unexpected)].join(', ')}.`);
  console.error('  A live region only speaks when its text MUTATES, so setting the SAME message twice announces ONCE —');
  console.error('  silent exactly when a user repeats an action to check it worked.');
  console.error("  Use `useLiveRegion()` from `ui/announce.js` (same `[text, set]` shape) and add `aria-atomic=\"true\"`;");
  console.error('  pass `{ collapseRepeats: true }` for AMBIENT churn the user did not cause.');
  console.error(`  Sites: ${hits.join(', ')}`);
  process.exit(1);
}
const staleAllowed = [...ALLOWED].filter((f) => !bareFiles.includes(f));

// The same IDENTITY check for the implicit population — a migrated one being
// swapped for a new one elsewhere must not read as no change at all.
const unexpectedImplicit = bareImplicitFiles.filter((f) => !IMPLICIT_ALLOWED.has(f));
if (unexpectedImplicit.length > 0) {
  console.error(`✗ check-live-regions: bare \`useState\` region(s) behind an IMPLICIT \`role="status"\` in file(s) that are not on the implicit allowlist: ${[...new Set(unexpectedImplicit)].join(', ')}.`);
  console.error('  `role="status"` IS a polite live region (ARIA 1.2 §status), so it has the same repeat defect —');
  console.error('  and it is the spelling three a11y gates could not see (ADR 0598 / feature 26 `SPU-1`).');
  console.error("  Use `useLiveRegion()` from `ui/announce.js`, or `announce()` for sr-only status with no visible region.");
  console.error(`  Sites: ${implicitHits.join(', ')}`);
  process.exit(1);
}
const staleImplicitAllowed = [...IMPLICIT_ALLOWED].filter((f) => !bareImplicitFiles.includes(f));

if (bareImplicit > IMPLICIT_BASELINE) {
  console.error(`✗ check-live-regions: ${bareImplicit} bare \`useState\` IMPLICIT-polite region(s) (\`role="status"\`, baseline ${IMPLICIT_BASELINE}). You ADDED ${bareImplicit - IMPLICIT_BASELINE}.`);
  console.error(`  Sites: ${implicitHits.join(', ')}`);
  process.exit(1);
}

if (bare > BASELINE) {
  console.error(`✗ check-live-regions: ${bare} polite live region(s) backed by a bare \`useState\` (baseline ${BASELINE}). You ADDED ${bare - BASELINE}.`);
  console.error('  A live region only speaks when its text MUTATES, so setting the SAME message twice announces ONCE —');
  console.error('  silent exactly when a user repeats an action to check it worked.');
  console.error("  Use `useLiveRegion()` from `ui/announce.js` (same `[text, set]` shape) and add `aria-atomic=\"true\"`;");
  console.error('  pass `{ collapseRepeats: true }` for AMBIENT churn the user did not cause.');
  console.error(`  Sites: ${hits.join(', ')}`);
  process.exit(1);
}

/**
 * A STALE ALLOWLIST ENTRY IS AN ERROR (ADR 0598 §Correction 9).
 *
 * This was a NOTE appended to a green tick — "allowlist entries no longer bare:
 * …; delete from the allowlist" — while the sibling `check-notice-announce.mjs`
 * exits 1 on exactly the same condition, with the rationale written out:
 *
 *   "A stale exemption is worse than none: it reads as a reviewed decision while
 *    exempting nothing, and the next person inherits a list they cannot trust."
 *
 * That rationale does not become weaker on this side of the seam. Two gates, one
 * invariant, two different verdicts is how a rule stops being a rule — and a note
 * on a PASSING run is read by nobody, which is the whole finding. The asymmetry
 * was INHERITED by the ADR 0598 implicit allowlist from the pre-existing explicit
 * one rather than invented here; both are fixed together, because fixing one
 * would have recreated the asymmetry inside a single file.
 *
 * MEASURED before flipping it: both allowlists are fully live (0 stale), so this
 * is not a latent red for anybody.
 */
const stale = [...staleAllowed, ...staleImplicitAllowed];
if (stale.length > 0) {
  console.error(`✗ check-live-regions: ${stale.length} allowlist entr${stale.length === 1 ? 'y matches' : 'ies match'} no live bare region:`);
  for (const f of stale) console.error(`    ${f}`);
  console.error('  Either the region moved to `useLiveRegion()` (DELETE the entry and lower the baseline —');
  console.error('  that is the gain being locked in) or the file was renamed. A stale exemption reads as a');
  console.error('  reviewed decision while exempting nothing.');
  process.exit(1);
}

const note = bare < BASELINE ? ` — down ${BASELINE - bare}; lower BASELINE to ${bare} in this file.` : '';
const implicitNote = bareImplicit < IMPLICIT_BASELINE ? ` — implicit down ${IMPLICIT_BASELINE - bareImplicit}; lower IMPLICIT_BASELINE to ${bareImplicit}.` : '';
console.log(`✓ check-live-regions: ${bare} bare-useState explicit-polite + ${bareImplicit} implicit (\`role="status"\`) region(s) of ${varRegions} variable-backed (${implicitVarRegions} implicit; ${politeSites} explicit-polite + ${statusRoleSites} status-role sites total, ${migrated.length} on useLiveRegion), baselines ${BASELINE}/${IMPLICIT_BASELINE}, allowlists ${ALLOWED.size}/${IMPLICIT_ALLOWED.size}, ratchet holds.${note}${implicitNote}`);
