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
  deleteProject,
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

  // ── Projects ──
  app.get('/v1/host/openwop-app/assistant/projects', wrap(async (req, res) => {
    res.json({ projects: await listProjects(tenantOf(req)) });
  }));
  app.post('/v1/host/openwop-app/assistant/projects', wrap(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const project = await createProject(tenantOf(req), {
      name: requireString(body.name, 'name'),
      ...(optNumber(body.priority, 'priority') !== undefined ? { priority: optNumber(body.priority, 'priority') } : {}),
      ...(typeof body.summary === 'string' ? { summary: body.summary } : {}),
      ...(typeof body.status === 'string' ? { status: body.status as ProjectStatus } : {}),
    });
    res.status(201).json(project);
  }));
  app.get('/v1/host/openwop-app/assistant/projects/:id', wrap(async (req, res) => {
    const p = await getProject(tenantOf(req), req.params.id);
    if (!p) throw new OpenwopError('not_found', 'Project not found.', 404, { projectId: req.params.id });
    res.json(p);
  }));
  app.patch('/v1/host/openwop-app/assistant/projects/:id', wrap(async (req, res) => {
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
  app.delete('/v1/host/openwop-app/assistant/projects/:id', wrap(async (req, res) => {
    if (!(await deleteProject(tenantOf(req), req.params.id))) {
      throw new OpenwopError('not_found', 'Project not found.', 404, { projectId: req.params.id });
    }
    res.status(204).end();
  }));

  // ── Commitments ──
  app.get('/v1/host/openwop-app/assistant/commitments', wrap(async (req, res) => {
    const filter: { status?: CommitmentStatus; projectId?: string } = {};
    if (typeof req.query.status === 'string') filter.status = req.query.status as CommitmentStatus;
    if (typeof req.query.projectId === 'string') filter.projectId = req.query.projectId;
    res.json({ commitments: await listCommitments(tenantOf(req), filter) });
  }));
  app.get('/v1/host/openwop-app/assistant/commitments/:id', wrap(async (req, res) => {
    const c = await getCommitment(tenantOf(req), req.params.id);
    if (!c) throw new OpenwopError('not_found', 'Commitment not found.', 404, { commitmentId: req.params.id });
    res.json(c);
  }));
  app.patch('/v1/host/openwop-app/assistant/commitments/:id', wrap(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updated = await updateCommitment(tenantOf(req), req.params.id, {
      ...(typeof body.status === 'string' ? { status: body.status as CommitmentStatus } : {}),
      ...(typeof body.dueAt === 'string' ? { dueAt: body.dueAt } : {}),
      ...(typeof body.projectId === 'string' ? { projectId: body.projectId } : {}),
    });
    if (!updated) throw new OpenwopError('not_found', 'Commitment not found.', 404, { commitmentId: req.params.id });
    res.json(updated);
  }));
  app.delete('/v1/host/openwop-app/assistant/commitments/:id', wrap(async (req, res) => {
    if (!(await deleteCommitment(tenantOf(req), req.params.id))) {
      throw new OpenwopError('not_found', 'Commitment not found.', 404, { commitmentId: req.params.id });
    }
    res.status(204).end();
  }));

  // ── Decisions (read; writes happen via ctx.features.assistant from loops) ──
  app.get('/v1/host/openwop-app/assistant/decisions', wrap(async (req, res) => {
    res.json({ decisions: await listDecisions(tenantOf(req), typeof req.query.projectId === 'string' ? req.query.projectId : undefined) });
  }));

  // ── Meetings ──
  app.get('/v1/host/openwop-app/assistant/meetings', wrap(async (req, res) => {
    res.json({ meetings: await listMeetings(tenantOf(req)) });
  }));
  app.get('/v1/host/openwop-app/assistant/meetings/:id', wrap(async (req, res) => {
    const m = await getMeeting(tenantOf(req), req.params.id);
    if (!m) throw new OpenwopError('not_found', 'Meeting not found.', 404, { meetingId: req.params.id });
    res.json(m);
  }));

  // ── Stakeholders ──
  app.get('/v1/host/openwop-app/assistant/stakeholders', wrap(async (req, res) => {
    res.json({ stakeholders: await listStakeholders(tenantOf(req)) });
  }));

  // ── Pending actions (the approval queue surface) ──
  app.get('/v1/host/openwop-app/assistant/pending-actions', wrap(async (req, res) => {
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
    wrap(async (req: Request, res: import('express').Response) => {
      const tenantId = tenantOf(req);
      const existing = await getPendingAction(tenantId, req.params.id);
      if (!existing) throw new OpenwopError('not_found', 'Pending action not found.', 404, { actionId: req.params.id });
      if (!existing.approvalId) {
        throw new OpenwopError('conflict', 'Action has no approval to decide — it must be enqueued through the approval loop.', 409, { actionId: req.params.id });
      }
      const decidedByUserId = req.userId ?? req.principal?.principalId;
      const decided = await decideActionViaApproval(tenantId, existing.approvalId, outcome, {
        ...(decidedByUserId !== undefined ? { decidedByUserId } : {}),
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
        .catch(() => {});
      res.json(decided.action);
    });
  app.post('/v1/host/openwop-app/assistant/pending-actions/:id/approve', decideRoute('approved'));
  app.post('/v1/host/openwop-app/assistant/pending-actions/:id/reject', decideRoute('rejected'));

  // §12 T4 — edit a still-pending draft. Kind/sources/taint are immutable;
  // the card surfaces `editedAt` so the approver knows they approve an edit.
  app.patch('/v1/host/openwop-app/assistant/pending-actions/:id', wrap(async (req, res) => {
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
  app.get('/v1/host/openwop-app/assistant/briefing', wrap(async (req, res) => {
    res.json({ brief: await composeBriefing(tenantOf(req)) });
  }));

  // ── Health (ADR 0029 / §12 T8 — admin/debug operating metrics) ──
  app.get('/v1/host/openwop-app/assistant/health', wrap(async (req, res) => {
    requireSuperadmin(req, 'Assistant health');
    res.json({ health: await buildAssistantHealth(tenantOf(req)) });
  }));

  // ── Perception loops (ADR 0023 §12 T2 — RFC 0052 jobs + status) ──
  app.get('/v1/host/openwop-app/assistant/loops', wrap(async (req, res) => {
    res.json({ loops: await listLoopStatuses(tenantOf(req)) });
  }));
  app.post('/v1/host/openwop-app/assistant/loops/:loopId/enable', wrap(async (req, res) => {
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
  app.post('/v1/host/openwop-app/assistant/loops/:loopId/disable', wrap(async (req, res) => {
    const job = await disableLoop(tenantOf(req), req.params.loopId);
    if (!job) throw new OpenwopError('not_found', 'Unknown or never-enabled assistant loop.', 404, { loopId: req.params.loopId });
    res.json({ loop: req.params.loopId, jobId: job.jobId, enabled: job.enabled });
  }));
}
