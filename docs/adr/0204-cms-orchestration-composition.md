# ADR 0204 — CMS orchestration composition: lifecycle events, scheduled publishing, preview links, shared sections, audit, governed node verbs + chain pack

**Status:** implemented (2026-07-03)
**Date:** 2026-07-03
**Toggle:** none new. C2 scheduling is admin-scope and 409-blocked when `cms-approval-gate` is ON; C3 rides the existing `sharing` toggle.
**Wire:** none — `host.cms.page.*` event types ride `run-event.schema.json`'s vendor-extension branch (the `openwop-app.crm.contact-triaged` precedent); the normative `RunEventType` enum is untouched and no event catalog is advertised, so **no RFC**. Everything else is host-ext.
**Depends on / composes:** ADR 0009/0027/0064/0066 (the CMS), ADR 0206 (editor surfacing), ADR 0007 (media), ADR 0013 (sharing — the token lifecycle C3 rides), ADR 0028 (the ONE audit store), ADR 0034 (trigger ingestion — explicitly NOT extended here), ADR 0152 (the chain-pack loader), ADR 0058/0073 (chat-drivability = agent + nodes), RFC 0013 (chain packs), the CMS gap analysis Phase C.

## Context

Phase C converts the CMS from an app feature into an orchestration demo: content
changes must be observable (webhooks), automatable (workflow verbs + a chain),
schedulable, previewable, reusable (shared sections), and auditable — all under
the standing constraint: **no parallel orchestration**. Every decision below
names the existing primitive it composes.

## Decisions

### C1 — Lifecycle events through the ONE webhook pipeline

- Event types: `host.cms.page.{submitted,published,rejected,unpublished,archived,restored}`
  (+ future `host.cms.*`), following the sole in-tree precedent
  (`openwop-app.crm.contact-triaged`, `features/crm/routes.ts`). The `content.*` names
  in the gap analysis were off-convention and are corrected here.
- **Emit path:** NOT the run event log. `eventLog.append` requires a `runId`,
  and `deliverToSubscribers` resolves the tenant from the run — a run-less
  event would mis-scope to the `'default'` tenant (an isolation hazard).
  Instead, `routes/webhooks.ts` (the delivery owner) exports ONE new entry
  point, `deliverHostExtEvent({type, tenantId, payload})`, that reuses the same
  subscription matching, durable enqueue, backoff worker, SSRF egress guard,
  and HMAC signing — one more door into the one pipeline, with the tenant
  carried EXPLICITLY.
- Emitted from `cmsService.transitionPage`/`restoreVersion` via
  `recordCmsAction` (single owner — routes, the approval decide handler, the
  C2 sweep, and the C6 node path all inherit it). Best-effort; payloads carry
  ids/slug/title/status/version/actor — never section content, never a locale
  (RFC 0103 §F).
- **`publish-on-event` (a workflow started BY a content event) is deferred:**
  `triggerIngestionService` is external-only (`webhook|email|form`); an
  internal-event trigger source is a real ADR 0034 extension — a Phase-D
  candidate, not something to sneak in sideways.

### C2 — Scheduled publishing: a feature sweep, not scheduler-core surgery

No one-shot absolute-time primitive exists (`schedulingService` is
cron-cadence; `firstFireAtMs` is only a horizon check). Extending the core
scheduler with job-kinds has host-wide blast radius; the house pattern for
non-workflow periodic work is a dedicated sweep (`retentionSweepDaemon`
precedent). So:

- `Page.scheduledPublishAt?` set via `POST …/pages/:id/schedule` (admin scope;
  **409 when `cms-approval-gate` is ON** — a scheduled publish is a publish
  bypass, same closure as the direct publish route), cancelled via `DELETE`.
- `features/cms/publishSweep.ts`: minute tick, `storage.claimIdempotency`
  per (page, scheduled-time) for multi-instance fire-once, publishing through
  `transitionPage('publish', 'system:cms-scheduler')` — so snapshots, C1
  events, and C5 audit all apply; no side-door.
- Fail-closed at fire time: the gate turning ON after scheduling skips the
  publish and clears the schedule (audited). Any publish consumes a pending
  schedule (`transitionPage` clears the field).

### C3 — Preview links: the sharing feature already IS the preview system

ADR 0013's `cms_page` share resolver already loads ANY status (drafts
included) behind a revocable, expiring, view-capped, uniform-404 public token
at `/shared/:token`. C3 therefore ships **zero new token surface**: the CMS
editor gains a "Preview links" panel driving sharing's management API
(create/copy/revoke, 7-day default expiry), and the share resolver now
resolves shared-section refs (C4) so previews render real content. Honest
caveat surfaced in-UI: preview links require the `sharing` toggle.

### C2b — Scheduled UNPUBLISH (extension, 2026-08-02)

Round-3 field research (Contentful scheduled actions, Sanity Scheduling API —
cited in `docs/steward/UX_UPGRADE-content.md`) placed the publish-at/
unpublish-at PAIR as the natural tier-2 increment; this extension ships it on
the same C2 architecture, unchanged:

- `Page.scheduledUnpublishAt?` set via `POST …/pages/:id/schedule-unpublish`
  (same admin scope as a manual unpublish), cancelled via `DELETE`. Legal
  while `published`, or alongside a pending publish schedule (the embargo
  pair — then strictly later than the publish time).
- A SEPARATE marker lane (`cms:scheduled-unpublish`) — the C2 markers are
  keyed by pageId alone, so the pair would collide in one collection. Same
  shape, same self-heal; no subject data (same DSAR class).
- The sweep gains an unpublish lane (own claim prefix) and ONE new rule in
  the publish lane: **window-elapsed** — a due publish whose paired unpublish
  is ALSO due is skipped with both schedules cleared and audited, so an
  instance down across the whole window never resurrects content past its
  embargo.
- **The approval gate deliberately does NOT apply to the unpublish lane**:
  the gate protects the publish direction (content going public); removing
  content is the fail-safe direction. Contentful/Sanity likewise leave
  unpublish ungated. A route test pins the asymmetry against a future
  symmetry "fix".
- `transitionPage`: any publish keeps a pending `scheduledUnpublishAt` (the
  pair survives publication); any transition LEAVING published/archived
  consumes it.

Tests: `test/cms-scheduled-unpublish.test.ts` (7 — legality, pair ordering,
gate asymmetry, sweep fire, window-elapsed, pair-survives-publish,
archive-consumes).

### C4 — Shared sections (inherit-only v1)

- `cms:sharedsection` rows (org-scoped, validated/sanitized via the SAME
  per-type builders as inline sections; cap 100/org). `Section.ref =
  {sharedSectionId}` marks an inherit-by-reference section (own data stays
  empty; **detach = copy-in + drop the ref**, an editor action not a state).
- **Resolution at the ONE delivery chokepoint** (`getPublishedBySlug`), which
  every published read routes through (cms by-slug, publishing public page,
  `/v1/content`, the workflow surface) + the share resolver. Dangling refs are
  DROPPED from delivery, never rendered empty. The editor keeps raw refs and
  renders a locked card.
- **Impact before change** (the research-doc acceptance criterion):
  `GET …/shared-sections/:id/pages` lists referencing pages; the editor modal
  shows them and the save confirms. Delete 409s while referenced.

### C5 — Audit through the ONE audit store (ADR 0028)

`recordCmsAction` appends `cms.<action>` rows via `storage.appendAudit` with
**`payload.tenantId` stamped** — the governance read (`/governance/audit`)
tenant-scopes on that field fail-closed, so unstamped rows would be invisible
to tenant-scoped admins. Covered: transitions, restore, schedule set/clear,
language-settings writes. Reads ride the existing superadmin governance route
(`?actionPrefix=cms.`) — no new route.

### C6 — Governed node verbs + the chain pack: workflows drive content

- `ctx.features.cms` gains `getDraftPage` (raw draft read — a tenant-scoped
  run reads like an org member; the §F guard protects ANONYMOUS delivery,
  which stays published-only), `updateSectionDraft` (DRAFT-only, sanitized via
  the same overlay cleaner + validated write path), and `submitPage` — which
  calls `queueContentApprovalIfGated`, the submit-side gate composition
  **extracted from the route so both share ONE owner** (a node submit can
  never bypass the ApprovalsInbox).
  > **CORRECTION 2026-08-21 (ADR 0593 / `CMSLWF-10`, `CMSAWF-4`).** The helper
  > named here was RETIRED. Post chat-first-port C1 a submit queues the row
  > UNCONDITIONALLY, so the toggle-conditional variant was a predicate copy with
  > a flip window — its last caller (the experiment-promote lane) had already
  > read the toggle four lines earlier, and a flip in between left a page
  > `in_review` with no approval row on the inbox lane. The ONE owner is now
  > `queueContentApproval`; the toggle question is `isApprovalGateOn` and it
  > belongs to the publish-BYPASS lanes only.
- **`publish-page` is REJECTED**: every existing feature write-surface is
  draft/submit-only ("the surface never publishes") and gate-ON publish routes
  409 as a bypass. Nodes draft and submit; humans publish.
- `feature.cms.nodes` → **1.2.0** (six nodes; the three new verbs). Node args
  resolve `config` (where chain params land as `{{inputs.*}}`) overlaid by
  edge-delivered `inputs` — the host strips static per-node `inputs` at
  definition validation, so chain params MUST ride config (learned the hard
  way; the chain test pins it).
- `feature.cms.agents` → **1.1.0**: new `content-editor` persona allowlisted
  to the six nodes — deliberately NO publish tool.
- Chain pack **`vendor.openwop-app.workflows.cms`**
  (`examples/workflow-chain-packs/cms-localization/`, loaded by the boot sweep
  — chain packs are catalog templates, not `requiredPacks`): chain
  `cms.localize-and-submit` = get-draft-page → translate-section →
  update-section-draft → submit-page, ports wired by edges
  (`read.sectionData → translate.data`, `translate.overlay → store.data`).
  The manifest schema requires a `core|vendor|community|private` name prefix
  (spec-governed — we conform, we don't touch the schema).

## What Phase C deliberately did NOT build

- An internal-event trigger source (ADR 0034 extension — Phase D candidate).
- A one-shot job primitive in `schedulingService`.
- A second token/preview surface, event pipeline, audit store, or publish verb.

## Tests

`test/cms-phase-c.test.ts` (7 route/surface-level: event fan-out + cross-tenant
negative; audit tenant stamping; schedule validation/gate/sweep/fail-closed;
shared-section CRUD/resolution/impact/409; surface verbs incl. the
no-publish-verb assertion), `test/workflow-chain-cms.test.ts` (3: schema-valid
load, typeId allowlist + no-publish, deterministic expansion with params as run
inputs).
