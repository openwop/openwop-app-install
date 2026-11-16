# ADR 1111 — the marketing launch step and `connectionRef` on `openapi-call` (CC-CHAIN-1)

Status: Accepted (P0–P2 implemented on `fix/cc-chain-1-launch-governed`; P3 deployed retest pending)

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

## Owner decisions (user, 2026-11-14)

- **Q1 — launch via the existing `publish-ad-variants`.** No new `ad-launch` node. The mapping
  turned out not to need a mapping node: the chain's `copy` step became a
  `core.ai.structuredOutput` whose `outputSchema` IS the node's `ad_variants` draft shape
  (`{ platformSets: [{ platform, variants: [{ headline, description, cta }] }] }`). Its `data`
  goes to the review gate as `artifact` (`copy.data → review.artifact`), so the reviewer
  approves the exact draft that is launched, and `launch` takes it FROM THE GATE on the single
  conditioned edge `review.artifact → launch.draft` (`truthy approved`) — the ADR 0582 §11
  pattern, with no unconditional sibling edge. `creative` and `page` stay review-only
  (`publish-ad-variants` publishes copy, not creative). `orgId`, `adAccountId`, `platform` and
  `briefId` reach the node as declared inputs from chain params; the three new params default to
  `""`, so a run with none of them set hands off. A live launch also needs the platform's own
  fields (Meta `pageId`, Google `landingUrl` + `euPoliticalAdvertising`, TikTok `identityId`);
  the chain does not collect them, the node names whichever is missing as a typed failure, and
  they can be set on the step in the builder.
- **Q2 — no connection ⇒ the ADR 0166 document handoff, and the run completes.** This is what
  `publish-ad-variants` already does for no `adAccountId`, `no_connection` and
  `no_developer_token`; no node change.
- **Q3 — change the banner copy; no host-side skip.** `preRunConnsIntro` (en/es/fr/pt-BR) no
  longer says the steps "will skip".

  > **Correction to the Q3 wording, made while implementing.** The approved direction was "say
  > the steps hand off or report not launched, and the run still completes". After P2 the
  > marketing chain has no `connectionRef` at all, so it no longer shows this banner. The chains
  > that still do are the `openapi-call` steps in `people-hr` (`itProvision`, `deprovision`,
  > `calendar`) and `data-ops` (`read`, `upsert`), and those FAIL (now with
  > `openapi_document_missing`), so "the run still completes" would be false for every chain the
  > banner appears on today. The shipped copy says what is true of both behaviours: until you
  > connect, those steps can't do their part — some hand you a draft instead, others stop the
  > run. Those chains need the same treatment as this one (see Follow-ups).

## Implementation plan

| Phase | Change | Test |
|---|---|---|
| P0 | This ADR | — |
| P1 | `openapi-call`: named `openapi_document_missing` when `connectionRef` is set and no document is wired; banner copy per Q3 | node unit test (red on `373d4863a`: `CONFIG_INVALID`); FE copy test |
| P2 | Re-point the launch per Q1/Q2; bump the marketing chain pack version; steward manifest | chain test: unlinked run completes with `launched:false`; linked + `dryRun` produces the PAUSED plan; regression for CC-CHAIN-1 |
| P3 | Deployed retest of `marketing.campaign-launch` in the QA workspace | campaign ledger CC-CHAIN-1 |

## Implementation record

| Phase | Change | Files | Test |
|---|---|---|---|
| P1 | `openapiCall`: `config.connectionRef` set and no `inputs.openapi.paths` ⇒ typed `openapi_document_missing` ("this step needs a wired OpenAPI document (inputs.openapi); the connection … does not provide one"). Without a `connectionRef` the old `CONFIG_INVALID` stays. `core.openwop.http` 2.1.2 → 2.1.3 (schema `$id`s follow; `connectionRef` description says it supplies no document); steward manifest regenerated. | `packs/core.openwop.http/index.mjs`, `pack.json`, `schemas/*.json`, `packs/.steward-manifest.json` | `test/cc-chain-1-openapi-document-missing.test.ts` (red on main: `CONFIG_INVALID`) |
| P1 | Banner copy per Q3 (and its correction above), four locales. No frontend test pinned this string before; none added. | `frontend/react/src/builder/i18n/{en,es,fr,pt-BR}.ts` | — |
| P2 | `marketing.campaign-launch` 1.1.0 → 1.2.0: `copy` → `core.ai.structuredOutput` emitting the `ad_variants` draft; `launch` → `feature.campaign-channels.nodes.publish-ad-variants@1.4.0` fed from the gate; params `adAccountId` / `platform` / `briefId` (default `""`). Pack `core.openwop.workflows.marketing` 1.2.1 → 1.2.2. | `examples/workflow-chain-packs/marketing/pack.json` | `test/cc-chain-1-campaign-launch-governed.test.ts` (red on main): unlinked approve ⇒ `launch` completes with a DRAFT `campaign-ad-copy` document holding the approved copy and never calls `ctx.ads`; account set + `no_connection` ⇒ the params reach `publishAd`, then the handoff; reject ⇒ `launch` skipped, run completes |
| P2 | Ratchet + existing-test upkeep: `publish-ad-variants` added to the ADR 0582 reject witness's effect set (so `launch` stays witnessed); the marketing mini-scheduler test's fake answers the structured `copy` call with `data` and expects `artifact` on the gate. | `test/workflow-chain-effect-reject-witness.test.ts`, `test/workflow-chain-marketing-execution.test.ts` | those files |
| P3 | Deployed retest of `marketing.campaign-launch` in the QA workspace. Needs the registry publish of `core.openwop.http@2.1.3` and `core.openwop.workflows.marketing@1.2.2` (DEPLOY.md "Vendoring a pack is NOT shipping it"). | — | campaign ledger CC-CHAIN-1 |

## Follow-ups (not in this change)

- `people-hr` (`itProvision`, `deprovision`, `calendar`) and `data-ops` (`read`, `upsert`) are the
  same defect: `openapi-call` + `connectionRef` with no wired document. They now fail by name,
  but they cannot succeed even after connecting. Each needs a re-point like this one (or a wired
  document param for `data-ops`, whose operation is already a param).
- `marketing.campaign-launch` lost its builder Connect chip with its `connectionRef`. A
  `x-usesConnections: true` on `publish-ad-variants` (a `feature.campaign-channels.nodes` bump)
  would at least report `connectionUsage: 'uses'` in the pre-flight.
