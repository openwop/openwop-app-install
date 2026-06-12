# ADR 0019 — Email Marketing (campaigns + templates over CRM contacts)

**Status:** implemented (Phases 1–2 + frontend + the core-app extension surface; Phase 3 real provider — follow-on)
**Date:** 2026-06-10 (backend implemented 2026-06-11)
**Depends on:** ADR 0001 (feature-package), ADR 0006 (RBAC), ADR 0008 (CRM — the
contact audience), ADR 0014 (feature workflow surfaces), ADR 0020 (Consent — gates marketing sends, **shipped first**)
**Toggle:** `email` · **Surface:** authed `/v1/host/sample/email/orgs/:orgId/*`
(host-extension, NON-NORMATIVE — no RFC). No public surface.
**MyndHyve §:** Email Marketing · **Baseline:** `src/features/email-marketing/`
(`MultiProviderCoordinator`, `adapters/`, `envelope/`, `services/`, `stores/`)

---

## Context (boundaries audit first)

The **engage** leg of the loop: act on the CRM contacts Forms (0017) captures by
sending templated campaigns.

**Pre-existing-surface audit:**
- **`email` namespace is free.** No `src/features/email`; the contacts the campaign
  targets live in `crm/contactsService.ts` (`listContacts(tenantId)` /
  `getContact`), the single owner of the rolodex (ADR 0008).
- **A provider-seam precedent exists — Notifications.** The `notifications` feature
  already ships an env-gated email/webhook **delivery stub** with an honest
  capability posture (advertise a channel only when configured). Email Marketing
  reuses that *posture*, not its transport: notifications are **transactional /
  in-app**; this is **bulk marketing** — a distinct concern with its own
  campaign/audience/log model. They may share a provider adapter later (open
  question), but folding bulk campaigns into the notification emitter would conflate
  two surfaces.
- **No e-commerce coupling** (the roadmap cut) and **no CRM↔email event-bridge** in
  v1 (MyndHyve marks it Partial).

What is **new**: templates, campaigns, the send log, audience resolution, and the
provider-adapter seam.

## Decision

An `email` feature-package (toggle `email`, default OFF, `bucketUnit: tenant`),
authed + org-scoped + RBAC. A campaign resolves its audience **live from
`contactsService`** (never a copied contact list), renders a template per contact
(variable interpolation), and dispatches through a **pluggable provider adapter** —
v1 ships a `console`/stub adapter with honest capability gating.

### The model

```
EmailTemplate { templateId, tenantId, orgId, name, subject, body,   // body: {{contact.name}} interpolation
                createdBy, createdAt, updatedAt }
Campaign      { campaignId, tenantId, orgId, templateId,
                audience: { stage?: ContactStage, tag?: string },   // resolved live from contacts
                status('draft'|'sending'|'sent'), stats?: { sent, failed, skipped },
                createdBy, createdAt }
SendLog       { sendId, campaignId, contactId, status('sent'|'failed'|'skipped'),
                providerId?, error?, ts }   // APPEND-ONLY
```

### Phase 1 — templates + campaigns store + CRUD (RBAC)

`emailService` + `DurableCollection`s (`email:template`, `email:campaign`).
Routes under `/v1/host/sample/email/orgs/:orgId/{templates,campaigns}`, all
`authorizeOrgScope`-gated (read=`workspace:read`, write=`workspace:write`), tenant+org
IDOR-guarded. Route harness tests.

### Phase 2 — audience resolution + render + send (stub adapter)

`POST .../campaigns/:id/send` (`workspace:write`): resolve the audience from
`listContacts(tenantId)` filtered by `audience` → render the template per contact
(interpolate `{{contact.*}}`) → **consent check** (`consentService.isAllowed(...,
'marketing')`, ADR 0020 — skip non-consenting) → dispatch via the provider adapter →
append a `SendLog` per recipient → roll up `stats`. v1 adapter is a `console`/stub
sink (deterministic, testable). Append-only log; partial-failure isolation (one
recipient's failure doesn't abort the batch).

### Phase 3 — real provider adapter seam (env-gated, honest)

`EmailProvider { id; send(msg): Promise<Result> }`; a real adapter (e.g. SendGrid)
behind env config. Honest capability: list a provider as sendable only when its
credentials are present (else the stub + a clear "no provider configured" — the
baseline's `provider_not_backend_routed` honesty).

### Phase 4 — frontend

`EmailPage` (nav-gated on `email`): templates editor → campaign builder (pick
template + audience filter) → send + per-campaign stats + send log. `emailClient.ts`.
`npm run build` gate.

## Core-app extension surface (node packs, agent packs, API)

Per **ADR 0014** (feature workflow surfaces), a feature is not only its REST + UI
faces — it must also **extend the core app's automation surface**. The surface below
is a committed phase (after the REST + UI phases), gated by the **same `email`
toggle** (all faces flip together), with signed `feature.email.*` packs published to
`packs.openwop.dev` (decoupled from toggle state for replay).

- **Node pack `feature.email.nodes`** — `feature.email.nodes.send` (send a
  template/campaign from a workflow — consent-gated via `ctx.consent`), `…render`
  (render a template for a contact).
- **Agent pack `feature.email.agents`** — `feature.email.agents.copywriter`
  (generate / optimize subject + body — the baseline's `email.generate` /
  `email.optimize` capability).
- **`ctx.email` workflow surface** — typed `listTemplates` / `send`, behind the same
  toggle + RBAC, advertised at `/.well-known/openwop`.
- **Envelope types** — `email.generate`, `campaign.create` (AI-drafted copy /
  campaign routed to `emailService`).
- **API endpoints** — the authed template/campaign/send routes above, reachable over
  MCP/A2A via the well-known advertisement.

## Architectural constraints honored

- **Single source of truth for contacts:** audience resolves live via
  `contactsService` — no copied list, no reach into CRM's store (composes ADR 0008
  exactly as Sharing composes cms/kb).
- **Honest provider capability:** stub-first; advertise/enable a provider only when
  configured (the Notifications posture; the baseline's 501 honesty).
- **Consent-gated marketing:** every send filters on `marketing` consent (ADR 0020).
- **Append-only send log + partial-failure isolation:** a bad recipient never drops
  the batch or corrupts the log.
- **RBAC org-scoped; no e-commerce coupling; no event-bridge in v1.**
- **No wire surface → no RFC.**

## Alternatives considered

1. **Build on the Notifications delivery path.** Rejected — transactional/in-app vs
   bulk-marketing are different surfaces (audience, scheduling, unsubscribe, stats);
   a shared low-level provider adapter is a later refactor, not a v1 merge.
2. **Copy the audience into the campaign at create.** Rejected — resolve live so a
   campaign reflects the current rolodex; copying duplicates contact data + drifts.
3. **Port all 7 MyndHyve adapters now.** Rejected — stub-first + one real adapter;
   add providers as a consumer pulls (honest capability beats 7 untested adapters).
4. **CRM↔email event-bridge (open → activity, stage → trigger) in v1.** Deferred —
   MyndHyve marks it Partial; it needs Analytics/webhook ingest first.

## Code-review resolutions (post-merge follow-up)

A `/code-review` of the merged Email feature (backend #138 + frontend #139) raised
four findings, all resolved in the `fix/email-review` follow-up:

- **MEDIUM-1 — GDPR erasure gap (resolved).** A `marketing`-consent data-subject
  delete previously left orphaned `SendLog` rows keyed on the recipient's
  `contactId`. `emailService` now registers an eraser on the host
  **subject-erasure seam** (`src/host/subjectErasure.ts`, ADR 0020): a
  `consentService.deleteSubject(tenantId, contactId)` cascades to
  `deleteSubjectSends`, purging every send-log for that subject. Mirrors how
  Analytics (0018) purges events. Covered by `email-route.test.ts` "consent
  data-subject delete purges email send-logs (GDPR cascade)".
- **MEDIUM-2 — re-send had no guard (resolved).** A `sent` campaign re-dispatched
  to the **entire** audience on every `POST …/send`. `sendCampaign` now throws
  `OpenwopError('conflict', …, 409)` unless an explicit `{ resend: true }` is
  passed; the route reads `body.resend`, the client surfaces a `resend` arg, and
  the UI confirms ("already sent — re-send?") and relabels the button **Re-send**.
  Each send is a real dispatch, so duplicate sends are worse than for analytics —
  intent must be explicit. Covered by the "blocks re-send … unless resend:true" test.
- **MEDIUM-3 — consent namespace coupling (open question, below).** The marketing
  gate and the send-log both key on CRM `contactId` as the consent **subjectKey**,
  whereas Analytics keys consent on an anonymous **visitor id**. Within Email this
  is internally consistent (audience, gate, log, and erasure all use `contactId`),
  but a single human who is both a CRM contact *and* an anonymous web visitor has
  **two** consent subject identities. Reconciling them needs an identity-stitch
  decision — tracked as an open question, not a blocker for Email.
- **LOW-4 — provider stub (acknowledged).** `activeProvider()` is the `console`
  stub; honest capability is preserved (no real delivery is advertised). A real
  env-gated adapter remains Phase 3 (above).

## Open questions

- [ ] **Consent subject-identity stitching (MEDIUM-3)** — unify a person's CRM
  `contactId` consent subject with their anonymous Analytics visitor-id consent
  subject. Needs an identity-resolution seam before marketing-consent decisions can
  span both surfaces; until then each surface gates on its own subjectKey namespace.
- [ ] **Unsubscribe / CAN-SPAM** — HMAC-signed unsubscribe tokens (the host already
  has webhook-signing primitives); wire when a real provider lands.
- [ ] **Bounce / open / click tracking** — needs a provider + inbound webhook ingest
  (composes Analytics 0018).
- [ ] **Send scheduling** (send-at / drip) — v1 is send-now.
- [ ] **Shared provider adapter with Notifications** (alt. 1) — extract once two
  consumers exist.
- [ ] **A/B subject lines** — reuse the toggle/variant engine, not a new A/B system.

## Implementation record

| Aspect | Evidence |
|---|---|
| Backend service | `src/features/email/emailService.ts` — `EmailTemplate` + `Campaign` + append-only `SendLog`; CRUD; `sendCampaign` resolves audience **live** from `contactsService.listContacts`, renders `{{contact.*}}`, consent-gates, dispatches via a provider, rolls up stats |
| Routes | `src/features/email/routes.ts` — authed org-scoped (`authorizeOrgScope`) templates + campaigns CRUD + `POST …/campaigns/:id/send` + send log. **No public surface** (authed-only) |
| Consent pairing (ADR 0020) | every recipient gated on the **real** `consentService.isAllowed(tenantId, contactId, 'marketing')` → non-consenting `skipped` in the log. The one consent rule |
| CRM composition (ADR 0008) | audience resolves **live** via `contactsService` — no copied list, no reach into CRM's store |
| Honest provider | a `console`/stub `EmailProvider` (`activeProvider()`); a real adapter is env-gated Phase 3 (the Notifications posture) |
| Partial-failure isolation | per-recipient try/catch; one bad recipient never aborts the batch or corrupts the append-only log |
| Extension surface (ADR 0014) | `src/features/email/surface.ts` (`ctx.features.email`: listTemplates/getTemplate/render) + `packs/feature.email.nodes/` (list-templates / render) + `packs/feature.email.agents/` (copywriter — writes copy, does NOT send) |
| Registration | appended to `BACKEND_FEATURES`; toggle `email` (off, tenant) |
| GDPR erasure (ADR 0020) | `deleteSubjectSends` registered on the host subject-erasure seam — a `marketing`-consent data-subject delete purges this subject's send-logs (no orphans) |
| Re-send guard | `sendCampaign(…, { resend })` — a `sent` campaign 409s unless `resend:true`; UI confirms + relabels **Re-send** (each send is a real dispatch) |
| Tests | `test/email-route.test.ts` — 8/8 (CRUD/RBAC + IDOR, send route, send logic: audience + render + **marketing consent gate** + stats, **re-send guard**, **GDPR cascade**, well-known advert, surface/node smoke) |
| Verify | `tsc --noEmit` clean; full suite green apart from the known pre-existing pack/env failures. (Also migrated the merged `consent-route` + `analytics-route` tests to the ADR-0026 `/test/login` auth seam — they were broken on `main` by the auth refactor.) |
| Frontend (Phase 4) | `frontend/react/src/features/email/` — `EmailPage` (org picker → templates editor → campaign builder [template + audience stage] → send + per-campaign stats + inline send log) + `emailClient.ts` + `routes.tsx`; appended to `FRONTEND_FEATURES`. `npm run build` gate green |
| Follow-on | Phase 3 (real provider adapter, env-gated + honest 501) |
