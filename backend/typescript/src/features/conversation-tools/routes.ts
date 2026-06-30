/**
 * ADR 0132 Phase 4 — per-conversation capability-scope REST (authed, host-extension).
 *
 *   GET  /v1/host/openwop-app/conversation-tools/sessions/:sessionId/capability-scope
 *   PUT  /v1/host/openwop-app/conversation-tools/sessions/:sessionId/capability-scope
 *   POST /v1/host/openwop-app/conversation-tools/sessions/:sessionId/approvals/:toolName
 *
 * Namespaced under the FEATURE (not core `/chat/sessions/*`) so the feature stays
 * self-contained with no route shadowing (ADR 0132 §Phase-4 path note). RBAC mirrors
 * the chat-session resource model (NOT org-scope): the toggle gate +
 * `isVisibleToAsync` (participant/owner visibility, IDOR-safe 404) for READ; WRITE
 * additionally owner-gated when the conversation has a recorded owner (a participant
 * may not silently re-scope another's tools or self-approve a gated action).
 *
 * @see docs/adr/0132-per-conversation-capability-scope.md
 */
import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { OpenwopError } from '../../types.js';
import { tenantOf } from '../featureRoute.js';
import { getConversationMeta, setConversationCapabilityScope, type ConversationCapabilityScope, type ConversationMeta } from '../../host/conversationStore.js';
import { isVisibleToAsync } from '../../host/conversationVisibility.js';
import { listToolApprovals, resolveToolApproval } from './approvalLedger.js';

const MAX_TOOLS = 200; // cap each scope list to bound payload (abuse guard)

/** The acting user's stable subject (ADR 0005) — the chatSessions precedent
 *  (`req.userId ?? req.principal?.principalId`); a trivial req accessor, not a
 *  re-implemented predicate. */
function actingUserOf(req: Request): string | undefined {
  return req.userId ?? req.principal?.principalId;
}

/** Load the conversation meta + enforce visibility (IDOR-safe 404). The meta MUST
 *  exist in the caller's tenant AND be visible to them — a missing meta (a session
 *  in another tenant, or one that never existed) is a 404, not a permissive default
 *  (capability-scope is a real sub-resource, so we do not fall through to the
 *  `isVisibleTo(null) ⇒ true` legacy-unowned heuristic here). */
async function requireVisibleMeta(req: Request, tenantId: string, sessionId: string): Promise<ConversationMeta> {
  const meta = await getConversationMeta(tenantId, sessionId);
  if (!meta || !(await isVisibleToAsync(meta, tenantId, actingUserOf(req)))) {
    throw new OpenwopError('not_found', `chat_session "${sessionId}" not found.`, 404);
  }
  return meta;
}

/** WRITE gate: visibility + owner (when the conversation has a recorded owner).
 *  An ownerless conversation stays tenant-permissive (the chatSessions
 *  `requireOwner` precedent). */
async function requireOwnerWrite(req: Request, tenantId: string, sessionId: string): Promise<ConversationMeta> {
  const meta = await requireVisibleMeta(req, tenantId, sessionId);
  if (meta.ownerUserId && meta.ownerUserId !== actingUserOf(req)) {
    throw new OpenwopError('forbidden', 'Only the conversation owner may change its tool scope.', 403);
  }
  return meta;
}

/** Validate a scope CONFIG body (shape only — never-widen is enforced at resolution
 *  time by intersecting with the agent ceiling, so a free-text tool id outside the
 *  ceiling is harmless). `null`/absent ⇒ clear the scope. */
function readScope(body: unknown): ConversationCapabilityScope | undefined {
  const b = (body ?? {}) as { scope?: unknown };
  const raw = b.scope;
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== 'object') throw new OpenwopError('validation_error', 'scope MUST be an object or null.', 400);
  const s = raw as Record<string, unknown>;
  const mode = s.mode;
  if (mode !== 'agent-default' && mode !== 'restricted') {
    throw new OpenwopError('validation_error', "scope.mode MUST be 'agent-default' or 'restricted'.", 400);
  }
  const list = (v: unknown, field: string): string[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      throw new OpenwopError('validation_error', `scope.${field} MUST be an array of tool-id strings.`, 400);
    }
    if (v.length > MAX_TOOLS) throw new OpenwopError('validation_error', `scope.${field} exceeds ${MAX_TOOLS} entries.`, 400);
    return v as string[];
  };
  const enabled = list(s.enabled, 'enabled');
  const disabled = list(s.disabled, 'disabled');
  const requireApproval = list(s.requireApproval, 'requireApproval');
  return {
    mode,
    ...(enabled ? { enabled } : {}),
    ...(disabled ? { disabled } : {}),
    ...(requireApproval ? { requireApproval } : {}),
  };
}

export function registerConversationToolsRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/conversation-tools/sessions/:sessionId';

  // READ — the scope config + the approval ledger for this conversation.
  app.get(`${BASE}/capability-scope`, async (req, res, next) => {
    try {
      const tenantId = tenantOf(req);
      const sessionId = req.params.sessionId;
      const meta = await requireVisibleMeta(req, tenantId, sessionId);
      res.json({
        scope: meta?.capabilityScope ?? { mode: 'agent-default' },
        approvals: await listToolApprovals(tenantId, sessionId),
      });
    } catch (err) { next(err); }
  });

  // WRITE — set (or clear, with scope:null) the conversation's scope config.
  app.put(`${BASE}/capability-scope`, async (req, res, next) => {
    try {
      const tenantId = tenantOf(req);
      const sessionId = req.params.sessionId;
      await requireOwnerWrite(req, tenantId, sessionId);
      const parsed = readScope(req.body);
      const setBy = actingUserOf(req);
      const scope: ConversationCapabilityScope | undefined = parsed
        ? { ...parsed, ...(setBy ? { setBy } : {}), setAt: new Date().toISOString() }
        : undefined;
      const updated = await setConversationCapabilityScope(tenantId, sessionId, scope);
      res.json({ scope: updated.capabilityScope ?? { mode: 'agent-default' } });
    } catch (err) { next(err); }
  });

  // RESOLVE — approve/deny a pending per-tool approval (the Phase 3 resolve seam).
  app.post(`${BASE}/approvals/:toolName`, async (req, res, next) => {
    try {
      const tenantId = tenantOf(req);
      const sessionId = req.params.sessionId;
      await requireOwnerWrite(req, tenantId, sessionId);
      const decision = (req.body as { decision?: unknown })?.decision;
      if (decision !== 'approved' && decision !== 'denied') {
        throw new OpenwopError('validation_error', "decision MUST be 'approved' or 'denied'.", 400);
      }
      const record = await resolveToolApproval(tenantId, sessionId, req.params.toolName, decision, actingUserOf(req) ?? 'unknown');
      res.json({ approval: record });
    } catch (err) { next(err); }
  });
}
