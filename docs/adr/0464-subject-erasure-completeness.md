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

## 8. Correction 2026-10-26 — the doubled `user:user:<hash>` spelling (DSAR-DBL)

> **§2's "a single host store holds one form or the other" was false.** There
> was a third form, and no eraser that used the shared matcher could see it.
> `User.userId` is ITSELF `user:<hash>` (`usersService.userIdFor`), and
> several writers apply `userRef()` (or a literal `` `user:${…}` ``) to it:
> `userRef(req.userId)` in `routes/chatSessions.ts` (read markers, reactions,
> feedback, message authors, the DM key), `ensureConversationMeta`
> (participants), the channel service, KickBot's and the assistant's DM key,
> manual-test runs, and the pre-0986 arena route. Those rows hold
> `user:user:<hash>`. `subjectKeyForms('user:<hash>')` returned
> `{user:<hash>, <hash>}`, so a DSAR keyed by `User.userId` (the users-route
> key) matched none of them. Three stores had grown private fixes (projects
> PRJC-1, memory GEN-TWIN-4, the conversation store's `subjectRefForms`). In
> ADR 0986, #5282 added a fourth (`subjectRefFormsWithDoubled`). Every other
> store missed the form, including the conversation eraser's own `dmKey` check.
>
> **Decision.** Fix the MATCHER, not the writers. `subjectKeyForms` now
> includes `user:` + the key and `user:` + the scope, i.e. exactly the
> `userRef()` of the subject's own spellings. It does not add `user:` + the
> stripped `raw`: for an `agent:X` key, that would bridge into an unrelated
> person's `user:X` (the projects F2 rule). This drops a bridge that
> `subjectRefForms` had. `subjectRefForms` and `subjectRefFormsWithDoubled` are
> deleted, and their callers read `subjectKeyForms(k).forms`.
> `eraseSubjectKnowledge` (raw-only) also deletes the `user:user:` scope.
> `manual-tests:run` (a tester's verdicts and free-text notes, with no eraser
> and invisible to both gates because its only subject field is `subjectRef`)
> gets `eraseManualTestRunsSubject`.
>
> **Side effect, intended.** The lead-intel erasers write one hash-only
> tombstone per form, so a DSAR now writes one more tombstone (the doubled
> spelling). It belongs to the same DSAR group and is readmitted with it. Two
> tests' `tombstonesCleared` counts moved from 2 to 3.
>
> **Not done here (a later ADR).** Normalizing the WRITERS (an idempotent
> `userRef`) would change dedup keys that live rows already hold: DM keys, read
> markers and reaction keys. That needs a re-key migration. MEASURED read-only
> in prod on 2026-10-26: 12 of 16 `chat:read-state` rows, 1 of 57 conversation
> `dmKey`s, 11 participant metas and 61 of 141 `chat_messages.author_subject`
> rows carry the doubled form. They belong to 3 subjects: two `user:<hex32>`
> ids, and one legacy `user:<uuid>` id from before `userIdFor` (1 of 39 users
> still has that shape). The first census counted 2 because its regex matched
> hex ids only. All 3 still have a live user row and none has a consent
> tombstone, so no data survived an erasure and no backfill is needed.
>
> **The dropped `user:`+raw bridge — nothing relied on it.** The old
> `subjectRefForms` was `forms ∪ userRef(forms)`. For every key shape except
> one, the new set is the same: `user:<h>`, a bare `<h>`, `oidc:<sub>`,
> `session:<id>` and `anon:<sid>` keys all still yield `user:`+key, which is
> what the principal-fallback writers (`userRef(req.userId ?? principalId)`)
> store. The only spelling lost is `user:X` for an `agent:X` key, i.e. an
> agent-keyed DSAR erasing a person-tagged ref. No writer produces that: every
> `userRef(` / `` `user:${…}` `` argument is a `User.userId`, a principal id or
> `_anon`, never an agent id, and no key resolver (kicktodo-core, crm,
> users-email, analytics identity-link) emits an `agent:` key. MEASURED
> read-only in prod on 2026-10-26 across the stores that used the bridge
> (conversation participants and dmKey, `chat_messages.author_subject`,
> `voice:session`, `chat:message-feedback`, `evals:arena-match`) plus read
> markers and reactions. Every `user:`-tagged ref is one of `user:user:<hex32>`,
> `user:user:<uuid>`, `user:oidc:*` or `user:session:*`. There is no
> `user:<raw>` of any other shape, and none of the 14 distinct `user:` refs
> has a remainder equal to a roster agent id (24 in prod).
>
> **Witness.** `test/dsar-doubled-subject-ratchet.test.ts` seeds the doubled
> form in 11 stores and erases through the real host fan-out. Reverting the
> matcher reddens 8 of them. Reverting the knowledge fix reddens knowledge.
> Because dropping the bridge NARROWS erasure, the same file pins it both ways
> across the six stores that used the bridge (participants, dmKey, chat
> author, voice session, feedback, arena rater). The positive side covers five
> key shapes (`user:<hex32>`, legacy `user:<uuid>`, `oidc:`, `session:`,
> `anon:`), each stored as the key itself and as its `userRef`. Each case
> erases the row and leaves a same-shape control person intact. The negative
> side: erasing `agent:X` leaves a person's `user:X` rows alone. Re-adding the
> bridge reddens the negative, and dropping the `userRef` arms reddens all
> five `userRef` positives.

## 9. Correction 2026-11-07 — the feature census had no denominator (CHAN-F6)

CHAN-F6 said the coverage ratchet "walks only `src/host`, so feature-dir stores
are unchecked". **Half true.** `subject-erasure-coverage.test.ts` does walk only
`src/host`, but `subject-erasure-feature-stores.test.ts` has walked `src/features`
since the §Correction that created it. The real gap was narrower and worse: that
census starts from a SIGNAL (a row type with `userId`, `email`, `subjectKey`,
`createdBy`, …), so a store with no signal field entered no list at all.

MEASURED at `68509a7f2`: 417 first-party feature namespaces. The signal census
governs 162, ADR 1018 lists 2 anonymous free-text stores, and 1 (`media:asset`)
is declared in `src/host`. **252 were governed by nothing**, so a new store that
named its subject `ownerRef`, `actor` or `recipient` passed every gate. (37 more
namespaces also appear in `src/host`, but only in demo seeders that re-open them.
They stay feature-governed: a seeder is not an owner.)

**P1 (this change) closes the denominator, not the audit.** A new block in
`subject-erasure-feature-stores.test.ts` requires every first-party feature
namespace to be governed by the signal census, the host gate, ADR 1018, a new
`SIGNAL_FREE_REVIEWED` map (reviewed, no subject data, with a reason), or a pinned
**shrink-only** baseline of the 252
(`test/fixtures/subject-erasure-signal-free-baseline.json`, ceiling 252). A new
store fails the day it lands. A baseline entry leaves by being reviewed or by
gaining a signal; a stale or now-governed entry reds the test. It is first-party
only, so the same baseline holds in an adopter's tree (ADR 1031 P3).

Sabotage-witnessed: a new signal-free feature store reds the governed check; an
appended baseline entry reds the shrink-only and liveness checks; a walk narrowed
to one feature reds the non-vacuity floor (417).

**P2+ (open):** review the 252 in waves, feature by feature, against each
feature's `erasure.ts`. Some will be subject-bearing under a field no signal
names; those need an eraser AND a signal, not a review line.

**Open decision, for a human (not settled by P1):** where a feature store's
classification lives. Either (a) the central registries in the test, as today,
or (b) self-classification beside each feature's eraser (a
`FeatureRatchetDeclarations` field, the ADR 1031 P2 pattern), which an adopter's
package would carry with it. P1 uses (a) only because the existing census does;
the baseline moves either way. *(SETTLED 2026-11-10: the ADR 1031 union of both;
see "Both open decisions settled" at the end of this section.)*

**P2 wave 1 (2026-11-09): 31 reviewed, baseline 252 → 221 (ceiling 221).** Each
was read at its declaration: the row type with its nested types, and the key
function, since a key built from a user id is subject data even when no field is.
They are config and schema rows (field definitions, pipelines, taxonomies, consent
policy), per-tenant counters keyed by tenant and date, retention watermarks, and
id-only index rows. Each has its reason in `SIGNAL_FREE_REVIEWED`.

**What wave 1 found: "no signal field" does not mean "no subject data".** A
pre-sort of the 252 row types (247 resolved, one level of nesting, so the count
is a floor) found **73** that match `PERSON_FIELD`: a field that names a person
under a name the census signals do not bind. Examples: `updatedBy` (capability-firewall,
model-router, campaign-intel), `attestedBy` (`brand:font`), `approverId`,
`voterId`, `viewer`, `subjectRef`, a sender address (`email:settings`).
`crm:lead-sla-settings` even calls `declarePiiFields(…, ['agencyLead',
'updatedBy'])`, a classification no erasure gate reads. Those stores stay in the
baseline; they need an eraser, or a widened actor signal (measure first, the KB-3
rule), not a review line. A new test refuses a reviewed entry whose resolved row
type carries such a field (`PERSON_FIELD`). Sabotage-witnessed: reviewing
`modelrouter:config` and `email:settings` reds it, naming `updatedBy` and
`senderAddress`.

**Next waves:** the remaining rows the pre-sort did not flag (about 140, each still
read by hand: a key or a free-text field can carry a person where no field name
does), then the person-bearing stores, feature by feature against each
`erasure.ts`. Widening `CREATED_BY_FIELD` to `updatedBy` would move them into the
actor ledger at once and break `ACTOR_DEBT_CEILING`, so it is a measured change
of its own. Should `declarePiiFields` feed the census? That question joins the open
decision above.

**Both open decisions settled, 2026-11-10 (1a, on the user's instruction to decide
from research, a UX review and an architect pass, then implement).** The reasoning
is kept here so a later reader can overturn it with evidence rather than taste.

*D1 — where a classification lives: the ADR 1031 union, not a migration.*
First-party reviews stay in the host table (`SIGNAL_FREE_REVIEWED`). A feature
package MAY carry its own in `<feature>/ratchetDeclarations.ts`
(`subjectErasureSignalFreeReviewed`, a new `FeatureRatchetDeclarations` field). The
census runs the same assertions over host table ∪ declared, exactly as ADR 1031 P2
specified for every exception table, and a namespace in both fails. A declared
entry may name only a store in its OWN package's directory.

- *Why not (a) alone:* an adopter cannot edit an upstream test, so an adopter
  package with a signal-free store had no way to say "reviewed".
- *Why not (b), moving all first-party rows into ~100 per-feature files:* zero
  first-party `ratchetDeclarations.ts` exist today, so it is pure churn. It would
  split one reviewable list (and its git history) across directories, and it is
  the opposite of what every other ratchet here does. The union keeps the one
  pattern.
- *UX, for the contributor who adds a store:* the red message now names both
  homes and says that a `declarePiiFields` call already classifies the row. A
  double entry reds and names both places. A foreign-package review reds with
  "a package reviews only its own stores".
- *Deferred, at a real gate:* extending the denominator itself to
  `src/adopter/features`. Today it is first-party only (P1), so an adopter's
  signal-free store is still unchecked. Turning it on reds every existing
  unclassified store in every adopter tree on their next sync, which is a
  cross-repo rollout (KickTodo, Book AI) needing notice and an adopter-side
  baseline. It is not a host-only PR. The field this change adds is the
  prerequisite.

*D2 — `declarePiiFields` feeds the census: yes, for store namespaces.* A
declaration is the owner stating in code that the row holds personal data. That
is a stronger claim than any field-name regex here, and until now no erasure gate
read it. MEASURED: 60 declared entities outside tests. 22 are store namespaces (21
literals plus csm's `CSM_STORE` constant) and 38 are dotted log-mask labels
(`kb.document`) that name no store and cannot join. **8 of the 221 unreviewed
baseline stores declared PII**, and each is reached by its feature's real eraser,
checked by reading it: `channel-ingress:pending` and `:sender-thread` (deleted),
`crm:lead-model-active` (`activatedBy` redacted), `crm:lead-sla-settings` (via
`eraseSlaSettingsSubjects`), `crm:merge-event` and `crm:signature-record` (both
named in `crm/erasure.ts`), `documents:version` and `proposals`. They now enter the
census as `topic` stores, classified COVERED. **Baseline 221 → 213 (ceiling 213).**
The older pin that `crm:signature-record` and `crm:merge-event` were invisible is
corrected in place: no FIELD signal sees them, and the declaration does.

Three new checks:
- A store-shaped entity that names no store reds (a typo or a removed store).
- A reviewed store that declares PII reds.
- The non-vacuous witness, `crm:lead-sla-settings`, is seen only through its
  declaration.

Sabotage-witnessed, each red, each restored:
- Dropping that declaration reds the denominator and D2.
- Misspelling its entity reds both.
- Reviewing it in a package declaration reds the review guards (`updatedBy`, and
  the PII declaration).
- Declaring `env:settings` and `crm:pipeline` from `features/environments` reds
  the double claim.
- Declaring `crm:booking-link-slug` there reds the ownership check.

Research note: practitioner GDPR guidance treats the data map as one versioned
inventory, updated when a field is added, that erasure must cascade through. Two
inventories that disagree (a PII registry no erasure gate reads) is the failure
D2 removes.

**P2 wave 3 (2026-11-13): 101 reviewed, baseline 212 → 111 (ceiling 111).** A
read-only pre-sort with the census's own resolver split the 212: **75** carry a
`PERSON_FIELD`, and **137** did not. Each of the 137 was then read by hand: the row
type with its nested types, the key function, every free-text field, and the
feature's `erasure.ts`. 101 hold nothing about a person (counters keyed by tenant
and date, id-only index rows, provider and Stripe account ids of a business,
operator configuration, business-object titles) and moved to
`SIGNAL_FREE_REVIEWED` with their reasons. The other **36 stay**, and no field
name gives them away:

- *Covered by an eraser the census cannot see (14).* The subject is in the key or
  in a nested payload: `analytics:replay` (`subjectKey`), `cdp:collected-event`,
  `channel-ingress:conversation`, `claude-code:presence` (a device id),
  `commissions:deal-claim` (the rep inside `statementId`), `goals`
  (`owner.principal`), `job-search:attestation-hashidx` and `:digest`,
  `kb:docrev`, `kb:enrichcache` and `kb:veccache` (a subject-keyed document id),
  `orgs:invite-hashidx`, `campaign-ops:intake-bytes` and `prompts:entry-version`
  (private bodies). They leave by a signal the census can read, not a review line.
- *No eraser reaches them (17), tracked as `CHAN-F19`:* `crm:sender-health-seen`
  (a raw recipient email in every bounce key, no age-out), `campaign-ops:request`
  (`createdBy`, `answeredBy`, request text), `team-ledger:suggester-queue` (the
  chat message text), `commerce:affiliate` and `commerce:payout` (an affiliate is
  often a person), `portability:import-claims` and `settings:byok-usage` (a user id
  in the key), `crm:dealkeyclaim` (a contact id in the key), `crm:lead-rr`,
  `connections:pairing` (a DM chat id or phone number), `chatwidget:session` and
  `:anonautowrite:session` (the visitor transcript's hash; TTL only),
  `notebook-source-summary`, `channel-ingress:settings` (relay lanes keyed by a
  personal device), `builder-pair:room` (partial), `analytics:replay-toggle-writes`
  (copied toggle rows with `updatedBy`, minutes-lived) and `service-desk:legacy-none`
  (typed as a full ticket; nothing writes it).
- *Kept by design (1):* `commerce-connect:order`. Its eraser exempts it as a money
  record (`commerce-connect/erasure.ts`), but the buyer may be a one-person
  workspace, so "holds no subject data" would be false.
- *Unresolved (4):* `crm:booking-link-slug` (a slug can be a rep's name),
  `crm:companykeyclaim` (a contact's email domain), `crm:territory-rule` (a filter
  literal can be a person's id) and `sales-maps:geocode` (a posted address).

The pre-sort also misread one row type (`service-desk:legacy-none` resolved
clean; it is a `Ticket`), which is why every candidate was read and none was
reviewed on the scan alone. **Next:** the unreviewed set is now person-bearing, so
the next waves are erasers (`CHAN-F19`) and census signals for the 14 covered
stores, feature by feature, not review lines.

**CHAN-F19 #1 (2026-11-13): `crm:sender-health-seen`, baseline 111 → 110 (ceiling
110).** The ADR 0955 D7 breaker's bounce/complaint dedup row keyed
`tenant::org::day::reason::<raw address>` and was never deleted, though it is only
needed for the same UTC day. Three changes (`crm/senderHealth.ts`, `crm/erasure.ts`):
- *The key holds a hash.* New rows key `h:<sha256(normalized address)>`. A hash of an
  email is still personal data, so the hash keeps the address out of keys and logs;
  the next two bullets are what bound and erase it.
- *A 2-day age-out* (`registerKvAgeOut`, `timestampField: 'at'`). The sweep selects by
  prefix and ages by `at`, which every row has carried since the store was created
  (90a29103c), so legacy raw-key rows age out on the same lane. No migration: it would
  duplicate the lane. During the switch, `recordBounceSignal` also reads the legacy key
  (read-only) so a bounce seen just before the deploy still dedupes a same-day
  redelivery after it; that read is marked for removal one TTL after the deploy.
- *The crm eraser deletes both key shapes* (`eraseSenderHealthSeen`), for every address
  in the contact's key-set and, before the no-contact return, for an email-keyed DSAR
  whose address no contact holds. The TTL is the backstop, not the erasure story, so a
  DSAR inside the first sweep window (before the per-tick cap clears legacy rows) still
  removes the subject's rows.
- *The census sees it:* `declarePiiFields('crm:sender-health-seen', ['key'], {
  maskGloballyByFieldName: false })` is the D2 signal, and crm registers an eraser.
  Tests: `test/chan-f19-sender-health-seen.test.ts` (six cases; seven sabotage probes, each red on its named case, plus the census red when the `declarePiiFields` line goes).

**CHAN-F19 #2 (2026-11-13): `team-ledger:suggester-queue`, baseline 110 → 109 (ceiling
109).** The ADR 0853 D3 decision suggester queued a person's chat text for the
classifier with no author on the row. So no eraser could find it, and the text still
reached the model after a DSAR. Three changes (`team-intent-ledger/decisionSuggester.ts`,
`feature.ts`):
- *The row names its author.* `authorUserId` comes from `HumanChatMessage`, which both
  emitters (the channel post route, the conversation exchange) set when they know it.
  It is a census signal (`USER_ID_FIELD`), and team-intent-ledger erases.
- *A DSAR deletes the subject's queued rows* (`eraseSuggesterQueueSubject`, registered
  beside the ledger and suggestion erasers), before the classifier can read them.
- *A 7-day age-out* (`registerKvAgeOut` on `createdAt`) bounds what cannot be
  attributed: rows queued before this change and rows whose emitter did not know the
  author. The worker drains every 30 s, so a row still queued at 7 days is stale. A
  DSAR inside that window misses an author-less legacy row; this is accepted and stated
  here rather than guessed at by text.
- *Not in this change:* a suggestion the agent already filed from an erased person's
  message keeps the model's title and summary (`suggestedBy` is the agent, so
  `eraseSuggestionSubject` does not match it). Tracked on the CHAN-F19 row.
Tests: `test/chan-f19-suggester-queue-erasure.test.ts` (three cases through the real
channel post route; five sabotage probes, each red on its named case, including the
census red when the `authorUserId` field goes).

**CHAN-F19 #3 (2026-11-14): `campaign-ops:request`, baseline 109 → 108 (ceiling 108).**
An ADR 0923 change request names its creator (`createdBy`), each person who answered
the planner's questions (`answers[].answeredBy`), and a person who overrode a duplicate
warning (`duplicateOverride.by`), with the reason they wrote. The row type is
`StoredRequest extends ChangeRequest`, and `ChangeRequest` lives in another file, so the
census saw no signal, and campaign-ops' eraser never reached the store.
- *The eraser leg* (`eraseRequestActors`, `campaign-ops/requestService.ts`, summed into
  `eraseCampaignOpsSubject`): per field, each value in the subject's key forms becomes
  the erased-user tombstone, and an override the subject made has its reason blanked.
  Another person's fields on the same row are kept. One CAS per row, never through the
  content writers, so the request keeps its version and is not re-interpreted.
- *Kept, by decision:* the request text, its history and the answer values. They are
  the client's change instruction, the same agency record as asset content (the rule in
  `campaign-ops/erasure.ts`), and a change set is hashed from them (ADR 0923 D6). The
  person's identity leaves; what they asked for does not. If a request's text itself
  names a person, that is free text in the agency's record, the same as an asset.
- *The census signal:* `declarePiiFields('campaign-ops:request', …)` beside the
  collection (the D2 signal). No new eraser id, so the WF-CONS-2 manifest is unchanged.
Tests: `test/chan-f19-campaign-ops-request-erasure.test.ts` (the real app's eraser set
through `eraseSubject`: the erased person's fields on two requests, the other person
kept, text and values and version kept, another workspace untouched). Four sabotage
probes, each red: the leg unwired, the PII declaration dropped (census red), every
answer tombstoned regardless of author, the override reason kept.

**CHAN-F19 #4 (2026-11-14): `settings:byok-usage` and `settings:user-prefs`, baseline
108 → 107 (ceiling 107), and one RECORDED_DEBT line closed.**
The ADR 0396 settings feature keeps two stores, and every row of each is keyed to one
person: `settings:user-prefs` (`${tenantId}:${userId}`: personal budget cap, reasoning
override, privacy opt-outs) and `settings:byok-usage` (`${tenantId}:${userId}:${day}`:
that person's BYOK token counters). The prefs store sat in RECORDED_DEBT ("simply has
no eraser yet"). The usage rows named the user only in the key, so the census saw no
signal and the store sat in the baseline.
- *The eraser* (`eraseSettingsSubject`, `settings/prefsStore.ts`, registered by the
  settings feature): deletes the subject's prefs row for each key form, and every usage
  row in the tenant whose user is a key form. Deleted, not scrubbed: neither store holds
  a shared or tenant-level setting, a personal pref has no meaning without its person,
  and the org lane (ADR 0178) keeps its own count. Tenant-scoped.
- *The census signal:* usage rows now record `userId` (the USER_ID_FIELD signal). Rows
  written before that are matched from the key, cut at its last `:` (a user id may hold
  `:`; a day never does). The 90-day age-out removes the last of them.
- *Manifest:* a new eraser id, so `eraseSettingsSubject` joins the WF-CONS-2 manifest
  with its ledger edge.
Tests: `test/chan-f19-settings-erasure.test.ts` (the real app's eraser set through
`eraseSubject`: the subject's prefs and day counters deleted, a legacy key-only counter
deleted, another person kept, the same person in another workspace kept). Four sabotage
probes, each red: the eraser unwired, the legacy key parse dropped, the tenant filter
dropped, the `userId` field removed from the row type (census red).

**CHAN-F19 #5 (2026-11-15): `commerce:affiliate` and `commerce:payout`, baseline 107 → 105
(ceiling 105). A DSAR for an affiliate is the operator redact route.**
A commerce affiliate (ADR 0177 P5, ADR 0447 P2) is an external person: a name, a
referral code and a commission. They are not a workspace principal, so no subject key
can reach them through `eraseSubject`, and an eraser leg would be a path that never fires.
User decision (2026-11-14): the workspace operator redacts them.
- *The route:* `POST /host/openwop-app/commerce/orgs/:orgId/affiliates/:affiliateId/redact`
  (`redactAffiliate`, `commerce/affiliate.ts`). The name becomes `[erased]`, in one CAS.
  A repeat is a no-op, and the telemetry event carries the id, never the old name.
  It needs `host:org:manage`, which only an org owner holds: the change cannot be undone,
  so it is an org-management act and not a member's write. An id from another tenant or
  org reads as absent (404, nothing leaked). Affiliate ids are global, so that is the
  cross-tenant case.
- *Kept, by decision:* the referral code, the rates, the commission ledger
  (`commerce:affiliate-ledger` and its payout runs, keyed by `payeeSubject` = affiliate
  id) and `commerce:payout` rows. They are money records, and none of them holds the name.
- *Census:* `declarePiiFields('commerce:affiliate', ['name'])` is the D2 signal.
  `commerce:payout` (affiliate id, amount, currency, status) is reviewed signal-free.
  No new eraser id, so the WF-CONS-2 manifest is unchanged.
Tests: `test/chan-f19-commerce-affiliate-redact.test.ts` (real HTTP, cookie sessions):
name erased with code, rates and accrued balance kept, the payout export shows the
placeholder, a repeat writes nothing; an editor gets 403 and the name is unchanged;
another workspace's manager gets 404 on a real id and it is unchanged. Six sabotage
probes, each red: the route unwired, the scope lowered to `workspace:write`, the
tenant/org check dropped, the code wiped too, the idempotence guard dropped, the PII
declaration dropped (census red).
