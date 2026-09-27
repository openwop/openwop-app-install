#!/usr/bin/env node
/**
 * Every `<Notice variant="success">` that reports a COMPLETED ACTION must
 * announce it.
 *
 * `Notice` derives `assertive` from `variant === 'error'` alone
 * (`ui/Notice.tsx`), so a `success` notice renders `role="status"` — and a
 * status region that MOUNTS ALREADY CONTAINING its text announces nothing.
 * `StateCard` had the identical defect (#2615/#2616). The result was that
 * finishing an action told a screen-reader user precisely nothing, while the
 * DOM looked correct and an attribute-level test passed either way.
 *
 * WHY 0 AND AN ALLOWLIST, NOT A NUMERIC BASELINE — the same reasoning as
 * `check-failure-card-announce.mjs`: a baseline of N is a SLOT. At `6`, a
 * genuinely new silent success notice can appear the same day one of the six
 * legitimate ones is wired, and the count still matches. Naming each exception
 * costs a line and makes that substitution impossible.
 *
 * NOT every success notice should announce. Six render from a STATE rather than
 * an action, so announcing would fire on every mount and every route back to
 * the page — noise is a defect in the same family as silence, just failing the
 * other way. Those are named below WITH the reason, because the skip is the
 * part a later well-meaning edit would undo.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { LEGACY_SILENT_READ_SITES } from './notice-announce-0598-cohort.mjs';
import { readGateBaseline } from './gateBaseline.mjs';

// Scan root. Overridable ONLY so the gate's own tests can point the REAL
// script at a fixture tree — testing an extracted copy would prove the copy
// works, not the gate. Unset in every normal invocation.
const SRC = process.env.OPENWOP_GATE_SRC ?? join(process.cwd(), 'src');
// Via the SHARED resolver (ADR 0598 §Correction 3) — `Number(env ?? '0')` reads a
// typo as NaN, and `count > NaN` is false, so an unreadable override turned this
// gate OFF while printing a tick.
const BASELINE = readGateBaseline('check-notice-announce', 'OPENWOP_SILENT_SUCCESS_NOTICE_BASELINE', 0);

/**
 * Success notices that must STAY silent, each with why. The reason has to be
 * about the STATE that renders it, never about the copy.
 */
const EXPECTED_SILENT = [
  // [file, rule, reason] — the RULE is part of the key. A file exempted for one
  // rule must not silently inherit the exemption for the other; that is how a
  // second rule quietly stops enforcing anything.
  ['a11y/A11yIssuesPanel.tsx', 'success', 'the empty-issues state display, not the act of checking'],
  ['agents/AgentConnectionStatusPanel.tsx', 'success', '`allConfigured` is standing status, not an outcome'],
  ['features/kicktodo/ProgressPage.tsx', 'success', '`completed` celebration re-renders on every visit'],
  ['settings/HeartbeatSettingsPage.tsx', 'success', 'a banner describing current settings'],
  ['workforces/WorkforcesGalleryPage.tsx', 'success', '`allClear` is standing status'],
  // Same file also has an ANNOUNCED notice (the placed demo order) — this entry
  // covers only the `?paid` landing banner, which renders from a URL parameter,
  // so a refresh or back-navigation would re-announce a purchase already made.
  ['features/commerce/StorefrontPage.tsx', 'success', 'the `?paid` landing banner renders from a URL parameter'],
  // ADR 0510 Phase 2 — the design-system gallery renders a STATIC success
  // Notice specimen (no action occurred); announcing it would post a phantom
  // completion to the live region on every visit.
  ['features/design-system-gallery/GalleryPage.tsx', 'success', 'static specimen — no action occurred'],
  // RULE 2 exemption, keyed by the FLAG (see the note on `silentAllowed`).
  // `DocumentsPage` sets `accessFailed` and `canvasesFailed` from independent
  // handlers in the SAME load effect, so unlike action results they genuinely
  // CO-OCCUR — and `canvasesFailed` already announces. The polite slot holds one
  // string, so wiring this too would mean whichever rendered last silently
  // replaced the other. One disclosure that is heard beats two that race.
  //
  // NARROWED 2026-08-11: this was file-keyed, which also exempted
  // `projectsFailed` at :349 — a different read, in a different section,
  // rendering a retry the user was never told about. The reason above never
  // covered it. That disclosure now announces; this entry covers `accessFailed`
  // and nothing else.
  ['features/documents/DocumentsPage.tsx', 'failed-read', 'accessFailed', 'co-occurs with canvasesFailed, which already announces — the polite slot holds one string'],
];
// Rule-1 (success) exemptions stay FILE-keyed — a page has at most one success
// notice in practice. Rule-2 (failed-read) exemptions are keyed by file + the
// FLAG the notice is gated on, because a page can hold several failed reads and
// a file key exempts all of them.
//
// MEASURED 2026-08-11, which is why this changed: the single legitimate
// entry — DocumentsPage, written for `accessFailed` — was ALSO exempting
// `projectsFailed` at :349, a different read in a different section rendering a
// retry the user was never told about. The reason on the entry ("canvasesFailed
// already announces — they co-occur") never covered it. The file key was
// silently laundering a real defect.
//
// NOT file:line. Line numbers shift on every edit above them, so an entry stops
// matching, the gate reports a violation on untouched code, and the cheapest
// repair is bumping the number — which trains "edit the allowlist" instead of
// "fix the defect". A flag name only breaks when someone RENAMES the state, which
// is rare, deliberate, and a moment when re-reviewing the exemption is correct.
const silentAllowed = new Set(
  EXPECTED_SILENT.map(([f, rule, flag]) => (rule === 'failed-read' ? `${rule}:${f}:${flag}` : `${rule}:${f}`)),
);
const allowlistHits = new Set();

/**
 * RULE 2 — a `warning`/`info`/`error` notice GATED ON A FAILED-READ FLAG must
 * announce. (`error` was added by ADR 0598 — see the three holes below.)
 *
 * These say "we could not get this data". A screen-reader user who never hears
 * one is shown an INCOMPLETE ANSWER with no way to know — the same
 * absence-is-a-claim family as rule 1, arriving through a different variant.
 *
 * The criterion is deliberately narrow. Of 183 silent warning/info notices only
 * ~12 gate on a failed-read flag; the rest are static informational furniture
 * that SHOULD stay silent, and announcing those would fire on every mount and
 * every route back. Noise is a defect in the same family as silence.
 */
// The `\(?` is load-bearing. Without it this anchored at `$` immediately after
// `&&`, so it only matched a gate written on ONE line — and the common
// multi-line JSX form
//
//     {loadFailed && (
//       <Notice variant="warning">…
//
// has an opening paren in the way and was INVISIBLE. MEASURED 2026-08-10:
// closing that hole took the reported count from 0 to 15. The gate had been
// printing "0 unannounced" while fifteen failed-read disclosures never reached
// assistive tech, which is the precise failure this file exists to prevent,
// committed by the file itself.
//
// THREE MORE HOLES, closed by ADR 0598 (feature 26 `SPU-1`/`SPU-5`). A `/grade-ux`
// pass ran this gate against `features/strategy` and got a green tick while three
// failure notices reached assistive tech not at all. Splitting the one regex into
// a SHAPE test and a NAME test is what makes the three separable:
//
//  1. THE EARLY-RETURN SHAPE. The old regex demanded `flag ? (` / `flag && (`, so
//     `if (failed) return <Notice…>` — an equally common way to write the same
//     disclosure — was invisible at EVERY variant, not just at `error`.
//  2. A FLAG NAMED `failed`. `\b\w*Failed\b` is case-SENSITIVE on the suffix, so
//     `loadFailed` matched and a bare `failed` did not. Two of strategy's three
//     escapes were named exactly that. This is not in the original finding; it
//     turned up from testing the regex against the real flag names rather than
//     re-reading the sentence about it.
//  3. `variant="error"` — see RULE 2 below.
//
// STILL NOT SEEN, and deliberately named rather than implied: an early return
// whose `<Notice>` is not the FIRST element after it (`if (loadError) { return (
// <div><PageHeader …/><Notice…>`). The gate reads a 60-character window before
// the element, and widening that to the enclosing block trades a real false-
// positive rate for it. Filed in ADR 0598, not silently assumed covered.
//
// A FOURTH HOLE, and the one that mattered most (ADR 0598 §Correction 2): shapes
// 0/1 capture the ONE identifier adjacent to the `?`/`&&`, so a COMPOUND gate
// classified on the wrong operand.
//
//     {ctxFailed && hasPriorityLink ? <Notice variant="warning">…
//
// yields `hasPriorityLink`, which is not a failed-read name, so the notice was
// never classified at all — not counted, not ratcheted, not checkable. PROVEN by
// deleting the `announce` from that exact line (`features/strategy/
// StrategyDetailPage.tsx:926`, the SPU-6 disclosure THIS PR added) and watching
// the extended gate stay green with every number unchanged. The extension could
// not protect the fix it shipped alongside.
//
// Shape 2 reads the whole trailing `&&` chain instead, and the flag may sit at
// ANY position in it. It is a strict widening of shape 0 (which already accepts
// a single trailing operand) and is anchored the same way, so it cannot reach
// backwards into unrelated code.
const GATE_SHAPES = [
  //  {flag ? (        {flag && (
  /([A-Za-z_$][\w$]*)\s*(?:\?|&&)\s*\(?\s*$/,
  //  if (flag) return (        if (flag) { return (        if (flag) return <
  /\bif\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{?\s*return\s*\(?\s*$/,
  //  {a && flagFailed && b ? (      {!loading && flagFailed && (
  /(!?\s*[A-Za-z_$][\w$]*(?:\s*&&\s*!?\s*[A-Za-z_$][\w$]*)+)\s*(?:\?|&&)\s*\(?\s*$/,
];
/** Does this identifier NAME a failed read? Case-insensitive suffix — hole 2. */
const isFailedReadFlag = (n) => /(?:failed|unavailable|stale|error)$/i.test(n);
/**
 * The flag this notice is gated on plus WHICH shape matched, or `null`.
 *
 * The shape index is not decoration: it is what makes each new capability
 * independently observable below. A single "did the extension match anything"
 * floor turned out to be INERT — breaking it also breaks the legacy detection
 * (both go through this function), so the stale-allowlist check always fired
 * first and the floor could never be the guard that caught anything. Counting
 * per shape fixes that: the early-return shape can be broken while the ternary
 * shape still works, and the floor for it then fires on its own.
 *
 * Shapes 0/1 capture exactly one identifier; shape 2 captures a `&&` chain, so
 * the capture is split and EVERY operand is tested. Deliberately NOT "scan every
 * identifier in the 60-character window": that window contains whatever code
 * happens to precede the element, so an unrelated `somethingFailed` two lines up
 * would attribute a gate that does not exist. The chain is anchored to the
 * operator the notice is actually gated on.
 */
function failedReadGate(gate) {
  for (let i = 0; i < GATE_SHAPES.length; i += 1) {
    const captured = GATE_SHAPES[i].exec(gate)?.[1];
    if (!captured) continue;
    const flag = captured
      .split(/\s*&&\s*/)
      .map((operand) => operand.trim())
      // A NEGATED operand is the opposite claim. `{!capsFailed && !saml && !scim ? (`
      // renders BECAUSE the read succeeded — it is static informational copy, not a
      // failure disclosure, and treating it as one was a MEASURED false positive
      // (`features/users/SsoPanel.tsx:118`) in the first cut of this shape.
      .filter((operand) => !operand.startsWith('!'))
      .find(isFailedReadFlag);
    if (flag) return { flag, shape: i };
  }
  return null;
}

/**
 * Strip comments while PRESERVING newline counts, so reported line numbers stay
 * true. Deleting a multi-line comment body outright shifts every line below it —
 * my first cut of this scan reported an import line as a finding. The counts
 * were right and the locations silently wrong, which is worse, because a wrong
 * location still reads like a real finding.
 */
const blank = (m) => '\n'.repeat((m.match(/\n/g) ?? []).length);
const stripComments = (src) =>
  src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .split('\n')
    .map((l) => (l.trimStart().startsWith('//') || l.trimStart().startsWith('*') ? '' : l))
    .join('\n');

/** Extent of a JSX opening tag — depth-tracked and quote-aware, not a regex. */
function tagExtent(src, i) {
  let depth = 0;
  let q = null;
  for (let j = i; j < src.length; j += 1) {
    const c = src[j];
    if (q) {
      if (c === q && src[j - 1] !== '\\') q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (c === '>' && depth === 0) return src.slice(i, j + 1);
  }
  return src.slice(i);
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/**
 * The criterion EXACTLY as it stood before ADR 0598, kept executable rather than
 * described. Every hit is classified against it, so the pre-existing ratchet
 * (`silentReads`, baseline 0) keeps its meaning to the character while the newly
 * visible population is counted separately and cannot launder it.
 */
const LEGACY_VARIANT = /variant\s*=\s*"(warning|info)"/;
const LEGACY_GATE = /\b\w*(?:Failed|Unavailable|Stale)\b\s*(?:\?|&&)\s*\(?\s*$|\b\w*Error\b\s*(?:\?|&&)\s*\(?\s*$/;

/** The (file, flag) key separator, written as an ESCAPE on purpose: a RAW
 *  control byte in source makes the whole file read as "binary data" to grep,
 *  which then silently returns NOTHING for every pattern — it looks like the
 *  code is missing. Introduced by §Correction 7 and caught here. */
const SITE_SEP = '\u0000';
const silent = [];          // rule 1 — success notices
const silentReads = [];     // rule 2 — failed-read disclosures the old criterion saw
const silentReadsNew = [];  // rule 2 — the three shapes ADR 0598 made visible
/** (file, flag) -> how many SILENT disclosures live there right now. The
 *  identity half of the ADR 0598 ratchet — see §Correction 7. */
const newSiteCounts = new Map();
/** Silent rule-2 sites that carry `id` — see §Correction 10 at the push site. */
const idCarrying = new Set();
let total = 0;
let totalReads = 0;
let totalReadsNew = 0;
// Per-CAPABILITY counters, so each of the three new shapes has a floor that can
// fire on its own (see `failedReadGate`).
let earlyReturnHits = 0;   // shape 1 — `if (flag) return <Notice…>`
let compoundGateHits = 0;  // shape 2 — `{a && flagFailed ? …` (ADR 0598 §Correction 2)
let errorVariantHits = 0;  // the widened variant set
let lowercaseFlagHits = 0; // a flag the case-SENSITIVE suffix test would have missed


for (const file of walk(SRC)) {
  const rel = relative(SRC, file).split(sep).join('/');
  // Test files carry deliberate fixtures — including a Notice with NO announce,
  // which exists precisely to prove the silent case still renders. Scanning them
  // would make this gate measure its own fixtures.
  if (rel.includes('__tests__')) continue;

  const src = stripComments(readFileSync(file, 'utf8'));
  const re = /<Notice[\s/>]/g;
  let m;
  while ((m = re.exec(src))) {
    const tag = tagExtent(src, m.index);
    const announces = /\sannounce\s*[:=]/.test(tag);
    const line = src.slice(0, m.index).split('\n').length;

    if (/variant\s*=\s*"success"/.test(tag)) {
      total += 1;
      if (announces) continue;
      if (silentAllowed.has(`success:${rel}`)) continue;
      silent.push(`${rel}:${line}`);
      continue;
    }

    // RULE 2 — is this warning/info/ERROR notice GATED on a failed-read flag? Read
    // the text immediately before the element, which is where the gate lives:
    //   {somethingFailed ? <Notice variant="warning">…
    //   if (failed) return <Notice variant="error">…
    //
    // HOLE 3, closed by ADR 0598: `error` used to be excluded here outright, on
    // the premise that `role="alert"` announces on insertion. `ui/Notice.tsx:19-22`
    // says the opposite in as many words — "that is NOT verified here and MUST NOT
    // be treated as established — assuming it is exactly the mistake that shipped
    // #2615" — so the exclusion rested on the one assumption the component's own
    // docblock forbids. A failed READ is the case where it matters most: the user
    // is looking at an incomplete answer, and silence reads as "nothing to report".
    //
    // The criterion stays NARROW in the way that matters: only notices gated on a
    // failed-read FLAG. An error notice rendering a caught exception message
    // (`{error ? <Notice>` where `error` holds a save failure) is caught too, and
    // that is intended — it is the same "this did not work" disclosure.
    if (!/variant\s*=\s*"(warning|info|error)"/.test(tag)) continue;
    const gate = src.slice(Math.max(0, m.index - 60), m.index);
    // The flag NAME is the exemption key — see the note on `silentAllowed`.
    const hit = failedReadGate(gate);
    if (!hit) continue;
    const { flag, shape } = hit;
    if (shape === 1) earlyReturnHits += 1;
    if (shape === 2) compoundGateHits += 1;
    if (/variant\s*=\s*"error"/.test(tag)) errorVariantHits += 1;
    if (!/(?:Failed|Unavailable|Stale|Error)$/.test(flag)) lowercaseFlagHits += 1;
    const legacy = LEGACY_VARIANT.test(tag) && LEGACY_GATE.test(gate);
    if (legacy) totalReads += 1; else totalReadsNew += 1;
    if (announces) continue;
    const key = `failed-read:${rel}:${flag}`;
    if (silentAllowed.has(key)) { allowlistHits.add(key); continue; }
    // ADR 0598 §Correction 10 — a notice carrying `id` CANNOT take the remedy
    // this gate prescribes: `ui/Notice.tsx` makes `announce` and `id` mutually
    // exclusive BY TYPE (an `id` means a control points `aria-describedby` at
    // it, so announcing too would speak it twice). "Pass `announce`" would not
    // compile, and a remedy that does not compile trains people to edit the
    // allowlist. Recorded per site so the message can say the true thing.
    // MEASURED: 4 live `id`-carrying notices, none failure-gated — latent, not
    // live, which is exactly when it is cheap to close.
    if (/\sid\s*=/.test(tag)) idCarrying.add(`${rel}:${line}`);
    if (legacy) { silentReads.push(`${rel}:${line} (gated on \`${flag}\`)`); continue; }
    const site = `${rel}${SITE_SEP}${flag}`;
    newSiteCounts.set(site, (newSiteCounts.get(site) ?? 0) + 1);
    silentReadsNew.push(`${rel}:${line} (gated on \`${flag}\`)`);
  }
}

// A stale exemption is worse than none: it reads as a reviewed decision while
// exempting nothing, and the next person inherits a list they cannot trust. An
// entry that matches no live notice is an ERROR, not a warning — either the
// defect was fixed (delete the line) or the flag was renamed (re-review it).
// ONLY against the real tree. `OPENWOP_GATE_SRC` points this script at a fixture
// directory for its own self-test (`scripts/__tests__/gates.test.ts`), where none
// of the allowlisted files exist — so every entry would read as stale and the gate
// would exit(1) before reaching the behaviour under test.
//
// This is not hypothetical caution: adding the check without this guard broke all
// six of that suite's cases, which is the SAME mistake as #3106 (a new gate whose
// own harness was never updated) committed 24 hours after writing the postmortem.
const scanningRealTree = !process.env.OPENWOP_GATE_SRC;
// ── VACUITY GUARDS (ADR 0598 §4.4, corrected by §Correction 8) ───────────────
//
// One per new capability, because the new shapes have no allowlist to keep them
// honest and no small population to eyeball. A broken regex here would report a
// comfortable number and read as a clean codebase; these floors are the only
// thing that turns that into a red.
//
// TWO THINGS §4.4 GOT WRONG, and they are the same defect §4.4 records fixing.
//
// 1. THE FLOORS RAN LAST, AFTER every content check had already exited. So the
//    floor written for a capability could never be the guard that FIRED when
//    that capability broke — a stale-allowlist, cohort or baseline breach always
//    got there first. MEASURED: making `isFailedReadFlag` case-SENSITIVE again
//    (the realistic drift) collapses `errorVariantHits` 204 -> 45 AND changes
//    which flag a compound gate is attributed to, so the run died on the COHORT
//    check naming `featureToggles/FeatureTogglePanel.tsx (gated on
//    `consoleFailed`)`. §4.4's own evidence table prints that mismatch — "flag
//    test made case-SENSITIVE again -> the widened variant="error" set matched
//    45" — and reads it as success. A vacuity guard must run BEFORE the checks
//    whose numbers it certifies; that is what "vacuity guard" means.
//
// 2. THEY SHORT-CIRCUITED. `for (…) { if (breach) exit }` reports ONE breach and
//    hides the rest, so a drift that broke three capabilities was diagnosed as
//    one. All floors are evaluated and every breach is printed.
//
// FLOORS, not exact counts: they must not need editing when a feature is cleaned
// up, only when the capability itself stops working.
//
// MEASURED ON THE SHIPPED TREE by instrumenting THIS script, not estimated —
// §4.4 replaced three invented numbers with three more that were never measured
// against the tree that shipped (it claimed 9 / 205 / 165; the real figures at
// that commit were 9 / 204 / 164, and the compound shape did not exist yet).
// TODAY, printed by the script itself on every green run so it cannot drift
// again: early-return **9**, compound **3**, error-variant **206**,
// lowercase-flag **165**. (The +2 / +1 over §Correction 2's re-measurement is
// exactly the two sites shape 2 made visible — which corroborates 204/164.)
const FLOORS = [
  ['the early-return shape (`if (flag) return <Notice…>`)', earlyReturnHits, 3],
  ['the compound-gate shape (`{a && flagFailed ? <Notice…>`)', compoundGateHits, 1],
  ['the widened `variant="error"` set', errorVariantHits, 60],
  ['the case-insensitive flag-name test (a flag named `failed`)', lowercaseFlagHits, 40],
];
const breached = scanningRealTree ? FLOORS.filter(([, got, floor]) => got < floor) : [];
if (breached.length > 0) {
  console.error(`✗ check-notice-announce: ${breached.length} of ${FLOORS.length} detection capabilities drifted — they are asserting nothing while every total below looks healthy:`);
  for (const [what, got, floor] of breached) {
    console.error(`    ${what} matched ${got} notice(s) across the real tree (floor ${floor})`);
  }
  console.error('  Reported BEFORE the content checks and ALL AT ONCE, on purpose: a broken detector');
  console.error('  makes every number below it meaningless, and one break can disable several shapes.');
  process.exit(1);
}

const staleAllow = !scanningRealTree ? [] : EXPECTED_SILENT
  .filter(([, rule]) => rule === 'failed-read')
  .map(([f, rule, flag]) => `${rule}:${f}:${flag}`)
  .filter((k) => !allowlistHits.has(k));
if (staleAllow.length > 0) {
  console.error(`✗ check-notice-announce: ${staleAllow.length} EXPECTED_SILENT entr(ies) match no live notice:`);
  for (const k of staleAllow) console.error(`    ${k}`);
  console.error('  Either the disclosure now announces (delete the entry) or its flag was renamed');
  console.error('  (re-review the exemption — a rename is exactly when the reasoning should be re-read).');
  process.exit(1);
}

/**
 * THE ADR 0598 COHORT — a SECOND ratchet, deliberately not folded into the one
 * below.
 *
 * Teaching rule 2 to see `variant="error"`, the early-return shape and a flag
 * named `failed` — and, per ADR 0598 §Correction 2, a compound `&&` gate whose
 * failed-read flag is not the adjacent operand — surfaced 192 silent disclosures
 * across 153 files that had been invisible since they were written. (190/152
 * before §Correction 2; the fourth shape added two sites in two files, one of
 * them already listed, and the set was RE-DERIVED in the same commit as the
 * number — a moved baseline with a stale identity set is the swap this ratchet
 * exists to make impossible.) They are NOT audited, merely pre-existing,
 * and they belong to 60-odd other features whose own grade passes will reach
 * them; closing them inside a strategy PR would have hidden the count inside an
 * unrelated change. So the number is MEASURED, ENUMERATED and LEFT OPEN — the
 * precedent PR-A set for the 44 notify nodes it did not fix.
 *
 * WHY COUNTS AND NOT THE REASONED ALLOWLIST this file argues for everywhere
 * else: that argument ("naming each exception costs a line") rests on the
 * population being small enough that a human wrote each entry with a reason. At
 * 192 it is not, and 192 fabricated reasons would be worse than none — a list
 * that reads as reviewed and is not.
 *
 * WHY (file, FLAG) AND NOT A FILE SET (ADR 0598 §Correction 7). This shipped as
 * a global count plus a `Set<file>`, and that pair is a 153-FILE-WIDE SLOT — the
 * exact failure the docblock at the top of this file argues against, reintroduced
 * 192 wide. PROVEN: wiring `announce` onto one cohort file's disclosure and
 * adding a brand-new silent one in the SAME file left the count at 192 and the
 * file set unchanged, and the gate printed a tick. Keying on (file, flag) with a
 * per-site COUNT narrows the slot from 153 files to one flag's count in one file,
 * for the same enumeration effort and no fabricated reasons. What it still cannot
 * see — a swap within ONE (file, flag) pair — is named in the cohort module
 * rather than implied.
 *
 * A STALE ROW IS AN ERROR, symmetric with `staleAllow` above: a row matching no
 * live silent notice reads as covering something and covers nothing.
 *
 * Lower these as features are cleaned; never raise them.
 */
// In FIXTURE mode the cohort is meaningless (none of those files exist), so the
// baseline drops to 0 — that is what lets `scripts/__tests__/gates.test.ts` drive
// the real script through these three shapes and see it FAIL. A check that only
// runs against the real tree cannot be tested, and an untested gate extension is
// the thing this whole exercise is about.
const NEW_BASELINE = readGateBaseline(
  'check-notice-announce',
  'OPENWOP_SILENT_READ_NOTICE_BASELINE_0598',
  // 192 → 191: ADR 0601 / NBU-2 replaced notebooks' single shared, un-announced
  // `<Notice variant="error">` with per-panel `StateCard announce` failures. The
  // cohort row was DELETED, not lowered, so the ratchet tightens with it.
  //
  // 191 → 189: ADR 0605 Tier 6 (`KSU-10`) did the same for knowledge-sync's two
  // rows (`loadError`, `connectionsError`) — both Notices now pass `announce`.
  // Lowering this is the OTHER HALF of deleting those rows, and it is the half
  // that is easy to skip: with the rows gone the scan reports 189 and a baseline
  // of 191 still PASSES, so the gate would have silently carried two units of
  // slack — room for two new unannounced Notices to land green. This file says
  // "DELETE or LOWER its rows here AND lower the gate's baseline" (`:40`) for
  // exactly that reason. Measured after the deletion: 189 unannounced.
  //
  // 189 → 188: ADR 0608 Tier 5 (`CPU-10` slice) wired `announce` onto
  // `features/projects/ProjectMembersTab.tsx`'s `error` Notice — the one that
  // reports a failed member add/remove AND a failed visibility write, i.e. the
  // scope-narrowing control. Row DELETED, baseline lowered with it, per `:40`.
  //
  // 188 → 187: AST-UX-3 (grade-ux) wired `announce` onto `notifications/
  // ApprovalsInbox.tsx`'s `error` Notice + its new failed-first-load StateCard.
  // Cohort row DELETED, baseline lowered with it (the OTHER HALF), per `:40`.
  //
  // 187 → 186: ORGINV-UX-7(a) (grade-ux, feature loop 2026-09 it.2) wired
  // `announce` onto `orgs/InvitesSection.tsx`'s `error` Notice — the inviter's
  // create/revoke failure disclosure. Row DELETED, baseline lowered, per `:40`.
  //
  // 186 → 183: PROF-UX-11 / PROF-UX-15 (grade-ux, feature loop 2026-09 it.3).
  // `features/profiles/TeamPage.tsx` DROPPED its raw-`err.message` error Notice
  // (the announced failed-read StateCard was already there — one channel), and
  // `features/profiles/ProfileWorkflowsTab.tsx` + `agents/AgentWorkspacePage.tsx`
  // wired `announce` onto their `error` Notices (assign/unassign + pin/unpin
  // failures). Three rows DELETED, baseline lowered with them, per `:40`.
  // Measured after the deletion: 183 unannounced.
  //
  // 183 → 182: CRM-UX-16 (grade-ux, feature loop 2026-09 it.4) wired `announce`
  // onto `features/crm/ReportsTab.tsx`'s `error` Notice (a failed reports load
  // was silent to assistive tech). Row DELETED, baseline lowered with it, per
  // `:40`. Measured after the deletion: 182 unannounced.
  //
  // 182 → 179 (2026-09-03): CRM-UX-14 residue (feature loop 2026-09 it.4
  // fix-up). `features/crm/BookingTab.tsx` + `SignTab.tsx` DROPPED their
  // raw-`e.message` error Notices (each already rendered the announced
  // failed-read StateCard beside it — one channel, now with Retry), and
  // `GmailSyncTab.tsx` replaced its error Notice with that same card. Three
  // rows DELETED, baseline lowered with them, per `:40`. Measured after the
  // deletion: 179 unannounced.
  //
  // 179 → 176 (2026-09-03): KB-UX-9 (grade-ux, feature loop 2026-09 it.5) wired
  // `announce` onto the three un-announced disclosures on the Knowledge Base's
  // two sibling panels — `knowledge/SubjectKnowledgePanel.tsx`'s `error` Notice
  // (which reports BOTH the failed knowledge read and a failed attach/detach)
  // and `features/agent-knowledge/AgentKnowledgePanel.tsx`'s `error` and
  // `orgsFailed` Notices. Each announces a `t()` sentence, not the raw
  // `err.message` it renders — `ui/Notice.tsx` documents the string parameter as
  // existing to keep server prose out of the live region. Three rows DELETED,
  // baseline lowered with them, per `:40`. Measured after the deletion: 176
  // unannounced.
  //
  // 176 → 175 (2026-09-09): SHUX-9 (grade-ux, feature loop 2026-09 it.6) wired
  // `announce` onto `features/sharing/SharedQuoteView.tsx`'s `error` Notice — the
  // failure half of a PUBLIC, anonymous, transactional surface whose SUCCESS was
  // already announced, so a screen-reader user who pressed Accept and failed got
  // nothing at all. Row DELETED, baseline lowered with it (the other half, per
  // `:40`). Measured after the deletion: 175 unannounced.
  //
  // 175 → 174 (2026-09-10): ANL-UX-6 (grade-ux, feature loop 2026-09 it.9) wired
  // `announce` onto `features/analytics/AnalyticsPage.tsx`'s summary-failure
  // `error` Notice — it used to speak the RAW client message via role=alert while
  // the scoped StateCard beside it spoke politely (one failure, two voices); it now
  // speaks the localized `loadFailed` headline. Row DELETED, baseline lowered with
  // it, per `:40`. Measured after the deletion: 174 unannounced.
  //
  // 174 → 173 (2026-09-10): EM-UX-26 (grade-ux, feature loop 2026-09 it.10, ADR
  // 0654 D10) wired `announce` onto `features/email/EmailPage.tsx`'s page-level
  // `error` Notice — it speaks the localized `loadFailedTitle` headline, never the
  // raw client message, and now carries the EM-UX-7 Retry. Row DELETED, baseline
  // lowered with it, per `:40`. Measured after the deletion: 173 unannounced.
  //
  // 173 → 172 (2026-09-20): the Progress screen now renders its failed read as
  // an announcing StateCard with a working Retry action. The old silent error
  // Notice and its cohort row are gone, so the measured ceiling falls with it.
  scanningRealTree ? 172 : 0,
);
/** (file, flag) -> the recorded ceiling. */
const NEW_COHORT = new Map(LEGACY_SILENT_READ_SITES.map(([f, flag, n]) => [`${f}${SITE_SEP}${flag}`, n]));
const showSite = (k) => { const [f, flag] = k.split(SITE_SEP); return `${f} (gated on \`${flag}\`)`; };

/**
 * ADR 0598 §Correction 10 — say the TRUE remedy when `announce` is not available.
 *
 * `ui/Notice.tsx` makes `announce` and `id` mutually exclusive by TYPE, so for an
 * `id`-carrying notice the standard "Pass `announce`" instruction does not
 * compile. A gate whose prescribed cure is impossible is worse than one that says
 * nothing: it reads as actionable and the cheapest way out is the allowlist.
 */
function explainIdCarrying() {
  if (idCarrying.size === 0) return;
  console.error(`  NOTE — ${idCarrying.size} of these carr${idCarrying.size === 1 ? 'ies' : 'y'} an \`id\`, and \`ui/Notice.tsx\` makes \`announce\` and \`id\``);
  console.error('  mutually exclusive BY TYPE, so "pass `announce`" will NOT compile there:');
  for (const s of idCarrying) console.error(`    ${s}`);
  console.error('  For those: either the control already points `aria-describedby` at the notice (in which');
  console.error('  case a screen reader reads it on focus and it is genuinely exempt — add an EXPECTED_SILENT');
  console.error('  entry with THAT reason), or the `id` is unused and should be removed so `announce` is');
  console.error('  available. Do not reach for the allowlist because the obvious cure did not typecheck.');
}

// GROWTH at any site — a NEW (file, flag) pair, or more silent disclosures on an
// existing one than were recorded. Either is a regression the global count can
// absorb, which is the whole reason this half exists.
const grewNew = scanningRealTree
  ? [...newSiteCounts].filter(([k, n]) => n > (NEW_COHORT.get(k) ?? 0))
  : [];
if (grewNew.length > 0) {
  console.error(`✗ check-notice-announce: ${grewNew.length} site(s) carry MORE silent failure disclosures (ADR 0598 rule-2 shapes) than the recorded cohort:`);
  for (const [k, n] of grewNew) console.error(`    ${showSite(k)} — ${n}, recorded ${NEW_COHORT.get(k) ?? 0}`);
  console.error('  These say "this did not work" / "we could not get this data". `role="alert"` is NOT a licence to');
  console.error('  stay silent — `ui/Notice.tsx:19-22` says that behaviour is unverified here and must not be assumed.');
  console.error('  Pass `announce` with the text to speak. Do NOT raise a row in notice-announce-0598-cohort.mjs.');
  explainIdCarrying();
  process.exit(1);
}

// STALE rows — symmetric with `staleAllow` above, which the cohort half shipped
// without. A row that matches no live silent notice reads as covering something
// and covers nothing; the next person inherits a list they cannot trust. A row
// whose live count merely FELL is progress, so it is reported and not fatal.
if (scanningRealTree) {
  const stale = [...NEW_COHORT.keys()].filter((k) => !newSiteCounts.has(k));
  if (stale.length > 0) {
    console.error(`✗ check-notice-announce: ${stale.length} cohort row(s) in notice-announce-0598-cohort.mjs match no live silent notice:`);
    for (const k of stale) console.error(`    ${showSite(k)}`);
    console.error('  Either the disclosure now announces (DELETE the row and lower the baseline — that is the');
    console.error('  gain being locked in) or its flag was renamed (update the row; a rename is exactly when');
    console.error('  the entry should be re-read).');
    process.exit(1);
  }
  const shrunk = [...newSiteCounts].filter(([k, n]) => n < (NEW_COHORT.get(k) ?? 0));
  for (const [k, n] of shrunk) console.log(`  (down: ${showSite(k)} now ${n}, recorded ${NEW_COHORT.get(k)} — lower the row.)`);
}
if (silentReadsNew.length > NEW_BASELINE) {
  console.error(
    `✗ check-notice-announce: ${silentReadsNew.length} failure disclosure(s) in the ADR 0598 shapes never reach `
    + `assistive tech (baseline ${NEW_BASELINE}). You ADDED ${silentReadsNew.length - NEW_BASELINE}.`,
  );
  for (const s of silentReadsNew) console.error(`    ${s}`);
  explainIdCarrying();
  process.exit(1);
}

if (silentReads.length > BASELINE) {
  console.error(
    `✗ check-notice-announce: ${silentReads.length} failed-read disclosure(s) never reach assistive tech `
    + `(baseline ${BASELINE}). You ADDED ${silentReads.length - BASELINE}.`,
  );
  for (const s of silentReads) console.error(`    ${s}`);
  console.error('  These say "we could not get this data" — a screen-reader user who never hears one is');
  console.error('  shown an incomplete answer. Pass `announce`, or add a `failed-read` EXPECTED_SILENT');
  console.error('  entry WITH the reason (the only accepted one so far: a SECOND failed-read notice on a');
  console.error('  page where one already announces — they co-occur, and the polite slot holds one).');
  explainIdCarrying();
  process.exit(1);
}

if (silent.length > BASELINE) {
  console.error(
    `✗ check-notice-announce: ${silent.length} success Notice(s) report a completed action without announcing it `
    + `(baseline ${BASELINE}). You ADDED ${silent.length - BASELINE}.`,
  );
  for (const s of silent) console.error(`    ${s}`);
  console.error('  Pass `announce` with the text to speak. If it renders from a STATE rather than an');
  console.error('  action, add it to EXPECTED_SILENT in this file WITH the reason — do not raise a number.');
  process.exit(1);
}

console.log(
  `✓ check-notice-announce: ${total} success Notices (${silent.length} unannounced) + `
  + `${totalReads} failed-read disclosures (${silentReads.length} unannounced) + `
  + `${totalReadsNew} in the ADR 0598 shapes (${silentReadsNew.length} unannounced, `
  + `baseline ${NEW_BASELINE}, cohort ${NEW_COHORT.size} (file, flag) sites), `
  + `baseline ${BASELINE}, ${EXPECTED_SILENT.length} deliberate skips named.`,
);
// ADR 0598 §Correction 8 — PRINT the vacuity numbers on a green run. §4.4 twice
// wrote floor justifications from figures that were never measured against the
// tree that shipped (three invented, then three off-by-one). A number the script
// reports every run cannot drift from the tree, and the next person choosing a
// floor reads it instead of guessing.
if (scanningRealTree) {
  console.log(`  (detection: ${FLOORS.map(([what, got, floor]) => `${what.replace(/ \(.*/, '')} ${got}/floor ${floor}`).join('; ')})`);
}
