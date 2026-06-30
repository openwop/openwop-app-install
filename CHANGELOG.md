# Changelog

All notable changes to **openwop-app** are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/); the project follows
[Semantic Versioning](https://semver.org/) per **ADR 0052**. Pre-1.0 caveat: while
on `0.x`, a `0.MINOR` bump MAY carry breaking changes (SemVer §4).

What bumps which part (ADR 0052 §D1): **MAJOR** = a breaking change to a
customer-facing contract (route/config/env removal or rename, dropped capability,
a migration unsafe for the prior binary); **MINOR** = additive & backward-compatible
(new feature/route/capability, **any** forward-only schema or app migration);
**PATCH** = a fix with no contract or migration change.

The operator upgrade contract lives in **`DEPLOY.md` § "Upgrading"**. Each released
section below — and its **"Upgrading from"** block — is generated from Conventional
Commits by the `/cut-app-release` skill; required upgrade stops are tracked in
**`RELEASES.md`** / `releases.json` (ADR 0052 §D2/§D7).

## [Unreleased]

## [0.1.0] — 2026-06-30

Inaugural versioned white-label release (ADR 0052) — replaces the rolling `whitelabel`
tag with an immutable `v0.1.0` + a moving `latest` alias. Captures the pre-1.0 app:
the OpenWOP workflow-engine backend + React SPA, the feature-package suite (CRM, CMS,
KB, Campaign Studio, publishing, notifications, RBAC/orgs, connections/BYOK), the
runtime white-label brand + generative theming (ADR 0170/0171), and the real-time
voice + ads-dispatch host arms. Fresh install — no prior version to upgrade from.

### Fixed
- **Campaign Strategist prompt — honest ad-dispatch guidance (ADR 0167).** The Strategist's
  instructions still said "there is no live ad/social posting in-app yet… nothing is posted to a
  platform" — stale after the ADR 0167 Phases 1–3 made Meta/Google/TikTok dispatch real. Corrected:
  the agent now distinguishes a **real PAUSED ad campaign** (when an ad account + platform connection
  are configured) from a **document handoff**, always tells the human which happened, and gets an
  explicit go-ahead before any real dispatch (campaigns are created PAUSED — they never auto-spend).
  Added an "Operator setup — enabling real dispatch" section to ADR 0167 (per-platform connection,
  the Google `OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN`, the test-only API-base overrides, the PAUSED-safety).

### Added
- **Customizable token-based theming (ADR 0171, extends ADR 0170).** The Appearance editor is now
  **generative**, not preset-picking: a super-admin sets a brand color (+ optional background tint,
  contrast level, corner radius, fonts) and the host deterministically generates the full **light + dark**
  design-token set — the accent kept exact for fidelity, on-colors **solved for WCAG-AA**, and the stock
  theme reproduced byte-identically so unedited installs never shift. Built on a dependency-free OKLCH
  engine (`src/brand/theme/`); the inputs persist in `Brand.identity.theme` (replay-safe) and apply at
  runtime via the ADR 0170 `:root` injection (generator lazy-loaded; pre-paint reads cached tokens → no
  flash). The rebuilt editor adds a sticky live light/dark preview (with the real logo), a **ContrastChecker**
  (WCAG ratio + APCA advisory), an **advanced per-token JSON override** tier (allowlisted tokens only,
  server-sanitized), and named seed-set starters. Host-extension — no new wire, no RFC. (#1019)
- **Runtime white-label brand identity (ADR 0170 — `brand` graduates to core).** ONE `brand` feature now
  owns both the app's own white-label identity AND tenant marketing brands (the CMS-owns-homepage pattern).
  A super-admin sets the app logo, colors, fonts, instance name, favicon, title, and default theme at
  **runtime** via an Admin **Appearance** panel — a reserved `brand:host-app` brand served pre-auth on
  `/v1/host/openwop-app/public-brand`, applied by injecting `:root` CSS vars (no rebuild). Supersedes the
  build-time `VITE_BRAND_*` baking (now the boot seed). All identity values are CSS-grammar-sanitized
  host-side; asset URLs scheme-validated. Host-extension — no new RFC. (#1016)
- **Campaign Studio: real outbound TikTok Ads dispatch (ADR 0167 Phase 3 — completes Meta/Google/TikTok).**
  A `tiktokStrategy` creates the campaign→adgroup→ad pipeline (all **DISABLE**/paused) against the hardcoded
  `business-api.tiktok.com/open_api/v1.3`, authenticating with a **raw `Access-Token` header** (not
  `Authorization: Bearer`) and the public `advertiser_id` in the request body. To support this the broker gained
  `authScheme:'raw'` + a `brokeredPost` `authHeaderName` option (the broker writes its secret under the named
  header; the `extraHeaders` strip now protects whatever that header is named — a caller can't override the
  broker's `Access-Token`). Adds a new RFC 0095 `tiktok-ads` connection pack. Fork-stable idempotent; no rollback
  (DISABLE objects don't spend). Also hardened the publish node's platform routing to an explicit allow-set (a
  bad `platform` input can no longer silently dispatch to the wrong platform). Rides Accepted RFC 0045/0046/0047/0079.
- **Campaign Studio: real outbound Google Ads dispatch (ADR 0167 Phase 2).** `host/adsAdapter.ts` is
  refactored to a `PlatformStrategy` (shared idempotency/provenance spine + Meta + a new Google strategy);
  `publish-ad-variants` gains a `platform` input (`meta` default). Google creates the budget→campaign→adGroup→ad
  `:mutate` pipeline (all **PAUSED**) against the hardcoded `googleads.googleapis.com/v18`, with the per-user
  OAuth Bearer token (broker-resolved) **and** the app-level `developer-token` — the latter as **operator host-side
  config** (`OPENWOP_GOOGLE_ADS_DEVELOPER_TOKEN`, not a Connection secret), carried by a new additive
  `brokeredPost` `extraHeaders` param that **case-insensitively strips any `authorization` override** (the broker
  stays the sole credential authority — existing slack/email/sms/Meta callers unaffected). Fork-stable idempotent
  on the `google` key; fails closed if the developer-token is unset (and the node then degrades to the ADR 0166
  document handoff). Also fixes a Phase-1 bug (a reused record reported `platform:'meta'` instead of its own).
  (Phase 3, TikTok, to follow.)
- **Campaign Studio: real outbound Meta ad dispatch (ADR 0167 Phase 1).** A new `host/adsAdapter.ts`
  (`ctx.ads.publishAd`, the slack/sms/email adapter pattern) turns an approved `ad_variants` draft into a
  real **PAUSED** Meta campaign→adset→ad through the Connections broker — composing `brokeredPost` (OAuth
  token host-resolved, never on the wire), **created-PAUSED** (no auto-spend), **hardcoded `graph.facebook.com`
  host** (never input-derived), an **adapter-owned fork-stable idempotency map** (keyed on
  `tenant:briefId:platform:adHash`, NOT runId → a `:fork` reuses the recorded platform ids, no duplicate paid
  campaign), explicit RFC 0079 `stampConnectionUse`, and best-effort PAUSED-safe cleanup on partial failure.
  `publish-ad-variants` dispatches when an `adAccountId` is targeted + a Meta connection exists; otherwise it
  falls back to the ADR 0166 document handoff. Rides the already-Accepted RFC 0045/0046/0047/0079 — **no new
  wire, no new RFC.** (Phases 2–3, Google/TikTok, to follow.)
- **Campaign Studio publish: ad / creative / social → document handoffs (ADR 0166).** Completes the
  five-channel publish path. Three `role:"action"` nodes in `feature.campaign-channels.nodes` —
  **`publish-ad-variants`**, **`publish-creative-briefs`**, **`publish-social-posts`** — map a draft to
  Markdown and write it as a **draft `documents` document** (ad-copy / creative-briefs / social-calendar)
  via a new `ctx.features.documents.createDraftDocument` (content-guarded + the deterministic
  `createDocument` short-circuit + idempotency-keyed `addVersion`, all in one owned method). These three
  channels have **no first-party platform target in-app** (a MyndHyve evaluation confirmed real outbound
  ad dispatch is a large, RFC-gated effort; organic social posting exists nowhere), so the honest target
  is a reviewable, exportable handoff packet — **nothing is dispatched to a platform**. Tenant-isolated,
  replay-idempotent (deterministic `runId:nodeId` ids), wired into the Campaign Strategist allowlist.
- **Campaign Studio publish last-mile (ADR 0162).** Generated channel drafts now become real
  entities: two `role:"action"` nodes in `feature.campaign-channels.nodes` —
  **`publish-landing-page`** (a landing_page draft → a **draft** CMS page via a new
  `ctx.features.cms.createDraftPage`) and **`publish-email-sequence`** (an email_sequence draft →
  one **draft** email template + campaign **per step** via a new `ctx.features.email.createDraftCampaign`).
  Both delegate to the existing cms/email services (single source of truth), are draft/unsent-only
  (a human gates publish/send), tenant-isolated (tenant from the run scope), and replay-idempotent
  (deterministic `runId:nodeId` ids — `createTemplate`/`createCampaign` gained optional id
  short-circuits). Wired into the Campaign Strategist tool-allowlist (ADR 0058). No new UI, no new wire.
- **Connection packs: Google Ads, Meta Ads, Oracle NetSuite (RFC 0095).** Three new
  `examples/connection-packs/` provider definitions loaded by the existing `connectionPackLoader`:
  **Google Ads** + **Meta Ads** (`marketing`) and **Oracle NetSuite** (`finance`, per-account
  `instanceUrlTemplate`) — each an OAuth2 `reach:openapi` provider carrying no secret, mirroring the
  shipped `workday`/`salesforce` packs. They fit the existing RFC 0095 manifest (no spec amendment)
  and become resolvable providers operators can connect. (ADR 0149.)
- **ADR 0149 — Real-Work Workflow Library (decision record).** Catalogs 20 real-work corporate
  workflows (exec/CoS, marketing/ads, people, finance, sales/CS, IT) and records that their correct,
  protocol-aligned home is a **workflow(-chain) pack** loaded like node/agent/connection packs
  (`schemas/workflow-chain-pack-manifest.schema.json`, RFC 0013) — a loader this host does **not** yet
  implement. An initial implementation that introduced a parallel pinned `lib.*` catalog + a bespoke
  discovery route was **reverted** as an architecture deviation (the established homes —
  `workflowTemplates.ts` and the builder registry — and a future workflow-pack loader are the right
  locations). Net code landed: the three connection packs above; the workflow-pack loader is tracked
  as the next architecture step.
- **Real-time voice host arm (ADR 0109, RFC 0106).** The reference-host arm for the OpenWOP real-time voice profile (RFC 0106, `Active`): `ctx.callTranscriber` (streaming STT — a deterministic stub + real finite-audio transcription via the managed multimodal `callAI` audio path on a host media-asset url, the `streamRef → mediaRef` finalize seam; a live `streamRef` is an honest `transcription_unsupported` because live media transport is host-internal per RFC 0106 §E), the streaming arm of `ctx.callSpeechSynthesizer({stream:true})` (emits `voice.synthesis_chunk` metadata-only run-events), and the `voice.barge_in → voice.cancelled` lifecycle (no partial leak, §F). Advertises the full `aiProviders.realtimeVoice` surface (`transcription`/`synthesis`: `"streaming"`, `turnDetection: "semantic"`, `bargeIn: "supported"`), derived from what's wired (advertise+accept-in-lockstep). **Always-on host plumbing — no toggle**; the chat's voice UX is the pre-existing `ChatInput` MediaRecorder mic (RFC 0091 implicit transcription), so no duplicate mic was built. Host work riding RFC 0106 — no new RFC. (#683, #689, #691, #693, #694)
- **Tool-output compaction (ADR 0099).** A toggle-gated platform feature (`tool-output-compaction`,
  OFF by default, tenant-bucketed) that compacts verbose JSON tool outputs at the typed tool-result
  boundary before they re-enter the model context — cutting BYOK token spend. Structure-preserving by
  default (minify + drop empty fields); opt-in per-agent lossy array-elision and per-tool exemptions
  via `agentProfile.configParameters.compaction`. The decision is frozen per-run in `run.metadata` and
  read verbatim on replay/`:fork` (deterministic); fail-open (a disabled/erroring path never breaks a
  run). Also exposes an explicit `ctx.features['tool-output-compaction'].compact` workflow surface +
  `feature.tool-output-compaction.nodes.compact` node. Savings are reported as observability telemetry
  (no parallel counter store). Host-internal — no wire change, no new RFC.
- **Strategy create-form templates (ADR 0080 Phase E).** Four presets — OKR, annual operating
  plan, portfolio bet, and working-backwards — offered as a "Start from" picker in the New Strategy
  modal. A template is a pure client preset (i18n-keyed objective/key-result/initiative scaffolds +
  horizon defaults) that **pre-fills** the existing create flow; the backend re-validates everything
  (a template is a suggestion, never an authority). No new entity, store, or schema. en +
  native-reviewed pt-BR. (Completes ADR 0080 — marked `implemented`.)
- **Strategy Analyst agent pack `feature.strategy.agents` (ADR 0080 Phase C).** A manifest agent
  (RESEARCH persona, research model class) that **audits alignment gaps** across the strategy
  portfolio (reasoning over `get-health`'s signals + `get-strategy`) and **drafts board-ready memos**
  — tool-allowlisted to the five `feature.strategy.nodes` only. Chat-drivable through the existing
  AI chat (ADR 0058 — no bespoke panel; deep-link the agent). It **recommends and drafts; the human
  authors strategy** — the agent has **no strategy-mutation tool** (its only write is a board-memo
  Document), preserving the read-only-strategy invariant, and its prompt forbids fabricating strategy
  facts. Rides RFC 0003 + ADR 0058; **no new RFC**.
- **Strategy node pack `feature.strategy.nodes` + `board-update` document kind (ADR 0080 Phase B).**
  A signed node pack over the read-only `ctx.features.strategy` surface — `list-strategies`,
  `get-strategy`, `get-context`, `get-health` (the new 4th read surface method) — plus a
  `create-board-memo` **write** node that persists an agent-authored memo as a Document of the new
  open-vocabulary `board-update` kind (`ctx.features.documents`), degrading to inline markdown when
  `documents` is OFF. The strategy surface stays **read-only**: the memo write lands in Documents,
  never in Strategy. All nodes are `role:action` (replay-safe recorded output; the memo
  `addVersion` is idempotency-keyed). Host-extension, **no new RFC** (rides RFC 0076).
- **Strategy health rollup (ADR 0080 Phase A).** A live, RBAC-bounded health signal
  (`on-track`/`at-risk`/`off-track`) rolled up per strategy from its linked execution — project
  charter health + milestone completion % + linked priority ideas — surfaced as a chip on the
  Strategy Portfolio and exposed via `GET /v1/host/openwop-app/strategy/health`. The verdict is a
  **computed projection** (never stored — same live-resolve discipline as the context packet), and
  it carries the component `signals` verbatim so the *why* is honest (no invented precision). Rides
  the existing `strategy` toggle; host-extension, **no new RFC**.
- **Strategy (Strategic Planning) — backend feature-package (ADR 0079, Phase 1).** A toggle-gated
  (`strategy`, OFF, `tenant`, "Business Tools") executive **strategy portfolio**: narrative
  rationale + OKR-compatible objectives/key-results + initiatives + planning horizon
  (quarter/half-year/annual/multi-year/custom) + owner/accountable-exec + status/confidence/risk,
  with **canonical alignment links** out to projects, Priority Matrix lists/ideas, advisory boards,
  and documents. Host-extension under `/v1/host/openwop-app/strategy/*` (CRUD · `PUT /:id/links` ·
  `GET /context`); **no new RFC**. Scope is a visibility modifier (`user`/`workspace`/`org`) over a
  mandatory owning `orgId` (ADR 0079 §Correction): fail-closed RBAC, tenant/org IDOR (uniform 404),
  cross-entity link read-gate (403 on an unreadable target; context silently omits it), soft-archive
  on delete (hard-delete only user-scoped drafts). Links are read **back** into consumer surfaces —
  no denormalized `strategyIds[]`, no `Project.charter` overload, not a reuse of `goals`.
  **Phase 2 (frontend):** a `/strategy` "Strategy" workspace page (nav-gated on the toggle) — a
  Portfolio of strategy cards (filter by scope/status/horizon; status/risk/confidence chips) + a
  per-strategy detail editor (Overview · Objectives/key-results · Initiatives · Alignment link
  picker), composing the shared `ui/` cohesion layer; en + native-reviewed pt-BR catalogs.
  **Phase 3 (Priority Matrix alignment):** a ranked idea row shows the strategies it's aligned to
  (chips) + an "Align to strategy" control, via a strategy-OWNED embeddable component the Priority
  Matrix page renders — composed entirely over the existing `GET /strategy/context` +
  `PUT /strategy/:id/links`, **no priority-matrix backend coupling** (avoids a feature import cycle,
  ADR 0079 §Correction).
  **Phase 4 (Projects alignment):** the Project Overview tab shows the strategies a project is
  aligned to (chips, via the existing context endpoint, toggle-gated), and the strategy Alignment tab
  shows each linked project's status/health — both FE-composition, no projects backend coupling.
  **Phase 5 (Board of Advisors context):** a board carries selected strategies as `contextRefs`
  (validated readable by the author, RBAC'd); a board context-preview endpoint
  (`GET /advisors/boards/:id/strategy-context`) powers a setup picker + preview. At `@@` summon, the
  board's strategy context is resolved (RBAC-filtered for the convener) and **snapshotted onto the
  boardroom conversation**, then injected into each advisor's system prompt — via a new **core
  board-context resolver seam** (`host/boardContextResolver.ts`, the ADR 0075 resolver-registry
  pattern) so core never imports a feature, and `composeAgentSystemPrompt` gains an optional
  `strategyContext` block.
  **Phase 6 (workflow surface):** a read-only `ctx.features.strategy` (`list`/`get`/`context`),
  auto-advertised at `/.well-known/openwop`. A run is tenant-trusted (no caller subject), so the
  surface exposes **shared** strategies only — `user`-scoped private drafts are excluded (no leak
  to a subjectless run). ADR 0079 marked `implemented` (Phases 1–6); node/agent packs deferred.

### Fixed
- **Accessibility & i18n polish across Strategy and Chat (`/grade-ux` — `STRAT-1..6`, `CHAT-10/11/14`).**
  Strategy: a confirm guard before the irreversible delete/archive, an `<h2>` entity heading in the
  detail view, key-result rows grouped as a labelled `role="group"`, modal headings `<h3>`→`<h2>`, the
  template-applied hint as an `aria-live` status, and static `flex` inline styles → utility classes.
  Chat: `StepList` rows announce their state to screen readers (with a dedicated `stepStatusPending`
  label distinct from the run-level "Starting…"), the `WorkflowProgressPanel` empty state uses the
  shared `<StateCard>`, and the two async streaming-error strings are i18n-keyed. Also **defines the
  previously-undefined `.sr-only`/`.visually-hidden` utility** — it was referenced by `Modal` +
  `ReviewCard` but a no-op, so those labels were painting visible (latent a11y bug, now fixed). All
  new strings en + pt-BR + fr.
- **Strategy context resolution memoizes its priority-list reads per call (ADR 0080 follow-on, perf).**
  `resolveStrategyContext` now reads + ranks each linked priority list at most once per resolve
  instead of once per priority-idea link — a portfolio-wide read like `GET /strategy/health` no longer
  re-ranks the same list repeatedly. Behaviour is identical (transparent optimization); a call-count
  regression test locks it in. Surfaced by a post-merge `/architect` review of the full Strategy feature.
- **Strategy context no longer leaks `private` projects to non-member org readers (ADR 0054).** The
  context packet's linked-project enrichment now gates on the project's own `resolveProjectAccess`
  (member-scoped visibility) instead of plain org-read, so a `private` project linked to a
  workspace-visible strategy is omitted for a read-only org member who isn't a project member.
- **Strategy link/owner identifiers are no longer secret-scrubbed.** `StrategyLink` target ids
  (card/list/project/board/document), `ownerUserId`, and `linkedProjectIds` are opaque references,
  not free text — they now validate through a non-scrubbing bounded check (`reqId`/`optId`) instead
  of `cleanString`, which would redact a uuid-shaped id (e.g. a `host.kanban` card id) to
  `[REDACTED:secret-shaped]` and silently break the link. Free-text fields (title/summary/rationale)
  keep secret-scrubbing.
- **Advisor chat — attribution, roster sidebar, and a live "thinking" indicator.** A reply
  from a named agent now carries a sender header (avatar + name, persona tagline beneath), so a
  council turn is never an unattributed blob — the identity rides the wire (`agent.agentId`),
  resolved to the `@handle` + tagline. The chat "in this conversation" rail goes from a
  radio-button list to a roster of people (avatar-anchored, name as the hero, active voice on the
  clay avatar ring). While the synchronous conversation `exchange` runs, an optimistic
  attributed "thinking" bubble shows in the feed and the addressed advisor's rail row pulses with
  a live "Thinking…" line (`thinkingAgentId`), instead of a frozen UI. Frontend-only; the
  attribution data was already on the message. A2UI is not involved (it renders agent-authored
  interactive forms, not attribution/progress).
- **Live cross-surface review-status sync (ADR 0074).** A decision on any human-review
  surface — the chat Reviews tab, the in-chat approval card, the Runs screen, or the inbox —
  now updates every other surface in real time, cross-client, instead of leaving stale
  still-approvable copies. The decision owners (`resolveAndResume`, `claimApproval`/
  `rejectApproval`) broadcast a non-persisted `review.updated` cache hint over the existing
  tenant-scoped notifications SSE stream (the emitter's new `signal()` path — never an inbox
  row, no second connection); a shared client `reviewStatusStore` (single source of truth)
  patches/evicts the affected review and drives every surface + the pending-count badge.
  Host-internal, no RFC (reuses the `node.interrupt.resolved` event; adds no wire surface).
- **CMS content localization — real localized delivery + Phase-3 workflow surface (ADR 0064 / RFC 0103).**
  `GET /v1/content/pages/{slug}` now negotiates over the **host-advertised** content set
  (`OPENWOP_I18N_LOCALES` / `capabilities.content`) instead of the system-site's empty per-org
  settings, so a supported locale returns an honest `Content-Language`; the seeded system-site
  home (`SEED_VERSION` 5) carries es + pt-BR overlays for real translated delivery, and a
  supported-but-unauthored locale falls back to base per-section. Adds the `ctx.features.cms`
  read surface (`listPages` + locale-resolved `getPage`), the `feature.cms.nodes` pack (`get-page`
  + `translate-section`), and the `feature.cms.agents.localizer` agent (tool-allowlisted to those
  nodes — the chat-drivable path; no separate envelope seam). Host-internal, no RFC (rides
  Accepted RFC 0103). En route this also **fixes a latent surface-gate bug** (ADR 0014
  correction): always-on features (no toggle — `cms`, `assistant`, `agent-knowledge`) had their
  `ctx.features.<id>` workflow surface refused on every call (`host_capability_disabled`), so the
  shipped `feature.{assistant,agent-knowledge}.nodes` packs were dead through the real runtime
  path. The gate now treats a feature with no toggle default as always-on substrate.
- **Priority Matrix federation — fan-out cache (ADR 0061 #3).** `GET /portfolio/federated`
  now fetches each peer through a process-local **single-flight + short-TTL (30s default,
  `OPENWOP_PM_FED_CACHE_TTL_MS`) + bounded + jittered** cache, cutting duplicate outbound peer
  calls at scale. Correctness over speed: because a peer's slice depends on the resolved
  credential (ADR 0062 per-user bearers), the cache key carries the **credential identity**
  (`resolvePeerCredential` reports `u:<userId>` / `shared` / `env` / `none`) so a per-user
  slice is never served to another caller. Only successful fetches are cached; failures stay
  fail-soft. Host-internal, no RFC.
- **Priority Matrix — weighted voters (ADR 0059).** A multi-voter list can give a stakeholder's
  vote more pull via an optional `voterWeights` map on `PriorityList` (voterId → integer 1..10;
  absent/uniform = equal weight, exactly as before). When weights differ, `aggregateVotes` uses
  the **weighted arithmetic mean** (`mean` mode) or a **lower weighted median** (`median` mode) —
  weights are never silently dropped. Config-authority-gated (list creator or `host:org:manage`),
  validated (1..10, capped), and re-ranked on a live read (no recompute / run-stamp; replay
  unaffected). FE: a per-voter weight selector in the owner/admin vote-breakdown Modal.
  Host-internal, no RFC. Follows the Limited Weighted Votes (LWV) governance pattern.
- **Priority Matrix federation — enterprise credentials + per-user authorization (ADR 0062).**
  Peer bearers move from the deploy-time env token to the **BYOK envelope** (`secretResolver`,
  KMS-sealed/rotatable), keyed per-`(peer)` and per-`(peer,user)`. `resolvePeerToken` resolves
  per-user → tenant-shared → env (deprecated). The **per-user** credential makes a peer
  authorize on the caller's own token, so its slice is filtered to their access — **closing the
  read-authorization asymmetry** (ADR 0061). `PUT /priority-matrix/peers/:id/credential` (tenant
  scope = superadmin; user scope = self) + a per-peer FE credential form. Host-internal, no RFC;
  cross-host SSO/OBO delegation (RFC 8693) is escalated to a tracked openwop RFC.

### Fixed
- **Chatting with a reasoning advisor no longer fails with `request_timeout`.** The synchronous
  conversation `exchange` generates the reply in-request, and a reasoning model legitimately
  exceeds the global 30s server backstop (especially mid-council). The interrupt-resolve routes
  now get a longer budget (`OPENWOP_LLM_REQUEST_TIMEOUT_MS`, default 120s); every other route
  keeps the tight 30s.
- **Chatting with an `@agent` no longer fails the first message with `interrupt_not_found`.**
  `POST /v1/runs` dispatches in the background and returns before the conversation gate suspends,
  so the immediate `exchange` raced the suspend; the client now waits for the gate to open
  before sending the first turn.
- **Button icons align with their labels and primary buttons drop the inverted-ink slab.** The
  shared `button` rule is now a flex container (icon centers on the text) and fills the brand
  clay (`--clay-strong`) instead of `--ink`, which rendered as a harsh near-white-on-dark /
  near-black-on-cream block.
- **Chat composer placeholder is vertically centered** in the input bar (the single-line
  textarea now matches the 36px action buttons).
- **Provider/model avatar badges use one theme color** (`--clay-strong`) instead of four
  unrelated per-brand colors (the "Try it free" / Anthropic / OpenAI / Google tiles).

### Security
- **Backend `undici` bumped 7.27.2 → 7.28.0 (Dependabot).** Closes 7 alerts (3 high, 2 moderate, 2
  low) on the default branch — `undici` is a direct backend runtime dependency for host-side
  `fetch`/`Agent` egress. Patch release within `^7` (satisfies `testcontainers`' `^7.25.0`); no API
  change. `npm ci` reports 0 vulnerabilities.
- **Priority Matrix federation — bounded peer-response reads (ADR 0061).** The peer fetch now
  sends `accept-encoding: identity` (removes the decompression-bomb vector) and reads via a
  streaming `readCapped()` hard byte cap instead of buffering `res.text()` (undici has no
  built-in max-response-size; Content-Length is untrusted) — OWASP SSRF response-size control.

### Added
- **Priority Matrix — app↔app federated portfolio (ADR 0061).** A per-tenant registry of
  peer openwop-app origins + `GET /priority-matrix/portfolio/federated` that merges the
  local portfolio with each peer's, tagging every item with its `source`. Security: peer
  config is **non-secret** (the bearer is a deploy-time env secret, never persisted),
  egress is **SSRF-guarded** (reuses the webhook egress guard — host validated at
  registration, pinned DNS at connect), peer management is **superadmin-gated**, and a
  failing peer is **fail-soft** (reported, never fatal). This is **Option A** (both ends
  run this host → the non-normative host-extension route) — host-extension, **no RFC**.
  Cross-*vendor* prioritization (Option B) stays parked behind a future RFC.
- **Priority Matrix follow-ons (ADR 0059/0060).** Three host-internal additions:
  (1) **opt-in portfolio normalization** — `?normalize=list-relative|percentile` on
  `GET /priority-matrix/portfolio` + a "Compare" selector, a labeled comparability aid
  (raw stays the default); (2) **per-voter vote breakdown** — `GET .../ideas/:cardId/votes`,
  config-authority gated (list owner / org admin), surfaced via a Modal on the Votes count;
  (3) **single→multi-voter vote seeding** — switching `votingMode` seeds the creator's vote
  from each existing shared score so priorities survive the switch. Additive; no new RFC.
- **Priority Matrix — cross-list portfolio rollup (ADR 0060).** A read-only
  workspace **Portfolio** view aggregating + ranking ideas across all the priority
  lists the caller can read (`GET /priority-matrix/portfolio`, per-org readability
  filter; `ctx.features.priority-matrix.listPortfolio`). Each row shows its source
  list, in-list rank, and scoring model — priorities aren't strictly comparable
  across lists with different criteria, so the view is explicit about it.
  Host-extension, no new RFC. (Cross-*host* federation stays parked behind a future RFC.)
- **Priority Matrix (ADR 0058).** A toggle-gated feature-package (`priority-matrix`,
  OFF, tenant-bucketed) to capture ideas/requests into named priority lists, score
  them against a configurable weighted criteria set (1–10 slider weights; a
  Weighted-Scoring engine with WSJF/RICE/ICE/Value-Effort presets), rank them, and
  run a planning session that turns a selection into a meeting agenda. An idea is a
  `host.kanban` card (statuses = columns, terminal lanes + assignment via ADR 0049 —
  no parallel board); lists are workspace-scoped, or project-scoped when a `projectId`
  is set (board `ownerSubject`, ADR 0046). The agenda composes the Documents
  `board-agenda` kind (ADR 0053) when enabled, inline markdown otherwise. Adds the
  `ctx.features.priority-matrix` workflow surface + the `feature.priority-matrix
  .{nodes,agents}` packs (a Prioritization Analyst agent drivable from the AI chat).
  Host-extension, no new RFC.
- **Priority Matrix — multi-voter scoring (ADR 0059).** A list can opt into
  `votingMode: 'multi-voter'` (default `single`) with `voteAggregation: 'mean' | 'median'`:
  each member casts an independent per-criterion `IdeaVote` and ideas rank by the
  aggregate, so one member can't overwrite another. Switching mode is config-authority
  gated; single-mode lists are unchanged (no migration). Host-extension, no new RFC.
- **Versioned app releases + built-in migrations (ADR 0052).** An app-version
  single-source-of-truth (`/VERSION` → `src/version.ts`), surfaced at `/readiness`
  (`version`, deploy-verifiable) and recorded in `__app_meta` (fresh-install vs.
  upgrade-from-prior detection). A boot-time **app-migration runner** (§D5) for
  non-schema one-shots, forward-only + idempotent, sibling to the existing
  `__schema_version` DDL runner. This changelog + the `RELEASES.md` manifest.
- **Kanban card assignment to people (ADR 0049)** — assign a card to a person or
  role; addressed inbox notification + a `/my-work` "assigned to me" live mirror;
  `terminal`-lane completion; card-scoped access.
- **Per-recipient notification targeting (ADR 0050)** — `NotificationRecord
  .recipientUserId` (addressed vs. tenant-broadcast) + per-user Web-Push.

### Changed
- **Boards and Knowledge Base moved from the workspace rail to the Admin console.**
  `/boards` now lives under Admin → **Operations** (with Mission Control + Runs) and
  `/kb` under Admin → **Access & data** (with Organizations + Keys). The admin surface
  is ungated, so every user still reaches both via the Admin entry; each keeps its own
  RBAC (and KB its `kb` toggle). Nav-placement only — no route, auth, or wire change.
- **"My Work" folded into the personal board (ADR 0049 correction #3).** The
  standalone `/my-work` page + top-level nav item are removed; the "assigned to me"
  mirror is now a collapsible **"Assigned to me"** rail rendered as the leftmost
  column of your personal board, showing your open (non-terminal) assigned cards and
  collapsing away when empty. Same derived-view records (no copies); `/my-work`
  redirects to `/boards` (query-preserving) and assignment-notification deep-links
  now target `/boards?card=`. No wire/RFC change.
- **Per-agent knowledge & memory and collaborative projects are now always-on**
  (ADR 0038 / ADR 0054 §Correction). The `agent-knowledge` and `project-collab`
  feature toggles are retired (added to `RETIRED_TOGGLE_IDS`, so any stale per-tenant
  override is cleared at boot). The Agent **Knowledge** + **Memory** tabs and the
  project **Members** + **Chat** tabs now render unconditionally. Authority is
  unchanged — per-agent knowledge still enforces IDOR + RBAC + profile policy, and
  collaborative project writes stay org-scoped (`private` projects read-gated to
  members via the `subjectAccess` seam). No wire/RFC change.
- **In-app Network inspector enabled on the deployed app** (`VITE_ENABLE_NETWORK_RECORDER=1`
  in `.env.production`). The recorder previously ran liveness-only in prod, so the
  panel showed "0 calls". Full capture now records to the tab-scoped sessionStorage
  mirror; request **and** response bodies are credential-redacted (BYOK routes dropped,
  `token`/`password`/`apikey`/`secret` fields scrubbed) and truncated.
- White-label distribution moves from the rolling `whitelabel` tag to immutable
  `vX.Y.Z` releases; `latest` (aliasing `whitelabel`) becomes a moving pointer to
  the newest stable so the `/install/` URL stays stable (ADR 0052 §D7). The
  `/publish-whitelabel` skill is renamed/reworked to **`/cut-app-release`**.

### Changed
- **Project write controls are pre-gated on the caller's write access** (ADR 0063).
  The project read now projects `canWrite` (the caller's `workspace:write` in the
  project's org, from the same `resolveProjectAccess` the gate uses), so a read-only
  member / org viewer no longer sees Delete, Edit charter, Add/Remove member, the
  visibility toggle, Open chat / Save cadence, Assign workflow, the embedded
  memory/knowledge/schedule write controls, or the projects-list **Create project**
  form when they hold no `workspace:write` — all previously 403'd on use; they see a
  "read-only access" notice instead. The shared `MemoryBrowser` /
  `SubjectKnowledgePanel` / `SubjectSchedulesPanel` gained an opt-in `readOnly` prop
  (agent + profile surfaces unchanged). UX only — `requireProject('workspace:write')`
  remains the authority on every write route. No wire change.

### Fixed
- **Kanban columns hold a firm minimum width and the board scrolls horizontally.**
  Columns are now ≥280px and no longer shrink to cram many lanes into view; the
  board scrolls within the page (`min-width:0` on the content column keeps wide
  content from forcing a page-level scrollbar), so a 20-column board is fully
  reachable. The "Assigned to me" rail stays pinned at 240px.
- **Duplicate personal board / owner on multiple auth channels** (ADR 0003 §Correction).
  The personal-workspace owner member + personal kanban board were provisioned under
  the raw request subject, which falls back to the volatile channel principal
  (`oidc:<sub>` bearer / `session:<sid>`) before the session is bound — so a single
  human accrued a second "My Board" + a duplicate owner per auth channel. Both
  provisioning choke points (`GET /me/workspaces`, `GET /kanban/boards/personal`) now
  key on the caller's one canonical durable user (`resolveCallerUser`), matching the
  read side. Backend-only; no wire change.

#### Upgrading from a rolling `whitelabel` install
- **No required stop.** DB schema migrations (`__schema_version`) and app
  migrations (`__app_meta`) apply automatically on boot, forward-only and
  idempotently — an instance on any prior schema/app version catches up in one
  start.
- **Back up your database first.** Rollback is forward-only: redeploy the prior
  image and restore the snapshot (ADR 0052 §D3 — there are no down-migrations).
- **Verify:** `GET /readiness` returns `200` with the new `version`; smoke the
  changed surface.

<!--
Released sections (newest first) are appended below this line by /cut-app-release.
Each carries: ## [X.Y.Z] — YYYY-MM-DD, the Added/Changed/Deprecated/Removed/Fixed/
Security subsections, and a #### Upgrading from <prev> block when an operator action
or a required stop applies.
-->
