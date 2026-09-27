# ADR 0460 — KickTodo honesty reads + the admin exception projection

Status: implemented (P1 #2320; P2 this branch) — 2026-07-21
Date: 2026-07-21
Relates: ADR 0458 (whose data unblocks these reads), ADR 0437/0438 (the design law that deferred these surfaces "blocked on data"), ADR 0415 (gates), ADR 0068/0074 (reviews projection precedent)
TODO refs: `docs/steward/TODO.md §6` KT-PORT-4, KT-PORT-5

## 1. Context

The 0437/0438 experience ADRs deferred four surfaces as "blocked on backend
reads," and the 0458 audits classified them THEATER-adjacent (a designed
surface with no data behind it). ADR 0458 built the data for three of them;
the fourth needs a projection, not a store:

- **Gate Center** (KT-PORT-4): `publishService.assertGates` is now FIVE
  executing checks (evidence, claims, rights, safety, simulation) — but no
  read exposes per-gate pass/open, so the workspace still can't render the
  matrix honestly.
- **Simulation panel** (KT-PORT-4): `candidate.simulation` is durable, typed,
  persona-keyed — unrendered.
- **Lesson/day build status** (KT-PORT-4): derivable from the durable plan
  revision + lesson-media pointers — unrendered.
- **The admin command center** (KT-PORT-5): the 0438 Exception Ledger Row
  never got its aggregate feed. The audits' verdict stands: build it as a
  **projection over the owners that already hold the exceptions**, exactly
  like `host/reviewProjection.ts` — never a second store.

## 2. Boundaries audit

- Per-gate status: the gate functions exist in `publishService`; the read is
  a pure re-evaluation returning `{gate, state: pass|open, detail}` — no new
  state, no bypass (the write-path re-checks at submit AND complete stay
  authoritative; the read is display-only and says so).
- Exception sources already owned: approvals queue (shared owner), monitor
  findings (kicktodo-creator), payout runs awaiting evidence
  (kicktodo-commerce), review flags (kicktodo-community), stale wearable
  streams (kicktodo-integrations). Each owner exposes its exceptions; the
  projection composes — the keyed-registry contract (repeat boots overwrite;
  a source that fails is reported degraded, never silently empty).

## 3. Decision

1. **Reads (kicktodo-creator surface + routes, manage-gated):**
   `gateStatus(candidateId)` (five rows, display-only, re-derived),
   `simulationVerdicts(candidateId)` (the durable record verbatim),
   `lessonStatus(candidateId)` (per-day: enriched? media? from plan revision
   + pointers). The Studio workspace renders: the honest 5-gate matrix
   (server truth, never all-green it can't back), the three-persona verdict
   panel (findings verbatim), the day strip.

   > **Correction note (Phase 1 impl, 2026-07-21 — /architect honesty gate):**
   > Two words in the paragraph above were painted-status traps the grounding
   > pass caught, and the implementation corrects them:
   > 1. **`gateStatus` five rows, but only FOUR are enforced.** The write path
   >    (`publishService.assertGates`) throws on `evidence → claims → safety →
   >    simulation` only; **`rights` is NOT an independent gate** — blocked-domain
   >    sources are folded into the `claims` predicate. So the matrix surfaces
   >    `rights` as an **informational disclosure row** (`informational: true` —
   >    which domains were rights-blocked), visually distinct from the enforced
   >    pass/fail rows, never implying an enforcement that isn't there. The
   >    predicates are extracted ONCE (`evidenceGate`/`claimsGate`/`safetyGate`/
   >    `simulationGate`/`rightsGate`) and shared by `assertGates` (throws first
   >    open, byte-identical order + messages) and `evaluateGates` (returns all
   >    five) — one source of truth, pinned by a parity test.
   > 2. **`lessonStatus` drops `enriched?`.** The rich lesson body is *ephemeral
   >    node output* with no host SSoT (`packs/feature.kicktodo.nodes/index.mjs`
   >    — "a lesson is node output shown at the checkpoint gate, never durable
   >    domain state"); an `enriched:true` flag would be painted status. The read
   >    reports only the honest DURABLE signals: `planned` (the day exists in the
   >    validated plan revision) + `hasMedia` (a `LessonMediaPointer` row exists)
   >    + `mediaKind?`. This is exactly the OQ2 "no painted status" discipline.
2. **The exception projection (host seam + kicktodo-admin consumer):**
   `registerExceptionSource(key, fn)` keyed registry in host (the
   reviewProjection/lifecycle contract); each kicktodo package registers its
   source over its OWN store; `listExceptions(tenant)` composes with
   per-source degradation reported. `kicktodo-admin`'s command center renders
   the 0438 Exception Ledger Row grammar (severity BY SHAPE + label, mono id,
   server-authoritative owner, ONE safe action deep-linking the owning
   surface, audit expander). The projection is app-generic by construction —
   other features may register sources later; this ADR ships only the
   kicktodo five.

## 4. Evaluation matrix (deltas only)

| Dimension | Verdict |
|---|---|
| Feature-package | EXTENDS kicktodo-creator + kicktodo-admin; ONE new host seam file (projection registry — the reviewProjection sibling) |
| Toggle | none new (kicktodo-creator / admin authority as today) |
| Workflow surface | read ops only; optionally exposed as read tools later (allowlisted, never baseline) |
| Node/agent packs | none required this ADR |
| Public surface | none |
| RBAC | reads inherit the family gates (manage for creator reads; admin composition per 0438's additive-tier law) |
| Replay/fork | n/a (display-only reads) |
| Frontend | Gate matrix + sim panel + day strip on the read-only workspace; command center rows — all DESIGN.md primitives; a11y: severity by shape+label |
| Lifecycle | no new durable state anywhere (the projection stores nothing) |

## 5. RFC verdict

**Host-extension only — no RFC.**

## 6. Phases

| Phase | Contents | Gate | Landed |
|---|---|---|---|
| 1 | The three creator reads + Studio rendering (matrix/panel/strip) | — | #2320 |
| 2 | Exception-source seam + kicktodo sources + command center rows | Phase 1 review clear | this branch |

Reviews + grade rhythm per ADR 0458.

### Phase 2 implementation record

- **The seam** — `host/exceptionProjection.ts`: a NEW keyed registry
  (`registerExceptionSource(key, fn)`, repeat-boot overwrite — the
  `rosterLifecycle` idiom) + `listExceptions(tenant)` that composes every source
  with PER-SOURCE degradation (the `retentionPurger` idiom — a throwing source is
  reported `ok:false` AND injects a synthetic `degraded` row, never a silent gap).
  `reviewProjection.ts` was deliberately NOT touched (it is not a registry — it's
  a hard-coded composition — and a parallel session was editing it).
- **Read route** — manage-gated `GET …/kicktodo/admin/exceptions` (registered from
  `kicktodo-core`; 403 `forbidden_scope`, not a leaky 404).
- **Sources** — each registers over its OWN store from its feature's
  `registerRoutes`: `kicktodo:approvals` (the shared queue, KickTodo kinds),
  `kicktodo:monitor` (broken source-health findings), `kicktodo:payouts` (open
  payout runs awaiting evidence), `kicktodo:review-flags` (flagged reviews). All
  reads are `${tenantId}::`-prefixed (no cross-tenant scan).
- **Command center** — `AdminOverviewPage` renders an Exception Ledger section
  (the 0438 §4.4 grammar) via a new `ExceptionLedgerRow` composing existing
  primitives (severity glyph + label chip, mono `<code>` id, server-authoritative
  owner, ONE `<Link>` deep-link, `review-card__trace` audit expander); a degraded
  source shows a `<Notice>`, never a silent "all clear".

> **Correction note (Phase 2 impl — /architect finding ②, the honesty gate):**
> the ADR names FIVE sources; Phase 2 ships FOUR and DEFERS the fifth
> (**stale wearable streams**) — because it cannot yet be made honest. A correct
> staleness signal needs (a) a durable liveness clock (`WearableEvidenceRule` has
> no `lastReadingAt` today), AND (b) an enrollment-active + live-consent join to
> avoid FALSE POSITIVES (a completed enrollment or a revoked consent legitimately
> stops readings). Shipping a source that flags those as "exceptions" would itself
> be painted status — the exact thing this ADR exists to prevent. The registry is
> app-generic by construction (§3.2), so the wearable source lands later as its own
> change once the liveness clock exists. Deferring for HONESTY, not for size.

## 7. Open questions

- **OQ1 — RESOLVED:** per-source, bounded, composed — `SOURCE_ROW_CAP = 200` with
  a `truncated` flag surfaced per source (a capped list is never read as "all"),
  every source a `${tenantId}::` prefix read (no cross-tenant scan).
- **OQ2 — RESOLVED:** yes. THEATER-guard tests pin it per surface — Phase 1's
  gate-parity + no-`enriched` tests, and Phase 2's degradation test (a down source
  is reported, never a silent "all clear") + the honest-empty assertion (a fresh
  tenant returns `rows: []`, never a painted status).
- **OQ3 (follow-on):** the deferred wearable-staleness source (see the Phase 2
  correction note) — needs the durable liveness clock + enrollment/consent join.
