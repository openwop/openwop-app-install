/**
 * vendor.myndhyve.kanban — kanban-coordination pack runtime.
 *
 * 6 nodes route through ctx.kanban.*:
 *   board.create, board.review, task.assign,
 *   timeline.plan, workflow.automate, resource.monitor.
 *
 * @see docs/plans/MYNDHYVE-TO-OPENWOP-PACK-MIGRATION.md
 */

import { createHash } from 'node:crypto';

function ensureKanban(ctx) {
  if (!ctx.kanban || typeof ctx.kanban.boardCreate !== 'function') {
    throw Object.assign(new Error('host does not expose ctx.kanban'), { code: 'host_capability_missing' });
  }
}

function deriveIdempotencyKey(parts) {
  const h = createHash('sha256');
  for (const p of parts) {
    if (p === undefined || p === null) h.update('\0');
    else if (typeof p === 'string') h.update(p, 'utf8');
    else h.update(JSON.stringify(p), 'utf8');
    h.update('\x1e');
  }
  return 'openwop-' + h.digest('hex').slice(0, 16);
}

export async function boardCreate(ctx) {
  ensureKanban(ctx);
  const { projectId } = ctx.config;
  const { name, columns, description } = ctx.inputs;
  const idempotencyKey = deriveIdempotencyKey([
    String(ctx.runId), String(ctx.nodeId), name, columns, projectId ?? '', description ?? '',
  ]);
  const result = await ctx.kanban.boardCreate({
    name, columns,
    ...(description !== undefined ? { description } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    idempotencyKey,
  });
  return {
    status: 'success',
    outputs: {
      boardId: result?.boardId ?? '',
      createdAt: result?.createdAt ?? new Date().toISOString(),
      idempotencyKey,
    },
  };
}

export async function boardReview(ctx) {
  ensureKanban(ctx);
  if (typeof ctx.kanban.boardReview !== 'function') {
    throw Object.assign(new Error('host does not expose ctx.kanban.boardReview'), { code: 'host_capability_missing' });
  }
  const { includeArchived = false, atRiskThresholdDays = 3 } = ctx.config;
  const { boardId } = ctx.inputs;
  const result = await ctx.kanban.boardReview({ boardId, includeArchived, atRiskThresholdDays });
  return {
    status: 'success',
    outputs: {
      boardId,
      ...(result?.boardName ? { boardName: result.boardName } : {}),
      totalTasks: result?.totalTasks ?? 0,
      columnCounts: result?.columnCounts ?? {},
      atRiskTasks: Array.isArray(result?.atRiskTasks) ? result.atRiskTasks : [],
      reviewedAt: result?.reviewedAt ?? new Date().toISOString(),
    },
  };
}

export async function taskAssign(ctx) {
  ensureKanban(ctx);
  if (typeof ctx.kanban.taskAssign !== 'function') {
    throw Object.assign(new Error('host does not expose ctx.kanban.taskAssign'), { code: 'host_capability_missing' });
  }
  const { notifyAssignee = true } = ctx.config;
  const { taskId, assigneeId, comment } = ctx.inputs;
  const idempotencyKey = deriveIdempotencyKey([
    String(ctx.runId), String(ctx.nodeId), taskId, assigneeId, comment ?? '',
  ]);
  const result = await ctx.kanban.taskAssign({
    taskId, assigneeId, notifyAssignee,
    ...(comment !== undefined ? { comment } : {}),
    idempotencyKey,
  });
  return {
    status: 'success',
    outputs: {
      taskId,
      assigneeId,
      ...(result?.previousAssigneeId ? { previousAssigneeId: result.previousAssigneeId } : {}),
      assignedAt: result?.assignedAt ?? new Date().toISOString(),
    },
  };
}

export async function timelinePlan(ctx) {
  ensureKanban(ctx);
  if (typeof ctx.kanban.timelinePlan !== 'function') {
    throw Object.assign(new Error('host does not expose ctx.kanban.timelinePlan'), { code: 'host_capability_missing' });
  }
  const { startDate, workingHoursPerDay = 8, workingDaysPerWeek = 5, scheduler = 'critical-path' } = ctx.config;
  const { boardId } = ctx.inputs;
  const idempotencyKey = deriveIdempotencyKey([
    String(ctx.runId), String(ctx.nodeId), boardId, startDate ?? '', workingHoursPerDay, workingDaysPerWeek, scheduler,
  ]);
  const result = await ctx.kanban.timelinePlan({
    boardId,
    ...(startDate !== undefined ? { startDate } : {}),
    workingHoursPerDay, workingDaysPerWeek, scheduler,
    idempotencyKey,
  });
  return {
    status: 'success',
    outputs: {
      boardId,
      schedule: Array.isArray(result?.schedule) ? result.schedule : [],
      criticalPath: Array.isArray(result?.criticalPath) ? result.criticalPath : [],
      ...(result?.projectEndDate ? { projectEndDate: result.projectEndDate } : {}),
    },
  };
}

export async function workflowAutomate(ctx) {
  ensureKanban(ctx);
  if (typeof ctx.kanban.automateRules !== 'function') {
    throw Object.assign(new Error('host does not expose ctx.kanban.automateRules'), { code: 'host_capability_missing' });
  }
  const { replaceExisting = false } = ctx.config;
  const { boardId, rules } = ctx.inputs;
  const idempotencyKey = deriveIdempotencyKey([
    String(ctx.runId), String(ctx.nodeId), boardId, rules, replaceExisting,
  ]);
  const result = await ctx.kanban.automateRules({ boardId, rules, replaceExisting, idempotencyKey });
  return {
    status: 'success',
    outputs: {
      boardId,
      activeRules: typeof result?.activeRules === 'number' ? result.activeRules : rules.length,
      added: typeof result?.added === 'number' ? result.added : rules.length,
      appliedAt: result?.appliedAt ?? new Date().toISOString(),
    },
  };
}

export async function resourceMonitor(ctx) {
  ensureKanban(ctx);
  if (typeof ctx.kanban.resourceMonitor !== 'function') {
    throw Object.assign(new Error('host does not expose ctx.kanban.resourceMonitor'), { code: 'host_capability_missing' });
  }
  const { maxConcurrentPerAssignee = 5, includeAgents = true } = ctx.config;
  const { boardId } = ctx.inputs;
  const result = await ctx.kanban.resourceMonitor({ boardId, maxConcurrentPerAssignee, includeAgents });
  return {
    status: 'success',
    outputs: {
      boardId,
      assigneeLoad: result?.assigneeLoad ?? {},
      wipBreaches: Array.isArray(result?.wipBreaches) ? result.wipBreaches : [],
      overdueTasks: Array.isArray(result?.overdueTasks) ? result.overdueTasks : [],
      monitoredAt: result?.monitoredAt ?? new Date().toISOString(),
    },
  };
}

export const nodes = {
  'kanban.board.create': boardCreate,
  'kanban.board.review': boardReview,
  'kanban.task.assign': taskAssign,
  'kanban.timeline.plan': timelinePlan,
  'kanban.workflow.automate': workflowAutomate,
  'kanban.resource.monitor': resourceMonitor,
};

export default nodes;
