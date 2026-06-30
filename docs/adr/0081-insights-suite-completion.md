# ADR 0081 - Insights Suite completion + deferred connector/governance follow-ups

**Status:** implemented; the dashboard/demo-seed/read-model parts **Superseded by ADR 0082**
(2026-06-20 — rebuilt on the workflow engine). The connector (SA-JWT, Gmail), agent-tool,
trigger, and governance work here is KEPT; only P1's demo seed + the dashboard read model it
fed are removed by 0082.
**Date:** 2026-06-19
**PRD:** the deferred work catalogued by ADRs 0076/0077/0078 (their Open Questions + Phase
correction notes) — turning the validated-but-dormant Insights & Drafting Agent Suite into a
runnable surface, and completing the connector/governance follow-ups those ADRs explicitly
deferred.
**Depends on / composes:** ADR 0076 (connectors — extends with SA-JWT auth + Gmail draft), ADR
0077 (governance — extends the retention rollout), ADR 0078 (the suite — completes live
execution + demo enablement), plus the existing scheduler (0052), trigger ingestion (0034),
agent dispatch (RFC 0070), demo-mode seeding, and `featureToggles` service.
**Surface:** host-extension only — connection/auth-flow internals, node packs, the feature's
own seeders/routes, and per-feature retention purgers. No wire change.
**RFC gate:** **no new RFC** for any phase here. The ONE cross-host item — portable
"Verify Source" query-provenance as a normative run-event field — is **explicitly out of
scope** (it would need an OpenWOP RFC in `../openwop/`; the host-extension `dataAsOf`/`sourceQuery`
metadata already satisfies the single-host case).

## Why this exists

ADR 0078 shipped the Insights Suite as loadable, validated, fail-closed-by-default artifacts,
but several pieces were deliberately deferred so the feature could land safely: unattended
BigQuery auth (a service-account key is not a bearer token), live agent tool execution, the
Workday trigger source, and demo enablement. ADR 0076 deferred Gmail draft parity + a host-side
write gate's sibling; ADR 0077 deferred broad retention-purger coverage. This ADR closes that
backlog as one coherent, phased effort — each item host-extension, each fail-closed.

## Deferred-inventory audit (proven, with source)

| Item | Source | Status before this ADR |
|---|---|---|
| BigQuery service-account-JWT mint | 0076 Open Q2 | `AuthFlow` has no JWT-bearer kind; broker injects the stored secret as a bearer directly |
| Live agent tool execution | 0078 P1/C1 | live tool loop wires only `openwop:knowledge.search`; suite node tools not projected |
| Workday trigger source | 0078 §audit | trigger ingestion + Workday pack exist; event→subscription mapping unbuilt |
| Demo enablement + seed | 0078 (dormant) | toggle OFF; no sample `VarianceReport`/`TalentSnapshot` |
| Retention purger rollout | 0077 P3 | only `analytics` registers a purger |
| Gmail draft parity | 0076 Open Q3 | Graph-only |
| Cron validation at PUT /config | 0078 P2 review (LOW) | bad cron → silently never-firing job |
| Portable "Verify Source" provenance | 0078 conditional | host-ext metadata works; cross-host = RFC → **OUT OF SCOPE** |

## Decision — phased

1. **P1 — Demo enablement + seed (Track B, first to de-risk).** A demo-mode seeder writes a few
   `VarianceReport` (one off-plan) + `TalentSnapshot` rows (spread across the 9-box) behind
   `OPENWOP_DEMO_MODE`; enable the `insights-suite` toggle for the showcase tenant. Makes the
   dashboard + chat embed clickable on the deterministic path with zero live-data risk.
2. **P2 — BigQuery SA-JWT auth (extends 0076).** A new `AuthFlow: 'service-account-jwt'` that
   RS256-signs a JWT assertion from a BYOK service-account key and exchanges it at
   `oauth2.googleapis.com/token` for a short-lived access token, cached to expiry. Host-internal
   credential resolution; the key stays BYOK-enveloped, never logged.
3. **P3 — Live agent tool execution (Track A2).** Project the suite's allowlisted node tools into
   the agent tool provider so a live-dispatched agent can call them (the deterministic dispatch
   path proves the wiring; BYOK models drive the live turn).
4. **P4 — Workday trigger source (Track A4).** Map a work-anniversary event to a trigger
   subscription that starts `openwop-app.insights.anniversary-draft`.
5. **P5 — Retention purger rollout (extends 0077).** Register `RetentionPurger`s for the other
   PII-bearing features (crm, kb, profiles, comments), mirroring analytics.
6. **P6 — Gmail draft parity + cron validation (extends 0076 + polish).** A Gmail draft node +
   provider (base64url RFC822 `users/me/drafts`) sibling to Outlook; validate `scheduleCron` at
   `PUT /config` (400 on a malformed cron).

## Boundaries

No new feature-package, no route collisions — every phase extends an existing owner (connections
providers/auth, the integration node pack, the suite feature, governance retention). Demo seeding
rides the existing demo-seeder registry; toggle enablement uses the `featureToggles` service. No
core→feature import introduced.

## Live-validation caveat (honest)

P2/P3/P4 ship the CODE + deterministic/mock tests. **True live end-to-end** (a real GCP
service-account key, BYOK models, a real Workday tenant) cannot be exercised without those
external credentials; the nodes/flows fail closed without them, and a `ci:full`/manual smoke with
real creds is the final acceptance — out of this environment's reach.

## Implementation corrections

**Phase 1 (architect review):** seeding `__showcase__` alone is a no-op — the read routes
filter by the caller's tenant and the toggle buckets on the caller. Resolved by (a) a
`demoMode()` showcase-data fallback on the read routes (mirrors `workforces.ts`, badged
`source:'showcase'`) + (b) the seeder flipping the toggle to `beta` (open) in demo mode.
Production default stays `off`. UI uses the canonical `<IllustrativeBadge>` in a `<Notice>`
(not a hand-rolled chip), per the workforces precedent.

**Phase 2 (architect review):** the SA-JWT mint hooks at **`liveSecretFor`** (the credential
resolver), NOT `brokeredEgress` — `brokeredEgress` already injects whatever the resolver
returns as a bearer, so a new branch there yields the minted access token transparently and
keeps `connectionsService` the single owner of credential resolution (preserving the
`connections:use` gate + provider allowlist + confused-deputy guard). A dedicated
`CredentialKind: 'service-account-jwt'` (not overloading `oauth2`). The token exchange goes to
the fixed Google endpoint directly (NOT the connector broker — that pin is for the BigQuery
query). Stdlib-only RS256 (`node:crypto`, no jsonwebtoken dep). The SA key stays
BYOK-enveloped; the minted token is in-process-cached to expiry, single-flighted, never
persisted, never logged. This **resolves ADR 0076 Open Q2.**

**Phase 3 (architect review):** the live tool loop is an injected-port design
(`resolveTool`/`executeTool`), so projecting a node-as-tool is a `BUILTINS`-map extension —
no change to the loop, allowlist enforcement, or RFC 0064 recording. Only **pure compute
nodes** (`variance-compute`, `talent-score` — read only `ctx.config`/`ctx.inputs`) are
projected into live ad-hoc dispatch, via an **explicit projectable allowlist** in
`agentToolProvider.ts` (not a heuristic — the bigquery node doesn't declare its connector
requirement, so a "no-requires" heuristic would wrongly project it). Connector-backed nodes
(`core.bigquery.query`, `core.email.draft`) are DELIBERATELY excluded — they need the full
executor broker ctx (storage + acting-human Connection + `connections:use`) and run via the
P2 meta-workflows; projecting them into ad-hoc dispatch would fork the egress path (ADR 0001).
This makes the Talent/Financial agents genuinely live-tool-capable for their compute tools.

**Phase 4 (architect review + code-review):** the trigger source is reconciled at
config-set in `applyConfig`, mirroring the weekly-variance schedule: an
`anniversaryTriggerEnabled` flag (re)registers a deterministic webhook subscription
(`insights-anniversary:<tenant>:<principal>`) bound to `openwop-app.insights.anniversary-draft`;
disabling **pauses** it (there is no `deleteSubscription` — pausing makes ingest a no-op and
preserves delivery history). Because `registerSubscription` is idempotent and returns the
existing row WITHOUT touching its state, a re-enable-after-pause needs an explicit
`setSubscriptionState(active)` to revive. An ingested anniversary-shaped event resolves the
workflow and starts a run whose `metadata.triggerData` carries the payload (stamped
`trustBoundary/contentTrust: 'untrusted'`, so the human `approve` gate and draft-only
`emailDraft` mean untrusted input can never auto-send). **Honest scope (carry-forward):**
(a) the **Workday→event emission** (Workday POSTing the anniversary webhook to the
tenant-auth-gated ingest endpoint) is the integration boundary, NOT host code — the host
registers + resolves the subscription and consumes the event; (b) the shipped subscription
uses `verificationMode: 'none'` for the deterministic path — **a real Workday tenant MUST
register with `verificationMode: 'required'` + a signing secret** before exposure;
(c) the anniversary-draft nodes (`knowledge.retrieve`, `mock-ai`) do not yet *read*
`subjectId`/`milestone` from `ctx.triggerData` — the run carries the payload but a follow-up
adds a trigger-entry node or variable-mapping that threads it into retrieve+draft.

**Phase 5 (architect review + code-review):** registered `RetentionPurger`s for the three
PII-bearing durable-entity features — **crm** (`crm:contact`, name/email), **profiles**
(`profiles:profile`, bio/location), **comments** (`comments:thread`, body) — each
mirroring the analytics purger via the ADR 0077 `registerRetentionPurger` seam
(feature→host, module-load side-effect, no core→feature import). Two deliberate departures
from the analytics reference:
- **Age on `updatedAt`, not creation time.** Analytics ages on event-time `ts` (telemetry
  expires by age); these are durable user-authored entities, so they age on **last
  activity** — an actively-edited record keeps surviving; only genuinely *abandoned* PII
  ages out. Strict `<` cutoff (a row exactly at the cutoff is retained).
- **kb DROPPED from the rollout.** KB holds tenant *knowledge content* with a vector
  mirror, NOT data-subject PII; an age-purge would orphan vector entries and destroy the
  RAG corpus under the 365-day PII default. Retention for KB, if ever wanted, belongs under
  the `internal` classification (no default — admin opt-in), not `confidential-pii`.

**⚠ Carry-forward decisions (surfaced, NOT silently resolved):**
1. **Enrollment-trigger coupling (the data-loss footgun).** The retention sweep
   (`retentionSweepDaemon.ts`) runs for any *governed* tenant — and a governance policy row
   is created for unrelated reasons (provider allowlist, action policy). Because
   `confidential-pii` carries a **365-day default** (`SWEPT` in `retentionSweepDaemon.ts`,
   from the ADR 0077 PRD), registering *any* governance policy silently enrolls that
   tenant's dormant contacts/profiles/comments in deletion once
   `OPENWOP_RETENTION_SWEEP_ENABLED=true`. Before P5 the only purger was analytics
   (low-stakes telemetry); P5 is the first time enabling governance can destroy durable,
   user-authored business records. Mitigations in place: opt-in governed-tenants-only,
   sweep default-OFF, the audit row is the tombstone, and `updatedAt`-aging spares active
   rows. **Recommended ADR 0077 follow-up (a deliberate decision for the maintainer, NOT
   taken here because it changes ADR 0077's accepted default + analytics behavior): flip
   `confidential-pii` `defaultDays` to `null` (opt-in), matching the `internal` precedent,
   so PII purge requires an explicit `retention.confidentialPiiDays`.**
   **RESOLVED (follow-up, branch feat/retention-opt-in):** `SWEPT` `confidential-pii`
   `defaultDays` is now `null` — retention purge is opt-in (an admin must set
   `retention.confidentialPiiDays`). ADR 0077 §3 carries the correction note;
   `retention-sweep.test.ts` pins the guarantee (governed tenant with no window purges 0).
2. **Subject-erasure asymmetry.** crm/profiles/comments now participate in time-based
   retention but register no `registerSubjectEraser`, so a GDPR erase-by-subject request
   does not reach contacts/profile/comment bodies. P5 is retention-only; the erase-by-
   subject leg for these three is a follow-up.
   **RESOLVED (follow-up, branch feat/subject-erasure-parity):** profiles + comments now
   register subject-erasers (`deleteSubjectProfile` keyed on `userId`,
   `deleteSubjectComments` keyed on `authorId`; both tenant-guarded + fail-closed),
   driven by `consentService.deleteSubject`. **Correction to this note: crm is
   DELIBERATELY OUT, not a deferred gap** — a CRM contact is a third-party business record
   with no app-principal key (random `crm:<uuid>`), so the principal-keyed erasure seam
   must not delete it; the contact's reachable PII (marketing send-history) is already
   erased by the email eraser via `contactId`. "Erase the third party I hold a record
   about" is a distinct DSAR-by-email path (its own route/ADR), never this shared seam.
   A negative guard test pins that crm does not participate. The comment orphan trade-off
   (note 3 below) is inherited intentionally by erasure.
3. **Comment root-purge orphans a fresh reply.** Per-row `updatedAt` purge can delete a
   year-dormant root while a recent reply survives (its `parentId` dangles; it still
   renders via `listThread`, just loses its anchor). Acceptable at current scale; noted.

**Phase 6 (architect review + code-review):** two host-internal items.
- **(6a) Gmail draft parity.** A dedicated narrow `gmail` provider
  (`providerRegistry.ts`, pinned `gmail.googleapis.com`, scope `gmail.compose`,
  `consumerNodes:['core.email.draft']`) — sibling to `microsoft-graph`, same
  override-immune narrow-identity rationale. `core.email.draft` gained a provider-strategy
  branch on `connectorId`: `gmail` → base64url RFC822 → `POST users/me/drafts
  {message:{raw}}`; else the Graph create-message path. Binding a `gmail` connection makes
  the existing anniversary-draft workflow Gmail-capable (provider chosen per node-config —
  not automatic). **Never-send honesty (differs from Graph):** Gmail has NO scope that
  permits draft creation while forbidding send (`gmail.compose` is the narrowest and also
  allows send), so Gmail's never-send is enforced **by construction only** — the node only
  ever builds the fixed `drafts.create` literal, never a send endpoint (the URL is chosen
  by an internal boolean, never caller-interpolated). Scheduled/unattended Gmail drafting
  would need SA-JWT generalized beyond P2's BigQuery scope — out of scope (the anniversary
  draft runs human-acting to an approval gate, so PKCE is the baseline).
  **Code-review BLOCKING fixed:** the raw-RFC822 path was a MIME header-injection vector
  (a `\r\n` in subject/recipient could smuggle a hidden `Bcc:`); resolved with a
  fail-closed node guard (rejects CR/LF in recipients/subject before any egress, both
  providers) + `buildRfc822` defensively CR/LF-stripping header values (belt-and-suspenders
  for the pure primitive). Graph's structured-JSON path was already injection-safe.
- **(6b) Cron validation.** `PUT /config` validates `scheduleCron` at the HTTP boundary via
  the scheduler's single parser (`host/cronSchedule#parseCron`), 400 `invalid_request` on
  a malformed expression — closing the ADR 0078 P2 LOW (a bad cron previously persisted a
  silently never-firing job). No divergent validator; feature→host import.

## Phase → commit / test ledger (all phases implemented)

| Phase | What landed | Tests |
|---|---|---|
| P1 | Demo enablement + seed + showcase read-fallback | `insights-suite-demo.test.ts` |
| P2 | BigQuery service-account-JWT mint at `liveSecretFor` | `service-account-jwt.test.ts` |
| P3 | Live agent tool projection (pure compute nodes) | `insights-agent-tools.test.ts` |
| P4 | Work-anniversary trigger source (subscription + ingestion) | `insights-suite-trigger.test.ts` |
| P5 | Retention purgers (crm/profiles/comments; kb dropped) | `retention-purgers.test.ts` |
| P6 | Gmail draft parity + cron validation | `email-draft-connector.test.ts`, `insights-suite-cron.test.ts` |

Each phase: `/architect` pre-review → implement → `/code-review` → fixes applied (P2 clamp+evict, P4 dedup-doc+rename, P5 footgun-documented, P6 CRLF-injection fixed). Full backend suite green (2171 passed) + `tsc --noEmit` clean at completion.

## RFC verdict

**Host-extension — no new RFC.** The only wire-touching idea (portable query-provenance) is
out of scope; everything here is non-normative host work composing accepted surfaces.
