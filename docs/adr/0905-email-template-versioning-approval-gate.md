# ADR 0905 — Email: versioned templates, a version-pinned send approval, transactional templates, subscription topics

**Status:** Accepted (2026-10-17) — plan only, no code. Architect-reviewed (§ Architect review). Live spend, vendor accounts and IAM wait on § Open decisions for David.
**Date:** 2026-10-17
**Feature:** `email` (extends ADRs 0019, 0193, 0217, 0227, 0655, 0848, 0895). New toggle
`email-approval-gate` (P2).
**Origin:** MyndHyve port, capability 2 of 4 (gap analysis 2026-10-17: "Email: no versioning and no
approval before sending", `MYNDHYVE-OPENWOP-APP-GAP-ANALYSIS.md` row "Email"). MyndHyve read at
`7246fb1ce`.
**RFC verdict:** **host-extension — no RFC.** Templates, campaigns, approvals and the preference
centre are all under `/v1/host/openwop-app/*`. The approval rides the host's own `PendingApproval`
queue (ADR 0025 §4), not a wire interrupt; the run-time send path (`core.openwop.integration.email-send`,
ADR 0895) is untouched. No event type, capability or envelope is added.

## Context

### MyndHyve baseline (`7246fb1ce`)

- **Templates are transactional, not marketing.** There are **15** SendGrid dynamic template ids,
  not ~12, each from an env var (`functions/src/notifications/email.ts:210-226`): welcome,
  password_reset, email_verification, invitation, notification_digest, trial_ending,
  subscription_updated, payment_failed, workflow_completed, workflow_failed, share_notification,
  comment_mention, seller_payout_failed, approval_requested, approval_escalated. The setup doc
  lists only the first 12 (`docs/FIREBASE_FUNCTIONS_SETUP.md:104-115`). Subjects are built in code
  (`email.ts:403-425`); an unset id falls back to escaped inline HTML (`:390-391`).
- **Marketing list:** one "product updates" list (`SENDGRID_MARKETING_LIST_ID`, `config.ts:66-68`)
  synced from signup consent (`marketing.ts:68-225`).
- **ASM groups:** three env groups (marketing / newsletter / product) used only on *unsubscribe*
  (`unsubscribe.ts:187,215,338-353`); outgoing mail never sets `asm.group_id` (`email.ts:22-33`).
- **HMAC unsubscribe:** `base64url(JSON{email,userId,listId,createdAt,expiresAt}).base64url(HMAC)`,
  30-day expiry, email in the URL, unauthenticated callable (`unsubscribe.ts:43-163`;
  `functions/src/index.ts:3941-3961`).
- **Versioning / approval:** none. `campaignTemplateStore.ts` is a client-only Zustand store
  (`:105-150`).

**Warts — never inherit:** the code reads `UNSUBSCRIBE_SECRET` but the deployed secret is
`UNSUBSCRIBE_HMAC_SECRET` (`unsubscribe.ts:56` vs `runtimeSecrets.ts:30`); signature compared with
`!==` (`:119`); links die after 30 days; one unset group id disables all group suppression
(`:344-351`); "unsubscribe all" writes a global suppression that also blocks transactional mail
(`:296-299`); no `List-Unsubscribe` / RFC 8058; email address in the URL.

### openwop-app today (`4cdb132c3`)

| Concern | Owner | Finding |
|---|---|---|
| Template model | `features/email/emailService.ts:35-41` | `EmailTemplate {templateId,name,subject,body,format?,…}` — **no version**. `updateTemplate` is a whole-row CAS retry (`:270-279`). `deleteTemplate` ignores referencing campaigns (`:281-284`). |
| Campaign model | `emailService.ts:43-64` | `CampaignStatus = 'draft'|'sending'|'sent'`; `templateId` only — no version pin. |
| Send | `routes.ts:289-307` → `emailService.ts:522-541` | `workspace:write` only. `sendCampaignSerialized` **re-reads the live template per batch** (`:541`), so an edit during `sending` changes the rest of the send. Guards: resend 409 → console-stub 501 → no sender 501 → no link base 501; per recipient consent (`:654-660`) then `suppressionBlocksSend` (`:675`). |
| Rendering | `emailService.ts:234`; `engagementService.renderHtmlBody:367`; `safeMarkdown.ts` | `{{contact.name|email|company}}` only; escape-first text or safe Markdown. No MJML/Handlebars. |
| Adapter | `host/emailAdapter.ts:73-149,195-232` | SendGrid / Postmark / SMTP. No dynamic template id, no ASM group. RFC 8058 one-click headers already emitted (`listUnsubscribeHeaders` `:109-121`). |
| Unsubscribe | `engagementService.ts:60-111,196-209`; `routes.ts:426-597` | **Opaque `tok:<uuid>` rows**, never expire, revocable, no PII in the URL; widen-only-while-fresh (ADR 0655 D3). Stronger than MyndHyve's HMAC. |
| Consent / suppression | `consent/consentService.ts:37-41`; `crm/suppressionService.ts:23,155` | per-channel `marketing.email`; tenant-wide suppression. **No topic/list granularity.** |
| Transactional mail | `orgs/inviteDelivery.ts:75-79`; `host/emailApprovalDelivery.ts`; `crm/signService.ts:288,300`; `crm/bookingService.ts:364,506`; `commerce` (`features/commerce/transactionalEmail.ts` `sendTransactionalEmail` seam, transport set in `commerce/feature.ts:82` to `email/brokeredProvider.ts:114` `sendBrokeredTransactionalEmail`, idempotent via the email sent-ledger); `billing/funnelWeeklySummary.ts` | Each sender hard-codes **English-only** subject/body strings. Commerce alone has a send **seam** (pluggable transport); nobody has a template registry, locale, or operator override. Password reset / verification belong to Firebase (ADR 0026). |
| Packs / surface | `email/feature.ts:41-58`; `email/surface.ts:40-75` | toggle `email` (OFF, tenant, depends `crm`). `feature.email.nodes@1.2.1` (`get-template`, `list-templates`, `render`); copywriter agent; `ctx.features.email.createDraftCampaign` (`workspace:write`) — **no send in ctx**. |

### The approval primitive to compose (single owner)

`host/approvalService.ts` `PendingApproval` is the one durable approval queue ("no new approval
store", ADR 0025 §4). Adding a kind = an `APPROVAL_KINDS` entry (`:40-66`) with a redactor (APPR-5
test) + a `KIND_DISPATCH` row (`host/approvalDecision.ts:324`, `satisfies Record<DecidableKind,…>`
so a missing row fails `tsc`) + a `create…Once` creator.

CMS is the reference consumer (`features/cms/contentApproval.ts`, ADRs 0066/0593/0859):
version on the subject (`Page.version`), version pinned on the row (`pageVersion`), one open row
per subject with **repin** on resubmit (`:447-460`), deterministic id
(`appr:cms:sha256([tenant,pageId,createdAt,reviewCycle])`, `:505-508`), CAS create
(`createContentApprovalOnce`), and on decide: re-read subject → `review_closed` 409 if gone → on
approve `stale_review` 409 if `live.version !== pinned` → self-approval refusal → CAS resolve →
`transitionPage(…, {expectedVersion})` with `reopenApproval` compensation. The `cms-approval-gate`
toggle only decides whether a direct publish may **bypass** review.

The existing `campaign-spend` kind is a different act (ads spend; audits as
`campaign.ads.spend-*`, `approvalDecision.ts:581-588`) and must not be reused (ADR 0554 note).

### Boundaries audit

- **Template store owner:** `emailService` (`DurableCollection` rows). Versions are a sibling
  collection in the same service, not a new package.
- **Approval owner:** core approvals queue; `email` owns only its kind's handler.
- **Egress owner:** `email/egressGuard.ts` + ADR 0655 — sends still exit only there.
- **Transactional templates:** the seam already exists in the wrong place —
  `features/commerce/transactionalEmail.ts` (`sendTransactionalEmail` + `setTransactionalEmailTransport`).
  D6 **hoists that seam** to `host/transactionalEmail.ts` (one owner) rather than writing a second
  one, because the senders live in `orgs`, `crm`, `commerce`, `billing` and `host/`. The transport
  stays the brokered spine (`sendBrokeredTransactionalEmail`, `email/brokeredProvider.ts:114`) with
  its sent-ledger idempotency keys; `commerce/feature.ts:19` already imports it, so the transport
  registration moves to `email`'s feature boot and the seam's no-transport answer stays the
  documented honest no-op.
- **Route collision:** new routes under the existing `${ORG}` email router
  (`…/templates/:id/versions`, `…/campaigns/:id/submit-review`, `…/campaigns/:id/withdraw-review`,
  `…/topics`); `git grep` for each → none.

## Decision

**D1 — Immutable template versions.** `EmailTemplate` gains `version: number` and
`contentHash` (sha256 of `subject`, `body`, `format`). Every successful update writes an immutable
`email:template-version` row `{templateId, version, subject, body, format, contentHash, createdBy,
createdAt}` and bumps `version` under an **expected-version CAS** (`If-Match`-style `expectedVersion`
on `PATCH`; mismatch ⇒ 409 `version_conflict`, the CMS shape). Routes: list versions, get one,
restore (= a new version copying an old one). Delete becomes **refused (409 `template_in_use`)**
while any non-`sent` campaign references the template; versions of a deleted template are kept
while a `sent` campaign references them (audit: what was sent).

**D2 — A campaign pins what it sends, gate or no gate.** At send start, `sendCampaign` resolves
the template version once and stamps `campaign.sendPin = {templateVersion, contentHash}` in the
same CAS that moves `draft → sending`; every batch renders from that **version row**, never the
live template. This fixes the mid-send-edit defect independently of approval and makes ADR 0193's
"approved bytes = sent bytes" rule structural.

**D3 — The `email-campaign-send` approval kind.** Campaign statuses become
`draft | in_review | approved | sending | sent` (+ `changes_requested` as a draft-with-reason).
- **Pin:** `{templateId, templateVersion, contentHash, senderAddress, audienceHash}` where
  `audienceHash` hashes the audience **definition** (`stage` / `segmentId` + segment definition
  version), not its membership. Membership is resolved at send, because consent and suppression
  must be evaluated at send time (ADR 0217/0655) — an approval can never widen who is mailable.
  The review card shows the estimated recipient count at submit, labelled as an estimate.
- **Queue:** `submit-review` creates the row via `createEmailSendApprovalOnce` (CAS, deterministic
  id `appr:email:sha256([tenant,campaignId,createdAt,reviewCycle])`); resubmit repins the open row.
  Any edit to the template, sender or audience while `in_review`/`approved` returns the campaign to
  `draft` and auto-resolves the row (`review_closed`) — the CMS lifecycle (ADR 0593).
- **Decide:** `KIND_DISPATCH['email-campaign-send']` — re-read the campaign and template; 409
  `review_closed` if no longer `in_review`; on approve 409 `stale_review` if the live pin differs;
  **self-approval refused** via CMS's delegation-aware, fail-closed `selfApprovalBlocked`
  (`contentApproval.ts:632-656`), **hoisted to `host/approvalSelfCheck.ts`** in P2 so both kinds call
  one helper (`email` cannot import `cms`); CAS resolve;
  transition `in_review → approved` with `expectedVersion`, `reopenApproval` on failure.
  **Who may approve (architect E1, settled):** by default `host:members:manage` (admin/owner) —
  the CMS precedent (`contentApproval.ts:209`). For the agency → client case, an org setting
  `emailApprovers: {roleRefs[], groupRefs[]}` is stamped onto the row as the existing ADR 0075
  `approverRoleRefs` / `approverGroupRefs` (`approvalService.ts:430-433`) and checked with
  `isEligibleApprover` (`host/approverResolution.ts:175`). **No new scope:** a custom role may carry
  only RFC 0049 protocol scopes (`isProtocolScope`, `accessControlService.ts:217-226`, enforced at
  `routes/accessControl.ts:289`), so a mintable `host:email:approve` would break that invariant, and
  a new protocol scope would be a wire change. `approvals:respond` alone (every editor has it,
  `:241`) is not enough: an editor could approve a peer's send.
- **Send:** with the gate ON, `sendCampaign` (the service, not the route — so every caller is
  gated) refuses 409 `approval_required` unless the campaign is `approved` and its live pin equals
  the approved pin — **or** is `sending` with a `sendPin` equal to the approved pin (a resumed batch
  is a continuation, `emailService.ts:533-536`; refusing it would strand every in-flight send the
  moment the gate turns on); the send then stamps `sendPin` from the **approved** pin (D2). Resend of a
  `sent` campaign requires a fresh approval cycle.
- **Notifications:** the existing approval notification path (`emailApprovalDelivery`,
  ADR 0010 emit seam) carries "approval requested" — MyndHyve's `approval_requested` /
  `approval_escalated` templates map here, not to new sends.

**D4 — Toggle `email-approval-gate`.** Same semantics as `cms-approval-gate`: the review queue is
always available; the toggle decides whether a direct send may **bypass** review. **Default OFF**
(bucket `tenant`, category `Marketing`, `dependsOn: ['email']`), because turning it on silently
would block every live sender's next campaign. The MyndHyve distribution manifest
(`distributions/myndhyve.json`) ships it ON. Whether the platform default should flip to ON is a
product call (Open decision 2).

**D5 — Agents draft and submit, never approve or send.** `ctx.features.email` gains
`submitForReview(campaignId)` (`workspace:write`); there is still **no** `send` in ctx. Node
`feature.email.nodes.submit-for-review` declared `role:"side-effect"` +
`capabilities:["side-effectful"]` with `SERVED-SET-BASELINE.json` regenerated — the ADR 0627 D1 guard
is the **classification**, not a role-`action` convention. A `mode:'replay'` fork serves the recorded
outcome; a `branch` fork re-runs live by design and is idempotent because resubmitting an
`in_review` campaign repins the one open row (D3). The copywriter agent's tool list gains it; its prompt states it cannot approve
(test-pinned). Approval stays human, in the Approvals inbox.

**D6 — Transactional templates as a host registry, not SendGrid dynamic templates.**
`host/transactionalEmail.ts` (the hoisted commerce seam): `registerTransactionalTemplate({kind,
render(locale, data) → {subject, text, html?}})` with the four product locales, `{{var}}` escaping by construction, and a
golden test per kind. Senders call `sendTransactional(kind, to, data, {locale})` through the
existing egress (`purpose:'transactional'`). Operator override: a white-label distribution may
register a replacement renderer per kind at build time (ADR 0366 load hooks); **no per-tenant
editing in v1** (transactional copy is product copy, and tenant-edited security mail is a phishing
vector). Brokered sends need an acting user's Connection (the existing spine); a sender with no
acting user and no Connection gets the seam's honest `no_transport` — stated, not hidden.
Migration of the existing hard-coded senders, one PR each:

| MyndHyve template | openwop-app owner | Action |
|---|---|---|
| password_reset, email_verification, welcome | Firebase Auth (ADR 0026) | none — not ours to send |
| invitation | `orgs/inviteDelivery.ts` | migrate to registry |
| approval_requested, approval_escalated | `host/emailApprovalDelivery.ts` | migrate to registry |
| share_notification, comment_mention, workflow_completed/failed, notification_digest | notifications email channel (ADR 0010; digests deferred, ROADMAP §0010) | register kinds; digest stays deferred |
| trial_ending, subscription_updated, payment_failed | `billing` (Stripe sends receipts/dunning today) | register kinds; send only where Stripe does not |
| seller_payout_failed | `commerce-connect` | register kind |
| (openwop-only) signature request/signed, booking confirmed/rescheduled/cancelled, order confirmation, funnel weekly summary | `crm/signService`, `crm/bookingService`, `commerce`, `billing/funnelWeeklySummary` | migrate to registry |

SendGrid dynamic templates are rejected: the content would live outside our versioning, locales
and tests; Postmark/SMTP would lose parity; and a template id in an env var is exactly the
MyndHyve drift (15 ids, docs list 12).

**D7 — Subscription topics (the ASM-group port), narrowing only.** An org defines topics
(`{topicId, name, description}`, max 20) — **opt-out lists only in v1**: no `default:'out'`
(opt-in) topics, which would be a second consent meaning the ADR does not need (architect E5). A campaign targets one topic
(optional; none = the org's general list). The preference centre (ADR 0227) lists topics; a
recipient's topic opt-out is a row keyed `(tenant, org, contactId, topicId)`. At send, topic
opt-out is checked **after** `marketing.email` consent and suppression and can only **exclude** —
it never widens consent (ADR 0655). The check is a narrowing argument **inside the consent seam**
(`consentService.isAllowed(…, {topicId})`), so there is still one evaluator ("no second evaluator",
`consentService.ts`), and the topic rows register a subject eraser (ADR 0464). "Unsubscribe from everything" stays the existing full
marketing opt-out and **never touches transactional mail** (MyndHyve wart fixed). Topics are
internal state, provider-agnostic; nothing is mirrored to SendGrid ASM.

**D8 — Keep opaque unsubscribe tokens; do not port HMAC.** Existing `tok:<uuid>` rows are
revocable, carry no PII and never expire — strictly better than MyndHyve's 30-day HMAC with the
email in the URL. RFC 8058 headers already ship (ADR 0848).

**D9 — The platform "product updates" list composes, it is not a feature.** The platform
operator's own marketing list = the system-site tenant's CRM + an email campaign + a topic, fed by
signup consent. No code beyond a signup-consent → contact hook, and only if David wants a platform
list (Open decision 3).

### Rejected

- **Approve the template instead of the campaign.** A template is reusable; the act being approved
  is "send *this* content from *this* sender to *this* audience". The template version is part of
  the pin, not the subject.
- **Pin audience membership.** Would require approving a recipient list that consent/suppression
  must then override anyway, and would store a PII snapshot per approval.
- **A new `email-approvals` store or a workflow-interrupt approval.** Forks the one queue; the
  campaign send is a host route, not a run.
- **Reuse `campaign-spend`.** Different act, different audit (ADR 0554).

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | All in `features/email/` except two hoists to `host/` — `transactionalEmail.ts` (from `features/commerce/`, D6) and `approvalSelfCheck.ts` (from `features/cms/`, D3) — and the approval kind registration in `host/approvalService.ts` / `approvalDecision.ts` (the documented extension point). |
| 2 | Toggle + admin UI | New `email-approval-gate` (OFF, `tenant`, `Marketing`, `dependsOn: email`), managed in `FeatureTogglePanel`. `email` toggle unchanged. |
| 3 | Workflow surface | `ctx.features.email.submitForReview`; read `getTemplate` gains `version`. No send. |
| 4 | Node pack | `feature.email.nodes` 1.3.0: `submit-for-review` (`side-effect` + `side-effectful`, served-set baseline regenerated); `get-template` returns `version`. Not a gate node, so not in `APPROVAL_GATE_TYPE_IDS`. |
| 5 | AI chat + envelopes | No envelope. Copywriter agent gains the `submit-for-review` tool (pack-allowlisted). |
| 6 | Agent pack | `vendor.openwop-app.email.agents` 1.1.0: tool added; "you cannot approve or send" in the prompt, test-pinned. |
| 7 | Public surface | Preference centre `/public-email/p/:token` lists topics (existing public route; token-scoped, uniform 404). |
| 8 | RBAC | Templates/campaigns `workspace:write`; approve = `host:members:manage`, or an org-configured approver role/group via ADR 0075 refs + `isEligibleApprover`; no new scope; self-approval refused; tenant+org IDOR on decide (the CMS order). |
| 9 | Replay / fork | No run-time send changes. `submit-for-review` is classified `side-effect` (replay forks serve the recorded outcome; branch forks repin the one open row). Approval rows are host state, not run state. |
| 10 | Frontend | Template editor: version history + diff + restore; campaign: status chip (draft/in review/approved/sent), "Submit for review", pinned-preview banner; Approvals inbox card renders the **pinned version** (approve what you see). Preference centre topics. 4-locale strings. |

## Implementation plan — one mergeable PR per phase

Each phase is an independently mergeable PR off `origin/main`, gated by `npm run ci`, citing
`ADR 0905 P<k>` in its commits, and adding a row to an implementation record in this ADR when it
lands. **Track 1 needs no new spend, vendor account or credential and is ordered first so it ships
regardless; Track 2 phases wait on the named Open decision.** Phases within one ADR that touch
the same large file (noted) merge serially, not in parallel. A pack version bump in any phase
needs the registry republish that `check-pack-version-bump` names.

All phases are Track 1 — **no new spend, vendor account or credential.** Open decisions 1–3 are
product-scope choices that change defaults, not whether a phase can merge; decision 4 (MyndHyve's
SendGrid key) is an operator config step after P3, not a code dependency.

**P0 — send pin + delete guard.** (S, 1–2 d) · David: no.
- Owns: `features/email/emailService.ts` (`sendPin` stamped in the `draft → sending` CAS; batches render
  from it; `deleteTemplate` 409 `template_in_use`).
- Tests: `test/email-send-pin.test.ts` (red first: edit mid-send ⇒ later batches unchanged);
  `test/email-template-delete-guard.test.ts` (route-level).

**P1 — template versions.** (M, 3 d) · David: no.
- Owns: `features/email/emailService.ts` (version rows `email:template-version`, expected-version
  CAS, restore); `features/email/routes.ts` (`…/templates/:id/versions[/:v]`, `…/restore`);
  `features/email/surface.ts` (`getTemplate` returns `version`); FE `emailClient.ts`,
  `EmailTemplateDetailPage.tsx`, `EmailTemplateViews.tsx`, `i18n/*` (history, diff, restore).
- Tests: `test/email-template-versions.test.ts` (concurrent edit ⇒ one 409; restore = new version;
  P0 pin now reads version rows); FE `__tests__/templateHistory.test.tsx`; erasure of version rows
  covered by the existing email erasure test.

**P2a — shared approval self-check hoist.** (S, 1 d) · David: no.
- Owns: new `host/approvalSelfCheck.ts` (moved `selfApprovalBlocked` + refusal form);
  `features/cms/contentApproval.ts` (imports it). Pure refactor, no behaviour change.
- Tests: existing CMS approval suite green; `test/approval-self-check.test.ts` (delegation-aware,
  fail-closed) moved with it.

**P2b — `email-campaign-send` approval kind + `email-approval-gate` toggle.** (M–L, 5–6 d) · David: no
(default OFF; the default question is Open decision 2).
- Owns: `host/approvalService.ts` (kind + redactor + `createEmailSendApprovalOnce`);
  `host/approvalDecision.ts` (`KIND_DISPATCH` row); new `features/email/sendApproval.ts`
  (queue/repin/decide/review-closed, ADR 0075 org approver refs); `features/email/emailService.ts`
  (statuses, the gate in `sendCampaign`, `sending` continuation); `features/email/routes.ts`
  (`submit-review`, `withdraw-review`, org approver settings); `features/email/feature.ts`
  (toggle `email-approval-gate`, OFF, tenant, `dependsOn: email`). Serial after P2a.
- Tests: `test/email-send-approval.test.ts` — the CMS ladder (stale 409, closed 409, self-approval
  refused, CAS double-approve ⇒ one transition, approver-group member allowed / non-member refused);
  `test/email-send-approval-gate-route.test.ts` (gate ON ⇒ 409 from the route **and** from
  `sendCampaign` directly; resumed `sending` proceeds when the pin matches); APPR-5 redactor test;
  toggle catalog test.

**P2c — agent + node + FE review flow.** (M, 3 d) · David: no.
- Owns: `features/email/surface.ts` (`submitForReview`); `packs/feature.email.nodes` 1.3.0
  (`submit-for-review`, `role:"side-effect"` + `side-effectful`, schemas) + `SERVED-SET-BASELINE.json`
  + side-effect floor regen; `packs/vendor.openwop-app.email.agents` 1.1.0 (tool + "cannot approve
  or send", test-pinned); FE `EmailPage.tsx` (status chips, submit, pinned-preview banner), approvals
  inbox card renderer for the kind, `i18n/*`.
- Tests: replay-fork witness through the real executor (no second row); `pack-surface-arg-parity`,
  `promptCatalogParity` for the agent; FE `__tests__` for review flow + inbox card (renders the
  pinned version).

**P3 — transactional template registry.** (M, 4–5 d, one PR for the seam + one per sender) · David: no.
- Owns (seam PR): `host/transactionalEmail.ts` (hoisted from `features/commerce/transactionalEmail.ts`
  + `registerTransactionalTemplate`, 4 locales, escaping by construction); `features/commerce/*`
  imports updated; transport registration moved to `features/email/feature.ts`.
- Owns (sender PRs): `features/orgs/inviteDelivery.ts`; `host/emailApprovalDelivery.ts`;
  `features/crm/signService.ts`; `features/crm/bookingService.ts`; `features/commerce/*`;
  `features/billing/funnelWeeklySummary.ts`; each with its own kind + locale strings.
- Tests: `test/transactional-email-registry.test.ts` (4-locale goldens per kind; `\r\n` cannot reach
  a header; no-transport is the honest no-op); each sender's existing test re-pointed at the registry.

**P4 — subscription topics.** (M, 3 d) · David: no.
- Owns: `features/consent/consentService.ts` (`isAllowed(…, {topicId})` narrowing arm + topic
  rows + eraser); `features/email/emailService.ts` (campaign `topicId`); `features/email/routes.ts`
  (`…/topics` CRUD); preference centre `routes.ts:476-597` + `publicPageStrings.ts`; FE topics
  panel + `i18n/*`.
- Tests: `test/email-topics.test.ts` (opt-out excludes; topic cannot re-include a `marketing.email`
  opt-out; full opt-out never blocks transactional); erasure census includes topic rows.

**P5 — platform product-updates list.** (S, 1 d) · David: **yes** — Open decision 3 (product scope).

## Tests

Per-phase tests are named in the implementation plan above. Every phase lands red-first:
the failing test is committed before the fix, so each PR shows the defect and its closure.

## Open decisions for David

1. **Product scope: who may approve.** Org admins only, or also client users named as
   approvers via the org's approver roles/groups (ADR 0075 refs) (the agency → client approval the YC demo needs)? The ADR plans both; David may
   cut the client role.
2. **Product scope: platform default for `email-approval-gate`.** OFF (no behaviour change for live
   senders; MyndHyve build ON) or ON everywhere.
3. **Product scope: a platform "product updates" list** (D9) — yes/no.
4. **Vendor account:** the MyndHyve SendGrid account's sender domain and key, if MyndHyve-branded
   sends should keep its sending reputation (credential only David holds).

## Architect review (2026-10-17)

`/architect`, Track A + Track B check. Independent adversarial review; findings verified in code and
**folded into the decisions above**.

| # | Sev | Dimension | Finding | Resolution |
|---|---|---|---|---|
| E1 | CRITICAL | AuthZ / wire | The first draft minted a `host:email:approve` scope onto custom roles. Custom roles carry **only** protocol scopes (`accessControlService.ts:217-226`, enforced `routes/accessControl.ts:289`); the only literal alternative — a new protocol scope — is a **wire change needing an RFC**. | D3: `host:members:manage` default + ADR 0075 approver refs (`approvalService.ts:430-433`, `isEligibleApprover`). No new scope, no RFC. |
| E2 | HIGH | Duplication | A transactional send seam already exists in `features/commerce/transactionalEmail.ts`. | D6 hoists it to `host/`; brokered transport + sent-ledger kept. |
| E3 | HIGH | Duplication | `selfApprovalBlocked` lives in `features/cms` (`contentApproval.ts:632-656`) and `email` cannot import it. | D3: hoist to `host/approvalSelfCheck.ts`; both kinds call it. |
| E4 | HIGH | Failure modes | "Refuse unless `approved`" would strand resumed `sending` batches (`emailService.ts:533-536`). | D3: `sending` with a matching `sendPin` proceeds; tested. |
| E5 | MEDIUM | Single evaluator | A separate topic store would be a second consent evaluator; `default:'out'` topics introduce opt-in semantics. | D7: opt-out topics only, evaluated inside `consentService.isAllowed`; eraser registered. |
| X2 | HIGH | Replay | "Fork-guarded per ADR 0627" misread the ADR: the guard is the `side-effect` classification, not role `action`. | D5: `side-effect` + `side-effectful`, served-set baseline regenerated. |
| E6 | MEDIUM | AuthZ | `approvals:respond` is checked only on open gates (`approvalDecision.ts:151-178`). | The kind handler does its own IDOR + scope check in CMS order (D3). |

**Boundaries:** one approval queue, one egress, one transactional seam, one consent evaluator.
**RFC (Track B):** confirmed host-extension **because** E1 was resolved without a protocol scope.
**Verdict:** Accepted as a plan.
