# ADR 0068 - Unified review projection for interrupts and approvals

**Status:** implemented  
**Date:** 2026-06-18  
**PRD:** `docs/ai-chat-a-plus-prd.md`  
**Depends on / composes:** `routes/interrupts.ts`, `host/approvalService.ts`, `routes/approvals.ts`, ADR 0023 (assistant approvals), ADR 0066 (CMS approval gate), ADR 0051 (A2UI review rendering).  
**Surface:** host-extension under `/v1/host/openwop-app/reviews/*`.  
**RFC gate:** host work only. A standard cross-host review-list endpoint or normative review event needs a new OpenWOP RFC.

## Why this exists

Users currently meet two human-review systems:

- runtime interrupts, which pause an already-running workflow and resume through `/v1/interrupts/{token}` or `/v1/runs/{runId}/interrupts/{nodeId}`;
- pending approvals, which are pre-execution proposals in `approvalService` and resolve through `/v1/host/openwop-app/approvals/:id/{claim,reject}`.

That distinction is architecturally correct, but the user experience should be unified. A person should have one review inbox and one card model, while the backend preserves the source-specific semantics.

> **Enrichment note (2026-06-19, approval-card context):** the v1 projection left a
> reviewer staring at opaque ids — `requestedBy` was hardcoded to the literal
> `"workflow"`, and the card had no idea WHAT was being approved. `ReviewRequest`
> now also carries `workflowId` + `workflowName` (the initiating workflow's human
> name; `run.metadata.workflowName ?? workflowId`), a real `requestedBy` (the
> initiating human via `run.metadata.actingUserId`, else the *named* workflow —
> never the bare "workflow"), and `assets[]` — the concrete content under review
> (the gate's bundled `options[].content` + any pinned artifact binding) so the
> card can render the asset by type (email / markdown / text) instead of raw
> output. Host-extension only; no wire/RFC change.

## Feature-refinement audit

| Concept | Existing owner | Decision |
|---|---|---|
| In-flight workflow pause/resume | `interrupts` table + `routes/interrupts.ts` | Remains owner. Do not move runtime interrupts into `approvalService`. |
| Pre-execution proposal gate | `host/approvalService.ts` | Remains owner. Do not represent unstarted proposals as fake run interrupts. |
| Assistant action approvals | assistant feature handler registered into approval hooks | Keep the feature-specific decide handler. |
| CMS publish approval | CMS handler registered into approval hooks | Keep the feature-specific decide handler. |
| Review inbox shape | Missing | Add a projection over the two owners. |

## Decision

Add a unified, read-first `ReviewRequest` projection that lists, gets, and dispatches actions to source-specific handlers.

```ts
type ReviewSource = 'interrupt' | 'approval';
type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled' | 'resolved';

interface ReviewRequest {
  reviewId: `interrupt:${string}` | `approval:${string}`;
  source: ReviewSource;
  kind: string;
  status: ReviewStatus;
  tenantId: string;
  orgId?: string;
  runId?: string;
  nodeId?: string;
  interruptId?: string;
  approvalId?: string;
  artifactId?: string;
  revisionId?: string;
  requestedBy?: { kind: 'user' | 'agent' | 'system'; id: string; label?: string };
  requestedAt: string;
  dueAt?: string;
  risk?: { level: 'low' | 'medium' | 'high' | 'critical'; reasons: string[] };
  actions: ReviewAction[];
  provenanceRefs: ReviewProvenanceRef[];
}
```

The projection route never becomes a third state owner. `POST /reviews/:reviewId/actions/:action` maps:

- `interrupt:*` to the existing interrupt resolve path;
- `approval:*` to the existing approvals claim/reject path, including registered assistant/CMS handlers.

## Route plan

```text
GET  /v1/host/openwop-app/reviews?status=pending
GET  /v1/host/openwop-app/reviews/:reviewId
POST /v1/host/openwop-app/reviews/:reviewId/actions/:action
```

Mount the routes after `interrupts` and `approvals` in `registerAllRoutes.ts`. Since the path prefix is new, it does not collide with existing `/approvals` or `/runs/:runId/interrupts` routes.

## Authorization

- Listing is scoped to the caller's tenant and eligible orgs.
- A review is visible only if the caller could view its source record.
- A decision is accepted only if the caller could resolve the source record.
- Non-visible review IDs return 404, not 403, to avoid existence leaks.
- The action list is derived from the source-of-truth record after authorization.

## Phased plan

1. **Projection types and helpers.** Add `host/reviewProjection.ts` with mappers from `InterruptRecord` and `PendingApproval`.
2. **Read routes.** Add list/get routes with no-existence-leak tests.
3. **Action dispatch.** Add source-specific dispatch and stale/already-resolved responses.
4. **Frontend review card.** Add `frontend/react/src/chat/reviews/ReviewCard.tsx` and use it in chat, side panel, and inbox.
5. **Notifications.** Link notifications to `reviewId` where possible, but preserve source-specific deep links during rollout.
6. **Audit projection.** Show resolved history from source records and run events instead of raw message-local resume payloads.

## Acceptance criteria

- One inbox lists pending runtime interrupts and pending host approvals.
- Review cards use one normalized shape in chat, side panel, notifications, and inbox.
- Resolving an interrupt still uses interrupt ownership.
- Resolving an approval still uses `approvalService` and registered decision hooks.
- Already-resolved or stale decisions return explicit, user-actionable responses.
- Route tests cover tenant isolation, org scope, non-reviewer denial, no existence leak, and idempotent resolution.

## Alternatives considered

- **Move approvals into interrupts.** Rejected because pre-execution proposals do not have a run to suspend.
- **Move interrupts into `approvalService`.** Rejected because runtime pause/resume semantics, tokens, expiry, and replay belong to the OpenWOP interrupt path.
- **Frontend-only normalization.** Rejected because it cannot provide audit-grade visibility, stale-safe action derivation, or cross-surface consistency.

## Open questions

- Should resolved reviews remain visible in the same endpoint by default, or require `status=resolved`?
- How long should resolved projection rows be retained when their source is pruned?
- Should the projection include full resume values, or only redacted summaries plus source links?

## Implementation record

Phases 1–4 landed (notifications/audit projection — Phases 5–6 — deferred).

| Phase | Change |
|---|---|
| 1 Projection types + helpers | `host/reviewProjection.ts` — `ReviewRequest`/`ReviewAction`/`ReviewStatus` + `interruptToReview`/`approvalToReview` mappers + `listReviews`/`getReview`. Conversation-kind interrupts are excluded (a chat gate is not a review). |
| 2 Read routes | `routes/reviews.ts` — `GET /reviews`, `GET /reviews/:reviewId`. Tenant isolation via `run.tenantId===ctx.tenantId`; content-publish org gating REUSES `resolveEffectiveAccess`; non-visible → 404 (no existence leak). Mounted after `approvals` in `registerAllRoutes.ts`. |
| 3 Action dispatch | `POST /reviews/:reviewId/actions/:action`. **Single decision owner:** the approval claim/reject logic was extracted verbatim from `routes/approvals.ts` into `host/approvalDecision.ts` (`claimApproval`/`rejectApproval`); both `/approvals` and `/reviews` call it (38 approval tests guard the extraction). Interrupt resolve exports + reuses `resolveAndResume` + `validateResumeValue` from `interrupts.ts`. Actions are derived from the source AFTER authz (422 for an un-offered action); a re-decide is stale-safe (409). |
| 4 Frontend review card | `chat/reviews/{reviewClient,ReviewCard,ReviewInboxPanel}` + `DESIGN.md §5.1` registry rows. Actions render from the backend record; read-only when empty. |

**Corrections to the plan / open questions:**
- *Runtime-link:* none added — `reviewId` carries the source id and the source stores answer visibility directly; no projection sidecar.
- *Resolved-review listing (open question):* v1 returns the pending inbox; resolved history is reachable via `status=approved|rejected` for approvals. Resolved interrupts are not retained as open rows, so `status=resolved` returns the approval-source subset only. Documented, not yet a stored projection.
- *Known bound:* the interrupt scan is `listOpenInterruptsAll(500)` then tenant-filtered (no tenant index on interrupts — host is single-tenant). Truncation is logged; never a cross-tenant leak. A true multi-tenant deployment needs a tenant-indexed open-interrupt query in the runtime store (out of host-extension scope).
- *Auth granularity:* `/reviews` gates on `runs:read` (no-op in the demo). In a scope-enforced deployment an approval-only reviewer lacking `runs:read` would see an empty inbox — fail-closed, safe, noted for a future per-source gate.

Deferred: wiring `<ReviewInboxPanel>` into the chat nav shell, notification deep-links, and the audit-history projection. (Review strings were i18n'd into the `chat` catalog — en + pt-BR; pt-BR pending NS-1 review.)

Tests: `backend/test/reviews-route.test.ts` (list both sources, 404 no-existence-leak, unified interrupt resolve + stale 409, 422 action-not-offered) + 38 approval-regression; `frontend ReviewCard.test.tsx` (source-derived actions, dispatch+note, read-only-when-resolved, requiresValue empty-object).

