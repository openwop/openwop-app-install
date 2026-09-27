# ADR 0308 — Tool-grounded commitments + agent deliverable tools (documents.draft / email.draft / notify-me)

Status: implemented (2026-07-07) — P0–P3 landed; P4 (async follow-through) deferred to its own ADR by design

> Numbering note: 0306/0307 are reserved by the app-builder editor-parity program
> (cited from ADR 0305 / ROADMAP; not yet authored), so this program takes 0308.

## Context — the fabrication incident

In a Board-of-Directors group chat (2026-07-06, model: Gemini Flash-Lite) the
assistant committed to: pulling an uptime/latency metrics report, drafting an
email to the platform team, placing both "in our shared document area," and
sending a link "to your inbox." **None of it happened, and none of it could
have**: no tool was called during the turn; nothing executes after a chat turn
ends (so "I'll have those ready shortly" is structurally unkeepable); and the
builtin agent-tool surface has no report, email, or notification tool —
`builtinAgentToolIds()` today is knowledge.search, ai.research.web,
core.openwop.http.fetch, code-exec, the RAG retrievers, and the projected
compute nodes (`host/agentToolProvider.ts:278`).

This is the known **agent-fabrication** failure mode, and it has two halves:
the agent *lied* (promised beyond its tools), and the promised capabilities
*don't exist*. This ADR fixes both, honesty first — an agent must only commit
to what it can do **with a tool, in this turn**, and the three capabilities the
incident promised become real, governed tools.

## Boundaries audit (what already exists — verified in source)

- **Builtin tool surface (single owner):** `host/agentToolProvider.ts` —
  `BuiltinTool { def: {name, description, inputSchema}, run(input, scope) }`,
  static `BUILTINS` map, `scope = {tenantId, runId?, agentProfileId?}`.
  Consumers: `host/conversationToolLoop.ts` (typed chat), `host/agentRunnerNode.ts`,
  `features/voice/realtime/toolBridge.ts` (ADR 0141/0142), `routes/agents.ts`.
  Gating everywhere is allowlist-default-deny ∩ builtins, then the Capability
  Firewall (ADR 0135). **Constraint:** this file is CORE — the ADR 0001 import
  boundary (core must not import features) forbids adding feature-owned tools
  here directly.
- **Documents:** `features/documents/documentsService.ts:261 createDocument`
  (+ artifactRoutes/render/surface). The report-→-document-→-notification shape
  already ships for strategy (ADR 0233 `strategy.board-pack`).
- **Email:** `features/email/emailService.ts` — campaign-shaped
  (`CampaignStatus = 'draft'|'sending'|'sent'`, brokeredProvider, engagement).
  The draft-for-approval discipline is established by the insights-suite
  Communication agent (ADR 0082: "always a draft for approval", never auto-send).
- **Notifications:** the emit seam is already core-accessible —
  `notifications/emitter.js` `getNotificationEmitter().emitMany(...)` (used by
  `host/channelActivityNotify.ts:66`, `host/escalationNotify.ts`). The
  `notifications` feature owns the inbox UI + preferences.
- **Context composition (single owner):** `host/chatContext.ts`
  `composeChatContext` (ADR 0278) — the ONE scaffold both typed chat
  (`conversationExchange`) and realtime voice (`composeRealtimeInstructions`)
  read. An addendum here reaches every agent turn, text and voice, once.
- **No collisions:** no existing `openwop:documents.*` / `openwop:email.*` /
  `openwop:notifications.*` builtin ids; no route changes at all (tools are not
  routes).

## Decision

Four decisions. Through-line: **an agent's words about actions must be backed
by tool calls in the same turn** — and the tools that make the common
commitments keepable are *draft-only, deep-linked, self-scoped deliverables*.

### D1 — The anti-fabrication addendum lives in the one scaffold (Phase 0)

`composeChatContext` folds a `TOOL_GROUNDED_COMMITMENTS` block into every
composed system prompt (text + voice inherit it from the one owner — no
per-surface copies):

- You may state you did something ONLY when a tool call in this turn did it.
- If you lack a tool for a request, say so plainly and offer what you CAN do.
- Never promise future or background work ("I'll have it ready shortly") — you
  run only within this turn.
- Never reference a surface you did not actually write to ("your inbox",
  "the shared document area") unless a tool result in this turn confirms it.

Verification floor: a unit test pinning the block's presence in composed
prompts (agent-scoped and unscoped), plus an eval scenario reproducing the
incident conversation asserting the reply either contains tool calls or an
honest capability statement. Model-tier note (advisory, not this ADR's
mechanism): group/board chats should default to a stronger tier via the
model-router — small models fabricate most.

### D2 — Feature-registered builtin tools (the seam), not core-owned tools

Core gains a tiny registry on the existing single owner:

```ts
// host/agentToolProvider.ts
export function registerFeatureAgentTool(tool: BuiltinTool): void
```

Feature packages register their tools from their `feature.ts` init (the same
dependency-inversion move as voice's `wireStreamAudioResolver`, ADR 0138
finding #1) — core never imports a feature; a disabled/absent feature simply
registers nothing. Registered tools flow through the SAME projection +
gating as today's builtins with **zero changes to the enforcement stack**:
agent `toolAllowlist` default-deny → Capability Firewall (ADR 0135) →
`executeTool`, in the chat loop, the agent runner, and the voice bridge alike.
`builtinToolNamespaces()` stays derived, so the ADR 0102 per-tool gate picks up
the new namespaces automatically.

**Toggle honesty:** each tool's `run` re-checks its owning feature's toggle for
the caller's tenant and returns a structured `feature_disabled` error when off
(registration is process-wide; toggles are per-tenant and dynamic — a
projection-time hide would go stale). The declaration may be visible to an
allowlisted agent of a toggle-off tenant; the execution is honest.

### D3 — The three deliverable tools (draft-only · deep-linked · self-scoped)

| Tool id | Owning feature (toggle) | Does | Never does |
|---|---|---|---|
| `openwop:documents.draft` | `documents` | `createDocument` from `{title, contentMarkdown, tags?}`; returns `{documentId, url, title}`; the chat renders the existing artifact/link card | publish/share beyond the feature's defaults |
| `openwop:email.draft` | `documents` *(see correction)* | create a **draft** `{to?, subject, bodyMarkdown}` as an `email-draft` kind Document (structured To/Subject header + body); returns `{documentId, title}`; the human reviews it in Documents and sends via their mail tooling or the `core.email.draft` workflow node | **send** — there is deliberately no send tool |
| `openwop:notifications.notify-me` | `notifications` *(no toggle — see correction)* | `getNotificationEmitter()` to the **requesting user only** `{title, body?, url?}`; `url` restricted to RELATIVE in-app paths (the inbox `Link`s it raw — an absolute URL would be an off-app phishing vector, P3 architect review); returns `{delivered: true}` | notify other users (v1 self-scope; broadening needs its own decision + RBAC); link off-app |

Shared properties: tenant + caller scoped (the tool scope carries tenantId; the
acting user is the turn's caller); results carry a deep-link so "check your
inbox" / "here's the report" are *verifiably true sentences*; every write is an
ordinary feature-service call (single owners: documentsService / emailService /
the notification emitter) — no parallel stores.

Data honesty for "reports": the tool writes what the agent composed from
sources it actually reached (knowledge.search, analytics reads, a saved
workflow invoked via the existing workflows-as-tools path). The tool does not
invent a metrics pipeline.

### D4 — Grants + firewall composition

- Tools enter per-agent `toolAllowlist`s explicitly (default-deny stands).
  Initial grants: the workspace assistant + board moderator personas.
  **Grant mechanism (found in audit, answers OQ-2): the ADR 0104 super-admin
  per-tenant+agent allowlist OVERRIDE** (`resolveAgentToolAllowlistOverride`,
  applied in `conversationToolLoop.ts` exactly as `runAgentDispatchLive`) — an
  operator action, no pack re-publish needed; pack-manifest allowlists remain
  the durable default.
- Capability-firewall composition rules (ADR 0135) apply on the canonical ids;
  the safe-by-construction property is that `email.draft` composes safely with
  read tools *because* send does not exist as a tool.
- Voice sessions inherit everything through the ADR 0142 boundary untouched.

## RFC verdict

**Host-extension only — no RFC.** No wire surface changes: tools are host
builtins behind the existing agent-loop machinery; no new run-event, capability
flag, or endpoint contract. Nothing is advertised on `/.well-known/openwop`.

## Evaluation matrix (per the /feature-refinement contract)

1. **Feature-package:** no new package — extends `documents`, `email`,
   `notifications` (each keeps its single service owner) + the core seam (D2).
2. **Toggle:** no new toggle; each tool rides its owning feature's existing
   toggle (D2 honesty rule). The Phase 0 addendum is core scaffold hygiene —
   always-on, like SPOKEN_MODE_ADDENDUM.
3. **`ctx.<feature>` surface:** unchanged (documents/email/notifications keep
   their existing surfaces; these are agent-loop tools, not workflow nodes).
4. **Node pack:** none new — deliberate. The workflow-engine paths already
   reach these features via their packs; this ADR covers the *chat agent loop*.
5. **Envelopes:** none — tools, not envelope types.
6. **Agent pack:** no new agents; existing personas gain allowlist grants (D4).
7. **Public surface:** none.
8. **RBAC/isolation:** tenant-scoped via tool scope; notify-me self-only;
   drafts owned by the acting user per each feature's existing ownership rules;
   fail-closed on toggle-off (`feature_disabled`).
9. **Replay/fork:** tools execute inside turns like existing builtins; no
   variant stamping needed.
10. **Frontend:** no new pages. The chat's existing artifact/link card renders
    tool results; the notifications inbox + email/documents pages are the
    approval surfaces. (Optional polish: a distinct "draft created" card.)

## Phased plan

| Phase | Scope | Verify |
|---|---|---|
| **P0** | `TOOL_GROUNDED_COMMITMENTS` in `composeChatContext` + unit test + incident eval scenario | backend vitest |
| **P1** | D2 registry seam + `openwop:documents.draft` (register in `features/documents/feature.ts`) + toggle-honesty + tests + assistant/moderator grants | backend vitest; live: ask the assistant for a report → real document link |
| **P2** | `openwop:email.draft` (draft entity decision — see OQ-1) + approval surface wiring | backend vitest + live draft→approve→send |
| **P3** | `openwop:notifications.notify-me` (self-scope) + inbox deep-link | backend vitest + live inbox check |
| **P4** | — deferred to a future ADR: real async follow-through (scheduler job via the roster agents-propose pattern, run output landing back in the conversation). Until then P0's rule forbids promising future work. |

Phase record (updated as work lands):

| Phase | Landed |
|---|---|
| P0 | `TOOL_GROUNDED_COMMITMENTS` folded into `composeChatContext` (both scaffolds; voice inherits via the one owner) + tests (`documents-agent-tool.test.ts` P0 block; the voice bare-scaffold pin updated) |
| P1 | `registerFeatureAgentTool` seam (agentToolProvider) + `actingUserId` threaded onto the chat tool scope (conversationToolLoop, ADR 0024 §4 stamp) + `openwop:documents.draft` (features/documents/agentTools.ts; toggle-honest, acting-user-required, org-RBAC via `resolveEffectiveAccess`, agent provenance, idempotent version) + 6 tests. **Residue:** DocumentsPage has no `?doc=` deep-link param — the tool returns `/documents` + the exact title (small FE follow-up). **Correction (ADR 0324, 2026-07-09):** the P0 scaffold reached voice via `composeChatContext`, but this `actingUserId` threading reached the CHAT loop only — the realtime voice bridge kept a bare scope, so every deliverable tool failed closed (`acting_user_required`) in live voice while the scaffold promised it could deliver. Fixed by the shared scope composer + host-bound session caller (ADR 0324). |
| P2 | `openwop:email.draft` as an `email-draft` Document over the shared deliverable core (OQ-1 decided by architect review; header-field newline hardening from code review) — 5 tests |
| P3 | `openwop:notifications.notify-me` (self-scope; relative-in-app-URL phishing floor from architect review; `agent.deliverable` type renders via the inbox's generic fallback — verified, no FE change) + the `?org=&doc=` DocumentsPage deep-link closing the P1 residue (inaccessible-org dead-end fixed per UX review, i18n ×4) — 5 tests |

## Alternatives weighed

- **Hard-code the tools in core `BUILTINS`** — rejected: violates the ADR 0001
  import boundary (core→feature) and makes toggle honesty awkward.
- **Expose the features via workflows-as-tools only** (no builtins) — rejected
  as the *primary* path: it makes the common deliverables depend on per-tenant
  saved workflows existing; builtins with allowlist grants are deterministic.
  (Workflows-as-tools remains the data-pull escape hatch.)
- **A "send email" tool with an approval interrupt** — rejected for v1:
  draft-never-send is a simpler invariant than gated-send, matches the
  ADR 0082 Communication-agent rule, and keeps the firewall composition safe by
  construction.
- **Prompt-only fix (Phase 0 alone)** — rejected: honesty without capability
  turns every request into "I can't"; the product intent is that the common
  commitments become keepable.

## Open questions

- **OQ-1 (email draft entity) — DECIDED (b), architect review 2026-07-07:**
  the email feature has NO one-off message entity (templates → campaigns →
  send-logs only), and vendor-side drafting already has an owner (the
  `core.email.draft` workflow node, ADR 0076/0081 — deliberately excluded from
  chat-tool projection). Option (a) would stand up a second prepared-message
  store + a net-new one-off send path. So `openwop:email.draft` writes an
  `email-draft` kind **Document** (structured To/Subject header + markdown
  body; `asKind` is a free kebab tag — no schema change) as a DISTINCT tool id
  (own allowlist/firewall identity). **Correction:** its owning toggle is
  `documents` (where the write lands), not `email`; the email feature enters
  only at a future send-handoff. Falsifier recorded: revisit ownership if a
  one-off host-side send path ever ships in the email feature.
- **Correction (P3 architect review, 2026-07-07):** the notifications feature
  carries NO toggle (core platform infrastructure since 2026-06-11; the emit
  path was never gated) — the D2 per-tool toggle-check rule is N/A for
  `notify-me`. Its fail-closed floor is the acting-user requirement + the
  relative-URL restriction instead.
- **OQ-2 (grant surface):** should allowlist grants be editable per-agent in
  the console (agentProfile UI) rather than only in agent manifests? Deferred —
  follows the existing allowlist ownership either way.
- **OQ-3 (eval harness):** the incident eval as a scripted-provider scenario in
  the `evals` feature vs a vitest-only assertion. Floor is vitest; the evals
  entry is stretch.
