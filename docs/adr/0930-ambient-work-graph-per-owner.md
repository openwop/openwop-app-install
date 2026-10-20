# ADR 0930 — Ambient work graph: patterns belong to the person who did the work

Status: implemented (2026-10-18; accepted after the adversarial `/architect` pass, whose corrections A1–A12 and the closing-grade corrections C1–C2 below override the decision text they name)
Date: 2026-10-18
Extends: ADR 0137 (Ambient Work Graph). Composes: issue #4543 (`host/runPayloadAccess.ts`), ADR 0625 /
RFC 0165 run owner (`host/runOwner.ts`), ADR 0464 subject erasure, ADR 0072 workflow author, RFC 0096
proposals (`features/proposals`).
Feature-loop round 2 row 52. Grade: `/grade-workflows ambient-work-graph` → **C**
(`docs/steward/WORKFLOWS-ASSESSMENT.md` § "Ambient work graph — feature loop round 2 row 52").

## Context

The feature says "you've done this N times, make it a workflow?". The code says something else. One
sweep reads the tenant's newest 500 completed runs, clusters every run by `agentId | tool sequence`,
and writes one tenant-wide row per pattern. Every member reads every row, and any writer decides
(dismiss, accept) for every row. 7 of 12 probes were RED on `ed18b10ad`
(`backend/typescript/test/ambient-work-graph-r2.test.ts`):

| Gap | What happens on `main` |
|---|---|
| `AWG2WF-1` Blocker | A Viewer reads another member's tool sequence, run ids and goal text. Issue #4543 withholds exactly this (payload + event payload) from a non-admin on every run read. |
| `AWG2WF-2` Blocker | An Editor's Scan mines and returns other members' runs. |
| `AWG2WF-3` High | Another member can dismiss your pattern, or accept it and get an RFC 0096 proposal whose provenance is your runs. |
| `AWG2WF-4` Medium | Store writes are read-then-blind-put. A sweep that raced a dismiss writes `suggested` back. |
| `AWG2WF-5` Medium | Host-fired runs (no owner) are suggested as manual work. |
| `AWG2WF-6` Medium | `:fork` copies events, so two runs plus a fork reach the threshold of 3. |
| `AWG2WF-7` Medium | No subject eraser. `sampleGoal` is declared PII; nothing erases it. |
| `AWG2WF-8` Medium | Scan reads events for every one of up to 500 runs on any Editor's POST. |
| `AWG2WF-9` Low | `FEATURES.md` and ADR 0137 say "opt-in". The feature is always-on and there is no control at all. |

**The market scan says the same thing.** The work-patterns round-2 scan
(`docs/steward/UX_UPGRADE-boards.md` § "Work patterns … ROUND 2") names Microsoft Viva Insights as
the reference: personal insights are visible **only to the individual**, an org view exists only
behind a minimum group size plus differential privacy, and **opting out stops processing, not just
display**. That scan graded us "opt-in, tenant-scoped" and said we exceed the field on privacy. Both
claims were false: there is no opt-in, and tenant-scoped meant every member.

## Boundaries audit

| Concern | Single owner (file) | Decision |
|---|---|---|
| Who a run belongs to | `host/runOwner.ts` `runOwner` / `isRunOwnedBy` (ADR 0625) | Reuse. Owner = the RFC 0165 owner principal. No second ownership rule (row 50's lesson: the task deck had one and disagreed with the home tiles). |
| Who may read a run's payload | `host/runPayloadAccess.ts` (#4543) | The work graph exposes payload-class data (tool names, agent ids, goal text), so it may never show more than this rule allows. Per-owner mining stays strictly inside it, even for admins (D1). |
| Fork / redrive provenance | `RunRecord.forkMode` (`types.ts:84`); `metadata.redriveOf` (reserved, `runDispatch.ts:81`) | Read both to exclude re-executions (D2). |
| Suggestion persistence | `DurableCollection` `compareAndSwap` (`hostExtPersistence.ts`) | Use it for every write (D4). No new store type. |
| Subject erasure | `registerSubjectEraser` + `EXPECTED_SUBJECT_ERASERS` manifest | A new named eraser (D5). |
| A personal privacy switch | `features/settings/prefsStore.ts` `PrivacyPrefs` | **Not reused.** It is keyed `(tenant, userId)`, but runs are owned by an opaque principal derived from the session subject, and the daemon has only the principal. Keying the pause by `(tenant, opaquePrincipal(callerSubject))` in this feature makes the route and the daemon agree by construction (the "two identity keys" trap, rows 4 and 7). |
| Accept → workflow | ADR 0072 author via the builder Pair thread; RFC 0096 proposal | Unchanged, except that it only ever sees the caller's own pattern. |

No route collision: every new route sits under the existing
`/host/openwop-app/work-graph/orgs/:orgId/` prefix.

## Decision

**D1 — Mine and store per owner.** A run belongs to `runOwner(run).principal`. The sweep groups
runs by owner and clusters within each owner only. A suggestion row gains `ownerPrincipal`, and its
id becomes `hash(tenantId, ownerPrincipal, signature)`. `GET`, `refresh`, `dismiss` and `accept`
serve the caller's rows only, where the caller is `opaquePrincipal(callerSubject(req))` (the projection
`ownRuns.ts` and `runPayloadReader` use). Another person's row is a 404, the same as an unknown id.
**Admins get no wider view.** "You have done this" is personal. An aggregated team view would need
Viva's minimum-group-size rule and is filed (OQ-2), not built.

**D2 — Mine only work a person started by hand.** Three kinds of run are excluded before any event
read:
- runs with no owner (host-fired schedules, heartbeats, webhooks, which are already automated);
- forks (`forkMode` set);
- redrives (`metadata.redriveOf`).

The personal-workspace rule from #4511 ("every run is mine") is deliberately NOT applied. An
unstamped run in a personal workspace is host-fired, so D2's reasoning holds there too.

**D3 — A bounded Scan.** `refresh` mines only the caller's runs: the tenant's newest 500 completed
runs, filtered to the caller's own before any `listEvents`. Event reads are bounded by the caller's
own run count (≤ 500), not the tenant's. The daemon does one tenant scan and one event read per
owned, non-excluded run, and then groups.

**D4 — Decisions are compare-and-swap.** `upsertSuggestion` and `setSuggestionStatus` retry on
`compareAndSwap`. A sweep never overwrites `dismissed`/`accepted`, because the merge happens inside
the CAS on the row it read. A decision also re-checks `ownerPrincipal` on that same row.

**D5 — Subject erasure.** `eraseAmbientWorkGraphSubject(tenantId, subjectKey)` deletes the subject's
suggestion rows and pause row, matched by `opaquePrincipal(subjectKey)`. It is a delete rather than a
redaction: the row is that person's behavioural profile, not org content. It is a named function,
registered at feature boot and added to `EXPECTED_SUBJECT_ERASERS` (manifest count +1). The
proposal a person accepted keeps the RFC 0096 redaction its own eraser already does.

**D6 — Legacy tenant-wide rows are never served.** A stored row without `ownerPrincipal` came from
the old tenant-wide sweep and cannot be attributed. It is never returned. The next sweep that touches
the tenant deletes it (route and daemon). Its dismissed/accepted state is lost, which is correct
because nobody owned that decision. The prod count of these rows is a read-only question for the
lead (Q1).

**D7 — A personal pause that stops processing.** `GET`/`PUT
…/work-graph/orgs/:orgId/settings` `{ paused: boolean }`, per `(tenant, owner principal)`, needs
`workspace:read`. It covers the caller's own data only, so any member may set their own. While paused:
- neither the route nor the daemon reads that person's runs' events;
- their stored suggestions are deleted when the pause is set;
- `refresh` returns `{ suggestions: [], paused: true }`.

This is the Viva semantics ("opting out stops processing"). The pause is per workspace, because a
person's runs are per workspace. The page says so.

**D8 — The surface reads runs, so it needs `runs:read`.** Every route calls
`requireProtocolScope(req, 'runs:read')`, the same scope `GET /runs` and the task deck need. Today
only a session reaches these routes (`resolveCallerUser`; a key is refused with 401), so this is
defence in depth for the day a key lane does reach them.

**D9 — Honest copy and docs.** The page heading and lede say "patterns in **your** runs" and name the
three exclusions. FEATURES.md and ADR 0137 drop "opt-in" for the truth: always-on, personal, with a
pause. ADR 0137 gets a correction note.

### Data model (changes only)

```ts
WorkflowSuggestion {
  …existing fields,
  ownerPrincipal: string;   // NEW — opaquePrincipal of the run owner; required on every new row
}
// id = `ws-${hash(`${tenantId}:${ownerPrincipal}:${signature}`)}`

WorkGraphPause {           // NEW collection 'ambient-work-graph:pause', tenant-indexed
  id: `${tenantId}:${ownerPrincipal}`; tenantId; ownerPrincipal; paused: true; updatedAt;
}
```

A pause row exists only while paused (unpausing deletes it), so absence means "not paused".

## Evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | Stays in `features/ambient-work-graph/`. A new `erasure.ts` and `pauseStore.ts`; no core edits beyond the eraser manifest line. |
| 2 | Toggle + admin UI | None. Always-on since ADR 0134 graduation; no toggle is reintroduced. The control is personal (D7), not an admin switch. |
| 3 | Workflow surface | None (unchanged). The feature produces workflows through ADR 0072; it exposes no `ctx`. |
| 4 | Node pack | None. |
| 5 | AI-chat envelopes | None. The accept seed goes into the existing Pair thread. |
| 6 | Agent pack | None. No chat-time tool exists or is added, so the "tool shares the route predicate" rule has no instance. |
| 7 | Public surface | None. |
| 8 | RBAC + isolation | Session + `requireOrgScope` (`workspace:read` / `workspace:write`) + `runs:read` (D8); per-owner rows (D1); 404 for another person's id. |
| 9 | Replay / fork | The projection never influences a run. Forks and redrives are excluded from mining (D2). The id hash stays pure. |
| 10 | Frontend | `WorkGraphPage`: personal copy, the pause switch, a paused empty state, 4-locale i18n. |

## Phased plan

1. **Store + sweep (D1–D4, D6).** Owner field and id, exclusions, owner-grouped clustering, CAS
   writes, legacy purge. Probes S1, S3 and the ownerless leg go green.
2. **Routes (D1, D3, D7, D8).** Owner-only reads and decisions, the bounded Scan, the pause routes and
   `runs:read`. Probe S2 goes green, with new pause probes.
3. **Erasure (D5).** Eraser, manifest, and an ADR 0464-style witness.
4. **Frontend + docs (D7, D9).** Page copy and the switch, i18n ×4, FEATURES / ADR 0137 corrections.

## Alternatives weighed

1. **Apply #4543's rule as-is (admins see every member's patterns).** Rejected. The payload rule
   answers "may this person read that run". The work graph answers "what have *you* been repeating",
   and clustering everyone's runs into one list for an admin is a behavioural report about other
   people. Viva puts that behind a minimum group size. OQ-2 files it.
2. **Keep tenant-wide rows and filter them on read.** Rejected. One row mixes several people's runs
   (`exampleRunIds`, `count`), so no per-reader filter can make it honest, and decisions stay shared.
3. **Reuse `settings` `PrivacyPrefs` for the pause.** Rejected (boundaries audit): a different
   identity key from the one runs carry.
4. **Migrate legacy rows to an owner.** Rejected. A row is a cluster across owners, so it has no
   single owner to assign.

## Open questions

- **OQ-1 — CLOSED 2026-10-18 by the prod read below (§ "Prod exposure and coverage").** The question was whether mined runs are mostly runs of an existing workflow. They are worse than that: the only completed tool-calling runs in prod are `conformance-noop`. Original text:
  **Already-a-workflow noise (`AWG2WF-10`).** If prod shows that most mined runs are runs of an
  existing workflow, should the signature skip runs whose workflow is tenant-owned? This waits on the
  lead's read-only Q2/Q3. It is not built blind.
- **OQ-2 — A team view.** An aggregated, k-anonymous view (Viva min group 5–10) is a separate ADR, if
  ever.
- **OQ-3 — Legacy accepted proposals.** RFC 0096 proposals minted from legacy tenant-wide accepts
  (`wg:ws-*`) may cite other members' runs. That store is row 53's (proposals). Filed there with the
  prod count (Q5).

## RFC verdict

**Host-extension, no RFC.** Every route is under `/host/openwop-app/work-graph/*`. No run-event field,
capability, event type or normative MUST changes. The owner stamp is read, never written.

## Adversarial `/architect` pass — corrections (2026-10-18, verdict GO-with-corrections)

The pass found 3 HIGH and 7 MEDIUM in the text above. Every correction below replaces the decision it
names. The original text is kept so the reasoning trail stays readable.

- **A1 (HIGH, overrides D5) — erasure must last.** Run records are exempt from erasure (ADR 0464 §4),
  so the erased person's runs keep their owner stamp and the next sweep would rebuild the profile.
  The eraser therefore deletes the rows **and writes a durable suppression row** (the D7 pause row with
  `reason: 'erased'`). The sweep honours it exactly like a pause. Witness: erase, re-sweep, zero rows.
  The same person can lift it later with an explicit `PUT paused:false`, which is a new act of consent.
  Personal-workspace rows (A5) are not matched by principal. Account deletion's tenant teardown covers
  them (the collection's `tenantOf` index), and a contact-DSAR in a personal tenant must not wipe the
  owner's own patterns.
- **A2 (HIGH, adds to D4/D6/D7) — deletes need guards that a sweep in flight cannot outrun.** Order:
  a pause or erasure writes the suppression row FIRST, then deletes. The sweep reads suppression before
  it mines an owner and again after its writes for that owner; if it is now present, it deletes what it
  wrote. Every read route also drops rows whose owner is suppressed, so a row a race resurrects is
  never served.
- **A3 (HIGH, new decision D10) — accept is a share, and says so.** `createProposalFromAcceptedPattern`
  puts `sampleGoal` into the proposal title and artifact, and `GET /proposals` lists proposals to every
  member of the tenant. So accept published the personal pattern to the workspace. From now on:
  - the accept passes no `sampleGoal` to the proposal, so the title is the generic "Automate a recurring
    N× pattern";
  - its provenance is the owner's own runs only (which D1 already guarantees);
  - the button copy says that making a workflow shares the step pattern with the workspace as a proposal.

  The `draftSeed` returned to the owner keeps `sampleGoal`, because it goes into their own Pair thread.
- **A4 (MEDIUM, corrects the Context table) — the #4543 premise was overstated.** `metadata.goal` is
  caller metadata (`routes/runs.ts:721-723`). It is surfaced unchanged on the snapshot to every
  `runs:read` member, and run ids are listable by every member. What #4543 really withholds and the
  work graph leaked is the tool-name sequence and agent id (event payloads, `EVENT_PAYLOAD_KEEP`).
  D1 stands on its own ground, the market scan's: a cross-run behavioural profile belongs to the
  person it describes. Caller metadata reaching Viewers is #4543's own question, and it is filed there
  (`AWG2-F1`).
- **A5 (MEDIUM, overrides D2's personal-workspace sentence) — the personal workspace is one bucket.**
  "An unstamped run in a personal workspace is host-fired" is false (notebooks, podcasts and channels
  start ownerless runs from human HTTP lanes). Worse, the legacy `actingUserId` fallback uses the
  spelling current at create time, so per-principal grouping would strand a user's pre-bind runs in a
  bucket no session reads. So in a personal tenant (`isPersonalTenantId`, not `anon:`), every OWNED
  run belongs to one owner key, `personal`. The route uses that key when `isOwnPersonalWorkspace(req)`;
  the daemon uses it for a `user:` tenant. Ownerless runs stay excluded everywhere. They are
  pipeline runs (OQ-1), and the copy says "runs you started".
- **A6 (MEDIUM, adds to D2) — exclude workload and anonymous owners; skip `anon:` tenants.** API-key,
  env-key and test-seam runs are stamped `kind: 'workload'` (`runOwner.ts:108-118`), and anon runs carry
  `anonPrincipal`. No session can ever read as either, so mining them would only store PII nobody can
  see. The daemon skips `anon:` tenants (`isAnonTenantId`).
- **A7 (MEDIUM, overrides the id in the data model) — a collision-resistant id, verified inside the
  CAS.** `stableHash` is 32-bit djb2 in a global keyspace, so per-owner rows make birthday collisions
  plausible, and a CAS would merge over a stranger's row. The id becomes `ws-` + the first 24 hex of
  `sha256(tenant:ownerKey:signature)`. The upsert also refuses (logs and skips) a read row whose
  `tenantId`, `ownerPrincipal` or `signature` differs from the detected one.
- **A8 (MEDIUM, adds to D4/D7) — a state machine, and pause keeps dismissals.**
  - Legal transitions:
    - suggested → dismissed | accepted;
    - accepted → accepted, which is idempotent and returns the seed again;
    - accepted → dismissed, which removes it from the list;
    - dismissed → dismissed is idempotent;
    - dismissed → accepted is a 409, because the page never shows a dismissed row.
  - A pause deletes every non-dismissed row. A dismissed row is cut down to a signature-only
    suppression, with no evidence, count or goal. So unpausing never brings a dismissed pattern back.
- **A9 (MEDIUM, overrides D3) — bound the rows and say the recall limit.** Scan pages
  `listRuns({tenantId, status:'completed', before})` 200 at a time. It stops at 1,000 rows scanned or
  200 owned runs collected, and reads events only for the owned runs. The response carries
  `scanned`/`truncated`, and the page says "your runs among the workspace's 1,000 most recent". The
  daemon reads the tenant's suppression rows once per pass, not once per owner.
- **A10 (MEDIUM, residue) — the pause key follows the auth lane.** Runs stamped from an unbound
  bearer carry `opaque(oidc:sub)`, while a cookie session carries the bound spelling. A pause set from
  one lane does not cover runs stamped from the other. `ownRuns.ts` shares this residue. Filed as
  `AWG2-R1`, not fixed here.
- **A11 (LOW, overrides D8's placement).** `runs:read` is checked AFTER `requireOrgScope`, so a
  non-member still gets the org 404. It is a no-op unless `OPENWOP_AUTHORIZATION_ENFORCEMENT=true`
  (apart from `owk_` key narrowing). It is defence in depth, as D8 says.
- **A12 (LOW, overrides the RBAC row).** The data is personal, so `refresh`, `dismiss` and the pause
  need `workspace:read`, which lets a Viewer manage their own patterns. `accept` stays
  `workspace:write`, because it mints a tenant proposal (A3).
- Notes: F13 (a new-id accept mints a second `wg:` proposal beside a legacy one) joins OQ-3. F14: the
  eraser returns a `SubjectEraseReport`, and erasure is per tenant, as for every eraser. F15: the
  `PrivacyPrefs` rejection is about keeping one identity key in one place, not impossibility.

## Closing-grade corrections (2026-10-18, `/grade-code` D+ and `/grade-ux` D on the branch)

As on every row of this loop, both Blockers were in this ADR's own fix.

- **C1 (Blocker `AWG2CD-1`, overrides A5): there is no personal bucket.** A personal workspace
  can have members: its root org takes `POST /orgs/user:X/members`, and the member can switch
  in. Under A5, every owned run in a `user:` tenant was keyed `personal`, so the owner's Scan
  returned a member's tool sequence, run ids and goal text. This was reproduced over HTTP.
  Runs are now keyed by their stamp's principal in every tenant, and the eraser matches
  personal workspaces like any other.
- **C2 (High `AWG2CD-2`, overrides D2's "ownerless" rule): only stamped runs count.** The
  scheduler daemon, the assistant loops and other host lanes write `actingUserId` with no
  owner stamp. `runOwner`'s legacy fallback therefore gave an hourly cron a person, so it
  could have been suggested as "you did this 24 times". A run counts only if it carries the
  RFC 0165 owner stamp. Runs carrying a host attribution block (`schedule`, `heartbeat`,
  `kanban`, `approval`, `eval`), a redrive, a delegated child (`parentRunId`) or a fork are
  excluded too. The cost is pre-stamp history, before 2026-09-02. My ownerless witness had
  seeded `metadata: {}`, a shape no real scheduled run has; the new witness seeds the
  shapes the host writes.
- Also fixed:
  - `AWG2CD-3`: accept re-checks the pause after the decision, so no proposal is minted for
    a profile its owner just withdrew.
  - `AWG2CD-4`: erasure deletes the tenant's legacy rows.
  - `AWG2CD-6`: a pause re-reads a row before deleting it.
  - `AWG2CD-7`: `truncated` is true at the owned-run cap; the daemon skips the probe.
  - `AWG2CD-8`: suppression writes are compare-and-swap.
  - `AWG2CD-12`: dismiss is refused while paused.
  - `AWG2UX-15`: `GET settings` returns `reason`.
- `AWG2CD-11` is closed as unreachable: an anonymous session gets 401 from `requireOrgScope`,
  which was probed. The daemon's `anon:` skip stays, and it is witnessed.
- **Residue and filed items:**
  - `AWG2-R1`, the auth-lane spelling (A10). It also reaches erasure (`AWG2CD-5`).
  - `AWG2CD-9`: tombstones for every key form of a DSAR.
  - `AWG2CD-10`: per-owner reads scan the tenant's rows.
  - `AWG2-F1`: caller metadata reaching Viewers, a #4543 question.
  - OQ-1 to OQ-3.
  - The UX residue: `AWG2UX-7` undo, `AWG2UX-9` gating on effective access (refusals are
    mapped instead), and `AWG2UX-14` raw tool ids.

## Implementation record

| Phase | What | Commit |
|---|---|---|
| grade + RED probes | `/grade-workflows` C; 7 of 12 probes RED on `ed18b10ad` | `e875a0d71` |
| 1–3 | per-owner store + sweep + routes + pause + eraser (D1–D8, A1–A12) | `73eeec746`, `f01db26ed` |
| 4 | personal page, pause, scan bound, doc corrections (D7, D9) | `59628f168`, `85c6d3f8d` |
| closing grades | C1, C2 and the `AWG2CD`/`AWG2UX` fixes | `a52dee16c`, `c427716c3` |
| coverage honesty | prod exposure + coverage section, honest empty state, `AWG2-R2` filed | `d5fb5dc0f` |
| merged | PR #5011, train `4991 5011 4999` (openwop-app-0b) | `abab8eb21` (main `b0ff69efa`) |

Witnesses: `backend/typescript/test/ambient-work-graph-r2.test.ts` (41 tests). Every backend
fix was sabotaged on a clean tree, and every sabotage turned a test red (the log is in the
PR). Also `frontend/react/src/features/ambient-work-graph/__tests__/workGraphPersonal.test.tsx`,
whose FE sabotages all went red.

## Prod exposure and coverage (measured 2026-10-18)

Measured by the team lead, read-only, in a ROLLBACK transaction, counts only:

| Measure | Value |
|---|---|
| `host_ext_kv` rows `hostext:%` (floor) | 140,609 |
| completed runs (floor) | 27,258 |
| stored work-graph suggestions | **1** (`suggested`, 1 tenant) |
| RFC 0096 proposals from work-graph accepts (`wg:ws-*`) | 0 |
| background sweep daemon (`OPENWOP_WORKGRAPH_SWEEP_ENABLED`) | **ON** |
| completed runs with `agent.toolCalled` events | **18**, all `conformance-noop`, all unstamped |
| `agent.toolCalled` runs by status | completed 18 · waiting-input 8 · cancelled 4 |
| chat conversation runs (`openwop-app.conversation`) | **61**, all `waiting-input`, **0 completed** |
| completed runs carrying `metadata.owner` | 18,006 |
| completed AND owner-stamped AND with `agent.toolCalled` | **0** |

**Exposure.** AWG2WF-1 was live, but it was nearly unexercised: 1 stored suggestion, almost
certainly mined from conformance runs, and no proposal was ever minted from an accept. The D6
legacy purge removes that 1 row on its tenant's next Scan or daemon pass.

**Coverage. After D1 and C2, the miner finds nothing in prod today.** That is the honest end
state of this ADR, not a regression it introduced. Even before this ADR, the feature had
nothing real to learn from, for two reasons:
- The sweep reads only `completed` runs. A chat conversation run is one long-lived run that
  stays `waiting-input` (61 of 61), so the place people actually repeat tool sequences is
  never read.
- The only completed tool-calling runs are unstamped conformance fixtures, which C2 rightly
  excludes.

Security stays as decided: no unstamped run is ever counted. The feature's value claim is
corrected instead. FEATURES.md and the page's empty state now say that patterns come only
from completed, owner-stamped runs that called tools, and that such runs are rare today.

**Residue `AWG2-R2` (filed, not built here) — mine the work people actually do.**
- **Recommendation:** mine *settled tool-call windows* inside conversation runs, not
  completed runs. One window is one user turn's `agent.toolCalled` sequence, closed by the
  turn's `conversation.exchanged` reply.
- Each window would be keyed to the turn's author, the RFC 0165 owner of the conversation
  run, with the C2 exclusions applied per window.
- The same per-owner store, pause, eraser and CAS carry over unchanged. Only the gatherer
  (`collectRuns` / `toInput`) changes.
- It needs its own ADR. A window must be settled (no open tool call) so a replay or `:fork`
  of a live conversation cannot double-count it. It also needs a per-window idempotency key.
- The alternative, mining whichever event types real runs emit, is weaker. Workflow runs
  are already workflows, and the outcome would be the "make this workflow a workflow" noise
  OQ-1 asked about.
