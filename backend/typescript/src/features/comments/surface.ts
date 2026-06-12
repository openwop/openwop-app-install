/**
 * Comments workflow surface (ADR 0014) — `ctx.features.comments`, a thin adapter
 * over `commentsService` for the feature.comments.nodes pack + reviewer agent.
 * Tenant from the run scope; org-scoped. `post` is the one write — a workflow/agent
 * authored comment, stamped with an `agent:run` author (the run scope carries no
 * human subject; per-subject authorship is the deferred authority refinement). It
 * is replay-safe because it is called from a `role: "action"` node whose output is
 * recorded (replay/fork read the recorded result, the write is not re-issued).
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { listThread, createComment, updateComment, getComment, RESOURCE_TYPES, type ResourceType } from './commentsService.js';
import { emitCommentNotification } from './notifications.js';

const INTERNAL = new Set(['tenantId']);
function project(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!INTERNAL.has(k)) out[k] = v;
  return out;
}
const asResourceType = (v: unknown): ResourceType | null => {
  const s = str(v);
  return (RESOURCE_TYPES as readonly string[]).includes(s) ? (s as ResourceType) : null;
};

export function buildCommentsSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  // The run scope has no human subject — an agent-authored comment is stamped with
  // a stable, opaque, non-PII author so its provenance is honest in the thread.
  const author = `agent:${scope.runId ?? 'run'}`;
  return {
    list: async (args) => {
      const rt = asResourceType(args.resourceType);
      if (!rt) return { comments: [] };
      const rows = await listThread(tenantId, str(args.orgId), rt, str(args.resourceId));
      return { comments: rows.map(project) };
    },
    post: async (args) => {
      const rt = asResourceType(args.resourceType);
      if (!rt) return { comment: null };
      const { comment, notify } = await createComment({
        tenantId, orgId: str(args.orgId), resourceType: rt, resourceId: str(args.resourceId),
        ...(optStr(args.parentId) ? { parentId: optStr(args.parentId) } : {}),
        body: str(args.body), authorId: author,
      });
      await emitCommentNotification(comment, notify);
      return { comment: project(comment) };
    },
    resolve: async (args) => {
      const commentId = str(args.commentId);
      const existing = await getComment(tenantId, str(args.orgId), commentId);
      if (!existing) return { comment: null };
      const c = await updateComment(tenantId, str(args.orgId), commentId, existing.authorId, { status: 'resolved' });
      return { comment: c ? project(c) : null };
    },
  };
}
