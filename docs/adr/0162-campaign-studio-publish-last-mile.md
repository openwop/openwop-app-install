# ADR 0162 — Campaign Studio: publish channel drafts to live page-builder / email

| Field | Value |
|---|---|
| **Status** | implemented (Phase 1, 2026-06-28) |
| **Date** | 2026-06-28 |
| **Feature(s)** | `campaign-channels` (ADR 0157) publish nodes over the `cms` (ADR 0009/0012/0064) + `email` (ADR 0019) feature surfaces |
| **Depends on** | ADR 0157 (channel generators), 0158 (orchestration + Strategist agent), 0014 (`ctx.features` workflow surface), 0058 (chat-drivability = agent + nodes), 0064 (CMS surface) |
| **RFC gate** | None — host work composing already-registered feature surfaces + node packs. **No new RFC.** |

## Context

ADR 0157/0158 explicitly deferred the **last mile**: a generated `landing_page` or
`email_sequence` draft is a run artifact, not yet a *publishable* entity. A user who
runs a campaign gets polished drafts but must hand-copy them into the page-builder /
email tool. ADR 0158 §Non-goals: *"Pushing channel drafts into page-builder/email as
live entities (follow-on)."* This ADR is that follow-on.

The owning features already model these entities and **already have write-capable
services** — only their workflow **surfaces** are read-only:

- **CMS** (`features/cms/cmsService.ts`) — `createPage({ tenantId, orgId, title, slug?, sections?, createdBy, baseLocale? })`
  creates a `draft`-status `Page`, running every section through `validateSections`
  (XSS/open-redirect sanitization, slug uniqueness). The `ctx.features.cms` surface,
  however, exposes only `listPages`/`getPage` ("Read-only by design", ADR 0064).
- **Email** (`features/email/emailService.ts`) — `createTemplate({ name, subject, body, createdBy })`
  + `createCampaign({ templateId, stage?, createdBy })`. The `ctx.features.email`
  surface exposes only `listTemplates`/`getTemplate`/`render` ("Read-only in v1 — the
  campaign `send` … is a follow-on").

So the gap is **not** a missing store — it is a missing *write seam* on two existing
surfaces. Standing up a second page/email store would be the exact "parallel surface"
anti-pattern this project forbids.

## Decision

**Each owning feature gains one narrow, draft-only write method on its surface that
delegates to its existing service; `campaign-channels` gains two publish nodes that map
a channel draft onto those calls; both nodes join the Campaign Strategist's
tool-allowlist** so publishing is chat-driven (ADR 0058) — no new UI, no parallel store.

1. **`ctx.features.cms.createDraftPage({ orgId, title, sections })`** → delegates to
   `cmsService.createPage(...)` with `createdBy = args.createdBy || scope.runId` and the
   service's default `status: 'draft'`. Returns `{ pageId, slug, status }`. The service
   owns all sanitization/uniqueness — the surface adds nothing but the call. **Draft-only:**
   the surface never sets `published`; promotion stays a human action in the CMS UI
   (fail-safe — generated content is never auto-published).
2. **`ctx.features.email.createDraftCampaign({ orgId, name, emails[], stage? })`** → for
   **each** email step, `createTemplate({ name, subject: subjectLines[0], body })` **and**
   `createCampaign({ templateId, stage })` — **one draft template + one draft campaign per
   step**. Returns `{ campaignIds[], templateIds[], steps }`. (The `Campaign` model holds a
   single `templateId`, so a 1-campaign-per-sequence mapping would *orphan* steps 2..N; per-step
   campaigns keep every step independently sendable — see Key design decisions.) **No `send`** —
   each campaign is inert until a human triggers the existing `sendCampaign` route (fail-safe;
   honours the email feature's "send is a follow-on" boundary). Drip *timing* (`sendDelayDays`)
   is not yet modelled — sequencing is a human/scheduler follow-on.
3. **`feature.campaign-channels.nodes` gains `publish-landing-page` + `publish-email-sequence`** —
   pure mappers from the ADR 0157 draft shapes onto the two surface calls:
   - `landing_page` `{ title, sections:[{type,heading,body,ctaText?}] }` → CMS sections:
     first section → `hero` (`{ heading, subheading: body, ctaLabel: ctaText }`), rest →
     `richText` (`{ heading, html: body }`), any `ctaText` without a hero → a `cta` block.
     The CMS `SectionType` enum is `hero|richText|image|cta|columns`; the map is small +
     deterministic, and `validateSections` is the backstop.
   - `email_sequence` `{ emails:[{position,subjectLines[],previewText?,body,ctaText?,sendDelayDays?}] }`
     → `createDraftCampaign` (one template per email, subject = `subjectLines[0]`).
4. **Strategist tool-allowlist** (ADR 0058) gains both nodes, so the agent can "publish
   the landing page" / "turn the email sequence into a campaign" conversationally — the
   honest chat-driven path, surfaced through the existing run/chat, not a dashboard.

### Key design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Where the write lives | A new method on the **owning** surface (cms/email), delegating to its **existing service** | Single source of truth; the cms/email service stays the one writer. No second store (the "build ON orchestration" rule). |
| Draft / unsent only | `createDraftPage` never publishes; `createDraftCampaign` never sends | Fail-safe: AI-generated content needs a human gate before going live; honours each feature's own published/send boundary. |
| Tenant isolation | The write methods take `tenantId` from `scope` (closure-baked), only `orgId` from args | The cross-tenant guard — a run can never write into another tenant. Matches every existing write surface (`documents`, `campaign-orchestration`). |
| Replay/fork idempotency | Deterministic ids keyed on `runId:nodeId` — CMS via `createPage`'s `pageId` short-circuit; email via new optional `templateId`/`campaignId` short-circuits | A re-run or `:fork` from before the node reuses the existing entity instead of duplicating it (the `feature.documents.nodes` idempotency precedent). Nodes are `role:"action"`. |
| Email sequence → entities | One template + one campaign **per step** (not one campaign over the first template) | The `Campaign` model has a single `templateId`; per-step avoids orphaning steps 2..N and keeps each independently sendable. |
| `createdBy` provenance | `scope.runId` (not `args.createdBy`) | Attribution is stamped by the run, not forgeable by a node arg. |
| Node vs. surface | The channel→entity **mapping** lives in the publish node; the **write** lives in the surface | The mapping is campaign-channel-specific (draft shapes are ADR 0157's); the write is generic CMS/email. Clean seam. |
| Surface, not cross-feature import | `campaign-channels` calls `ctx.features.cms` / `ctx.features.email` | `ctx.features` (ADR 0014) is the sanctioned cross-feature seam; avoids a feature→feature code import. |
| Chat-driven, no new UI | Wire as Strategist agent tools | ADR 0058; "build ON orchestration, not a parallel surface." Existing CMS/email pages already render the resulting draft/campaign. |

### Non-goals

- Auto-publishing pages or auto-sending email (deliberately a human gate — see above).
- A new "Publish" FE button/dashboard (the Strategist chat + existing CMS/email pages cover it).
- The `ad_variants` / `creative_briefs` / `social_posts` channels — no first-party
  "live entity" target exists for them in-app yet (those ride the connectors, ADR 0159).

## Phased plan

| Phase | Scope | Gate |
|---|---|---|
| **1** | `cms.createDraftPage` + `email.createDraftCampaign` surface methods (delegating to existing services) · `publish-landing-page` + `publish-email-sequence` nodes in `feature.campaign-channels.nodes` (draft→entity mappers) · Strategist tool-allowlist += both · unit/pack tests (mapper shape; surface delegates; draft/unsent invariant; IDOR via org scope) | backend tsc + tests; boot registers the two nodes |

Single phase (contained — two surface methods + two nodes + an allowlist line). `/architect`
before · `/code-review` after. `/ux-review` N/A (no new UI; the draft/campaign render
through the existing CMS/email pages).

## Alternatives considered

1. **A new `publish` feature with its own page/email store.** Rejected — duplicates the
   cms/email entities; two writers for one concept drift and disagree (the cardinal
   "parallel surface" violation).
2. **Cross-feature code import (campaign-channels imports cmsService directly).** Rejected
   — `ctx.features` is the designed cross-feature seam; a direct import couples two
   independently-toggled features.
3. **Auto-publish / auto-send on generate.** Rejected — AI-generated marketing copy must
   pass a human gate before going live; draft/unsent is the safe default.
4. **A FE "Publish" button.** Rejected for the primary path — the chat-driven agent tool
   is the ADR 0058 pattern; a button could be added later but isn't the seam.

## Consequences

- A campaign's drafts become real CMS pages + email campaigns in one chat turn — closing
  the ADR 0157/0158 last mile without a new surface.
- Establishes the "add a narrow write method to the owning surface, delegate to its
  service" pattern for future draft→entity bridges (e.g. social posts → a scheduler).
- `ctx.features.cms` / `ctx.features.email` are no longer strictly read-only; the write
  methods are draft/unsent-scoped, so the published-delivery + send boundaries are intact.

## Implementation log

| Phase | Status | Evidence |
|---|---|---|
| 1 | ✅ Done | `cms.createDraftPage` + `email.createDraftCampaign` surface methods (tenant from scope, `createdBy = runId`, draft-only, delegating to the existing `createPage`/`createTemplate`+`createCampaign`). `emailService.createTemplate`/`createCampaign` gained optional deterministic `templateId`/`campaignId` idempotent short-circuits (mirroring `createPage`'s `pageId`). `publish-landing-page` + `publish-email-sequence` `role:"action"` nodes in `feature.campaign-channels.nodes` (draft→entity mappers, org resolved from the brief, deterministic `runId:nodeId` idem keys). Strategist tool-allowlist + prompt updated. **`campaign-channels-publish.test.ts` 12/12** (mappers, fail-closed, end-to-end mapper→real-surface, draft/unsent invariant, replay idempotency, tenant isolation, invalid-stage rejection); `campaign-channels.test.ts` export assertion updated. tsc clean; full backend suite 3580 pass (only the 2 env-only WASI reds, unrelated). `/architect` (GO-with-fixes — all applied) · `/code-review`. |
