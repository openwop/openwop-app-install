# 0184 — Pack-chain provider decoupling: what Phase 1 fixed, and the capability-node gate for the rest

Status: accepted

## Context

The reusable-workflow redesign (Phases 1–4) set out to fix two complaints about the
21 vendored workflow-chain packs (`examples/workflow-chain-packs/*`):

1. **Single-use / throwaway** — chains froze per-invocation values (a specific PTO
   date, a topic) into the instantiated `WorkflowDefinition`, so each instance was a
   one-shot.
2. **Hard-coded vendor** — chains bind one provider by name: marketing → `google-ads`,
   exec-ops → `microsoft365`, people-hr → `workday`/`microsoft365`/`jira`, finance →
   `netsuite`, it-support → `jira`/`microsoft365`.

This ADR records where those stand after Phases 1–2, and the architecture decision for
the remaining provider-decoupling — because a rigorous review shows the bulk of it is
**gated on capability infrastructure that does not exist yet**, not a mechanical edit.

## What is already fixed

- **Complaint 1 is resolved for all 21 chains (Phase 1, shipped #1057).** `expandChain`
  now lifts per-invocation `parameters` into the definition's `variables[]` (the
  normative run-input contract) and rewrites `{{params.X}}` → `{{inputs.X}}` at
  instantiate time — it no longer freezes values. Every chain is reusable via
  `POST /v1/runs.inputs`; no chain edit was required. This applies uniformly, so it is
  **not** re-done per pack here.
- **The capability-typed *connection* seam exists (Phase 2, shipped #1058).**
  `resolveProviderForCapability` + `requiredConnections: capability:<category>` let the
  host resolve "the user's <category> connection" and gate readiness by capability
  rather than a named provider.

## The finding: why the chains still name a vendor

The chains reach external systems through `core.openwop.http.openapi-call` nodes whose
config is `{ connectionRef, operationId }` — e.g. `{ google-ads, createCampaign }`,
`{ workday, createWorker }`, `{ microsoft365, listCalendarEvents }`. Two facts make
these **inherently provider-specific**, and Phase 2's connection seam does not change
that:

1. **`connectionRef` is inert at the egress seam.** Credentials bind by URL-host match
   in `connectionInjection.ts` (`makeConnectionSafeFetch`) against
   `run.configurable.connections`; the node's `connectionRef` is advisory metadata,
   never read to pick the credential. So retyping it to `capability:hr` decouples
   nothing.
2. **`operationId` + the OpenAPI spec are the provider's API shape.** `createWorker`
   (Workday), `listCalendarEvents` (Graph), `createCampaign` (Google Ads) are one
   vendor's operations against one vendor's schema. Pointing the same node at BambooHR
   or Google Calendar is a different spec + different operations — not a config swap.

**Therefore a chain built on `openapi-call` cannot be made provider-agnostic by editing
the pack.** Only a provider-agnostic **capability node** — one that accepts a neutral
input shape and internally dispatches to whichever provider the tenant connected — can
decouple it. Exactly one such node exists today: `feature.campaign-channels.nodes.
publish-ad-variants` (ad publishing via the `ctx.ads` adapter, meta/google/tiktok,
PAUSED + dry-run preview). It covers **ad publish only** — not ad metrics, not budget
updates, and nothing for calendar / HRIS / ticketing / ERP. `AdsAdapter` exposes a
single method, `publishAd`.

A review also considered routing marketing's `campaign-launch` through
`publish-ad-variants` now. Rejected: that node lives in the `feature.campaign-channels`
pack, which these templates do **not** depend on — adding it would make a zero-config
preloaded template fail to instantiate on a host without that feature — and its natural
inputs (`platformSets`, `briefId`, `adAccountId`) come from the campaign-brief/kernel
subsystem, a shape the lightweight template does not produce. Forcing it trades a clear
starter template for a broken dependency.

## Decision

1. **Do not ship cosmetic decoupling.** Retyping `connectionRef` to a capability token,
   or swapping in a capability node the template can't satisfy, would either be inert or
   break zero-config instantiation, and would advertise provider-agnosticism the runtime
   does not honor (a dishonest claim, CLAUDE.md RFC-gate spirit). We do neither.
2. **Provider-decoupling of the `openapi-call` chains is the Phase 2b program**, defined
   here as the real path:
   - **Template-friendly capability nodes**, provider-agnostic, with neutral input
     shapes and a safe default (draft/preview when unconnected — the `publish-ad-variants`
     document-handoff pattern): `calendar.list-events` / `calendar.create-event`,
     `hris.create-worker` / `hris.submit-time-off` / `hris.terminate-worker`,
     `ticketing.create-issue` / `ticketing.transition-issue`, `erp.post-bill` /
     `erp.match-po`, and `ads.get-metrics` / `ads.update-budget` (completing the ads
     surface the optimization loop needs).
   - A **capability-dispatch host surface** (the `ctx.ads` pattern generalized) that
     routes a neutral call to the tenant's connected provider of that category, reusing
     Phase 2's `resolveProviderForCapability` as the resolver.
   - **RFC gate:** any of these that surface a new capability on the wire (a new
     `ctx.*` adapter contract other hosts must honor, a new capability advertisement)
     needs an openwop RFC at ≥ Accepted before the host claims it. Ad publishing already
     rides accepted ADR 0166/0167; the new categories likely need one RFC for the
     capability-dispatch contract.
   - **Sequencing:** this is a large program behind real gates (new host surfaces +
     RFC + per-category adapters), correctly sequenced *after* the Phase 1–4 UI work,
     not folded into a pack edit.
3. **Interim posture — honesty over churn.** The chains keep their `openapi-call` nodes.
   Their node names already state the provider (`(Workday)`, `(M365)`, `(Google Ads)`),
   which is honest. Pack descriptions are corrected only where they overstate
   `connectionRef`'s role (it is advisory, not the binding mechanism).

## Consequences

- The user-visible "throwaway workflow" problem is **already** gone (Phase 1); every
  template is reusable with run inputs.
- The "hard-coded vendor" problem has an explicit, honest roadmap (Phase 2b) instead of
  a cosmetic edit that would misrepresent what the runtime does.
- Phase 4 (surfacing the run-input contract in the assign/run UI) is unblocked and
  independent of Phase 2b — it is the next shippable step.

## Implementation (this ADR)

Phase 3 ships this decision record plus the description-honesty pass; no chain graph is
rewired (doing so honestly requires the Phase 2b capability nodes above). Phase 2b is
tracked as its own program.
