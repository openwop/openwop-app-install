# workflow-engine — Architecture

> Companion to [`README.md`](./README.md). This file documents the *shape* of the app — what each layer is for, what stays neutral, and the boundary discipline that keeps the app from drifting into a private fork.

## Architecture contract for new work

This application is an OpenWOP host plus a feature-package platform. New
features must extend that architecture; they must not create parallel systems
for concepts the app already owns.

Use this as the first review checklist for every new feature, agent, workflow,
schedule, integration, public route, or admin surface:

- **Follow the OpenWOP wire.** Runs, events, interrupts, workflow definitions,
  schedules, agents, BYOK credentials, host capabilities, replay, fork, and
  provider calls must use the existing OpenWOP protocol shapes and host
  extension patterns. Do not invent a second run model, event stream,
  scheduling model, agent registry, workflow registry, credential path, or
  capability document inside a feature.
- **Do not fork the protocol in this app.** If a change needs a new run-event
  field, capability flag, endpoint contract, auth profile, error semantic, agent
  wire shape, workflow-definition shape, schedule wire shape, or normative
  `MUST`, that belongs in the upstream OpenWOP RFC/spec process before or with
  the host implementation. Host-local product APIs live under
  `/v1/host/openwop-app/*` and remain non-normative.
- **Never hard-code a workflow.** A workflow ships as a **chain** (nodes + edges,
  an RFC 0013 workflow-chain pack, built-loader-loaded → builder-editable +
  `/`-runnable) or as a **stack** (todos on a kanban board, ADR 0311; a chain can
  be stacked as a card). Do not register an in-tree `builtinWorkflows` module (the
  deprecated ADR 0072 pattern) — it is invisible to the builder + `/` and not
  editable. See "Agents, workflows, and schedules" below.
- **Use the feature-package seam.** Product features live under
  `backend/typescript/src/features/<id>/` and
  `frontend/react/src/features/<id>/`, then append to the backend and frontend
  feature registries. A feature owns its service, routes, UI, tests, optional
  packs, optional `ctx.features.<id>` workflow surface, and ADR.
- **Let the backend be the authority.** Feature toggles, variants, RBAC,
  connection resolution, consent decisions, BYOK secret resolution, and
  capability support are server-side decisions. The frontend can render the
  backend's resolved view, but it cannot be the source of truth.
- **Prefer the existing owner for every concept.** Organizations, members,
  roles, scopes, and workspaces are owned by `accessControl` / workspace
  tenancy. Users and canonical subjects are owned by the identity/session
  layer. Credentials are owned by BYOK and Connections. Agents are owned by the
  agent registries, roster, and pack loaders; an agent's *capabilities*
  (e.g. the assistant operating-rhythm) live at the **core agent level** and are
  **activated per named agent via its `agentProfile`**, never hard-coded to a
  `roleKey` (ADR 0023 §Correction / ADR 0031). Workflows are owned by the
  workflow catalog and executor. Schedules are owned by the scheduler service
  and daemon. Notifications, approvals, comments, CMS, media, publishing,
  governance, and trigger delivery each already have an owner. Extend those
  owners instead of rebuilding them in a feature directory.
- **Advertise only honored behavior.** `/.well-known/openwop`, the node catalog,
  host-surface flags, auth profiles, and feature workflow surfaces must reflect
  behavior the host actually enforces. A disabled or unwired behavior should
  fail closed or advertise `supported: false`, not silently pretend to exist.
- **Keep replay and fork deterministic.** If a feature changes run behavior,
  stamp the resolved choice into run metadata at creation and read it back
  verbatim on replay/fork. Do not recompute feature variants, provider choices,
  agent bindings, or prompt bindings for historical runs.
- **Use pinned packs and existing loaders.** New executable node/agent behavior
  should ship as OpenWOP packs through the signed registry/dev-mount pipeline.
  Feature toggles gate activation, not pack presence, so historical runs can
  still resolve their node and agent types.
- **Use the shared storage and host-surface seams.** Durable state goes through
  the `Storage` interface, `DurableCollection`, or an established feature
  service. Host capabilities go through the host-surface registry/adapters. Do
  not add private one-off databases, queues, vector stores, credential stores,
  search adapters, or background dispatch loops unless the architecture first
  records why the existing seam cannot carry the requirement.
- **Ground every model exchange.** Any schema/catalog/enum text that reaches a
  model must be either generated at call time from its single source of truth
  or test-pinned to it (a parity tripwire); every AI-authoring path needs a
  declared output contract, a typed failure (never success-with-empty), and —
  where the model can act on errors — one bounded error-fed repair. Pick the
  right lane (see "AI information-exchange architecture" below): provider-native
  tools for chat turns, RFC 0021 envelopes for in-run structured intents, MCP
  for external integrations. Tracked in `docs/steward/LLM-EXCHANGE-AUDIT.md` at the repo
  root — a new model-facing surface should land with its row and tripwire.
- **Record non-trivial decisions.** New architecture, cross-cutting seams,
  auth/RBAC/BYOK/replay behavior, public unauthenticated surfaces, workflow
  surfaces, connector behavior, and anything touching the wire need an ADR under
  `docs/adr/`. Protocol changes additionally need an OpenWOP RFC.

The practical rule: a new feature should make the existing system more capable,
not create a smaller second copy of the system beside it.

## Layers

```
┌────────────────────────────────────────────────────────────────────┐
│  frontend/react/                                                   │
│  React UI — consumes @openwop/openwop SDK, renders interrupts,    │
│  streams events, displays capabilities, handles BYOK input        │
├────────────────────────────────────────────────────────────────────┤
│              ↑ HTTPS + SSE + Bearer auth (wire only)              │
├────────────────────────────────────────────────────────────────────┤
│  backend/typescript/                                               │
│  Express server                                                   │
│    ├── routes/         REST + SSE wire surface                    │
│    ├── middleware/     auth, traceContext, errorEnvelope          │
│    ├── bootstrap/      one-shot boot installers                   │
│    ├── executor/       node-module dispatch loop                  │
│    ├── host/           HostAdapterSuite — 15 neutral adapters     │
│    ├── byok/           secret resolver + ephemeral run secrets    │
│    ├── packs/          tarball loader + SRI/Ed25519 verify        │
│    ├── observability/  OTel tracer + cost emitter                 │
│    └── storage/        sqlite (default) | memory (tests)          │
└────────────────────────────────────────────────────────────────────┘
                          ↓ depends on (npm)
                @openwop/openwop          (wire types + SDK)
                @openwop/openwop-conformance  (test harness)
```

**Dependency direction is strict and downward.** The frontend never imports backend internals. The backend never imports frontend code. Both layers consume `@openwop/openwop` for wire types — same package, different surface.

## Existing extension seams

New work should normally enter through one of these seams:

| Need | Existing seam |
|---|---|
| Product feature with routes/UI/data | `backend/typescript/src/features/<id>/` + `frontend/react/src/features/<id>/` |
| Backend feature composition | `BACKEND_FEATURES` in `backend/typescript/src/features/index.ts` |
| Frontend feature composition | `FRONTEND_FEATURES` in `frontend/react/src/features/registry.ts` |
| Core route module | `ROUTE_MODULES` in `backend/typescript/src/routes/registerAllRoutes.ts` |
| Frontend route/nav/admin rail/command palette | `FEATURES` in `frontend/react/src/chrome/features.tsx` |
| Feature toggle / beta / variant | `backend/typescript/src/host/featureToggles/` |
| Workflow-visible feature API | `ctx.features.<id>` via `backend/typescript/src/host/featureSurfaces.ts` |
| Workflow execution | `backend/typescript/src/executor/` and `workflowCatalog` |
| Agent templates and installed pack agents | `AgentRegistry`, pack `agents[]`, and agent routes |
| Money obligation to a third party (shares, commissions, bounties) | `host/obligationLedger.ts` — accrual/reversal rows + evidence-gated payout runs (ADR 0447); adapters convert to integer minor units; the host never moves money |
| Capability token (bearer secret or public link) | LINK-shaped ⇒ a `sharing` resolver (ADR 0013); BEARER-shaped ⇒ a feature store on `host/capabilityToken.ts` (hash at rest, tenant in content, uniform 404). Hand-rolled `createHash` token stores trip `test/capability-token-tripwire.test.ts` (ADR 0448) |
| Standing agent instances / named coworkers | `rosterService`, agent workspace routes, heartbeat daemon |
| Agent config + capability activation | `agentProfile` host-ext (`/v1/host/openwop-app/agents/:id/profile`) + `AgentProfile.capabilities` (ADR 0031) |
| New third-party provider | RFC 0095 connection pack under `examples/connection-packs/<id>/pack.json` (ADR 0033) — no code |
| Schedules / recurring work | scheduler routes, `schedulingService`, `scheduleDaemon` |
| Human approvals | approval service/routes and interrupt/approval-gate primitives |
| Credentials and third-party app auth | BYOK secret resolver + Connections broker |
| Durable feature data | `Storage`, `DurableCollection`, or the owning feature service |
| Subject-bearing durable data (any store recording a data-subject identifier) | `registerSubjectEraser` at the owning host/feature module (ADR 0077/0381) — delete or anonymize, the owner's choice — OR the documented exemption allowlist with a lawful-retention/technical justification (there is no third state, ADR 0464 §2.1). Host stores are enumerated + enforced by `test/subject-erasure-coverage.test.ts`: a new subject-bearing `DurableCollection` in `src/host/**` fails the build until it is covered or exempted |
| React when ANOTHER feature's record is deleted / credential revoked (clean up or disable your soft references) | the keyed-registry lifecycle seams — `commerce/productLifecycleSeam.ts` (`onProductDeleted`, #1337), `host/crmRecordLifecycle.ts` (`onCrmRecordDeleted`, ADR 0283), `host/connectionLifecycle.ts` (`onConnectionRevoked`, ADR 0285), `host/rosterLifecycle.ts` (`onRosterMemberDeleted`, ADR 0288), `host/conversationLifecycle.ts` (`onConversationDeleted`, ADR 0288), `host/mediaAssetLifecycle.ts` (`onMediaAssetDeleted`, DATB-1). Same contract: keyed registration (repeat boots overwrite), idempotent bounded handlers, best-effort fan-out fired AFTER the owning row is gone. Disposition taxonomy (ADR 0288): PRUNE dead refs/live membership, DISABLE (never delete) authored configs, TOLERATE ON READ historical provenance |
| Org-scoping a Subject's work surface (board visibility) | `host/subjectOrgScope.ts` (`setSubjectOrgResolver` / `resolveSubjectOrg`) — the owning feature derives the org from the `ownerSubject` (ADR 0046) |
| Member/visibility-scoping a Subject's surfaces (resolve a caller's read/write level) | `host/subjectAccess.ts` (`setSubjectAccessResolver` / `resolveSubjectAccess` → `'none'\|'read'\|'write'`) — the owning feature composes org authority with the subject's visibility + members; WRITE stays org-scoped, READ gains a membership dimension (ADR 0054 D5). Orthogonal to `subjectOrgScope` (org-derivation). |
| Resolve a cross-cutting decision **once per run** and replay it verbatim (e.g. tool-output-compaction mode) | _implemented, ADR 0099_ — `host/runStartContext.ts` (`registerRunStartContributor`), applied by the ONE run-insert seam `host/runInsert.ts` `insertRunWithStartContext(...)`: a contributor resolves once at creation and freezes into `run.metadata`, read verbatim on `:fork`. *(CORRECTED 2026-08-23, feature-30 closeout — `TOCC-12` (iii), the one leg of that finding ADR 0604 did NOT sweep. This row said the contributors are "applied where runs are created (`runDispatch.ts`/`runStarter.ts`)" and **`runDispatch.ts` contains ZERO `insertRun` / `stampRunStartContext` calls** — it owns `buildRunRecord` + `RESERVED_RUN_METADATA_KEYS`, not the insert. `runStarter.ts:123` is one of ~20 callers of the real seam, not a co-owner. Re-derived at closeout: `Storage` declares exactly ONE run-row writer (`storage.ts:138 insertRun`), 20 files call it, and **four bypass this seam deliberately** — `host/workforceEval.ts`, `host/anonymousActor.ts`, `routes/anonSurfaceSeam.ts`, `routes/testSeam.ts` — so a run created on those lanes carries no frozen decision at all (tracker `TOCC-11`, open). ADR 0604 §4 records this citation family as corrected; it corrected two of the three legs.)* **Two writers COPY another run's metadata** (`routes/runs.ts` `:fork`, `routes/workflowDebug.ts` redrive) and both MUST pass `derivedFromRun: true` so a contributor treats the copied blob as authoritative in BOTH directions — present AND absent (ADR 0604 §D1; ratchet `test/run-metadata-copy-sites.test.ts`). Generalizes the `trustBoundary` read-side precedent to a write-side resolver, for features that own no run-creation route. |
| Transform tool output at the typed tool-result boundary (e.g. compaction) without editing core | _implemented, ADR 0099_ — `host/toolResultTransform.ts` (`registerToolResultTransform`), applied by the tool-result **builder** — the `agentDispatch` host-driven loop (`agentDispatch.ts:1252`) and the workflow tool-loop node's `onToolUse` return (`bootstrap/nodes.ts:2024`), where a string is first known to be tool output and about to enter the model context. *(Both citations CORRECTED 2026-08-23, ADR 0604/TOCC-12: `agentDispatch.ts:832` was a BLANK line at the assessed ref — the nearest compaction text was a comment at `:833` and the real call site `:1252`. Citation rot has now been the finding on three consecutive features; a `file:line` in this table is a claim, and stale ones send readers to unrelated code with full confidence.)* The provider dispatchers (`dispatchAnthropicWithTools`/`dispatchMiniMaxWithTools`) **relay** the builder's already-compacted `content` verbatim into the wire `tool_result` — they do **not** transform it (that would double-compact). Covers pack-nodes + manifest dispatch + — since ADR 0604 — the interactive `/` chat, with no `'tool'` message role needed. *(CORRECTED 2026-08-23, TOCC-1: "Covers chat" was FALSE for the whole life of the feature. `conversationToolLoop.ts` passed fifteen keys into `runChatToolLoop` and `compaction` was not one of them, so the transform short-circuited on every chat turn. The claim was made here, in `FEATURES.md` and in ADR 0099, which had conflated the `bootstrap/nodes.ts` heartbeat node — whose tool names are regex-validated to exclude `:` and `.`, so no `openwop:*` id can reach it — with the `/` chat. The lane is now wired and ratcheted by `test/tool-result-compaction-callers.test.ts`.)* (the AI-adapter message array is type-blind: `AiCallMessage.role` = `user\|assistant\|system`). Relay pinned by `tool-output-compaction-relay.test.ts`. |
| Work that OUTLIVES the thing that started it (a fire-and-forget refresh, a module-scope in-flight promise latch, a React effect's async continuation) | There is no single owner, and that is the point of this row: pick the form that matches the runtime. **Backend** — a module-scope `let x: Promise<T> \| null` latch MUST be able to recover from a stuck attempt: clear it on settle (`.catch`/`.finally` → `x = null`) AND, if the work is ever fire-and-forget, add a TIME BOUND. Cloud Run sets `cpu-throttling=true`, so once a response is flushed the instance is throttled (DEPLOY.md quantifies it as ~5% CPU) and a detached continuation may not resume for a long time — MEASURED at 16+ minutes in #3056, with active traffic throughout, i.e. effectively never for any purpose that matters. A promise that has not settled has not rejected either, so clear-on-settle alone does not cover it. That combination is the #3056 outage (`/` served a pruned bundle 16+ min; ten requests served, ZERO fetch failures logged). Prefer finishing the work IN-REQUEST (`await` it, bounded) — that is the only place CPU is guaranteed. Enforced by `test/detached-latch-tripwire.test.ts`. **Frontend** — a `.then` that calls setState must be guarded by a mounted ref RE-ARMED INSIDE the effect, never cleanup-only (StrictMode mounts → cleans up → remounts, so a cleanup-only ref is already false when the component is live — the ADR 0517 Phase E trap). Reference: `memory/MemoryBrowser.tsx`. NOTE this is a TEST-INTEGRITY concern, not a production one: React 18 makes a late setState a no-op, but jsdom teardown turns it into an unhandled rejection that fails the whole suite while every test reports green (`src/test/unhandled-rejection-attribution.ts` names the test) |
| Perform an EXTERNAL EFFECT from inside a run (outbound network, a user-visible notification, an email) | call `assertEffectAllowed(kind)` from the seam that performs it (`host/runEffectContext.ts`, ADR 0531) — the executor establishes a run-scoped `AsyncLocalStorage` context around every node execution, and the guard fails a replay CLOSED (`replay_source_missing`) so a fork cannot fire the effect a second time. This is the BACKSTOP; the ADR 0341 typeId classifier (`executor/sideEffects.ts`) is the fast path that serves the recorded outcome instead — a backstop firing means a node is MISSING from that classifier. A new effect seam adds a member to `EffectKind` **and** a behavioral test in `test/run-effect-context.test.ts`. Effects already idempotent by deterministic key (e.g. `obligationLedger.accrue`) are deliberately NOT guarded — keying is stronger than fail-closed |
| Host capabilities for pack nodes | host-surface registry and selected surface adapters |
| Decide whether a pack's CODE may execute at all (node packs, agent packs) | `host/packTrust.ts` (ADR 0555 P0) is the SOLE authority — `classifyPackDir()` returns a `PackTrustTier` (`steward` / `operator-trusted` / `untrusted` / `revoked`) plus the `dispatchable` decision, and `packs/tarballLoader.ts` + `packs/agentLoader.ts` CALL it rather than deriving a tier themselves. `steward` is attested by the committed `packs/.steward-manifest.json` (`scripts/gen-steward-manifest.mjs --check` gates it in `scripts/ci.sh`), NEVER by "the pack was in the packs dir" — two env vars steer the dev mount, so a mount-derived tier would let configuration redefine the trusted corpus. Revocation has TWO sources (`host/packRevocations.ts` durable rows + the ADR 0367 pinned keyring's `OPENWOP_TRUSTED_PACK_REVOCATIONS`) and `packTrust` is the only reader of either. The gate refuses the dynamic **import**, not just `execute` — `await import(url)` runs a module's top level, so "load but don't dispatch" is not a boundary for ES modules. Policy is default-ON with no deployment posture; `OPENWOP_PACK_TRUST_ALLOW_UNSIGNED` relaxes dispatch WITHOUT reclassifying and can never un-revoke. Test fixtures attest via `test/setup/attestPackFixture.ts`, never by disabling the policy |
| Run a pack's code OUT of the host's trust domain (isolation) | `host/packIsolationPolicy.ts` decides PLACEMENT (`OPENWOP_PACK_ISOLATION` = `untrusted` default / `off` / `all` / `fake`) and `host/packIsolationDispatch.ts` selects the ADAPTER (`OPENWOP_PACK_ISOLATION_ADAPTER` = `child` default / `fake`). ONE seam: `IsolationAdapter` (`host/isolationAdapter.ts`) — a new adapter implements `{id, guarantees, dispatch}` and inherits every guard, because capability, authority, replay and trust live HOST-side on the dispatch record (`packDispatchRegistry.ts`) and every effect returns through `packHostCallBroker.ts`, which is the only place `runWithEffectContext` + `runWithAuthority` are re-established across the process boundary (ADR 0531 / ADR 0556 P3 — AsyncLocalStorage does NOT cross it). An adapter declares `guarantees` as an EXHAUSTIVE `Record<IsolationGuarantee,'enforced'|'not-enforced'>` (`host/isolationGuarantees.ts`); a tier requiring more than the adapter enforces is REFUSED (`pack_isolation_guarantee_unmet`), never downgraded and never run in-process. `network-denied` is `not-enforced` by every adapter on this platform and the escape suite asserts egress still works — do NOT flip it without containing egress in the same commit. Do not add a second sandbox concept: the ADR 0114/0146 `sandboxAdapter.ts` family is a DIFFERENT contract (a source STRING evaluated remotely), not this one (ADR 0555 P1/P2) |
| Give a chat agent a READ/catalog tool (app state or schemas at turn time) | `registerFeatureAgentTool` (`host/agentToolProvider.ts`, ADR 0308) from the feature's `agentTools.ts` — read-only tools MUST reuse the HTTP route's access predicate via a SHARED helper (e.g. `buildOwnedTaskDeck`, `searchVisibleConversations`) so route and tool cannot drift, and fail EMPTY without `scope.actingUserId`. New tools are allowlisted per agent pack, NOT added to the ADR 0315 default-on baseline (that is its own ADR-level decision) |
| Feed a pack node's prompt a live catalog instead of a hand-copy | a feature-surface `getCatalog` op (the ADR 0358 pattern: `features/app-builder/surface.ts`, `features/slides/surface.ts`) read via `ctx.features.<id>` with a test-pinned literal fallback for foreign hosts; per-canvas component menus come from `host/canvasComponentCatalog.ts` (`catalogPromptSchema`) |
| Closed-world validation a pack node can call (and repair against) | a feature-surface `validate` op wrapping the feature's ONE validator (`validateAppDoc`, `validateSlidesDoc`, `wa.validateDraft`) — the node feeds the errors back for one bounded repair before failing typed |
| Let ANY agent ask "what schemas exist?" at turn time | `openwop:schema.lookup` builtin (`host/agentToolProvider.ts`) — node typeIds, canvas component catalogs, artifact types; its output is compaction-exempt (`SCHEMA_READ_EXEMPT_TOOLS`, `host/toolResultTransform.ts`) |
| In-run structured intent from the model (RFC 0021) | the envelope acceptor (`host/envelopeAcceptor.ts`) + the live `schema.request` loop in `host/agentDispatch.ts` `runChatToolLoop` (payload `{ envelopeType }`, answered out-of-band, capped at the advertised `schemaRounds`); a new envelope KIND is wire → OpenWOP RFC first |
| Pin a prompt's hand-carried vocabulary to its SSoT | a `promptCatalogParity.test.ts` in the owning feature's `__tests__/` (readFileSync the pack prompt; the `catalogParity.test.ts` precedent — inverted tripwires for tool-first prompts), plus the repo-wide phantom-tool-id lint `test/agent-prompt-tool-ids.test.ts` |
| Public content | CMS, Media, Publishing, Sharing, Forms, Consent, and Analytics public-route patterns |
| Governance / policy / audit | governance service and `storage.listAudit` |

If a proposed feature does not fit any seam, treat that as an architectural
decision to document before implementing, not as permission to add a parallel
path.

## Agents, workflows, and schedules

Agents, workflows, and schedules are first-class OpenWOP/application concepts,
not feature-local inventions.

- **Agents** must come from the existing agent surfaces: pack-declared manifest
  agents, user-authored agents in the persisted agent registry, or standing
  roster members. A feature may add agent templates or bind variants to agents,
  but it should not add a private agent table, private dispatcher, or private
  tool loop.
- **Agent capabilities are CORE, not named.** A capability (the assistant
  operating-rhythm graph + perception/action loops, etc.) belongs at the
  core-agent level and is activated per agent through `agentProfile.capabilities`
  — NEVER special-cased to a named agent or `roleKey`. Iris (Chief of Staff) and
  the Executive Operations twin are both just agents with the `assistant`
  capability activated; there is no "Iris's graph," only the tenant work-graph any
  capability-activated agent operates on (ADR 0023 §Correction, ADR 0031).
- **Workflows are NEVER hard-coded.** A workflow is one of exactly two shapes,
  both executed by the ONE shared executor:
  - a **chain** — a graph of **nodes and edges**, authored and shipped as an
    RFC 0013 / ADR 0163 **workflow-chain pack** (`kind:"workflow-chain"`) and
    loaded through the built chain loader (`host/workflowChainPackLoader.ts`). A
    chain surfaces in the builder's template gallery + the `/` picker, and
    instantiates into a tenant-owned, **builder-editable** workflow via
    `POST …/workflows/from-chain` (`expandChain` → `registerWorkflow` →
    `recordOwnership`). Its nodes come from node packs, so it is inspectable and
    editable end-to-end. **A chain can hold a sub-chain — workflows can hold
    workflows** (composition/nesting is first-class): a chain node may reference
    another chain, co-expanded and co-registered on instantiation. (Today's pack
    format does not yet express nesting or a run-produced variable bag; those are
    additive RFC 0013 extensions — see below — NOT reasons to hard-code.)
  - a **stack** — an ordered set of **todos on a kanban board** (the ADR 0311
    work-intake pattern). A **chain can be *stacked*** — enqueued as a card in a
    kanban stack — so a stack sequences/orchestrates chains as units of work.

  Do **NOT** register an in-tree `builtinWorkflows` module (the **deprecated**
  ADR 0072 pattern): a code-pinned `WorkflowDefinition` is invisible to the
  builder + `/`, is not user-editable, and shadows the chain loader — it violates
  this rule. A feature may provide **node packs**, **chain packs**, a feature
  workflow surface, or authoring UI — never a hard-coded definition, a separate
  workflow engine, or an alternate run lifecycle. (The in-tree-builtins migration
  to chains/stacks is **DONE** — the `BackendFeature.builtinWorkflows` field is gone
  (declaring one is a TypeScript error), `host/builtinWorkflows.ts` is deleted, and
  the `LEGACY_PINNED_WORKFLOWS` quarantine is drained to EMPTY / ratchet-frozen (ADR
  0472 P4); the history is tracked in `docs/steward/builtin-workflow-migration-audit.md`.
  The `*BuiltinWorkflows` arrays still in `src/features/**` are the chain-backed SSoT
  sources P4 registers, NOT the retired seam.) Two capabilities the pack format
  does not yet express — **sub-chain nesting** (a chain node holding another
  chain) and a **run-produced variable bag** (a node writing a value a later node
  reads by name) — are **additive RFC 0013 extensions**, not fundamental limits:
  nesting rides the manifest's existing `chains[]` (co-expand + co-register the
  child, rewrite the parent's reference to the minted id), and produced values map
  to explicit output→input **edges** (chain-native) or a pass-through `variables[]`.
  Both realize already-stated model capabilities in the format; reverting to a
  hard-coded definition is not an option.)
- **Schedules** must use the scheduler service and daemon. A feature may create
  scheduled jobs, expose scheduling UI, or provide scheduled workflow templates,
  but it should not poll its own private cron loop for work that the scheduler
  already models.
- **Run side effects** must flow through the existing run/event/interrupt/
  approval/idempotency machinery. Feature-specific actions should compose those
  primitives rather than bypassing them.

This keeps agent activity, workflow history, approvals, replay/fork, audit,
notifications, governance, and capability discovery aligned across the app.

## AI information-exchange architecture (the three lanes)

The app's value proposition is that a model can build and automate the app
itself, so every model↔app conversation is architecture, not prompt trivia.
There are exactly THREE channels, each with one owner — do not invent a fourth
or use one lane for another's job (audited + tracked in `docs/steward/LLM-EXCHANGE-AUDIT.md`
at the repo root; re-runs of `/grade-ai-exchange` update that file):

1. **Chat-time tools (provider-native function calling)** — how an agent asks
   the app questions and takes gated actions during a conversation turn.
   Compiled per turn by `host/conversationToolLoop.ts` from
   `effectiveToolAllowlist` (manifest ∪ the ADR 0315 default-on baseline, or an
   ADR 0104 full-replace override); definitions come from `agentToolProvider.ts`
   builtins + `registerFeatureAgentTool` registrations. Voice gets the SAME set
   by construction (`voice/realtime/toolBridge.ts`, set-parity-pinned).
   Schema/catalog asks ride `openwop:schema.lookup` or a feature catalog tool
   (`openwop:app-builder.catalog`, `openwop:slides.catalog`); app-state asks
   ride read tools that share their HTTP route's access predicate. Tool-first
   prompts keep NO hand-copied catalog (inverted tripwires pin the absence).

2. **RFC 0021 AI Envelopes (in-run structured intent)** — typed JSON the model
   emits in completion text (`{type, envelopeId, correlationId, payload, meta}`),
   validated by `host/envelopeAcceptor.ts` against per-kind schemas
   (`schemas/envelopes/*.schema.json`), round-capped, trust-attributed
   (`meta.source` routes LLM-emitted mutations through approval gates),
   correlation-deduped (replay/fork reads recorded outcomes verbatim), and
   BYOK-canary-redacted. The managed chat loop answers `schema.request`
   ({ envelopeType } — an ENVELOPE KIND's schema, injected out-of-band;
   `schema.response` is the MODEL's ack, never the host's delivery vehicle).
   This lane is normative OpenWOP wire: `/.well-known/openwop` advertises
   `supportedEnvelopes` + `schemaVersions` + `limits`, so a new kind or field
   is an OpenWOP RFC before host work.

3. **MCP (external integrations)** — transport to/from OTHER processes: the
   outbound client (`host/mcpClient.ts`, RFC 0020, approval-ledger +
   egress-firewall gated), the MCP server router exposing workflows as tools,
   and `core.openwop.mcp.handle-sampling` (inbound content is third-party —
   fenced `<UNTRUSTED>` unconditionally). MCP is never the in-run intent
   channel: it has no replay/dedup/round-cap/trust-attribution story.

Cross-lane invariants (enforced by tests — treat a red one as a lie to a model,
not a flaky test):

- **SSoT or pinned.** Schema text reaching a model is generated at call time
  from its single source of truth (`getCatalog` surface ops,
  `catalogPromptSchema`, `buildAuthoringCatalog`) or test-pinned to it
  (`promptCatalogParity.test.ts` per feature; `agent-prompt-tool-ids.test.ts`
  repo-wide — every `openwop:`-prefixed id in any agent pack must resolve).
- **Typed failure + bounded repair.** An unparseable/invalid model reply is a
  typed failure (`AI_OUTPUT_UNPARSEABLE` / `app_doc_invalid` / …), never
  success-with-empty or a fabricated placeholder; authoring paths feed the
  validator's errors back for ONE bounded repair before failing (the
  workflow-author `draft` loop and app-builder `render` structured-`isError`
  feedback are the reference implementations).
- **Read before write.** An agent that edits an artifact fetches it first
  (`get-design`, `canvasRead`, `get-brief`, `documents.get`,
  `workflow-author get`) — revisions ground on the real object, never memory.
- **Gated apply.** Model output reaches durable state only through closed-world
  validation and/or a human gate (HITL review steps, chain approvals, CAS
  writes, draft-only tools).
- **Byte-exact schemas.** Tool outputs that ARE schemas/catalogs are never
  compacted (`SCHEMA_READ_EXEMPT_TOOLS` in `host/toolResultTransform.ts` — a
  host-level invariant, outside the frozen per-run compaction decision);
  `compactToolSchema` strips only annotation keys from tool definitions.

Reference implementations to copy, not re-derive: **app-builder's agent-tool
trio** (`features/app-builder/agentTools.ts` — catalog → get-design → render
with validate/repair/CAS) and **workflow-author's draft→validate→persist**
(`packs/feature.workflow-author.nodes` over `wa.getCatalog()`); both are graded
A+ in the tracker with their residual drift risks stated.

## Feature-package architecture

The design of record is
[`docs/adr/0001-feature-first-package-architecture.md`](./docs/adr/0001-feature-first-package-architecture.md)
and the living catalog is [`FEATURES.md`](./FEATURES.md). A new product feature
is expected to follow this shape:

```text
backend/typescript/src/features/<id>/
├── feature.ts        # BackendFeature: id, routes, toggle, packs, surface
├── routes.ts         # /v1/host/openwop-app/<id>/*, backend-gated
├── <id>Service.ts    # domain logic and durable data access
└── surface.ts        # optional ctx.features.<id> workflow API

frontend/react/src/features/<id>/
├── routes.tsx        # FrontendFeature: route/nav fragment
├── <Id>Page.tsx      # user/admin surface
└── <id>Client.ts     # API client for host-extension routes
```

Feature route modules should gate their behavior by resolving the backend
toggle and by enforcing the existing tenant/RBAC/consent/connection rules for
the data they touch. Frontend routes use `featureId` for visibility, badges, and
page state, but the server remains authoritative.

Some features have graduated to always-on substrate. That does not mean they
leave the architecture; they still remain `BackendFeature` / `FrontendFeature`
modules for ownership and composition. It only means they do not declare a
runtime `toggleDefault`.

## Protocol and host-extension boundary

The OpenWOP protocol surface is the contract clients and conformance depend on:
run lifecycle endpoints, stream modes, interrupts, replay/fork behavior,
capability discovery, auth profiles, host capabilities, BYOK semantics, pack
execution, canonical errors, and workflow definitions.

Product features may add host-extension routes under `/v1/host/openwop-app/*`.
Those routes can be rich and durable, but they are not allowed to mutate the
OpenWOP wire by accident. When a host-extension pattern becomes generally
needed by OpenWOP clients, promote it through an RFC rather than quietly
depending on app-local behavior.

Capability honesty is mandatory:

- Do not advertise a capability unless the route, enforcement, storage, replay,
  and failure semantics are implemented.
- Do not add a feature workflow surface to discovery unless workflow nodes can
  actually call it under the same toggle and RBAC rules as the REST/UI surface.
- Do not expose a provider, connector, auth profile, MCP surface, search/vector
  backend, or production posture unless the selected backend is configured and
  fail-closed.
- Do not relax an OpenWOP `MUST`, required field, error meaning, event shape, or
  endpoint contract in app code.

## What's a "thin host wrapper"?

The MyndHyve `services/workflow-runtime/` is ~17K LOC because it wires a private engine package into a product host with Firebase auth, Firestore storage, KMS BYOK, Cloud Tasks dispatch, MyndHyve canvas types, and 47 vendor packs.

This app is target ~2–3K LOC because it:

- Implements the wire surface from scratch (like `examples/hosts/postgres/`), since the public `@openwop/openwop` SDK is a *client*, not an engine.
- Stubs auth (any non-empty Bearer token → synthetic principal).
- Stubs storage at sqlite (in-process; one node).
- Stubs BYOK at an in-memory map.
- Stubs Cloud Tasks dispatch with `setImmediate`.
- Registers only `core.*` packs + one example pack (`local.openwop-app`).
- Has no canvas types, kanban, brand, entities, or product surface.

A real deployment swaps each stub for a real implementation. The route handlers and the executor stay.

## The 15 host adapter slots

Mirrors the MyndHyve `HostAdapterSuite` triage. Each slot has a neutral implementation in this app:

| Slot | Real wrap (8) | Implementation |
|---|---|---|
| `tenantResolver` | ✅ | sqlite table `tenants` |
| `scopeResolver` | ✅ | sqlite table `scopes` |
| `workflowCatalog` | ✅ | sqlite table `workflows` + filesystem fallback |
| `principalAuthorizer` | ✅ | role-based, sqlite-backed |
| `identityResolver` | ✅ | stub: any-non-empty-Bearer → synthetic principal |
| `observabilitySink` | ✅ | OTel console exporter |
| `auditSink` | ✅ | sqlite append-only `audit_log` |
| `secretResolver` | ✅ | in-memory map (BYOK) |

| Slot | Minimal wrap (3) | Implementation |
|---|---|---|
| `artifactResolver` | ✅ | `local-fs:///` URI scheme only |
| `contextProviderRegistry` | ✅ | in-memory `Map` |
| `extensionManifestRegistry` | ✅ | sqlite (empty by default) |

| Slot | Throw-on-use stub (4) | Implementation |
|---|---|---|
| `enterprisePolicyResolver` | ⛔ | throws `host_capability_missing` |
| `environmentResolver` | ⛔ | throws `host_capability_missing` |
| `connectorInvoker` | ⛔ | throws `host_capability_missing` |
| `providerPolicyResolver` | ⛔ | throws `host_capability_missing` |

A pack that declares `peerDependencies: ["host.connectors"]` will be refused at register-time when its required surface is `throw-on-use`. This is the OpenWOP `host.*` capability contract working as designed (see `spec/v1/host-capabilities.md`).

## Boundary discipline

Three rules:

### 1. No frontend imports in the backend, no backend imports in the frontend

The two `package.json`s have disjoint dependency trees. The frontend declares `@openwop/openwop`; the backend declares its server deps + `@openwop/openwop` for wire types only. There is no shared local package between them.

### 2. All app-local additions live under `local.*` or `openwop-app.*` namespaces

- Example pack: `local.openwop-app` (NOT `core.*`, NOT `vendor.openwop.*`)
- Example workflow: `openwop-app.uppercase`
- Discovery's extension block: `extensions.openwop-app.*` only

This protects the `core.*` and `openwop.*` namespaces from app-local drift.

### 3. The Cloud Run shape is a deployment archetype, not a coupling

The Dockerfile is multi-stage Node 22-slim + esbuild bundle, listening on `$PORT`, with `/health` + `/readiness` probes — i.e., the canonical Cloud Run shape. But the code statically imports **no** cloud SDK: the AWS/Azure/GCP KMS clients are *optional* dependencies, dynamically imported only when `OPENWOP_BYOK_KMS_KEY` selects that backend (`src/byok/kmsBackends.ts`), so `npm install --omit=optional` yields a cloud-SDK-free image. A deployer who runs the same image on Fly.io / Render / ECS / Kubernetes gets the same behavior — and [`deploy/`](./deploy/README.md) ships a ready-made pack for each (compose, fly, render, aws, azure, gcp).

## Component-by-component map vs. the should-be doc

For each requirement in `MYNDHYVE-ON-OPENWOP-SHOULD-BE-ANALYSIS.md` §3, here's where the app implements it:

| Should-be requirement | Location |
|---|---|
| Engine kernel via `@openwop/openwop` | `src/executor/` (implements wire surface; `@openwop/openwop` consumed for types) |
| `/.well-known/openwop` advertisement | `src/routes/discovery.ts` |
| Run lifecycle endpoints | `src/routes/runs.ts` |
| 4 interrupt kinds + signed-token callback | `src/routes/interrupts.ts` |
| 4 stream modes + Last-Event-ID resume | `src/routes/streams.ts` |
| `Idempotency-Key` + `invocationId` | `src/routes/runs.ts` + `src/executor/invocationLog.ts` |
| BYOK end-to-end with strip-on-persist | `src/byok/` + `src/storage/sqlite/runStore.ts` (strip-on-persist invariant tested) |
| Pack consumption (SRI + Ed25519) | `src/packs/tarballLoader.ts` |
| OTel under `openwop.*` | `src/observability/tracer.ts` |
| Cloud Run shape | `Dockerfile` + `src/index.ts` (`$PORT`, health probes) |
| Conformance harness | `conformance/` |

| Frontend should-be | Location |
|---|---|
| `@openwop/openwop` browser consumption | `src/client/` (thin wrappers) |
| Run lifecycle UI | `src/runs/` |
| SSE event stream rendering | `src/streams/EventStreamView.tsx` |
| 4 interrupt renderers | `src/interrupts/` |
| Capability discovery UI | `src/discovery/CapabilitiesPanel.tsx` |
| BYOK key entry + policy explainer | `src/byok/` |

## Crash recovery + delivery durability (multi-instance-safe)

Two former "next step" gaps are now closed in the app itself — both built on
an atomic, lease-based claim that works across instances (Postgres `FOR UPDATE
SKIP LOCKED`, sqlite a single write transaction):

- **Run dispatch.** `executor.executeRun` — the single chokepoint every dispatch
  path funnels through — stamps a dispatch lease (`storage.setRunDispatchLease`)
  for this instance, expiring past the maximum legal runtime, so a live run is
  never re-dispatched. The `runDispatchSweeper` re-claims and re-runs
  `pending`/`running` runs whose lease expired (the owning instance crashed); the
  re-run is idempotent against the Layer-2 invocation log. A `createdAt` grace
  window keeps fresh dispatches from being raced; `waiting-*`/terminal runs are
  excluded by status.
- **Webhook delivery.** Routes enqueue a durable `webhook_deliveries` row per
  subscriber; the `webhookDeliveryWorker` claims due rows under a lease, signs +
  POSTs them, and retries with exponential backoff until dead-lettering — so a
  crash or transient receiver failure no longer drops a delivery (the prior
  `setImmediate` path did).

Both workers run only in the long-lived server entry (`main`); tests drive the
exported `sweepOrphanedRuns` / `processDueWebhookDeliveries` deterministically.

## Failure modes the app explicitly does NOT guard against

These are valid critiques of the app as a *production* artifact, but in scope only for the documented "next step" follow-ups:

- **Audit-log integrity.** No hash chain, no Ed25519 checkpoint signatures. Use the postgres reference host for that profile.
- **Production SLA claims.** This app doesn't advertise `openwop-production-profile`.
- **Pack publishing.** Read-only catalog only. Publishing lives in the postgres host's `pack-consumer.ts` story + `examples/node-pack-publishing/`.

When swapping a stub for a real implementation, also update the relevant `capabilities` block in `src/routes/discovery.ts` so the advertisement stays honest.

---

## Surfaces added after the initial scaffolding

### AI chat surface (`frontend/react/src/chat/` + `backend/.../bootstrap/nodes.ts` `vendor.openwop-app.chat-responder`)

A vertical slice from chat input → real provider dispatch → streamed tokens back into the bubble. Components:

- `ChatTab.tsx` — state machine that routes between BYOK wizard (no key) and `ChatSidebar` (key present).
- `ChatSidebar.tsx` + `ChatHeader` + `MessageFeed` + `MessageBubble` + `ChatInput` + `WelcomeCard` — the sidebar UI.
- `useChatSession.ts` — message thread state + per-turn dispatch. Each turn = one `POST /v1/runs` with `workflowId: 'openwop-app.chat.turn'`. Subscribes to SSE; appends `output.chunk` deltas to the in-flight assistant bubble; on `node.suspended` fetches the open interrupt and renders the matching card via the registry.
- **Card registry** (`chat/registry/`) is the extensibility seam. Adopters call `registerCard({cardType, Component, ...})` from any module to add their own card type. Built-in registrations cover the 4 interrupt kinds (approval / clarification / refinement / cancellation). Cards wrap in `CardErrorBoundary` so a broken third-party card doesn't crash the panel.

BE-side: `vendor.openwop-app.chat-responder` node calls Anthropic / OpenAI / Google providers via raw `fetch` (no SDK deps). Each token delta becomes an `output.chunk` event through `ctx.emit()` — strip-on-persist applies automatically.

#### Streaming contract for LLM interactions (ADR 0079)

Every LLM dispatch in this host streams its reply token-by-token through ONE
convention — new "talk to AI" code inherits it by reusing the seams below, not by
inventing a parallel stream:

- **Producer.** Pass an `onDelta(delta)` to the provider dispatch (`dispatchChat`
  in `providers/dispatch.ts` — every real provider streams via Web
  `ReadableStream` async-iteration; the conformance `mock` streams a chunked
  canned reply) and emit each delta as a single canonical event:
  `ctx.emit('output.chunk', { chunk, isLast: false })` (or `log.append(...)`
  from a host route). It is **transient** — stream-only, NO channel reducer folds
  it — so the authoritative turn (`conversation.exchanged`) / node result stays
  the source of truth on reload and `:fork`. Each delta MUST be
  `stripSecretsFromPersisted`'d before persist (SR-1 parity — the chunk lands in
  the durable event log too, so it can't leak a secret ahead of the sanitized
  turn). The two producers today are the chat-responder node
  (`bootstrap/nodes.ts`, always streams — it only runs for chat) and
  `aiProvidersHost.callAI`'s plain-text branch, which is **opt-in per call**
  (`req.stream === true`) so non-interactive batch/agent nodes don't append one
  durable event per token for no consumer; structured/JSON calls never stream.
  `openwop-app.node.message` was the transitional dual-emit and was **retired in ADR 0079
  Phase 5** — do not reintroduce it.
- **Consumer.** Tail the run SSE on the direct `*.run.app` URL (`subscribeToRun`,
  CDN-bypassing) and feed each `output.chunk` `chunk` through the
  `useApplyAnimation` batcher into the in-flight bubble. Both chat SSE handlers
  (`chatTurnSubscription.ts`, `useChatSession.ts`) already do this; guard against
  the SSE's replay-from-seq-0 with a subscribe-time cursor
  (`streamDeltaFromEvent`).
- **Async exchange (optional).** The conversation `exchange` can ack early and
  finish generation in the background so a long reply rides the SSE past the ~60s
  CDN POST ceiling — flag `OPENWOP_CONVERSATION_EXCHANGE_ASYNC` (default OFF). A
  post-ack failure surfaces as a terminal `openwop-app.ai.message-error` event, not a POST
  4xx. See ADR 0079 §Phase 3.

### Host-extension HTTP routes (vendor-prefixed)

Per `spec/v1/host-extensions.md` §"Canonical prefixes", anything outside the OpenWOP v1 wire contract MUST be vendor-prefixed. This app's additions:

- `GET / POST / DELETE /v1/host/openwop-app/byok/secrets[/:ref]` — runtime BYOK key management (replaces the env-only flow).
- `GET /v1/host/openwop-app/runs/:id/interrupts` — authed list of open interrupts with their resume tokens. Necessary because `node.suspended` events strip the token from the public event log so SSE / webhook fanout can't leak a resolution capability. Strong candidate for future RFC promotion — every host that strips tokens needs this surface.

### BYOK persistence (`backend/.../byok/`)

- `secretResolver.ts` delegates to sqlite via new `Storage` methods (`upsertEncryptedSecret` / `getEncryptedSecret` / `deleteSecret` / `listSecretRefs`).
- `encryption.ts` provides AES-256-GCM with master-key resolution: `OPENWOP_BYOK_ENCRYPTION_KEY` env var → auto-generated `data/.byok-master-key` (0600 perms) on first boot.
- Security boundary documented at the top of `encryption.ts`: protects against backup leaks and database extraction; does NOT protect against full filesystem access (master key on disk) or process memory inspection (decrypted plaintext cached in-process). This local-AES path is the portable fallback; for production set `OPENWOP_BYOK_KMS_KEY` to a managed KMS key (AWS KMS / Azure Key Vault / Google Cloud KMS — `src/byok/kmsBackends.ts` + `kmsEncryption.ts`), which never lands the wrapping key on disk.

### Pack coverage: all `core.openwop.*` nodes in the builder palette

On boot the server runs three layered pack-loading steps:

1. **`ensureRegistryPacksInstalled()`** — fetches published, Ed25519-signed packs (`core.openwop.ai`, `core.openwop.http`, …) from `packs.openwop.dev` and verifies them per spec. Trust anchor: registry public keys at `<repo>/registry/keys/<keyId>.pub`.
2. **`ensureLocalPacksMounted()`** — dev-mode fallback (`src/bootstrap/mountLocalPacks.ts`). Symlinks every `core.openwop.*` directory from the repo's `packs/` tree into the same `OPENWOP_PACK_DIR` the registry installer writes to. Two refinements:
   - **Skip-if-installed** — never clobbers a registry-installed pack with the same name.
   - **Shadow-if-newer** (default; opt out with `OPENWOP_STRICT_REGISTRY=true`) — when the repo manifest version is greater than the registry-installed version, rename the installed dir aside (`<name>.registry-<oldVersion>`) and symlink the repo dir in its place. Logged loudly; reversible by deleting the symlink and `mv`-ing the `.registry-*` dir back.
3. **`seedDefaultHostSurfaces()`** + **`initInMemorySurfaces({ dataDir })`** — declares the full RFC 0014–0019 surface list with `supported=false` defaults, then wires in-memory adapters (`src/host/inMemorySurfaces.ts`) and flips each wired surface to `supported=true`.

The catalog endpoint (`GET /v1/host/openwop-app/node-catalog`) cross-references each node's typeId against `bootstrap/hostSurfaceMap.ts` to compute `requiresHostSurfaces` + `missingHostSurfaces`. The UI dims palette items whose surfaces aren't advertised and shows a warning banner in the inspector; runs of those nodes return a friendly `host_capability_missing` envelope (augmented in `packs/tarballLoader.ts`).

### In-memory host surfaces (non-durable)

`src/host/inMemorySurfaces.ts` builds one surface bundle per run, scope-bound to `tenantId`:

| Field on `ctx` | Backing impl | Used by packs |
|---|---|---|
| `ctx.storage.kv` | `Map<tenantId, Map<key, entry>>` with TTL | `core.openwop.storage` (kv-*) |
| `ctx.storage.table` | tenant-scoped Map, table namespacing via key prefix | `core.openwop.storage` (table-*) |
| `ctx.storage.cache` | KV under a separate state Map | `core.openwop.storage` (cache-*) |
| `ctx.storage.blob` | Map of base64 blobs, synthetic `presign()` URL | `core.openwop.storage` (blob-*) |
| `ctx.storage.queue` | FIFO array per (tenant, queue) | `core.openwop.storage` (queue-*) |
| `ctx.db.sql` | `better-sqlite3` `:memory:` DB per tenant + parametric heuristic | `core.openwop.db` (sql-*) |
| `ctx.db.vector` | brute-force cosine over an in-memory Map | `core.openwop.db` (vector-*), `core.openwop.rag` (vector-*) |
| `ctx.fs` | sandboxed local fs under `<dataDir>/host-fs/<tenant>/` with path-escape rejection | `core.openwop.files` (read/write/stat/list/delete) |
| `ctx.queueBus` | in-memory publish/ack/nack/streamPublish | `core.openwop.messaging` (publish/ack/nack/stream-*) |
| `ctx.observability` | delegates to the workflow-engine structured logger | `core.openwop.obs` (log/metric/span/alert) |

### `ctx.compensation` — the inverse-action identity (RFC 0151 §C)

**Pack-facing contract, added 2026-08-16 by the ADR 0554 wire flip.** A node module
normally sees no `ctx.compensation`. It is present ONLY when that node is running
as an **inverse action** — the compensator the unwind invoked for a node that
declared `compensation.nodeTypeId` — and it carries:

| Field | Meaning |
|---|---|
| `ctx.compensation.inverseActionId` | The §C inverse-action identity. **Constant across retries** of the same obligation. |
| `ctx.compensation.attempt` | Which attempt this is. **Varies.** Also now the real value of `ctx.attempt`, which was previously pinned at `1` on this path. |

**What a compensator MUST do with it:** present `inverseActionId` — by itself — as
the idempotency key at the downstream provider. RFC 0151 §C puts `attempt`
*outside* the identity precisely so a retry re-presents the same key; a
compensator that composes the two (or derives a key from anything else that moves)
mints a second obligation on every retry, which for a refund node is a second
refund. This is the whole reason the block exists: before it, the host held the
identity and the compensator — the only thing that can present it downstream —
had no way to reach it.

The block is optional in the type, so existing nodes compile and run unchanged;
a node that never acts as a compensator will simply never see it.

Surfaces NOT wired (advertised honestly as `supported=false`): `host.mcp`, `host.a2a`, `host.triggers` (subset), `host.db.nosql`, `host.db.search`. The palette badges these as "host?" in the UI and the inspector explains.

### Path to real backends (the surface seam)

The interface contracts in `src/host/inMemorySurfaces.ts` (`KvSurface`, `TableSurface`, `SqlSurface`, …) are the *same* shapes a real-backend host will satisfy. The `NodeContext` typing in `src/executor/types.ts` (`HostStorageSurfaces`, `HostDbSurfaces`, …) doesn't bind to a specific implementation. Each portable surface is selected at build time through the backend seam in `src/host/surfaceBackends.ts`: by default every surface resolves to the `'memory'` (non-durable) tier; a deployment overrides any one via `OPENWOP_SURFACE_<KEY>` (or `OPENWOP_SURFACE_BACKEND` globally). To swap a surface with a real backend:

1. Create `src/host/<backend>/<surface>.ts` exporting a factory `(scope) => KvSurface` (or `SqlSurface`, …) over the real store.
2. Register it: `registerSurfaceAdapter('kv', 'redis', factory)` (typically from the adapter module, imported at boot). `buildHostSurfaceBundle` then resolves the selected backend per surface automatically — no edit to the bundle factory or pack code. Selecting a backend with no registered adapter **fails at boot** (`assertSelectedBackendsAvailable`), never silently falling back to the in-memory tier.
3. The advertised `implementation` tag is computed from the selected backend (`effectiveImplementation`), so once a surface uses `'redis'` / `'postgres'` / `'s3'` instead of `'memory'`, `/.well-known/openwop` reports it and the capabilities-panel non-durable badge self-clears.
4. Re-run `npm run test:conformance` to ensure the openwop-conformance suite still passes against the new wiring.

The reference for *real* backend wiring lives in `examples/hosts/postgres` — that example already pressures the RFC 0014–0019 contracts against actual services, and is the natural place to ship production-grade adapters before they migrate into this app's host suite.

### Shared provider catalog (`providers.json`)

Single source of truth for AI provider + model data. Both BE (`src/providers/catalog.ts` for default-model fallback) and FE (`src/byok/lib/providers.ts` for the wizard) read from the same file. The FE loader includes a runtime validator that fails loud on shape mismatch — better than silent `undefined`/`NaN` rendering.

Edit the JSON to add/remove providers or models. The `_schemaVersion` field hints at versioned schema for future migrations.
