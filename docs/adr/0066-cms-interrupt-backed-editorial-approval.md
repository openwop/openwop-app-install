# ADR 0066 — CMS interrupt-backed editorial approval (ADR 0009 follow-on)

**Status:** implemented (Phases 1–3, 2026-06-18).

### Phase → implementation ledger
| Phase | What shipped | Files |
|---|---|---|
| 1 | `PendingApproval.kind:'content-publish'` + `{orgId,pageId,pageTitle}`; `createContentApproval`; `hasPendingApprovalForPage`; `register/getContentApprovalHandler` hook; `cms-approval-gate` toggle (default OFF) | `host/approvalService.ts`, `features/cms/feature.ts` |
| 2 | Content-approval handler (org RBAC `host:members:manage` + IDOR + `transitionPage`); toggle-gated `submit`→create-approval (idempotent) + direct-`approve` 409 deferral; approvals claim/reject `content-publish` branch | `features/cms/contentApproval.ts`, `features/cms/routes.ts`, `routes/approvals.ts` |
| 3 | Inbox `content-publish` card group + published toast; `PendingApproval` client type | `notifications/ApprovalsInbox.tsx`, `agents/approvalsClient.ts`, `notifications/i18n/{en,pt-BR}.ts` |
| Tests | submit-queues / direct-approve-409 / claim-publishes / idempotent / reject-to-draft / editor-403 / toggle-OFF-byte-identical / org-filtered-list / reject-clears-approval / publish-bypass-409 / failed-transition-reopens | `test/cms-approval-gate.test.ts` (8 cases) |

### Post-merge hardening (code-review, 2026-06-18)
- **HIGH-1 / LOW-4 — compensating re-open.** The decide path resolves the approval (CAS) before transitioning the page; if the transition fails (stale `in_review`, or a deleted page), `reopenApproval` now restores the row to `pending` so a failed decide never consumes the approval (the record never claims "approved" while the page stayed unpublished).
- **MEDIUM-2 — org-filtered inbox list.** The approvals LIST org-filters `content-publish` rows to viewers with `host:members:manage` in the page's org (other kinds stay tenant-scoped), so a non-managing tenant member never sees the page title/existence (the decide was already org-gated).
- **MEDIUM-3 — no orphaned approvals.** Direct `reject`/`unpublish` resolve (reject) any pending content-publish approval for the page when the gate is ON; and the direct `publish` route — another publish bypass — now 409s like `approve` when the gate is ON (the inbox is the only publish path for a gated org).

Verify: backend `tsc` clean + full suite **1914 passed**; FE `npm run build` green.
**Date:** 2026-06-18
**Extends:** ADR 0009 (CMS / Page Builder) — closes its deferred "Interrupt-backed
approval" open question / Alternative 1.
**Toggle:** NEW `cms-approval-gate`, **default OFF** (opt-in). When OFF, the CMS
editorial workflow is byte-identical to today — a status-only state machine with
RBAC authority; no approval row is created and the direct `approve` route works
unchanged.
**RFC gate:** **No new RFC.** Pure host composition under
`/v1/host/openwop-app/*` — composes the existing host approval queue
(`host/approvalService.ts`) and the existing CMS workflow. No wire surface.

## Why this exists

ADR 0009 ships the CMS editorial workflow as an RBAC-gated **status state
machine** (`draft → in_review → published → archived`, `cmsService.transitionPage`
+ `WORKFLOW_RULES`). Publishing authority is real (`approve`/`reject` =
`host:members:manage`), but the gate is a status-field flip with no durable,
inbox-visible, resumable "this is awaiting your approval" artifact. ADR 0009
recorded "wire the OpenWOP `approval` interrupt as the editorial gate" as a
deferred follow-on / open question. This ADR delivers that editorial *value* —
an audited, resumable, inbox-surfaced human-approval gate — and **corrects the
framing**: the right primitive is the host's run-independent approval queue, not
the run-scoped wire interrupt.

## Context — the host already has the right primitive (audited)

There are **two** approval mechanisms in this host:

1. **Run-scoped HITL interrupt** — `core.approvalGate` node, `kind:'approval'`
   (`types.ts`), resolved via `resolveByRun(runId, nodeId, decision)`. It
   **attaches to a node in a workflow run** — it cannot exist without a run.
2. **Run-independent approval queue** — `host/approvalService.ts`
   (`DurableCollection<PendingApproval>('approval')`): `createApproval` /
   `listApprovals` / decide, with **no run**. It backs the **ApprovalsInbox** and
   the heartbeat loop that deliberately "does NOT start the run"
   (`approvalService.ts`). It was **already extended once** — a `kind`
   discriminator (`'run-proposal' | 'assistant-action'`) added the Executive-
   Assistant outbound-action variant **on the same queue**, under the in-code
   principle **"ADR 0025 §4 — no new approval store."**

A CMS publish is a **REST mutation with no run**. Using primitive #1 would force
spinning up a workflow run *solely to borrow the interrupt* — a parallel run
lifecycle, a workflow template, a status-flip callback, and a replay/fork surface
— for no added authority. Primitive #2 is exactly "human approval without a run,"
already inbox-wired, already proven extensible by `kind`.

## Decision

**Compose the existing run-independent approval queue (`host/approvalService.ts`)
via a new `kind:'content-publish'` variant — no new store, no run.**

### 1. Approval-queue variant (single source of truth)
Extend `PendingApproval` with `kind:'content-publish'` carrying
`{ orgId, pageId, pageTitle }`; the agent-centric fields (`rosterId`, `persona`,
`workflowId`) become optional for this kind (mirrors how `actionId`/`kind` were
added for `'assistant-action'`). Add a `hasPendingApprovalForPage(tenantId,
pageId)` idempotency guard (mirrors `hasPendingApprovalForCard`). **No second
approval store** — that would be a parallel system (CRITICAL boundary violation;
two inboxes for one concept).

### 2. CMS wiring (toggle-gated)
When `cms-approval-gate` is ON for the org:
- `submit` (draft → in_review) ALSO calls `createApproval({ kind:'content-publish',
  orgId, pageId, pageTitle, proposal })` (idempotent: one open approval per page).
- The queue's **decide** path calls `transitionPage(approve | reject)` to flip
  status + snapshot the published version (the existing publish path — single
  owner of the transition).
- The **direct `approve` route is gated off** for that org (publishing goes
  through the queue); `reject`/`unpublish`/`archive` are unchanged.

When OFF: nothing changes — no approval row, direct `approve` works (byte-identical).

### 3. RBAC / isolation (preserve `WORKFLOW_RULES` exactly)
- `submit` = `workspace:write` (an editor proposes).
- decide (`approve`/`reject`) = `host:members:manage` — and the decide route MUST
  verify the approval's `orgId` matches the page's org and the caller holds
  `host:members:manage` **in that org** (IDOR guard; the queue is tenant-scoped
  today, CMS adds the org+role dimension). Cross-org decide → uniform 404.
- Fail-closed: toggle ON + status `in_review` ⇒ only the queued approval can
  publish.

### 4. Replay / fork
**N/A — there is no run.** The approval is durable host state, not run state, so
there is no interrupt-on-a-run and no replay/fork surface. (This is a primary
reason to prefer the run-independent queue over the run-scoped interrupt.)

### 5. Data integrity
One open approval per page (`hasPendingApprovalForPage`); the existing
`withApprovalLock` per-`approvalId` compare-and-set + `transitionPage`'s
`from:['in_review']` guard (a double-approve hits 409) make the decide path
atomic single-instance (the documented cross-instance conditional-write caveat on
`resolveApproval` still applies).

## Boundaries audit

- **Single source of truth for "pending approval" = `host/approvalService.ts`.**
  This ADR composes it; it does NOT add a CMS-only approval store.
- **Single owner of the status transition = `cmsService.transitionPage`.** The
  decide path calls it; it does not re-implement publish.
- **Feature-package boundary (ADR 0001) intact** — CMS changes stay in
  `features/cms/`; the only core touch is the additive `kind` variant on the
  shared `approvalService` (the established extension seam, per ADR 0025 §4).
- **No parallel run lifecycle** — rejecting the run-scoped interrupt avoids
  standing up a workflow run for a REST mutation.

## Phased plan

- **Phase 1 — Queue variant + service.** `PendingApproval.kind:'content-publish'`
  + `{orgId,pageId,pageTitle}` (agent fields optional); `hasPendingApprovalForPage`;
  the `cms-approval-gate` toggle (default OFF). Service-level tests.
- **Phase 2 — CMS wiring.** Toggle-gated `submit`→create-approval; decide→
  `transitionPage`; direct-`approve` deferral for gated orgs; org+role+IDOR authz
  on decide. Route-level tests (createApp + cookie jar).
- **Phase 3 — Frontend.** A `kind`-discriminated `content-publish` row in the
  existing `ApprovalsInbox` (links to the CMS page); a "submitted for review /
  pending approval" state in `CmsPage`/`SectionsEditor`. `ui/` cohesion + a11y.

## Alternatives considered

1. **Run-scoped `core.approvalGate` (the literal ADR-0009 framing).** Rejected as
   the primary path — forces CMS publish to become a workflow run purely to borrow
   the run interrupt: a parallel run lifecycle + workflow template + status-flip
   callback + replay/fork surface, for no added authority. Wrong primitive for a
   runless REST mutation. (Still available later if a deployment wants the full
   workflow-engine trail — the state machine remains the seam, per ADR 0009.)
2. **A CMS-only approval store.** Rejected — a parallel system; two inboxes for
   one concept ("pending approval") that drift. Violates ADR 0025 §4.
3. **Status-only (today).** The baseline; this ADR is opt-in over it (toggle OFF
   ⇒ identical).

## Open questions

- [ ] Toggle id confirmed `cms-approval-gate`; `bucketUnit: tenant` (workspace-
  scoped editorial policy).
- [ ] Do gated orgs lose the direct-`approve` route entirely, or keep an
  admin-override (`host:members:manage` may still direct-publish)? Default:
  gate it off; revisit if operators want an override.
- [ ] Confirm the `ApprovalsInbox` row renderer discriminates on `kind` cleanly
  (a `content-publish` row links to `/cms` rather than a run/card).

## RFC gate

No wire surface → **no RFC**. Composes `host/approvalService.ts` +
`features/cms/*` under `/v1/host/openwop-app/*`. The run-scoped `core.approvalGate`
(unused here) is already Accepted regardless.
