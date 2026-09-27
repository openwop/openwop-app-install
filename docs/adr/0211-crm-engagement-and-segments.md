# ADR 0211 — CRM engagement bridge + saved segments

Status: implemented (send→activity bridge + segment audiences + segments core/UI — CRM gap analysis §5 D1/D2; Gmail sync deferred per §1)
Date: 2026-07-03
Depends on: ADR 0008 (amended), ADR 0019/0193 (Email Marketing), ADR 0208 (events/audit), ADR 0209 (lifecycle), ADR 0213 (typed custom fields).

## Context

Gap analysis E4: the activity timeline is fed only by hand. The email feature already
sends campaigns to CRM contacts with an org-scoped campaign model
(`features/email/emailService.ts` — templates/campaigns carry `tenantId + orgId`;
audiences resolve LIVE from `crm/contactsService`, "never a copied list").
Gap analysis E2/D2: there is no reusable segment; email's only audience filter is
`audience.{stage?}`.

## Decision

### 1. Email→activity bridge (D1 step 1)

In the email send loop, after a per-contact send-log row lands `status:'sent'`, append a
CRM activity `{ kind: 'email', body: 'Campaign email: <template name>', contactId,
companyId?: none, orgId: campaign.orgId }` through `crmEntitiesService.createActivity`
with a **deterministic activityId** `act:email:<campaignId>:<contactId>` (idempotent —
a resend/retry never duplicates the timeline row). Never store rendered content or the
subject line beyond the template name (PII discipline — the timeline is org-visible).
Best-effort: a failed append never fails the send. Emits nothing extra (the activity
append already emits `host.crm.activity.logged` via the ADR 0208 choke point when it
goes through routes/surface; the bridge calls the service directly and calls
`crmMutated` itself with actor `email:<campaignId>`).

**D1 step 2 (Gmail inbox sync) is explicitly DEFERRED**: it requires a per-user consent
opt-in and an email-body PII decision (store refs vs content) that deserve their own
ADR when a consumer pulls; the design sketch (a chain on the existing Gmail connection
provider matching participants → contacts, idempotent by messageId) is recorded here so
it isn't re-derived.

### 2. Saved segments (D2 — contacts-only v1)

- `DurableCollection('crm:segment')` rows `{ segmentId, tenantId, name,
  filters: SegmentFilter[], createdBy, createdAt, updatedAt }` where
  `SegmentFilter = { field: 'stage' | 'owner' | 'company' | 'lastTriageVariant' |
  'customFields.<key>', op: 'eq' | 'contains' | 'exists', value? }` (AND semantics; cap
  20 filters; 200 segments/tenant).
- **Evaluated at read** — `resolveSegmentMembers(tenantId, segmentId)` filters the live
  rolodex (tombstones excluded). No membership is ever materialized: this extends the
  email feature's live-resolution doctrine instead of creating a second audience system.
- Routes (tenant, `requireEnabled`): `GET/POST /crm/segments`,
  `GET/PATCH/DELETE /crm/segments/:segmentId`, `GET /crm/segments/:segmentId/members`.
- Workflow surface verb `listSegmentMembers({segmentId})` + `feature.crm.nodes`
  v1.3.0 node `list-segment-members` (read, recorded).
- **Email integration:** `Campaign.audience` gains optional `segmentId` (validated at
  create + resolved at send through the CRM evaluator; `stage` and `segmentId` are
  mutually exclusive — 400 otherwise). Email remains the audience OWNER; CRM owns the
  filter definition. The campaign-personas composition (ADR 0156) reads the same
  evaluator when it materializes real-people audiences.
- Mutations emit `host.crm.segment.created|updated|deleted` + audit (ADR 0208 §3).

## Alternatives rejected

- Materialized segment membership — violates the email feature's stated live-resolution
  doctrine and creates drift.
- Segments inside the email feature — CRM owns record semantics; email owns sending.
- A query DSL — the fixed filter vocabulary is the reference-host ceiling; typed fields
  come from ADR 0213.

## Open questions

- [ ] Company/deal segments — after a consumer pulls (the evaluator generalizes).
- [ ] OR groups / negation — not until a real audience needs them.
- [ ] A resend fires `host.crm.activity.logged` again even though the idempotent
  activity row is not duplicated (fire-and-forget posture); add event dedup only
  if a downstream consumer needs exactly-once semantics.
