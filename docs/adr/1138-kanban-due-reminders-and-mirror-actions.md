# ADR 1138 — Due reminders, and actions on mirrored cards

Status: Accepted (2026-11-15; David: "keep going"; design reviewed by openwop-app-14). Implemented in the PR that records it, which merges after ADR 1137's #5988 and shares its `assigneeCanSeeBoard` check.

Answers openwop/openwop-app#5953 H3 and H4. It extends [ADR 0049](0049-kanban-card-assignment-to-people.md) (assignment and the "Assigned to me" mirror) and pairs with [ADR 1137](1137-kanban-work-item-assignee.md) (work items carry an assignee). It is a host extension only; no wire RFC is involved.

## Context

Once a feature assigns a card (ADR 1137), the assignee's "Assigned to me" mirror (`frontend/react/src/kanban/AssignedColumn.tsx`) still has three gaps:

- It's read-only. Its header said so: "no drag, no lane actions".
- It can't send the person to where the work happens.
- It shows no due date. Nothing in `kanban/` styled a card as overdue.

Nothing reminds anyone either. The only overdue logic is on demand, in `ctx.kanban.resourceMonitor` (`host/kanbanSurface.ts`). So an adopter (CasaVoga CV-0221) runs its own due sweep.

## Decision

### D1. A card can link to its source

`KanbanCard.sourceRef?: { label, path }` is set by the feature that makes the card, through `createCard` or `card.patch`; `null` clears it. The board card and the mirror render it as an *Open {label}* link.

The value is guarded by `assertSourceRef` (`host/kanbanService.ts`):
- `path` must be an app-relative path: one leading `/`, no scheme, no `//`, no backslash, no whitespace, at most 512 characters.
- `label` is 1–80 characters.

So the link can never take someone off the app. The public card routes don't accept the field, so only server code sets it.

### D2. The mirror can finish a card

Each mirrored card now carries `doneColumnId`, the board's first completion lane (`doneColumnOf`: terminal, not cancellation).

A card the viewer holds gets a **Done** button. A card qualifies when it is assigned to the viewer (not role-addressed and unclaimed), not yet finished, and its board has a completion lane. Done sends the same `PATCH /cards/:id { columnId }` a drag makes, so the existing assignee carve-out (ADR 0049 D4) authorizes it. There is no new authority.

### D3. Due state, said in words

`CardDue` renders on the board card and on the mirror:
- *Overdue · date* once the date has passed;
- *Due soon · date* within two days;
- the plain *due date* otherwise.

A finished card shows its date plainly. Each state is a word, not just a colour.

### D4. Due-soon and overdue reminders

A new feature package, `kanban-due-reminders` (tenant bucket, **default OFF**), runs a daemon that ticks every 5 minutes. For each open card with a `dueAt` and an `assigneeId`, the assignee gets one `task.due` notification when the card comes within 48 hours of its date and another when the date passes. An overdue card more than 7 days old isn't announced, so switching the feature on doesn't flood people with old backlog.

**Exactly once, without a lease.**
- The notification id is a hash of (tenant, card, state, dueAt). A re-sweep of the same date fails on the primary key and sends nothing. A moved date gets a new id, so it re-arms.
- The insert comes before any push, email or Teams delivery (`notifications/emitter.ts`), so a duplicate delivers nothing.

**Cost.** These are openwop-app-14's conditions, all met:
1. The toggle resolves before any kanban read, so a tenant with it off costs nothing.
2. There are no whole-table scans. Tenants come from the toggle's own overrides and beta cohort; when the toggle is on for everyone, they come from the host's sweep tenant list (`listRosterTenants`). Cards come only from the verified tenant card index (`listOpenDueCards`), and boards are point reads. An unverified index skips the tenant for that tick rather than scanning.
3. Each tick covers 1/12 of the enabled tenants, so each is visited about once an hour. A tenant is capped at 500 cards per tick; a cursor resumes on its next visit, and hitting the cap is logged (`due_sweep_tenant_capped`).
4. The tick runs under `runUnderWorkerContract`.
5. Access is checked again at send time. The assignee must still be a workspace member who can read the board's subject (the ADR 1137 D1 rule). Someone removed from a project stops getting its reminders.

### D5. Two pieces an adopter shares (added 2026-11-15, for CasaVoga's CV-0221)

- **`refreshCardFacts(board, card, facts)`** is ADR 1137 D3's rule, exported for plain cards. It updates only title, description, `dueAt` and `sourceLabel`, never the holder, column or labels; it leaves a finished card alone and writes nothing when nothing differs. The work-item refresh calls it too, so the rule has one owner. An adopter that keeps its own card ids (CasaVoga) refreshes through it instead of copying the rule.
- **The `task.due` message ends with the card's `sourceLabel`**, with control characters stripped and capped at 120 characters (it is feature-supplied text in a notification body). That lets an adopter's "waiting on" card say who to chase ("… · waiting on the client") without an adopter-only reminder.

## Alternatives weighed

- **A per-tenant scheduled chain with a due-sweep node.** It would be editable in the builder, but every tenant would have to enable a schedule, with far more moving parts for one notice. openwop-app-14 and I chose the daemon.
- **Reuse `resourceMonitor`.** It's on demand and has no recipient. A sweep needs to run without anyone asking.
- **Default ON.** It would change behaviour for every install that already has due dates. An adopter turns it on in its defaults; CasaVoga will.

## Open questions

- A reminder isn't withdrawn when the card is finished. ADR 0049 withdraws only assignment notices. A small follow-up could archive `task.due` rows on completion.
