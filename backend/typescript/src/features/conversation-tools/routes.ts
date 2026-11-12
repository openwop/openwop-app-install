/**
 * ADR 0132 Phase 4 — per-conversation capability-scope REST (authed, host-extension).
 *
 *   GET  /v1/host/openwop-app/conversation-tools/sessions/:sessionId/capability-scope
 *   PUT  /v1/host/openwop-app/conversation-tools/sessions/:sessionId/capability-scope
 *   POST /v1/host/openwop-app/conversation-tools/sessions/:sessionId/approvals/:toolName
 *   DELETE /v1/host/openwop-app/conversation-tools/sessions/:sessionId/approvals/:toolName?resolvedAt=…
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
import { isVisibleToAsync, toolAuthorityHolds } from '../../host/conversationVisibility.js';
import { listToolApprovals, approvalExpiresAt, resolveToolApproval, revokeToolApproval, type ToolApprovalRecord } from './approvalLedger.js';

const MAX_TOOLS = 200; // cap each scope list to bound payload (abuse guard)

/** What a client sees of a ledger row: never the digest (FW2-D1); a channel row that can
 *  expire (a pending ask, an unused one-call approval) carries when it does (CHAN-F17). */
function approvalView(r: ToolApprovalRecord): Omit<ToolApprovalRecord, 'inputDigest'> & { expiresAt?: string } {
  const { inputDigest: _d, ...view } = r;
  const expiresAt = approvalExpiresAt(r);
  return expiresAt ? { ...view, expiresAt } : view;
}

/** The approve/revoke authority: the principal the conversation's tools act as (ADR 0834 D3). */
function requireToolAuthority(req: Request, meta: ConversationMeta, action: string): string {
  const approver = actingUserOf(req);
  if (!approver || !toolAuthorityHolds(approver, meta.ownerUserId)) {
    throw new OpenwopError('forbidden', `Only the conversation owner may ${action} its tool calls.`, 403);
  }
  return approver;
}

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
  const BASE = '/host/openwop-app/conversation-tools/sessions/:sessionId';

  // READ — the scope config + the approval ledger for this conversation.
  app.get(`${BASE}/capability-scope`, async (req, res, next) => {
    try {
      const tenantId = tenantOf(req);
      const sessionId = req.params.sessionId;
      const meta = await requireVisibleMeta(req, tenantId, sessionId);
      res.json({
        scope: meta?.capabilityScope ?? { mode: 'agent-default' },
        // FW2-D1 — the digest stays server-side (the client never needs it).
        approvals: (await listToolApprovals(tenantId, sessionId)).map(approvalView),
        // ADR 0834 D3 — what THIS viewer may do with the conversation's tool asks, so the
        // client stops offering controls the server would refuse or silently ignore.
        // `mayApprove` is the approvals route's own predicate. `mayBypass` is a hint: the
        // exchange decides against the RUN's acting principal, which for an owned
        // conversation is its owner; an ownerless (legacy) conversation leaves it to the
        // exchange.
        viewer: {
          mayApprove: toolAuthorityHolds(actingUserOf(req), meta.ownerUserId),
          mayBypass: !meta.ownerUserId || toolAuthorityHolds(actingUserOf(req), meta.ownerUserId),
          // The scope PUT's own gate (`requireOwnerWrite`): the owner, or anyone visible on
          // an ownerless conversation.
          mayEditScope: !meta.ownerUserId || meta.ownerUserId === actingUserOf(req),
        },
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

  // RESOLVE — approve/deny a PENDING per-tool approval (the Phase 3 resolve seam).
  // ADR 0834 D3 — authority is the principal the conversation's tools act as (its
  // owner), through the ONE predicate the exchange's bypass check also calls. An
  // ownerless conversation has no such principal ⇒ 403 (the scope PUT above stays
  // tenant-permissive for ownerless conversations; an approval spends authority).
  // ADR 0834 D2 — an approval ANSWERS an ask: no pending row ⇒ 409, and a row that moved
  // since the approver looked (`requestedAt` echoed) ⇒ 409.
  app.post(`${BASE}/approvals/:toolName`, async (req, res, next) => {
    try {
      const tenantId = tenantOf(req);
      const sessionId = req.params.sessionId;
      const meta = await requireVisibleMeta(req, tenantId, sessionId);
      const approver = requireToolAuthority(req, meta, 'approve');
      const body = (req.body ?? {}) as { decision?: unknown; requestedAt?: unknown; grain?: unknown };
      const decision = body.decision;
      if (decision !== 'approved' && decision !== 'denied') {
        throw new OpenwopError('validation_error', "decision MUST be 'approved' or 'denied'.", 400);
      }
      // FW2-CD-2 — approve what you saw: the version is required, not optional, so no
      // caller (an API client included) can approve a row it never read.
      if (typeof body.requestedAt !== 'string' || body.requestedAt.length === 0) {
        throw new OpenwopError('validation_error', 'requestedAt (the pending request version you reviewed) is required.', 400);
      }
      // ADR 0834 FW2-D1 — what the approval covers: `call` (default) = this exact call,
      // once; `conversation` = any call of this tool for the rest of the conversation
      // (in-app asks only).
      const grain = body.grain === undefined ? 'call' : body.grain;
      if (grain !== 'call' && grain !== 'conversation') {
        throw new OpenwopError('validation_error', "grain MUST be 'call' or 'conversation'.", 400);
      }
      const out = await resolveToolApproval(tenantId, sessionId, req.params.toolName, decision, approver, body.requestedAt, grain);
      if (!out.ok) {
        if (out.reason === 'grain_not_allowed') {
          throw new OpenwopError('validation_error', 'A request from a messaging channel can only be approved for this one call.', 400, { reason: 'grain_not_allowed' });
        }
        if (out.reason === 'approval_expired') {
          throw new OpenwopError('conflict', 'This request from a messaging channel expired. It will be asked again if the agent retries.', 409, { reason: 'approval_expired' });
        }
        throw out.reason === 'no_pending_approval'
          ? new OpenwopError('conflict', 'No approval is pending for this tool in this conversation.', 409, { reason: 'no_pending_approval' })
          : new OpenwopError('conflict', 'This request changed since you reviewed it — review it again.', 409, { reason: 'approval_changed' });
      }
      res.json({ approval: approvalView(out.record) });
    } catch (err) { next(err); }
  });

  // REVOKE — CHAN-F17: withdraw an approval (a tool-wide grant, or a one-call approval not
  // yet used). Same authority as approving. `resolvedAt` (the version the owner saw) is
  // required, as `requestedAt` is for a decision: no caller revokes a row it never read.
  app.delete(`${BASE}/approvals/:toolName`, async (req, res, next) => {
    try {
      const tenantId = tenantOf(req);
      const sessionId = req.params.sessionId;
      const meta = await requireVisibleMeta(req, tenantId, sessionId);
      requireToolAuthority(req, meta, 'revoke');
      const resolvedAt = req.query.resolvedAt;
      if (typeof resolvedAt !== 'string' || resolvedAt.length === 0) {
        throw new OpenwopError('validation_error', 'resolvedAt (the approval version you reviewed) is required.', 400);
      }
      const out = await revokeToolApproval(tenantId, sessionId, req.params.toolName, resolvedAt);
      if (!out.ok) {
        throw out.reason === 'no_approval'
          ? new OpenwopError('conflict', 'No approval is held for this tool in this conversation.', 409, { reason: 'no_approval' })
          : new OpenwopError('conflict', 'This approval changed since you reviewed it — review it again.', 409, { reason: 'approval_changed' });
      }
      res.status(204).end();
    } catch (err) { next(err); }
  });
}
