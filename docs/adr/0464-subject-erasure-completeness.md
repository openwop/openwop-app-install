# ADR 0464 — Subject-erasure completeness: close the host-store DSAR class

Status: implemented
Date: 2026-07-21
Relates: ADR 0077/0381 (the erasure seam), ADR 0458 P0 (the feature-side sweep), ADR 0448 (the tripwire precedent), ADR 0459 grade record (#2322 — the kind-local approvals fix this generalizes), ADR 0371/0380 (run/size retention)

## 1. Context — the class, not the incidents

Two grade sweeps in two days surfaced the same defect class in different
stores:

1. **Canvas version snapshots** carry `capturedBy: userId` for every canvas
   type app-wide (`canvasEditorRoutes.ts:302`) — no eraser reaches them; a
   DSAR-erased subject's id survives on every snapshot of every canvas they
   ever edited (0458 sweep, recorded as platform debt).
2. **Approval payloads** — the `kicktodo-plan-proposal` kind was the first to
   put *declared-PII free text* into the approvals store, which has retention
   pruning but **no erasure path** and never prunes pending rows (0459 sweep,
   Blocker). #2322 fixed that one kind locally; the store-wide gap remains
   for every other kind's subject-bearing fields.

Two recorded instances make a class: **host-owned durable stores holding
subject identifiers outside the subject-erasure seam**. ADR 0458 P0 closed
this for every `kicktodo-*` feature store; the HOST layer was never swept.
Each instance so far was found by an adversarial audit after shipping — the
class needs a structural cure, not a third incident.

## 2. Decision

### 2.1 The rule (added to ARCHITECTURE.md's contract)

> Every durable store that records a subject identifier either (a) is reached
> by a registered `SubjectEraser` (delete or anonymize, the owner's choice,
> registered AT the owning host module), or (b) appears on the documented
> **exemption allowlist** with a lawful-retention or technical justification.
> There is no third state.

### 2.2 The tripwire (the structural cure — ADR 0448 precedent)

`test/subject-erasure-coverage.test.ts`: enumerates host-owned durable
stores, flags any whose row type/content carries subject-identifier fields
(name-pattern + key-shape signal, per the audit's design inputs), and fails
unless the store is covered by an eraser registration or is on the
**shrink-only** exemption allowlist (each entry carries its justification).
A new subject-bearing host store without coverage fails the build the day it
is written.

### 2.3 The approvals payload-redactor registry (generalizing #2322)

`approvalService` gains a keyed per-kind redactor registry: each approval
kind (or its owning feature) registers the payload fields that carry subject
identifiers / subject-authored text and how erasure treats them
(redact-in-place vs delete-row). ONE store-level `SubjectEraser` walks
pending + resolved approvals applying the registered redactors. The #2322
kind-local ops migrate onto the registry (kicktodo-accountability registers
its redactor; behavior byte-identical, mechanism general).

### 2.4 Known fixes (plus whatever the §3 audit proves)

- **Canvas**: the canvas host module registers an eraser anonymizing
  `capturedBy` → `'[erased]'` across all version snapshots for the subject
  (tenant-scoped, idempotent, no notifications).
- **Approvals**: §2.3, with the audited per-kind field map.
- Further instances land only with the audit's proof, each with an
  end-to-end erase test (create → erase → assert).

## 3. Audit (evidence gate for §2.4's scope)

The full host-store × subject-identifier × coverage verdict table is produced
by the implementation-time sweep and recorded in the implementation record —
GAP items get fixes, EXEMPT items get allowlist entries with justification.

### 3.1 Audit sweep — summary (Phase 1)

Denominator: **67 host-owned durable stores** — every `new DurableCollection`
namespace literal in `src/host/**`, EXCLUDING the 17 `demo*Seed.ts` seeders
(they only re-open feature-owned namespaces; the owning declaration is under
`src/features/`, verified: **0** seeder-only orphans). Parametric factories
(`obligationLedger.ts` `config.ns`, `durableQueue.ts` `` `queue:${name}` ``)
pass no literal and are not host-literals; money-truth ledgers are handled by §4.

Every store is partitioned into exactly one registry in
`test/subject-erasure-coverage.test.ts` (pairwise-disjoint, no-stale, and
tenant-teardown-honesty assertions all enforced):

| Verdict | Count | What it holds |
|---|---:|---|
| ERASED (fully covered by a registered host eraser/redactor) | 0 | The only existing host redaction is the **kind-local `kicktodo-plan-proposal`** path in `approvalService` — it does NOT graduate the `approval` namespace out of debt. The integrator moves a namespace here as each peer lands + reports a store-level eraser (§6). |
| RECORDED_DEBT (subject-bearing, no eraser yet — shrink-only) | 23 | The 20 lead-enumerated GAP stores + **3 audit additions**: `access-groups` (`memberIds` subject refs), `kanban:board` (`ownerUserId`/`ownerSubject`; the lead enumerated only `kanban:card`), `collab:update` (`update` = subject-authored CRDT content; the lead enumerated only `collab:snapshot`). `review:decision` carries the honest reason **`unreachable — no tenantId; fix in flight`** (it cannot claim tenant-teardown coverage today — the honesty assertion would fail). |
| REVIEWED_EXEMPT | 44 | 8 named rulings (`cdp:audit-chain` lawful tamper-evident retention; `runartifact` run-retention + `deleteRun` cascade; `media:bytes`/`media:asset` ephemeral TTL; `chat:ui-state` id-only, PII-forbidden; `agent-toolallowlist-override` + `governance:policy` operator-audit attribution; `workspaces:active-pref` membership-lifecycle) + **2 audit extensions** of the operator-attribution ruling (`custom-domains:domain`, `hostevent:binding` — `createdBy` on a tenant config artifact) + 34 NO-SUBJECT-DATA rows (agent-identity: `roster`/`agent-profile`/`workforce`/`orgchart`; config: `feature-toggle`/`egress-rules`/`site-config`/`cms:langsettings`/…; pointer/index/idempotency: `approval:by-tenant-status`/`chat:exchange-idem`/`triggerbridge:*`/…; hash-only + seed markers). |

Total 0 + 23 + 44 = **67**. Correction note (§2.4 scope): the canvas incident
generalizes to `canvas`, `canvas:version`, and `canvas:idem` (all three carry or
may embed subject data), and the approvals gap is store-level, not the single
`kicktodo-plan-proposal` kind. `orgchart` was investigated as a potential GAP but
its `members` are RFC 0086 **roster (agent)** entries, not human subjects — exempt.
`workflow:ownership` is keyed `${tenantId}:${workflowId}` (owner is the tenant, no
person) — exempt.

## 4. Resolved questions (architect rulings, recorded)

- **Pending-approval retention:** NO age-based purge is adopted. A pending
  approval is live work-in-flight; erasure handles the compliance dimension
  (DSAR reaches the rows via §2.3), and staleness is an operations concern,
  not a retention one. Revisit only with operator evidence of pending-row
  accumulation.
- **Run records / `run.metadata.actingUserId` and event-log attribution:**
  EXEMPT, on the allowlist. Run records are replay-immutable by protocol law
  (mutating them breaks `:fork` determinism) and already lifecycle-governed
  by run retention (ADR 0371) + size retention (ADR 0380). Erasure of a
  subject's runs is a retention/deletion concern at run granularity, not
  field redaction.

  > **Extended 2026-09-26 (`/grade-data` FORKINT-3, `/architect` ruling) — the
  > `interrupts` table, fork copies included, is under this same exemption.** An
  > interrupt row's `data` (approval subject/prompt, approver refs, form or
  > conversation content) is a run child, and since ADR 0751 it is also REPLAY
  > INPUT: a `:fork` at a suspended checkpoint re-creates its gate from the
  > SOURCE row's `data` (`executor/forkInterrupts.ts:121-137`), whether or not
  > that row has since resolved. A field-redacting eraser would make two forks
  > of the same checkpoint inherit different gates depending on whether an
  > erasure ran in between, which is the determinism break this ruling exists to
  > prevent. It would also be dishonest coverage, because the same content stays
  > in the run's `node.suspended` event, which is exempt here by protocol law.
  > So a subject's interrupt content leaves the way the rest of the run does: at
  > run granularity. `deleteRun`, `pruneTerminalRuns` and `deleteAllTenantData`
  > each cascade `interrupts` (fork copies are keyed by the fork's own `run_id`),
  > witnessed by execution in `test/run-child-cascade-witness.test.ts`. The
  > human-facing approval records that carry the same subject are separately
  > erased through the approvals eraser (§2.3). **Stated residual:** run
  > retention is operator opt-in, so on a default-posture host the interrupt
  > copy lives as long as the run.
- **Audit log:** EXEMPT — lawful-retention justification; the audit trail of
  an erasure must itself survive the erasure (SEC-4 already logs incomplete
  erasures for exactly this reason).

## 5. What this deliberately does not do

- No wire change, no RFC (erasure is host-internal).
- No schema migration (redaction is in-place at erasure time).
- No retro-processing job: existing rows are reached the next time an
  erasure runs for a subject (erasure is the trigger, as everywhere else in
  the seam).
- Feature stores stay feature-owned (the 0458 P0 pattern is untouched; this
  ADR is the HOST half).

## 6. Phases

| Phase | Contents | Gate |
|---|---|---|
| 1 | Audit sweep (verdict table) + the tripwire + exemption allowlist (lands FIRST, honest from day one) | — |
| 2 | Canvas eraser + approvals redactor registry (+ #2322 migration onto it) + audit-proven GAP fixes, each with an end-to-end erase test | Phase 1 review clear |
| 3 | ARCHITECTURE.md contract row + assessment records + grade sweep | Phase 2 |

## 7. Implementation record (2026-07-21)

All three phases landed in one integrated change (single PR; three parallel
builders — tripwire, approvals cluster, host erasers — reconciled by the lead).

| Piece | Where | Notes |
|---|---|---|
| §2.2 tripwire | `test/subject-erasure-coverage.test.ts` | 67 stores partitioned 19 ERASED / 0 RECORDED_DEBT / 48 REVIEWED_EXEMPT; assertions: pairwise-disjoint, every-store-classified (severity hint via subject-field discriminator), shrink-only debt, tenant-teardown HONESTY (a teardown claim requires a real `tenantId` field) |
| §2.3 approvals redactor registry | `src/host/approvalService.ts` (`registerApprovalRedactor` + `eraseApprovalSubject`) | ONE store-level eraser walks pending+resolved rows applying per-kind `{idFields, textFields}` maps; #2322's kind-local `kicktodo-plan-proposal` ops migrated onto it (`features/kicktodo-accountability/compliance.ts`), behavior-identical |
| Approvals cluster erasers | `approvalDelegations.ts`, `teamsApprovalDelivery.ts`, `reviewDecisionLedger.ts` | `review:decision` rows gained `tenantId` (populated at both `appendDecision` call sites; pre-existing rows keep a frozen keyRef — documented residual reached by teardown once aged out) |
| Host erasers (15) | `src/host/hostSubjectErasers.ts` + owning modules | kanban cards+boards, canvas + versions (`capturedBy` → `'[erased]'`), scheduler (anonymize + `enabled:false`), twin grants, access members/orgs (redact PII, keep opaque subject + roles), conversations, read-state, feedback, reactions, subject-knowledge, subject-memory (delete), runner dispatch results, agent-profile twin link. Shared sentinel/helpers in `subjectErasureRedaction.ts` |
| ONE boot list | `registerHostSubjectErasers()` wired as `hostExt:subjectErasers` in `routes/registerAllRoutes.ts` | Correction to the builders' initial split: the approvals cluster's four module-load self-registrations were folded into this same explicit aggregator (17 registrations) so an import-graph change can never silently unregister an eraser |
| §2.1 contract row | `ARCHITECTURE.md` | erasure-completeness rule + pointer to the tripwire |
| Tests | `test/adr0464-host-subject-erasure.test.ts` (23), `test/subject-erasure-host-stores-adr0464.test.ts` (9), tripwire (4) | 36 tests; each eraser has a create → erase → assert path |

**Accepted residuals** (adversarial review, recorded deliberately):

1. **`runner-dispatch-result` is SUBJECT-scoped, not tenant-scoped.** The RFC
   0122 §19 dispatch wire carries no tenant, so a row cannot be attributed to
   one. Any tenant's DSAR for a subject deletes that subject's dedup rows
   globally — over-erasure of the subject's OWN data (never another subject's),
   the fail-closed direction. Bounded cost: the same principal's at-most-once
   dedup in another tenant resets. Acceptable while the runner capability is
   HONEST-OFF (`supported:false`; the store holds only conformance residue).
2. **`review:decision` legacy rows (no `tenantId`) erase cross-tenant.** An
   untenanted pre-0463 row cannot be attributed to a tenant; the eraser scrubs
   the erased subject's own refs wherever they appear rather than leaving them.
   Only the subject's own identity fields are touched; rows stamped with
   `tenantId` (all new rows) are strictly tenant-scoped. Follow-up: backfill
   `tenantId` and drop the fallback.
3. **Third-party PII inside approval `proposal` free text is out of the seam's
   reach.** An erasure subject key (`user:<id>`) cannot be matched to e.g. an
   email address quoted in prose (assistant-action). The text-only kinds
   register empty field maps (approver-ref anonymization only) — an honest
   non-claim; tenant teardown + future approvals retention are the backstop.

**Grade sweep** (2026-07-21, adversarial agents): code **A**, data **B+ → fixes
applied** (ux N/A — zero frontend diff). Applied: (a) the four approvals-cluster
erasers matched the subject key EXACTLY while the DSAR entry point accepts raw
(`alice`) or scoped (`user:alice`) forms — all four now expand
`subjectKeyForms` like the other 13, with a cross-form test per store (seed
raw, erase scoped); (b) the tripwire's store-enumeration regex made the
`DurableCollection` generic optional so an untyped constructor cannot escape
the denominator; (c) the admin Exception Ledger drops an owner chip whose ref
is the `[erased]` sentinel instead of rendering it as a person.

§3.1 reconciliation: the 23 debt entries → 19 ERASED + 4 re-ruled
REVIEWED_EXEMPT on implementation evidence (`access-groups` memberIds are opaque
keys whose target rows the access-members eraser redacts; `collab:snapshot` /
`collab:update` rows carry no subject-identifier field — attribution lives in the
canvas rows the eraser covers; `canvas:idem` is an ephemeral retry cache with
`tenantId`, teardown-covered). No age-based pending-approval purge was added
(§4 ruling stands).
