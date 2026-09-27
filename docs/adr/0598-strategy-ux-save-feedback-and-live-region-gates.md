# ADR 0598 — Strategy: a save that says it worked, a draft that survives, and two a11y gates that ran green over the defect

Status: implemented

Feature 26/71 ("Strategic Planning") of the grading loop. This ADR covers **PR-B**,
the UX half. PR-A (backend security + the cadence loop) is `aba554b8c` / ADR 0597.

Source: `docs/steward/UX-ASSESSMENT.md` § "Strategic Planning (feature 26/71)"
(`SPU-1`…`SPU-14`), graded at `aba4aa096`. Branched from `origin/main` @ `aba554b8c`.

---

## Context

The `/grade-ux` pass graded this feature **D** and gave a reason worth quoting,
because it is the shape of everything below: *the failed-read/honesty work here is
among the best in the repo*, and the findings are **the residue and the classes
those rounds did not sweep**. Three prior rounds (`STR-G1/G2`,
`STR2-B1/B2/B3/M1/M3/M5`, `R3-A/R3-B`) closed real "absence is a claim" defects.
What none of them touched was the other half of the conversation: whether anything
tells the user that what they *did* worked.

And the meta-finding, which is the reason two of the fourteen rows are repo-wide:
**the grader ran all three a11y gates against this feature and all three passed
green**, over a live defect each of them exists to catch. A green tick from a gate
that cannot see the shape is worse than no gate — it is a reviewed-looking claim
that nothing is wrong.

---

## Decision

Work in order of irreversibility, because a stale banner and a destroyed draft are
not the same kind of harm:

1. `SPU-3` — the stale error that appears for the first time **on success**.
2. `SPU-2` (+ `SPU-1`) — no save in the feature confirmed it worked, to anyone.
3. `SPU-4` — the tab switch that silently destroys the draft.
4. `SPU-1` + the two **gate blind spots** — fix the instrument, not just the site.
5. `SPC-15` — decide, and record the decision.
6. The remaining `SPU-*` rows.

---

## §1 — `SPU-3`: `setError(null)` appeared nowhere, so a SUCCESSFUL retry raised the banner

The harm is not "a banner lingers". While the list read is failing,
`error && !listFailed` **hides** the banner (the failure `StateCard` owns that
state). A **successful** retry flips `listFailed` false with `error` still set, so
the red Notice **mounts for the first time** over a correctly-loaded portfolio —
and because it carries `announce`, `ui/Notice.tsx:80` fires
`announce(msg, { assertive: true })`. A screen-reader user is interrupted to be
read a raw server error that is no longer true, as the reward for recovering.

**The existing spec could not see it, and the reason is instructive.**
`portfolioReads.test.tsx` used `mockRejectedValue` (permanent), so the retry failed
too and the success-after-failure state — the only state in which the defect
renders — was never reached. Its assertion was `listStrategies.mock.calls.length >
1`, **a call count, which cannot distinguish a successful retry from a failed one**.
Rewritten with `…Once`, a positive control (the portfolio row renders) and an
announcement **delta** rather than an absolute, so the module-global announcer
cannot make it order-dependent.

### The cure that would have reintroduced the family it closes

The obvious symmetric move is to clear `autoReverted` in `refresh()` too — the
finding names it as "also never cleared". **That would have destroyed the R2
STR2-M5 disclosure at the moment it is raised.** `ObjectivesEditor.save` calls
`onAutoReverted(...)` **immediately before** `await onChanged()`, and `onChanged`
*is* `refresh`. The warning would have been set and then wiped in the same tick.
It is cleared by the NEXT save instead (`onAutoReverted(… : null)`), which is the
only writer.

| Sabotage | Red |
|---|---|
| `setError(null)` dropped from `StrategyPage.refresh` | **1** — `list 500` renders over a loaded portfolio |
| `setError(null)` dropped from `StrategyDetailPage.refresh` | **1** |
| `autoReverted` clear reverted to `if (res.autoRevertedToDraft)` | **1** — the disclosure never clears |

---

## §2 — `SPU-2`: no save in this feature confirmed it worked, to anyone

Zero `toast.*`, zero success `<Notice>`, zero `announce(` across
`features/strategy/*.tsx` outside tests. Combined with `onChanged → refresh()`
remounting the editor via `key={strategy.updatedAt}` with identical values, **the
screen looked identical before and after a save**: "saved" and "the button did
nothing" were indistinguishable, and the natural response — click Save again — is
indistinguishable from the first attempt.

Eight save paths now call `toast.success`, which routes through `ui/toast.tsx:69`
→ `announce()`, so ONE call reaches the screen and assistive tech. Archive and
delete are included deliberately: they navigate away, so the row simply vanishes,
and the toast is the only thing separating "it worked" from "it silently failed".

**One message per save.** An auto-reverting objectives save raises
`autoRevertedNotice` ("Saved — but …") *instead of* a plain "Objectives saved":
two strings in the polite queue would mean the second and less informative one
describes the save.

### Finding taken, statistic corrected

The finding's support was *"88 of 98 directories under `features/` call
`toast.success`"*. **Not reproducible under any reading.** MEASURED on this tree:
**47 of 97** top-level feature dirs contain `toast.success`; **63** contain any
`toast.*`; **69** directories repo-wide at any depth. The FINDING reproduces
exactly — grep for any success signal in strategy returns **zero** — and
`toast.success` is still the shared primitive that announces. The claim is taken;
the number is corrected rather than repeated.

---

## §3 — `SPU-1`: a live region mounted with its text, and the gates that could not see it

`{result ? <span className="muted u-fs-12" role="status">{result}</span> : null}`
is the exact pattern `DESIGN.md:367-375` forbids. **Three failures in one:**

1. a **clean** import was entirely silent (the warning `<Notice>` that carries
   `announce` renders only when `skipped.length > 0`);
2. when rows WERE skipped, the announced string was the **count summary** and never
   the per-row **reasons** — the part the user has to act on;
3. a repeat import with identical counts left the Notice's `announce` prop
   unchanged, so `useEffect([announce, assertive])` never re-fired.

Cured with `announce()` per ACTION carrying the summary **and** every reason. The
dead role is **removed**, not duplicated — a container region plus a per-item role
for one message is the DS-8 double-announce.

---

## §4 — The two repo-wide gate blind spots

### 4.1 `check-live-regions.mjs` — the literal-attribute key

`role="status"` carries an **implicit** `aria-live="polite"` (ARIA 1.2 §status), so
it has the identical repeat defect this gate bounds; the gate keyed on the literal
attribute and could not see it. Matched **separately** from the explicit spelling
so the pre-existing population, its baseline and its four vacuity guards keep their
exact meaning; a tag carrying both spellings is attributed to the explicit matcher.
A **fifth vacuity guard** (a `role="status"` floor) was added, because guards 2–4
are all keyed on `aria-live="polite"` and could not protect the new half.

**PROOF.** Pre-fix span restored on the real tree:

| Gate | Result |
|---|---|
| ORIGINAL `check-live-regions.mjs` | `✓ … ratchet holds.` **EXIT=0** — green over the defect |
| EXTENDED | `✗ … features/strategy/StrategyDetailPage.tsx` **EXIT=1** |
| EXTENDED, post-fix | **EXIT=0** |

### 4.2 `check-notice-announce.mjs` — THREE holes, one more than the finding named

1. **The early-return shape.** `FAILED_READ_GATE` demanded `flag ? (` / `flag && (`,
   so `if (failed) return <Notice…>` was invisible **at every variant**, not just
   at `error`.
2. **A flag named exactly `failed`.** `\b\w*Failed\b` is case-SENSITIVE on the
   suffix, so `loadFailed` matched and a bare `failed` did not. **Two of
   strategy's three escapes were named exactly that.** This is not in the finding;
   it came from running the regex against the real flag names instead of
   re-reading the sentence about it.
3. **`variant="error"` excluded outright** — on the premise that `role="alert"`
   announces on insertion, which `ui/Notice.tsx:19-22` says in as many words is
   *"NOT verified here and MUST NOT be treated as established — assuming it is
   exactly the mistake that shipped #2615."* The exclusion rested on the one
   assumption the component's own docblock forbids.

The single regex is split into a SHAPE test and a NAME test, which is what makes
the three separable and independently testable.

**PROOF** (one fixture per hole, driven through the real script by
`scripts/__tests__/gates.test.ts`):

| Hole | ORIGINAL gate | EXTENDED gate | Once it announces |
|---|---|---|---|
| `variant="error"` gated on `loadFailed` | EXIT=0 | **EXIT=1** | EXIT=0 |
| `if (timelineFailed) return <Notice variant="warning">` | EXIT=0 | **EXIT=1** | EXIT=0 |
| a flag named `failed` | EXIT=0 | **EXIT=1** | EXIT=0 |

Plus two **over-fire controls** that must stay green: an error notice with no
failure gate (`isOverdue ? …`), and a look-alike identifier (`deferred`).

### 4.3 BLAST RADIUS — measured, enumerated, deliberately NOT fixed

> **CORRECTED — see §Correction 2 and §Correction 7.** The numbers below are
> superseded (**192** across **179 (file, flag) sites** in **153 files**), and the
> `Set<file>` this section argues for turned out to be a 153-file-wide SLOT — the
> failure this very section says it is avoiding.

| Gate | Newly visible | Where |
|---|---|---|
| `check-live-regions` | **5 files** | `builder/BuilderShell.tsx`, `builder/HistoryDrawer.tsx`, `builder/inspector/NodeConnections.tsx`, `chat/ChatInput.tsx`, `features/document-editor/DocumentToolbarExtras.tsx` |
| `check-notice-announce` | **190 silent disclosures across 152 files**, ~60 features | enumerated in `frontend/react/scripts/notice-announce-0598-cohort.mjs` |

Strategy's own hits (1 + 2) are fixed; the rest are left open, per PR-A's precedent
with the 44 title-only notify nodes: *fixing them inside a feature-26 PR would hide
the count inside an unrelated change.*

**Each gets its OWN baseline + identity set, not a raised existing one.** The
`check-live-regions` baseline is pinned "EXACTLY at the post-migration count, with
no slack — slack in a ratchet is silent capacity for regression"; absorbing five
newly-VISIBLE pre-existing sites by moving 1 → 6 would destroy what that number
means. Five newly-visible sites are not a migration.

**Why the 190 get a count + a FILE SET rather than the reasoned allowlist the
gate argues for everywhere else:** that argument ("naming each exception costs a
line") rests on the population being small enough that a human wrote each entry
with a reason. At 190 it is not, and **190 fabricated reasons would be worse than
none — a list that reads as reviewed and is not.** The count alone would be a
190-wide SLOT, which is the failure that file's own docblock warns about, so the
file set is pinned alongside it: a silent disclosure in a file not already carrying
one goes red immediately, even though the count did not move.

### 4.4 Two things the gate work got wrong first, and how

> **CORRECTED — see §Correction 8.** Both fixes here were incomplete. The
> per-capability floors ran LAST and short-circuited, so the floor written for a
> capability could never be the guard that fired; and the "measured" replacement
> numbers (`9 / 205 / 165`) were not measured against the shipped tree either
> (`9 / 204 / 164`). The script now PRINTS them on every green run.

**A guard that could never fire.** The first cut added a single vacuity floor —
"did the ADR 0598 shapes match anything?". It was **inert**: breaking the new-shape
detection also breaks the LEGACY detection (both go through the same function), so
the stale-allowlist check always fired first and the floor could never be the guard
that caught anything. Replaced with **per-capability** floors, which are
independently breakable. Each sabotage now produces a red naming a specific
capability:

| Sabotage | Red |
|---|---|
| early-return shape regex neutered | `the early-return shape … matched 0 notice(s) (floor 3)` |
| variant set narrowed back to `warning|info` | `the early-return shape … matched 1 notice(s) (floor 3)` |
| flag test made case-SENSITIVE again | `the widened variant="error" set matched 45 notice(s) (floor 60)` |

**Three invented numbers.** That same block first carried floors justified by
"measured on the real tree: early-return 20, error-variant 187, lowercase-flag 24".
**All three were made up.** Measured: **9 / 205 / 165**. The floors are now derived
from the real numbers, with the early-return one deliberately at 3 because 9 is
small enough that ordinary cleanup could move it.

**A gate importing a file nobody else has.** The 152-file cohort first landed at
`frontend/react/scripts/data/…`, which `.gitignore:28` (`data/`) swallows. `git
add` refused; without that refusal the gate would have shipped importing a
non-existent module for every other checkout.

---

## §5 — `SPU-4`: the tab switch that silently destroys the draft

Each tab body is `{tab === 'x' ? <Editor …/> : null}` and `useUrlTab` is a plain
`useSearchParams` write — no keep-alive, no dirty check, no confirm, no
`beforeunload`. A planner who types four objectives, eight key results and their
measurement config, clicks another tab to check an owner name, and comes back loses
all of it.

**ONE rule at ONE composition owner.** `leaveGuard()` lives on the page and is used
by BOTH ways off a mounted editor — the tablist and "Back to portfolio". Two
hand-written copies is what PR-A §2 fixed one file away. `ui/confirm.tsx` is the
mechanism; `window.confirm` stays banned. The keyboard lane needs nothing extra:
`rovingTabs` is *manual activation*, so arrows only move focus and activation goes
through each tab's own `onClick` → the guarded `onChange`.

**Dirtiness is VALUE equality, not "was touched".** Typing an edit and undoing it
must not prompt. Overview compares its twelve scalars exactly. Objectives compares
the objectives tree **and** `measureDrafts` — a SEPARATE state atom holding most of
the typing on that tab; comparing only the tree would report a fully-configured
measurement block as clean and discard it silently, i.e. the defect wearing a guard.

| Sabotage | Red |
|---|---|
| tablist unguarded (`onChange={setTab}`) | **3** — objectives / measures / alignment. A **blast radius**, and a deliberate pair-of-three so a fix covering one tab cannot pass |
| `onClick={leaveToPortfolio}` removed | 1 |
| objectives `dirty` pinned `true` | **2** — the two over-fire controls (clean switch; type-then-undo), again deliberately paired |
| `measureDrafts` dropped from the dirty key | 1 |
| alignment `dirty` pinned `false` | 1 |

---

## §6 — `SPC-15`: the cadence config has no SPA surface. **Decision: it stays open.**

PR-A's §Correction 8 corrected the row from "`CadenceEntry.params` has no SPA
writer" to the true statement: `grep -rn 'strategy/cadence' frontend/react/src`
returns **zero** hits and `strategyClient.ts` contains no cadence call of any kind.
All three schedules (weekly check-in, metric sync, board pack) are API-only. It is
a missing SCREEN, not a missing field.

**PR-B does not ship it, and the reason is not effort.** `SPC-9` is still open:
`PUT /cadence` is a **full replace**, so an absent key silently deletes that
schedule. A screen built on that semantic lets a user disable two schedules by
editing one — a silent destructive write, in the PR whose entire theme is *do not
destroy things silently*. Shipping the screen first would be building the UI on
top of the exact family §5 above exists to close.

There is a second, independent reason the screen is not a UX-round-sized change:
the `params` editor's required-key set must be **derived** from each chain's
`findUnfilledExpansionParams`, not hand-listed — otherwise the screen re-creates
`SPC-1` (a save that returns OK and then fails nightly forever) on the client side,
which is precisely what PR-A §5 spent its effort closing on the server.

So the order is: settle `SPC-9`'s disclosure semantics, then build the screen on a
PUT whose deletions are visible. Recorded as a residual with that sequencing, not
as an unexplained omission.

---

## §7 — The remaining rows

| Row | Cure | Note |
|---|---|---|
| `SPU-5` | `announce` on the three failure notices; **Retry** on the timeline failure | It was the only failure in the feature with no retry. Two of the three are now gate-enforced (§4). |
| `SPU-6` | `ctxFailed` disclosure; the raw-id fallback STAYS | Gated on there actually being a priority link — the packet resolves nothing else, so otherwise it is noise about a non-event. |
| `SPU-7` | `FeatureDisabledError` ⇒ render nothing; anything else ⇒ `InlineState kind="failed"` + retry, announced POLITELY | The two causes were collapsed and the docblock stated that as the intent. `strategyClient.ts:107` already distinguished them. |
| `SPU-8` | `count` (not `n`) + `_one`/`_other` ×4 + **name the template** + `useLiveRegion` | Three defects in one line — see below. |
| `SPU-9` | `_one`/`_other` ×4 for `blankTitlesBlockSave` | Verb agreement was wrong in fr/es/pt-BR on the single most likely case. |
| `SPU-10` | objective group named **and** KR label qualified | Both halves; naming the group alone still leaves the numbering ambiguous when focus jumps into a field. |
| `SPU-11` | focus moves to the error notice | Serves the keyboard user directly and the sighted one via scroll-on-focus. |
| `SPU-12` | `StrategyChips` gains `withLead`; the Card uses it and `strategySubLine` | The docblock's claim was false; now it is true and tested. |
| `SPU-13` | designed empty state naming the prerequisite | The explaining copy rendered only AFTER the precondition was met. |
| `SPU-14` | both fixtures completed, casts dropped | Removing `as ProjectRef` immediately exposed a genuinely missing `orgId`. |

`SPU-8` is worth its own paragraph: it interpolated `{{n}}`, not i18next's magic
`count`, so **no plural resolution happened in any of the four locales** — and
`portfolio-bet` and `working-backwards` each scaffold exactly ONE objective, so
picking either rendered "Pre-filled 1 objectives" in the first thing a new user
reads. Second defect on the same line: the message never named WHICH template was
applied, so switching between those two produced **byte-identical text** — the DOM
did not mutate and a live region only speaks on mutation. Third: re-picking the
SAME template is still identical text, which is why the region moved onto
`useLiveRegion()`.

**Two existing assertions PINNED the ungrammatical form.** `/have an empty title/`
matched only because the singular was wrong; fixing the plural turned both red.
Rewritten to assert the singular sentence exactly, with the plural arm beside it.

`StrategyViews` also gains the feature's first spec — it was one of six surfaces
with no coverage at all.

---

## §8 — ADR 0597 §Correction 4's SPA residual, closed

PR-A shipped `activationReviewClosed: true` in the PATCH response with **no SPA
reader** and filed it as "PR-B (UX)". The owner's own edit closes their own
submission from an approver's inbox; a silent version of that is the STR2-M5 lesson
repeated. Wired from **both** editors that can send a protected field —
`PROTECTED_FIELDS` is objectives / period / planningHorizon / accountableExecutive,
and Overview sends the last two while Objectives sends the first, so wiring only
the obvious tab would have covered half the trigger surface.

---

## Prescriptions falsified, and one assertion of my own

1. **"Clear `autoReverted` in `refresh()` too" (§1).** Would have destroyed the
   STR2-M5 disclosure in the same tick it is raised, because `refresh` **is**
   `onChanged` and the editor sets the marker immediately before calling it.
2. **"88 of 98 `features/` directories call `toast.success`" (§2).** Not
   reproducible: 47 of 97. The finding stands; the number does not.
3. **The finding named TWO holes in `check-notice-announce`; there are three
   (§4.2).** A flag named exactly `failed` matches neither alternative of the
   original regex — found by running it against the real flag names, and it is the
   hole two of strategy's three escapes actually fell through.
4. **MY OWN `SPU-11` ASSERTION WAS VACUOUS, and the probe caught it.** It read
   `document.activeElement?.contains(notice)`, which is **TRUE when `activeElement`
   is `document.body`** — it passed with the focus effect deleted. Rewritten as an
   identity against the focus holder; the same sabotage now reddens it. Recorded
   because it is the fourth round in a row where the fix contained a fresh instance
   of the family it closes.
5. **My first vacuity floor could never fire (§4.4)**, and my first floor numbers
   were invented (§4.4).

---

## Residuals — open, and open ON PURPOSE

| Id | Residual | Why not now |
|---|---|---|
| `check-notice-announce` (shape) | An early return whose `<Notice>` is **not the first element after it** (`if (loadError) { return (<div><PageHeader…/><Notice…>`) is STILL invisible — the gate reads a 60-character window before the element. **MEASURED: removing that `announce` leaves the gate green.** | Widening the window to the enclosing block trades a real false-positive rate. The shape is named in the gate's own docblock, and the site got a HAND-WRITTEN test instead — sabotage proves an assertion is load-bearing, it cannot invent the assertion nobody wrote. |
| `check-notice-announce` (cohort) | **192 silent disclosures across 179 (file, flag) sites in 153 files**, ~60 features, enumerated in `scripts/notice-announce-0598-cohort.mjs`. *(Re-measured twice: §Correction 2 for the fourth shape, §Correction 7 for the key.)* | Other features' surfaces; their own grade passes will reach them. Fixing them here hides the count inside a strategy PR. |
| `check-notice-announce` (same-site swap) | A swap within ONE `(file, flag)` pair — fixing one `error`-gated notice in a file and adding another `error`-gated one beside it — is **still green**. PROVEN in §Correction 7. | Distinguishing them needs line or content identity, which the gate rejects for a 179-entry mechanical list because a shifting line number trains "edit the list" instead of "fix the defect". The slot went from 153 files wide to one flag's count in one file: a narrowing, not a closure. |
| `check-notice-announce` (cohort + stale checks are fixture-unreachable) | Both are `scanningRealTree`-guarded, so `scripts/__tests__/gates.test.ts` cannot drive them. | In fixture mode all 179 rows would read as stale and the gate would exit before the behaviour under test — the same constraint `staleAllow` already had. The witnesses in §Correction 7 are real-tree probes run by hand. **Not claimed as automated.** |
| `check-notice-announce` (shape) — a LIVE instance in this feature | `StrategyDetailPage`'s own error disclosure is `{error ? (<div ref={errorRef} tabIndex={-1}><Notice variant="error" announce={error}>` — the `<Notice>` is not the first element after the gate, so it is invisible. **MEASURED on the FINAL tree: deleting that `announce` leaves the gate EXIT=0.** | Same trade as the row above. It is covered by the §Correction 6 hand-written assertion instead, which DOES redden on that sabotage — recorded so the feature's protection is not mistaken for the gate's. |
| `SPU-8` / §Correction 11 (product question) | Picking a template and then **Blank** keeps the template's `summary` and `horizon`. It is now DISCLOSED by the announcement rather than silent. | Whether Blank should offer to clear them is a product decision, not a UX-round fix. Protecting typed text is the defensible default. |
| `check-live-regions` (cohort) | **5 files** on the implicit allowlist (builder ×3, chat, document-editor). | Same reason. Each is one call site; each needs its own judgement about whether it can repeat. |
| `check-failure-card-announce` | NOT extended. It inspects only `<StateCard>` and was the third gate that ran green; a bare `<span>` still falls outside it. | Its blind spot is the same one `check-live-regions` now covers from the other side. Extending a third gate to the same population would create two rules for one invariant — the shape PR-A §2 fixed. |
| `SPC-15` | The cadence config has **no SPA surface at all**. | §6 — blocked on `SPC-9` (a full-replace PUT that silently deletes omitted schedules); building a screen on that semantic ships a silent destructive write. |
| `SPC-9` | `PUT /cadence` still silently deletes the schedules an absent key omits. | Inherited from PR-A. It is now the *blocker* for `SPC-15`, which is a change in its priority, not in its status. |
| `SPU-4` (import lane) | `ImportObjectivesBlock` calls `onChanged` → `refresh()` → a new `updatedAt` → **`ObjectivesEditor` remounts and discards unsaved objective edits**, on the SAME tab. Recipe: Objectives tab → type an objective → paste CSV below → Import. | A second instance of the `SPU-4` family in a lane `SPU-4` never enumerated. It needs a merge-or-confirm DECISION (the import legitimately rewrote the server's objectives), not the same guard — and inventing that semantics on the way past is how a fix manufactures a new failure mode. Filed with the reproduction. |
| `SPU-4` (route lane) | Browser back/forward and any other route change out of `/strategy/:id` are unguarded — only the tablist and the in-page "Back to portfolio" link are. | A router-level blocker (or `beforeunload`) is a different mechanism with app-wide blast radius, not a feature fix. |
| §8 (restore lane) | `POST /:id/versions/:n/restore` returns `activationReviewClosed` too, and there is **no restore UI in this feature at all** to read it from. | Nothing to wire it to. Named so a future restore screen inherits the requirement rather than rediscovering it. |
| ADR 0597 §Correction 4 (revert lane) | Still open from PR-A: `restore` withdraws a pending review but does not fire the **auto-revert** branch. | Backend; unchanged by this PR. |
| `SPU-10` (verbalization) | The markup is proven; the exact screen-reader verbalization order is not. | Needs a real screen reader — `CT-SP-3` in the tracker's click-through list. |
| `SPU-11` (viewport) | Focus-on-error is proven; whether the banner was off-screen depends on viewport and content length. | `CT-SP-8`. Trivially reproducible with ~6+ objectives, but not statically decidable. |
| `CT-SP-1`…`CT-SP-10` | The whole live click-through list (light + dark, 360/768/1440, real screen reader) is untouched. | No browser was driven in this PR. |

---

## Implementation record

| § | Change | Commit |
|---|---|---|
| — | ADR reservation | `99adfd0ce` |
| §1 | `SPU-3` — clear on success; the retry spec that could not fail | `fe9654795` |
| §2 §3 | `SPU-2` + `SPU-1` — eight confirmations, the import announcement | `c12f0ea74` |
| §5 | `SPU-4` — the leave guard | `c61a05c33` |
| §4 §7 | the two gate extensions + `SPU-5` | `531b2adfb` |
| §7 | `SPU-6` + `SPU-7` | `6576816d0` |
| §7 | `SPU-8` + `SPU-9` | `91c2c4a97` |
| §7 | `SPU-10`/`-11`/`-12`/`-13`/`-14` | `7e72a5495` |
| §8 | `activationReviewClosed` reaches the screen | `1250a1b60` |
| — | ADR 0598 implemented | `24c164838` |
| §Correction 1 | the merge gate was RED — an unused test import | `325242a13` |
| §Correction 2 | the compound-gate shape the extension could not see | `282b57259` |
| §Correction 3 | one shared resolver for all 12 env-overridable baselines | `e88ff70d6` |
| §Correction 4 | a withdrawal save spoke twice into a one-string slot | `3e8aed4a5` |
| §Correction 5 | two more draft-holders on the guarded tab | `d9d0d9d72` |
| §Correction 6 | a repeated identical failure was silent and unfocused | `822a25ebc` |
| §Correction 7 | the cohort ratchet was a 153-file-wide slot | `88504a21a` |
| §Correction 8 | vacuity guards that ran last and short-circuited | `6792aa46b` |
| §Corrections 9–11 | the three LOW rows | `1bdbafe32` |

**Gates run — and ONLY these. Nothing else is claimed.**

> **§Corrections 1–11 re-ran, on the FINAL tree:** `npm run build` **GREEN, 29
> checks** (26 → 29 as the gate list grew); `node scripts/check-test-types.mjs`
> **172, baseline 172, EXIT=0, read UNPIPED**; `node
> node_modules/typescript/bin/tsc --noEmit` clean; targeted vitest — the 5
> `features/strategy/__tests__` specs (**70**), `scripts/__tests__/gates.test.ts`
> (**41**) and the new `src/__tests__/gateBaseline.test.ts` (**6**), plus
> `testTypesRatchet` (**12**) — **131 in one run, all green.** `npm run ci` is still NOT run and NOT claimed.

- **`( cd frontend/react && npm run build )` — the canonical FE gate, all 26
  checks, GREEN.** Run after §4, after §7 and at the end. Never bare `vite build`.
- `node node_modules/typescript/bin/tsc --noEmit` — clean, after every change and
  after every sabotage restore.
- `node scripts/check-test-types.mjs` — **172, at baseline**, but only after
  §Correction 1. **The claim as first written was FALSE**: the branch shipped at
  **173, EXIT=1**, so `scripts/ci.sh:350` — and therefore `npm run ci` — was RED
  for the whole review window. See §Correction 1 for the mechanism that let a
  green `npm run build` be read as evidence about this lane.
- Targeted vitest: the 5 `features/strategy/__tests__` specs (60 tests) plus
  `scripts/__tests__/gates.test.ts` (32, incl. 6 new).
- **NOT run, and not claimed:** `npm run ci` (owned by the caller — a second fleet
  corrupts both results), the backend suite, Playwright e2e, and any browser.

**Every sabotage was restored from a `cp` backup and verified by diffing the file**,
not merely reverted in the working tree; `git status -s` was checked clean between
items.

---

## Corrections — the adversarial-review fold-in

The review's theme, and it is the right one: **this PR extended two repo-wide
gates, and the extensions carry the same defect classes the PR was fixing.** A
gate that cannot fail, a baseline that absorbs a swap, an override that silently
disables itself. Everything below was reproduced before it was cured.

### §Correction 1 — the merge gate was RED, and a green build is not evidence about that lane

`strategyViews.test.tsx:11` imported `screen` and never used it, so
`node scripts/check-test-types.mjs` reported **173 against a baseline of 172,
EXIT=1**. `scripts/ci.sh:350` runs it, so `npm run ci` was red for the whole
review window.

**Why it survived a "GREEN, all 26 checks" build.** `tsconfig.json` **excludes**
`src/**/__tests__/**` — that exclusion is the entire reason
`check-test-types.mjs` exists (its docblock, :4-6). So `npm run build`'s tsc
never compiled the file that had the error. **A green build carries no
information about this lane at all**, and reading it as though it does is the
same substitution that cost a full gate run on feature 25.

The `SPU-14` note in the gate list was true as far as it went — dropping
`as ProjectRef` DID expose a real missing `orgId` — but "which is the row
working" was written about a count that had never come back down. The import was
left behind by the same edit.

Cured by deleting the unused import. **`node scripts/check-test-types.mjs`
re-run UNPIPED: `✓ … 172 … (baseline 172, ratchet holds.)` EXIT=0.** The
targeted spec still passes 3/3.

### §Correction 2 — the extended gate could not see the disclosure THIS PR added

`GATE_SHAPES[0]` captures the ONE identifier adjacent to the `?`/`&&`. The SPU-6
disclosure §7 shipped is written as a **compound** gate:

```
{ctxFailed && hasPriorityLink ? <Notice variant="warning" announce={…}>
```

so the capture is `hasPriorityLink`, `isFailedReadFlag` says no, and the notice
was **never classified at all** — not counted in the 210, not in the 190, not
ratchetable. **PROVEN**: deleting that `announce` left `check-notice-announce`
**EXIT=0 with every number byte-identical**. §4.2's claim to have closed
strategy's shapes was one hole short, and the hole was the shape of the fix.

**Cure: a third `GATE_SHAPES` entry that reads the whole trailing `&&` chain**,
with every operand tested — the reviewer's cheaper variant, taken over "scan
every identifier in the 60-character window", which would attribute an unrelated
`somethingFailed` two lines above the element.

**The false-positive cost the finding left unmeasured, measured.** The first cut
stripped a leading `!` and tested the bare name. That flagged
`features/users/SsoPanel.tsx:118` — `{!capsFailed && !saml && !scim ? <Notice
variant="info">` — which is static "SSO is not enabled" copy rendering **because
the read SUCCEEDED**. A negated operand is the opposite claim, so shape 2 now
FILTERS negated operands out. That is the whole measured false-positive rate:
**one site, found and closed before the commit.**

**The count moved, and the cohort was re-derived IN THE SAME COMMIT.**
`silentReadsNew` **190 → 192**, cohort **152 → 153 files**, `totalReadsNew`
**210 → 213**. Both new sites are genuine and were read:

| Site | Gate | Already in cohort? |
|---|---|---|
| `features/bi/MetricsPage.tsx:243` | `{formError && !errorField && <Notice variant="error">` | yes (file already listed) |
| `features/projects/ProjectWorkflowsTab.tsx:111` | `{error && !runPrompt ? <Notice variant="error">` | **no — added** |

**A fourth vacuity floor, and an honest statement of what it is worth.** The
compound shape matches exactly **3** notices repo-wide, so the floor is **1**: at
that population a numeric guard can only catch drift-to-zero, and a floor of 3
would be an exact count wearing a floor's clothes. The load-bearing guard is the
fixture pair in `scripts/__tests__/gates.test.ts`. This is stated in the script
so nobody reads `1` as thorough.

**A thing worth knowing about this ratchet: removing a SHAPE cannot redden the
real-tree run.** Deleting shape 2 makes `silentReadsNew` FALL (192 → 190) and a
shrink-only ratchet permits that. MEASURED. Only the fixtures catch it — which
is the argument for the fixtures, and the reason a "the gate is green" claim is
not evidence that the gate still sees anything.

| Sabotage | Red |
|---|---|
| shape 2 deleted from `GATE_SHAPES` | **2** — `FAILS a compound gate …` + `FAILS the &&-only compound form …`. A deliberate pair (the `?` and `&&` spellings of one shape); **nothing on the real tree**, see above |
| the negated-operand filter replaced by the strip-`!` version | **1** — `leaves a NEGATED failure flag alone` |
| `announce` deleted from `StrategyDetailPage.tsx:926` | **1** — `✗ … features/strategy/StrategyDetailPage.tsx` EXIT=1 (EXIT=0 before this correction) |

### §Correction 3 — an override that silently disables itself, and the class was six times bigger than the finding

`Number(process.env.X ?? '190')` reads a typo as `NaN`, and every comparison
against `NaN` is false — including `count > BASELINE`. So the override did not
raise the bar or lower it, it **removed** it, and the run still printed a tick.
**PROVEN:**

```
OPENWOP_SILENT_READ_NOTICE_BASELINE_0598=0     → ✗ EXIT=1
OPENWOP_SILENT_READ_NOTICE_BASELINE_0598=zero  → ✓ EXIT=0   (… baseline NaN …)
```

The finding's sharpest point is right: `check-live-regions.mjs` had already
learned this and **written the lesson down in the same commit** that shipped the
unguarded sibling — *"an override that cannot be read is an operator MISTAKE, not
permission to assert nothing."* A rule that exists as prose in one file is not a
rule.

**The finding named two sites. The class has TWELVE.**
`grep -n 'Number(process.env' frontend/react/scripts/` → **12 env-overridable
baselines across 10 gate scripts**, of which exactly **2** carried the guard
(both in `check-live-regions`, and only one of those checked the empty string).
Enumerating the class instead of the instances is the difference between fixing
2 and fixing 12; the filed count was a floor, as usual.

**Cure: ONE shared resolver** — `frontend/react/scripts/gateBaseline.mjs`
(`resolveGateBaseline` / `readGateBaseline`) — and all twelve call sites rewired.
It refuses three shapes:

| Shape | Old behaviour | Now |
|---|---|---|
| `X=zero` | baseline `NaN`, gate OFF, tick printed | EXIT=1, names the NaN mechanism |
| `X=` (empty) | `Number('')` → **0**, i.e. the strictest baseline — a red for a reason nobody asked for, indistinguishable from a real regression | EXIT=1 |
| `X=99999` | ratchet loosened from the environment | EXIT=1 — **the override may only TIGHTEN** |

The ceiling is safe to apply uniformly because **all twelve compare
`count > BASELINE`** (checked one by one), so lower is always tighter. Tightening
stays open: `OPENWOP_SILENT_READ_NOTICE_BASELINE_0598=0` still works and prints
`(… tightened the baseline to 0)`.

**`check-test-types.mjs` is NOT rewired, deliberately.** Its `resolveBaseline`
already had both guards, has its own tested vocabulary, and differs on one case
on purpose: `''` resolves to the file baseline there and is an ERROR here. Two
resolvers with two documented semantics beats one resolver with a mode flag; the
divergence is named rather than merged away.

**Mechanism and wiring are tested SEPARATELY**, because the defect was never in
the logic — it was in which gates called it. `src/__tests__/gateBaseline.test.ts`
proves the resolver refuses; `scripts/__tests__/gates.test.ts` drives the REAL
scripts with a bad override (`runGate` gained an `env` argument).

| Sabotage | Red |
|---|---|
| `!Number.isInteger(n) \|\| n < 0` → `false` | **4** — 2 mechanism + 2 wiring (`check-notice-announce` and `check-live-regions` both stop refusing). A deliberate mechanism/wiring pair, not a blast radius |
| the `n > fileDefault` ceiling → `false` | **2** — the mechanism test and its wiring twin |
| the empty-string guard → `false` | **1** |

All nine rewired gates re-run individually: **EXIT=0, numbers unchanged.**

### §Correction 4 — "one message per save" was enforced against ONE of the two flags

`ui/announce.tsx:99-105` keeps a single module-level `politeMsg`. Two polite
messages for one save means the second overwrites the first, so the user hears
whichever landed last. §2 stated the rule and enforced it — against
`autoRevertedToDraft` only. `activationReviewClosed` arrived **one commit later**
(§8, `1250a1b60`) and inherited none of it:

* `OverviewEditor.save` fired an **unconditional** `toast.success`
  (`ui/toast.tsx:69` announces it) alongside the announcing withdrawal notice.
* `ObjectivesEditor.save`'s suppression term omitted the new flag entirely.

**REPRODUCED**, not traced: three assertions written against the fixed behaviour
were run first and all three went **red**, twice with
`expected "vi.fn()" to not be called at all, but actually been called 1 times`.
The R4 spec §8 shipped mocked the toast and never asserted it was **not** called
— which is why the rule could be broken by the next commit in the same PR.

**The co-occurrence is REACHABLE, and I checked the backend rather than the
trace.** `features/strategy/routes.ts` derives both flags from `touchesProtected`;
`autoReverted` additionally needs `protectedEditRequiresReapproval(s.status)`,
and `activationApproval.ts:227` gives `paused` the posture
`{approved: true, terminal: false}` — so it qualifies. A `paused` strategy can
hold a PENDING review because `PATCH {status:'active'}` from `paused` withholds
the flip and queues it. Recipe: **pause → submit for activation → edit
objectives**, and one response carries both flags.

**Cure, with the trap the reviewer flagged avoided.** Dropping `announce` from
the withdrawal notice would recreate the §8 defect *and* redden the gate §4
extended. Instead: both save paths suppress the plain toast when the disclosure
speaks, and the co-occurrence renders **ONE combined disclosure**
(`autoRevertedAndWithdrawnNotice`, added in all four locales — `check-i18n`
green). The single-fact notices are unchanged in the single-fact cases.

| Sabotage | Red |
|---|---|
| Overview suppression reverted to unconditional `toast.success` | **1** — `the OVERVIEW withdrawal disclosure IS the confirmation` |
| Objectives suppression term reverted to `!res.autoRevertedToDraft` | **1** — `the OBJECTIVES withdrawal disclosure IS the confirmation` |
| combined branch forced off (`{false ? (`) | **1** — `an auto-revert that ALSO withdraws the review renders ONE combined disclosure` |

**One thing the finding claimed that I did NOT reproduce, stated plainly:** the
literal *"both notices render, both announce, and the auto-revert disclosure is
clobbered"* is not observable in this suite, because the toast is mocked and the
two `Notice` effects land in different render passes. The DEFECT is real and the
cure is the same; the failure mode is *indeterminate* — either a clobbered
message or two competing polite strings — rather than a proven clobber ordering.
Saying which would need a real screen reader (`CT-SP-*`).

### §Correction 5 — SPU-4's own family, in a lane its enumeration never walked

*"ONE rule at ONE composition owner"* was the right shape and it was applied to
the four **tab editors**. The Objectives tab holds **three** draft-bearing
components:

| Component | Draft it holds | Reported `onDirty`? |
|---|---|---|
| `ObjectivesEditor` | the objectives tree + `measureDrafts` | yes |
| `ImportObjectivesBlock` | the pasted `csv` | **no** |
| `CheckInsPanel` | `value` + `note` per measured key result | **no** |

So the page's `dirty` reflected one of three sources and a tab switch destroyed
the other two with **no prompt at all**. **PROVEN by probe** before anything
changed: three assertions written against the fixed behaviour went red. This is
distinct from the import **remount** residual already filed — that one is about
`onChanged → refresh()` discarding the EDITOR's edits; this is the import block's
own draft, and the check-ins panel was in neither.

**The cure the reviewer warned about, and why it is the one taken.** A plain
second `useState` per child would have recreated a clobber the single flag avoids
only by ACCIDENT — there was exactly one reporter. Each child runs
`useEffect(() => onDirty(dirty))`, so with two booleans the last effect to fire
wins and a clean import block would erase a dirty editor. The owner keeps a
**Set of dirty SOURCES** and `dirty = size > 0`.

Two implementation details that are not decoration:

* `markDirty` returns the **previous Set** when nothing changed. React bails out
  on `Object.is`, so returning a fresh `new Set()` every time would re-render on
  every effect run.
* A confirmed leave clears the **whole** registry. The outgoing tab's components
  unmount with no cleanup that could report themselves clean, so clearing
  per-source would strand entries and prompt forever — a guard with no exit,
  which is its own defect.

| Sabotage | Red |
|---|---|
| import dirty effect neutered | **1** — `an unsaved CSV import draft prompts …` |
| check-ins dirty effect neutered | **2** — the value case and the note case. A deliberate pair for one effect |
| check-ins dirtiness keyed on `value` only | **1** — `a check-in NOTE alone counts …` |
| `markDirty` made to CLOBBER rather than compose | **1** — `the registry composes, it does not overwrite` |
| import dirtiness dropped `.trim()` | **1** — the `type-then-clear` over-fire control |

`( cd frontend/react && npm run build )` — **GREEN**, 29 checks.

### §Correction 6 — the SECOND identical failure did nothing at all

`setError` with an `Object.is`-equal string is a React bail-out. Nothing
re-renders, so `useEffect(…, [error])` does not re-fire (no focus move) and the
`Notice`'s `useEffect(…, [announce, assertive])` does not re-fire either — the
notice is already mounted and its prop is unchanged. **PROVEN**: a second
identical save failure produced `{reannounced: false, refocused: false}` — total
silence, no focus. That is the §2 defect ("saved" and "the button did nothing"
were indistinguishable) arriving through the FAILURE path, and §7 defect 3
reasoned exactly this way about `templateApplied` one commit earlier without
carrying it across.

**Cure: a monotonic companion, not a dependency-free effect.** `raiseError` is
the single writer — every `onError` site now routes through it — and bumps
`errorTick` alongside `setError`. The tick keys BOTH effects:

* the focus effect (`[error, errorTick]`). Re-running it on **every** render, the
  obvious alternative, would steal focus from a field being typed in while an
  error is standing — a worse defect than the one being fixed. There is a
  dedicated over-fire control for that.
* the `<Notice key={errorTick}>`. Its announce effect is PROP-keyed and the prop
  is by definition unchanged on a repeat, so a remount is the only thing that
  re-runs it. `announce()` then alternates its invisible marker, making the
  repeat a distinct live-region value. **Dropping the `announce` prop and
  calling `announce()` from the page instead was rejected**: it would either
  announce twice or, with the prop removed, re-open the family §4 extended a gate
  to catch.

| Sabotage | Red |
|---|---|
| focus deps reverted to `[error]` | **1** — `a REPEATED identical failure re-announces and re-focuses` |
| `key={errorTick}` removed from the Notice | **1** — same assertion, the other half |
| `raiseError` stops bumping the tick | **1** |
| focus effect given NO dependency array | **1** — `the focus effect does NOT fire on an unrelated re-render` |

**One test-authoring trap this hit, recorded because it passes for the wrong
reason.** The first cut asserted `document.activeElement).toBe(notice.closest(
'[tabindex="-1"]'))`. The tick REMOUNTS the notice, so the captured node is
detached and `closest` returns `null` — the assertion silently became
`toBe(null)`. The holder is the stable node and is what the assertion now names.

### §Correction 7 — §4.3's own argument, and then a 153-file-wide SLOT anyway

§4.3 reasoned correctly that a bare count would be a 190-wide slot, and pinned a
**`Set<file>`** beside it. A file SET plus a global COUNT is still a slot — it is
just 153 files wide instead of 190 disclosures wide.

**PROVEN.** Wiring `announce` onto `agentAllowlists/AgentAllowlistPanel.tsx:90`
and adding a brand-new silent disclosure **in the same file** left the count at
192 and the file set unchanged, and the gate printed **a tick**. A fixed
violation had bought a new one. That is the exact failure
`check-notice-announce.mjs`'s own docblock argues against at :13-17, committed by
the file itself — for the second time in this PR.

**Cure: a per-(file, FLAG) COUNT**, the reviewer's suggestion, with the key
chosen for the reason the reasoned allowlist already gives — `file:line` shifts
on every edit above it and trains "edit the list" instead of "fix the defect",
while a flag name changes only on a deliberate rename, which is when re-reading
the entry is correct. **Same enumeration effort, no fabricated reasons.**
179 `(file, flag, count)` rows summing to 192.

**And the stale check the finding asked for**, symmetric with `staleAllow`: a
cohort row matching no live silent notice is an **error**, because it reads as
covering something and covers nothing. A row whose count merely FELL is progress
and prints a `(down: …)` note instead.

| Probe | Before | After |
|---|---|---|
| fix one + add one, SAME file, different flag | ✓ EXIT=0, 192, unchanged file set | **✗ EXIT=1** — `AgentAllowlistPanel.tsx (gated on \`saveFailed\`) — 1, recorded 0` |
| fix one and do NOT update the cohort | ✓ (silently, the row just stopped covering anything) | **✗ EXIT=1** — `1 cohort row(s) … match no live silent notice` |
| fix one + add one, same file AND **same flag** | ✓ | **✓ — STILL GREEN. Named, not implied.** |

**The residual is stated in the cohort module, not buried.** A swap within ONE
`(file, flag)` pair needs line or content identity to see, and that is the thing
the paragraph above rejects for a 179-entry mechanical list. The slot is now one
flag's count in one file rather than 153 files — a narrowing, not a closure, and
it is described that way.

**A structural limit worth naming: neither new check is reachable from the
fixture harness.** Both are guarded by `scanningRealTree`, because in fixture
mode none of the 179 cohort files exist, so every row would read as stale and the
gate would exit before the behaviour under test — the same guard `staleAllow`
already needed and for the same reason. The witnesses above are real-tree probes,
run by hand and recorded here. Not claimed as automated.

### §Correction 8 — the vacuity guards ran LAST and short-circuited, so the floor for a capability could never be the guard that fired

§4.4 replaced ONE inert floor with four per-capability floors — the right move —
and then left them at the **bottom of the file, after every content check has
already exited**, evaluated in a loop that `process.exit(1)`s on the first
breach. Two defects, and they are the same defect §4.4 records fixing.

**REPRODUCED.** Making `isFailedReadFlag` case-SENSITIVE again — the realistic
drift — collapses `errorVariantHits` and zeroes `lowercaseFlagHits`, and on this
branch the run died on the **cohort** check naming
`featureToggles/FeatureTogglePanel.tsx (gated on `consoleFailed`)`. Not one of
the four floors got to speak. §4.4's own evidence table prints this mismatch —
*"flag test made case-SENSITIVE again → the widened `variant="error"` set matched
45"* — and reads it as success.

**Cure, both halves.**

1. **The floors run BEFORE the content checks.** A vacuity guard certifies the
   numbers below it; running it after them is not a guard, it is a footnote. The
   cost is a wrong diagnosis rather than a missed regression — but "each
   capability is independently observable" was false for three of the four.
2. **All floors are evaluated and every breach is printed.** One drift can
   disable several shapes, and reporting one hides that.

| Sabotage | Before (§4.4) | After |
|---|---|---|
| `isFailedReadFlag` case-SENSITIVE | floor #2 — or, on this branch, the cohort check | **2 of 4** — `variant="error"` **46**/60 AND the `case-insensitive flag-name test` **0**/40 |
| early-return regex neutered | floor #1 | **1 of 4** — early-return **0**/3 |
| variant set narrowed to `warning\|info` | floor #1 | **3 of 4** — early-return **1**/3, error-variant **0**/60, lowercase-flag **5**/40. *This is what the short-circuit was hiding* |
| shape 2 deleted | **nothing on the real tree** (the count FALLS, which a shrink-only ratchet permits) | **1 of 4** — compound-gate **0**/1 |

That last row also closes the gap §Correction 2 had to name: removing a shape now
reddens the real-tree run instead of only the fixtures.

**L2 folded in, and made structurally un-repeatable.** §4.4 says the floors were
derived from measured `9 / 205 / 165`. Instrumenting the shipped script gives
`9 / 204 / 164` — §4.4 replaced three invented numbers with three that were never
measured against the tree that shipped either. Rather than correct three numbers
in prose a fourth time, **the script now PRINTS them on every green run**:

```
(detection: the early-return shape 9/floor 3; the compound-gate shape 3/floor 1;
 the widened `variant="error"` set 206/floor 60;
 the case-insensitive flag-name test 165/floor 40)
```

The `+2 / +1` over the reviewer's `204 / 164` is exactly the two sites shape 2
made visible — which independently corroborates the reviewer's figures and not
§4.4's.

**A defect of my own, from §Correction 7, disclosed.** The `(file, flag)` key
separator was written as a **RAW NUL BYTE** in the source. It worked, and it made
`grep` classify the whole gate as *"binary data"* — so `grep -n 'FLOORS'` and
`grep -n 'scanningRealTree'` both returned **nothing** on a file that plainly
contained them. Three searches read as "the code is missing". It is now a named
`SITE_SEP` holding the `\u0000` ESCAPE, and hoisting it exposed a temporal-dead-zone
error the raw literal had hidden. Same family as everything else in this ADR: a
silent empty result reading as a true answer.

### §Correction 9 (L1) — a stale allowlist entry was fatal in one gate and a footnote in the other

`check-notice-announce.mjs:304-314` exits 1 on a stale exemption **with the
rationale written out** — *"a stale exemption is worse than none: it reads as a
reviewed decision while exempting nothing, and the next person inherits a list
they cannot trust."* `check-live-regions.mjs:365,383-388` appended the same
condition as a **note on a PASSING run**, which nobody reads.

The reviewer is right that the shape was **inherited**, not invented: the
pre-existing explicit allowlist had it and the ADR 0598 implicit one copied it.
Both are flipped together — fixing only the new half would have recreated the
asymmetry inside a single file.

**MEASURED before flipping:** both allowlists are fully live (0 stale), so this
is not a latent red for anyone.

| Sabotage | Red |
|---|---|
| a bogus `does/NotExist.tsx` added to `IMPLICIT_ALLOWED` | **EXIT=1** — `1 allowlist entry matches no live bare region` (was: a green tick with a note) |

### §Correction 10 (L3) — a gate that prescribed a cure which does not compile

`ui/Notice.tsx:51-72` makes `announce` and `id` mutually exclusive **by type** —
an `id` means a control points `aria-describedby` at the notice, so announcing as
well would speak it twice. But `check-notice-announce`'s error text says *"Pass
`announce` with the text to speak"*, which for an `id`-carrying notice **will not
typecheck**. A gate whose prescribed cure is impossible reads as actionable, and
the cheapest way out becomes the allowlist.

**VERIFIED LATENT:** exactly **4** live `id`-carrying `<Notice>` sites
(`CommercePage:472`, `BundleShopPage:404`, `ApplyGrantPage:252`,
`PageExperimentsPanel:247`), gated on `subIntervals.length === 0`, `!nameOk`,
nothing, and `weightTotal !== 100` — none is failure-gated, so nothing is broken
today. Which is exactly when it is cheap to close.

**Cure: the gate detects the combination and says the TRUE remedy** — either the
`aria-describedby` link makes it genuinely exempt (add an `EXPECTED_SILENT` entry
with THAT reason) or the `id` is unused and should go so `announce` is available.
Not a change to the type: the mutual exclusion is a real invariant and weakening
it to make an error message true would be the wrong direction.

| Sabotage | Red |
|---|---|
| the `id`-detection line deleted | **1** — `tells the TRUE remedy when the notice carries an \`id\`` |

(Plus a paired control that the note does **not** print for an ordinary
violation, so the message cannot become unconditional noise.)

### §Correction 11 (L4) — the most destructive choice in the picker was the silent one

`StrategyPage.applyTemplate`'s blank branch was `setTplAnnounce('')`. §7 fixed
**three** defects in the APPLIED message and left the CLEAR arm at the empty
string — so choosing **Blank**, which DISCARDS the scaffolded objectives and
initiatives, said nothing at all, while the `SPU-8` row read as closed.

**And the copy had to be got right in the other direction too.** `applyTemplate`
deliberately leaves `summary` and `horizon` alone (a user who typed over the
template's summary must not lose it), so a message claiming the form was reset
would OVERSTATE — the same family of defect as one that is absent. The new
`templateCleared` string names what was removed and what was kept, in all four
locales, and there is an assertion for each half.

| Sabotage | Red |
|---|---|
| `setTplAnnounce(t('templateCleared'))` reverted to `setTplAnnounce('')` | **2** — `choosing Blank AFTER a template says what it discarded` + `does NOT claim the whole form was reset`. A deliberate pair: the presence half and the honesty half |

**Newly observed, filed rather than fixed:** picking a template and then Blank
leaves the template's `summary` and `horizon` in the form. That is arguably
correct (it protects typed text) and it is now DISCLOSED rather than silent, but
whether Blank should offer to clear them is a product decision this PR does not
make.
