# 0189 — Mid-run connection interrupt (connect-to-continue)

Status: implemented

## Context

When a workflow step invokes a connector and the acting user has no active
connection for it, the run today **fails closed at the node**: the connector
choke point returns a graceful result (`connectorInvoker.ts` →
`{ ok: false, error: 'connector_no_connection' }`), the step reads as a no-op,
and the run continues. That posture is deliberate (ADR 0033 §3.3 — agents
propose, humans dispose; ADR 0037's graceful connector results), and the day-1
UX program (PR #1087) wrapped it in author-time honesty: the template
pre-flight (P3) and the Run-gate prompt (P9) surface unbound connections
*before* the run, with inline consent launches.

What still doesn't exist is the **mid-run** moment: a run that reaches an
unbound connector while a human is watching simply skips the step. The day-1
audit (D10/B3) called for a "connect X to continue" card. The 2026-07-02
architect review deferred it from the P9 slice because pausing a run touches
executor and replay semantics — this ADR is that deferred design.

## Decision

Ride the **existing normative interrupt primitive** — `ctx.interrupt(payload)`
(`spec/v1/interrupt.md`; `executor/types.ts` §interrupt/suspend), the same
mechanism `core.openwop.hitl` (form-request / approval-request / ask-user) and
the chat approval gate already suspend on. **No new pause machinery, no new
wire surface.**

1. **Raise.** When a connector invocation resolves `no_connection` AND the run
   is *interactive* (the same has-a-HITL-channel predicate the approval gate
   uses to know a card can be delivered), the invoking seam suspends with a
   typed payload:

   > **Correction (2026-07-02, Phase 1):** implementation recon found NO
   > existing interactivity predicate — HITL nodes suspend unconditionally.
   > Phase 1 therefore INTRODUCES it: `ctx.interactiveSession`, derived once
   > at executor ctx-build from `run.metadata.chatSessionId` (stamped by the
   > chat transport) AND a stamped acting human (the `trustBoundary`
   > ctx-fact pattern). Also: the suspend payload's `kind` field is reserved
   > by the engine's kind mapping (`mapSuspendKind` enum), so the card
   > discriminator is **`profile: 'openwop-connection'`** (the hitl
   > `openwop-form`/`openwop-chat` precedent), NOT `data.kind` as sketched
   > below.

   ```json
   {
     "kind": "connection-required",
     "ref": "<the node's connectionRef or capability token>",
     "providerId": "<resolved provider id, when the ref names one>",
     "category": "<capability category, when the ref is capability-typed>",
     "nodeId": "<the suspended node>"
   }
   ```

   with the deterministic interrupt key `conn:<nodeId>:<ref>` (interrupt.md
   §"key field") so replay short-circuits on the recorded resume value.

2. **Render.** The chat interrupt-card surface (the ONE chat — RFC 0005 /
   ADR 0073) gains a `connection-required` card that reuses the P9 connect
   flow verbatim: per-provider Connect button → `beginOAuth(providerId,
   returnTo)` when the host can run the consent (`oauthConfigured`), else the
   Access-hub link — plus **Skip this step**. The builder run overlay
   deep-links the same card.

3. **Resume.** The resume value is
   `{ "action": "connected" | "skip", "providerId"?: "<id>" }`.
   - `connected` → the node re-invokes through the SAME authorization choke
     point (`selectAuthorizedConnection` / `resolveProviderForCapability`) —
     the card never smuggles a credential; it only reports that one now
     exists. The **resolved providerId is stamped in the resume payload** so
     `:fork`/replay reads it verbatim and never re-resolves (the replay rule
     ADR 0001's correction taught us; run.metadata precedent).
   - `skip` → the node returns today's graceful
     `{ ok: false, error: 'connector_no_connection' }` — byte-identical to
     current behavior.

4. **Fail-closed boundaries (ADR 0033 preserved).**
   - **Headless runs** (scheduled, heartbeat, A2A — no interactive channel):
     behavior is UNCHANGED — the graceful no-op result, no suspension. A run
     that nobody is watching must never park on a question.
   - **Expiry:** the interrupt carries the host's standard HITL timeout; on
     expiry the resume value is `{ "action": "skip" }` — the run degrades to
     exactly today's posture rather than hanging.
   - **Autonomy:** `gateAutonomyByReadiness` (pre-run) stays the primary
     gate; this interrupt is the *recovery* path for what slipped past it,
     not a license to launch unready runs.

## The RFC gate — no new RFC

`ctx.interrupt` is already the accepted normative primitive; interrupt
*payloads* are host/pack data, not normative wire shapes — the direct
precedents are the `core.openwop.hitl` form/approval payloads and the chat
approval gate, none of which needed an RFC per payload kind. No new event
type, capability advert, or endpoint. (A future RFC could standardize the
`connection-required` payload for cross-host card portability — explicitly
out of scope here.)

## Alternatives weighed

- **Status quo (pre-run gate only, shipped as P9).** Covers the author-time
  moment but not long-running or multi-step runs where the missing binding is
  discovered mid-flight (e.g. a capability that resolves per-acting-user).
- **Fail the node, offer fork-from-checkpoint after connecting.** Replay-pure
  and zero executor change, but the UX is a dead run + a rerun — and `:fork`
  is not a user-facing affordance in the app today. Rejected as the primary
  path; it remains the natural fallback story for headless runs.
- **A new normative interrupt TYPE on the wire.** Would need an RFC reaching
  Accepted first, for no host benefit — the payload-over-existing-primitive
  achieves the same UX. Rejected (dishonest-wire risk for zero gain).
- **Pause via a new host-side run-state machine.** A second suspension
  mechanism beside the interrupt primitive — the no-parallel-architecture
  rule rejects this outright.

## Phased plan

| Phase | Scope | Notes |
|---|---|---|
| 1 | Executor seam: interactive-channel predicate exposed to the connector choke point; raise + resume semantics with the deterministic key; unit tests incl. replay short-circuit + expiry→skip | backend only, dark until Phase 2. **Landed** (feat/adr-0189): `ctx.interactiveSession` + `host/connectionInterrupt.ts` (invoke + capability-resolve helpers), wired into bigquery/workday/email-draft/calendar-capability nodes; expiry = lazy auto-skip on the open-interrupts read (mirrors the RFC 0093 §D approval-gate lazy timeout, but RESUMES-as-skip instead of failing); ticketing/HR/finance nodes deliberately keep their recommendation-style graceful paths (later slices if wanted) |
| 2 | Chat `connection-required` interrupt card (reuses P9 connect components) + i18n ×4 | **Landed** — `chat/cards/ConnectionRequiredCard.tsx`, discriminated by `data.profile` in `ClarificationCard` (single-chat rule; shared `GateEyebrow`). **Follow-up fix**: the connect UI was extracted to a shared `interrupts/ConnectionRequiredControls`, and `RenderInterrupt` (run-detail page + cross-run HITL inbox) now discriminates on the same profile → `ConnectionRequiredDialog`. Both interrupt surfaces render the Connect/Skip card; previously the non-chat path fell through to the free-text `ClarificationDialog` (wrong controls, though a stray answer still fail-closed to skip). This is what makes the P3 "Resolve →" deep-link land on the right card. |
| 3 | Builder run-overlay deep-link to the card | **Landed** — RunOverlayBanner "Waiting on you" state (derived from a suspended node) + Resolve → link to run detail; note: builder runs aren't chat-interactive, so the connection prompt itself is chat-scoped — the overlay change also fixes the stale "Running" banner for approval-gate suspends |
| 4 | Manual test page + FEATURES.md note | **Landed** — `connect-to-continue` suite (C2C-01..05) in the manual-tests runner + this FEATURES row |

## Scoping decision — the prompt is chat-interactive, by design

`ctx.interactiveSession` is derived from `run.metadata.chatSessionId` + an acting
human, i.e. "a chat delivery channel exists" — NOT "any human is watching".
**Builder-initiated runs deliberately do not carry it** (`createRun({workflowId,
inputs})` stamps no session), so a missing connection in a builder run stays the
graceful fail-closed no-op and the **P9 pre-run gate is the builder's connection
prompt** — the right-time prompt on an authoring surface where you set up before
you run. Mid-run prompting earns its keep in chat, where runs are turn-by-turn and
a human is present. This is a decision, not an oversight; the P3 overlay change
still fixes the stale "Running" banner for *any* builder suspend (e.g. approval
gates), and the RenderInterrupt fix above means the card renders correctly if a
builder run ever does suspend on a connection.

If builder mid-run parity is later wanted, it is a clean follow-up (cheap because
the shared card already exists): stamp an explicit `run.metadata.interactive` at
builder launch, broaden the predicate to `chatSessionId || metadata.interactive`,
and design the OAuth return-to-builder flow. Gate on real demand.

## Open questions — resolved after Phase-1 seam investigation

- **Skip-memory per (workflow, ref) — DEFERRED, blocked on a primitive.**
  Investigated: making a later node skip silently because an earlier node's
  prompt was skipped needs cross-node run state that survives suspend/resume
  **replay-deterministically**. The two candidate seams both fail that bar
  today: (a) `ctx.variables` persists per-run but the variables runtime marks
  mid-run mutation as *future scope* (HVMAP-2) — not a blessed replay surface;
  (b) the interrupt resolution mechanism is replay-safe but `reinvokeResolutions`
  seeds **only the single resumed node** (`executor.ts` — keyed by `resumeNodeId`),
  not run-wide, so ref-keying a shared `conn:<ref>` interrupt would still
  re-suspend the next node. Building skip-memory on either surface now would
  reintroduce exactly the replay fragility P1 guarded against. The annoyance is
  also narrow (only repeated *skip* of the same provider across multiple
  connector nodes; the *connect* happy path already unblocks all downstream
  nodes). **Revisit when HVMAP-2 lands a blessed mid-run variable-mutation
  surface, OR when the executor accumulates resolutions run-wide** — either
  makes it a small change.
- **Org-scope "an admin must connect this" variant — NOT NEEDED yet, no
  concept to hang it on.** Investigated the connection model: providers are
  *user-self-connectable* by default (OAuth self-consent); the org axis is a
  *choice at connection-create time* (`scope:'org'` is admin-gated on
  `host:connections:manage`, `connections/routes.ts`), not a provider property.
  There is no "this provider can ONLY be connected org-wide by an admin" state
  in the manifest, so "you can't connect this, ask your admin" isn't a
  well-defined condition to detect. The card already handles the adjacent honest
  case (host has no OAuth client → Access-hub link). **Revisit only if an
  org-managed-only provider concept is added** to `providerRegistry`; then the
  variant is a card branch on that flag + a notify-admin action.

## Follow-ups landed

- **Operator-tunable prompt timeout** — `OPENWOP_CONNECTION_PROMPT_TIMEOUT_SEC`
  (default 15 min; mirrors `OPENWOP_APPROVAL_GATE_DEFAULT_TIMEOUT_SEC`), read
  per-suspend. Enabled the **expiry→skip integration test** P1 lacked, which
  exercises the CAS-claimed lazy-resume path end-to-end (expired prompt drops
  from the open listing, run settles to the graceful no-connection terminal,
  resolved exactly once across repeated reads).
