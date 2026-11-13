# ADR 1111 — the marketing launch step and `connectionRef` on `openapi-call` (CC-CHAIN-1)

Status: Proposed

## Context

Observed live on app.openwop.dev (build `373d4863a`, 2026-11-11 23:22–23:23Z, Campaign
Studio acceptance campaign, issue CC-CHAIN-1). The `marketing.campaign-launch` chain
(`examples/workflow-chain-packs/marketing/pack.json`) ran audience → page → copy →
creative → review; the operator approved the consolidated review after checking the
content against the brief, and the last step failed:

- `launch` is `core.openwop.http.openapi-call@1.0.0` with
  `config: { connectionRef: "core.openwop.connections.google-ads", operationId: "createCampaign" }`
  and `inputs: {}`.
- `packs/core.openwop.http/index.mjs` `openapiCall` reads only `ctx.inputs.openapi`. It never
  reads `config.connectionRef`, so it throws `CONFIG_INVALID: openapi doc missing paths`
  every time, connected or not.
- Before the run, the builder's pre-flight banner said: "This workflow names connections you
  haven't linked yet — those steps will skip until you connect"
  (`frontend/react/src/builder/i18n/en.ts` `preRunConnsIntro`). Nothing in the executor or the
  node implements a skip.

So the chain promises three things it does not do: that it can launch on Google Ads, that an
unlinked step skips, and that linking a connection is what makes the step work.

What exists today (measured on `373d4863a`):

- No connection pack or provider manifest supplies an OpenAPI document. There is no
  `packs/core.openwop.connections.*` directory; ad platforms are built-in providers reached
  only through the governed ads egress (`host/adsAdapter.ts`, `ctx.ads.*`: brokered OAuth,
  host-pinned URLs, created PAUSED, spend governance; ADR 0167/0223/0952).
- ADR 0186 slice 4a already replaced this same pack's hard-coded google-ads
  `getCampaignMetrics` openapi-call with the provider-agnostic, fail-safe
  `core.openwop.connectors.ad-metrics` node. The launch step was left behind.
- The governed publish already exists as `feature.campaign-channels.nodes.publish-ad-variants`
  (PAUSED create via `ctx.ads.publishAd`; no account or connection ⇒ the ADR 0166 document
  handoff; spend-threshold approval ⇒ suspend).

## Decision (proposed)

1. **Do not make `openapi-call` resolve a document from a connection.** Doing so needs a
   connection manifest to carry an API description and the credential to be injected on a
   generic call. That is an RFC 0095 connection-pack change (wire) and a second credential path
   beside the broker, which ADR 0167 forbids. If it is ever wanted, it starts as an RFC in
   `../openwop`. This host does not advertise it.
2. **Re-point `marketing.campaign-launch`'s launch to the governed ads step**, following the
   ADR 0186 slice 4a precedent: a launch node that goes through `ctx.ads` (PAUSED, brokered,
   spend-governed) and is honest when there is no connection. That is either
   `publish-ad-variants`, if the chain's copy/creative outputs are mapped to its `ad_variants`
   draft shape, or a small `core.openwop.connectors.ad-launch` capability node beside
   `ad-metrics`. Q1 below picks between them.
3. **No connection ⇒ an honest, visible outcome, never a throw on a missing document.** The
   launch step reports `{ launched: false, reason: 'no_connection' }` (or hands off to a document,
   if Q2 says so) and the run completes, so the approved content is not lost.
4. **The banner tells the truth about the result.** Either the copy says what the chain's
   connection-bound steps actually do when unlinked ("…will not launch until you connect; the
   run still completes"), or a host-side skip is implemented for `connectionRef` nodes. That
   skip would have to be recorded in the event log so replay serves it (a live connection
   lookup is not replay-stable), so this ADR prefers the copy change plus decision 3.
5. Until 2–4 ship, a run of this chain fails at `launch` with `CONFIG_INVALID`. That is a
   typed failure, so it is not hidden, but the message does not name the cause. The follow-up
   PR also makes `openapi-call` fail with a named code
   (`openapi_document_missing`, "this step needs an API description; a connection does not
   provide one") when `connectionRef` is set and no document is wired.

## Alternatives weighed

- **A host-side skip for every node with `config.connectionRef`** (executor checks the acting
  user's connections before the node runs). It matches the banner today, but it adds a
  non-replay-stable decision to the shared executor, and it would still fail after the person
  connects, because the node still has no document. Rejected as the primary fix.
- **Bundle a Google Ads OpenAPI document in the chain.** Generic `bareFetch` with no credential
  injection cannot authenticate, would bypass PAUSED-create and spend governance, and would
  hard-code one platform. Rejected.

## Open questions (user / owner decisions)

- **Q1.** Launch via `publish-ad-variants` (reuse; needs an output→`ad_variants` mapping node) or
  a new `core.openwop.connectors.ad-launch` capability node (cleaner contract, new node pack
  surface)?
- **Q2.** With no connection: complete with `launched:false`, or fall back to the ADR 0166
  document handoff as `publish-ad-variants` does today?
- **Q3.** Banner: change the copy (preferred), or build the recorded host skip?

## Implementation plan

| Phase | Change | Test |
|---|---|---|
| P0 | This ADR | — |
| P1 | `openapi-call`: named `openapi_document_missing` when `connectionRef` is set and no document is wired; banner copy per Q3 | node unit test (red on `373d4863a`: `CONFIG_INVALID`); FE copy test |
| P2 | Re-point the launch per Q1/Q2; bump the marketing chain pack version; steward manifest | chain test: unlinked run completes with `launched:false`; linked + `dryRun` produces the PAUSED plan; regression for CC-CHAIN-1 |
| P3 | Deployed retest of `marketing.campaign-launch` in the QA workspace | campaign ledger CC-CHAIN-1 |
