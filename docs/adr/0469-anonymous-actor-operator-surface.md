# ADR 0469 — Anonymous-actor operator surface: production write/egress activation

Status: implemented (all phases A–D landed — see Implementation record)

Resolves the open questions **OQ1** (production widget write/egress) and **OQ2**
(`rate-limit-session-cap` control) of [ADR 0468](0468-anonymous-actor-authorization-host.md).
Host-only, additive, **no wire change and no new RFC** — RFC 0132 is Accepted
(openwop#869; protocol 119→124) and the `anonymousActor` capability (both tiers) is
already advertised. This ADR activates the bounded-write-egress tier on the *production*
widget (today it exists only on the conformance seam) and gives operators a way to
configure and act on it.

## Context — what #2403 shipped vs. what is still inert

ADR 0468 / PR #2403 shipped the RFC 0132 host half: the opaque principal, default-deny
grant model (`WidgetConfig.anonToolGrant` + `cleanAnonGrant` validation already exist),
the two decision primitives (`authorizeAnonTool` + `guardAnonEgress`), the
`authorization.decided` audit, the `owner.principalKind:"anonymous"` projection, and the
production read-tier turn `runAnonReadTurn`. The **conformance seam** exercises both
tiers non-vacuously.

On the **production widget**, everything past the read tier is decision-only, not
functional:
- A granted bounded-write returns `"pending_approval"` *text* to the visitor but creates
  **no durable RFC 0051 approval** (`anonymousActor.ts` `wrappedExecuteTool`) — so an
  operator can neither see nor act on it.
- Egress is **not wired** on the widget: `guardAnonEgress` is called only in the seam
  adapter, never in `runAnonReadTurn`.
- There is **no operator UI** to author a widget's `anonToolGrant` write/egress tiers.
- Anon writes never reach the operator approval inbox.
- No anon-specific write/egress caps (turn-level `capsTracker` only).

## Decision

Activate the tier by **extending existing owners** — no parallel systems. The four
integration seams (verified by an architecture-review seam map):

1. **Approval** rides the ONE typed kind-dispatch table
   (`approvalDecision.ts` `KIND_DISPATCH … satisfies Record<DecidableKind, …>` — a new
   kind without an entry is a compile error). New kind `anon-surface-write`.
2. **Operator inbox** is data-driven (`chat/reviews/ReviewInboxPanel.tsx` +
   `ReviewCard.tsx` render `review.kind` + `review.actions` with no per-kind switch) — a
   new kind surfaces with **zero new UI**.
3. **Grant editor** lives in the existing `/chat-deployment` hub
   (`features/chat-deployment/ChatDeploymentHubPage.tsx`) over the existing
   `PATCH …/chat-widget/orgs/:orgId/widgets/:widgetId` route (`workspace:write`).
4. **Caps** extend the existing `features/chat-widget/capsTracker.ts` +
   `WidgetCaps` — no parallel rate-limiter.

## Architecture-review findings (baked into the plan)

- **[CRITICAL, security] Write caps gate approval CREATION, not just execution.** Without
  a cap before `createApproval`, an internet bot floods the operator inbox — an
  approval-inbox DoS. The `capsTracker` write check MUST precede
  `createAnonSurfaceWriteApproval`. ⇒ the cap work (OQ2) lands **with** Phase A, not after.
- **[CRITICAL, data/security] Approve→execute is deferred execution.** `runAnonReadTurn`
  completes synchronously; the held write runs later on approval. So the approval payload
  MUST persist the exact tool call (name + args + destination), and the `KIND_DISPATCH`
  handler MUST re-run it **tenant-scoped with `actingUserId` undefined** (preserving the
  ADR 0468 no-secret-reach floor). Egress on approve MUST still pass `guardAnonEgress` +
  the SSRF-guarded fetch (`credentialAttached:false`) — approval is NOT an egress bypass.
  Reject fails closed (no effect).
- **[HIGH, authz] Tool-picker source.** The existing catalog route
  (`agentAllowlists.ts` `agent-allowlists/admin`) is **superadmin-gated**; the widget
  grant editor is `workspace:write`. Reuse the underlying `buildToolCatalog()` behind a
  **workspace-scoped** read — do not couple the operator editor to a superadmin route.
- **[HIGH, security/PII] Captured visitor data is untrusted PII** on the approval
  payload. The APPR-5 redactor (enforced: `getRegisteredApprovalRedactorKinds`) for
  `anon-surface-write` MUST redact the captured fields; the actor stays the opaque anon
  principal (non-PII).
- **[PASS] Boundaries** — every concept defers to its existing owner; no duplication.

## Phased implementation plan

### Phase A — Production write/egress activation + the security cap (backend)
Lands as one unit (the cap is a security prerequisite for the write path going live).

- **A1. New approval kind `anon-surface-write`** on the existing seam:
  tuple `APPROVAL_KINDS` → typed `PendingApproval.anonSurfaceWrite?` payload
  (widgetId, opaque principal, tool call `{name,args,destination?}`, captured fields) →
  `createAnonSurfaceWriteApproval` (copy `createContentApproval`) → handler pair →
  `registerApprovalRedactor('anon-surface-write', …)` redacting the captured PII →
  `KIND_DISPATCH` entry → `reviewProjection.approvalVisible` RBAC branch (surface-tenant
  operators only).
- **A2. `runAnonReadTurn` write/egress wrapper** (replace the stub): on a granted write,
  (a) check the anon **write cap** (A3) — over-limit ⇒ deny + audit; (b) create the
  durable approval with a deterministic business key (anon run + tool-call index, so a
  retried dispatch is idempotent — no duplicate approvals); (c) return "awaiting review"
  to the visitor. For egress tools: run `guardAnonEgress` at decision; a human-gated
  egress uses the same approval path.
- **A3. Anon write/egress caps** (OQ2 part 1): add fields to `WidgetCaps` + `cleanCaps`;
  add a counter `DurableCollection` + `checkAnonWrite(…)` in `capsTracker.ts` (mirror
  `checkWidgetTurn`, CAS-atomic); extend the retention purger.
- **A4. Approve→execute handler**: on approve, re-run the held tool call via a
  surface-tenant-scoped provider with `actingUserId` undefined; egress via
  `guardAnonEgress` + the guarded fetch; record the outcome (`attachRunId`/result) on the
  approval. Reject ⇒ no effect.
- **Tests**: route-level (boot app + probe) — write→approval created (not executed),
  approve→executed, reject→no effect, egress-on-approve audience-guarded, cap gates
  approval creation (anti-flood), flag-off behavior, redactor covers captured fields.

### Phase B — Grant-authoring UI (frontend)
- Extend the widget console in `/chat-deployment` with a grant panel: pick **read** tools,
  **write** tools + control (`hitl`), **egress** tools + declare **audiences**; PATCH via
  the existing widget route. Populate the tool picker from a **workspace-scoped**
  tool-catalog read (finding 3) — new thin route over `buildToolCatalog()`. Reuse
  `surface-card` / `<Notice>` primitives; no new design components.

### Phase C — Approval inbox integration
- **Zero new UI** — the data-driven `ReviewCard` renders `anon-surface-write` from the
  backend `review.kind` + `review.actions`. Ensure a clear human-readable label + risk
  chip. (A richer per-kind card is an optional later enhancement via the assistant-action
  projector pattern.)

### Phase D — Full OQ2: `rate-limit-session-cap` control
- Wire the `rate-limit-session-cap` `AnonWriteControl` (today only `hitl` exists) as an
  alternative to HITL for low-risk writes — a per-session write cap that auto-allows
  under the cap and denies over it, no human gate. Extends A3's counter.

## Sequencing gates
A (with A3's cap) is the security-complete backend unit and MUST land first. C is free
once A's kind exists. B (UI) follows A. D layers on A3. No phase boundary is a scope-cut —
each is a real dependency gate.

## Open decisions
1. **OD1** — Default posture when a widget grants a write tool but sets no control:
   deny `anon-write-ungated` (current seam behavior) is retained; the UI MUST require a
   control when a write tool is added (mirror `cleanAnonGrant`'s server-side rule).
2. **OD2/OQ2** — Approval expiry for anon writes. **✅ RESOLVED (follow-on).** A pending
   `anon-surface-write` hold now auto-expires: `purgeExpiredAnonHolds` self-registers on the
   ONE retention seam (`registerRetentionPurger`, module-load like `capsTracker`) and deletes
   PENDING anon holds older than the **`confidential-pii`** retention cutoff (the holds carry
   visitor PII, so that existing operator window IS their TTL — no new knob). Only pending
   rows (a decided hold is an audit record kept on its own window); tenant-scoped via the
   by-tenant-status index (not a full scan); the pending status-index entry is dropped with
   each row. Covered by `test/adr0469-anon-hold-ttl.test.ts` (5 cases).
3. **OD3** — Whether captured lead data should route to CRM on approve (the ADR 0449
   contact bridge) or stay on the approval only. Deferred to a CRM-bridge follow-on.

## §N3 — the write tier has no non-deliverable write tool yet (characterization)

**Verified finding (grade-code `0469-N3`):** every tenant-**write** tool in the current
registry is an **ADR 0308 deliverable** gated on an acting user — `kanban.add-todo`
(`agentToolProvider.ts:283`, `acting_user_required`), plus the feature-registered
`documents.draft`/`email.draft`. The anon write tier runs the held/auto tool
**tenant-scoped with `actingUserId` undefined** (the no-secret floor), so **an approved or
auto-executed anon write of any of today's write tools FAILS CLOSED at execution** — the
rail is correct and safe, but nothing genuinely mutates yet.

- **What N3 proved:** the execution *plumbing* lands a real result end-to-end — a tool that
  succeeds `actingUserId`-undefined (`knowledge.search`), granted AS a write, executes on
  both the A4 deferred-approve path and the Phase-D auto path and feeds back its real result
  (not a hold, not `acting_user_required`). Tests: `adr0469-phase-d-auto-write.test.ts` (N3
  positive) + the existing A4 "APPROVE … EXECUTES" case.
- **What remains (own ADR, not this one):** a **non-deliverable tenant-write tool** — the
  natural first is a **public lead-capture** tool that writes a CRM Contact via the ADR 0449
  `ensureContact` seam (a public visitor submitting their OWN details needs no acting user).
  That gives the write tier a real production consumer. Feature-package scope → a dedicated
  ADR + node pack (`/feature-refinement`), deliberately NOT smuggled into this surface.
- **Operator guidance (until then):** granting a *deliverable* write tool to an anon surface
  yields holds/auto-runs that fail closed at execution; the write tier is production-useful
  once a non-deliverable write tool ships.

Everything stays behind `OPENWOP_ANON_ACTOR_ENABLED` (default OFF). The flag is the
operator's to flip once the surface is configured.

## Implementation record

| Phase | Status | Commit / test |
|---|---|---|
| A1 — `anon-surface-write` kind (idempotent create, KIND_DISPATCH, redactor, reviewProjection RBAC) | ✅ implemented | `approvalService.ts` / `approvalDecision.ts` / `reviewProjection.ts` |
| A2 — `holdGrantedWrite` DI hook (host actor stays feature-agnostic; `publicGateway` wires widget+caps+approval) | ✅ implemented | `anonymousActor.ts` / `publicGateway.ts` |
| A3 — per-day write cap gates approval CREATION (anti-flood) | ✅ implemented | `capsTracker.checkAnonWrite` / `WidgetCaps.maxWritesPerDay` |
| A4 — approve→execute (CAS-flip-first + compensating reopen; `workspace:write` decider gate) | ✅ implemented | `decideAnonSurfaceWrite` |
| Tests (A) | ✅ | `test/adr0469-anon-surface-write.test.ts` (8 cases) |
| B — grant-authoring UI (`WidgetGrantEditor` + workspace-scoped tool-catalog route reusing the exported `buildToolCatalog` SSoT) | ✅ implemented | `features/chat-widget/routes.ts` (`GET …/tool-catalog`, `workspace:read`) / `WidgetGrantEditor.tsx` / `chatWidgetClient.ts` |
| Tests (B) | ✅ | `test/adr0469-widget-grant-route.test.ts` (4 route cases) + `WidgetsPage.test.tsx` (editor + HITL-only) |
| C — approval-inbox integration (opaque-visitor requester + risk chip; ZERO new UI — data-driven `ReviewCard`) | ✅ implemented | `reviewProjection.approvalToReview` |
| Tests (C) | ✅ | `test/adr0469-anon-review-projection.test.ts` (2 cases) |
| D — `rate-limit-session-cap` control: AUTO-EXECUTE inline under a per-session cap (`authorizeAnonTool` returns the control; `autoWriteUnderCap` DI hook; `checkAnonAutoWrite`; editor offers it) | ✅ implemented | `anonymousActor.ts` / `capsTracker.checkAnonAutoWrite` / `publicGateway.ts` / `WidgetGrantEditor.tsx` |
| Tests (D) | ✅ | `test/adr0469-phase-d-auto-write.test.ts` (7 cases) + `WidgetsPage.test.tsx` (auto-run selector) |

### Correction notes (architect + code-review, Phase D)

- **Egress posture (Q1, CRITICAL).** Auto-execute (no human gate) MUST never reach an
  audience-unbound egress. The wrapper can't bind the anon audience inline, so
  `rate-limit-session-cap` auto-executes ONLY when the surface declares **no egress
  audiences**; a surface with egress falls back to the HITL hold path (`holdGrantedWrite`).
  The scoped provider's `guardedEgressFetch` (SSRF + ADR 0187 tenant egress policy) is the
  always-on floor. UI mirrors this (`controlEgressForcesHitl`).
- **Dual caps (Q2, defense in depth).** An auto-write consumes BOTH the per-session
  (`checkAnonAutoWrite`) AND the per-day (`checkAnonWrite`, A3) budget — a bot cycling
  sessions is still bounded per-day.
- **Honest control (Q3).** A per-session count cap is a legitimate RFC §C.3 mandatory
  control: the tool still runs tenant-scoped `actingUserId`-undefined (no-secret floor
  holds), it's dual-count-bounded, egress stays operator-reviewed, and the UI labels it
  plainly ("auto-run, no approval"). An unbounded auto control is forbidden — the control
  REQUIRES `caps.maxAutoWritesPerSession` (cross-field save guard + runtime fail-closed).
- **Audit (Q4).** Distinct reasons `anon-write-auto-allowed` / `anon-write-auto-capped`,
  attributed to the opaque principal — distinguishable from the held path.

### Correction note (architect, Phase B)

- **Honest-advertise (HIGH).** `authorizeAnonTool` (anonymousActor.ts) currently treats
  `rate-limit-session-cap` IDENTICALLY to `hitl` (both `requiresApproval:true`) — the
  distinct "auto-allow under a per-session cap" semantics are **Phase D**. The Phase B
  grant editor therefore offers **`hitl` only** (write tools are always held for
  approval); `rate-limit-session-cap` is not selectable until Phase D wires its turn-time
  behavior. Locked by a `WidgetsPage.test.tsx` assertion.
- **SSoT reuse.** The workspace-scoped catalog route reuses the exported
  `buildToolCatalog` (agentAllowlists.ts) — the ONE catalog builder — rather than the
  superadmin `/agents/:agentId` route (finding 3) or a second copy (which already drifted
  once on visibility, per that file's own comment).

### Correction notes (code-review, Phase A)

- **A4 decider-scope self-check (HIGH, authz).** The claim/reject route enforces **no
  per-kind scope** — every feature handler self-enforces (e.g. `decideEnvironmentPromotion`
  → `host:members:manage`). `decideAnonSurfaceWrite` therefore self-checks the decider
  holds **`workspace:write`** (the same scope `reviewProjection.approvalVisible` gates
  visibility on) BEFORE the CAS flip. `reviewProjection` visibility is NOT decision
  authority — without the handler check, an under-privileged tenant member could POST a
  guessed `approvalId` to trigger the deferred write. Regression-tested.

### Deferred (documented, not hidden)

- **OD4 — `tool.args` PII on erasure. ✅ RESOLVED (follow-on, PR pending).** The redactor
  now redacts `anonSurfaceWrite.tool.args` + `.destination` (the depth-capable
  `getPath/setPath` reach the nested object), AND a new `ApprovalKindRedactor.onSubjectMatch:'cancel'`
  flips a still-PENDING hold to `rejected` on erasure — so the (sentinel-stringified) args
  can never be executed by A4 for a gone visitor, and the row survives as a redacted audit
  record. A resolved row is redacted but keeps its terminal status. Covered by
  `test/adr0469-anon-surface-write.test.ts` (cancel + full redaction + resolved-keeps-status
  + idempotency). Architect Q1-Q4 ruled: cancel-not-delete (audit), erasure-wins on the rare
  DSAR race (the decide-side CAS protects), idempotent (redacted principal won't re-match).
- **OD5 — deferred-execution run-event.** A4 records the operator decision via the
  dispatcher audit (`anon.surface.write.approved` + tool), but appends no event to the
  (terminal) anon run's own log. Acceptable — the durable audit exists; revisit if the
  anon run's event log becomes an operator-facing timeline.
