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
import { cleanString } from '../../host/boundedStrings.js';
import { getPage } from '../cms/cmsService.js';
import { getCollection } from '../kb/kbService.js';

export type ResourceType = 'cms_page' | 'kb_collection';
export const RESOURCE_TYPES: readonly ResourceType[] = ['cms_page', 'kb_collection'];

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
  status: CommentStatus;
  createdAt: string;
  updatedAt: string;
}

const MAX = { body: 4000 } as const;

/** A commentable resource: validate it is in (tenant, org) and yield the title +
 *  owner used for the notification emit. Returns null when not in this org (the
 *  caller maps that to a uniform 404 — no cross-org existence leak). */
interface CommentTarget {
  validate(tenantId: string, orgId: string, resourceId: string): Promise<{ title: string; ownerId: string } | null>;
}

const TARGETS: Record<ResourceType, CommentTarget> = {
  cms_page: {
    async validate(tenantId, orgId, resourceId) {
      const p = await getPage(tenantId, orgId, resourceId);
      return p ? { title: p.title, ownerId: p.createdBy } : null;
    },
  },
  kb_collection: {
    async validate(tenantId, orgId, resourceId) {
      const c = await getCollection(tenantId, orgId, resourceId);
      return c ? { title: c.name, ownerId: c.createdBy } : null;
    },
  },
};

const comments = new DurableCollection<Comment>('comments:thread', (c) => c.commentId);

export function isResourceType(v: unknown): v is ResourceType {
  return typeof v === 'string' && (RESOURCE_TYPES as readonly string[]).includes(v);
}

// ── reads ──
export async function listThread(tenantId: string, orgId: string, resourceType: ResourceType, resourceId: string): Promise<Comment[]> {
  return (await comments.list())
    .filter((c) => c.tenantId === tenantId && c.orgId === orgId && c.resourceType === resourceType && c.resourceId === resourceId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)); // thread order: oldest first
}

export async function getComment(tenantId: string, orgId: string, commentId: string): Promise<Comment | null> {
  const c = await comments.get(commentId);
  return c && c.tenantId === tenantId && c.orgId === orgId ? c : null;
}

/** What a fresh comment needs delivered (Phase 2 notification emit). `parentAuthorId`
 *  is set only for a reply, and only when it differs from the new comment's author. */
export interface CommentNotifyTargets { resourceTitle: string; ownerId: string; parentAuthorId?: string }

// ── writes ──
export async function createComment(input: {
  tenantId: string; orgId: string; resourceType: unknown; resourceId: unknown; parentId?: unknown; body: unknown; authorId: string;
}): Promise<{ comment: Comment; notify: CommentNotifyTargets }> {
  if (!isResourceType(input.resourceType)) {
    throw new OpenwopError('validation_error', `\`resourceType\` MUST be one of: ${RESOURCE_TYPES.join(', ')}.`, 400, { field: 'resourceType' });
  }
  const resourceId = typeof input.resourceId === 'string' ? input.resourceId.trim() : '';
  if (!resourceId) throw new OpenwopError('validation_error', '`resourceId` is required.', 400, { field: 'resourceId' });
  const body = cleanString(input.body, MAX.body);
  if (!body) throw new OpenwopError('validation_error', '`body` is required and MUST be a non-empty string.', 400, { field: 'body' });

  // The resource MUST exist in THIS (tenant, org) — cross-org/tenant id 404s.
  const target = await TARGETS[input.resourceType].validate(input.tenantId, input.orgId, resourceId);
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
    body, authorId: input.authorId, status: 'open', createdAt: now, updatedAt: now,
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
): Promise<Comment | null> {
  const existing = await getComment(tenantId, orgId, commentId);
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

export async function deleteComment(
  tenantId: string, orgId: string, commentId: string, actor: { userId: string; isAdmin: boolean },
): Promise<boolean> {
  const existing = await getComment(tenantId, orgId, commentId);
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
    : (await comments.list()).filter((c) => c.parentId === commentId && c.tenantId === tenantId && c.orgId === orgId);
  if (!actor.isAdmin && replies.some((r) => r.authorId !== actor.userId)) {
    throw new OpenwopError('conflict', 'This comment has replies from other people — only an org admin can delete it. You can resolve it instead.', 409, { commentId, replies: replies.length });
  }
  for (const r of replies) await comments.delete(r.commentId);
  return comments.delete(commentId);
}

/** Test-only: clear the comment store. */
export async function __resetCommentsStore(): Promise<void> { await comments.__clear(); }
