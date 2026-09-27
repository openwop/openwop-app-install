/**
 * Comments chat tools (CFP-1 repair; ADR 0308 D2 seam) — the read + post
 * grounding for the Content Reviewer agent. The pack formerly allowlisted the
 * workflow node typeIds `feature.comments.nodes.list` / `post`, which nothing
 * projects into a conversational tool, so the reviewer loaded toothless (CFP-1).
 * These `registerFeatureAgentTool` tools make the same list + post real, over
 * the same `commentsService` owner the routes use.
 *
 * Authority parity (hard rule #1): both resolve org scope through the same
 * `listOrgs` + `resolveEffectiveAccess` predicate the comments routes enforce —
 * `list` needs `workspace:read`, `post` needs `workspace:write` (matching the
 * GET/POST route scopes). Read-before-write (hard rule #4): `list` grounds the
 * reviewer before it posts. The read fails EMPTY without an acting user; the
 * write (an action tool) fails TYPED. The comment is authored by the acting
 * human (`authorId = actingUserId`), through the `createComment` owner + its
 * notification — never raw storage.
 */

import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveActionOrgScope, resolveReadOrgScope, str, toolEmpty, toolError, toolOk } from '../../host/agentToolKit.js';
import { listThread, createComment, isResourceType, RESOURCE_TYPES, type ResourceType } from './commentsService.js';
import { emitCommentNotification } from './notifications.js';
import { OpenwopError } from '../../types.js';

export const COMMENTS_LIST_TOOL_ID = 'openwop:comments.list';
export const COMMENTS_POST_TOOL_ID = 'openwop:comments.post';

const COMMENTS_GATE = { featureId: 'comments', featureLabel: 'Comments' } as const;

const INTERNAL = new Set(['tenantId']);
function project(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!INTERNAL.has(k)) out[k] = v;
  return out;
}

const RESOURCE_ENUM = [...RESOURCE_TYPES];

export function registerCommentsAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: COMMENTS_LIST_TOOL_ID,
      description:
        "Read a resource's existing comment thread (a CMS page or KB collection) so you can avoid repeating a note already made. "
        + 'Read-only. Read this BEFORE posting.',
      inputSchema: {
        type: 'object',
        properties: {
          resourceType: { type: 'string', enum: RESOURCE_ENUM, description: 'The kind of resource the thread hangs off.' },
          resourceId: { type: 'string', description: 'The resource id.' },
          orgId: { type: 'string', description: 'Organization id (optional when the workspace has one org).' },
        },
        required: ['resourceType', 'resourceId'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      // Read tool: no acting user ⇒ empty; feature off / ambiguous org ⇒ typed
      // (CFPT-1c majority posture); unknown org / no scope ⇒ empty.
      const r = await resolveReadOrgScope(scope, COMMENTS_GATE, str(input.orgId));
      if (r.kind === 'empty') return toolEmpty({ comments: [], note: r.note });
      if (r.kind === 'error') return r.result;
      const rt = input.resourceType;
      if (!isResourceType(rt)) return toolEmpty({ comments: [], note: `resourceType must be one of: ${RESOURCE_TYPES.join(', ')}.` });
      const resourceId = str(input.resourceId);
      if (!resourceId) return toolEmpty({ comments: [], note: 'resourceId is required.' });
      // ADR 0659 D1 — an app-state tool SHARES its route's access predicate and fails
      // EMPTY without an acting user (CLAUDE.md). `null` = target absent OR invisible;
      // the note names no resource, so this is not an existence oracle for a model.
      const rows = await listThread(scope.tenantId, r.orgId, rt as ResourceType, resourceId, { subject: scope.actingUserId });
      if (rows === null) return toolEmpty({ comments: [], note: 'That resource is not available in this organization.' });
      return toolOk({ comments: rows.map(project) });
    },
  });

  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: COMMENTS_POST_TOOL_ID,
      description:
        'Post a review comment (or a reply via `parentId`) on a resource — this notifies the resource owner over the existing inbox. '
        + 'One focused issue per comment. Read the thread first (comments.list) to avoid duplicates. It does NOT edit the resource.',
      inputSchema: {
        type: 'object',
        properties: {
          resourceType: { type: 'string', enum: RESOURCE_ENUM, description: 'The kind of resource to comment on.' },
          resourceId: { type: 'string', description: 'The resource id.' },
          body: { type: 'string', description: 'The comment text — what is wrong + a suggested fix.' },
          parentId: { type: 'string', description: 'Optional: the root comment id this is a reply to (same thread).' },
          orgId: { type: 'string', description: 'Organization id (optional when the workspace has one org).' },
        },
        required: ['resourceType', 'resourceId', 'body'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      // Action tool: fail TYPED.
      const resolved = await resolveActionOrgScope(scope, COMMENTS_GATE, str(input.orgId));
      if ('error' in resolved) return resolved.error;
      try {
        const parentId = str(input.parentId);
        const { comment, notify } = await createComment({
          tenantId: scope.tenantId,
          orgId: resolved.orgId,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          ...(parentId ? { parentId } : {}),
          body: input.body,
          // Author and caller are the same principal on this lane; passed separately
          // because the workflow lane's are NOT (ADR 0659 D1).
          authorId: resolved.actingUserId,
          caller: { subject: resolved.actingUserId },
        });
        await emitCommentNotification(comment, notify);
        return { content: JSON.stringify({ comment: project(comment) }) };
      } catch (err) {
        if (err instanceof OpenwopError) return toolError(err.code, err.message, err.details);
        throw err;
      }
    },
  });
}
