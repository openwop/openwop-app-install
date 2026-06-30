# ADR 0051 — A2UI agent-authored interactive chat surfaces

**Status:** implemented (Phase 2 wire-honest adopted + conformance-proven; Phase 3 use-cases shipped — see the phase table. Status line corrected 2026-06-22.)
**Date:** 2026-06-15
**Toggle:** `a2ui-surfaces` (default OFF, `bucketUnit: tenant`)
**Capability:** no new `AgentCapabilityId`. A2UI is a *rendering layer*, activated by a
host-pinned component catalog + the existing chat card registry; any
capability-activated agent (assistant, advisor, work-twin) can emit a surface.
**Depends on / composes:** RFC 0055 (multimodal envelope variants + `meta.rendering` —
extended additively with a `display: "a2ui"` value and a `ui.a2ui-surface` kind),
the **chat card registry** (`frontend/react/src/chat/registry/` — `registerCard`,
`CardProps.onAction`, `CardHost` error boundary), the **`host.chat` surface**
(`backend/typescript/src/host/chatSurface.ts` — `emitCard`/`updateCard`, the
`core.chat.*` nodes per `bootstrap/hostSurfaceMap.ts:106`), the **interrupt/resume
contract** (the 4 interrupt cards in `chat/registry/defaultCards.tsx`), ADR 0027
(connected-content trust / untrusted-input taint), ADR 0001 (feature-package),
ADR 0024 (Connections — cross-host A2A agent identity).
**Surface:** no new HTTP route. One new frontend card registration (`ui.a2ui-surface`; see § Correction)
+ one new pack node (`core.chat.emitSurface`) beside `core.chat.sendMessage` /
`core.chat.progressCard`. The A2UI component catalog version is advertised in
`/.well-known/openwop` once Phase 2 lands.
**RFC gate — CLEARED (2026-06-15).** This touches the **wire** (a cross-host-observable
envelope kind + a capability advertisement), so the honest cross-host version was gated on
a new RFC — **RFC 0102 (A2UI agent-authored interface surfaces)**. That RFC is now
**`Active`** (the 7-day comment window was waived by the maintainer to unblock
implementation; per `../openwop/RFCS/README.md` §"Status states", `Active` **locks the wire
shape** and implementation may proceed — `Accepted` is reached *after* this reference host
implements + conformance reflects it, so `Active`, not `Accepted`, is the correct gate to
begin). Implementation of Phase 2 is therefore unblocked now. A host-only de-risking
prototype (Phase 1) was always unblocked under a vendor-namespaced kind advertised
`supported: false`; it makes **no** wire claim. See § "RFC gate".

> **Correction (2026-06-16):** RFC 0102 reached **`Accepted`** on 2026-06-15 — it
> graduated on dual live witnesses vs `@openwop/openwop-conformance@1.26.0`: the
> **openwop-app** reference host (19/19 a2ui assertions under
> `OPENWOP_REQUIRE_BEHAVIOR=true`) **and** the **MyndHyve** non-steward witness
> (`workflow-runtime-00485-kon`, 19/19), both on the byte-identical core schema. The
> "`Active`-is-the-gate" reasoning above held exactly: `Accepted` followed once this
> reference host implemented and conformance reflected it. The proof-run was
> re-confirmed on current `main` (5/5 a2ui scenarios, 19 assertions, suite 1.26.0).

## § Correction (2026-06-15) — RFC 0102, final shape

A cross-session architecture review (`openwop-1`, via crosstalk `A2UI`) revised RFC 0102
the same day it landed, and the kind namespacing flipped twice before settling. The body
below predates this; where it conflicts, **this note wins**. Final settled shape (RFC 0102
re-amended to core, openwop#716; reference renderer aligned, openwop-app this PR):

- **Kind is the core, un-namespaced `ui.a2ui-surface`** — a content-primitive family
  beside `media.*` (`ai-envelope.md` §"A2UI surfaces"). *(History: a brief vendor-namespaced
  detour — `vendor.openwop-app.a2ui.surface`, openwop#715 / openwop-app#319 — was reverted
  by maintainer ruling because vendor-namespacing defeats the cross-host portability this
  RFC exists to deliver. The `vendor.*` string remains valid only as a Phase-1 prototyping
  namespace.)*
- **No `a2ui` capability block.** Advertise via the existing `supportedEnvelopes` +
  `schemaVersions` surface only.
- **`catalogVersion` is host-enumerated**, not free-string; unknown/higher →
  `unknown_schema_version`; the stored surface is self-contained for replay.
- **`surface` is a closed `anyOf`** over the day-1 components, discriminated by a
  single-string-enum `component` field (NOT `oneOf` — banned for LLM-emitted payloads,
  `ai-envelope.md` §"Variant payload discrimination"). The invariant set is **five**
  (`a2ui-surface-no-code-exec`, `a2ui-action-confinement`, `a2ui-surface-no-network-egress`,
  `a2ui-surface-no-secret-rendering`, `a2ui-untrusted-blocks-approval`) +
  a `threat-model-prompt-injection.md` update.
- `display: "a2ui"` stays dropped.

## Why this exists

OpenWOP's AI chat can already render rich inline cards — but only ones we have
**pre-built in the React frontend**. The card registry
(`frontend/react/src/chat/registry/`) is the documented extensibility seam, and the
`host.chat` surface (`backend/typescript/src/host/chatSurface.ts`) already lets a
workflow `emitCard({ cardType, payload })` / `updateCard(...)` into the live session.
The gap is the *renderer*: every `cardType` a workflow emits must have a matching
React component compiled into the SPA. The four built-in interrupt cards prove the
ceiling — `ApprovalCard` is fixed buttons, `ClarificationCard` is a bare textarea,
`RefinementCard` is a JSON textarea (`chat/registry/defaultCards.tsx`). An **agent
pack** — or worse, a **remote cross-host A2A agent** we don't control — cannot ship a
*new* interactive form (a date+attendees+duration picker, a per-action review panel)
without a frontend deploy from us.

[A2UI](https://a2ui.org/) (Apache-2.0, v0.9.1 production / v1.0-candidate) is the
right shape for the missing layer: an agent emits a **declarative UI surface** built
from a **pre-approved component catalog**, with data binding and actions that route
**back to the agent**. The headline property — *"declarative data, not executable
code, so agents can safely send rich UIs across trust boundaries"* — is precisely
OpenWOP's posture: multi-host, cross-host A2A, third-party packs. A remote agent can
present a real form in our chat **without us executing its code**, because the host
renders only its own pinned catalog components.

Two product use cases motivate it concretely:

1. **Structured clarification / parameter collection** instead of free-text. When the
   assistant needs to disambiguate a `calendar.invite` (date / attendees / duration)
   it today can only ask in prose via `ClarificationCard`. With A2UI it emits a real
   form and the typed answer comes back as the interrupt resume value.
2. **Per-kind action-review UI defined in the pack**, not hardcoded per
   `PendingAction` kind (`email.send` / `calendar.reschedule` / `nudge` in
   `features/assistant/assistantService.ts`). Each action kind ships its own review
   surface (recipient diff, editable fields) from the pack that defines the action.

## Decision

Adopt A2UI as the **generative-UI rendering layer** for agent-authored interactive
chat cards, riding the existing seams rather than forking them:

1. **Frontend — one renderer for all future surfaces.** Register a single card type
   `ui.a2ui-surface` via `registerCard(...)`. Its component renders an A2UI surface
   from `CardProps.payload` against a **host-pinned, closed component catalog**, and
   routes A2UI actions through the **existing** `CardProps.onAction` path. No per-card
   React code is ever needed again; new agent-authored forms are pure data.

2. **Actions are resume/exchange, never a new channel.** An A2UI action on a surface
   bound to an open interrupt maps its collected form data into the **existing**
   `onAction('resolve', <resumeValue>)` contract — the same path the four built-in
   interrupt cards use. A surface bound to a conversation turn (RFC 0005) maps to an
   `exchange(...)` message. A2UI is a *renderer over the interrupt/resume seam*, not a
   second HITL or RPC system. We **do not** adopt A2UI v1.0-candidate's
   client-to-server RPC in this ADR.

3. **Backend — emit rides `host.chat`.** `emitCard({ cardType: 'ui.a2ui-surface',
   payload })` already works as-is (`chatSurface.ts:108`). Add a thin `core.chat.emitSurface`
   pack node beside `core.chat.sendMessage` / `core.chat.progressCard` for ergonomic
   authoring; `updateCard` (merge/replace, already idempotent) is the "agent revises
   the surface" path.

4. **Wire — extend RFC 0055, don't invent.** A2UI surfaces are carried as a new
   universal envelope kind `ui.a2ui-surface` (a new `ui.*` family — interactive UI,
   not `media.*`) with a `schemas/envelopes/ui.a2ui-surface.schema.json`, plus a new
   an optional `a2ui` capability block (`{ catalogVersion, components[] }`) so a cross-host
   agent knows what it may emit. The kind is the additive vehicle (the `type` discriminator
   is open, like `media.*`); the RFC 0102 five-architect pass **dropped** a
   `meta.rendering.display: "a2ui"` enum value as redundant + the one non-clean-additive
   edge (widening a closed, validated enum). All additive (see § Compatibility). This is
   **RFC 0102**.

### What stays the same (no parallel system)

- HITL stays the interrupt/resume machinery; A2UI only changes *how the prompt is
  rendered and how the answer is collected*. The hardcoded `ClarificationCard` /
  `RefinementCard` / `ApprovalCard` remain the **default fallback** when no surface is
  supplied or the catalog version isn't recognized.
- Persistence stays `emitCard`/`updateCard` + the chat message store. A surface is an
  event-logged `workflow_run` message (`chatSurface.ts:115`), exactly like any card.
- Replay/fork stays deterministic by construction (see below).

## Security model (the point of A2UI)

A2UI is attractive *because* it is declarative. The invariants that make that real —
and that become public, conformance-testable MUST-NOTs in RFC 0102:

- **Closed catalog, fail-closed.** A conformant renderer renders **only** host-pinned,
  pre-approved components and **MUST reject** any component outside the advertised
  catalog (render the existing `CardHost` fallback / `<Notice>`, never eval, never
  inject HTML). Proposed invariant `a2ui-surface-no-code-exec`.
- **Actions resolve to resume/exchange only.** An A2UI action **MUST** resolve to a run
  interrupt resume or a conversation exchange — **never** a direct host RPC or
  side-effect — in this profile. Proposed invariant `a2ui-action-confinement`.
- **Untrusted-author trust — compose with the wire, don't reinvent.** A surface emitted by
  a node that consumed untrusted MCP/A2A content carries the **existing**
  `meta.contentTrust: 'untrusted'` (`ai-envelope.md` §"Trust boundary"), propagated to the
  derived `RunEventDoc`s. The existing rule `untrusted_content_blocks_approval` therefore
  **already blocks** an untrusted-authored surface from advancing an `approval` interrupt —
  no new taint primitive. ADR 0027 remains the app-side mapping for how that
  `contentTrust` flag flows into action governance (ADR 0028/0036).
- **No secrets, tenant-scoped assets.** A surface payload carries no credential material
  (same SR-1 redaction as `meta`); any image/file the surface references follows the
  `media-asset-url-tenant-scoped` invariant (RFC 0055 §C) — no remote/guessable URLs
  (SSRF / tracking-pixel vector).

## Replay / fork safety

Deterministic by construction, because A2UI reuses the two seams that are already
replay-safe:

- The **surface** is emitted as an event-logged `workflow_run` message (`chatSurface.ts:115`).
  On replay/`:fork` it is read **verbatim** from the event log — the LLM is **never**
  re-asked to regenerate it (which would produce a different surface). 
- The **answer** is the interrupt resume value, stamped and read back verbatim by the
  existing interrupt machinery.
- Therefore the only durable state is `(emitted surface envelope, submitted resume
  payload)`. Ephemeral A2UI data-binding state (a partially-filled, never-submitted
  form) is **not** durable and **MUST NOT** be relied on — it is fine to lose on reload.

## Streaming

A2UI is "flat, streaming JSON" generated incrementally; OpenWOP envelopes already carry
`partial: true`. The renderer renders partial surfaces as they stream **but MUST gate
interactivity until the envelope finalizes** (`partial: false`) — submitting an action
against a half-streamed form is a correctness bug.

## Compatibility — Additive

Per `COMPATIBILITY.md` §2.1, and mirroring RFC 0055 (which added `media.{image,audio,file}`
the same way):

- New **optional** advertised envelope kind `ui.a2ui-surface` (beside `media.*`) — the
  `type` discriminator is open, so consumers that don't recognize the kind degrade to
  default (raw-JSON / `<Notice>`) rendering. This is the additive vehicle.
- New **optional** `a2ui` capability block in `/.well-known/openwop`, plus the existing
  required `supportedEnvelopes`/`schemaVersions` advertisement (no new required field).
- (Dropped by RFC 0102) a `meta.rendering.display: "a2ui"` value — redundant with the
  `type` discriminator and the only non-clean-additive edge (closed-enum widening).

No required→optional change, no type change, no relaxed MUST, no error-code remap.

## Phased implementation plan

| Phase | What | Gate |
|---|---|---|
| **0 — RFC** ✅ | **RFC 0102 is `Accepted`** (graduated 2026-06-15; was `Active` earlier the same day): `ui.a2ui-surface` kind + schema, `a2ui` capability block, the 2 SECURITY invariants, conformance scenarios. (`display: "a2ui"` was dropped — see § Compatibility.) | ~~RFC comment window~~ **waived → Active → `Accepted` (dual-witness).** |
| **1 — Host-only prototype (no wire claim)** | Frontend `a2ui.surface` card renderer over the A2UI **0.9.1** catalog (form subset), behind toggle `a2ui-surfaces`, emitted under a **vendor-namespaced** interim kind advertised `supported: false`. De-risks the renderer + action→resume mapping without a dishonest cross-host claim. | none (non-normative) |
| **2 — Wire-honest** | Core kind `ui.a2ui-surface`: renderer aligned ✅; per-kind schema vendored byte-identical (sha256 `68f977c1…`) ✅; advertised in `supportedEnvelopes` + `schemaVersions` ✅; acceptor validates it (accepted/gated/invalid/untrusted-blocks-approval) ✅; render-side probes (`no-code-exec`/`no-network-egress`) ✅. `core.chat.emitSurface` node deferred (existing `emitCard({cardType:'ui.a2ui-surface'})` already emits; the node is ergonomic sugar). Conformance *proof run* ✅ — all five a2ui scenarios (`shape`/`degrades`/`version-refusal`/`replay`/`untrusted-blocks-approval`, 19 assertions) pass vs `@openwop/openwop-conformance@1.26.0` under `OPENWOP_REQUIRE_BEHAVIOR=true` (re-confirmed on current `main`); the same evidence graduated RFC 0102 to `Accepted` on dual witnesses (openwop-app + MyndHyve). | Phase 0 `Accepted` ✅; **adopted + proven** |
| **3 — Use cases** | **Started ✅** — the interrupt→A2UI bridge is live (`chat/a2ui/interruptBridge.ts` + `MessageFeed`): any `clarification`/interrupt carrying `data.{catalogVersion,surface}` renders as a real A2UI form in chat, collected values → interrupt resume. Producers shipped on the bridge: <br>• **`local.openwop-app.a2ui-clarify`** node + the `openwop-app.a2ui-clarify` sample workflow (a meeting-scheduling surface). <br>• **`calendar.invite`** ✅ — the assistant's `feature.assistant.nodes.enqueue-action` node clarifies an incomplete invite (missing title / start / attendees) via the awaitable `ctx.suspend` (interrupt.md); resumed values merge into `payload.event` before the single `enqueueActionWithApproval` enqueue (test: `…/assistant-calendar-a2ui.test.ts`). <br>• **`email.send`** ✅ — a drafted email with no recipient raises the same surface to collect recipient (+ subject); a subject-only gap is non-blocking (it has a default). The recipient is re-validated on resume (untrusted wire value; the `prepare-action-request` CR/LF header-injection defense is preserved), and a still-missing recipient fails fast rather than enqueuing a doomed email (test: `…/assistant-email-a2ui.test.ts`). <br>• **`calendar.reschedule`** ✅ — when the event is known (`payload.eventId`) but the new time isn't, the same date/slot/duration surface collects it and merges into `patch.start`/`patch.end` (shared `buildEventTimes` builder); a missing `eventId` is not clarified (no event picker in the catalog), and an unusable resumed date fails fast (test: `…/assistant-reschedule-a2ui.test.ts`). <br>• **`nudge`** — intentionally NO surface: a nudge executes internally as a Notifications-inbox item whose only field is `draft` (always required by `enqueue-action`); there is no recipient/target to disambiguate, so inventing a clarification would be a fake gap. <br>The kinds share one `planClarification(kind, payload)` dispatcher (extend-don't-fork: a new kind is one branch); all are strictly additive — gated on `ctx.suspend` + a blocking gap, no parallel surface (they ride the existing enqueue path + the existing bridge). The per-`PendingAction`-kind arc is complete. | Phase 2 ✅ |

## § Follow-on (2026-06-18) — review and artifact catalog expansion

The AI chat A+ PRD (`docs/ai-chat-a-plus-prd.md`) adds a product requirement for
review and artifact workbench surfaces. This is **not** a new renderer, feature package,
or action channel. ADR 0051 remains the owner of agent-authored interactive chat UI; ADR
0068 and ADR 0069 define the review and artifact records the surfaces bind to.

Decision:

- Expand the pinned A2UI catalog with read-only components for provenance, risk,
  citations, artifact previews, diffs, revision timelines, and approval matrices.
- Keep action confinement exactly as this ADR decided: actions target interrupt resume
  or conversation exchange only. A publish, approve, reject, request-changes, or export
  button is a typed resume/exchange payload that the backend routes through ADR 0068 or
  ADR 0069 authority checks.
- Bind surfaces by stable IDs (`reviewId`, `artifactId`, `revisionId`), not by embedded
  artifact bodies or secret-bearing provider traces.
- Unknown components, unknown catalog versions, malformed payloads, and untrusted
  approval-advancing surfaces still fail closed.
- Historical surfaces carry their catalog version and render with the compatible
  renderer for replay; a catalog bump must keep old versions available or produce the
  existing safe fallback.

Acceptance criteria for this follow-on:

- Component/schema fixtures cover every new catalog component.
- Render tests cover keyboard flow, labels, disabled/stale states, and malformed payloads.
- Security tests prove no code execution, no network egress, no secret rendering, and no
  untrusted-content approval advancement.
- The catalog is advertised only for components the host can actually render.
- New standardized cross-host components go through an OpenWOP RFC before being claimed
  as normative catalog behavior.

## Open questions / decisions checklist

- [x] **Envelope kind name** → `ui.a2ui-surface` (new `ui.*` family; it is interactive UI,
      not a `media.*` asset).
- [x] **Catalog version** → pin **A2UI 0.9.1** (production), not the v1.0-candidate, day 1.
- [x] **Component subset day 1** → form primitives: heading/text, text/date/select/checkbox
      fields, action button. Advertise the supported list + version in discovery.
- [x] **Adopt A2UI v1.0 client-to-server RPC?** → **No.** Out of scope; a new host RPC
      channel needs its own RFC + security review. Actions map to resume/exchange only.
- [x] **Where action data lands** → `resumeValue` for an interrupt-bound surface;
      `exchange` content for a conversation-bound surface.
- [x] **Replace the hardcoded interrupt cards?** → **No.** Keep them as the default/fallback;
      A2UI is an opt-in richer renderer for the same interrupt kinds (no HITL fork).
- [x] **Catalog evolution policy** — how a host bumps catalog version without breaking
      historical surfaces in replay (carry the catalog version in the emitted envelope?).
      Surface envelopes carry `catalogVersion`; hosts keep compatible renderers or use
      the safe fallback for historical surfaces.
- [x] **A2UI ↔ `meta.rendering` overlap** — is `display: "a2ui"` redundant once the
      `ui.a2ui-surface` kind exists, or kept for non-typed prose fallbacks? *Resolve in
      RFC 0102 review.* Resolved by RFC 0102 final shape: the kind is sufficient and
      `display: "a2ui"` was dropped.

## References

- A2UI — https://a2ui.org/ (Apache-2.0, v0.9.1 / v1.0-candidate)
- RFC 0055 — Multimodal envelope variants & rendering hints (the precedent this extends)
- RFC 0102 — A2UI agent-authored interface surfaces (companion wire RFC, this ADR's gate)
- Seams: `frontend/react/src/chat/registry/{CardRegistry.ts,types.ts,defaultCards.tsx}`,
  `backend/typescript/src/host/chatSurface.ts`, `backend/typescript/src/bootstrap/hostSurfaceMap.ts`
- ADR 0027 (connected-content trust), ADR 0028/0036 (action governance), ADR 0001
  (feature-package), `ARCHITECTURE.md` § "Architecture contract for new work"
