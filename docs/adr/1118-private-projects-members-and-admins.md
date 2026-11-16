# ADR 1118 — A private project admits its members and the org's admins

Status: Accepted (2026-11-13, David: "yes, proceed" on Option B). Implemented in this PR.

Amends ADR 0054 D5. ADR 0054 itself is not rewritten; it gets a pointer to this one.

## Context

ADR 0054 D5 (2026-06-16) made project visibility a read-ACL separate from authority. A
`private` project was readable by its people-members **and by every org writer**
(`workspace:write`), and writable by every org writer. "Membership never grants write"
held, and so did the converse: a lack of membership never removed it.

Row 93 (ADR 1115, podcasts) brought this to the surface. Its grader filed a Blocker
because a non-member org writer could publish a private notebook's episode to the public
web. That was not a podcasts bug. It is what D5 says. The built-in roles explain why it
still matters:

- `editor` holds `workspace:write`. It is the ordinary contributor role ("Create and cancel
  runs, write workspace"), not an elevated one.
- So "private" excluded only non-member **viewers**. For most teams that is close to
  org-visible.
- The same app's private chat channels promise "Only invited members can see it." The
  project toggle used the same word for a much weaker rule.
- Write is the larger exposure. A non-member editor could rename or delete a private
  project, rewrite its sources and publish its podcast audio.

**Production (measured 2026-11-13, read-only, counts only):** 21 projects across 5
tenants. All 21 are `org`-visible and **0 are private**. So 0 people lose access, and no
private-project org uses a custom role. This change alters what "private" will mean the
first time someone uses it. It removes no one's access today.

## Decision

`projectsService.levelFor`, the one rule every project-owned surface reaches through
`resolveProjectAccess`, `listVisibleProjects` or the `subjectAccess` seam, now reads:

| Visibility | Who gets in | Level |
|---|---|---|
| `org` (default) | unchanged: `workspace:write` ⇒ write, `workspace:read` ⇒ read | unchanged |
| `private` | a people-member, **or** an org admin/owner (`host:members:manage`) | `write` with `workspace:write`, else `read` |
| `private` | anyone else, **editors included** | `none` (404) |

- **Admins and owners keep the way in** (`PRIVATE_PROJECT_ADMIN_SCOPE =
  'host:members:manage'`). They manage the project's members, and the org needs someone
  who can recover a project whose members left, answer a DSAR, or respond to an incident.
- **Membership still never grants write.** A viewer who is a member reads. An editor who is
  a member writes.
- **An absent caller is still `none`** (ADR 0839 D1), and that check runs first.
- **The UI copy says the new rule** in 4 locales: the help text, the confirm dialog and the
  toast ("Only members and workspace admins…"; the confirm names editors).

### Found while testing, and decided here

- **Going private keeps the person who did it.** `setProjectVisibility(…, actor)` adds the
  acting person as a `lead` member when they are not one already. Without this, an editor
  who made their own project private was locked out at once, because a creator is not
  automatically a member. It is explicit, so the Members tab shows it. At the 100-member
  cap the flip is refused with a message, rather than going over the cap.
- **The documents write doors now ask the project.** PATCH, DELETE and `POST …/versions`
  on a document had deliberately skipped the owner check (ADR 0643 / `KBC-4`), on the
  premise that "an org writer is never refused by visibility". A test pinned that
  premise and said the doors must be gated if it ever failed. This ADR makes it fail, so
  they now call `assertOwnerWritable` (`canWriteDocument`). The recovery path is kept: a
  document whose project is GONE stays writable, so it can still be re-pointed and
  deleted. The refusal applies only when the owning project still exists.

### Alternatives weighed

- **A: keep D5 and warn more clearly.** It costs nothing, but "private" stays weak and
  contradicts channels. Rejected.
- **C: members only, with no admin override.** This risks orphaned projects, and it would
  stop admins from responding to an incident or a DSAR. Rejected.
- **Gate write on membership only, and leave read alone.** That would be a third meaning,
  "private" that every editor can see but only members can change. Rejected as harder to
  explain than either rule.

## Consequences

- One function changed. Every surface that goes through the rule follows: the project
  pages, board, memory, knowledge, sources, schedules, chat, podcasts (ADR 1115's
  `notebookReadableBy`), the list scan, and the context blocks. No surface keeps its own
  copy of the private rule (grep: `visibility === 'private'` appears only in `levelFor`
  and the setter).
- **Podcasts (ADR 1115).** A non-member org editor is now hidden from a private notebook's
  episodes, as a viewer already was. ADR 1115's correction note ("an org writer is not
  hidden") was true until this ADR. The note stays as history.
- **Advisory boards are out of scope.** `advisory-board` has its own `private`, "Only you
  and workspace writers", decided in its own ADR. Aligning it is a separate decision.
- No migration: no project is private in production, and the field is unchanged.
- Replay and fork are unaffected. Visibility is a read-time filter and is never stamped on
  a run (ADR 0054 D5).

  > **CORRECTED 2026-11-15 (ADR 1133, #5970):** runs were not in this list, so a private
  > project's runs, their events and their `run-event:*` artifacts stayed readable to a
  > non-member org viewer. ADR 1133 applies this rule to them through the same subject
  > seam, derived from the run's host-written attribution. Still read-time only, and
  > still never stamped on a run.

## Verification

- `projects-route.test.ts`, new case "ADR 1118". A non-member org editor reads and writes
  an org-visible project (control). Once the project is private, the same editor gets 404
  on read, board, knowledge, PATCH and DELETE, and drops out of the list, and the refused
  write does not land. A non-member admin reads and writes. After being added as a member,
  the editor reads and writes again (`canWrite: true`).
- `kbc4-documents-ingest-to-kb-idor.test.ts`: a non-member editor gets 404 on GET,
  versions, PATCH and DELETE of a private project's document, and the PATCH does not
  land. The owner (admin) and a member editor write. The stranded-document legs still
  pass, so the exit is intact.
- The fixture changes in four other tests are the same story: the person who made a
  project private is now a member (`setProjectVisibility(…, actor)`), and a non-member
  editor expects 404 or `notebook_unavailable` where it used to expect access.
- Sabotage: putting back `workspace:write ⇒ write` ahead of the visibility check reddens
  the route case and the documents case. Removing `assertOwnerWritable` from the
  versions door reddens the documents case.
- Targeted runs: 106 files touching private projects, documents or the access seam
  (921 passed), 206 ratchet and source-walker files, and 19 frontend files (projects
  copy and `*Ratchet*`).
- The existing D5 case is retitled ("members + org admins"). Its owner is an admin, so it
  passes unchanged.

## Follow-up: access changes are audited (#5906, 2026-11-14)

Project membership and visibility decide who sees a private project, but they left no
audit trace. They now write `security.*` entries to the tenant's tamper-evident audit
chain (`appendAudit`, ADR 0389 P2). These are the same kinds of entries as secret
reveals and break-glass.

| Kind | When | Payload |
|---|---|---|
| `security.project.member-added` | a new member | `projectId, orgId, ref, role, actor` |
| `security.project.member-role-changed` | a re-add with a different role | `… role, previousRole` |
| `security.project.member-removed` | an existing member removed | `projectId, orgId, ref, role, actor` |
| `security.project.visibility-changed` | the value actually moved | `projectId, orgId, from, to, addedLeadMember?, actor` |

- **No-ops write nothing:** a re-add with the same role, a flip to the current value, or
  removing a non-member.
- **Ids only.** The chain is DSAR-exempt and cannot be redacted (ADR 0657 D11), so
  payloads carry opaque user ids, never an email or a name. The test asserts that.
- **The entry is written after the change lands.** A failed append is logged
  (`project_access_audit_failed`) and does not undo an access change that already
  happened.
- **Out of scope:** org membership changes (`accessControlService` member add, remove and
  roles) are not audited either. That is the same gap one level up, and it is left for its
  own decision.

Test: `projects-route.test.ts` "#5906" covers the four kinds, three no-ops, the payloads,
and no email in the chain. Removing the append reddens it.
