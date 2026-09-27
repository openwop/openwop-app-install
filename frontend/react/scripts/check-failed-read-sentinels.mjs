#!/usr/bin/env node
/**
 * Failed-read sentinel RATCHET gate.
 *
 * THE DEFECT CLASS. A read rejects, the catch writes an EMPTY value, and the
 * render — which cannot tell "the server said none" from "we never heard back" —
 * makes a confident claim:
 *
 *     listOrgs().catch(() => setOrgs([]))      -> "No organizations — create one first"
 *     listPayoutRuns().catch(() => setRuns([])) -> "No payout runs yet."
 *     listAudit().catch(() => setRows([]))      -> "No audited actions match"
 *
 * Roughly twenty of these have been fixed across the admin and workspace
 * surfaces. Each fix is a per-page test; the tests protect the pages someone has
 * already audited and say nothing about the ones nobody has opened yet. This
 * gate covers the tail: it counts the raw shape and fails if the count goes UP.
 *
 * WHY A COUNT AND NOT A SEMANTIC CHECK. The defect is only a defect when the
 * empty branch makes an INSTRUCTIVE claim ("create one first") rather than a
 * neutral one. That distinction is a judgement about copy — `noBoardsBody`
 * instructs, `dlqEmpty` mostly does not — and is not statically decidable. A
 * guard that tried would be a guard nobody could trust. So this one asserts only
 * what it can actually see: THE SHAPE DOES NOT SPREAD. Every genuine fix lowers
 * the baseline; the violation set can only shrink. Same contract as
 * `check-spacing-literals.mjs`, deliberately.
 *
 * WHAT IT DOES NOT CLAIM — read this before trusting a green run.
 *
 * 1. A file inside the baseline is not "audited" or "safe", merely pre-existing.
 *    Green means no NEW instance joined the tail; it is not evidence any page is
 *    honest.
 * 2. TWO further syntaxes are KNOWN to be uncounted, deliberately:
 *      - brace form   `.catch(() => { setX([]); ... })`      (66 occurrences)
 *      - await form   `try { ... } catch { setX([]); }`      (54 occurrences)
 *    Both are excluded because the majority of them ALSO set an error alongside,
 *    which is the CORRECT shape — counting them would flag correct code, the
 *    baseline would never meaningfully shrink, and the gate would train people to
 *    ignore it. Narrowing to what can be judged without reading the surrounding
 *    render is the deliberate trade.
 *
 *    Those two figures are MEASURED, through the same `stripComments` used
 *    below, and they replace an earlier "~61 / ~14" that was neither. The await
 *    figure was wrong by nearly 4x, which is worth stating plainly: this section
 *    exists to bound what the gate does not cover, so a number invented here is
 *    a worse defect than the same number invented anywhere else in the file.
 *
 * 3. A THIRD SHAPE is uncounted, and unlike the two above it is not a syntax
 *    variant of the same statement — it is a different MECHANISM, which is why
 *    it went unnoticed until 2026-08-10:
 *
 *      const [rows, setRows] = useState<T[] | null>(null);
 *      …fetch().catch(() => setError(msg));     // rows STAYS null — correct so far
 *      const visible = (rows ?? []).filter(…);  // the empty is minted HERE
 *      <DataTable rows={visible} empty={<StateCard title="No usage recorded yet."/>} />
 *
 *    Nothing is written into state by the catch, so every grep in this file —
 *    all of which look at the catch — is structurally blind to it. The empty
 *    array is manufactured at RENDER by a `?? []` coalesce, and the confident
 *    claim is made by a table's `empty` slot the failure branch never suppressed.
 *    Found in `features/usage-analytics/UsageDashboardPage.tsx` (fixed there):
 *    a failed cost read printed "No usage recorded yet.", which on a spend
 *    dashboard is the difference between "you spent nothing" and "we do not know
 *    what you spent".
 *
 *    AUDITED IN FULL 2026-08-10 — this replaces an earlier "a sample of 8 found 7
 *    correct", which was a bounded suspicion, not a measurement. Population: 61
 *    files under `src/features` holding a nullable list state AND an error state
 *    AND a `?? []`. Every one was triaged; the 9 carrying the original defect's
 *    exact shape (an error rendered as a SIBLING `{error && <Notice>}` while the
 *    list renders anyway) had their render paths READ, not grepped.
 *
 *    RESULT: 2 real, 59 correct.
 *      - `kicktodo-studio/CreatorInsightsPage.tsx` — "Nothing accrued yet" on a
 *        FAILED earnings read (money).
 *      - `model-router/ModelRouterPage.tsx` — "No rules — every turn uses the
 *        fallback target" on an unreadable config (routing behaviour).
 *    Both fixed in the same pass. The other 59 independently converged on
 *    `{items && items.length === 0 && !failed && …}`, which is now written down
 *    on `ui/StateCard.tsx` — the component every author opens when adding an
 *    empty state.
 *
 *    STILL NOT GATED, and now for a MEASURED reason rather than a cautious one.
 *    The triage heuristic — "sibling error Notice + an empty claim with no
 *    `!error`" — flagged 6 files and 4 were FALSE POSITIVES: a ~44% noise rate,
 *    on the very shape a gate would have to encode. The cause is structural, not
 *    a weak regex: the failure flag has no canonical name (`error`, `loadFailed`,
 *    `orgsFailed`, `earningsFailed`, `decisionsFailed`, `linksFailed`, plus an
 *    `'error'` state-sentinel in `sharing/SharingPage.tsx`). A gate cannot know
 *    which of a file's booleans means "the read failed" — which is precisely the
 *    semantic judgement the "WHY A COUNT AND NOT A SEMANTIC CHECK" note above
 *    already refuses to attempt.
 *
 *    If you are reading this because you are about to build that gate: the 44%
 *    is the number to beat, and you cannot beat it by naming more flags — a new
 *    feature will invent a new one. Revisit only if a canonical failable-read
 *    primitive ever lands, which would make the shape expressible.
 *
 *    THE NUMERIC VARIANT WAS AUDITED 2026-08-11 AND IS CLEAN — 0 of 44. Recording
 *    the negative because it is load-bearing: it tells the next person not to
 *    re-run this, and it explains WHY the two variants differ.
 *
 *    Population: 44 files holding a nullable state + a failure flag + `?? 0`.
 *    Narrowed to the 15 whose coalesce reaches a RENDERED figure (a formatter
 *    call, a JSX interpolation, a `count:`/`value=` prop), plus 8 two-step
 *    `const n = x ?? 0` hits the first scan would have missed. Every one read.
 *    None can render a fabricated zero on a failed read.
 *
 *    THE STRUCTURAL REASON, which is the useful part: `?? []` frequently stands
 *    in for the WHOLE read — a list IS the response, so coalescing it substitutes
 *    for the request itself. `?? 0` almost never does. It defaults an OPTIONAL
 *    FIELD on an object that already loaded: tax that does not apply, a currency
 *    present in gross but absent in fees, an idea nobody scored, an enrollment
 *    not started. If the read failed, the containing object is null and the whole
 *    block is already gated out. The dangerous shape needs the coalesce to
 *    substitute for the READ, and numbers are usually fields OF a read.
 *
 *    So do not generalise "coalesce on a nullable read" into a rule. The rule is
 *    narrower: a coalesce that REPLACES the read's own absence.
 *
 * 4. A FOURTH catch shape, spotted during the 2026-08-11 numeric audit and NOT
 *    audited: `.catch(() => [])` returning an empty array as a RESOLVED VALUE,
 *    typically inside a `Promise.all`, rather than writing state —
 *
 *      const [a, b] = await Promise.all([readA(), readB().catch(() => [])]);
 *
 *    AUDITED 2026-08-11: 11 live occurrences in 11 files, 0 clear defects.
 *
 *    The first count published here said "20 across 20 files" and was wrong by
 *    ~45% — it counted TEST PROSE and COMMENTS. Eight were `__tests__` files
 *    documenting this defect being FIXED elsewhere, and one was a comment saying
 *    a `.catch(() => [])` would be wrong there. Comment-stripped and
 *    production-only it is 11. Recorded because this file's whole subject is
 *    counts that mislead, and the miscount happened while filing one.
 *
 *    All 11 sit on a SECONDARY read feeding labels, names or options, while the
 *    PRIMARY read stays unguarded and propagates. The rule to apply — already
 *    stated by a peer at `features/kicktodo/GuidePage.tsx:92` (KT-G2) — is that a
 *    per-item read may fail soft ("one unreadable circle should not void the
 *    count") but the LIST failing "means we know nothing at all".
 *
 *    Do not reflex-fix this shape. `chat/conversationTransport.ts:245` swallows an
 *    interrupt list to `[]` and is CORRECT: it is a polling loop with a deadline,
 *    so a transient failure means "not open yet", and aborting the wait would be
 *    the worse bug. Two picker cases are borderline and named as FRGATE-5.
 *
 * So this gate bounds ONE syntax of ONE mechanism — 103 of the 223 occurrences of
 * the three catch-shapes, i.e. UNDER HALF, and none of the render-time mechanism
 * in (3). Do not read a green run as "the class is contained"; that is precisely
 * the over-claim the class is about.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { readGateBaseline } from './gateBaseline.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, '..', 'src');

/** Lower this whenever a fix removes a sentinel; it must never be raised. */
// 100 → 81 → 71 → 69 → 52. The ratchet only means something if it TRACKS the real
// count: at 100 the gate tolerated 19 regressions before it would have said
// anything. (A peer measured 82 hours earlier; it reached 81 as more work
// merged — so this is the count at the commit that lowers it, not a round number.)
//
// The 71 → 69 step (2026-08-04) closed slack this gate CANNOT close itself: a
// peer fixed two sentinels and left the constant alone, because improving the
// count only prints an advisory note while regressing it fails the build. Left
// alone, that is two regressions the gate would have waved through. If this
// keeps happening, make an improvement fail too ("you improved — re-pin the
// baseline"); it was not done here because in a repo this size any PR that
// incidentally deletes a `.catch` would then go red for an unrelated reason.
// 49 → 47: ADR 0582 §6 removed two `err instanceof Error ? err.message : t(…)`
// sentinels from the CSM page when `csmClient` started throwing a typed error
// the page can map to localized copy (CSM-UX-3).
// ADR 0590 — 47 → 45: the priority-matrix batch converted two silent
// failed-read swallows (schedule tri-state, peers list) into stated failures.
// CLNP-2(d) — 44 → 43: the kanban assignee picker's `.catch(() => setMembers([]))`
// now keeps the previous list and renders a stated 'couldn't load members' option.
// Shrink-only: never raise this without the disclosure the header demands.
const BASELINE = readGateBaseline('check-failed-read-sentinels', 'OPENWOP_FAILED_READ_BASELINE', 43);

/**
 * TWO shapes are counted, both of which hand a render an empty value it cannot
 * distinguish from a real answer:
 *
 *   SET form     `.catch(() => setThing([]))`      — writes the sentinel directly
 *   RETURN form  `.catch(() => [])`                — feeds it into a .then/await
 *                                                    that writes it a line later
 *
 * The RETURN form was missed by the first cut of this gate and is NOT rarer:
 * `listChallenges().catch(() => [])` inside a `Promise.all` is the same defect
 * one level of indirection away, and two of the fixes that motivated this gate
 * (the catalog-health console, the feature-toggle console) were exactly it.
 */
const SENTINEL = /\.catch\(\s*\(\s*\)\s*=>\s*(?:set[A-Z][A-Za-z0-9_]*\(\s*(?:\[\]|null)\s*\)|\[\]|null)\s*\)/g;

/** Tests legitimately construct these shapes to sabotage-probe a fix. */
const isSkipped = (p) => p.includes('__tests__') || p.endsWith('.test.ts') || p.endsWith('.test.tsx');

/**
 * COMMENTS ARE NOT CODE, and getting this wrong made the gate actively harmful.
 *
 * The first cut matched raw file text, so a comment EXPLAINING the defect —
 * "`.catch(() => setOrgs([]))` rendered the 'No organizations' state" — counted
 * as an instance of it. That is backwards twice over. It reddened the build for
 * a peer whose commit REMOVED four of these and documented why, and the only
 * ways to get green were to delete the explanation or to raise the baseline.
 * A gate that taxes the comment describing a fix trains people to stop writing
 * the comment, and those comments are how two of the defects in this very class
 * were found in the first place.
 *
 * Stripping is deliberately conservative: block comments, whole-line comments,
 * and trailing `//` that isn't part of a `://` URL. A sentinel hidden in a
 * trailing comment after real code on the same line would still be counted —
 * vanishingly rare, and I would rather over-count in a way that is visible than
 * silently drop a real one.
 */
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
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full) && !isSkipped(full)) out.push(full);
  }
  return out;
}

const files = walk(SRC);

// VACUITY GUARD. A file-scanning gate that silently scans nothing looks exactly
// like a passing one. The floor is DERIVED, not a magic number: `src/features`
// alone is the bulk of the tree, so if the walk returns fewer files than that
// directory contains, the walk is broken regardless of what the count says.
const featureFiles = walk(join(SRC, 'features')).length;
if (files.length <= featureFiles) {
  console.error(`✗ check-failed-read-sentinels: walked ${files.length} files but src/features alone holds ${featureFiles} — the walk is broken, not the code clean.`);
  process.exit(1);
}

let count = 0;
const hits = [];
for (const f of files) {
  const src = stripComments(readFileSync(f, 'utf8'));
  const m = src.match(SENTINEL);
  if (m) {
    count += m.length;
    hits.push(`${relative(SRC, f)} (${m.length})`);
  }
}

if (count > BASELINE) {
  console.error(`✗ check-failed-read-sentinels: ${count} failed-read sentinels across ${files.length} files (baseline ${BASELINE}). You ADDED ${count - BASELINE}.`);
  console.error('  A `.catch(() => setX([]))` hands the render an empty value it cannot tell from a real answer.');
  console.error('  Give the failure its own state and let the empty branch mean only "the server said none".');
  console.error(`  Files: ${hits.slice(0, 12).join(', ')}${hits.length > 12 ? ` … +${hits.length - 12} more` : ''}`);
  process.exit(1);
}

const note = count < BASELINE ? ` — down ${BASELINE - count}; lower BASELINE to ${count} in this file.` : '';
console.log(`✓ check-failed-read-sentinels: ${count} failed-read sentinels across ${files.length} files (baseline ${BASELINE}, ratchet holds).${note}`);
