/**
 * Collaboration / Comments feature (ADR 0021). Threaded comments on commentable
 * resources (CMS pages, KB collections), authed + org-scoped + RBAC. Reuses the
 * Sharing (0013) resolver-registry pattern (a new commentable type is one map
 * entry) and the Notifications (0010) emit seam (no new realtime channel). Adds a
 * `ctx.features.comments` read/post surface (ADR 0014) + `feature.comments.{nodes,
 * agents}`, all behind the same `comments` toggle. Authed-only (no public surface).
 * Off by default.
 */

import type { BackendFeature } from '../types.js';
import { registerCommentsRoutes } from './routes.js';
import { buildCommentsSurface } from './surface.js';
import { registerCommentsAgentTools } from './agentTools.js';
import { onConversationDeleted } from '../../host/conversationLifecycle.js';
import { onCanvasDeleted } from '../../host/canvasLifecycle.js';
import { pruneThreadsForDeletedResources, pruneThreadsForResourceAndComposites } from './commentsService.js';

export const commentsFeature: BackendFeature = {
  id: 'comments',
  registerRoutes: (deps) => {
    registerCommentsRoutes(deps);
    // CFP-1 — the Content Reviewer agent's real chat tools (comments.list read +
    // comments.post write). Process-wide + inert until the pack allowlists the
    // ids; per-tenant toggle + RBAC honesty lives inside each tool's run().
    registerCommentsAgentTools();
    // ADR 0288 P2 — comments on a deleted conversation's messages have no
    // reachable surface left; prune them (system lifecycle, not a user action).
    // A chat_message comment's resourceId is `${sessionId}#${messageId}` (the
    // ADR 0021 anchor format), so build the composite ids from the event.
    onConversationDeleted('comments', async ({ tenantId, conversationId, messageIds }) => {
      await pruneThreadsForDeletedResources(tenantId, 'chat_message', messageIds.map((m) => `${conversationId}#${m}`));
    });
    // ADR 0334 DATA-1 / 6b — a deleted canvas.document has no reachable comment
    // surface left; prune its threads (gated on the type — other canvas types
    // carry no comments today). This cascades BOTH the whole-canvas thread
    // (resourceId === canvasId) AND every inline range-anchored thread
    // (resourceId === `${canvasId}#${threadId}`), whose threadIds die with the doc.
    onCanvasDeleted('comments', async ({ tenantId, canvasId, canvasTypeId }) => {
      if (canvasTypeId !== 'canvas.document') return;
      await pruneThreadsForResourceAndComposites(tenantId, 'canvas_document', canvasId);
    });
  },
  // Face 2 (ADR 0014): `ctx.features.comments` — list/post/resolve for the
  // feature.comments.nodes pack + the reviewer agent.
  surface: { id: 'comments', build: buildCommentsSurface },
  toggleDefault: {
    id: 'comments',
    label: 'Collaboration / Comments',
    description: 'Threaded comments on CMS pages + KB collections, notified over the existing inbox — product feature.',
    category: 'Content',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'comments',
  },
  requiredPacks: [
    // WF-CMNT-10 — bumped WITH the behavioural change. Node packs have no
    // version-aware precedence on the mount lane, so a fix at an unchanged
    // version is silently inert on a registry-installing host.
    { name: 'feature.comments.nodes', version: '1.1.0' },
    { name: 'feature.comments.agents', version: '1.0.1' }, // CFP-1 real chat tools
  ],
};
