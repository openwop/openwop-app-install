# ADR 0104 — Super-admin agent tool-allowlist editor (runtime override over pack manifests)

**Status:** implemented (Phases 1–4 complete — override store + dispatch seam, super-admin REST + tool catalog, admin screen, audit; see § Implementation ledger)
**Date:** 2026-06-22
**Toggle:** none new — a **platform-admin surface**, gated by `requireSuperadmin` (ADR 0028),
not a tenant feature toggle. Visible only on the admin rail (`tier: 'admin'`).
**Capability:** no new `AgentCapabilityId`; no wire capability. Adds a host-local,
per-`(tenant, agentId)` **toolAllowlist override** persisted in a `DurableCollection` and
merged at the single dispatch seam where `filterTools` runs. The agent's *advertised*
manifest is unchanged (see § "Honesty / wire").
**Depends on / composes:**
ADR 0028 (super-admin gate — `requireSuperadmin`), ADR 0031 (`AgentProfile` / the
`DurableCollection` host-extension store — the persistence precedent), ADR 0058 §5 + ADR 0089
(chat-drivability = agent `toolAllowlist` → node packs; the thing being edited), RFC 0002 §A14
/ RFC 0003 (the `toolAllowlist` manifest field this overrides host-side),
[[agent-capability-core-not-named]] (the editor is generic over all agents — nothing
Iris-specific), [[no-parallel-architecture]] (override at the existing dispatch seam — do
**not** fork the agent registry or mutate the shared resolved manifest).
**Surface:** host-internal admin, under `/v1/host/openwop-app/agent-allowlists/admin/*`
(super-admin gated; mirrors the `feature-toggles/admin/*` convention). No public surface.
**RFC gate:** **NO new RFC.** Host-local dispatch policy over an already-specified manifest
field; no run-event field, capability flag, event type, endpoint contract, or normative MUST.
See § "RFC gate".

---

## Why this exists

ADR 0058/0089 established that an agent gains the ability to take an action when a node-pack
tool is in its **`toolAllowlist`**. For a **pack-installed** agent — the Chief of Staff
(Iris), the Prioritization Analyst, every `feature.*.agents` persona — that allowlist is
**baked into the signed pack manifest** (`packs/feature.*.agents/pack.json`) and is
**immutable at runtime** (loaded once into the in-process agent registry; ADR 0058 work).
The only way to change Iris's tools today is to hand-edit a pack file and redeploy. A
**user-forked** agent has a `PATCH /agents/:agentId` allowlist route — but that path does
not exist for the pack agents, and there is **no UI** for either.

The operator needs a **screen** to grant or revoke an agent's tools without a code change —
e.g. give Iris the new `schedule-status` node (ADR 0103) the moment it ships, or pull a tool
back if it misbehaves. This is a **platform-operator** action (trusted, infrequent,
audited), so it is **super-admin gated**, not a tenant self-serve control.

## Goal

A super-admin-only screen + REST surface that reads any agent's **effective tool allowlist**
(manifest ∪/− override) and the **catalog of mountable tools**, and persists a per-`(tenant,
agentId)` override that the dispatcher applies — covering pack-installed *and* user-forked
agents through one seam — without mutating the shared manifest or forking the registry.

> **Correction (Phase 1 implementation, 2026-06-22 — architect review).** Two design
> points the original draft got wrong, found by reading the live dispatch code:
> 1. **Not "one filterTools seam" — two model-offering chokepoints.** `filterTools`
>    runs at three sites: `runAgentDispatchLive` (async, `deps.tenantId`),
>    `compileAgentTools` (sync) called by the chat path `runConversationAgentToolTurn`
>    (async, `run.tenantId`), and the **sync deterministic** `runAgentDispatch` (no
>    model call; A2A floor / workforce-eval / RFC-0070 REST). The override is applied
>    at the two **model-offering** paths (live dispatch + chat turn — both async with a
>    tenant in scope; the chat path passes an effective allowlist into a new optional
>    `compileAgentTools(…, allowlistOverride?)` param). The deterministic sync seam is
>    **out of scope** (it offers nothing to a live model and cannot take an async lookup).
> 2. **No `host:`-only guard.** Unlike `resolveAgentToolPermissions` (profile-derived,
>    `host:`-scoped), the override MUST resolve for ANY agentId — Iris dispatches under
>    the pack id `feature.assistant.agents.chief-of-staff`, so a `host:` guard would make
>    the feature's first consumer silently no-op.

---

## Boundaries audit (what already exists — reuse, do not fork)

`Explore` sweep (2026-06-22):

- **Super-admin gate exists.** `host/superadmin.ts` — `requireSuperadmin(req, surface?)`
  (env `OPENWOP_SUPERADMIN_TENANTS`, `*`-tenant bearer, or `OPENWOP_FEATURE_TOGGLES_DEV_OPEN`
  dev opt-in). Reuse verbatim ([[prod-superadmin-mechanism]]).
- **Admin route + screen precedent.** `routes/featureToggles.ts` exposes
  `…/feature-toggles/admin/configs` (each handler calls `requireSuperadmin`);
  `featureToggles/FeatureTogglePanel.tsx` + `client/featureTogglesClient.ts` are the
  canonical admin-screen UX (load → edit-in-place → save, 403 → `<Notice variant="error">`).
  The new screen is registered the same way: one entry in `chrome/features.tsx` with
  `tier: 'admin'` (auto-listed on `settings/AdminOverviewPage`).
- **DurableCollection is the host-extension store.** `host/agentProfileService.ts`:
  `new DurableCollection<AgentProfile>('agent-profile', p => p.profileId)` with fail-closed
  cross-tenant reads (`profile.tenantId !== tenantId → null`). The override store is the
  same shape — **no new DB table, no migration** (ADR 0031).
- **The dispatch seam is singular and already the §A14 owner.** `host/agentDispatch.ts`
  reads `agent.toolAllowlist` and applies `filterTools(req.availableTools, allowlist)` at
  **two** call sites — the deterministic path (~`:168`) and the live path (~`:616`). Both
  resolve the manifest via `getAgentRegistry().get(agentId)` (an immutable, process-global
  Map; `executor/agentRegistry.ts`). This is the one place to inject the override so it
  covers **both** agent kinds and **both** dispatch modes.
- **Tenant scope is enforced at the route/dispatch layer, not the registry** (`routes/agents.ts`
  `visibleTo()`); pack agents are global (`ownerTenant` undefined), user agents tenant-bound.
  The override is therefore keyed by `(tenantId, agentId)` and applied with the **dispatch
  tenant**, so a per-tenant grant never leaks to another tenant's dispatch of the same global
  pack agent.
- **The userAgents PATCH proves "set allowlist + re-register"** for forked agents
  (`routes/userAgents.ts`). We do **not** extend that path to pack agents (can't mutate a
  signed manifest); we override at dispatch instead — strictly host-local policy.

## Decision

A host-local **`AgentToolAllowlistOverride`** store + a super-admin REST surface + an admin
screen, with the override applied at the **single existing `filterTools` seam** in
`agentDispatch.ts`. The override is **full-replace** semantics ("these are the tools this
agent may use"), with **clear-override = revert to the manifest**.

### Data model (additive — DurableCollection, no migration)

```
AgentToolAllowlistOverride
  overrideId: string             // `${tenantId}:${agentId}` (the DurableCollection key)
  tenantId: string
  agentId: string                // pack agentId (e.g. feature.assistant.agents.chief-of-staff) OR a user agentId
  toolAllowlist: string[]        // FULL replacement set (openwop:<typeId> ids); [] = "no tools"
  note?: string                  // operator rationale (audit)
  updatedBy: string              // the super-admin subject
  updatedAt: string
```

`new DurableCollection<AgentToolAllowlistOverride>('agent-toolallowlist-override', o => o.overrideId)`,
fail-closed cross-tenant read (mirrors `agentProfileService`).

### Resolution seam (the only behavioral change)

In `agentDispatch.ts`, both dispatch paths, **after** `getAgentRegistry().get(agentId)` and
**before** `filterTools`:

```ts
const manifestAllow = agent.toolAllowlist;
const override = await getAgentToolAllowlistOverride(dispatchTenantId, agent.agentId);
const effectiveAllow = override ? override.toolAllowlist : manifestAllow;
const toolSurface = filterTools(req.availableTools ?? [], effectiveAllow);
```

- **Late-binding:** resolved per dispatch, so an edit takes effect on the next run — no
  registry mutation, no cache invalidation, no redeploy.
- **Never widens beyond what's mounted:** `filterTools` still intersects with
  `req.availableTools`, which already reflects mounted node packs + enabled feature toggles.
  Granting a tool whose feature is OFF (or whose pack isn't installed) is a **no-op** — the
  tool simply isn't offered. The override controls *offering*, not feature entitlement.
- **The shared resolved manifest is never mutated** — the override is read alongside it.

### REST surface (super-admin gated)

```
GET    …/agent-allowlists/admin/agents             // list agents (pack + user) + manifestAllowlist + override (if any)
GET    …/agent-allowlists/admin/agents/:agentId    // one agent: manifestAllowlist, override, effective, + toolCatalog
PUT    …/agent-allowlists/admin/agents/:agentId    // upsert override { toolAllowlist, note }
DELETE …/agent-allowlists/admin/agents/:agentId    // clear override → revert to manifest
```

`toolCatalog` = the mountable tool ids (core nodes + installed node-pack `typeId`s, as
`openwop:<id>`), so the screen presents a **checklist** rather than free text. Every handler
calls `requireSuperadmin(req, 'Agent tool-allowlist administration')`. Validation: array of
strings, each `^openwop:[A-Za-z0-9._:-]+$`, max 64 entries (cap matches the userAgents
validator); unknown ids are **allowed** (harmless — filtered at dispatch) but surfaced in the
UI as "not currently mounted".

### Frontend

A new `tier: 'admin'` screen (`AgentAllowlistPanel.tsx` + `agentAllowlistClient.ts`),
modeled on `FeatureTogglePanel`: pick an agent → see manifest baseline + a checklist of the
tool catalog (manifest tools pre-checked, override diffs highlighted) → Save (PUT) / Reset to
manifest (DELETE). Registered via one `chrome/features.tsx` entry (`group: 'Platform'`,
`labelKey`/`hintKey` i18n across en/es/fr/pt-BR). 403 renders the standard super-admin
`<Notice>`.

## Phased plan

- **Phase 1 — store + resolution seam.** `AgentToolAllowlistOverride` type +
  `agentToolAllowlistService.ts` (`get`/`upsert`/`clear`, fail-closed tenant) +
  inject the override at the two `filterTools` sites in `agentDispatch.ts`. Unit tests:
  override replaces manifest; absent override = manifest; cross-tenant override ignored;
  unmounted tool is a no-op; clear reverts.
- **Phase 2 — super-admin REST.** The four routes above + `toolCatalog` assembly from the
  node registry; `requireSuperadmin` on each; route tests (403 for non-admin, upsert/read/
  clear round-trip, validation rejects, tenant isolation).
- **Phase 3 — admin screen.** `AgentAllowlistPanel` + client + `chrome/features.tsx` entry +
  i18n (4 locales) + `ui/` cohesion (checklist, `<Notice>`, `<StateCard>`/`<Skeleton>`);
  light + dark; a11y (`/ux-review`).
- **Phase 4 — audit.** Emit a governance/audit log entry on every upsert/clear (who, agent,
  before→after) per ADR 0028's admin-action audit pattern.

## Evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package (0001) | Host-extension, not a tenant feature: `host/agentToolAllowlistService.ts` + `routes/agentAllowlists.ts` + a small dispatch-seam edit. No core nav edits beyond the admin-rail registration. |
| 2 | Toggle + admin UI | **No tenant toggle.** Super-admin gated; surfaced on the admin rail (`tier: 'admin'`) like Feature toggles. |
| 3 | Workflow surface (0014) | None — this configures *which* tools an agent is offered; it adds no `ctx.features.*` surface. |
| 4 | Node pack | None new. It edits the *consumers* of node packs (allowlists), not the packs. |
| 5 | AI-chat envelopes | N/A (no separate envelope seam, ADR 0058 §5). The override feeds the existing agent+node dispatch path. |
| 6 | Agent pack | Generic over ALL agents (pack + user); nothing named-agent-specific ([[agent-capability-core-not-named]]). |
| 7 | Public surface | **None.** Super-admin authed only. |
| 8 | RBAC + isolation (0006/0028) | `requireSuperadmin` on every route; override keyed + read by `(tenantId, agentId)`, fail-closed cross-tenant (DurableCollection pattern). Override cannot bypass feature toggles/RBAC — `filterTools` ∩ `availableTools` still applies; node execution still hits each feature's own gate. |
| 9 | Replay / fork safety | The allowlist gates *which tools are offered at dispatch*; a completed run **replays recorded outputs**, so a later edit never alters a past run. New runs bind the current effective allowlist. No `featureVariant` stamp (tool offering is not a run-dispatch variant). |
| 10 | Frontend | `AgentAllowlistPanel` + client + admin-rail entry; checklist UX; tokens/a11y; light + dark; i18n ×4. |

## Honesty / wire

The `toolAllowlist` is an RFC 0003 manifest field and RFC 0002 §A14 informs host filtering.
This ADR does **not** change the agent's **advertised** manifest — the override is **host-local
dispatch policy**. An agent's published manifest (and any A2A advertisement) continues to
reflect the pack-declared allowlist; the host simply applies an operator policy when *it*
dispatches. We therefore advertise nothing dishonest. (If a future requirement were to
*re-advertise* a mutated manifest on the wire, that would need an RFC — out of scope.)

## RFC gate

**Host-extension only — no new RFC.** Routes live under `/v1/host/openwop-app/agent-allowlists/admin/*`
(non-normative); the override is a host-local `DurableCollection` record applied at the
host's own dispatch seam. No run-event field, capability flag, event type, endpoint
contract, or normative MUST; no change to the manifest wire shape (§ "Honesty / wire").

## Alternatives weighed

- **Mutate the resolved manifest in the registry** vs **read an override at dispatch** →
  chose dispatch read. The registry is process-global and un-tenanted; mutating it would
  leak a per-tenant grant across tenants and fight the immutable-manifest design
  ([[no-parallel-architecture]]).
- **Extend the userAgents PATCH to pack agents** vs **a separate override store** → chose
  the override. A pack manifest is signed/immutable; "editing" it would mean shadow-copying
  it into the user-agent store — a parallel agent. The override leaves the manifest intact.
- **Additive override (manifest ∪ extra)** vs **full-replace** → chose full-replace
  (matches the userAgents allowlist semantics; the UI seeds the checklist from the manifest
  so "add one" is still one click, and *revoke* is expressible — additive could not revoke).
- **Tenant self-serve** vs **super-admin only** → super-admin. Granting an agent new tools
  is a platform-trust decision (an agent reaching connected systems); it belongs with the
  operator, audited, not in tenant hands.
- **Free-text tool ids** vs **checklist from a catalog** → catalog, to prevent typos and
  make the mounted-vs-unmounted state legible (typos are harmless but confusing).

## Open questions

- [ ] **Scope of an override for a global pack agent** — per-tenant (proposed) vs
      platform-global single record. Per-tenant is safer (no cross-tenant surprise) but means
      a global default still requires a manifest edit. Proposed: per-tenant now; a
      `tenantId: '*'` platform-default row is a later enhancement.
- [ ] **Tool catalog source** — confirm the node registry exposes a list of mounted node
      `typeId`s + core node ids for the checklist (Phase 2 spike). If not, assemble from the
      installed-pack manifests.
- [ ] **Audit destination** — reuse ADR 0028's admin-audit log vs a dedicated
      `agent-allowlist-audit` collection. Proposed: reuse 0028.
- [ ] **Interaction with ADR 0102 per-tool permission enforcement** — confirm the override
      (offering) composes cleanly *above* 0102's per-tool execution gate (entitlement); they
      are orthogonal layers but worth an explicit test.

## Implementation ledger

**Phase 1 shipped 2026-06-22.** Backend `tsc --noEmit` clean; `agent-toolallowlist-override`
+ existing dispatch/chat suites green (33 tests). Reviewed: `/architect` before (the two
corrections above), `/code-review` after (clean — no fixes).

| Phase | What landed | Artifacts |
|---|---|---|
| 1 — store + dispatch seam | `AgentToolAllowlistOverride` + `agentToolAllowlistService` (resolve/get/list/upsert/clear, tenant-prefixed key, fail-closed, **no `host:` guard**); override applied at `runAgentDispatchLive` + the chat tool-loop (`runConversationAgentToolTurn` → new optional `compileAgentTools(…, allowlistOverride)` param); deterministic `runAgentDispatch` documented out-of-scope | `host/agentToolAllowlistService.ts`, `host/agentDispatch.ts`, `host/conversationToolLoop.ts`, `test/agent-toolallowlist-override.test.ts` |
| 2 — super-admin REST + tool catalog | **shipped 2026-06-22** — `routes/agentAllowlists.ts`: GET `…/agents` (list + override), GET/PUT/DELETE `…/agents/:agentId` (manifest/override/effective + `toolCatalog`); all `requireSuperadmin`; `visibleTo` 404 (no cross-tenant leak); keyed by the DISPATCH agentId; ROUTE_MODULES entry; 5 route tests | `routes/agentAllowlists.ts`, `routes/registerAllRoutes.ts`, `test/agent-allowlists-routes.test.ts` |
| 3 — admin screen | **shipped 2026-06-22** — `agentAllowlists/AgentAllowlistPanel` (agent list + tool checklist seeded from manifest/override, Save/Reset) + `agentAllowlistClient` + `chrome/features.tsx` (`/agent-allowlists`, `tier:'admin'`, Platform nav) + `agentAllowlists` i18n namespace ×4 + nav labelKey/hintKey ×4 | `frontend/react/src/agentAllowlists/*`, `chrome/features.tsx`, `i18n/locales/*/nav.ts` |
| 4 — audit | **shipped 2026-06-22** — best-effort `hostExtStorage().appendAudit` on upsert (`agent-allowlist.upsert`) + clear (`agent-allowlist.clear`), keyed `tenant:agentId`, no second audit store (ADR 0028) | `routes/agentAllowlists.ts` |

**Review cycle (per phase): `/architect` before · `/code-review` + `/ux-review` after, all fixes applied.**
- **Phase 1** — architect found + fixed the "two model-offering chokepoints, not one seam" and "no `host:` guard" corrections; code-review clean.
- **Phase 2** — architect added the `visibleTo` 404 refinement; code-review clean (gate on every route, bounded reads).
- **Phase 3/4** — architect (inline) confirmed the area-dir/namespace auto-registration + audit-composes-appendAudit; code-review + ux-review clean (no banned patterns, no hex/emoji, reused `ui/` primitives, a11y).
- **Gates:** backend `tsc` clean + `agent-allowlists`/`agent-toolallowlist` suites green (13 tests); frontend `npm run build` green (tsc + token/CSS/i18n + vite + bundle/CSP).

## Next step

`/architect` review recommended (this touches capability gating + authz + replay reasoning —
the CLAUDE.md trigger). On acceptance: Phase 1→4; `/code-review` + `/nfr` pre-merge;
`/ux-review` for the admin screen (light + dark). First real consumer: granting Iris the
ADR 0103 `schedule-status` node from the UI instead of a pack edit.
