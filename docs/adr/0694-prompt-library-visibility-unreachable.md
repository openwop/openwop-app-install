# ADR 0694 — `visibility` is the ACL, and any org writer can rewrite someone else's

Status: **implemented** (verified 2026-09-17, #3848)

Feature loop 2026-09, iteration 34 — Prompt library (`FEATURES.md` ordinal 202,
ADR 0116). Graded at `origin/main` `aea976e2e`. Ids continue the 2026-08-27
passes (`PLWF-`/`PLC-`).

> **This ADR was rewritten before implementation.** Its first draft led with a
> UX Blocker ("every UI-created prompt is private forever") built on a surface
> confusion, and buried the authz defect below. An adversarial `/architect` pass
> falsified three of its claims. The discarded draft and why it was wrong are
> recorded in "Superseded first draft" — the reasoning trail is the point.

## Context

The 2026-08-27 passes graded this feature **C** / **C+** / **B−**. Re-verifying
every filed row at HEAD, **five are already closed** ("Stale rows"). The live
defect was not among them, and was not visible from any filed row.

## D1 (Blocker, `PLC-6`, NEW) — the read gate is not the write gate

`PLC-1` made `private` mean private on **reads**:
`promptLibraryService.ts:121` `readableBy(e, caller)` →
`e.visibility !== 'private' || e.createdBy === caller`, applied by `listEntries`
(`:142`) and `getEntry` (`:149`), folding an unreadable entry into the same 404
as a missing one.

**Writes were never gated the same way**, and one of the writable fields *is* the
read gate:

| # | Fact | Evidence |
|---|---|---|
| 1 | `updateEntry` reads the entry **unfiltered**, deliberately | `promptLibraryService.ts:178` — comment: *"Use the unfiltered get so an org writer keeps managing any entry."* |
| 2 | It then writes `visibility` from caller input with **no owner check** | `promptLibraryService.ts:185` |
| 3 | The route gates only `workspace:write` — no owner predicate | `features/prompts/routes.ts:55-57` |
| 4 | `deleteEntry` is org-scoped by the same deliberate choice | `promptLibraryService.ts:193` — *"WRITE authority stays org-scoped (PLC-1 gates reads, not deletes)"* |

So **any `workspace:write` member can PATCH another member's `private` entry to
`org` or `shared`** and then read its body — or have anyone else read it.

### Why this survived review

Because it is *correct for every other field*. Org-scoped write authority over
`name`, `description`, `tags` and `promptRef` is a reasonable product decision,
and `:178`/`:193` state it as one. The bug is that **`visibility` was grouped
with the cosmetic fields when it is the ACL itself** — so a rule written about
*editing* silently became a rule about *granting*.

This is exactly the shape ADR 0644 D1 closed on the sharing **mint** path, where
the reasoning is recorded verbatim at `sharing/sharingService.ts:394-401`:
`validate` is the entitlement hook, it must apply the resource's own visibility
predicate, and the "a minted link IS the grant" rationale is *circular* where
whether the actor was entitled to grant is the open question. **That reasoning
transfers to `updateEntry` without modification, and was not applied there.**
`PLC-5` closed the mint lane; the update lane is the same grant by another verb.

### Decision

- **D1a** — in `updateEntry`, gate **`visibility` alone** on ownership: if
  `input.visibility !== undefined` and the stored entry is not `readableBy` the
  actor, refuse `403` ("Only the owner may change a private prompt's
  visibility."), mirroring ADR 0644 D1's message and status. Every other field
  keeps org-scoped write authority — this ADR does **not** relitigate `:178`.
- **D1b** — a route-level witness (`createApp` + cookie jar, per the repo's
  authz-test convention): owner may widen; a second `workspace:write` member in
  the same org may not, and gets 403 not 404 (the entry is not secret from a
  writer — they can already see it exists via the unfiltered edit lane, so a 404
  here would be a lie, unlike the read lane where 404 is correct).
- **D1c** — a negative leg pinning that the *other* fields stay org-writable, so
  a later reader cannot mistake D1a for a general owner-only rule.

**Deliberately NOT done:** gating `deleteEntry`. It is the same org-scoped
choice, it destroys rather than grants, and widening this ADR to cover it would
relitigate a documented decision on no evidence. Recorded as an open question.

## D2 (Improvement, `PLWF-3`, NEW) — a docblock claims a replay mechanism that does not exist

`features/prompts/promptSurface.ts:9-10` states the surface is *"Reads only;
replay-safe via the **action-node convention** (the seam records outputs)."*

Measured — nothing records or serves these outputs:

```
feature.prompts.nodes.list-library    floor=False | served=False | declared=True
feature.prompts.nodes.get-entry       floor=False | served=False | declared=True
feature.prompts.nodes.render-entry    floor=False | served=False | declared=True
```

On replay the nodes re-execute and re-read the live store. The *conclusion*
("replay-safe") holds — they are pure reads, so re-execution duplicates no
effect — but the stated *mechanism* is false, and a false mechanism is how the
next reader reasons wrongly about a node that is not a pure read.

Third instance of one family: **ADR 0655 D4** (email — three pure reads under
`role:"action"`, docblock claiming the opposite) and **ADR 0686 / `CEWF-1`**
(code-exec — the same false "never re-execute" claim, where it *was* dangerous).
ADR 0655 D4 is the precedent to copy.

### Decision

- **D2a** — correct the docblock to what is true.
- **D2b** — declare the three nodes `role:"read"` (pack minor bump), matching
  ADR 0655 D4.

  **Corrected after measuring — an earlier draft of this line said "this moves no
  generated artifact", and that is FALSE.** Regenerating all three artifacts
  moves two of them:

  - `sideEffectFloor.generated.ts` — a **role-census comment only**:
    `321 action → 318`, `33 read → 36`. Exactly these three nodes changing bucket
    in a header comment.
  - `packs/.steward-manifest.json` — the prompts pack's `version` + `digest`, the
    expected RFC 0076 lockstep stamp.

  **No set MEMBERSHIP changes**: floor, served and declared are byte-identical for
  all three nodes, and every semantic bucket in `gen-served-set.mjs` is unchanged
  (`35` served/role:action, `1` streaming-output, `23` ai-opaque, `20`
  deferred-role-semantics, `0` needs-classification — before and after).

  That distinction matters to a reviewer: a diff in `sideEffectFloor.generated.ts`
  normally means a classification moved, and here it does not. The reason the sets
  hold still is narrower than "nothing reads role" — `gen-served-set.mjs:155`
  *does* key on role, via `DEFERRED_SEMANTICS_ROLES = ['gate','streaming-output']`
  (`scripts/lib/packNodeReach.mjs:285`), neither of which is involved; and the
  floor/served binding (`gen-side-effect-floor.mjs:139`) keys on
  `role === 'side-effect'` or the `side-effectful` capability, also uninvolved.

  Honesty fix; must not be described as a correctness one.
- **D2c** — a witness modelled on `test/email-node-replay.test.ts`, plus a leg
  asserting the three artifact counts are unchanged, so the neutrality claim is
  measured rather than asserted.

**Deliberately NOT done:** making the render replay-served. ADR 0655 D4 settled
the same question the other way for email, and an unpinned `promptRef` resolving
to latest is documented intent (`promptLibraryService.ts:55-70`), not a defect.

## D3 (Blocker, `PLC-7`, NEW) — import can mint permanently unreadable rows

`features/portability/portabilityService.ts:308` calls `createEntry` with
`name`/`promptRef`/`description`/`tags` and **no `visibility`**, so
`promptLibraryService.ts:93` defaults it to `private`. That alone would strand an
imported catalog behind its importer. The id space makes it worse:

| # | Fact | Evidence |
|---|---|---|
| 1 | The import actor is the **raw** request subject, with a literal fallback | `features/portability/routes.ts:97` — `callerSubject(req) ?? 'import'` |
| 2 | `callerSubject` returns the un-canonicalized id | `host/requestSubject.ts:17` — `req.userId ?? req.principal?.principalId` |
| 3 | The read lane compares against the **canonical** `user.userId` | `features/prompts/routes.ts:22` → `readableBy(e, user.userId)` |
| 4 | The prompts routes' `createEntry` uses that canonical id, so the two lanes disagree | `features/prompts/routes.ts:29` |

So an entry imported by an unbound OIDC/bearer caller is stamped
`createdBy: 'oidc:<sub>'` while every read compares `user:<hash>` — and when
`callerSubject` is undefined the row is stamped the literal string `'import'`,
which **no `user.userId` can ever equal**. Combined with the `private` default,
those rows are readable by **nobody**: invisible in the catalog, still returned
by `listEntriesUnfiltered` on the next export, and unrepairable through the read
lane.

**This is a fix that already exists in-repo and was not transferred.**
`promptSurface.ts:19-29` documents precisely this hazard for the workflow surface
— *"a run's `actingUserId` is the RAW `req.userId ?? principalId`, so an
unbound-OIDC/bearer owner arrives as `oidc:<sub>` while their `createdBy` is
`user:<hash>` … Without this an owner is locked out of their OWN default-private
prompt"* — and canonicalizes with `userIdFor`. The import path needs the same
treatment and never got it.

- **D3a** — canonicalize the actor at the import call site with the **same**
  `userIdFor` rule `promptSurface.ts:29` uses, so `createdBy` lands in the id
  space reads compare against.
- **D3b — CORRECTED DURING IMPLEMENTATION; the first version was a privacy
  downgrade I nearly shipped.** It read: *"default an unspecified import to `org`
  — an import is an explicitly org-scoped act."* Two facts falsify it:

  1. **The exporter never carried `visibility` at all**
     (`portabilityService.ts:284-290` as it stood), so the "carry the bundle's own
     visibility" clause could *never fire* on a bundle this host produced.
  2. Therefore **every** self-exported entry would hit the default — and every
     round-tripped **`private`** prompt would come back **`org`-visible**.

  My fix would have created a fresh instance of the class it closes. The corrected
  decision: **export carries `visibility`**, import **preserves** it, and an
  unspecified import defaults to the conservative **`private`**.

  The `org` default was never needed, because **D3a is what actually closes
  `PLC-7`**: with `createdBy` in the id space reads compare against, an imported
  `private` entry is readable by *its importer* rather than by nobody. "Readable by
  nobody" was the defect; "readable only by the importer" is ordinary private
  semantics, not a bug to fix by widening everyone's ACL.

  (This does not touch the separate, known export-side leak: the exporter reads
  `listEntriesUnfiltered`, and co-residency leakage of prompts is tracked as the
  still-open **`CPC-16`** at `features/portability/routes.ts:66`.)
- **D3c** — refuse the `'import'` fallback for this handler rather than writing an
  unownable row. A row nobody can read is worse than a refused import.
- **D3d** — the witness, as shipped (`test/prompt-visibility-authority.test.ts`):
  - `6b` drives `applyImport` with a raw (`oidc:`) subject and asserts the row's
    `createdBy` lands in the canonical space and the importer can read it.
  - `6c` asserts a subject-less import **skips** rather than minting an unownable row.
  - `6d` asserts a **round trip preserves visibility in BOTH directions** — a
    `private` entry stays private and an `org` entry stays org. This is the leg that
    would have caught the D3b downgrade above, and it does: sabotaging with that exact
    pair (export drops `visibility` + import defaults `org`) reds `6b` and `6d`.

  Two fixture traps found writing these, recorded so the next author does not
  rediscover them: the exporter walks `listOrgs(tenantId)`, so entries written under
  a bare `orgId` string export **nothing** (a real `createOrg` is required, or the
  assertion is unreachable); and `createUserTemplate` is **global** (no `tenantId`),
  so seeding the same template twice in one test returns `ok:false`.

**D3e (added after measuring the witness) — the rule and the wiring must be pinned
SEPARATELY, because the first version of this witness pinned only the rule.**
Sabotaging `canonicalPromptActor` itself reds two pre-existing surface tests. But
reverting the **portability call site** to the raw actor — re-introducing `PLC-7`
verbatim — left **all 35 tests GREEN**. The witness proved the helper worked and
said nothing about whether the importer used it, which is the entire defect. Legs
`6b`/`6c` now drive `applyImport` end-to-end; the same sabotage reds `6b`.

This is why D3a's fix is *also* a consolidation: the canonicalization rule now
lives once, beside `createEntry` which defines the id space, with three callers.
It had been an inline expression in `promptSurface.ts` — **and that is precisely
why the importer never received it.** A rule that lives at one call site is not a
rule; it is a local habit the next call site cannot inherit.

## Stale rows — five filed rows are closed at HEAD

Verified by grepping the mechanism and its gate, not the symbol:

- **`PLC-1`** (private not enforced on read) — **CLOSED**, `:113-122`.
- **`PLC-2`** (version pin) — **CLOSED**, `resolvePromptRef` `:67`;
  `parsePromptRef` handles leading/trailing `@` and ids containing `@`.
- **`PLC-5`** (sharing MINT bypasses private) — **CLOSED** by ADR 0644 D1.
  Confirmed not a weaker copy: `sharingService.ts:33` imports
  `readableBy as promptReadableBy` — an **alias of the identical function**.
- **`PLWF-1`** (= `PLC-2`) and **`PLWF-2`** (= `PLC-1`) — **CLOSED** with their
  twins. `promptSurface.ts:28-29` additionally canonicalises the caller into the
  id space `createEntry` stamps, so an unbound-OIDC owner is not locked out of
  their own private prompt.

The workflows tracker still shows `PLWF-1`/`PLWF-2` open and its **B− rested on
both** — the same stale-carried-row pattern as it.31/it.32.

## Superseded first draft — why it was wrong

The first draft's D1 claimed "every UI-created prompt is private forever",
resting on the FE create payload omitting `visibility`. `/architect` falsified it:

- **The surfaces were conflated.** `prompts/PromptLibraryPage.tsx:11` imports
  `./promptsClient.js` → `/v1/prompts` and writes a `PromptTemplate` via
  `upsertUserPrompt` (`:363-391`). That is the prompt **store** page. The ADR
  0116 **catalog** is a different surface.
- **The catalog has no create UI at all.** `createPrompt`
  (`client/promptLibraryClient.ts:36`) has **zero callers** — the only other
  textual hits are an i18n key for the store page's button. So the claimed
  population does not exist, and `PLC-3`'s "every UI-created entry defaults to
  private" was already mis-stated when filed.
- **The severity-interaction narrative was therefore invented.** It asserted that
  `PLC-1` converted a cosmetic gap into a functional outage. There was no
  cosmetic gap, because there were no UI-created entries.

**The transferable lesson: a file named for a feature is not evidence it
implements that feature.** `PromptLibraryPage.tsx` is not the prompt library. The
check that would have caught it in minutes — and that the first draft skipped —
is *"who calls this client function?"* before reasoning about what its callers do.

## RFC verdict

**No RFC.** Host-ext throughout. D1 tightens authorization on an existing
non-normative route under `/v1/host/openwop-app/prompts/*`; D2 corrects a comment
and a pack `role` field the executor does not read; D3 changes an import default.
No wire shape, no capability advertisement, no conformance claim.

## Open questions

1. **`deleteEntry` (`:193`) keeps org-scoped authority.** Deliberately out of
   scope — destroying is not granting — but a writer deleting a co-member's
   private prompt is arguably the same asymmetry. Needs its own evidence.
2. **D1's id-space residue — MEASURED, and D1a is safe.** `updateEntry` has
   exactly ONE caller (`features/prompts/routes.ts:58`) and it passes
   `user.userId` from `requireOrgScope`, the same canonical id `createEntry`
   stamps at `:29` and `listEntries` compares at `:22`. So D1a's `readableBy`
   check runs in the right space. **The sharing path is the residue**: it passes
   `caller?.subject` raw (`sharingService.ts:405`). If those spaces differ an
   owner is refused sharing their OWN prompt — **fail-closed, so not a leak**,
   which is why it is an open question and not a row. Same root cause as D3.
3. Whether `createdBy` should be erased on a DSAR. It is an ACL predicate, not
   metadata, and prompts registers no subject eraser. **Not filed**: tenant
   teardown is already covered (`prompts:entry` auto-registers in
   `HOSTEXT_COLLECTIONS` via the `DurableCollection` constructor and is walked by
   `purgeTenantHostExt`), and RFC 0048 principals are opaque.

## Status correction (2026-09-17)

This record read `Status: Proposed` while its decision was already merged in **#3848**. It was on the steward staleness baseline (`backend/typescript/test/steward/adr-status-not-stale.test.ts`) as *flagged but unverified*; the status above was established by reading the code, not the commit message.

**Evidence.** D1a `features/prompts/promptLibraryService.ts:219-223`; D2a `features/prompts/promptSurface.ts:11-25`; D2b `packs/feature.prompts.nodes/pack.json:23,32,41` all `role:"read"`, pack 1.1.0; D3a-e `features/portability/portabilityService.ts:296,330,332,348` + shared `promptLibraryService.ts:106 canonicalPromptActor`.

**This record landed as ADR 0688 and was renumbered to 0694** (`7b4b350fa`, git `R099`), so NO commit subject names "ADR 0694" for it. The subject that DOES name 0694 — `ccab9131d` — implemented the usage-rollup record that is now **0695**. A subject-grep ratchet therefore mis-attributes this slot in both directions: a false positive here, and a false negative for the renamed record. **D1b deviation:** the ADR asked for a route-level witness; the shipped witness is service-level. `features/prompts/routes.ts` is the sole `updateEntry` caller and passes the canonical `user.userId`, so the gate is exercised in the right id space, but the route lane itself is unpinned.
