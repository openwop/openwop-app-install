/**
 * Executive-Assistant feature routes (host-extension, best-effort — ADR 0023).
 *
 * Surface under /v1/host/openwop-app/assistant. Toggle-gated on `assistant` (backend
 * authority — 404 when off), scoped to the caller's active workspace (tenantId).
 * Exposes the memory graph: projects, commitments, decisions, meetings,
 * stakeholders, and the pending-action approval queue.
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteAssistantProject,
  listCommitments,
  getCommitment,
  updateCommitment,
  deleteCommitment,
  listDecisions,
  listMeetings,
  getMeeting,
  listStakeholders,
  listPendingActions,
  getPendingAction,
  editPendingAction,
  type CommitmentStatus,
  type ProjectStatus,
} from './assistantService.js';
import { listLoopStatuses, enableLoop, disableLoop } from './loops.js';
import { composeBriefing } from './briefing.js';
import { decideActionViaApproval } from './actionApproval.js';
import { buildAssistantHealth } from './health.js';
import { requireSuperadmin } from '../../host/superadmin.js';
import { requireTenantScope } from '../featureRoute.js';
import { findAssistantAgent } from './capability.js';
import { randomUUID } from 'node:crypto';
import { ensureConversationMeta, findByDmKey, dmKeyOf, userRef, type ConversationMeta } from '../../host/conversationStore.js';
import { readMarkersOf, type ReadMarkerView } from '../../host/conversationReadState.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('features.assistant.routes');

// Graduated off the feature toggle (2026-06-11, feature.ts § Correction) — the
// Chief of Staff is a real roster agent and its surfaces serve unconditionally
// as always-on substrate (the standalone /assistant page is removed).
const tenantOf = (req: Request): string => req.tenantId ?? 'default';

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OpenwopError('validation_error', `Field \`${field}\` is required and MUST be a non-empty string.`, 400, { field });
  }
  return value;
}

function optNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new OpenwopError('validation_error', `Field \`${field}\` MUST be a number.`, 400, { field });
  }
  return value;
}

export function registerAssistantRoutes(deps: RouteDeps): void {
  const { app, storage } = deps;
  const wrap = (h: (req: Request, res: import('express').Response) => Promise<void>) =>
    async (req: Request, res: import('express').Response, next: import('express').NextFunction) => {
      try {
        await h(req, res);
      } catch (err) {
        next(err);
      }
    };
  // (2026-07 vuln-scan M9) Mutating / side-effectful assistant routes (CRUD,
  // approve/reject which can trigger real email sends, loop toggles) require
  // workspace:write — the surface previously gated on tenant only, so a viewer-role
  // member could act. requireTenantScope short-circuits the personal-tenant owner,
  // so the solo-user + anon-demo flows are unaffected.
  const wrapWrite = (h: (req: Request, res: import('express').Response) => Promise<void>) =>
    wrap(async (req, res) => {
      await requireTenantScope(req, 'workspace:write');
      await h(req, res);
    });
  // (COS-11) The READ side of the same 2026-07 vuln-scan finding. The writes were
  // hardened above because a viewer could otherwise ACT; the reads were not
  // revisited, so a non-member could read the tenant work-graph and — worse — a
  // read-only VIEWER could read every drafted outbound BODY and recipient address
  // on `/pending-actions`. `requireTenantScope` short-circuits the personal-tenant
  // owner + wildcard operator, so the solo-user + anon-demo + admin flows are
  // unaffected; a non-member resolves to zero scopes and is denied.
  //
  //  - The shared work-graph (projects/commitments/decisions/meetings/stakeholders,
  //    tenant-wide BY DESIGN — capability.ts "only the tenant work-graph") gates on
  //    `workspace:read`: any member reads it, a non-member cannot.
  //  - `/pending-actions` carries drafted outbound message bodies + recipient
  //    addresses, a narrower thing than a shared work record, so it gates on
  //    `workspace:write` — the SAME authority the decide path already requires
  //    (only someone who could send the draft may read it).
  const wrapRead = (h: (req: Request, res: import('express').Response) => Promise<void>) =>
    wrap(async (req, res) => {
      await requireTenantScope(req, 'workspace:read');
      await h(req, res);
    });

  // ── Workspace conversation (ADR 0043 Phase 6 — W-A) ──────────────────
  // POST → open-or-resume the SINGLE workspace conversation for this user: a
  // type:'workspace' chat whose participant is the tenant's assistant-capability
  // agent (ADR 0023), so the existing chat.turn + per-agent-knowledge path
  // (ADR 0038) routes turns to the assistant with workspace context. Deduped on
  // (owner, workspace:<tenant>) — distinct from a plain 1:1 DM with the same
  // assistant. 404 when no assistant agent is configured (no orphan workspace
  // chat with nothing to route to). The route lives in THIS feature (not core
  // chatSessions) because resolving the assistant is a feature concern (ADR 0001).
  app.post('/v1/host/openwop-app/assistant/workspace-conversation', wrap(async (req, res) => {
    const tenantId = tenantOf(req);
    const assistant = await findAssistantAgent(tenantId);
    const agentId = assistant?.agentRef?.agentId;
    if (!agentId) {
      throw new OpenwopError('not_found', 'No workspace assistant is configured for this workspace.', 404);
    }
    const owner = req.userId ?? req.principal?.principalId;
    const ownerSubject = owner ? userRef(owner) : `tenant:${tenantId}`;
    const dmKey = dmKeyOf(ownerSubject, `workspace:${tenantId}`);
    // Project into the conversation-header shape the rail consumes, joining each
    // participant's read marker (ADR 0043 — read state lives in its own store)
    // into `participants[].lastReadAt`, mirroring core `toConversation`. Without
    // this, a RESUMED workspace conversation's header would briefly read as
    // unread until the next list refresh.
    const project = (
      session: { sessionId: string; title: string; createdAt: string; updatedAt: string; messageCount: number },
      meta: ConversationMeta,
      readBySubject?: ReadonlyMap<string, ReadMarkerView>,
    ): Record<string, unknown> => ({
      ...session,
      tenantId,
      type: meta.type,
      ...(meta.ownerUserId ? { ownerUserId: meta.ownerUserId } : {}),
      participants: meta.participants.map((p) => {
        const lastReadAt = readBySubject?.get(p.subjectRef)?.lastReadAt ?? p.lastReadAt;
        return lastReadAt ? { ...p, lastReadAt } : p;
      }),
    });

    const existing = await findByDmKey(tenantId, dmKey);
    if (existing) {
      const session = await storage.getChatSession(tenantId, existing.conversationId);
      if (session) { res.json(project(session, existing, await readMarkersOf(tenantId, existing.conversationId))); return; }
      // Stale meta (session gone) — fall through and recreate.
    }

    const sessionId = randomUUID();
    const title = 'Workspace';
    const ts = new Date().toISOString();
    await storage.createChatSession({ sessionId, tenantId, title, createdAt: ts, updatedAt: ts, messageCount: 0 });
    const meta = await ensureConversationMeta(tenantId, sessionId, {
      type: 'workspace',
      ...(owner ? { ownerUserId: owner } : {}),
      participants: [`agent:${agentId}`],
      dmKey,
    });
    res.status(201).json(project({ sessionId, title, createdAt: ts, updatedAt: ts, messageCount: 0 }, meta));
  }));

  // ── Projects ──
  app.get('/v1/host/openwop-app/assistant/projects', wrapRead(async (req, res) => {
    res.json({ projects: await listProjects(tenantOf(req)) });
  }));
  app.post('/v1/host/openwop-app/assistant/projects', wrapWrite(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const project = await createProject(tenantOf(req), {
      name: requireString(body.name, 'name'),
      ...(optNumber(body.priority, 'priority') !== undefined ? { priority: optNumber(body.priority, 'priority') } : {}),
      ...(typeof body.summary === 'string' ? { summary: body.summary } : {}),
      ...(typeof body.status === 'string' ? { status: body.status as ProjectStatus } : {}),
    });
    res.status(201).json(project);
  }));
  app.get('/v1/host/openwop-app/assistant/projects/:id', wrapRead(async (req, res) => {
    const p = await getProject(tenantOf(req), req.params.id);
    if (!p) throw new OpenwopError('not_found', 'Project not found.', 404, { projectId: req.params.id });
    res.json(p);
  }));
  app.patch('/v1/host/openwop-app/assistant/projects/:id', wrapWrite(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updated = await updateProject(tenantOf(req), req.params.id, {
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(typeof body.status === 'string' ? { status: body.status as ProjectStatus } : {}),
      ...(optNumber(body.priority, 'priority') !== undefined ? { priority: optNumber(body.priority, 'priority') } : {}),
      ...(typeof body.summary === 'string' ? { summary: body.summary } : {}),
    });
    if (!updated) throw new OpenwopError('not_found', 'Project not found.', 404, { projectId: req.params.id });
    res.json(updated);
  }));
  app.delete('/v1/host/openwop-app/assistant/projects/:id', wrapWrite(async (req, res) => {
    if (!(await deleteAssistantProject(tenantOf(req), req.params.id))) {
      throw new OpenwopError('not_found', 'Project not found.', 404, { projectId: req.params.id });
    }
    res.status(204).end();
  }));

  // ── Commitments ──
  app.get('/v1/host/openwop-app/assistant/commitments', wrapRead(async (req, res) => {
    const filter: { status?: CommitmentStatus; projectId?: string } = {};
    if (typeof req.query.status === 'string') filter.status = req.query.status as CommitmentStatus;
    if (typeof req.query.projectId === 'string') filter.projectId = req.query.projectId;
    res.json({ commitments: await listCommitments(tenantOf(req), filter) });
  }));
  app.get('/v1/host/openwop-app/assistant/commitments/:id', wrapRead(async (req, res) => {
    const c = await getCommitment(tenantOf(req), req.params.id);
    if (!c) throw new OpenwopError('not_found', 'Commitment not found.', 404, { commitmentId: req.params.id });
    res.json(c);
  }));
  app.patch('/v1/host/openwop-app/assistant/commitments/:id', wrapWrite(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updated = await updateCommitment(tenantOf(req), req.params.id, {
      ...(typeof body.status === 'string' ? { status: body.status as CommitmentStatus } : {}),
      ...(typeof body.dueAt === 'string' ? { dueAt: body.dueAt } : {}),
      ...(typeof body.projectId === 'string' ? { projectId: body.projectId } : {}),
    });
    if (!updated) throw new OpenwopError('not_found', 'Commitment not found.', 404, { commitmentId: req.params.id });
    res.json(updated);
  }));
  app.delete('/v1/host/openwop-app/assistant/commitments/:id', wrapWrite(async (req, res) => {
    if (!(await deleteCommitment(tenantOf(req), req.params.id))) {
      throw new OpenwopError('not_found', 'Commitment not found.', 404, { commitmentId: req.params.id });
    }
    res.status(204).end();
  }));

  // ── Decisions (read; writes happen via ctx.features.assistant from loops) ──
  app.get('/v1/host/openwop-app/assistant/decisions', wrapRead(async (req, res) => {
    res.json({ decisions: await listDecisions(tenantOf(req), typeof req.query.projectId === 'string' ? req.query.projectId : undefined) });
  }));

  // ── Meetings ──
  app.get('/v1/host/openwop-app/assistant/meetings', wrapRead(async (req, res) => {
    res.json({ meetings: await listMeetings(tenantOf(req)) });
  }));
  app.get('/v1/host/openwop-app/assistant/meetings/:id', wrapRead(async (req, res) => {
    const m = await getMeeting(tenantOf(req), req.params.id);
    if (!m) throw new OpenwopError('not_found', 'Meeting not found.', 404, { meetingId: req.params.id });
    res.json(m);
  }));

  // ── Stakeholders ──
  app.get('/v1/host/openwop-app/assistant/stakeholders', wrapRead(async (req, res) => {
    res.json({ stakeholders: await listStakeholders(tenantOf(req)) });
  }));

  // ── Pending actions (the approval queue surface) ──
  // COS-11 — `wrapWrite`, NOT `wrapRead`: the queue exposes drafted outbound
  // bodies + recipient addresses, so it gates on the SAME `workspace:write`
  // authority the decide path requires (a viewer must not read a draft they
  // cannot send).
  app.get('/v1/host/openwop-app/assistant/pending-actions', wrapWrite(async (req, res) => {
    const status = typeof req.query.status === 'string' ? (req.query.status as 'pending') : undefined;
    res.json({ pendingActions: await listPendingActions(tenantOf(req), status) });
  }));
  // Every action decision flows THROUGH its approval act — the single loop
  // (ADR 0025 §4): the CAS-guarded resolveApproval is the lock, shared with
  // /approvals/:id/claim via decideActionViaApproval. There is no direct
  // status-mutation path: enqueueActionWithApproval ALWAYS creates the
  // PendingApproval, so a pending action without an approvalId is a corrupt
  // row, not a legacy one — fail closed rather than write a parallel decision.
  const decideRoute = (outcome: 'approved' | 'rejected') =>
    wrapWrite(async (req: Request, res: import('express').Response) => {
      const tenantId = tenantOf(req);
      const existing = await getPendingAction(tenantId, req.params.id);
      if (!existing) throw new OpenwopError('not_found', 'Pending action not found.', 404, { actionId: req.params.id });
      if (!existing.approvalId) {
        throw new OpenwopError('conflict', 'Action has no approval to decide — it must be enqueued through the approval loop.', 409, { actionId: req.params.id });
      }
      const decidedByUserId = req.userId ?? req.principal?.principalId;
      // ADR 0662 D2 — approve-what-you-see. REQUIRED on approve (an optional guard is an
      // unguarded guard, and this repo has no mechanism to force a compatibility window
      // closed: host-extension routes are non-normative and nothing advertises them).
      // A reject needs no hash — refusing something that changed is still a refusal.
      const expectedContentHash = (req.body as { expectedContentHash?: unknown } | undefined)?.expectedContentHash;
      if (outcome === 'approved' && typeof expectedContentHash !== 'string') {
        throw new OpenwopError('validation_error', '`expectedContentHash` is required — approve the version you read.', 400, { field: 'expectedContentHash' });
      }
      const decided = await decideActionViaApproval(tenantId, existing.approvalId, outcome, {
        ...(decidedByUserId !== undefined ? { decidedByUserId } : {}),
        ...(typeof expectedContentHash === 'string' ? { expectedContentHash } : {}),
      });
      if (!decided) throw new OpenwopError('not_found', 'Approval not found.', 404, { actionId: req.params.id });
      if (!decided.changed) {
        throw new OpenwopError('conflict', `Action already ${decided.approval.status}.`, 409, { status: decided.approval.status });
      }
      void storage
        .appendAudit({
          timestamp: new Date().toISOString(),
          principalId: decidedByUserId ?? 'unknown',
          action: `assistant.action.${outcome}`,
          resource: `assistant-action:${req.params.id}`,
          outcome: 'success',
          // tenantId in the payload is what the governance audit VIEW
          // tenant-filters on (audit_log has no tenant column).
          payload: { approvalId: existing.approvalId, tenantId },
        })
        // WF-COS-8 — the governance AUDIT append. A swallowed failure here means
        // an approve/reject of an outbound action has no audit row and nobody
        // ever learns it: the compliance trail is silently short by one entry,
        // which is exactly the class this feature's other honesty fixes close.
        // Still non-blocking (the decision has already landed), but never silent.
        .catch((err) => log.warn('assistant_action_audit_append_failed', {
          tenantId, approvalId: existing.approvalId, outcome,
          error: err instanceof Error ? err.message : String(err),
        }));
      res.json(decided.action);
    });
  app.post('/v1/host/openwop-app/assistant/pending-actions/:id/approve', decideRoute('approved'));
  app.post('/v1/host/openwop-app/assistant/pending-actions/:id/reject', decideRoute('rejected'));

  // §12 T4 — edit a still-pending draft. Kind/sources/taint are immutable;
  // the card surfaces `editedAt` so the approver knows they approve an edit.
  app.patch('/v1/host/openwop-app/assistant/pending-actions/:id', wrapWrite(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const editedByUserId = req.userId ?? req.principal?.principalId;
    const recipientDiff =
      body.recipientDiff && typeof body.recipientDiff === 'object' &&
      Array.isArray((body.recipientDiff as Record<string, unknown>).before) &&
      Array.isArray((body.recipientDiff as Record<string, unknown>).after)
        ? (body.recipientDiff as { before: string[]; after: string[] })
        : undefined;
    const edited = await editPendingAction(tenantOf(req), req.params.id, {
      ...(typeof body.draft === 'string' ? { draft: body.draft } : {}),
      ...(body.payload && typeof body.payload === 'object' ? { payload: body.payload as Record<string, unknown> } : {}),
      ...(recipientDiff !== undefined ? { recipientDiff } : {}),
      ...(editedByUserId !== undefined ? { editedByUserId } : {}),
    });
    if (!edited) {
      throw new OpenwopError('conflict', 'Action is missing or no longer pending — a decided action is re-drafted, not edited.', 409, { actionId: req.params.id });
    }
    res.json(edited);
  }));

  // ── Briefing (ADR 0023 §12 T3 — loop 5's read surface) ──
  // ONE batched read (commitments + meetings + approvals composed server-side)
  // so the page never fans out per-row requests into the per-IP rate budget.
  app.get('/v1/host/openwop-app/assistant/briefing', wrapRead(async (req, res) => {
    res.json({ brief: await composeBriefing(tenantOf(req)) });
  }));

  // ── Health (ADR 0029 / §12 T8 — admin/debug operating metrics) ──
  app.get('/v1/host/openwop-app/assistant/health', wrap(async (req, res) => {
    requireSuperadmin(req, 'Assistant health');
    res.json({ health: await buildAssistantHealth(tenantOf(req)) });
  }));

  // ── Perception loops (ADR 0023 §12 T2 — RFC 0052 jobs + status) ──
  app.get('/v1/host/openwop-app/assistant/loops', wrapRead(async (req, res) => {
    res.json({ loops: await listLoopStatuses(tenantOf(req)) });
  }));
  app.post('/v1/host/openwop-app/assistant/loops/:loopId/enable', wrapWrite(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // D2 — the loop acts AS the enabling human (per-user credential axis);
    // stamped server-side, same discipline as POST /v1/runs.
    const actingUserId = req.userId ?? req.principal?.principalId;
    const job = await enableLoop(tenantOf(req), req.params.loopId, {
      ...(actingUserId !== undefined ? { actingUserId } : {}),
      ...(typeof body.cronExpr === 'string' && body.cronExpr.length > 0 ? { cronExpr: body.cronExpr } : {}),
    });
    if (!job) throw new OpenwopError('not_found', 'Unknown assistant loop.', 404, { loopId: req.params.loopId });
    res.json({ loop: req.params.loopId, jobId: job.jobId, enabled: job.enabled });
  }));
  app.post('/v1/host/openwop-app/assistant/loops/:loopId/disable', wrapWrite(async (req, res) => {
    const job = await disableLoop(tenantOf(req), req.params.loopId);
    if (!job) throw new OpenwopError('not_found', 'Unknown or never-enabled assistant loop.', 404, { loopId: req.params.loopId });
    res.json({ loop: req.params.loopId, jobId: job.jobId, enabled: job.enabled });
  }));
}
