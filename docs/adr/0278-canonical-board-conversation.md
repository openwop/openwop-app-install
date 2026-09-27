# ADR 0278 — The canonical board conversation (join semantics for Boards of Advisors)

**Status:** **implemented** (2026-07-05)
**Date:** 2026-07-05
**Toggle:** rides the existing `advisory-board` toggle — no new toggle.
**RFC verdict:** none — host-extension route + host-internal conversation binding; the
council still runs on the RFC 0005 conversation wire (RFC 0101 roster semantics unchanged).
**Supersedes:** ADR 0040's per-summon conversation-instance model (the `@@`-summon
in-place stamping remains as a secondary affordance; the *canonical* conversation is new).
**Relates to:** ADR 0043 (persistent conversations), ADR 0045/0046/0047 (subject model),
ADR 0054 (project group chat D3 + subjectAccess D5 — the precedent), ADR 0079/0100
(board planning context), ADR 0277 (identity + knowledge reconciliation).

## Context

A "board chat" was only ever the *current* chat session promoted in place by the
`@@`-summon (`markAsBoardGroup` on whatever session was open). N summons → N
disconnected boardrooms; no reverse index; no rediscovery; no way for a second
user to "join the board's channel"; the planning-context snapshot froze at
summon time. The product ask — *initialize the board's channel if it doesn't
exist, or join the user to it* — had no owner.

Meanwhile the exact pattern already existed twice: the **project group chat**
(ADR 0054 D3: `subjectConversationId` + `ensureConversationMeta` +
`ownerSubject` + member access via the `subjectAccess` seam + an "Open project
chat" deep-link) and its notebook clone. `ConversationMeta.ownerSubject` was
even documented as "supersedes the advisory-specific `boardId`".

## Decision

1. **`'board'` joins `SubjectKind`** (`host/subject.ts`); `boardSubject(boardId)`
   lives in the advisory-board feature (the `projectSubject` pattern). An
   ADVISORY board — never `host.kanban`.
2. **`POST /v1/host/openwop-app/advisors/boards/:boardId/chat`** (host-extension,
   toggle-gated, board-READ-gated): ensure-or-reuse the ONE conversation at
   `subjectConversationId(tenantId, boardSubject(boardId))` — `type:'group'`,
   `ownerSubject: board:<id>`, agent participants = the board's cohort mapped to
   their chat-callable projections (`agent:<agentRef.agentId>`, the refs the
   `@@` summon stamps, so RFC 0101 roster enforcement matches dispatched ids);
   then `markAsBoardGroup` with a **fresh planning-context snapshot on every
   open** (RBAC-filtered for the opener — the summon-only snapshot went stale);
   then reconcile the agent lineup to the current cohort both ways. Humans are
   NOT participants — they join via the subject-access read gate (the project
   pattern; attribution stays server-stamped `authorSubject`).
3. **The `subjectAccess` seam became a PER-KIND registry**
   (`registerSubjectAccessResolver(kind, fn)`): the original single-slot `set`
   meant the second registering feature silently clobbered the first — projects
   owned the slot, and the board resolver would have knocked it out (or been
   knocked out) depending on boot order. Projects migrated to register under
   `'project'` (mechanical; its resolver already self-filtered). Advisory-board
   registers `'board'`: WRITE ⟺ org `workspace:write` (the ADR 0045 boundary —
   membership never grants write); READ ⟺ `shared` visibility + org
   `workspace:read`, or the `private` board's creator; missing board ⇒ `none`
   (fail-closed).
4. **`markAsBoardGroup` preserves `ownerSubject`** — it rebuilt the meta without
   the generic owner binding, which would have silently erased the join gate on
   every re-open/summon. (Host fix; benefits any future subject-bound group
   that gets board-stamped.)
5. **Frontend:** an "Open chat" action on every board card/row
   (`ensureBoardChat` → `navigate('/chat?conversation=<id>')` — the
   ProjectChatTab deep-link pattern), 4-locale i18n. The **`@@`-summon is
   unchanged** — it remains the explicit "bring the board into THIS chat"
   affordance; the canonical conversation is the durable home.
6. **Seam-clarity copy** (the P2 `/ux-review` note): the board-edit hints now
   say what each grant IS — Shared knowledge = searched live on each turn;
   Planning context = a snapshot taken when the chat opens or is summoned.
7. **KB access needs NO new mechanism** (deliberate): the canonical
   conversation's advisors carry Shared-knowledge bindings (composed per turn
   since ADR 0277 P2) and the `injectedContextBlock` carries
   strategies/projects. A board-level knowledge provider on the `ownerSubject`
   path would be a redundant third mechanism — rejected.

## Alternatives considered

- **Ride the channels feature (`type:'channel'`, ADR 0126):** rejected — channels
  are user-named UUID rooms with no entity binding; the board-promotion route
  explicitly denies channels; RFC 0101 roster enforcement is gated on
  `type:'group'`+`boardId`; and an entity→channel index would be a new parallel
  system. The "channel-ness" the ask wants (one durable room + join) comes from
  the deterministic subject conversation + the access resolver.
- **Rail visibility:** the list route is already subject-aware
  (`isVisibleToAsync` per session), so a shared board's chat appears in the rail
  of org members with resolved read — the project-chat precedent, and the
  discoverability the ask requires. Private boards stay creator-only.
- **Repointing `@@`-summon at the canonical conversation:** RESOLVED (2026-07-05,
  deferred-closure batch) with a surgical guard instead of a rewrite: a PURE
  summon (`@@handle` with nothing else) in an EMPTY chat ensures + opens the
  canonical conversation; a summon WITH a question — and any summon in a
  non-empty chat — keeps the in-place path byte-identical (the typed text must
  land where it was written, and the cadence owns that flow; pinned by tests:
  redirect / stay-in-place / fail-open-on-ensure-error). Optional ConveneDeps
  (`isSessionEmpty`, `openBoardConversation`) — embeds without them are
  unchanged.

## Hardening corrections (2026-07-05 `/grade-code` adversarial audit)

The post-merge fresh-eyes audit (two parallel reviewers) found and fixed:

- **GRADE-5 (authz):** the chat route gated on board *visibility* only — a
  zero-role co-tenant could mutate (create/stamp the canonical session) via a
  route every read sibling 403s. Now `requireOrgScopeFor(workspace:read)`,
  matching `resolveBoardAccess`'s read floor (CHATP-2 symmetry).
- **GRADE-6 (ownership):** every opener was passed as `ownerUserId`, churning
  ownership to "whoever clicked last" and accumulating irremovable owner-role
  user participants. The opener becomes owner only at CREATION.
- **GRADE-7 (durability):** a summon racing an open could rebuild the meta
  without `ownerSubject`, permanently downgrading the shared room to the legacy
  gate — `markAsBoardGroup` gained an assert-`ownerSubject` param the route
  passes on every stamp.
- **GRADE-8 (info-flow):** the per-opener context re-snapshot in a now-SHARED
  conversation let a privileged reader's strategy block reach narrower readers
  via advisor replies (and a narrow reader silently downgraded the room). Only
  `workspace:write` openers (the org's curators) re-snapshot; readers preserve.
- **GRADE-13 (lifecycle):** `deleteBoard` left every advisor's shared-KB
  bindings forever and stranded the conversation (resolver → `'none'` for
  everyone = unreadable, undeletable dead data). Delete now reconciles the
  whole cohort (cross-board/legacy-protected) and releases `ownerSubject`
  (`releaseConversationOwnerSubject`) so the creator keeps the transcript.
- **GRADE-9/-10/-12/-14:** stale rail title refreshed on open (title-source
  guarded); 200-on-reuse vs 201-on-create; legacy derived-shared boards now
  reconcile their OWN cohort edits (effective = stored ∪ derived); the share
  toggle records intent under CAS (concurrent different-kind toggles no longer
  drop each other).
- **Accepted residual risk (recorded, not fixed):** concurrent FIRST opens are
  last-writer-wins on the meta (no CAS) — interleavings converge to a correct,
  slightly lossy state (a first opener's owner-participant row may be absent;
  access is unaffected since `ownerSubject` is in every write). The reconcile
  fan-out on cohort edits is O(relevant boards × kinds × advisors) KV reads —
  bounded by boards-per-tenant; memoize per (org, kind) if telemetry warrants.

## Verification

`test/advisory-board-chat.test.ts` (route harness): deterministic reuse (two
opens → one sessionId); org-member JOIN (same id + read + append via
subject-access, no participant row); `ownerSubject` survives re-stamps; private
board co-tenant 404 + cross-tenant 404 (fail-closed, no existence leak); cohort
shrink reconciles the agent lineup on re-open. Full backend + FE gates green.
