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
