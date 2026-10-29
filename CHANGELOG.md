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

## [0.9.0] — 2026-10-29

A MINOR release under ADR 0052. It adds tool-output compaction for child runs
(off by default), client-report review and whole-workspace Connections, along
with model-call replay coverage and fixes to how tool errors are fenced. There
are no schema or app migrations: schema stays at sqlite 51 / postgres 49 and app
migrations stay at 24.

### Added

- **Tool-output compaction: child runs and editing (ADR 0999).** A sub-workflow
  child run now keeps the compaction decision its root run fixed. The output of
  a workflow called as a tool is fenced before it reaches a model. Read-before-write
  tool outputs are never compacted, and the panel gains a lossy-compaction
  editor. The `tool-output-compaction` feature stays **off** by default (#5356).
- **Client reports go through review (ADR 0957 P1b).** Scheduled and on-demand
  client reports run through the compute → review → publish workflow chain. The
  client, the report definition and its version, and the calendar period are all
  fixed when the run starts. Publishing a report requires the computed snapshot's
  digest to match, an explicit approval, and the client's fixed policy. Reports
  are not sent to clients automatically (#5364).
- **Whole-workspace Connections (ADR 0994).** Admins can share a Connection with
  the whole workspace, for sends that have no acting user, such as approval
  notices and campaigns (#5368).

### Changed

- **Model calls replay from the invocation log (ADR 1002).** Managed-tier
  `callAI` calls and tool-calling rounds (managed and BYOK) are now recorded in
  the invocation log, the same way BYOK `callAI` already was. A replay fork is
  served from the log rather than making live, paid model calls. If the log has
  no matching entry, the replayed node fails (#5362).
- Provider error codes are read from the whole response body, not from the
  shortened message, so a quota error now reports its code (ADR 0945 P2, #5369).
- DEPLOY.md now states that production in-process WASI code execution needs
  `OPENWOP_CODE_EXEC_RUNTIME=wasi` (ADR 0995 D8, #5366).

### Fixed

- KickTodo Challenge Factory reviews no longer show raw JSON. The outline
  approval and the final result are shown as readable fields, the plan's
  alternatives are listed, and a submitted request reads as awaiting review, not
  as published (#5365).
- Client-report notices name the report, not the engine that produced it
  (ADR 0926 D1, #5364).
- The creative-fidelity judge no longer sends unbranded products to review for
  no reason. An attribute missing from both the source and the edited image
  (for example, no logo on either) now counts as `match`. `not_visible` now
  means the source has the attribute and the edit hides it, and an attribute
  added in the edit is a `mismatch` (ADR 0945 P2, #5375).
- CI tooling:
  - Tracegate now invalidates on changed, added or removed value imports, and
    rejects observations from interrupted runs.
  - Shutdown probes keep each boot's log, and serial mode now sequences the
    frontend lanes.
  - The release-bus INT self-test now passes when the gate runs it as a
    background job (#5360, #5361, #5363, #5367, #5371).

### Security

- **Tool errors are fenced by where they came from (ADR 1000, TOC2CD-11/14).**
  Every thrown tool error is fenced before it reaches a model, on every lane:
  the chat tool loop, the built-in executor, the realtime voice bridge and the
  provider dispatchers. A returned error from an untrusted tool is shown
  unfenced only when a host helper vouched for its message. The refusals of the
  nine default-on trusted tools are unchanged (#5358, #5359).
- **Replay egress guards (ADR 0531).** On replay forks, `workflows.compose-and-run`
  / `workflows.propose`, `ai.research.web` and native web search are all refused
  at the existing effect guard. A refused replay no longer leaves a stray draft
  behind, falls back to example data, or makes a live model call (#5373).

#### Upgrading from 0.8.0

- **No required stop; rolling-safe.** `node scripts/upgrade-plan.mjs 0.8.0`
  gives one step, 0.8.0 → 0.9.0: back up the database (and object store); the
  schema permits 0.8.0 instances during the upgrade; start 0.9.0 (sqlite
  51 → 51, postgres 49 → 49, app 24 → 24, so no migrations run); check
  `/readiness`.
- **No configuration changes are required.** `tool-output-compaction` stays
  off by default.
- After the upgrade, check that `/readiness` reports `version: 0.9.0`.

## [0.8.0] — 2026-10-28

A MINOR release under ADR 0052, including breaking startup requirements under
its pre-1.0 policy. Configure the two security decisions below before deploying
to an `auth` posture. This release adds schema migrations sqlite 51 / postgres
49 for durable run admission; app migrations remain at 24.

### Added

- **Durable run admission, first phase (ADR 0987).** Main and evaluation run
  creation count pending/running runs inside the storage transaction, preserving
  concurrency limits across instances and beyond the old 60-second window
  (#5327). Existing rows keep a null admission key and drain without counting
  toward the new cap. Other creation lanes and load qualification remain later
  phases; this is not complete coverage of every run-creation path.
- **Production security profile (ADR 0981).** Startup reports missing controls
  together; readiness reports `strict` or `evaluation`. A superadmin-only census
  reports callers the membership and MFA rules would refuse (#5262, #5265,
  #5272). Missing decisions now refuse an `auth` deployment before its build.
- **Durable host-event replay (ADR 0973, RFC 0250).** Replay uses the durable
  event log across instances. Legacy `Last-Event-ID` resumes from that log when
  the current process lacks the cursor (#5182, #5187, #5322). Failed appends
  retry, oversized events are retained as dead letters, and operators can
  inspect dead-letter counts without exposing event payloads (#5323).
- **Proposal operations and eval evidence.** RFC 0249 proposal operations
  (#5168, #5173), RFC 0244 eval counters and isolated memory (#5225, #5291),
  RFC 0251 regression-baseline selection (#5256), and RFC 0252 fixtures from
  recorded runs (#5261). Conformance is pinned to 2.46.33 (#5313).
- **Eval leaderboard and arena (ADR 0986).** Server-attributed results and
  run-bound, credential-bound comparisons replace client-supplied claims (#5282).
- **Chat and agent tools.** Per-workspace multi-tab chat with protected busy
  tabs (#5231, #5237), scoped agent knowledge (#5234), personal chat-memory
  extraction (#5250), and scheduled chats using the job's real state (#5270).
- **Campaign collaboration (ADR 0958).** Client approver grants, vendor asset
  intake, a ClamAV upload scanner, and collaborator erasure that anonymizes
  accepted files while respecting legal holds (#5268, #5276, #5303, #5309).
- **Funnels and experiments (ADRs 0948–0949).** Lead-magnet and tripwire
  blueprints, post-purchase offers, campaign-bound publishing, persisted step
  experiment pointers, and journey splits (#5255, #5293, #5296, #5307,
  #5254, #5253, #5257, #5288).
- **Managed tier selection (ADR 0990).** The site owner can select its provider
  and model in the managed-tier administration surface (#5285, #5305).
- **Creative fidelity judge check (ADR 0945 P2).** Workspace admins can test
  their chosen BYOK vision model against four synthetic product edits and see
  which changes it detected. The check uses the production judge, bounds provider
  calls and stops on provider failure (#5316). This does not certify a model's
  accuracy on the workspace's own product images. Provider failures now report a
  bounded diagnostic code (#5340).
- **Chat export and import (ADR 0992).** Exports preserve message roles and
  content, imports are visibly identified and cannot impersonate native system
  messages, and archive selection uses the current conversation's permissions
  (#5312).
- **Team prompt library (ADR 0993).** Workspace members can manage library
  entries; private entries remain owner-only, tenant templates survive restarts,
  and `/p-<slug>` inserts text into the invoking composer for review before sending
  (#5329). Portability exports and erasure respect private ownership.
- **Collaborator operations (ADR 0958).** The client Collaborators panel,
  activity review, expiration notices and archive-time suspension share the live
  grant rules (#5331–#5336, #5341, #5343). The collaboration feature remains
  behind its existing toggle; upgrading does not enable it.
- **Email routing and SES feedback (ADR 0994).** Operators can prefer separate
  providers for transactional and marketing messages. SES uses the existing SMTP
  Connection; signed SNS bounce/complaint notifications update suppression
  (#5339). Existing single-provider connections continue to work.
- **Bounded code execution (ADR 0995).** Workflow reviews show the submitted
  program and can complete their gate; sandbox memory, scratch space, output and
  concurrency have explicit limits, and execution reserves budget before running
  (#5346). Production WASI execution requires explicit operator opt-in.
- **Operator and CI tooling.** Upgrade planning, portable adopter-owned browser
  baselines, adaptive CI width, batch branches, Tracegate red-reader packets,
  and the advisory cross-machine release bus (#5185, #5279, #5326, #5181,
  #5214, #5274, #5295, #5302). Deploys, configuration updates and certification
  cuts now queue only when their configured targets overlap; waits are bounded
  and fail open, while gates and releases to different targets proceed (#5319).

### Fixed

- Vector/search workflow calls accept the published pack argument names before
  applying the reserved workflow namespace; canonical arguments take precedence
  and conflicting aliases are removed (#5354).
- CI tooling isolates its fixture processes, avoids accidental dependency installs
  from a progress banner, and reports advisory browser failures separately.
  Configured merge trains retain gate evidence for the exact candidate tree
  (#5292). Tracegate records import-time work separately in its boot shadow
  measurements (#5320). Live CI claims survive an unreadable process-start
  timestamp, and preflight fixtures use an isolated marker store. Tracegate
  checks global invalidations before per-file inputs (#5330).
- Merge trains reject PR heads that changed after gating. Required and advisory
  browser runs preserve separate failure artifacts, and deployment diagnostics
  distinguish historical job activity from measured revision drain (#5337, #5342).
- The desktop client uses Electron 45 and electron-builder 26.18 (#5183).
- Upgrade plans put required configuration before starting the new version,
  so operators can satisfy the startup checks before the backend boots.
- A malformed chat import returns `400 validation_error` instead of 500 (#5301).
- `/privacy` redirects to the brand's configured privacy policy (#5314).
- Stream and SPA run IDs use the run's tenant, preventing request-scope tenant
  mismatches (#5299, #5236). Node outputs containing NUL can be stored, and a
  starter-dispatch exception marks its run failed (#5300).
- KickTodo's operator can use the Challenge Author chat; Factory plans must
  cite evidence before building lessons (#5289, #5235).
- Public author bylines omit unidentified authors and the system site's byline
  uses the host operator (#5277, #5278).
- White-label deployment checks preserve the adopter's hosting target and
  branding defaults (#5224, #5238). The registry's connection-pack revisions
  are synchronized (#5241).

### Security

- **OpenSearch physical names.** Tenant and index segments use separate encoded
  components instead of lossy lowercase replacement, separating the previously
  colliding ASCII names and preserving the workflow boundary (#5355). Existing
  OpenSearch deployments need a reviewed rebuild; see the upgrade warning below.
- **Workflow storage isolation (ADR 0998).** Workflow nodes use a reserved `wf:`
  namespace for vector, search, NoSQL and blob storage. Host features cannot use
  that namespace, and workflows cannot address host-owned data through these
  surfaces (#5351). Existing workflow-written data needs an operator-reviewed
  transition; see the upgrade warning below.
- **Conversation search privacy (ADR 0997).** Search reads messages from the
  durable conversation store after checking current conversation visibility,
  then applies the same message projection as chat. It removes the derived
  tenant-wide search index and purges its legacy rows (#5349). Results identify
  when the bounded candidate scan was truncated; SQLite's case-insensitive
  matching remains limited to its native `LIKE` behavior.
- **Chat artifact visibility (ADR 0996).** Artifacts created by chat tools follow
  the originating conversation's current visibility. Outputs without a
  conversation are readable only by their bound user; anonymous outputs remain
  unreadable. Code results and interactive artifacts no longer inherit a wider
  workspace audience (#5347).
- **Prompt-template tenancy (ADR 0993).** User templates belong to one tenant
  and persist in storage; reads preserve existing `Vary` headers (#5324).
- **Superadmin MFA and enrollment.** A required second factor, QR enrollment,
  correct otpauth encoding, and a single-factor backup guard (#5158, #5156,
  #5157, #5159, #5171).
- Authorization, erasure and reference checks are tightened across campaign
  collaboration, agent memory, commerce account ownership and run approvals
  (#5248, #5234, #5255, #5090). The DSAR matcher covers the doubled legacy
  subject spelling (#5306).
- Dependency advisory fixes include body-parser, undici and Azure MSAL
  (#5164, #5165, #5192, #5233).

#### Upgrading from 0.7.x

- **No required stop; rolling-safe schema.** Back up the database before an
  upgrade. Schema sqlite 51 / postgres 49 adds a nullable `runs.admission_key`
  column and its `(admission_key, status)` index, without a backfill. App
  migrations remain at 24. A breaking configuration decision can be made before the
  deploy and does not require stopping on this version before later upgrades.
- **Plan the index build.** PostgreSQL's normal boot migration uses a plain
  `CREATE INDEX`, which blocks writes to `runs` while scanning it. Measure the
  table and active transactions first. For a large database, arrange the nullable
  column addition and a concurrent index build before starting the new binary;
  verify the index is valid, not merely present. Keep the schema-version marker
  managed by the migration runner. Measure old-revision drain before claiming
  fleet-wide admission behavior.
- **Preserve rollback consistency.** Follow the forward-only backup/recovery
  policy in RELEASES.md. Dropping the new column/index alone leaves schema
  51/49 recorded and prevents a subsequent boot from recreating them. Do not
  manually decrement the marker or run that incomplete rollback snippet.
- **Breaking startup requirements apply to `OPENWOP_DEPLOY_POSTURE=auth` and
  legacy `OPENWOP_AUTH_ENFORCE_BEARER=true`.** Cookie-per-visitor and
  bearer-shared deployments are unaffected. Only the exact value `true` counts.
- Set `OPENWOP_AUTHORIZATION_ENFORCEMENT=true`, or explicitly accept the
  temporary risk with `OPENWOP_ALLOW_UNENFORCED_AUTHORIZATION=true`.
- If `OPENWOP_SUPERADMIN_TENANTS` is set, require enrolled superadmins' MFA with
  `OPENWOP_SUPERADMIN_REQUIRE_MFA=true`, or explicitly accept the temporary
  risk with `OPENWOP_ALLOW_SUPERADMIN_WITHOUT_MFA=true`. Enroll every listed
  superadmin and sign in with the factor before requiring it. Break-glass
  remains the recovery path.
- Set these plain environment flags **before deploying**; older releases
  ignore them. Preflight Gate 5c refuses a missing or unmeasurable decision.
  Use incremental `scripts/update-env.sh` updates to preserve other settings.
- To stage membership enforcement, deploy with the explicit override, allow
  real traffic, then read the superadmin
  `GET /host/openwop-app/operations/profile-census`. Grant the reported callers
  the roles they need before enabling enforcement and removing the override.
- **Postmark campaign stream:** marketing and unlabelled mail now uses
  Postmark's Broadcast stream (default `broadcast`). Confirm that stream exists
  on the connected server, or set `OPENWOP_POSTMARK_BROADCAST_STREAM` to its
  existing Broadcast stream name, before upgrading. Missing streams refuse with
  `email_stream_missing`; transactional mail remains on `outbound`. Purpose
  preferences use `OPENWOP_EMAIL_TRANSACTIONAL_PROVIDER` and
  `OPENWOP_EMAIL_MARKETING_PROVIDER`; unset preferences preserve the current
  default provider. No provider Connection is created automatically.
- **Production WASI is opt-in:** deployments that relied on the bundled runtime
  must explicitly select `OPENWOP_CODE_EXEC_RUNTIME=wasi` to retain it. Review
  instance memory and the documented concurrency/resource limits before enabling
  it; merely including the WASM asset no longer activates production execution.
- **Breaking workflow storage boundary (ADR 0998):** vector namespaces, search
  indexes, NoSQL datasources and blob keys used by workflow nodes now resolve
  under `wf:` internally. Node inputs and returned names remain unprefixed.
  Previously stored, unprefixed data is not automatically moved and is no longer
  accessible through those nodes. Before upgrading, inventory affected workflows
  and their data, back up the relevant stores, and arrange an operator-reviewed
  transition for data proven to belong to those workflows. Never bulk-copy host
  feature data into `wf:`: that would expose private data to workflow runs.
  Quiesce affected workflows during the transition; mixed old/new instances
  address different stores. The rolling-safe declaration above covers the schema,
  not this workflow data transition. Deployments without affected workflows need
  no data move. No migration command is supplied or run automatically.
- **Existing OpenSearch indexes require a rebuild (#5355).** This applies only
  when the search adapter is OpenSearch. The new binary uses different physical
  index names and does not read the old indexes. Inventory affected tenant/index
  pairs, back up their data and mapping/settings, and arrange a reviewed rebuild
  from authoritative tenant-scoped source data before switching traffic. Old
  physical indexes may contain data from multiple logical tenant/index pairs
  because of the previous naming collisions: do not copy an entire old index
  into one tenant without proving every document belongs there. Quiesce affected
  writers while transitioning and verify tenant isolation, counts and queries
  before resuming. Preserve backups and old indexes until the reviewed rollback
  window ends. Apply the workflow `wf:` transition as well where relevant. This
  release supplies no automatic data migration; the rolling-safe schema claim
  does not cover mixed-version OpenSearch reads and writes.
- After the upgrade, verify both deployed build stamps and `/readiness`
  reporting `version: "0.8.0"`.

## [0.7.0] — 2026-10-23

PRs since v0.6.0. No schema or app migrations, rolling-safe, no required stop.
A MINOR release under ADR 0052 §D1: it adds features (callAI attempt
accounting and retry policy, the operator-access panel and sweep, an animated
journey hero). It also carries two security fixes: a patched Node.js runtime and a
sub-workflow interrupt guard.

### Added

- **callAI attempt accounting and a per-call retry policy (ADR 0966, RFC 0248).**
  `ctx.callAI` reports every provider attempt it made (count, output tokens, usage
  completeness, whether a reply was replayed) and honours a per-call `retry`
  policy, capped (#5139). Advertised as `aiProviders.callAccounting` with the
  conformance suite pinned to 2.46.19 (#5142). Certified in production: major-2
  cut `f98d673d761f`, 468/0/11/372.
- **`OPENWOP_CONFORMANCE_CALLAI_FIXTURE` (ADR 0967).** An operator opt-in, off by
  default and ignored in the `auth` posture, that registers the one conformance
  node witnessing RFC 0248. Without it, the advertised behaviour is real but
  unwitnessed. Its mock scripts are scoped to the run, and a replay reads the
  recorded attempts (#5147).
- **Operator access for KickTodo (ADR 0910 P2–P3).** A boot and hourly
  operator-access sweep with a readiness check (#4995), and an Operator access
  panel with step-up re-authentication, MFA and a countdown (#4994).
- **CMS journey hero animation.** The journey visual draws in, days pop and one
  goal pulses; reduced motion is respected (#4993).

### Fixed

- **Secret redaction** keeps readable word slugs out of the opaque-blob rule, so
  public URLs (such as blog canonical URLs) are no longer replaced with a
  placeholder (#4992).
- An adopter bundle's default frontend build is budgeted without its
  `.env.production` (#5140).
- Tracegate's daemon re-runs its own misses alone and keeps its logs (#5138).

### Security

- **Node.js 22.23.4 base image.** The backend image's digest-pinned `node:22-slim`
  moves to the 2026-10-21 security release: CVE-2026-111497 (Brotli decoder
  out-of-bounds write), CVE-2026-105482 and CVE-2026-106069 (TLS/DNS hostname
  bypasses), four medium/low CVEs, and the CA store update for the compromised
  eMudhra intermediate (#5146).
- **Sub-workflow interrupts.** A child workflow's mirrored gate can no longer be
  resolved through the parent run (#5127).
- **Dependencies.** dompurify 3.4.17 (GHSA-cg2g-xh64-v4q7, critical; plus two
  more) (#5143); markdown-it denial of service (#5130).

#### Upgrading from 0.6.0

- **No required stop.** Schema (sqlite 50 / postgres 48) and app migrations (24)
  are unchanged, so a rolling deploy is safe.
- **Rebuild your image.** The Node.js fix only reaches you when the backend image
  is rebuilt from this release's `Dockerfile`. A running 0.6.0 image keeps the old
  base. If you build from your own base image, move it to Node 22.23.4 or later
  (or 24.22.1 / 26.12.1).
- **No breaking config.** `OPENWOP_CONFORMANCE_CALLAI_FIXTURE` is new and off by
  default. Leave it unset unless you publish conformance evidence.
- After the upgrade, `/readiness` reports `version: "0.7.0"`.

## [0.6.0] — 2026-10-20

PRs since v0.5.1. No schema or app migrations, rolling-safe, no required stop.
A MINOR release under ADR 0052 §D1: it adds features (campaign operations, ads
conversions, email approvals, per-deployment custom-domain edges, knowledge-base
retrieval). One setting was removed (see Upgrading).

### Added

- **Campaign operations, P0 (ADRs 0921–0927).** Client accounts, an asset
  registry and a CMS page adapter (#5015); change sets with version-bound
  approval, verified execution, an operator inbox and a demo agency (#5022).
- **A rate limit shared across instances for public token surfaces (ADR 0934
  P0).** Hashed keys in a compare-and-set fixed window (#5026).
- **Email approvals and versioned templates (ADR 0905).** Immutable template
  versions with history, diff and restore (#4922); an `email-campaign-send`
  approval kind and an email approval gate (#4928).
- **Ads (ADR 0907).** Account-wide metrics with conversions, a 7-day look-back
  and backfill (#4935); TikTok and LinkedIn metric readers, off until verified
  against a sandbox (#4936); Google conversion uploads and relay match quality
  (#4937); hourly conversions delivery, off by default, with consent re-checked
  at send (#4938).
- **Knowledge base retrieval (ADR 0904).** Fair cross-collection fusion,
  calibrated relevance and a retrieval eval (#4926); query-aware embeddings on
  BYOK providers (#4976); structure-preserving DOCX/PDF parsing with page
  numbers and chunker v3 (#4978).
- **Per-deployment custom-domain edge (ADR 0906).** An edge-certificate provider
  port and adapters with ordered release (#4930); edge lifecycle,
  notifications and an HTTPS UI (#4931); an operator script for the one-time
  edge (#4921); the adapter impersonates a dedicated service account (#4985).
- **System site profiles (ADR 0931).** A per-distribution site profile and
  optional seeds (#5000).
- **Ambient work graph (ADR 0930).** Patterns belong to the person who did the
  work (#5011).
- **Just-in-time kicktodo-operator activation (ADR 0910 P1)** with use-time
  expiry and audited self-approval (#4969).
- **CMS section styles (ADR 0920).** Tones, split heads, new column layouts,
  plan and chat visuals (#4968).
- `VITE_BRAND_PRIVACY_URL` for the app's Privacy links (#5003).
- `OPENWOP_RETENTION_SWEEP_DRY_RUN` previews the retention sweep (#5002).
- A build-time legacy cache purge for a replaced service worker (ADR 0873 D13,
  #4999).
- RFC 0245: a recorded tool error replays as an error; conformance pin 2.46.18
  (ADR 0929, #4989).

### Changed

- Pack pins live in one table and resolve lazily (ADR 0919, #4971); `createApp`
  resolves a pin only for a pack it installs (#4990).
- One GCP metadata-server client (#4977); the approvals separation-of-duties
  core moved to `host/approvalSelfCheck.ts` (#4941).
- The frontend ships react-router's production build (−433 B entry gzip, #5024).
- `bump-version` writes the lockfiles' root version, and the lockstep check
  reads it (#4988).

### Fixed

- **Custom domains fail closed on lookup errors**, with one canonical host and a
  leased sweep (ADR 0906 P0, #4919).
- **Ads:** API versions un-retired, TikTok conversions fixed, relay rows erased,
  sandbox harness (ADR 0907 P0/P1, #4920).
- **Proposals apply honestly (ADR 0938).** A transition table with CAS, apply
  bound to what the reviewer saw, and authorized reads. With no installer
  registered, every apply is refused rather than reported as installed (#5019).
- **Goals:** who may act on a goal, and what the judge may read (ADR 0908,
  #4939).
- The builder's workflow menu paints above other cards and is no longer clipped
  in list view (#5034).
- **Deleting your own account cancels its Stripe subscriptions first**, revokes
  what it delegated in other workspaces (API keys, CLI logins, pairings) and
  emits `host.users.user.erased`. If the cancel fails, nothing is deleted
  (503) (#5001).
- **A superadmin can decide reviews on the reserved system site.** That org has
  no members, so its content reviews were undecidable (403). Every real org
  still needs `host:members:manage` (ADR 0027, #5042).
- Call-to-action, form, product-grid and entity section headings carry the same
  anchor id as other headings, so in-page links to them work (#5045).

### Docs

- ADRs 0906 (decisions), 0921–0928, 0933–0934, 0938, 0939, 0940, and the
  Campaign Studio program (ADRs 0941–0962).

#### Upgrading from 0.5.1

- **Required stop:** no. No schema or app migrations (sqlite 50 / postgres 48,
  app 24, as 0.5.1). Back up, deploy, check `/readiness` reports
  `version: "0.6.0"`.
- **Removed:** `OPENWOP_PROPOSALS_ACTIVATION` (ADR 0938 D2). Its
  `approval-gate` value only ever minted orphan approvals. If you set it, it now
  has no effect; remove it.
- **New optional settings**, all off or unset by default:
  - `VITE_BRAND_PRIVACY_URL` (frontend build);
  - `OPENWOP_RETENTION_SWEEP_DRY_RUN`;
  - `OPENWOP_SYSTEM_SITE_PROFILE`, `OPENWOP_SYSTEM_SITE_SEEDS_DISABLED`;
  - the custom-domain edge: `OPENWOP_CUSTOM_DOMAIN_EDGE`,
    `OPENWOP_CUSTOM_DOMAIN_EDGE_PROJECT`, `OPENWOP_CUSTOM_DOMAIN_EDGE_SA`,
    `OPENWOP_CUSTOM_DOMAIN_EDGE_HOSTNAME`, `OPENWOP_CUSTOM_DOMAIN_CERT_MAP`,
    `OPENWOP_CUSTOM_DOMAIN_LB_IP`, `OPENWOP_CUSTOM_DOMAIN_EDGE_POLL_MS`
    (see ADR 0906);
  - ads: `OPENWOP_ADS_VERIFIED_READERS`, `OPENWOP_ADS_VERIFIED_SENDERS`, and the
    `OPENWOP_ADS_SANDBOX` / `OPENWOP_SANDBOX_*` harness (ADR 0907).

## [0.5.1] — 2026-10-18

Ten PRs since v0.5.0. No migrations, rolling-safe, no required stop, no breaking
config. **Versioning note:** this release carries new features, which ADR 0052
§D1 would make a MINOR bump (0.6.0); it is labelled 0.5.1 by the maintainer's
decision. Nothing in it changes a migration or a contract.

### Added

- **White-label adoption seams (ADR 0916).** Two brand tokens with unchanged
  defaults: `--rule-control` (a text field's border) and `--ink-muted-recess`
  (muted text on the recess fill), both lifted in More-contrast mode. A frontend
  feature may ship its own nav-label translations (`navMessages`, keys under its
  own id). The Keys page recognises a key pasted under the wrong vendor's card
  and offers to move it. The deploy scripts take `OPENWOP_DEPLOY_BRANCH`
  (default `main`) for a distribution whose release branch has another name.
- **Feature-surface requirements in the node catalog (ADR 0917).** A pack node
  may declare `x-requiresFeatureSurfaces`; the per-tenant node catalog marks it
  missing while that feature is off, so the palette stops offering what a run
  would refuse.
- **A declared entry share for white-label distributions (ADR 0874
  amendment).** `distributions/<name>.json` may declare `entryShareBytes`
  (gzip, at most 1024) with an `entryShareReason`; that distribution's entry
  budget is the host's 129 kB plus the share, reported separately. The default
  build keeps 129 kB.

### Changed

- **Chain expansion ids fold nested parameter values (ADR 0917).** Two
  expansions that differ only in a nested value no longer share an id. Ids for
  flat parameters are unchanged; stored workflows and their runs keep theirs.
- **Default workspaces are rooted in membership for authority (ADR 0910 P0).**
- The frontend CI lane enters Tracegate early (ADR 0918).

### Fixed

- **An email campaign sends the content it started with (ADR 0905 P0).** A send
  now pins the template's subject and body when it starts, so editing the
  template while the campaign is sending no longer changes the rest of that send;
  a resend re-pins. Deleting a template that a campaign not yet sent still
  references is refused with `409 template_in_use` (naming the campaigns).
- **Revoked v2 chain packs no longer load (ADR 0713 A-04).** The keyring's
  revocation list now applies to v2 chain packs as it did to v1; a zero-install
  boot names the error.
- **`check-wire-claims` fails closed** when it cannot build its expected
  document, instead of passing a 1.x host with the field missing.
- A webhook delivery test no longer collides on a port (WHD-19).

### Docs

- ADRs 0904–0907: the MyndHyve port slate (RAG, email approval, custom-domain
  certificates, ads).

#### Upgrading from 0.5.0

- **Required stop:** no. No schema or app migrations (sqlite 50 / postgres 48,
  app 24, as 0.5.0). Back up, deploy, check `/readiness` reports
  `version: "0.5.1"`.
- New optional settings: `OPENWOP_DEPLOY_BRANCH` (deploy scripts), and the
  distribution manifest keys `entryShareBytes` / `entryShareReason`.

## [0.5.0] — 2026-10-18

Eight days since v0.4.0 (255 merged PRs; ADRs up to 0915). Rolling-safe, no
required stop, no breaking config.

### Added

- **Turning a bundle on is a workspace action, and buying one turns it on (ADR 0892
  Phase B).** On the feature store, a workspace owner or admin can enable an
  entitled bundle for their own workspace, or turn it off, from the bundle's card.
  Enabling also turns on what the bundle depends on. It is refused when the plan
  does not cover the bundle (the card offers the purchase) or when the host has
  switched part of it off. A verified bundle purchase now turns the bundle on for
  the buyer's workspace. Before this, a buyer received an entitlement and the
  features stayed hidden. Global toggle state stays super-admin only.
- **No hard-coded AI vendor (ADR 0903).** A run's AI provider and model come from
  the run's own choice, then the workspace's AI setting, then the catalog default,
  fixed once at run start so replay stays deterministic. Feature packs and the
  bundled chain packs no longer default to Anthropic; `core.openwop.ai` 1.5.0 makes
  `provider`/`model` optional. A sub-workflow child inherits the parent's choice
  and the host's provider policy.
- **Provider failures say what they are, and structured output is native where
  the vendor supports it (ADR 0911, ADR 0912).** A rejected key, model or request
  fails at once with its own code; a rate limit is not retried a second time; a
  5xx or timeout backs off and retries, and a run that ends on one fails with
  that code instead of "did not emit valid JSON". Gemini calls ask for JSON with
  a response schema and OpenAI calls use `json_schema`; a retry names what was
  wrong; an unescaped quote is repaired when the result then parses; an
  unparsable reply leaves a short, scrubbed excerpt on the retry event. New knob:
  `OPENWOP_PROVIDER_RETRY_BACKOFF_MS` (default 1000, 0 disables).
- **Seams for white-label features (ADRs 0913–0915).** `from-chain` takes an
  optional `subject` label, and `eraseWorkflowSubject` deletes exactly that
  subject's workflows and their runs (through the workflow index, refusing under
  a legal hold). A feature can register a document kind that is deleted, not
  anonymized, on its owner's erasure. `baseVersionId: null` makes a document's
  first save a checked one. The Markdown editor takes a content `lang`; the EPUB
  and DOCX writers take `language`/`direction`, and DOCX images carry alt text. A
  backend feature can declare public paths strictly inside its own namespace.
- **Agent evaluations (ADR 0889).** `mode:"eval"` runs, an eval-suite store,
  RFC 0244 graders (trajectory, trials, regression, efficiency, output) and an
  Agent Evals tab with capture-to-case.
- **Approval and session authority (ADRs 0894, 0896).** Approvers approve what
  they saw, with one decider per approval and a per-approval expiry; sessions bind
  to their opener and org, and one-shot approvals are verified.
- **Commerce (ADRs 0877, 0890).** Checkout tax, promotion codes and no-card
  trials. A storefront takes live money only on the operator's own account or the
  tenant's own Stripe Connect account; every other tenant is demo.
- **Support desk (ADR 0878)**, per-slide comments (ADR 0886), comment mentions and
  edit-own (ADR 0881), the team-ledger GitHub check (ADR 0855), and the offline
  service-worker engine (ADR 0873).
- **Table storage conforms to its declared schema (ADR 0909, RFC 0228 G4)**, and
  streams are bounded server-side with readers resuming (ADR 0897).

### Changed

- **CRM is an opt-in bundle (ADR 0892).** The `crm` toggle now defaults **off**,
  so a fresh white-label install no longer shows the CRM group. Analytics stays
  on and its nav item moved to the Marketing group. Enable CRM in Admin → Feature
  toggles (globally or per workspace).
- **Strategy, Priority matrix and Advisory board are opt-in too (ADR 0892,
  superseding ADR 0229).** They now default **off**. Enable them in Admin →
  Feature toggles.
- **KicktoDo surfaces bind to the run's person (ADR 0901)**, and a coach turn can
  only create work for that person.
- The display face is Bricolage Grotesque (ADR 0883).

#### Upgrading from 0.4.0

- **Required stop:** no. Rolling-safe: back up, deploy, check `/readiness`
  reports `version: "0.5.0"`.
- **Schema migrations:** Postgres 48 / SQLite 50 delete webhook subscriptions
  registered under the retired OpenWOP major 1 (and their pending deliveries).
  Those already received nothing; delivered history stays.
- **App migration 23** (`grandfather-crm-on-for-existing-users`) keeps CRM **on**
  for an install that already uses it: it writes an enabled `crm` toggle row when
  none exists and the database has CRM contacts or an enabled CRM dependent
  (commerce, csm, email, territories, job-search, …). An install with a saved
  `crm` row, or with no CRM data, is unchanged.
- **App migration 24** (`grandfather-planning-on-for-existing-users`) does the same
  per feature for `strategy`, `priority-matrix` and `advisory-board`: an install with
  data for one of them and no saved row keeps that one on.
- New optional env: `OPENWOP_PROVIDER_RETRY_BACKOFF_MS`.

## [0.4.0] — 2026-10-10

One day since v0.3.0 (2026-10-09): 80 commits and four new architecture decision
records (ADRs 0869–0872). A MINOR release: new capabilities, no schema or app
migrations, no required stop, and nothing an operator must change.

#### Upgrading from 0.3.0

- **Required stop:** no (`releases.json`).
- **Migrations:** none. Postgres schema stays **47**, SQLite **49**, app
  migrations **22**.
- **Rolling-safe:** yes. A 0.3.0 process may share the database during a rolling
  deploy. Kanban cards a 0.3.0 process writes during the overlap are stamped with
  their tenant on the next hourly tick (ADR 0872). Take a backup first as usual.
- **New optional settings (ADR 0871), all with working defaults:**
  `OPENWOP_STORAGE_GROWTH_GAUGE` (`false` turns the hourly gauge off; on by
  default), `OPENWOP_SURFACE_ROW_TRIGGER` (default `100000` rows per tenant per
  family), `OPENWOP_VECTOR_NAMESPACE_TRIGGER` (default `50000` vectors per
  namespace), `OPENWOP_VECTOR_PG_STATEMENT_TIMEOUT_MS` (default `30000`) and
  `OPENWOP_VECTOR_QUERY_WARN_MS` (default `200`).
- **Discovery advertises `multiAgent` only when you switch it on.** It appears
  when `OPENWOP_MULTI_AGENT_EXECUTION_MODEL` is set, and its
  `executionModel.version` is the highest phase N with every
  `…_PHASE_2`..`…_PHASE_N` flag also set; with phase 1 off the block is absent.
  The `agents` family now carries `dispatch: true`. Check these flags if a client
  relies on the `multiAgent` block.
- **Image-mode deploys build no certification bundle** (ADR 0869). `deploy.sh`
  without `OPENWOP_CERT_BUNDLE_ORIGIN` no longer refuses to ship for want of a
  stamp; it still runs the major-2 ratchet. To serve evidence, set the origin and
  run `publish-evidence.sh`.
- **After upgrading:** `GET /readiness` → `200` and its `version` reads `0.4.0`.
  Within an hour, the logs carry `surface_rows_gauge` lines; about three hours
  after the first hourly tick, `tenant_index_verified collection=kanban:card`.

### Added

- **An hourly storage-growth gauge** (ADR 0871). Once per UTC hour, across all
  instances, the host logs `surface_rows_gauge` (per durable surface family:
  tenants, the largest tenant's rows, the total, tenants over the trigger) and,
  with pgvector, `vector_rows_gauge` (namespaces, the largest, the total, the
  pgvector version). No line carries a tenant id or a namespace. A pgvector
  query of 200 ms or more logs `vector_query_slow`, and the vector pool now has
  a 30 s `statement_timeout` (it had none). `scripts/measure-storage-growth.mjs`
  reads the lines back and reports each trigger as CLEAR, TRIGGERED or
  UNMEASURED.
- **Work-Twin portfolio cards say which workflows are demos** (ADR 0870). A
  workflow built on the demo AI node shows a "Demo" chip and a one-line
  explanation, and Run now is disabled, with the reason, on a deployment that
  cannot run it (sign-in posture). New non-normative route:
  `GET /host/openwop-app/workflows/availability?ids=…`. ADR 0870 also plans
  real-AI Work-Twin workflows; those decisions are still Proposed.
- **Approved sends check Google permissions first.** An approved email or
  calendar action now checks that the approver's Google connection is present,
  current and allowed to write before it starts a run. If not, nothing runs and
  the notice gives numbered steps to reconnect with write access. A send Google
  refuses with `401`/`403` gives the same steps.

### Changed

- **Kanban card reads use a tenant index** (ADR 0872). Every card now records
  its board's tenant, and once the hourly check has verified the index, board
  views, the dashboard, "assigned to me" and card create/move read one tenant's
  cards instead of every card. Creating a card on a board that does not exist
  answers `kanban_board_not_found`. Cards whose board is gone are logged
  (`kanban_card_unstamped_orphans`), never deleted, and keep reads on the full
  scan.
- **Authorization reads use the members index** (ADR 0866 D4). Access checks
  read one tenant's members once the index is verified. A member the index lacks
  is confirmed against the full scan before any deny, self-approval exemption or
  demo-mode owner bypass, so the index can only say yes.
- **The 44 Work-Twin `tmpl.*` templates are a chain pack** (ADR 0775 P2a–c).
  They load from `vendor.openwop-app.workflows.work-twin-templates@1.0.0` under
  their original ids, byte-identical, so past runs replay unchanged. They stay
  hidden from `/builder` and the `/` picker. A host with
  `OPENWOP_WORKFLOW_CHAIN_EXAMPLES=0` no longer has these ids.
- **`scripts/preflight-deploy.sh` refuses a deploy while a Cloud Run revision is
  tagged** (Gate 5b), and prints the `--remove-tags` command. `--allow-tagged`
  keeps a deliberate tag.
- **Image-mode `deploy.sh` builds no certification bundle** (ADR 0869); see
  Upgrading.
- **The desktop shell runs Electron 41** (was 39), closing the Electron
  advisories.

### Removed

- **The v1 discovery builder** (ADR 0812 P4). `/.well-known/openwop` serves only
  the v2 root, and the `Capabilities-Etag` header, which only the v1 response
  set, is gone. The in-tree `tmpl.*` workflow catalog is deleted (see Changed).

### Fixed

- **Attestation verification reported `discovery_drift` on every v2 host.** It
  re-digested the v1 document instead of the root actually served. The certify
  stamp also pointed at the retired `/v1` bundle path.
- v2 discovery advertises `scheduling` again (`cron`, `delayed`,
  `maxFutureHorizon: P366D`). It had been missing from the v2 root since v1
  retired, so the horizon the 0.3.0 notes announced was stated nowhere.
  `workspace` is still not advertised: it is missing a required event (ADR
  0858).
- v2 discovery advertises `multiAgent` again. `executionModel.version` is now
  the highest phase N with every phase 1..N switched on, so a gap in the phase
  flags caps the claim. v1 could claim 5 with phases 2 to 4 off. The verifier
  level (6) is not claimed. The escalation interrupt kind is `clarification`,
  which is what the host emits; v1 named an `x-host-…` kind it never sent. The
  phase-3 gate (getRunAncestry) now honours `…_PHASE_5`.
- v2 discovery advertises `agents.dispatch: true`. `core.dispatch` runs
  workers as child runs and never changes the parent's workflow graph. The v1
  fan-out descriptor has no v2 seat, so it is withheld.
- v2 discovery states `auth.subjectLinkKey` only when both the `saml` and
  `scim` lanes are advertised. A host with one lane forms no links, so it
  no longer claims a link key (spec-steward ruling 2026-10-10; matches v1).
- **Reconnecting a Google connection left a dead duplicate "Needs reconnecting"
  row.** A successful consent now retires the same person's inactive twin rows
  for that provider. An active twin is left alone.
- **A document that does not exist showed "Couldn't load" with a retry** instead
  of "not found". The page now reads the error's status.
- **In a collaborative document, one user's undo could undo another user's
  edits** (ADR 0335). The editor's own undo history is now actually off, so only
  the collaborative undo runs.
- **`npm run selftest` in `clients/desktop` hung** instead of exiting 0 or 1
  (a relative self-test directory). It now runs.

### Security

- **A refused registry pack deleted the good install it was replacing** (ADR
  0660 D3). The installer re-checked `pack.json` only after removing the old
  install and copying the new one, so a tampered tarball was refused with its
  files already on disk. The check now runs on the staged bytes first.
- **The three audit exceptions are closed, not renewed.** Knowledge-base PDF
  parsing uses the patched `pdfjs-dist` 6.2.108 instead of unpdf's vendored
  pdf.js (GHSA-hq66-cqwq-w95j). The SPA depends on `@firebase/app` and
  `@firebase/auth` directly, which drops Firestore's `@grpc/grpc-js`
  (GHSA-m9gg-hp2v-232j, GHSA-f596-whhp-79r4). `scripts/audit-exceptions.json` is
  empty.
- **Dependency updates close 17 of 20 open backend and frontend Dependabot
  alerts** (lockfile only, every bump within its existing range): `fast-uri`,
  `markdown-it`, `moment`, `source-map-js`, `mammoth`, `brace-expansion`,
  `browserslist` and others. Three stay open: `vitest`/`@vitest/mocker`
  (dev-only) and `katex` (low; the bundled copies are pinned by `mermaid` and
  the math plugins).

## [0.3.0] — 2026-10-09

Two weeks since v0.2.0 (2026-09-27): 1,549 commits and **108 architecture decision
records (ADRs 0759–0867)**, each in `docs/adr/`. The headline: **OpenWOP v1 is
retired** — this host now speaks only the v2 protocol. `0.x` caveat applies: this
MINOR bump carries breaking changes (listed under **Upgrading**), as SemVer §4
permits before 1.0.

#### Upgrading from 0.2.0

- **Required stop:** no (`releases.json`). There is no intermediate version.
- **Migrations (replay forward on boot, no manual step):** Postgres schema
  **46 → 47**, SQLite **48 → 49** (one nullable `invocation_log.presented_key`
  column, no backfill, no table rewrite), app migrations **21 → 22** (a no-op
  marker; its cleanup runs in the background after the server listens and records
  `app_bg_job:internal-seed-retract` = `done`).
- **Rolling-safe:** the schema changes are additive, so a 0.2.0 process may share
  the upgraded database during a rolling deploy. Take a backup first as usual.
- **Breaking — OpenWOP v1 is removed (ADR 0669, ADR 0812).** Discovery advertises
  only `protocolVersions ["2.0"]`; every `/v1/*` request (WebSocket upgrades
  included) answers `410`, public read twins answer a bodiless `308` to their
  unversioned address, and a `1.x` client is refused with `426`.
  `OPENWOP_V1_RETIRED` no longer exists — there is no switch to serve v1 again.
  Move every integration (SDKs, webhook subscribers, scripts, the CDP collection
  snippet) to the unversioned v2 paths before upgrading. Stored run links and
  asset addresses keep working.
- **Breaking — chain packs must pin nodes exactly (ADR 0766).**
  - **Operator-supplied chain packs** (`OPENWOP_WORKFLOW_CHAIN_PACKS_DIR`, or a
    registry-installed chain pack) that reference nodes without an exact version now
    fail to load. Run `( cd backend/typescript && npm run chains:pin -- --write )`
    against your packs (or pin by hand as `typeId@x.y.z`), then bump each pack and
    each changed chain one patch. Watch `checks.chainPacks.refused` on `/readiness`.
  - Packs you publish to a registry for this host must be signed for the **v2
    tree** (`ed25519-canonical-json`) with `engines` admitting `<3.0.0`.
- **Trusted proxies (ADR 0851):** if a load balancer or CDN with a public address
  (other than Google's front end) sits in front of the backend, set
  `OPENWOP_TRUSTED_PROXY_CIDRS` to its ranges, or every user shares one rate-limit
  bucket.
- **SAML deployments (ADR 0815):** after the bootstrap org, only an `owner` of an
  existing org in the shared SAML tenant can create orgs — grant `owner` before
  upgrading if others need to.
- **Public-site analytics consent (ADR 0860):** with no geo header configured every
  visitor is asked before analytics counts; set `OPENWOP_GEO_COUNTRY_HEADER` behind
  an edge that overwrites it to default "on" outside regulated regions.
- **Scale-out hosts (ADR 0867):** a host running more than one instance (Cloud Run
  and similar are detected; `OPENWOP_INSTANCE_TOPOLOGY` overrides) no longer
  advertises a storage family backed by process memory, and logs
  `storage_families_withheld_process_local`. Select a shared backend
  (`OPENWOP_SURFACE_BACKEND=durable` on Postgres Storage, `OPENWOP_SURFACE_VECTOR=pgvector`,
  `OPENWOP_SURFACE_BLOB=gcs|s3`); a selected engine must pass its boot check or the
  process exits.
- **Defaults that moved:** `builder-pair` is ON (the Create-with-AI drawer is gone);
  the managed free tier is 150,000 tokens per member per day unless
  `OPENWOP_MANAGED_DAILY_TOKEN_CAP` is set; major-2 host-event webhooks use the
  `openwop-app.<feature>.<entity>-<verb>` spelling (RFC 0236 delivery stays behind
  `OPENWOP_HOST_EVENTS_V2`, default off).
- **After upgrading:** `GET /readiness` → `200`, its `version` reads `0.3.0`, and
  `checks.chainPacks.refused` / `checks.registryPacks.failed` are empty.

### Removed
- **OpenWOP major 1 (ADR 0812 P3c).** The served-v1 shim, the `/v1` route
  registrations' rewrite path, the v1 deprecation headers and the
  `OPENWOP_V1_RETIRED` switch are gone; `/v1/*` answers `410` and the ADR 0806 public
  twins `308`. The SPA reads discovery at major 2 only and no longer depends on
  `@openwop/openwop-v1`.

### Added

- **Visitors choose analytics on the public site** (ADR 0860). The front page, docs and funnel pages now ask visitors in the EEA, the UK and California, and any visitor whose region is unknown, before counting anything, with "Accept analytics" and "Reject analytics" side by side. Everywhere else analytics is on by default, and a "Privacy choices" control in the footer turns it off. The choice is recorded on the existing public consent lane. **Upgrading:** with no geo header configured, every visitor's region is unknown, so everyone is asked — including on a tenant whose consent policy says opt-out. To default to "on" outside regulated regions, put an edge that overwrites a country header in front and set `OPENWOP_GEO_COUNTRY_HEADER` (see `.env.example`).
- **The visitor key is stored only after consent** (ADR 0860). The public pages used to write `owp:vk` to the browser on every visit. The key is now written only when the visitor's choice (or their region's default) allows it, is removed when they refuse or withdraw, and is per site (`owp:vk:<orgId>`). The old key is deleted.
- **Workspace settings say that feature usage is counted** (ADR 0860). The Privacy panel now states that the product counts which features members use, in aggregate.

- **CMS prose blocks** (ADR 0813). A `richText` section now renders `### ` subheadings, `- ` and `1. ` lists, and `> ` quotes, in the app and in the crawler HTML. Plain paragraphs render as before, and there is still no raw-HTML path.
- **Blog post settings in the CMS editor** (ADR 0813). Mark a page as a blog post, set its category, and set yourself as the byline. The page routes accept `authorId: "me"`, resolved to the caller.
- **The launch blog post, as a draft** (ADR 0813). "10x Your Company = Your Team + AI Agents" is seeded on the system site with its two diagrams. It is never auto-published: finish its `[TODO]` markers and publish it from the CMS.
- **A Media library for the public site** (ADR 0817). A super admin can upload and pick images for the "Front page (public site)" scope, in the CMS editor's image picker and on the Media Library page. Before, that scope had no library, so changing a public-site image needed a code change.
- **Seeded updates after you edit** (ADR 0817). When the code that created a page has newer content but you have already edited or published the page, the update now appears in the page's History as a "Seeded update". Compare it, then Restore to use it. Your edits are never overwritten.
- Pack node entries may declare `"x-ports": "single"` (ADR 0782): the builder keeps one input port whatever the input schema's `required` says, so a schema can state its real contract without re-routing saved edges. The 17 `feature.kicktodo.nodes` input schemas get their `required` fields back (pack 1.30.3). The agent-orchestration nodes group under AI in the palette (`vendor.myndhyve.agent-orchestration` 1.0.3).
- `scripts/write-build-commit.mjs` stamps `build-meta/deployer.json` on the deploy path only (the checkout's directory name and a session slug: `OPENWOP_DEPLOY_SESSION`, else the agent's `CLAUDE_CODE_SESSION_ID`), so a production build can be traced to the session that made it. It ships in the source upload and the image, and is never served. The workflow-author model is told about single-port nodes, and `validate`/`persist` reject a `targetInput` edge into one.

- `/readiness` `checks.registryPacks` (boot-time registry install: attempted,
  installed, failed with a `code`, skipped with a reason, `bootAt`) and
  `checks.chainPacks` (chain packs loaded / refused). `scripts/verify-deploy.sh`
  fails a revision reporting either kind of failure; the named waivers are
  `--allow-registry-failures` and `--allow-chain-pack-failures`.
- A run whose definition pins a node version the host runs differently is
  stamped `metadata.nodePinMismatches` and logged `run_node_pin_mismatch`.
- A directly submitted workflow definition may pin nodes (`typeId@x.y.z`). The
  pin is kept in `metadata.nodePins`; ranges are refused.
- `scripts/check-registry-parity.sh` reports a **version collision**, a
  `name@version` already published with different content.

### Fixed

- **A form submit could attach a stranger's browsing to an existing contact** (ADR 0860). A submission whose email matched an existing contact linked the submitter's session to that contact, so anyone who typed Bob's email could add their page views to Bob's lead score. A submission now links its session only to a contact it created. A match to an existing contact adds one "Submitted the form" note to that contact's timeline per form per day. A signed email-click link still re-identifies an existing contact.

- **A new CMS section lost its selection a moment after it was added.** Its first save gives it a permanent id, and the editor now follows the section to it.
- **Publish or Submit dropped unsaved edits in the CMS.** A workflow action ran on the last saved version and then replaced the editor with it, so edits made since the last Save were lost without a warning. The editor now saves first, and stops if the save fails.
- **The CMS "Public" preview was blank in Chrome, and covered the editor.** A frame with no `src` finishes loading before React listens, so the preview never filled. Its hidden stage was also still shown on the Editor and Outline tabs, so the empty frame sat above the section editor. Both are fixed.
- **Prompt templates revalidate to `304`.** `GET /prompts/{templateId}` compared `If-None-Match` with a bare string match, so a `W/`-weakened echo from a compressing front door, or a list, answered `200`. It now uses the shared matcher the discovery and run routes use, and the `304` carries the `ETag`.

- **Blog posts are articles to crawlers** (ADR 0813). The prerendered post now has its title as `<h1>` and `Article` JSON-LD with `datePublished`. The public page read carries `kind` and `publishedAt` for posts.

- **Host events are v2-conformant on the wire** (ADR 0792). A major-2 webhook subscriber now receives `openwop-app.<feature>.<entity>-<verb>` (for example `openwop-app.crm.contact-created`) in place of `host.<feature>.<entity>.<verb>`, in the body `type`, both event-type headers and the `hostext:` run marker. Major-1 subscribers are unchanged. A subscription or host-event binding may use either spelling. The run event `host.webhook.response` now reads on major 2 as `openwop-app.webhook-response` (it returned `500`).

- **Upgrading no longer hangs at boot on the ADR 0789 seeded-workflow cleanup.**
  App migration 22 retracted stale seeded-workflow listings inside startup, and
  on a large install it outlasted the platform's startup probe, so the new
  revision never became ready. Migration 22 is now a no-op marker. The cleanup
  runs in the background once the server is listening, resumes where it stopped
  after a restart, and records `app_bg_job:internal-seed-retract` = `done` when
  it finishes. It also scans the scheduler once rather than once per row.

- **Builder: on a node with several input or output ports, each connection handle now sits beside its own port label** (it drifted up to a row away, which could wire an edge into the wrong input field). Single-port nodes are unchanged.

### Security

- **Per-IP rate limits could be bypassed by sending `X-Forwarded-For`** (ADR 0851, #4516). The limiter keyed on the leftmost entry, which the client writes, so a new header value per request got a new budget. The client address is now read from the right, skipping known proxy hops, at every place the app uses it: rate limits, SSE stream caps, break-glass login, analytics visitor hashing, and the e-signature audit record, which had recorded the front end's address instead of the signer's. **Upgrading:** if a load balancer or CDN with a public address sits in front of the backend (other than Google's front end), set `OPENWOP_TRUSTED_PROXY_CIDRS` to its ranges, or all users will share one rate-limit bucket.

- **Organizations: a sub-org is no longer a door to workspace authority, and removal takes down what the member delegated** (ADR 0815).
  - In a shared workspace, workspace-wide authority now comes from the member's workspace (root) membership only. A role in a sub-org is authority inside that sub-org.
  - Creating an org in a tenant shared by several people is owner-tier. Before this, any signed-in member could create a sub-org, become its owner, and manage the workspace.
  - Owner rows are judged per person: a group-derived owner, or an owner reached through a duplicate row, counts as an owner.
  - A member's identity can no longer be re-pointed in place.
  - Removing or demoting an admin cancels the invites they sent. Leaving a workspace pauses the schedules that ran as that person; resuming one re-owns it.
  - New host events: `host.orgs.member.added`, `host.orgs.member.roles-changed` and `host.orgs.member.removed`.

  **Operator action (SAML deployments):** every SAML user signs into ONE shared tenant (`OPENWOP_SAML_TENANT`, default `default`). The first org created there is still the bootstrap. After that, a user can create orgs only if they are an `owner` of an existing org in that tenant. Grant it from Organizations → Members ("Transfer ownership" or the `owner` role), or add the user to a group that carries `owner`.

  OIDC sign-in, the anonymous demo and personal workspaces are unaffected: each user has their own tenant there. No migration and no new env var.


### Changed
- **Pair Canvas is on by default** (ADR 0773 G-10e). The builder's AI pairing (ghost suggestions you keep or drop) replaces the Create-with-AI drawer, which is removed. Turn the `builder-pair` toggle off to hide AI pairing in the builder.
- **The managed free tier's default daily allowance is 150,000 tokens per member** (was 50,000, smaller than one Pair Canvas first draft). It is the free portion spent before plan credits and paid balance (ADR 0821), so operators who sell AI credits may want it lower. An explicit `OPENWOP_MANAGED_DAILY_TOKEN_CAP` still wins. On a login-free public demo, also set `OPENWOP_MANAGED_GLOBAL_DAILY_TOKEN_CAP`.

- **Edit sections right on the page** (ADR 0828). The CMS editor has Edit, Preview and Page tabs. On Edit, point at a section for its toolbar, click Edit to open it in place, drag its handle (or use the keyboard) to move it, and use "+" between sections to add one there. Page settings, History and experiments live on the Page tab. The side panels are gone.
- **A calmer CMS header** (ADR 0828). Publish (or Approve, for a page in review) is the one primary button, last in the row; "Check accessibility" and the assistant links move under More, and the in-place editor shows one card instead of two.
- **The CMS page editor is one screen** (ADR 0828). The section list, the live page and a settings panel sit side by side; selecting a section anywhere selects it everywhere. Drafts save themselves; a published page still saves only when you press Save. The Public, Outline and Editor views are gone.
- **Edit a page's address, search description and social image in the CMS** (ADR 0828). They sit on the editor's Page tab and save with the page. A published page's old address keeps redirecting.
- **Drag sections to reorder them, and undo** (ADR 0828). In the CMS section list, drag a section by its handle (or use the keyboard). Undo and Redo, or ⌘Z and ⇧⌘Z, step back and forward through your edits.
- **A visual section picker in the CMS** (ADR 0828). "Add section" shows every section type with a sketch of its layout and a line on what it is for. Filter by category or search; your shared sections are there too.
- **A checklist before you publish** (ADR 0828). Publish, Approve and Submit first show what still blocks the page (an empty title, a to-do left in the text), what is worth fixing (no author, description or social image, accessibility issues, untranslated sections) and what passed. "Show me" takes you to the spot.
- **Take single sections from History** (ADR 0828). Compare shows a past version, or a seeded update, beside your draft section by section; "Use this version" copies just that section into your draft, and Undo takes it back.
- **Rewrite a section with AI** (ADR 0828). On the CMS Section tab: Improve, Shorten, Expand, change the tone, fix spelling, or say what you want. You see the proposal beside the current text and apply it or discard it; links and images are never changed, and Undo takes it back.
- **Workflow-chain packs must pin every node reference exactly** (ADR 0766,
  RFC 0177 §E.1). The loader now REFUSES a chain whose node `typeId` (or
  compensation `nodeTypeId`) carries no version or a range. Every in-tree chain
  is pinned. `/readiness` reports refusals under `checks.chainPacks`.
- **Pack manifests are v2** (ADR 0767): `kind`, `engines` admitting major 2, an
  honest spec `category` with the palette group in `x-paletteCategory`, and node
  inputs as real schema files. Palette groups are unchanged except 62 nodes that
  previously fell to a default group.
- The template pre-flight and "Use template" name a node that is installed at a
  version other than the one the template pinned (`pinMismatches`), separately
  from a node that is not installed.

- **Schedules fire once, fenced in the job row, not a pruned claim** (ADR 0787).
  After winning a slot, the daemon re-reads the job and advances it by
  compare-and-swap, and only while the job is still enabled, still bound and
  still due at that exact slot. Consequences:
  - a pass that stalled past the claim prune fires nothing;
  - so does a job disabled, deleted or erased mid-pass;
  - each fire gets a deterministic run id per (tenant, job, slot), so a
    re-fired slot collapses to one run.
  Every job write is now a compare-and-swap, so a daemon write can no longer
  resurrect a deleted job or undo a disable or an erasure.
- **The scheduler door requires `workspace:write`** to create, edit, run or
  delete a schedule in a shared workspace. Viewers get `403`.
  - PATCH `metadata` merges, and can never set `actingUserId`.
  - Changing a job's `workflowId` makes it act as the person who changed it.
  - A feature-managed job cannot be retargeted there (`409`).
  - An erased job cannot be re-enabled (`409`).
- **Run now fires exactly what the schedule fires**: the job's inputs, its
  credentials and actor, and its feature gate. It never moves the next
  scheduled fire. When no run starts, the response carries `skipped: <reason>`.
- **`capabilities.scheduling.maxFutureHorizon` is now `P366D`** (was `P30D`),
  and the host honours it:
  - yearly, quarterly and 31st-of-month cadences fire;
  - an enabled schedule with an unparseable cron, an unknown time zone or no
    fire inside the horizon is refused with `400` (it used to be stored and
    never fire, or throw a `500`);
  - a cadence with no further slot records `lastSkipReason: 'no-next-fire'`.
- **Erasing a user also disables their schedules that carry their legacy
  `oidc:` principal.** This applies only in the user's home tenant, only when the
  principal comes from their own User row, and never when another User row there
  claims the same principal.
- **Schedules the old 30-day search stranded come back to life.** For example, a
  monthly `0 9 3 * *` whose next fire had been deleted. The daemon recomputes
  their next fire.
- `/readiness` for KickTodo lists `schedulerFleet`: every instance running the
  fenced daemon, with its Cloud Run revision and commit.

## [0.2.0] — 2026-09-27

The first versioned release since the inaugural `v0.1.0` (2026-06-30): three months
of work — 3,364 commits and **593 architecture decision records (ADRs 0172–0757)**,
each in `docs/adr/`. `0.x` caveat applies: this MINOR bump carries breaking changes
(listed under **Upgrading**), as SemVer §4 permits before 1.0.

### Highlights

The ADR titles, bucketed by keyword (approximate — an ADR is counted once, in the
first bucket its title matches; 161 fit no bucket):

- **OpenWOP v2 wire, RFC adoption & conformance** (~57 ADRs) — this host now speaks
  **both majors**: v2 identity (tenant-bound ids, the Subject as owner, the `ow2.`
  token scheme), the era key and codemap read path, the closed v2 snapshot, signed
  certification bundles published after every deploy, and host witnesses for
  RFCs 0199 (outbound OAuth client + credential interrupt), 0200/0201/0205/0206/
  0209/0210, 0173 (effect identity) and 0176 (persistence migration rows).
- **Workflows, chains, builder & execution** (~94) — chain packs and the builder
  gallery replace every in-tree built-in workflow; durable dispatch outbox, Layer-2
  effect ledger and atomic claim, replay/fork safety, webhook delivery isolation.
- **Agents, chat & AI exchange** (~47) — one embeddable chat, agent packs + node
  packs as the drivability pattern, standing roster, heartbeat/work loop, MCP + A2A.
- **Canvas, docs, slides & app builder** (~45) — shared canvas chassis with
  collaboration, slides, documents, drawings, app builder.
- **CRM, commerce, billing & marketing** (~97) — one content kernel, Stripe billing
  and Connect commerce, paid feature bundles, campaigns, CDP.
- **CMS, publishing & site** (~27), **Security, identity, orgs & BYOK** (~35),
  **Platform, deploy & operations** (~30).

The detailed entries below were recorded as the work landed (they cover the most
recent part of the window in depth; the ADRs are the complete record).

#### Upgrading from 0.1.0

- **Required stop:** no (`releases.json`). There is no intermediate version.
- **Migrations (replay forward on boot, no manual step):** Postgres schema
  **29 → 46**, SQLite **32 → 48**, app migrations **1 → 21**. All are forward-only;
  several are additive columns with no backfill.
- **Not rolling-safe — stop the 0.1.0 binary before starting 0.2.0.** Postgres
  migration 37 / SQLite 39 **renames** `invocation_log.provider_key` →
  `invocation_id`; a 0.1.0 process sharing the upgraded database fails on that
  table. Take a backup first; downtime is the boot-time migration window.
- **Breaking wire/config changes:**
  - **Webhook headers:** the pre-spec combined `openwop-signature: t=…,v1=…`
    encoding and the `openwop-subscription-id` header are **removed**. Verify with
    the `OpenWOP-*` (or `X-openwop-*`) family — same `${timestamp}.${rawBody}`
    recipe; the OpenWOP SDK helpers (TS 1.9.0 / Py 1.7.0 / Go v1.6.0) read both.
  - **Rate limiting split into two tiers (ADR 0640):**
    `OPENWOP_RATELIMIT_IP_REQS_PER_MIN` is now the **write** budget (default 60);
    reads use the new `OPENWOP_RATELIMIT_IP_READ_REQS_PER_MIN` (default 600, floored
    at the write budget, so an old raised value still lifts reads).
  - **Interrupt resume tokens change shape** (`ow2.hs256.<kid>.…`). Tokens issued
    by 0.1.0 keep resolving. Set **`OPENWOP_INTERRUPT_TOKEN_SECRET`** (new) — it
    falls back to a built-in value that is not a secret.
  - **`/v1` is unchanged for v1 clients.** v2 behaviour applies only to a request
    that negotiates `OpenWOP-Version: 2`.
- **After upgrading:** `GET /readiness` → `200` and its `version` reads `0.2.0`.

### Added
- **RFC 0209 — A2UI v0.9 surfaces at major 2 (ADR 0749).** The v2 root now advertises the envelope-kind catalog (`supportedEnvelopes` `["ui.a2ui-surface"]`, `schemaVersions` `{"ui.a2ui-surface": 2}`, `envelopeStrictness: warn`), printed from the same constant the new admission path enforces: the schema version selects ONE payload branch (never the union), the RFC's cross-field rules and the surface-fold guard are checked at record time, and an approval bound to a surface any untrusted envelope touched cannot be resolved (`untrusted_content_blocks_approval`). The `emitA2uiSurface` v2 seam drives it. The chat's A2UI card renders the ten-component v0.9 profile — and nothing of a surface until its fold holds `root` — beside the unchanged 0.9.1 renderer. No v2 `deltaTransport`. v1 unchanged.
- **v2 charter Phase 4 (P4-D) — v2 identity: the Subject is the owner, ids have a grammar, tokens have a scheme (ADR 0629).** Under **major 2 only**, `RunSnapshot.owner` is the closed `{ tenant, workspace?, subject }` block with `subject` REQUIRED and `principal`/`principalKind` removed (`spec/v2/core/identity.md` §1.1); `run.started` echoes the same block, projected by the same function so the two cannot disagree. A run this host recorded no principal for reads with the §1.2 legacy subject (`urn:openwop:legacy`) instead of omitting a required field, and the two v2 lanes (`session`, `anonymous`) are read back from the issuer the subject was attested under — a READ projection over the same persisted stamp, so nothing is re-minted and nothing is rewritten (migration row `openwop.migration.C3.4`).
- **RFC 0207 — the outbound trace carrier: this host's cross-host calls now continue the caller's trace.** An MCP request or A2A message this host sends carries the W3C trace context the RUN was created under, in BOTH carriers: `params._meta.traceparent` (MCP, unprefixed — the mapping `mcp-integration.md` §D names) and `Message.metadata.openwop.traceparent` (A2A), plus the HTTP `traceparent` header on each. Either carrier conforms alone; sending both satisfies the SHOULD. **The trace is read off the run row, not the ambient context** (`run.metadata.traceContext`, a new RESERVED key stamped host-side from the creating request's own header): a run is dispatched on `setImmediate` and, on the durable path, redelivered from the `dispatch_outbox` by a timer daemon with no request context at all, so an outbound call made mid-run cannot read the caller's trace any other way. Each outbound request gets a fresh CHILD span of it, so two concurrent calls stay distinguishable while joining one trace. Nothing is invented: a run started with no inbound `traceparent`, or with a malformed one, sends no carrier. **Correlation only — never read as tenant, principal or scope.** The §22 A2A and §23 MCP invoke seams thread the seam request's own `traceparent` for the same reason they drive the real clients.
- **The tenant-bound run id (`identity.md` §5, ADR 0629 Decision 1).** A major-2 caller sees `<tenantId>/<opaque>` and a `runId` whose tenant segment is not the caller's is refused with `403 id_tenant_mismatch` before the store is touched. **Run ids are NOT re-minted and no row is rewritten** — the store keeps the bare UUID and the `/v1` wire keeps returning it; the tenant-bound form is a reversible projection at the major-2 boundary (`host/v2Ids.ts`), applied by both JSON senders (`res.json` and `sendNegotiatedRunJson`, which bypasses it).
- **`Idempotency-Key` grammar (`idempotency.md` §Layer 1).** Under major 2 a key outside `^[A-Za-z0-9._~-]{22,128}$` is `400 idempotency_key_invalid`, refused before a claim is taken (the code MUST NOT be cached). The v1 wire's free-form key is untouched.
- **The `ow2.` resume-token scheme (`identity.md` §4, `interrupt.md` §Tokens).** Interrupt tokens are now minted as `ow2.hs256.<kid>.<payload>.<mac>`, with `kid` derived from `OPENWOP_INTERRUPT_TOKEN_SECRET` so a secret rotates without orphaning outstanding tokens. Under major 2 an unadvertised `alg`, an unheld `kid`, a bad MAC or a malformed token are one refusal: `401 interrupt_token_invalid`.
- **`schemaVersion` on the v2 event envelope (`events.md` §"The envelope").** Supplied at the ADR 0628 storage seat on a major-2 read (`1` — this host has never versioned an event payload, so a column would hold one constant); absent from the v1 read, which is unchanged.
- **v2 charter Phase 4 (P4-C) — the era key and the codemap read path (ADR 0628).** Every run this host creates is now stamped `eventLogSchemaVersion: 3` (`spec/v2/core/persistence.md` §"The era key"), and the v2 discovery root advertises that same one constant. The stamp lives on `Storage.insertRun`, the single interface method all **23** run-creation call sites funnel into, so persistence.md's "MUST begin stamping `3` on ALL of them in the same change" holds by construction rather than by inspection. Additive nullable column, **no backfill**: sqlite migration 44, Postgres migration 41, no `UPDATE`. A run that predates the cut keeps its absent era, reads as `2`, and its rows are never rewritten; the snapshot's REQUIRED `eventLogSchemaVersion` is synthesized as `2` for those runs at read time, because a missing stored era is not a read error.
- **The storage seat (ADR 0628 §2).** `Storage.listEvents` — the storage interface's event-list method, which every one of the backend's 35 event reads passes through (poll, SSE, fork, replay divergence, debug bundle, the analytics folds) — translates an era-`2` log through the vendored `schemas/v2/event-codemap.json` for a major-2 reader, with `sequence` preserved verbatim; an unmapped type with no vendor prefix fails the read with `500 event_type_unmapped`. Its writers `appendEvent`/`appendEventsBatch` hold each log to its era's vocabulary and refuse a v2 name an era-`2` log cannot express. The adapter is installed by decorating the Storage object in `openStorage()`, the one place a Storage is constructed, so no call site can bypass it and the two backends cannot drift.
- **RFC 0165 host leg (ADR 0625, 2026-09-02)** — root `protocolVersions: ["1.1"]` on discovery; `RunSnapshot.owner` for EVERY run with a principal (was anonymous-actor-only), now carrying the RFC 0165 `subject` record minted at creation from the caller's lane and persisted on the reserved `metadata.owner` key, with the `urn:openwop:legacy` synthesis for runs that predate it; `run.started` echoes the owner block; `:fork` copies the owner (principal + subject) verbatim while `actingUserId` keeps its ADR 0024 re-stamp; `GET /.well-known/openwop` sends a standard `ETag` and honors `If-None-Match` → `304` (`ETag` added to the CORS expose list). Suite pin `^1.152.0 → ^1.159.0` (1.157.0 and 1.159.0 fix two defects in the suite's `owner-subject-echo` leg that this leg surfaced: an async-start race and a `lastSequence=0` read that skips a 0-numbered first event); vendored schemas re-synced at `openwop-conformance/v1.159.0`.

### Changed
- **The v2 run snapshot is CLOSED (`runs.md` §Snapshot, ADR 0629 Decision 5).** Under major 2 the snapshot is filtered against the `properties` of the vendored `schemas/v2/run-snapshot.schema.json` — read from the artifact, never retyped — which drops eleven fields the v1 wire carries and v2 declares no seat for: `parentRunId`, `parentSeq`, `forkMode`, `parentNodeId`, `inputs`, `removalAt`, `pinned`, `costUsd`, `costByNode`, `childRuns`, `interrupt`. `parentRunId` and `inputs` are not host extensions in spirit and their loss is reported upstream rather than smuggled through `metadata`. **The `/v1` snapshot still carries all of them.**
- **Interrupt resume tokens change shape on BOTH wires** (43 characters/one segment → 105/five). The token is an opaque capability with no v1 grammar and every consumer treats it as opaque, but the bytes differ; tokens outstanding across the deploy keep resolving unchanged.
- **v2 charter Phase 4 (P4-A) — the corpus pin moves to the v2 line.** `schemas/CORPUS_TAG` is now `v2.0.0-rc.3` and the vendored set is re-copied from that tag (182 schemas, including `schemas/v2/` for the first time). The suite and its new peer are pinned EXACTLY — `@openwop/openwop-conformance@2.0.0-rc.3` and `@openwop/spec-artifacts@2.0.0-rc.3`, not a caret range: a host measuring itself against a moving suite is not evidence.
- **`check-vendored-schemas.mjs` learns both corpus release lines and reads the pinned tag.** The pin regex accepted only `openwop-conformance/vX.Y.Z` with a three-part version, so it could not express the v2 coordinated release (`vX.Y.Z[-rc.N]`, which publishes the suite AND `@openwop/spec-artifacts` together). It now accepts both. Separately, the drift comparison read whatever the sibling checkout happened to be on rather than the tag the pin names — so it could report agreement with a corpus nobody released. It now reads `git show <CORPUS_TAG>:<path>`, the same rule `sync-schemas.sh` already applies on the copying side, and the source label says which tag it compared against.
- **Webhook `OpenWOP-*` header family now carries the spec's values (RFC 0165 §C.1; closes ADR 0538 Phase 2).** `OpenWOP-Webhook-Id`, `OpenWOP-Event-Type`, `OpenWOP-Timestamp`, `OpenWOP-Signature: sha256=…`, `OpenWOP-Signature-Algorithm: v1` are emitted value-identical to their `X-openwop-*` twins. The pre-spec combined `openwop-signature: t=…,v1=…` encoding and the `openwop-subscription-id` header are removed. A subscriber may verify from either family with the same `${timestamp}.${rawBody}` recipe; the openwop-sdks helpers (TS 1.9.0 / Py 1.7.0 / Go v1.6.0) read both.
- **Vendored schemas are pinned to a corpus tag** (v2 charter Phase 0, 2026-09-02). `scripts/sync-schemas.sh` now requires `--tag openwop-conformance/vX.Y.Z` (or `OPENWOP_CORPUS_TAG`), refuses to copy unless the sibling corpus checkout is exactly at that tag with a clean `schemas/`, and records the tag in `schemas/CORPUS_TAG`. `scripts/check-vendored-schemas.mjs` (in `npm run ci`) fails when that tag's version differs from the installed `@openwop/openwop-conformance`. Why: the corpus is about to grow `schemas/v2/`, and an unpinned sync from whatever HEAD `../openwop` is on would ship v2 schemas into a v1 image (the H34 drift class, one major up). Suite pin `^1.151.0` → `^1.152.0`; schemas re-vendored from `openwop-conformance/v1.152.0` (only the bundle-v1 schema's deprecation note and `schemas/README.md` changed).

### Fixed
- **`GET /v1/agents/roster` is served (RFC 0086 §B, #4163).** Discovery advertised `agents.roster.supported`, but the route was never registered and `/agents/roster` fell into `/agents/:agentId` (`404 "agent 'roster' is not installed"`). It now returns the closed `agent-roster-response` projection of the tenant's standing roster, registered ahead of the id route.
- **RFC 0176 pinned-run disposition fires for every caller (#4159).** A run pinned to an unimplemented change id was cancelled only when read by the wildcard operator; a configured tenant key read it back as `running` indefinitely.
- **`sync-fixtures.sh` vendors a named corpus TAG, and the guard's remediation line now works.** The script took no tag and copied the sibling corpus clone's WORKING TREE, so with the clone ahead of the pin (found by an adopter: clone 2.36.1, pin 2.36.0) a failing `check-vendored-fixtures` printed "run `sync-fixtures.sh`" and that run vendored the wrong release — failing the same guard for the opposite reason, with a throwaway detached worktree as the only way out. It now requires `--tag` (the same contract `sync-schemas.sh` has) and `git archive`s that tag, never touching the shared clone's HEAD, index or working tree; the guard prints the tag matching the installed suite, reads the corpus AT that tag for its which-side-is-stale call, and no longer tells you to reconcile a working tree. `sync-schemas.sh` gets the same read-at-the-tag treatment: it demanded the clone already be checked out at the tag — an instruction that mutates a checkout shared with other sessions — and its three `spec/v2/*.json` copies came from the working tree, which its clean-`schemas` check never covered. `check-vendored-schemas.mjs`'s remedy no longer tells you to build a throwaway detached worktree at the tag and point `OPENWOP_CORPUS_DIR` at it — the sync reads the tag itself, so `git -C ../openwop fetch --tags` is the whole preparation. `deploy/gcp/up.sh` passes both tags (its untagged `sync-schemas.sh` call had aborted every confirmed deploy since 2026-09-02).
- **`GET /v1/runs/{id}/events/poll?lastSequence=0` dropped the first event (ADR 0625).** The route added 1 to the cursor on top of storage's already strictly-after `listEvents`; with this host's first event at sequence 1, `run.started` was never returned through the spec-canonical cursor. Caught by the RFC 0165 echo scenario; fixed 1:1.

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
  Host-internal, no RFC (reuses the `interrupt.resolved` event; adds no wire surface).
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
