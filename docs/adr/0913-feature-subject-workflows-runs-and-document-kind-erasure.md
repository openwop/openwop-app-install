# ADR 0913 — A feature erases the workflows and runs it created for one subject, and deletes its own document kind on erasure

Status: Accepted (implemented in this PR)

## Context

Book AI upstream proposals P1, P2, P20 and P11 (`bookai/docs/upstream-proposals.md`).

- **P1:** Book AI runs its AI tools by instantiating chains
  (`POST …/workflows/from-chain`). Each instantiation is a tenant-owned workflow
  whose frozen inputs hold the run's parameters: the question, a selected quote,
  the author's idea. When a book is deleted these definitions stay.
  - The only full delete recipe was inline in the tenant `DELETE` route:
    ownership, the run-reference refusal, the schedule guard, the live-room
    guard, and the revision cascade inside `deleteRegisteredWorkflow`.
  - A feature copying that recipe would drift from it.
- **P2:** Book AI found a book's runs by paging `listRuns({tenantId})` and
  reading each run's frozen revision. That is a tenant scan capped at 20,000
  runs, after which it reported `complete: false`.
- **P20:** the documents eraser anonymizes every document. Book AI decided that
  erasing a person deletes their Writing-studio plans (kind
  `bookai-story-plan`).
  - Book AI had to delete them itself before the documents eraser ran, so
    correctness depended on eraser registration order.
  - A retry after the documents eraser had run could no longer find the plans:
    `createdBy` had already become `erased:subject`.

## Decision

- **D1 — One delete recipe.** `host/tenantWorkflowDelete.ts`
  `deleteTenantWorkflow(storage, tenantId, workflowId)` is the route's recipe,
  moved, not rewritten. It returns `{deleted: true, removed}` or `{deleted:
  false, reason}`, where the reason is one of `not_owned`,
  `workflow_referenced`, `workflow_scheduled` or `workflow_room_live`. The
  route now calls it and maps the reasons to the same 404/409 bodies as before.
  Authorization stays with the caller.
- **D2 — A subject label at instantiation.** `from-chain` accepts an optional
  `subject`.
  - The grammar is `<feature>:<id>`: a lowercase prefix, then up to 200 of
    `[A-Za-z0-9:._-]`. A malformed subject is a 400.
  - The label is stamped on the parent workflow's ownership row and is sticky
    across saves, like `authoredVia`.
  - Sub-chain children are not labelled. They are shared across instantiations
    (their id keys on the chain version), so labelling one would let one
    subject's erasure delete another's child.
- **D3 — The erasure seam.** `eraseWorkflowSubject(storage, tenantId, subject,
  {reason})`:
  1. Under a tenant legal hold it deletes nothing and reports `legal_hold` for
     each labelled workflow.
  2. For each owned workflow with the label, it pages
     `listRuns({tenantId, workflowId})`. That read uses the existing
     `idx_runs_workflow` index, so there is no tenant scan and no new storage.
     It cancels each live run before deleting it, and deletes the run's
     sub-workflow child runs first (`listRunsByParent`): those run shared child
     definitions but carry this subject's data.
  3. It then deletes each workflow through D1.
  4. It returns `{complete, workflowsDeleted, runsDeleted, refused[]}`. A
     workflow with more than 10,000 runs in one call reports `runs_remaining`,
     and a second call continues.
- **D4 — A document kind that is deleted on erasure.** A feature calls
  `registerDocumentKindErasure(kind, 'delete')`.
  - The documents eraser then deletes a registered-kind document the subject
    created or owns, through `deleteDocument`. That is the one cascade:
    versions, rendered bytes and share links.
  - Every other kind is anonymized, as before.
  - Under a legal hold the registered kind is anonymized instead. A hold is
    never overridden by an erasure, and the identifier still goes.
  - This is order-independent. A retry still finds the plans, because nothing
    anonymized them first.

- **D5 — A checked first save** (Book AI P11). `POST …/documents/:id/versions`
  with `baseVersionId: null` means "I saw no version". It lands version 1, or
  it fails `409 stale_base` if any version exists. This is the version-1 case
  of the ADR 0838 D5 check. Two first saves from two tabs can no longer both
  land, because the version slot write is insert-only. The host's SPA client
  passes `null` through.

## Not done (left to the caller, or later)

- Labelling runs directly (`run.metadata.subject`, with a storage index). D3
  reaches runs through the workflow index already present, so a new index is not
  needed for Book AI's case: every Book AI run belongs to a labelled workflow.
- The P1 proposal mentions "pending proposal guards". The route had none for
  DELETE, so D1 adds none.

## Consequences

- Book AI can stamp `bookai:<orgId>:<bookId>` at `from-chain`, call
  `eraseWorkflowSubject` from `purgeDeletedProject`, and drop its run scan
  and its 20,000-run cap.
- It can register `bookai-story-plan` and drop `erasePersonPlans`, along with
  the registration-order test that guarded it.
- Workflows created before the label existed are not found by it. Book AI's
  existing scan remains its fallback for those.

## Implementation

| Part | Where |
| --- | --- |
| D1, D3 | `backend/typescript/src/host/tenantWorkflowDelete.ts`; `routes/workflows.ts` (DELETE now delegates) |
| D2 | `host/workflowOwnership.ts` (`subject`, `listOwnedBySubject`, `WORKFLOW_SUBJECT_PATTERN`); `routes/workflows.ts` (`from-chain`) |
| D4 | `features/documents/erasure.ts` (`registerDocumentKindErasure`) |
| D5 | `features/documents/documentsService.ts` (`addVersion`), `routes.ts`, `frontend/react/src/features/documents/documentsClient.ts` |
| Tests | `backend/typescript/test/adr0913-subject-erasure-seams.test.ts` |

## Checklist

- [x] D1–D4 with tests
- [ ] Tell Book AI the PR number
