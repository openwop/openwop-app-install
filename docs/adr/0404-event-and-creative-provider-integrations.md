# ADR 0404 — Event + creative provider integrations (webinar connector + AI video nodes)

Status: implemented

Decision source: **docs/steward/MYNDHYVE-DECISIONS.md § Decision 6 (a)/(b)** (read + adversarially
verified 2026-07-17) and **docs/steward/MYNDHYVE-GAP-ANALYSIS.md** marketing rows 70/71, deferral
notes 81/82, item 6 at line 102. Both rejections ("no native webinar delivery", "no
native video studio") rest on verified counterpart behavior: HubSpot ships no native
webinar delivery and rides an official Zoom integration for the full marketing-data loop
(registration → attendance → contact-timeline → marketing-events); Canva ships no native
avatar engine and embeds an official HeyGen app, its only native AI video being commodity
text-to-video. Under-evidenced flags carried forward honestly: "webinars beyond HubSpot"
and the final video-provider selection are open questions (§ Open questions).

## Context

MyndHyve's Campaign Studio bundled two conversion-funnel micro-surfaces this app lacks:
webinar hosting and an AI video studio. The gap analysis classifies BOTH as "likely SKIP
native, integrate instead" (rows 81/82). This ADR ports them the way the verified market
leaders build them — **as connectors/provider-nodes, not as native products**:

- **(a) Webinar connector (Zoom first).** No native webinar delivery. Registration rides
  the existing forms/funnels; a provider adapter pushes registrants to Zoom; Zoom
  attendance/engagement webhooks flow back into the CRM contact timeline, segments, and
  campaign-journey enrollment; a lightweight **marketing-event** entity aggregates
  registrant/attendee counts for reporting. The RFC 0095 connection-pack seam stays open
  for Livestorm/StreamYard without a code change.

- **(b) AI video provider nodes (HeyGen-class).** No native video studio. An
  avatar/script→video provider is API-integrated as workflow **nodes** plus a canvas/creative
  affordance ("generate video from script/brief → asset lands in media"). Optionally a raw
  text-to-video node against a frontier video API (Veo/Sora-class). Output is async: submit
  job → webhook/poll → download → `media.createAsset` with provenance.

**Honest capability finding (audited, cited below):** the app today has image generation
(`providers/dispatchImages.ts`, ADR 0115 — OpenAI Images + Google Imagen) and speech
(`dispatchSpeech.ts`), but **zero video generation**. There is no `generateVideo`,
text-to-video, or video dispatch anywhere in `providers/` or `aiProviders/`; the
`generateVideo` action noted in the MyndHyve gap analysis has **no openwop counterpart**.
The `video` occurrences in the codebase are unrelated (content-type detection, the
app-builder `video` UI component, audio/video *transcription*). So (b) is genuinely
net-new dispatch — the closest patterns to copy are `dispatchImages.ts` / `dispatchSpeech.ts`.

## Boundaries audit (file:line)

Every seam these features touch already exists and is owned by another feature. Neither
feature reimplements any of it.

**Connections — owns credentials/OAuth (ADR 0024).**
`features/connections/connectionsService.ts:2-9` — non-secret metadata in the app store,
secret material (API key / refresh token) in the BYOK envelope under `connection:<id>`;
`secretRef()` `:66`, `createSecretConnection()` `:94` (API-key path for HeyGen),
`upsertOAuthConnection()` `:149` (OAuth path for Zoom). Credential kinds
`connections/providerRegistry.ts:13-15` (`oauth2 | api_key | bearer | ...`);
`ProviderManifest` `:23`; `apiHosts` egress allow-list `:50-62`.
**`adapterOnly` governance** — `providerRegistry.ts:68` (flag), set on governed-write
providers `:311`/`:345`; **enforced** at `host/connectionInjection.ts:55`
(`if (!manifest || manifest.adapterOnly) continue;` — the generic `safeFetch` credential
injection SKIPS adapterOnly providers so `http.fetch` cannot bypass the governed write),
test-pinned `test/connection-injection.test.ts:98-108`. **Both new providers are
`adapterOnly`** (Zoom registrant writes; HeyGen job submission).

**RFC 0095 connection packs — the seam (Accepted).**
Host loader `features/connections/connectionPackLoader.ts:206` (`loadConnectionPacks`),
manifest validated against vendored `connection-pack-manifest.schema.json` `:45`,
credential-material blocklist `assertNoCredentialMaterial()` `:109`, `toProviderManifest()`
`:132`; wired at boot `index.ts:407`. Only `kind:"connection"` packs consumed. RFC 0095 is
**Accepted** (RFC 0120 `apiHosts` + RFC 0123 `vendor` extend it, both Accepted). A
Livestorm/StreamYard provider ships as a connection pack, no host change.

**campaign-connectors — sync precedent, but NOT the home for the webinar sync.**
`features/campaign-connectors/syncService.ts` — cooldown CAS `claimSync()` `:103`,
`SYNC_COOLDOWN_MS` `:33`, date-scoped cursor `yesterdayIso()` `:64`, single persist
chokepoint `persistSyncedRows()` `:71`, main loop `runMetricsSync()` `:138`. Adapter is
constructed per-request from the broker — `makeAdsAdapter()` (`host/adsAdapter.ts`),
`routes.ts:59`. **Decision:** the `AdsAdapter` interface is domain-specialized for
ad-performance metrics (`getMetrics`/`listDispatches`, spend/impressions/ROAS, keyed on
`MarketingCampaign`). Webinar events (registration/attendance, not ad spend) do not fit it.
The webinar connector **reuses the sync *pattern*** (cooldown CAS, single-persist
chokepoint, event backfill with cursor) but gets **its own adapter interface + node pack +
feature package**, rather than overloading `AdsAdapter`. This is the No-Parallel-Architecture
rule applied correctly: ride the connections broker + RFC 0095 packs (the true shared
substrate), copy the sync ergonomics, do not shadow the ads adapter. (See § Decision for
why a **new feature package `webinars`** rather than a campaign-connectors extension.)

**crm — timeline activities.** Write seam `features/crm/entities/activities.ts:75`
(`createActivity`, idempotent on deterministic `act:`-prefixed id). SYSTEM-append precedent
to copy: `crm/gmailSyncService.ts:301` `appendGmailActivity()` — deterministic id
`act:gmail:<orgId>:<messageId>:<contactId>`, `getActivity` idempotency check, `createActivity`,
then `crmMutated(...)`. Attendance activities use id `act:webinar:<eventId>:<contactId>:<phase>`.

**campaign-journeys — enrollment.** `features/campaign-journeys/journeyService.ts:93`
`enroll(tenantId, journeyId, contactId, runId?, opts?)` (idempotent CAS, one enrollment per
contact/journey); arbitrated `enrollArbitrated()` `:132`. **There is no trigger-type enum** —
journeys are RFC 0013 chains triggered by host events (`feature.ts:3` "Deliberately NOT a
journey engine"). So "enroll on webinar attendance" is an **event consumer that calls
`enroll()`**, not a new trigger enum. The webinar sync emits `webinar.registered` /
`webinar.attended` / `webinar.no-show` host events that a journey chain subscribes to.

**forms — registration capture.** Public submit
`features/forms/routes.ts:159` (`POST /v1/host/openwop-app/public-forms/:formId/submit`).
Sink seam `features/forms/submissionSinks.ts:45` `registerSubmissionSink()`, run post-persist
fail-soft `runSubmissionSinks()` `:62` (CRM's is `crm/formsSubmissionSink.ts`). The webinar
connector registers a **webinar-registration sink** that, when a form is bound to a webinar
event, pushes the registrant to the provider and creates the CRM contact (or reuses the CRM
sink for the contact and adds only the registrant push). **No new public route** — registration
rides existing public forms/funnels (verified: forms already owns the unauthed submit + honeypot).

**media — video asset storage.** `features/media/mediaService.ts:317` `createAsset(input)`
(`contentType`, `sizeBytes`, `storageRef`, `contentHash?` sha256 ADR 0352, `lineage?`
provenance ADR 0229); `MediaAssetLineage` `:32` (prompt/model/rights). Capacity enforced
BEFORE bytes via `assertOrgCapacity()` `media/mediaStorage.ts:150` (per-org 1000 assets /
256 MiB). Video output attaches provenance via `lineage` and counts against the same caps —
**video is large**, so § Replay/cost covers size handling explicitly.

**providers — model dispatch.** `providers/dispatchImages.ts` (image gen, ADR 0115,
`NATIVE_IMAGE_PROVIDERS=['openai','google']` `:34`, operator escape hatch
`host/imageProviderAdapter.ts`), `dispatchSpeech.ts` (TTS/STT). **No video dispatch exists.**
The AI-video node adds a `dispatchVideo.ts` mirroring these (per-vendor native functions,
plain-Error throws, async-job return, adapter escape hatch). **HeyGen is a VENDOR adapter,
not an LLM provider** — its avatar/script→MP4 job is a governed vendor write + async fetch,
so it lives as an `adapterOnly` connection provider, NOT in the `aiProviders/` LLM catalog.
A raw frontier text-to-video model (Veo/Sora-class) IS a model provider and belongs in
`dispatchVideo.ts` alongside a BYOK catalog entry.

**ADR 0106 — cost metering + caps precedent.** `aiProviders/mediaBudget.ts` — per-org daily
budget, `MediaKind='tts'|'stt'` `:22`, `checkMediaBudget()` `:116` (`{exceeded,cap,used}`,
fail-OPEN on storage error), `recordMediaUsage()` `:138`, default-OFF at budget 0. AI-video
**extends `MediaKind` with `'video'`** and meters per-second-of-output (or per-job), reusing
this exact check/record shape.

**Toggle + pack-pin pattern.** Toggle declared `toggleDefault` on the feature module
(`features/types.ts:51`), registered `features/index.ts:162`. Node-pack "pin in 3 places":
feature `requiredPacks` (e.g. `campaign-connectors/feature.ts:21-23`) → physical
`packs/<name>/pack.json` → test ambient `test/feature-packs.d.ts`. **Flag from audit:** a live
drift exists (campaign-connectors feature pins `1.0.0` while pack.json is `1.2.0`) — the two
new packs MUST keep all three pins in lockstep; a parity test asserts it.

## Decision

### Home for (a): a new `webinars` feature package (NOT a campaign-connectors extension)

campaign-connectors is ad-metrics-specialized (`AdsAdapter`, spend/ROAS). A webinar connector
has a different adapter shape (registrants, attendance, engagement events), a different entity
(marketing-event), and different downstream wiring (timeline + journeys, not campaign metrics).
Overloading campaign-connectors would fragment its `AdsAdapter` contract and its `ads.sync`
node semantics. Per ADR 0001 feature-first packaging and the No-Parallel-Architecture rule, the
webinar connector is a **new `features/webinars/` package** that *reuses* the shared substrate
(connections broker, RFC 0095 packs, forms sinks, CRM activities, journey enroll) and *copies*
the campaign-connectors sync ergonomics (cooldown CAS, single-persist chokepoint) into its own
`webinarSyncService.ts`. It does NOT add code to campaign-connectors.

### (a) Webinar connector design

- **Provider adapter contract** (`features/webinars/host/webinarAdapter.ts`, constructed
  per-request from the connections broker like `makeAdsAdapter`):
  - `registerRegistrant(eventId, contact) → { providerRegistrantId, joinUrl }` — governed
    write to Zoom (`adapterOnly`, brokered egress).
  - `listRegistrants(eventId, cursor?)`, `listAttendance(eventId, cursor?)` — reads.
  - `verifyWebhook(headers, rawBody) → boolean` — HMAC signature verification against the
    per-connection webhook secret (Zoom `x-zm-signature`); a webhook with a bad/absent
    signature is dropped, never processed.
  - `parseEvent(payload) → WebinarEvent` — normalizes to `registered | attended | no-show |
    left-early` with `{eventId, participantEmail, joinTime, leaveTime, durationSec, engagementPct?}`.
- **Two ingestion lanes** (both feed the same normalized `WebinarEvent` pipeline):
  1. **Webhook lane** (real-time) — `POST /v1/host/openwop-app/webinars/webhooks/:connectionId`
     (operator-facing host-ext route, verifies signature, enqueues). Idempotent on
     provider event id.
  2. **Backfill sync lane** (`webinarSyncService.ts`) — cooldown-CAS reconciliation copied from
     campaign-connectors (`claimSync`/`SYNC_COOLDOWN_MS`), cursor per event, catches missed
     webhooks. No historical re-import beyond the event window (honest, like `ads.sync`).
- **marketing-event entity** (`features/webinars/entities/marketingEvent.ts`, KV blob — no SQL
  migration, per the CRM first-class-field precedent): `{ eventId, provider, title, startsAt,
  registrantCount, attendeeCount, noShowCount, formId?, journeyId? }`, aggregated for reporting.
  Counts are derived from the activity stream, not a second source of truth.
- **Downstream wiring** (each idempotent):
  - CRM timeline — `createActivity({ kind:'webinar', activityId:'act:webinar:<eventId>:<contactId>:<phase>', ... })`
    copying `appendGmailActivity`.
  - Segments — attendance activities are queryable by the existing CRM segment engine (no new
    seam; a "attended webinar X" segment is a normal activity filter).
  - Journeys — the pipeline emits host events `webinar.registered` / `webinar.attended` /
    `webinar.no-show`; a journey chain subscribes and calls `enroll()`.
- **Registration** — a form is bound to an event (`form.metadata.webinarEventId`). The webinar
  submission sink (registered via `registerSubmissionSink`) pushes the registrant to the provider
  and ensures the CRM contact. No new public route.

### (b) AI video provider nodes design

- **Video provider adapter** — two placement rules, honestly separated:
  - **HeyGen-class avatar provider** = **vendor adapter**, `adapterOnly` connection provider.
    Contract (`features/creative-video/host/videoProviderAdapter.ts`):
    `submitJob({ script, avatarId, voiceId, brandTokens }) → { jobId }`;
    `pollJob(jobId) → { status, resultUrl?, error? }`; `verifyCallback(headers, body)` for the
    completion webhook. Governed write (job submission spends money) → `adapterOnly` so
    `http.fetch` can't bypass the cost meter.
  - **Frontier text-to-video** (Veo/Sora-class) = **model provider** → `providers/dispatchVideo.ts`
    (mirrors `dispatchImages.ts`), with a BYOK catalog entry and an operator escape hatch
    `host/videoProviderAdapter.ts`.
- **Async job lifecycle** (the node does NOT block on generation):
  1. `video.generate` node validates input (script/brief + avatar + brand tokens), checks the
     ADR 0106 budget, calls `submitJob`, and persists `{ jobId, requestHash }`.
  2. Completion arrives by webhook (preferred) or poll fallback (cooldown-bounded).
  3. On completion the host downloads the MP4, enforces `assertOrgCapacity` (video is large —
     size cap applies BEFORE store), calls `media.createAsset` with
     `lineage: { model, provider, prompt:script, rights }`, and the node output is the **asset
     id** (never the bytes, never a regenerate handle).
- **Canvas/creative affordance** — a "generate video from script/brief" action on the media/creative
  surface that composes the same `video.generate` node through the existing chat/workflow drive
  (no bespoke panel — reuse the ADR 0058 agent+nodes drivability + the shared EmbeddedChatPanel
  pattern; the affordance is a node invocation, not a new AI surface).
- **Cost metering** (ADR 0106) — extend `MediaKind` with `'video'`, meter per output-second (or
  per job for fixed-price providers), `checkMediaBudget` before submit, `recordMediaUsage` on
  completion, default-OFF at budget 0. Video is the most expensive media kind, so the per-org
  daily cap and a per-job second-count ceiling both apply.
- **Provider capability matrix (honest)** — shipped in the connector setup UI and the ADR:

  | Capability | Zoom (webinar) | HeyGen-class (avatar) | Frontier T2V (Veo/Sora-class) |
  |---|---|---|---|
  | Auth | OAuth2 (PKCE) | API key | API key / BYOK |
  | Placement | connection provider (adapterOnly) | connection provider (adapterOnly) | model provider (dispatchVideo) |
  | Sync/ingest | webhook + backfill CAS | job webhook + poll | inline async job |
  | Output | attendance events | MP4 asset | MP4 asset |
  | Cost meter | none (event data) | ADR 0106 `video` | ADR 0106 `video` |
  | v1 status | shipped | shipped | **optional / behind separate sub-toggle** |

## Feature evaluation matrix (10 rows)

1. **Feature-package architecture (ADR 0001).** TWO new packages: `features/webinars/` (a) and
   `features/creative-video/` (b). Neither modifies campaign-connectors, media, crm, or providers
   beyond the sanctioned seams (submission sink, `createActivity`, `createAsset`, a new
   `dispatchVideo.ts` sibling). Rationale for two packages: webinar (marketing events) and video
   (creative media) are distinct domains with distinct toggles, adapters, and downstream owners.

2. **Toggle / admin UI.** TWO toggles (decision: separate, not one — they gate independent vendor
   integrations with independent BYOK/connection setup and independent value):
   - `webinars` — category Marketing, `status:'off'`, `bucketUnit:'tenant'`. Admin: connector setup
     wizard (connect Zoom via connections OAuth), webinar-event dashboard.
   - `creative-video` — category Canvas/Creative, `status:'off'`, `bucketUnit:'tenant'`. Admin:
     provider setup (API key / BYOK), an optional nested `creative-video.t2v` sub-toggle for the
     frontier text-to-video node (kept separable because T2V cost/quality/availability differ and
     the decision marks it "optional").

3. **Workflow + node packs.** TWO new packs, each pinned in 3 places:
   - `packs/feature.webinars.nodes` — `webinar.register` (push a registrant), `webinar.sync`
     (backfill reconcile). adapterOnly consumer of the Zoom provider.
   - `packs/feature.creative-video.nodes` — `video.generate` (avatar script→video), and
     (sub-toggle-gated) `video.text-to-video`. adapterOnly consumer of the video provider.
   - Both bump their pack pin in lockstep across feature `requiredPacks` / `pack.json` /
     `test/feature-packs.d.ts`; a parity test asserts the three agree (closing the drift the audit
     found in campaign-connectors).

4. **AI-chat envelopes (RFC 0021).** **None new.** Chat drives these through the existing tool loop:
   the `video.generate` node is invoked via a workflow the agent composes (ADR 0058 drivability),
   not a new envelope kind. Node/asset schemas are **tool asks** (`openwop:schema.lookup`), never
   envelope kinds — consistent with the CLAUDE.md three-lane rule. No new wire intent shape.

5. **Agent packs.** **None new.** No named agent is introduced (David's law — capabilities at core,
   activated via profile). The nodes are pack-allowlisted tools any suitably-scoped agent can be
   granted; they are NOT added to the ADR 0315 default-on baseline (they are ACTION tools that spend
   money and write to vendors — explicit grant only).

6. **Public surface.** **(a) none for registration** — rides existing public forms/funnels
   (`forms/routes.ts:159`), verified. The ONLY new inbound routes are **operator-facing host-ext
   webhook receivers** under `/v1/host/openwop-app/webinars/webhooks/:connectionId` and
   `/v1/host/openwop-app/creative-video/callbacks/:connectionId` — non-normative host-ext, signature-
   verified, never touch the wire. **(b) none public.**

7. **RBAC / tenant isolation.** Connection setup + toggle admin gated to org admins (same predicate as
   other connectors). Webhook receivers authenticate by connection-id + HMAC signature, resolve the
   owning tenant from the connection, and write ONLY within that tenant. Node tool grants share the
   route's access predicate (the CLAUDE.md tool↔route parity rule). Video assets inherit media's
   per-org capacity + serve-token auth.

8. **Replay / fork safety.** **(a)** Webhook + backfill are idempotent on provider event id; CRM
   activities idempotent on deterministic `act:webinar:*` ids; journey `enroll()` idempotent CAS. A
   replayed run re-reads the same activities, never double-enrolls. **(b) The critical invariant:** an
   async video job's result is **pinned as an asset id in run state** — replay/fork stores and returns
   the existing `media` asset id and **never re-submits the job or regenerates**. `requestHash` guards
   duplicate submits within a run. Cost is metered once, at first completion.

9. **Frontend (i18n ×4).** Connector setup wizards (Zoom OAuth connect, HeyGen key entry); a webinar-
   event dashboard (events list, per-event registrant/attendee/no-show counts, form/journey binding);
   a "generate video from script/brief" creative affordance that composes the node and shows async job
   status → resulting media asset. All strings externalized in the 4 locales (i18n parity is a fatal
   build gate); all through the shared `ui/` design system (no bespoke chat panel).

10. **RFC gate.** **Host-ext — no new wire RFC.** The webinar/video connectors ride **RFC 0095
    connection packs (Accepted)** + RFC 0120 `apiHosts` (Accepted) for egress allow-listing; the
    webhook receivers and the video nodes are host-extension surfaces under
    `/v1/host/openwop-app/*` which never touch the normative wire. No new run-event field, capability
    flag, or event type. If a future need arises to advertise webinar/video as a *protocol* capability
    (it does not for v1), that would require an `openwop` RFC first — out of scope here.

## Phased implementation plan

- **Phase 1 — Zoom register + attendance (a core).** `features/webinars/` package + toggle;
  `webinarAdapter` (Zoom, adapterOnly) via connections OAuth; Zoom connection pack (or built-in
  provider manifest); webhook receiver + signature verify; `webinarSyncService` backfill CAS;
  `marketing-event` entity; CRM `createActivity` on registered/attended/no-show; forms
  registration sink; `feature.webinars.nodes` pack (`webinar.register`, `webinar.sync`). Tests:
  webhook idempotency, signature-reject, CRM activity idempotency, connection-injection adapterOnly.
- **Phase 2 — journeys wiring (a).** Emit `webinar.registered/attended/no-show` host events; a
  journey chain subscribes and calls `enroll()`; segment queries over attendance activities;
  webinar-event dashboard frontend.
- **Phase 3 — AI video provider (b core).** `features/creative-video/` package + toggle;
  `videoProviderAdapter` (HeyGen-class, adapterOnly) via connections API-key; async job lifecycle
  (submit → webhook/poll → download → `createAsset` with lineage); ADR 0106 `MediaKind='video'`
  metering + caps; `feature.creative-video.nodes` pack (`video.generate`); canvas/creative
  affordance frontend. Tests: replay pins asset id (no regenerate), budget cap, capacity cap.
- **Phase 4 — text-to-video (b optional).** `providers/dispatchVideo.ts` for a frontier T2V model
  (Veo/Sora-class) as a BYOK model provider; `video.text-to-video` node behind the
  `creative-video.t2v` sub-toggle; catalog entry. Gated separately because provider availability +
  cost are the open question.

  > **Correction (implementation, ADR 0404 P4).** P4 did NOT add a `providers/dispatchVideo.ts`
  > BYOK model-provider dispatch. That template (mirroring `dispatchImages.ts`) is **synchronous**
  > (prompt→bytes inline); video is inherently the **async job** shape (submit→CAS→poll→SSRF-guarded
  > download→media asset) that P3 already built in `features/creative-video/videoService.ts`. A
  > `dispatchVideo.ts` would have either re-implemented that whole pipeline (the exact parallel path
  > this ADR set out to avoid) or bypassed the load-bearing **`adapterOnly` governed-spend** guarantee
  > — for a per-job-expensive frontier model, an un-bypassable cost meter matters more than the model-
  > provider categorisation in the table above. So T2V **reuses the P3 broker-adapter pipeline** with a
  > second `adapterOnly` connection provider (`runway`, `kind:'api_key'` — the operator's own
  > Runway/Veo/Sora key rides the same connection) and a thin `textToVideo()` verb over one generalized
  > `videoService` (a `kind:'avatar'|'t2v'` discriminant; `requestHashFor` gained `model` so a shared
  > prompt on a different model is a distinct job, never a hash-collision under-charge). The sub-toggle
  > is a new `BackendFeature.extraToggleDefaults` seam, AND-gated with the parent at the route/verb.
  > Net: one video pipeline, one job store, one `video` MediaKind, one SSRF guard — not two.

## Alternatives weighed

- **Native webinar delivery** — REJECTED (decision §6a, adversarially verified: HubSpot, the reference
  mid-market suite, ships none and rides Zoom). Building live-streaming infra is a discrete heavy
  product, not a white-label-core capability.
- **Native video studio / avatar engine** — REJECTED (decision §6b, verified: Canva embeds HeyGen
  rather than building an avatar engine; its only native AI video is commodity text-to-video).
- **Webinar connector as a campaign-connectors extension** — REJECTED. `AdsAdapter` is ad-metrics-
  specialized; overloading it fragments the contract and the `ads.sync` semantics. New package reusing
  the substrate + copying the sync ergonomics is cleaner (§ Decision).
- **Embed provider UI iframe vs API integration** — for (b), Canva embeds the HeyGen *app UI* in an
  iframe. We choose **API integration** (nodes + programmatic job) over an iframe embed because the app
  is workflow-first: a `video.generate` node composes into chains, seeds, and the chat-drive pattern,
  and lands provenance-stamped assets in `media`. An iframe would be an opaque second surface (violates
  the single-chat / no-parallel-surface posture) and can't be metered or replayed. A HeyGen *interactive
  editor* embed could be a later nice-to-have, not v1.
- **Livestorm-first instead of Zoom-first** — REJECTED for v1 (Zoom has the largest install base and the
  best-documented webhook/registrant API; the RFC 0095 pack seam keeps Livestorm/StreamYard a
  no-code-change addition). Honest caveat: the connector call rests on HubSpot + ecosystem guides;
  GoHighLevel/Kit posture not directly verified.
- **One combined toggle** — REJECTED. Independent vendors, independent BYOK/connection setup,
  independent value; separate toggles let an operator enable webinars without video and vice-versa.

## Open questions

- **Zoom App Marketplace review.** A production Zoom OAuth app (registrant write scope + webhook
  subscription) may require Zoom marketplace review/approval. v1 can ship with a BYO Zoom OAuth app
  (operator provides client id/secret via `oauthClientStore`, like other operator OAuth clients) to
  avoid gating on Zoom review; a first-party marketplace listing is a follow-on.
- **Final video-provider selection.** HeyGen is the reference (Canva-verified), but Synthesia/D-ID are
  candidates; the frontier T2V model (Veo/Sora-class) availability + BYOK terms are unsettled — hence
  Phase 4 is optional and sub-toggled.
- **Webinar recording ingestion → KB.** Ingesting the Zoom cloud recording (transcript → knowledge base)
  is a natural follow-on (the app already has audio/video transcription in `notebooks`/`aiProviders`).
  **Deferred** — not v1; noted as a nice-to-have.
- **Engagement-score fidelity.** Zoom's engagement/attention metrics vary by plan tier; the adapter
  reads what the API exposes and stores `engagementPct?` optionally (honest partial).

## RFC verdict

**Host-extension work — no new wire RFC.** Both features ride the Accepted **RFC 0095** connection-pack
seam (+ RFC 0120 `apiHosts`, RFC 0123 `vendor`, both Accepted). Webhook receivers and video nodes are
non-normative `/v1/host/openwop-app/*` host-ext surfaces. No run-event field, capability flag, or event
type is added to the OpenWOP wire. Advertising webinar/video as a protocol capability is explicitly NOT
done in v1; were it ever wanted, an `openwop` RFC would come first.

## Implementation record

All four phases shipped 2026-07-17 (branch `feat/adr-0404-event-creative-providers`). Per-phase
`/architect` → `/code-review` → `/ux-review` with fixes applied, then a 3-lens `/grade-code` +
`/grade-ux` + `/grade-data` pass with same-day remediation.

| Phase | What shipped | Commit |
|---|---|---|
| P1 | Zoom webinar connector — `webinars` pkg (marketing-event entity, deterministic-id CRM activities, attendance-wins reconcile), `zoom-webinar` inbound-observer on the shared webhook seam, `feature.webinars.nodes` (register/sync) | `feat(webinars): … §a / P1` |
| P2 | Journeys wiring + webinar dashboard (counts derived on read, register / bind-form / sync) | `feat(webinars): … §a / P2` |
| P3 | AI avatar video — `creative-video` pkg, `heygen` adapterOnly provider, replay-safe async job (requestHash-CAS submit-once, bounded-poll, SSRF-guarded + size-capped download → media asset), ADR 0106 `video` MediaKind | `feat(creative-video): … §b / P3` |
| P4 | Frontier text-to-video behind the `creative-video.t2v` sub-toggle (`extraToggleDefaults` seam), `runway` adapterOnly provider reusing the P3 pipeline (see the §P4 correction), `video.text-to-video` node, FE mode switch | `feat(creative-video): … §P4` |

**Review + grade remediation (same day):** P3 code-review fixed 2 HIGH (SSRF redirect/rebind via
`guardedEgressFetch`; poisoned-requestHash on pre-submit failure) + 4 MED. P4 code-review fixed 2
ship-blockers (concurrent double-submit → race-free re-claim; stuck-`downloading` on crash → stale
recovery). Grade pass fixed: cross-**org** dedup collision (org in the request hash), a re-charge loop
on a permanently-denied download (terminal-error classification), the missing async **resolve surface**
(`resolveVideoJob` + FE polling), a `onMediaAssetDeleted` cascade (no dangling job→asset ref), the
**video** budget failing open (now fail-closed for the priciest kind), and webinar email normalization
(no false no-show). Open/deferred items + the live-probe + click-through checklists live in
`docs/CODEBASE-ASSESSMENT-adr0404.md`, `docs/DATA-ASSESSMENT-adr0404.md`, `docs/UX-ASSESSMENT-adr0404.md`.

**Not deployed.** Deploy note: a new CSP script hash was not required (no inline-script change); the two
new toggles (`creative-video`, `creative-video.t2v`) + `webinars` ship OFF by default. Operator actions
before enabling: connect Zoom (OAuth + inbound webhook), HeyGen (api key), and — for T2V — a Runway/
frontier key, and set `OPENWOP_T2V_RESULT_HOSTS` / `OPENWOP_VIDEO_RESULT_HOSTS` to the provider's actual
result CDN host(s).
