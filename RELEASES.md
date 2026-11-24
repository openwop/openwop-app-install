# Releases

Human-readable index of openwop-app releases. The machine-readable source of truth
is [`releases.json`](./releases.json); the per-release "what changed + how to
upgrade" lives in [`CHANGELOG.md`](./CHANGELOG.md). Both are maintained by the
`/cut-app-release` skill (ADR 0052).

## How upgrades work

- **Immutable `vX.Y.Z` releases** (ADR 0052 §D7). `latest` (and the legacy
  `whitelabel` name) is a **moving alias** to the newest stable, so the `/install/`
  download URL is stable while each version is independently pinnable/auditable.
- **Skip intermediate versions freely** (§D2). On boot the app applies every
  pending DB schema migration (`__schema_version`) and app migration (`__app_meta`)
  in order — an instance N upgrading to N+k catches up in one start.
- **Required stops are the exception** (§D2). A release MAY declare
  `requiredStop: true` in `releases.json` when a migration cannot be safely skipped
  or needs a manual operator action; an upgrade must then land on that version
  before continuing. **Default: no required stops.**
- **Forward-only** (§D3). No down-migrations. Rollback = redeploy the prior image
  and restore a pre-upgrade database backup. Always back up before upgrading.

## Required-stop and rolling-safety policy

Two separate constraints (ADR 0052 §D2 / §D2a), each recorded in `releases.json`
and read by `node scripts/upgrade-plan.mjs <from> [<to>]`:

- **`requiredStop: true`** — an upgrade must LAND on this version before going
  past it. Mark it only when a migration must complete before a later one can run
  (a destructive or long-running data migration), or when a manual operator action
  must happen between the two versions.
- **`rollingSafe: false`** (+ `rollingUnsafeReason`) — the previous release's
  binary cannot run against this release's migrated schema (no expand/contract
  path), so every old instance stops before the first new one starts. This holds
  for anyone crossing the release, including an upgrade that skips past it.

A breaking config change that the operator can make at the same time as the
upgrade is neither: list it in `breakingConfig`.

> **Corrected 2026-10-24 (ADR 0052 §D2a).** Until today this section listed
> "a migration not backward-compatible with the prior running binary" as a reason
> to mark a required stop. v0.2.0 was exactly that, and it was recorded
> `requiredStop: false` because "land on 0.2.0 first" was never what it needed:
> its notes said "stop the 0.1.0 binary first". The manifest had no field for that,
> so a tool reading it would have offered a rolling upgrade. `rollingSafe` is that
> field; v0.2.0 now carries `rollingSafe: false`. The released v0.2.0 artifact
> itself is unchanged.

## Version log

### v0.20.0 — 2026-11-24

- **Required stop:** no. **Rolling-safe:** yes.
- **Schema:** sqlite 54 / postgres 52 (unchanged) · **App migrations:** 26 (unchanged).
- **Security:** the member Sharing API can no longer mint `sign_request`,
  `booking_manage`, `collab_invite` or `commerce_order` links (#6225). Adopters carry
  `test/sharing-system-mint-only.test.ts` at sync (#6226).
- **Breaking:** none. No route, env var or config key is removed or renamed.
  Behaviour changes: a replay fork with no matching AI record fails with
  `replay_source_missing` instead of calling the model (`mode: 'branch'` re-runs live,
  #6206); the app reloads after a confirmed workspace switch or create (#6207).
- **Config:** none. A proxy in front of the backend's direct host must pass the
  `x-openwop-workspace-selection` header (#6219).
- Kanban group-by and facet filters on the paged board, index-backed unpaged board
  read, paged "Assigned to me" (ADR 1155 P5); approve a held tool call on a chat card
  (ADR 1156 P1).
- Fixes: due-date sweep covers boards without roster agents (#6212); example data in
  a shared workspace (#6219); a failed run names a node's stated refusal (#6229);
  command palette Escape (#6227); three grade-tests product asks (#6218).
- [CHANGELOG §0.20.0](./CHANGELOG.md#0200--2026-11-24)

### v0.19.0 — 2026-11-23

- **Required stop:** no. **Rolling-safe:** yes.
- **Schema:** sqlite 54 / postgres 52 (unchanged) · **App migrations:** 26 (unchanged).
- **Breaking:** none. No route, env var or config key is removed or renamed.
  Behaviour change: approving a Campaign Studio channel draft now creates that draft
  in the connected tool (ads are created paused) (ADR 0162 correction, #6200).
- **New optional settings, unchanged by default:** `OPENWOP_SYSTEM_INDEX_SWEEP_MS`
  (default 60 s; `OPENWOP_MEDIA_INDEX_SWEEP_MS` still honoured) and the
  `projects.client-portal` sub-toggle (default off).
- **One-time work after upgrade:** each tenant's kanban card index is built on its
  first indexed read (inline up to 500 cards, else by the background sweep while
  reads use the old path).
- Kanban at scale (ADR 1155 P1–P4): `dueAt: null`, card `facets`, a paged
  `GET /boards/:id?limit=`, an index-backed "Assigned to me", batch board commands.
  The 2,000-card cap (P5b) is NOT in this release.
- Project client access (ADR 1099 P1), computer-use trajectory viewer (ADR 1136 P3b),
  reallocation-plan withdraw (ADR 1022), shared approval quorum groundwork (ADR 0924
  P2a), offline `onlineOnly` (ADR 0873 D6).
- Fixes: internal comment threads are member-only (#6109); origin-denied URLs keep
  origin and path only; CHAN-F19 erasure follow-ups.
- [CHANGELOG §0.19.0](./CHANGELOG.md#0190--2026-11-23)

### v0.18.0 — 2026-11-22

- **Required stop:** no. **Rolling-safe:** yes.
- **Schema:** sqlite 54 / postgres 52 (unchanged) · **App migrations:** 26 (unchanged).
- **Breaking:** none. No route, env var or config key is removed or renamed. Behaviour
  change: a node-pack import that fails on an I/O error answers `502` with its cause,
  not `409 pack_restart_required` (#6164).
- **New optional setting, unchanged by default:** `VITE_BRAND_APP_HOME_PATH`
  (frontend build; default `/dashboard`).
- A scheduled client report skips when its owner lost client access (ADR 0957 P1).
- Link-only client report portal, off by default (ADR 0957 P2 slice 1).
- Campaign Studio guided-flow records, progress and home reads, and campaign-scoped
  spend approvals and attribution (ADR 1154 P1/P2, D5/D7).
- [CHANGELOG §0.18.0](./CHANGELOG.md#0180--2026-11-22)

### v0.17.0 — 2026-11-21

- **Required stop:** no. **Rolling-safe:** yes.
- **Schema:** sqlite 54 / postgres 52 (unchanged) · **App migrations:** 26 (unchanged).
- **Breaking:** none. No route, env var or config key is removed or renamed. Behaviour
  changes: an unpaged media asset list is newest first (#6112); replacing an
  already-imported node pack answers `409 pack_restart_required` (#6157); a
  reallocation proposer cannot decide their own plan (#6161); an erased person leaves
  every beta cohort (#6153).
- **New optional settings, all unchanged by default:**
  - `OPENWOP_MEDIA_INDEX_SWEEP_MS`;
  - `OPENWOP_PUBSUB_PING_INTERVAL_MS`, `OPENWOP_PUBSUB_PING_TIMEOUT_MS`;
  - `VITE_BRAND_CONSENT_CLEARANCE`, `VITE_BRAND_CONSENT_FOOTER` (frontend build).

  No setting changes meaning.
- Subject erasure covers seven more stores (ADR 0464 §9, CHAN-F19 #6–#12).
- A refused A2A push URL no longer echoes its credential (ADR 1147 GUARD-3).
- MCP `campaign_propose_budget_change`, human-gated (ADR 0962 P2); collaborator grant
  renewal (ADR 0958); browser-agent sign-in take-over (ADR 1136 P3a).
- CMS split columns, linked gallery tiles, video hero and CTA photo band; consent
  placement options (ADR 1150, ADR 1153).
- Media assets record width and height; media lists can be paged (#6112).
- Webhook retries arrive on schedule (RFC 0173); the Postgres event listener recovers
  from a silent socket (#6133).
- [CHANGELOG §0.17.0](./CHANGELOG.md#0170--2026-11-21)

### v0.16.0 — 2026-11-18

- **Required stop:** no. **Rolling-safe:** yes.
- **Schema:** sqlite 54 / postgres 52, one additive nullable column
  (`invocation_log.llm_cache_key`). **App migrations:** 26 (unchanged).
- **Breaking for API callers:** adding a person to an org by `user:` subject now
  answers `409 use_add_existing` / `use_link`. Use `…/members/add-existing` and
  `…/members/:memberId/link` (#5945).
- **New optional settings, all off or unchanged by default:**
  - `OPENWOP_API_KEY_EMPTY_SCOPES` (default permit);
  - `OPENWOP_API_KEY_UNDECLARED_REWRITE` (`report` | `apply`, default off);
  - `OPENWOP_MEDIA_ORG_MAX_ASSETS|BYTES|COLLECTIONS`;
  - `OPENWOP_LLM_CACHE_KEY_RECIPE_2`;
  - `OPENWOP_TELEMETRY_FAMILY`.

  No setting changes meaning.
- Every error response is `no-store` (ADR 1147).
- Approval requests reach only people who can open the run (ADR 1140).
- Share links can verify their recipient by emailed code (ADR 1141, off by default).
- Inbox: Needs you / Updates / Archived with one count (ADR 1125).
- Collaboration projections (ADR 1099), RFC 0260 recipe 2, RFC 0262 telemetry, Kanban
  due reminders, per-org media caps, and browser-agent groundwork (ADR 1136).

### v0.15.0 — 2026-11-16

- **Required stop:** no. **Rolling-safe:** yes. From before 0.14.0, land on
  0.14.0 first if the legacy env-key id rewrite was never run (see v0.14.0).
- **Schema:** sqlite 53 / postgres 51 (unchanged) · **App migrations:** 26 (unchanged).
- New setting: the optional `OPENWOP_ASSET_SIGNING_PREVIOUS_SECRET`. No setting
  changes meaning; `OPENWOP_LEGACY_BEARER_REWRITE` is removed and ignored.
- Run admission checks required chain parameters, shadow-first (run admission preflight P0).
- A sole admin can approve their own autonomy gate (CC-GATE-2 G1).
- Public-asset grants for the storefront, share links and e-sign, the asset
  org floor and signed reads, all behind `OPENWOP_ASSET_ACCESS` (ADR 1122).
- A client's workflow definitions and a private project's runs are read only
  by their people (ADR 1132, ADR 1133).
- Inbox requests name who asks and why; an open request cannot be archived
  away; external-event waits no longer notify (ADR 1125).
- Kanban work items can carry an assignee or a project role and be refreshed
  (ADR 1137).
- Campaign Studio fixes: market-intelligence digests read the pages they find,
  SEO briefs save as documents, governed campaign launch, Strategist context.
- [CHANGELOG §0.15.0](./CHANGELOG.md#0150--2026-11-16)

### v0.14.0 — 2026-11-15

- **Required stop:** yes (since 2026-11-16, see below). **Rolling-safe:** yes.

  > **Corrected 2026-11-16 (ADR 1045, CHAN-F18; user decision).** Published as
  > "Required stop: no". 0.14.0 turned out to be the last release that carries
  > the one-time legacy env-key id rewrite (`OPENWOP_LEGACY_BEARER_REWRITE`),
  > which was removed right after it. An install that used env keys and never
  > ran the rewrite must land on 0.14.0 and run it (`report`, read the counts,
  > then `apply`) before going past it; later releases cannot rewrite those
  > records. An install that already ran it, or never used env keys, passes
  > straight through. `releases.json` now records `requiredStop: true` with
  > that reason, so `upgrade-plan.mjs` splits any upgrade that crosses 0.14.0.
  > The released v0.14.0 artifact itself is unchanged.
- **Schema:** sqlite 53 / postgres 51 (one index on `notifications`) · **App migrations:** 26 (unchanged).
- New settings: `OPENWOP_COMMERCE_MAX_PRODUCTS_PER_ORG` (default 5000),
  `OPENWOP_COMMERCE_INDEX_SWEEP_MS` (default 60000) and the optional one-shot
  `OPENWOP_CMS_OVERLAY_REALIGN`, `OPENWOP_ASSET_ACCESS` (default off); two default-off flags. No setting changes meaning.
- A client's runs are read only by that client's people (ADR 1121).
- Private projects admit only members and the org's admins; four Gemini models
  leave the catalog; `registerCollaborationOrgGate` is renamed.
- Open chats no longer file Inbox requests; a one-time background job retires
  the ones already sent.
- Adds readable Inbox requests that close with their step, feature wording on
  approval cards, hideable menu entries and paged product and order reads.
- [CHANGELOG §0.14.0](./CHANGELOG.md#0140--2026-11-15)

### v0.13.0 — 2026-11-11

- **Required stop:** no. **Rolling-safe:** yes.
- **Schema:** sqlite 52 / postgres 50 · **App migrations:** 26 (unchanged).
- New settings: `OPENWOP_CHANNEL_APPROVAL_TTL_MIN` (default 1440 minutes) and
  `OPENWOP_INTEGRITY_GAUGES` (on unless `false`). No setting changes meaning.
- Hosting: a self-kept `firebase.json` needs the new `/docs` and `/docs/**`
  rewrites.
- Adds a public trial entry, unlisted (quote-only) products, project health and
  read tools, a relay channel kill switch, WhatsApp settings in Connections and
  new CMS sections (`films`, `pricing.plans`, a `resources` nav group).
- Tool approvals cover one exact call by default; creative briefs, alt text and
  WhatsApp sends need `workspace:write`; removing a knowledge-sync source
  deletes its synced documents.
- [CHANGELOG §0.13.0](./CHANGELOG.md#0130--2026-11-11)

### v0.12.0 — 2026-11-10

- **Required stop:** no. **Rolling-safe:** yes.
- **Schema:** sqlite 52 / postgres 50 · **App migrations:** 26 (unchanged).
- `OPENWOP_MEDIA_DAILY_VIDEO_JOBS=0` now disables paid video (it meant uncapped);
  set `unlimited` for no cap. Unset defaults to 10 units per org per day.
- Adds public-site style tokens (`--site-*` in `brand.css`), feature project
  tabs and an Operations delivery panel.
- CDP collect, merchandising and creative video writes need `workspace:write`;
  reserved CDP event types are refused over HTTP.
- [CHANGELOG §0.12.0](./CHANGELOG.md#0120--2026-11-10)

### v0.11.0 — 2026-11-09

- **Required stop:** no. **Rolling-safe:** no. A 0.10.0 instance cannot resolve
  re-keyed partner-portal tokens, so stop every 0.10.0 instance before starting
  0.11.0 when the dealers partner portal is in use.
- **Schema:** sqlite 52 / postgres 50 · **App migrations:** 26.
- KickTodo leaves openwop-app. A KickTodo adopter takes its packages under its
  own `src/adopter/features/` and attests its packs in
  `packs/.adopter-manifest.json` in the same sync. Seven KickTodo env vars are
  no longer read.
- Adds channels into the main chat, SKILL.md import, animated films, designed
  custom-domain pages, new CMS section options and persisted agent-scoped
  embedded chat. BI metrics become per org and refuse stale definitions. Channels, skill import,
  films and designed pages stay off by default.
- A run whose every final step was skipped now completes. Keyless workspaces
  run workflow AI steps on the managed tier.
- Closes cross-tenant and cross-client paths in A2A, connections, ads and BYOK.
  Env-key principal ids change once, and delivery-log rows older than 7 days are
  pruned after the upgrade.
- [CHANGELOG §0.11.0](./CHANGELOG.md#0110--2026-11-09)

### v0.10.0 — 2026-11-02

- **Required stop:** no. **Rolling-safe:** yes.
- **Schema:** sqlite 51 / postgres 49 (unchanged) · **App migrations:** 24 (unchanged).
- The AI Envelope is removed. Stored workflows that use `vendor.myndhyve.ai` nodes
  fail with `host_capability_missing`, capabilities drop the envelope fields, and
  two env vars are no longer read.
- Adds agent deployments and versions, the model router, chat-widget
  conversations, agent clarification questions and session replay. Agent
  deployments, agent versions, clarification, replay and the site runtime stay
  off by default.
- Under `OPENWOP_DEPLOY_POSTURE=auth`, a run start returns `503` when the shared
  counter store can't answer. Model text can no longer become an executed tool.
- Fixes Campaign Studio approval and org-ownership paths, and rate-limits custom
  domains per client.
- [CHANGELOG §0.10.0](./CHANGELOG.md#0100--2026-11-02)

### v0.9.0 — 2026-10-29
- **Required stop:** no. **Rolling-safe:** yes.
- **Schema:** sqlite 51 / postgres 49 (unchanged) · **App migrations:** 24 (unchanged).
- No configuration changes are required. Tool-output compaction stays off by default.
- Model calls replay from the invocation log (managed tier and tool rounds),
  thrown and untrusted tool errors are fenced before they reach a model, and
  replay forks refuse compose/propose drafts, web research and native search.
- Client reports go through review, and admins can create whole-workspace
  Connections. KickTodo reviews show readable fields instead of raw JSON, and
  the creative-fidelity judge no longer sends unbranded products to review.
- [CHANGELOG §0.9.0](./CHANGELOG.md#090--2026-10-29)

### v0.8.0 — 2026-10-28
- **Required stop:** no. **Rolling-safe:** yes.
- **Schema:** sqlite 51 / postgres 49 · **App migrations:** 24 (unchanged).
- Durable run admission adds a nullable scope key and index without a backfill.
  Plan PostgreSQL's index-build write pause; see the operator upgrade notes.
- Breaking `auth`-posture startup decisions require membership authorization
  and superadmin MFA, or their explicit operator overrides. Set them before
  deploying; see the upgrade instructions.
- Durable event replay, proposal operations and eval evidence, multi-tab and
  scheduled chats, campaign collaboration, funnels and managed-tier selection.
  Workspace admins can check their BYOK creative-fidelity judge against synthetic
  product edits before relying on it.
  Prompt-template tenant isolation, operator and run-stream fixes, plus CI and
  white-label adoption improvements. Chat import/export, private team prompts,
  collaborator management and purpose-based email routing are included.
- Existing Postmark campaign operators must verify their Broadcast stream.
  Production WASI execution now requires explicit opt-in; read the upgrade notes.
- Conversation search uses the durable messages and current visibility rules;
  the legacy tenant-wide search index is removed (ADR 0997).
- Workflow vector/search/NoSQL/blob storage is separated from host-feature data
  (ADR 0998). Existing workflow data needs a reviewed transition; affected
  workflows must be quiesced while old and new storage namespaces differ.
- Existing OpenSearch deployments need a reviewed rebuild from authoritative
  tenant-scoped data into the new physical index names (#5355). Old indexes may
  contain colliding tenants; do not copy them wholesale. Back up, quiesce affected
  writers and verify the rebuild before resuming. No automatic migration runs.
- [CHANGELOG §0.8.0](./CHANGELOG.md#080--2026-10-28)

### v0.7.0 — 2026-10-23
- **Required stop:** no.
- **Schema:** sqlite 50 / postgres 48 · **App migrations:** 24 (unchanged from 0.6.0).
- A MINOR release (ADR 0052 §D1), rolling-safe. New: callAI attempt accounting
  and per-call retry policy (RFC 0248, certified in production), the KickTodo
  operator-access panel and sweep, an animated CMS journey hero. Security: Node.js
  22.23.4 base image (October 2026 Node.js security release; rebuild your image),
  sub-workflow interrupt guard, dompurify and markdown-it advisories.

### v0.6.0 — 2026-10-20
- **Required stop:** no.
- **Schema:** sqlite 50 / postgres 48 · **App migrations:** 24 (unchanged from 0.5.1).
- A MINOR release (ADR 0052 §D1), rolling-safe. New: campaign operations P0,
  email approvals and versioned templates, ads conversions and metrics, knowledge
  base retrieval, per-deployment custom-domain edges, system site profiles, CMS
  section styles. Fixed: custom domains fail closed, proposals apply honestly, a self-deleted
  account's subscriptions are canceled first, section anchors work.
  **Removed:** `OPENWOP_PROPOSALS_ACTIVATION` (no working effect; ADR 0938 D2).
- [CHANGELOG §0.6.0](./CHANGELOG.md#060--2026-10-20)

### v0.5.1 — 2026-10-18
- **Required stop:** no.
- **Schema:** sqlite 50 / postgres 48 · **App migrations:** 24 (unchanged from 0.5.0).
- Ten PRs since v0.5.0, no migrations, rolling-safe, no breaking config. New:
  white-label adoption seams (field/recess brand tokens, feature nav translations,
  wrong-vendor key detection, `OPENWOP_DEPLOY_BRANCH`), feature-surface
  requirements in the node catalog, and a declared entry share for distributions.
  Changed: nested params fold into chain expansion ids (flat ids unchanged).
  Fixed: an email campaign sends the content it started with, and a template in
  use cannot be deleted (ADR 0905 P0); revoked v2 chain packs no longer load. **Labelled a patch by the
  maintainer's decision**; by ADR 0052 §D1 its feature content would be a minor.
- [CHANGELOG §0.5.1](./CHANGELOG.md#051--2026-10-18)

### v0.5.0 — 2026-10-18
- **Required stop:** no.
- **Schema:** sqlite 50 / postgres 48 · **App migrations:** 24.
- Eight days since v0.4.0 (255 merged PRs; ADRs up to 0915). Rolling-safe, no
  breaking config. Migrations: Postgres 48 / SQLite 50 drop webhook subscriptions
  of the retired OpenWOP major 1 (they already received nothing); app migrations
  23–24 keep CRM, Strategy, Priority matrix and Advisory board ON for installs
  that use them, now that those default off. New: no hard-coded AI vendor (a run
  AI default), honest provider-failure codes and native structured output, agent
  evaluations, approval/session authority, checkout tax and promotions, and the
  white-label seams (subject erasure, content language, feature public paths).
  New optional env: `OPENWOP_PROVIDER_RETRY_BACKOFF_MS`.
- [CHANGELOG §0.5.0](./CHANGELOG.md#050--2026-10-18)

### v0.4.0 — 2026-10-10
- **Required stop:** no.
- **Schema:** sqlite 49 / postgres 47 · **App migrations:** 22.
- One day since v0.3.0 (80 commits, ADRs 0869–0872). No migrations, rolling-safe,
  no breaking config. New: an hourly storage-growth gauge with optional trigger
  knobs (`OPENWOP_STORAGE_GROWTH_GAUGE`, `OPENWOP_SURFACE_ROW_TRIGGER`,
  `OPENWOP_VECTOR_*`); tenant-indexed kanban and authorization reads; the 44
  Work-Twin `tmpl.*` templates ship as a chain pack; the v1 discovery builder is
  deleted. v2 discovery advertises `multiAgent` only when its phase flags are set.
- [CHANGELOG §0.4.0](./CHANGELOG.md#040--2026-10-10)

### v0.3.0 — 2026-10-09
- **Required stop:** no.
- **Schema:** sqlite 49 / postgres 47 · **App migrations:** 22.
- Two weeks since v0.2.0 (1,549 commits, ADRs 0759–0867). **OpenWOP v1 is
  removed** — `/v1/*` answers `410` and the host speaks only v2; move integrations
  to the unversioned v2 paths first. Rolling-safe (additive columns only). Also
  breaking: chain packs must pin nodes exactly; registry packs must be v2-signed.
  New: `OPENWOP_TRUSTED_PROXY_CIDRS` for public-address proxies; scale-out hosts
  need shared `OPENWOP_SURFACE_*` backends to advertise storage families.
- [CHANGELOG §0.3.0](./CHANGELOG.md#030--2026-10-09)

### v0.2.0 — 2026-09-27
- **Required stop:** no. **Rolling-safe:** no (`rollingSafe: false`, recorded
  2026-10-24; see the correction above).
- **Schema:** sqlite 48 / postgres 46 · **App migrations:** 21.
- Three months since v0.1.0 (3,364 commits, ADRs 0172–0757): this host now speaks
  OpenWOP **v1 and v2**, with signed certification evidence per deploy. **Not
  rolling-safe:** stop the 0.1.0 binary first (Postgres mig 37 / SQLite 39 rename an
  `invocation_log` column). Breaking: legacy webhook `openwop-signature` /
  `openwop-subscription-id` headers removed; the per-IP rate limit split into
  read/write tiers; set the new `OPENWOP_INTERRUPT_TOKEN_SECRET`.
- [CHANGELOG §0.2.0](./CHANGELOG.md#020--2026-09-27)

### v0.1.0 — 2026-06-30
- **Required stop:** no.
- **Schema:** sqlite 32 / postgres 29 · **App migrations:** 1.
- Inaugural versioned white-label release (ADR 0052) — replaces the rolling
  `whitelabel` tag with an immutable `v0.1.0` + a moving `latest` alias. Captures the
  pre-1.0 app, including the runtime white-label brand + generative theming
  (ADR 0170 / 0171). Fresh install — no prior version to upgrade from.
- [CHANGELOG §0.1.0](./CHANGELOG.md#010--2026-06-30)
