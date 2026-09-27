# ADR 0191 — Bundled workflow templates resolve out of the box

Status: Accepted (Phase 1 + Phase 2 implemented)

## Context

The reference app installs `core.openwop.workflows.lighthouse` (ADR 0149) by
default (`OPENWOP_INSTALL_PACKS`). Those five "real work" templates are authored
over the feature node packs — `feature.crm.*`, `feature.analytics.*`,
`feature.kb.*` — plus `core.ai.chatCompletion` and `core.openwop.integration.*`.
The pack manifest promises graceful degradation: "on hosts that ship the feature
packs (e.g. the OpenWOP reference app) [the templates] resolve fully; on other
hosts the unmet node types surface as a connect/install prompt rather than
failing."

That promise held only half. The reference app **ships** the feature packs, so
the node *types* resolve — but the surfaces those nodes read (`ctx.features.crm`,
`ctx.features.analytics`) are **toggle-gated** (ADR 0014), and `crm` + `analytics`
shipped `status:'off'` by default (each "a brand-new product surface", ADR
0018/§4). So a tenant that installs a lighthouse template and runs it hits a
**runtime** `host_capability_disabled` throw mid-run — the exact failure the
manifest's degradation clause was meant to prevent. Observed in prod on
`lighthouse.renewal-risk` (`feature 'analytics' is not enabled for this tenant`)
and `lighthouse.account-brief` (`crm`). (`kb` is unaffected — it graduated to
always-on, ADR 0010/0024; `feature.kb.nodes.rag` never gates.)

Two gaps compound:
1. **Default state** — a *reference/demo* app whose flagship bundled templates
   fail out of the box is a broken first-run. The off default was correct policy
   for a net-new SaaS surface, wrong for the demo host that ships templates
   depending on it.
2. **Failure mode** — even where a per-tenant off is legitimate, a *zero-config*
   template should tell the operator "this needs CRM + Analytics — enable them"
   **before** the run, not throw a raw capability error from inside node
   execution. The manifest's degradation clause only covers *missing node types*
   (install prompt), never *installed-but-toggle-gated surfaces*.

## Decision

Two phases, decoupled so the urgent fix ships first.

### Phase 1 — Default the reference-app product surfaces the bundled templates need to `on`

Flip `crm` and `analytics` `toggleDefault.status` from `'off'` → `'on'`. The
reference app ships these surfaces on so the bundled templates resolve out of the
box. Scope of the flip is deliberately minimal — only the two features the
lighthouse pack actually reads; every other product feature (`production`,
`forms`, `consent`, `email`, `usage-analytics`, …) stays `off`.

Preserved invariants:
- **CRM A/B split** — `crm` keeps its `basic`/`enriched` variants. `status:'on'`
  with variants ⇒ enabled + split traffic (`featureToggles/service.ts`), so the
  triage-node experiment is unchanged; only the gate opens.
- **Analytics consent** — the toggle gates only the *authed read surface*. The
  public beacon stays independently consent-gated (ADR 0020). Default-on changes
  nothing about consent.
- **Operator override** — the default is the floor, not a lock. A super-admin can
  still set either feature `off` (globally or per-tenant) in the Feature toggles
  screen; `resolveOne`'s stored-config + `tenantOverrides` layering is unchanged.

This is a host-config decision (a compiled default), **not** a wire change — no
RFC. It changes behavior for every deployment of this app, including the MyndHyve
cutover (which becomes a first-class consumer): those deployments now ship CRM +
Analytics on by default, which is the intended posture for a work-twin runtime.

### Phase 2 (proposed) — Pre-flight required-capability check on templates

Make the "needs a feature enabled" case a **designed pre-run state**, not a
runtime crash, so any host (or any tenant that turned a feature off) degrades the
way the manifest promises:

1. **Derive required features from a chain** — a chain's node `typeId`s follow the
   `feature.<id>.nodes.*` convention, so the host can compute the set of feature
   toggle ids a chain depends on by scanning its steps (host-only; no manifest
   field, no wire change).
2. **Expose the requirement on the existing listing** — extend the non-normative
   `GET /v1/host/openwop-app/workflow-chains` projection.
   **Correction (as implemented):** the ADR first proposed resolving each toggle
   for the caller server-side (`requiredFeatures: [{ id, enabled }]` via
   `resolveOne`). Implemented instead as **host-global derivation + client-side
   join**, matching the pre-existing `chainRequirements` pattern (the route is
   `_req`; connection status already joins client-side). The projection carries
   `requiredFeatures: [{ id, label }]` (label from the toggle default; **only
   toggle-gated features — always-on ones like `kb` are omitted**), and the
   `TemplatePreflightModal` joins each id against the caller's already-loaded
   `useAllFeatureAccess()` assignments to decide enabled/disabled. This keeps the
   route caller-agnostic and reuses `FeatureAccessContext` instead of coupling the
   listing to the toggle service. `/v1/host/openwop-app/*` is a host-extension
   route — no RFC. `requiredFeatures` extends the existing `chainRequirements`
   seam (a 4th injected resolver, like `providerExists`) — no parallel path.
3. **Surface it in the template UI** — the `ChainTemplateModal` / template card
   renders a `<Notice>` when a required feature is off ("This template needs CRM
   and Analytics"), with an **Enable** affordance for super-admins (reusing the
   `FeatureTogglePanel` save path) and a read-only explainer for everyone else.
   No new "talk to AI" surface, no second admin system.

## Alternatives weighed

- **Leave the defaults off; document "enable these first".** Rejected: makes the
  flagship demo broken by default and pushes a papercut onto every new operator.
- **Enable *all* product features by default.** Rejected: over-broad; only the two
  the bundled templates read are justified. The rest stay off (single-purpose
  gating intact).
- **A per-chain `requiredFeatures` field in the RFC 0013 manifest.** Rejected: it
  would touch the normative wire schema and need an openwop RFC for a fact the
  host can already derive from node typeIds. Phase 2 stays host-only.
- **Catch the runtime throw and re-render as a prompt.** Rejected: mid-run failure
  still burns a run + a poor UX; pre-flight is the honest place.

## Implementation record

| Phase | What | Status |
|---|---|---|
| 1 | `crm` + `analytics` `toggleDefault.status` → `on`; FEATURES.md rows; correction notes in the two `feature.ts` headers | implemented — this change |
| 2 | `requiredFeatures` derivation (`chainRequirements` 4th resolver, gated-only) + `workflow-chains` projection + `TemplatePreflightModal` feature rows + `<Notice>` + Enable CTA (client-join via `useAllFeatureAccess`) | implemented |

## Open questions / decisions checklist

- [x] Which features to flip — only `crm` + `analytics` (the lighthouse deps);
      `kb` is already always-on. Others stay off.
- [x] CRM A/B variants preserved under `status:'on'` — yes (on + variants ⇒ split).
- [x] Analytics consent unaffected — yes (beacon gate is separate).
- [x] Wire/RFC gate — none; compiled default + non-normative host route.
- [x] Phase 2: global vs per-tenant enable — **deferred to the Feature toggles
      panel.** The modal's Enable CTA navigates to `/feature-toggles` rather than
      writing a toggle itself, so the operator makes the global-vs-override call
      in the existing admin surface (no bespoke enable path in the modal).
- [x] Phase 2: non-super-admin affordance — the Enable CTA shows **unconditionally**
      (mirrors the existing "Connect" CTA, which also links out regardless of
      permissions); `/feature-toggles` is admin-tier and self-gates. The `<Notice>`
      names the features so a non-admin still learns what to ask an operator for.
