# ADR 1137 — Work items carry an assignee and can be refreshed

Status: Accepted (2026-11-15; David: "proceed with next phases"; design reviewed by openwop-app-14). P1 implemented in #5985, P2 in #5987, P3 in the PR after them. Answers openwop/openwop-app#5953 H1, H2 and H5.

Extends [ADR 0738](0738-kanban-core-work-item-execution.md) (work items) and
[ADR 0049](0049-kanban-card-assignment-to-people.md) (assignment and the "Assigned to me"
mirror). H5 reads the project role from [ADR 1095](1095-project-tab-roles.md). Host
extension only; no wire RFC is involved.

## Context

An adopter (CasaVoga, CV-0221) turns its own records into build-process tasks on project
boards. ADR 0738 work items are the host's way to do that: a deterministic identity per
source item, retries that converge, audit and outbox. They are missing three things, so the
adopter calls `createCard` directly instead:

1. **No assignee.** `KanbanWorkItemProposal` (`host/kanbanService.ts:480`) takes `dueAt`
   but not `assigneeId` or `assigneeRole`. A materialized card reaches no one's
   "Assigned to me" mirror, and nothing notifies anyone. Only `POST /cards/:id/assign`
   (`routes/kanban.ts:858`) and `ctx.kanban.taskAssign` (`host/kanbanSurface.ts:171`)
   send `kanban.assigned`.
2. **No refresh.** Re-materializing the same source returns the existing card unchanged
   (`createCard` returns an existing id as is). A due date that moved upstream never
   reaches the card. Bumping `source.revision` mints a new identity, so it makes a second
   card instead of updating the first.
3. **Workspace roles only.** `assigneeRole` matches workspace role keys in the mirror
   (`listCardsAssignedToUser`, `host/kanbanService.ts:2069`). A project's lead or
   contributor (ADR 1095) can't be addressed.

## Decision

### D1. A proposal may name an assignee

`KanbanWorkItemProposal` gains:

| Field | Meaning |
|---|---|
| `assigneeId?` | One person. |
| `assigneeRole?` | A role, claimable as in ADR 0049 D2. Mutually exclusive with `assigneeId`. |
| `assignmentReason?` | Shown with the assignment (≤ 500 chars). |
| `sourceLabel?` | The card's existing provenance label (≤ 200 chars). |
| `labels?` | Set when the card is created (≤ 20, each ≤ 64 chars). |

They are written onto the card when it is **created**, never later (D3).

**Validation happens in `prepareWorkItems`, before any write**, so a bad assignee fails the
whole materialization with `kanban_assignee_invalid` and writes nothing:

- `assigneeId` must be a member of the board's workspace (`isWorkspaceMember`, the assign
  route's rule).
- On a board that belongs to a subject (`boardSubject(board)`, e.g. a project's board), the
  assignee must also be able to **read** that subject: `subjectReadAllowed(tenant, subject,
  { subject: assigneeId })`. A private project's card can't be assigned to, and so notify,
  a non-member (ADR 1118).
- Both `assigneeId` and `assigneeRole` on one item is invalid.

**Client orgs.** A kanban board has no org of its own. `KanbanBoard`
(`host/kanbanService.ts:173`) carries `tenantId`, `columns`, `rosterId`, `ownerUserId`
and `ownerSubject`, and no `orgId`. So the only org a board can belong to is its subject's.
For a project, the subject check resolves through `resolveProjectAccess` in the project's
own org (`resolveEffectiveAccess(…, { orgId: p.orgId })`). A member who holds authority only
in client A gets `none` on a client-B project, and the materialization is refused. Any other
membership-scoped subject kind answers through its own registered resolver. The
caller-bound `clientOrgGate` (ADR 1121/1132) is the wrong instrument here, because the
question is about a third party.

The check is about the **assignee's** access, not the caller's. The caller's own gate is
unchanged: the `ctx.kanban` surface binds the run's tenant, as it does today.

### D2. A new assignment notifies once

When a materialization **creates** a card with an `assigneeId`, the host sends the ADR 0049
notification through `emitAssignmentNotification`. It goes only to the assignee
(`recipientUserId`). The notification id is derived from the command's `idempotencyKey`, so a
retried command doesn't double-notify. A role-addressed card sends nothing, as on the assign
route today.

Known gap: a crash after the card is written but before the notify call loses that one
notification, because the retry finds the card already there. Notifications are best-effort
everywhere in ADR 0049, so this ADR leaves that alone and says so.

### D3. `refresh` updates what the source owns and nothing else

`MaterializeKanbanWorkItemsCommand` gains `refresh?: boolean`. With it, when an item's
identity already exists, the host updates the card through the normal `card.patch` command:

- **Updated:** `title`, `description`, `dueAt`, `sourceLabel`. These are facts the source
  owns.
- **Never touched:** assignee, role, column, order, labels, priority, handoff. These belong
  to the people working the board.
- **Not refreshed at all:**
  - a card in a terminal column, because finished work stays as it was finished;
  - a work item whose card a person deleted. `deleteCard` cascades the work item
    (ADR 0738), so without a record the next sync would mint it again. `deleteCard` now
    writes an ids-only `kanban:work-item-dismissal` row (work item, board, card, time),
    and a `refresh` skips a dismissed identity. Dismissals are cleared with their board
    and in tenant purge. Without `refresh`, ADR 0738 behaviour (recreate on retry) is
    unchanged.
- A field that already matches is not written, so a no-op refresh makes no write and no
  board-change event.

The identity rule doesn't change: a caller that wants refresh keeps `source.revision`
stable. The result gains `refreshedCardIds: string[]`.

### D4. A project role can address a card (H5)

A card on a project board may carry `assigneeRole: 'project:lead'` or
`'project:contributor'`. These are the member roles ADR 1095 defines. `observer` can't be
addressed, because an observer can't write the board and so can't claim. No client value
exists; ADR 1099 decides separately whether a client may ever be an assignee.

- **Seam:** a new host registry, `registerSubjectRoleResolver(kind, fn)`, in
  `host/subjectAccess.ts`, beside the access resolver. The projects feature registers its
  ADR 1095 role lookup for `'project'`. Core never imports the feature.
- **Mirror:** `listCardsAssignedToUser` resolves the viewer's role once per project board
  that carries a `project:` role card, and includes the card when the role matches.
- **Validation:** a `project:` role is accepted only on a board whose subject is a project.
  That holds on materialize (D1), on the assign route and on `card.patch`.
- **Claim:** unchanged. A project board's claim already needs board write
  (`routes/kanban.ts:886`).
- **One lookup:** the role comes from `projectRoleOf` (`features/projects/projectsService.ts`).
  That is the ADR 1095 `myRole` rule, moved out of `routes.ts` so the single-project read and
  this seam share it. Which roles are addressable is the registrant's call
  (`ADDRESSABLE_PROJECT_ROLES`), so kanban core holds no copy of the project role list.
- **Parsing:** `<kind>:<role>` is read as a subject role only when `<kind>` registered a role
  resolver. Any other value is a workspace role key, exactly as before.

## Phases

| Phase | Scope |
|---|---|
| P1 | D1–D3 in `kanbanService` and the `ctx.kanban.materializeWorkItems` surface, plus tests. |
| P2 | D4: the role resolver seam, the projects registration, the mirror, the assign-route validation, plus tests. |
| P3 | `core.openwop.kanban-work-items` 1.2.0 (materialize 1.2.0): the item assignee fields, a `refresh` config and `refreshedCardIds` in the output, so a chain can use D1–D4. `vendor.openwop.app-builder.workflows` 1.4.3 re-pins `plan-to-kanban` 1.0.3, and the e2e gallery fixture is re-pinned too. This is a vendored image pack and is not in prod's `OPENWOP_INSTALL_PACKS`, so it needs no registry publish. |

## Alternatives weighed

- **Refresh by bumping `source.revision`.** Rejected: it makes a new identity and a second
  card. The issue asks for the opposite.
- **Refresh overwrites the assignee too.** Rejected: whoever reassigned the card on the
  board would be silently undone by the next sync. The board wins on who and status.
- **Notify from the outbox daemon.** That would be more durable, but the outbox carries
  audit types today. Adding a delivery type is a bigger change than #5953 needs. It's
  noted as follow-up.
- **Reuse workspace role keys for project roles.** Rejected: `lead` in one project is not
  `lead` in another. The namespaced `project:` value is resolved against the board's own
  project.

## Open questions

- H3 (an *Open* link and *Done* on mirrored cards) and H4 (a due-soon and overdue sweep)
  stay open on #5953. Neither blocks this ADR.
