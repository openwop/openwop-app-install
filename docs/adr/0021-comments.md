# ADR 0021 — Collaboration / Comments (threaded comments on content)

**Status:** implemented (Phases 1–3 + the core-app extension surface; the `comment.create`
chat envelope is deferred — see the port corrections + implementation record below)
**Date:** 2026-06-10
**Depends on:** ADR 0001 (feature-package), ADR 0006 (RBAC), ADR 0009 (CMS — a
commentable resource), ADR 0011 (KB — a commentable resource), ADR 0010
(Notifications — the emit seam + SSE this reuses)
**Toggle:** `comments` · **Surface:** authed `/v1/host/openwop-app/comments/orgs/:orgId/*`
(host-extension, NON-NORMATIVE — no RFC)
**MyndHyve §:** Collaboration & Presence · **Baseline:**
`src/core/collaboration/{services,collaborationStore.ts,components/CommentsPanel.tsx,
components/CommentAnchor.tsx}`

---

## Context (boundaries audit first)

The first platform-depth feature beyond the growth loop: threaded comments turn the
CMS pages (0009) and KB collections (0011) into a collaboration surface. It is high
value precisely because it **reuses infrastructure already shipped** rather than
building new transport.

**Pre-existing-surface audit:**
- **`comments` namespace is free** (the `registerAllRoutes` grep hit is the English
  word "comment" in code, not a route).
- **The notification delivery path already exists — reuse it, don't rebuild.**
  `getNotificationEmitter().emit({ tenantId, type, priority, title, message,
  actionUrl?, metadata? })` (`src/notifications/emitter.ts:38`) fans a notification
  out to SSE subscribers **automatically** — a feature does nothing extra. A new
  comment/reply emits through this seam; building a second SSE channel would
  duplicate Notifications (0010).
- **The resolver-registry pattern already exists — reuse it.** Sharing (0013)
  centralizes "validate a `(resourceType, resourceId)` is in this org" in a static
  resolver map (`cms_page` → `cmsService.getPage`, `kb_collection` →
  `kbService.getCollection`). Comments uses the **same** mechanism so a new
  commentable type is one map entry.
- **Resource reads are org-scoped point lookups** — `cmsService.getPage(tenantId,
  orgId, pageId)` (`cms/cmsService.ts:134`), `kbService.getCollection(tenantId,
  orgId, collectionId)` (`kb/kbService.ts:187`) — both return `null` cross-org.

What is **new**: the comment thread store and the authed CRUD surface. The **RTDB
presence/cursor** layer of MyndHyve's Collaboration is **deferred** (heavier; it was
a deliberate CMS-v1 cut) — v1 is comments only.

## Decision

A `comments` feature-package (toggle `comments`, default OFF, `bucketUnit: tenant`),
authed + org-scoped + RBAC. A comment **references** a `(resourceType, resourceId)`
validated by a resolver (it never copies resource data); a reply emits a
notification through the existing emitter (auto-delivered over SSE).

### The model + resolver registry

```
Comment { commentId, tenantId, orgId, resourceType('cms_page'|'kb_collection'),
          resourceId, parentId?, body, authorId,
          status('open'|'resolved'), createdAt, updatedAt }   // edits allowed on own; not versioned in v1

CommentTarget { validate(tenantId, orgId, resourceId): Promise<{ title: string } | null> }
const TARGETS: Record<ResourceType, CommentTarget> = { cms_page, kb_collection }
```

`DurableCollection<Comment>('comments:thread')` keyed by `(tenantId, orgId,
resourceType, resourceId, commentId)` — so a thread is a prefix scan.

### Phase 1 — comment store + resolver registry + CRUD (RBAC)

Routes under `/v1/host/openwop-app/comments/orgs/:orgId`, `authorizeOrgScope`-gated:
- `POST .../comments` `{ resourceType, resourceId, body, parentId? }`
  (`workspace:write`) — reject unknown `resourceType`; `resolver.validate` asserts
  the target is in this org (cross-org/tenant 404); append.
- `GET .../comments?resourceType=&resourceId=` (`workspace:read`) — the thread.
- `PATCH .../comments/:commentId` — edit own body / `resolve`/`reopen`
  (`workspace:write`; edit gated to author, resolve to member).
- `DELETE .../comments/:commentId` — author or org-admin; tenant+org IDOR-guarded.
Route harness tests (RBAC, cross-org IDOR, unknown type, toggle-off 404).

### Phase 2 — notification emit on add/reply

The comments feature contributes the **namespaced string** notification types
`comment.added` / `comment.reply` — it does **NOT** edit the core `NotificationType`
union. `NotificationRecord.type` is `NotificationType | string` (`src/types.ts:225`,
an intentionally open union), the emit seam is type-agnostic
(`emitter.ts:46` is a `type: input.type` pass-through), and the FE presentational
maps `TYPE_ICON` (`NotificationPanel.tsx:26`) + `TYPE_LABELS` (`types.ts:68`) are
already `Record<string, …>` with fallbacks — so a string type renders unbroken and
guards every existing consumer. The feature owns its literals locally:

```ts
// src/features/comments/notifications.ts
export const COMMENT_NOTIF = { added: 'comment.added', reply: 'comment.reply' } as const;
```

and emits via `getNotificationEmitter().emit({ type: COMMENT_NOTIF.added, … })`. The
only presentational touch is **two additive entries** to the string-keyed
`TYPE_ICON` + `TYPE_LABELS` maps (a speech-bubble icon + "New comment" / "New reply"
labels) — additive and fallback-protected, never a change to an existing type.

On a top-level comment, emit to the resource owner; on a reply, emit
`comment.reply` to the parent author (+ owner). SSE delivery is automatic via the
emitter — **no new channel**. `actionUrl` deep-links to the resource thread.

> **Decision — feature notification types are namespaced strings, not a core-union
> edit (`/architect`, 2026-06-11; corrects this ADR's original Proposed wording,
> which said "add … to the `NotificationType` union" ≈ option B).** Evaluated three
> options: **(A)** namespaced string + feature-local `as const`; **(B)** extend the
> core union; **(C)** a `registerNotificationType()` registry seam (mirrors
> `registerSubjectEraser`, `host/subjectErasure.ts`). Dominant force: **open/closed +
> the core-must-not-depend-on-its-consumers invariant** that `subjectErasure` already
> encodes — it eliminates **B** (a dependency magnet every future feature would edit;
> its "type-safety" is *nominal* here since no consumer switches on the literal, and
> is recovered locally by `as const`). Chose **A** as the smallest reversible step
> that is *permanently correct* for the type contract and forecloses nothing — this
> is also industry practice for extensible event-type systems (CloudEvents `type` is
> a reverse-DNS-namespaced **string** with well-known types in *registries*, not a
> closed enum). **C is the documented graduation, not a rejected option** — see Open
> questions for its trigger.

### Phase 3 — frontend

A reusable `CommentsPanel` + `CommentAnchor` (the MyndHyve components are the UI
baseline), mounted on the CMS page editor and the KB collection view (both behind
`useFeatureAccess('comments')`). `commentsClient.ts`. `npm run build` gate.
**Presence/cursors are NOT in this phase.**

## Core-app extension surface (node packs, agent packs, API)

Per **ADR 0014** (feature workflow surfaces), a feature is not only its REST + UI
faces — it must also **extend the core app's automation surface**. The surface below
is a committed phase (after the REST + UI phases), gated by the **same `comments`
toggle** (all faces flip together), with signed `feature.comments.*` packs published
to `packs.openwop.dev` (decoupled from toggle state for replay).

- **Node pack `feature.comments.nodes`** — `feature.comments.nodes.post` (a workflow
  posts a comment — e.g. an automated review note on a CMS page), `…list`, `…resolve`.
- **Agent pack `feature.comments.agents`** — `feature.comments.agents.reviewer`
  (reviews a CMS page / KB doc and posts comments; composes the agentic-harness
  review persona; posts via the comment store → the notification emit seam, so a
  human is notified of the agent's review).
- **`ctx.comments` workflow surface** — typed `post` / `list` / `resolve`, behind the
  same toggle + RBAC, advertised at `/.well-known/openwop`.
- **Envelope type** — `comment.create` (an AI-authored comment routed to the comment
  store via the resolver registry).
- **API endpoints** — the authed thread CRUD routes above, reachable over MCP/A2A via
  the well-known advertisement.

## Architectural constraints honored

- **Reuse transport, don't rebuild:** notifications emit + SSE (0010) deliver
  comment events; no second realtime channel.
- **Compose via resolver registry (Sharing 0013 lesson):** comments reference +
  validate a resource; they never copy CMS/KB data; a new type is a map entry. CMS
  (0009) + KB (0011) untouched.
- **RBAC org-scoped + IDOR-guarded:** every read/write verifies tenantId+orgId; the
  target resource is re-validated in-org at comment time.
- **Single source of truth:** the comment store owns threads; resource bodies stay
  in CMS/KB.
- **Scoped v1:** presence/cursors (RTDB) and versioned comment history deferred —
  not scope-cutting, a real infra gate (RTDB layer) deferred to its own ADR.
- **No wire surface → no RFC.**

## Alternatives considered

1. **Per-feature comments (CMS owns its own, KB its own).** Rejected — scatters the
   thread + notify + resolver logic across features; centralize once (the Sharing
   registry lesson).
2. **A new dedicated SSE channel for comments.** Rejected — the Notifications SSE
   already auto-delivers emitted events; a second channel duplicates 0010.
3. **Presence + live cursors now.** Deferred — the RTDB/ephemeral-presence layer is
   a larger infra surface (MyndHyve's dual `RtdbPresenceService` /
   `FirestorePresenceService`); comments deliver the value first.
4. **Versioned comment history / edit audit.** Deferred — v1 allows author edits +
   open/resolve; an audited history is a follow-on if moderation needs it.

## Open questions

- [ ] **Presence / live cursors** (alt. 3) — its own ADR (RTDB or an SSE-presence
  channel).
- [ ] **Graduate notification types to a `registerNotificationType()` registry
  (option C)** — promote the FE `TYPE_ICON` / `TYPE_LABELS` maps + the `typeIcon` /
  `actionLabelFor` switches to a metadata registry keyed by the same namespaced
  string (mirroring `registerSubjectEraser`). **Trigger:** a 3rd feature contributes
  notification types, OR a feature needs per-type routing / default-delivery-channel
  / i18n metadata. Until then, Phase 2's string + 2 additive map entries is the
  proportionate, forward-compatible step (zero migration — the registry keys off the
  same string). Premature at N=1.
- [ ] **@mentions → targeted notification** — needs a member/user lookup to resolve
  a mention to a `subject`.
- [ ] **More commentable types** (a Deal, a Form submission) — a resolver map entry.
- [ ] **Moderation panel** (MyndHyve has one) — resolve/hide/report at org-admin.
- [ ] **Rich text in comments** — composes the `rich-text` feature when ported.
- [ ] **Per-subject notification targeting** (see port correction 1) — the inbox is
  tenant-scoped today; targeting an individual recipient (owner / parent author) is a
  Notifications (0010) capability that doesn't exist yet. Until it lands, a comment
  notification is tenant-scoped with the intended `recipientId` carried in `metadata`.
- [ ] **`comment.create` chat envelope** (see port correction 2) — deferred. No
  feature registers a custom AI-chat envelope today (Email 0019 didn't either); the
  AI-authored-comment capability is already delivered via `feature.comments.nodes.post`
  + the reviewer agent + `ctx.features.comments.post`. A dedicated envelope needs a
  per-feature envelope-registration seam (core plumbing) — its own change.

## Port corrections (implementation, "port not clone")

1. **Notifications are tenant-scoped, not per-recipient.** The Proposed ADR's Phase 2
   said "emit to the resource owner" / "to the parent author". This host's Notifications
   (ADR 0010) inbox has **no per-user recipient** on `NotificationRecord` — `listNotifications`
   filters by `tenantId` only. So a comment notification is emitted **tenant-scoped**, with
   the intended recipient + actor carried in `metadata.recipientId` / `metadata.actorId`
   for when per-subject targeting lands. Self-activity (owner comments on own resource /
   reply to self) emits nothing. The notification TYPES are namespaced strings
   (`comment.added` / `comment.reply`) per the accepted `/architect` decision — no
   core-`NotificationType`-union edit; the only presentational touch is two additive,
   fallback-protected entries in the string-keyed FE `TYPE_ICON` + `TYPE_LABELS` maps.
2. **No `comment.create` chat envelope in v1** — matches the Email (0019) precedent (no
   feature registers a custom envelope; there is no per-feature envelope seam). The
   AI-authored-comment path ships via the node pack + reviewer agent + `ctx.comments.post`.
3. **Frontend is a self-contained `/comments` page, not an embed.** To honor the
   feature-package boundary (no edits to CMS/KB pages), v1 ships a standalone
   `CommentsPage` (org → resource picker composing the CMS/KB list clients → the reusable
   `<CommentsPanel>`). `<CommentsPanel>` is exported so embedding it in the CMS editor /
   KB view is a clean follow-on, not a core edit now.

## Implementation record

| Aspect | Evidence |
|---|---|
| Backend service | `src/features/comments/commentsService.ts` — `Comment` thread store (`comments:thread`); a `(resourceType, resourceId)` **resolver registry** (`cms_page` → `cmsService.getPage`, `kb_collection` → `kbService.getCollection`) validates the target in-org + yields title/owner; create/list/update(edit-own + resolve)/delete(author-or-admin, cascades replies) |
| Routes | `src/features/comments/routes.ts` — authed org-scoped (`authorizeOrgScope`) `POST/GET/PATCH/DELETE …/comments/orgs/:orgId/comments`. **No public surface.** Delete derives org-admin from `resolveEffectiveAccess` roles |
| Delete-cascade authority (code-review #148) | deleting a ROOT cascades its replies, but a **non-admin** author whose root has **foreign-authored** replies is refused (`409` — "resolve it instead") so a non-privileged actor can't destroy others' comments; an org admin may delete the thread. Author-of-only-own-replies still deletes cleanly |
| Notifications (ADR 0010) | `src/features/comments/notifications.ts` — `COMMENT_NOTIF` namespaced strings + `emitCommentNotification` (tenant-scoped, best-effort, self-activity skip). FE `TYPE_ICON`/`TYPE_LABELS` +2 additive entries |
| CMS/KB composition | resolver references the resources **live** via `cmsService`/`kbService` — no copied data, no reach into their stores (the Sharing 0013 lesson) |
| Extension surface (ADR 0014) | `src/features/comments/surface.ts` (`ctx.features.comments`: list/post/resolve, agent-authored `agent:<runId>` provenance) + `packs/feature.comments.nodes/` (list/post/resolve) + `packs/feature.comments.agents/` (content-reviewer — posts comments, does NOT edit) |
| Registration | appended to `BACKEND_FEATURES` + `FRONTEND_FEATURES`; toggle `comments` (off, tenant); `requiredPacks` `feature.comments.{nodes,agents}` |
| Frontend (Phase 3) | `frontend/react/src/features/comments/` — `CommentsPage` (org → resource picker → thread) + reusable `CommentsPanel` (add/reply/resolve/reopen/delete) + `commentsClient.ts` + `routes.tsx` (Workspace nav); deep-linkable via the notification `actionUrl` |
| Tests | `test/comments-route.test.ts` — 11/11 (CRUD + IDOR + unknown-type/404 + toggle-off 404, string-notification emit + self-activity skip, **delete-cascade authorization** [non-admin foreign-reply 409 + admin cascade + own-replies delete], surface/node smoke, well-known advert) |
| Verify | `tsc --noEmit` clean; `comments-route` 11/11; full suite green apart from the 8 known pre-existing pack/runtime failures (identical on `origin/main`). Frontend `npm run build` gate green (tsc + token/CSS/bundle/CSP) |
| Deferred | presence/live cursors (alt. 3), per-subject notification targeting, `comment.create` envelope, moderation panel, rich text, `<CommentsPanel>` embed in CMS/KB |
