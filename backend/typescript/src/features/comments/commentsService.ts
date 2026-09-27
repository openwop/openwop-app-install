/**
 * Collaboration / Comments service (host-extension, ADR 0021). Threaded comments
 * that REFERENCE a `(resourceType, resourceId)` — they never copy resource data.
 * A static resolver registry validates that the target is in the caller's org
 * (the Sharing 0013 lesson: one map, a new commentable type is one entry) and
 * yields the resource's title + owner for the notification emit (Phase 2). The
 * comment thread store is the single source of truth for threads; CMS (0009) /
 * KB (0011) bodies stay in their own services.
 *
 * @see docs/adr/0021-comments.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { type SubjectCaller, subjectReadAllowed } from '../../host/subjectAccess.js';
import { cleanString } from '../../host/boundedStrings.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { registerRetentionPurger, purgeRowsByAge } from '../../host/retentionPurger.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { getPage } from '../cms/cmsService.js';
import { getBrief as getCreativeBrief } from '../creative-briefs/creativeBriefsService.js';
import { getList as getPriorityList, listRankedIdeas } from '../priority-matrix/priorityMatrixService.js';
import { getCollection } from '../kb/kbService.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { getCanvasForTenant } from '../../host/canvasSurface.js';

// ADR 0081 P5 — a comment's `body` is author free-text (may name/quote people); declare
// it for log-masking (ADR 0077). `authorId` is an opaque principal id (RFC 0048), not PII.
declarePiiFields('comments.comment', ['body']);

// ADR 0021 (extension) — `chat_message` makes an inline chat message commentable
// (inline comments on agent output), via the SAME one-map-entry pattern as cms/kb.
// The resourceId is
// `${sessionId}#${messageId}`: the sessionId is validated by tenant ownership, the
// messageId is the opaque UI anchor. v1 is INTRA-TENANT (a chat session is
// tenant-private, unlike the org-shared cms/kb resources); cross-tenant comments on
// a SHARED session (RFC 0122 share grant) are a follow-up (see ADR).
export type ResourceType = 'cms_page' | 'kb_collection' | 'chat_message' | 'priority_idea' | 'canvas_document' | 'creative_brief';
export const RESOURCE_TYPES: readonly ResourceType[] = ['cms_page', 'kb_collection', 'chat_message', 'priority_idea', 'canvas_document', 'creative_brief'];

export type CommentStatus = 'open' | 'resolved';

export interface Comment {
  commentId: string;
  tenantId: string;
  orgId: string;
  resourceType: ResourceType;
  resourceId: string;
  parentId?: string;
  body: string;
  authorId: string;
  /** ADR 0659 D10 — the human principal an agent-authored comment was made FOR. Absent on
   *  a human-authored row (where `authorId` already is that principal). */
  onBehalfOf?: string;
  status: CommentStatus;
  createdAt: string;
  updatedAt: string;
}

const MAX = { body: 4000 } as const;

/** A commentable resource: validate it is in (tenant, org) and yield the title +
 *  owner used for the notification emit. Returns null when not in this org (the
 *  caller maps that to a uniform 404 — no cross-org existence leak). */
interface CommentTarget {
  /** `caller` (ADR 0643 R3 Blocker 2) — the commenting principal; a subject-bindable
   *  target (a KB collection) resolves it so a non-member's comment cannot 404-probe
   *  or surface a private corpus's name in a thread title. */
  validate(tenantId: string, orgId: string, resourceId: string, caller?: SubjectCaller): Promise<{ title: string; ownerId: string } | null>;
}

const TARGETS: Record<ResourceType, CommentTarget> = {
  // ADR 0353 P4 — threaded review comments on a creative brief.
  creative_brief: {
    async validate(tenantId, orgId, resourceId) {
      const b = await getCreativeBrief(tenantId, orgId, resourceId);
      return b ? { title: b.title, ownerId: b.createdBy } : null;
    },
  },
  cms_page: {
    async validate(tenantId, orgId, resourceId) {
      const p = await getPage(tenantId, orgId, resourceId);
      return p ? { title: p.title, ownerId: p.createdBy } : null;
    },
  },
  kb_collection: {
    async validate(tenantId, orgId, resourceId, caller) {
      const c = await getCollection(tenantId, orgId, resourceId, caller ?? { subject: undefined }); // KBC-1 / R3 Blocker 2 — the commenter's principal, fail-closed when absent
      return c ? { title: c.name, ownerId: c.createdBy } : null;
    },
  },
  // A chat message: resourceId is `${sessionId}#${messageId}`. Validated by TENANT
  // ownership (`getChatSession` returns null outside the caller's tenant ⇒ uniform
  // 404, no cross-tenant existence leak); the messageId is opaque here (the UI
  // anchors on it). Chat sessions carry no org/owner field, so `ownerId` is empty
  // (a chat is tenant-private — no distinct resource owner to notify).
  chat_message: {
    async validate(tenantId, _orgId, resourceId) {
      const sessionId = resourceId.split('#')[0] ?? '';
      if (!sessionId) return null;
      const session = await hostExtStorage().getChatSession(tenantId, sessionId);
      return session ? { title: session.title || 'Conversation', ownerId: '' } : null;
    },
  },
  // A priority idea (ADR 0232): resourceId is `${listId}#${cardId}`. Validated by
  // the LIST's tenant + org (the aggregate root — the ADR 0021 "one map entry"
  // extension contract); the card lives on the list's kanban board.
  priority_idea: {
    async validate(tenantId, orgId, resourceId) {
      const [listId, cardId] = resourceId.split('#');
      if (!listId || !cardId) return null;
      const list = await getPriorityList(tenantId, listId);
      if (!list || list.orgId !== orgId) return null;
      const idea = (await listRankedIdeas(tenantId, listId)).find((r) => r.card.id === cardId);
      return idea ? { title: idea.card.title, ownerId: idea.card.createdBy ?? list.createdBy } : null;
    },
  },
  // A rich-text document canvas (ADR 0334): resourceId is the canvasId for a
  // whole-canvas thread, OR `${canvasId}#${threadId}` for an inline range-anchored
  // thread (ADR 0334 6b — the chat_message/priority_idea composite-id precedent).
  // Both validate the SAME canvas: split on '#' and take the canvasId portion
  // (a bare canvasId has no '#', so `split('#')[0]` is backward-compatible).
  // Validated by TENANT ownership + type (getCanvasForTenant returns null outside
  // the caller's tenant ⇒ uniform 404; a wrong-type canvas is rejected). Canvases
  // are tenant-scoped in host.canvas (org rides ownerSubject), so `orgId` is not
  // the partition key here; ownerId is empty (no distinct row owner on the view).
  // ADR 0659 D9 — org is NOT derivable here (`ownerSubject` is optional and a
  // `kind:'user'` subject has no org resolver), so tenant stays the partition. The real
  // gate is the SAME seam `kb_collection` uses: when the canvas carries an
  // `ownerSubject`, the thread resolves only for a caller who may READ that subject.
  // Additive — an owner-less canvas keeps its previous behaviour exactly.
  canvas_document: {
    async validate(tenantId, _orgId, resourceId, caller) {
      const canvasId = resourceId.split('#')[0] ?? '';
      const c = await getCanvasForTenant(tenantId, canvasId);
      if (!c || c.canvasTypeId !== 'canvas.document') return null;
      if (c.ownerSubject && !(await subjectReadAllowed(tenantId, c.ownerSubject, caller))) return null;
      const st = c.state && typeof c.state === 'object' && !Array.isArray(c.state) ? (c.state as Record<string, unknown>) : {};
      const title = typeof st.title === 'string' && st.title ? st.title : (c.name || 'Document');
      return { title, ownerId: '' };
    },
  },
};

// GOV-1: `tenantOf` arms the tenant secondary index (bounded retention-purge scan).
const comments = new DurableCollection<Comment>('comments:thread', (c) => c.commentId, undefined, (c) => c.tenantId);

export function isResourceType(v: unknown): v is ResourceType {
  return typeof v === 'string' && (RESOURCE_TYPES as readonly string[]).includes(v);
}

// ── reads ──
/**
 * CMNT-3 — read through the TENANT INDEX, never `list()`.
 *
 * Every read below used `comments.list()` = a `kvList` over the whole
 * `comments:thread` namespace + a decode of every row in every tenant + an
 * in-memory filter. The collection was constructed WITH `tenantOf` (the index is
 * armed, line ~134) and the retention purger already read through it — the
 * bounded lane was present and simply unused on the hot path, which is every
 * `/comments` render, every inline expand, and every `openwop:comments.list`
 * tool turn.
 *
 * One helper so a future read cannot pick the unbounded lane by accident. Note
 * the index is a bounded scan, not a filter: it enumerates only this tenant's
 * markers, so cross-tenant rows are never decoded at all — the `tenantId ===`
 * check below is defence in depth against a stale marker, not the boundary.
 */
async function rowsForTenant(tenantId: string): Promise<Comment[]> {
  if (!tenantId) return []; // fail-closed: an unscoped read must never fall back to list()
  return (await comments.listForTenantIndexed(tenantId)).filter((c) => c.tenantId === tenantId);
}

/**
 * ADR 0659 D1 — THE commentable-target predicate. Every lane resolves through this and
 * nothing else.
 *
 * The defect it closes: `createComment` used to pass `{ subject: authorId }` here, i.e.
 * the comment's AUTHOR as the visibility CALLER. Authorship is provenance ("who wrote
 * this"); visibility is authorization ("whose access decides"). Conflating them failed in
 * BOTH directions at once — the read lanes had no caller at all and leaked subject-bound
 * corpora (`CMNT-15`/`CMWF-1`), while the workflow lane's `agent:${runId}` author is never
 * a bound member, so a node could never comment on one and was told `not_found`, which was
 * false (`CMWF-2`).
 *
 * `caller` is REQUIRED and never defaults to the author: a site that forgets it passes
 * `{subject: undefined}`, which `subjectReadAllowed` refuses on a bound target — the
 * direction a forgotten gate must fail in.
 */
async function resolveCommentTarget(
  tenantId: string, orgId: string, resourceType: ResourceType, resourceId: string, caller: SubjectCaller,
): Promise<{ title: string; ownerId: string } | null> {
  return TARGETS[resourceType].validate(tenantId, orgId, resourceId, caller);
}

/**
 * The thread, or `null` when the target does not exist OR the caller cannot see it — a
 * UNIFORM answer, so this is not an existence oracle. Callers map `null` to their own
 * lane's refusal (404 on HTTP, `toolEmpty` for a chat tool, typed `not_found` on the
 * workflow surface) and MUST NOT distinguish the two causes.
 */
export async function listThread(
  tenantId: string, orgId: string, resourceType: ResourceType, resourceId: string, caller: SubjectCaller,
): Promise<Comment[] | null> {
  // Fail-closed FIRST: an unscoped read must never reach a resolver (which would hand an
  // empty tenantId to another feature's store). Caught by `comments-bounded-reads`.
  if (!tenantId) return null;
  if (!(await resolveCommentTarget(tenantId, orgId, resourceType, resourceId, caller))) return null;
  return (await rowsForTenant(tenantId))
    .filter((c) => c.orgId === orgId && c.resourceType === resourceType && c.resourceId === resourceId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)); // thread order: oldest first
}

/**
 * ADR 0659 D1 — ORDERING. The by-id lanes cannot resolve the target before the store read
 * (the target is only known FROM the row), so the row is read first and the caller-gate
 * runs on it. An invisible target returns the IDENTICAL `null` the missing-row path
 * returns, and it runs BEFORE any author/admin guard — otherwise `updateComment`'s 403
 * would still distinguish "exists, not yours" from "absent", which is the oracle D1 closes.
 */
export async function getComment(tenantId: string, orgId: string, commentId: string, caller: SubjectCaller): Promise<Comment | null> {
  const c = await comments.get(commentId);
  if (!c || c.tenantId !== tenantId || c.orgId !== orgId) return null;
  if (!(await resolveCommentTarget(tenantId, orgId, c.resourceType, c.resourceId, caller))) return null;
  return c;
}

/** What a fresh comment needs delivered (Phase 2 notification emit). `parentAuthorId`
 *  is set only for a reply, and only when it differs from the new comment's author. */
export interface CommentNotifyTargets { resourceTitle: string; ownerId: string; parentAuthorId?: string }

// ── writes ──
export async function createComment(input: {
  tenantId: string; orgId: string; resourceType: unknown; resourceId: unknown; parentId?: unknown; body: unknown;
  /** Provenance — WHO WROTE IT. On the workflow lane this is `agent:${runId}`. */
  authorId: string;
  /** ADR 0659 D1 — authorization: WHOSE ACCESS DECIDES. Never derived from `authorId`. */
  caller: SubjectCaller;
  /** ADR 0659 D10 — the human principal a run acted for, so erasure reaches
   *  agent-authored rows (`authorId` is `agent:${runId}` and matches no subject key). */
  onBehalfOf?: string;
}): Promise<{ comment: Comment; notify: CommentNotifyTargets }> {
  if (!isResourceType(input.resourceType)) {
    throw new OpenwopError('validation_error', `\`resourceType\` MUST be one of: ${RESOURCE_TYPES.join(', ')}.`, 400, { field: 'resourceType' });
  }
  const resourceId = typeof input.resourceId === 'string' ? input.resourceId.trim() : '';
  if (!resourceId) throw new OpenwopError('validation_error', '`resourceId` is required.', 400, { field: 'resourceId' });
  const body = cleanString(input.body, MAX.body);
  if (!body) throw new OpenwopError('validation_error', '`body` is required and MUST be a non-empty string.', 400, { field: 'body' });

  // The resource MUST exist in THIS (tenant, org) — cross-org/tenant id 404s — and be
  // readable by the CALLER (ADR 0643 R3 Blocker 2, corrected by ADR 0659 D1: this used to
  // pass the AUTHOR, which refused every agent-authored comment on a bound corpus).
  const target = await resolveCommentTarget(input.tenantId, input.orgId, input.resourceType, resourceId, input.caller);
  if (!target) throw new OpenwopError('not_found', 'Resource not found in this organization.', 404, { resourceId });

  // A reply's parent MUST be a live comment on the SAME thread (a root comment —
  // single-level threading in v1; a reply-to-reply re-parents to the root).
  let parentId: string | undefined;
  let parentAuthorId: string | undefined;
  if (input.parentId != null && input.parentId !== '') {
    const pid = typeof input.parentId === 'string' ? input.parentId : '';
    const parent = pid ? await comments.get(pid) : null;
    if (!parent || parent.tenantId !== input.tenantId || parent.orgId !== input.orgId
      || parent.resourceType !== input.resourceType || parent.resourceId !== resourceId) {
      throw new OpenwopError('validation_error', '`parentId` does not reference a comment on this thread.', 400, { field: 'parentId' });
    }
    parentId = parent.parentId ?? parent.commentId; // flatten reply-to-reply to the root
    parentAuthorId = parent.authorId !== input.authorId ? parent.authorId : undefined;
  }

  const now = new Date().toISOString();
  const comment: Comment = {
    commentId: `cmt:${randomUUID()}`,
    tenantId: input.tenantId, orgId: input.orgId,
    resourceType: input.resourceType, resourceId,
    ...(parentId ? { parentId } : {}),
    body, authorId: input.authorId,
    ...(input.onBehalfOf ? { onBehalfOf: input.onBehalfOf } : {}),
    status: 'open', createdAt: now, updatedAt: now,
  };
  await comments.put(comment);
  return {
    comment,
    notify: { resourceTitle: target.title, ownerId: target.ownerId, ...(parentAuthorId ? { parentAuthorId } : {}) },
  };
}

/** Edit own body and/or flip open↔resolved. Body edits are author-only; resolve/
 *  reopen is any member's (passed `canResolve`). Returns null when not found. */
export async function updateComment(
  tenantId: string, orgId: string, commentId: string, actorId: string,
  patch: { body?: unknown; status?: unknown },
  caller: SubjectCaller,
): Promise<Comment | null> {
  const existing = await getComment(tenantId, orgId, commentId, caller); // D1 — gate BEFORE the author guard
  if (!existing) return null;
  const next: Comment = { ...existing };

  if (patch.body !== undefined) {
    if (existing.authorId !== actorId) {
      throw new OpenwopError('forbidden_scope', 'Only the author may edit a comment body.', 403, { commentId });
    }
    const body = cleanString(patch.body, MAX.body);
    if (!body) throw new OpenwopError('validation_error', '`body` MUST be a non-empty string.', 400, { field: 'body' });
    next.body = body;
  }
  if (patch.status !== undefined) {
    if (patch.status !== 'open' && patch.status !== 'resolved') {
      throw new OpenwopError('validation_error', "`status` MUST be 'open' or 'resolved'.", 400, { field: 'status' });
    }
    next.status = patch.status;
  }
  next.updatedAt = new Date().toISOString();
  await comments.put(next);
  return next;
}

/**
 * ADR 0288 P2 consumer — SYSTEM prune of comment threads on resources that no
 * longer exist (chat messages of a deleted conversation): the content has no
 * reachable surface left. Deliberately bypasses `deleteComment`'s actor gate —
 * this is lifecycle cleanup fired by the owning deletion, not a user action
 * (the same reasoning as the resource's own cascade). Bounded tenant-indexed
 * scan; idempotent.
 */
export async function pruneThreadsForDeletedResources(
  tenantId: string, resourceType: ResourceType, resourceIds: readonly string[],
): Promise<number> {
  if (resourceIds.length === 0) return 0;
  const doomed = new Set(resourceIds);
  let n = 0;
  for (const c of await comments.listForTenantIndexed(tenantId)) {
    if (c.resourceType !== resourceType || !doomed.has(c.resourceId)) continue;
    await comments.delete(c.commentId);
    n += 1;
  }
  return n;
}

/**
 * Prune every thread for a base resource AND its composite `${base}#*` children
 * (ADR 0334 6b) — a canvas.document delete must cascade the whole-canvas thread
 * (`resourceId === base`) plus all inline range-anchored threads
 * (`resourceId === ${base}#${threadId}`), whose threadIds aren't known at delete
 * time. Exact-or-`#`-prefix match so a sibling id sharing a string prefix (but
 * not the `#` boundary) is never swept. Bounded tenant-indexed scan; idempotent.
 */
export async function pruneThreadsForResourceAndComposites(
  tenantId: string, resourceType: ResourceType, base: string,
): Promise<number> {
  if (!base) return 0;
  const prefix = `${base}#`;
  let n = 0;
  for (const c of await comments.listForTenantIndexed(tenantId)) {
    if (c.resourceType !== resourceType) continue;
    if (c.resourceId !== base && !c.resourceId.startsWith(prefix)) continue;
    await comments.delete(c.commentId);
    n += 1;
  }
  return n;
}

export async function deleteComment(
  tenantId: string, orgId: string, commentId: string, actor: { userId: string; isAdmin: boolean },
  caller: SubjectCaller,
): Promise<boolean> {
  const existing = await getComment(tenantId, orgId, commentId, caller); // D1 — gate BEFORE the actor guard
  if (!existing) return false;
  if (existing.authorId !== actor.userId && !actor.isAdmin) {
    throw new OpenwopError('forbidden_scope', 'Only the author or an org admin may delete a comment.', 403, { commentId });
  }
  // Deleting a ROOT cascades its replies (a reply has no children — reply-to-reply
  // flattens to the root at create time). Guard the cascade so a NON-admin author
  // can't destroy OTHER people's replies by deleting the comment they replied under:
  // if foreign-authored replies exist, only an org admin may delete the root (the
  // author can `resolve` it instead). No data loss by a non-privileged actor.
  const replies = existing.parentId
    ? []
    : (await rowsForTenant(tenantId)).filter((c) => c.parentId === commentId && c.orgId === orgId); // CMNT-3 — indexed, not a full-collection scan
  if (!actor.isAdmin && replies.some((r) => r.authorId !== actor.userId)) {
    throw new OpenwopError('conflict', 'This comment has replies from other people — only an org admin can delete it. You can resolve it instead.', 409, { commentId, replies: replies.length });
  }
  for (const r of replies) await comments.delete(r.commentId);
  return comments.delete(commentId);
}

/** Test-only: clear the comment store. */
// ADR 0081 P5 — time-based retention (ADR 0077 seam). Delete this tenant's comment
// threads NOT touched within the window — age on `updatedAt` (an active thread keeps
// being touched; a year-dormant thread's free-text body is the stale PII). No-op on a
// falsy tenant / non-PII classification (fail-closed).
registerRetentionPurger({
  feature: 'comments',
  async purge(tenantId, classification, cutoffIso) {
    if (!tenantId || classification !== 'confidential-pii') return 0;
    return purgeRowsByAge('comments', await comments.listForTenantIndexed(tenantId), tenantId, cutoffIso,
      (c) => ({ tenantId: c.tenantId, updatedAt: c.updatedAt, id: c.commentId }),
      (id) => comments.delete(id));
  },
});

// GDPR data-subject erasure (subject-erasure seam, ADR 0077 / ADR 0081 follow-up): a
// comment's free-text `body` is the subject's PII and `authorId` is the opaque principal
// (RFC 0048), so when a DSAR `subjectKey` is that userId, delete every comment authored by
// the subject. Tenant-scoped, fail-closed on a falsy subject. Returns the count removed.
// Orphan trade-off (intentional, matches the retention purger + ADR 0081 P5): erasing an
// author's root comment leaves others' replies with a dangling `parentId` — they still
// render via `listThread`, just lose their anchor. Subject erasure correctly takes
// priority over thread cosmetics; we do NOT re-parent or tombstone.
/** ADR 0659 D10 — matches `authorId` OR `onBehalfOf`: a comment an agent wrote at a
 *  person's direction is that person's, and `agent:${runId}` matches no subject key. */
export async function deleteSubjectComments(tenantId: string, subjectKey: string): Promise<number> {
  if (!subjectKey) return 0;
  let removed = 0;
  // CMNT-3 — indexed, not a full-collection scan. Erasure runs once per resolved
  // subject key, so the old `list()` was N tenant-wide scans per DSAR.
  for (const c of await rowsForTenant(tenantId)) {
    if (c.authorId === subjectKey || c.onBehalfOf === subjectKey) { await comments.delete(c.commentId); removed += 1; } // D10
  }
  return removed;
}

const commentsEraser = async (tenantId: string, subjectKey: string): Promise<void> => { await deleteSubjectComments(tenantId, subjectKey); };
registerSubjectEraser(commentsEraser);

export async function __resetCommentsStore(): Promise<void> { await comments.__clear(); }
