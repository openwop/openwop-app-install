/**
 * Core Kanban WorkItem materializer.
 *
 * The node deliberately does not know an App Builder, CRM, document, or any
 * other producer. A producer emits the small typed proposal envelope and this
 * node sends it through the shared tenant-scoped host.kanban command boundary.
 */

import { createHash } from 'node:crypto';

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw fail('validation_error', `${label} must be an object`);
  }
  return value;
}

function text(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw fail('validation_error', `${label} must be a non-empty string`);
  }
  return value;
}

function deliveryKey(ctx, boardId, proposal) {
  const source = object(proposal.source, 'proposal.source');
  const stable = [
    String(ctx.runId ?? ''),
    String(ctx.nodeId ?? ''),
    boardId,
    String(source.kind ?? ''),
    String(source.id ?? ''),
    String(source.revision ?? ''),
  ].join('\u0000');
  return `kanban-work-${createHash('sha256').update(stable).digest('hex').slice(0, 32)}`;
}

function isApproved(value) {
  return value === true || (value && typeof value === 'object' && value.action === 'approve');
}

export async function materializeWorkItems(ctx) {
  if (!ctx.kanban || typeof ctx.kanban.materializeWorkItems !== 'function') {
    throw fail('host_capability_missing', 'host does not expose ctx.kanban.materializeWorkItems');
  }
  const inputs = object(ctx.inputs ?? {}, 'inputs');
  const boardId = text(inputs.boardId, 'boardId');
  const proposal = object(inputs.proposal, 'proposal');
  object(proposal.scope, 'proposal.scope');
  object(proposal.source, 'proposal.source');
  if (!Array.isArray(proposal.items)) throw fail('validation_error', 'proposal.items must be an array');
  const config = object(ctx.config ?? {}, 'config');
  if (config.requireApproval === true && !isApproved(inputs.approval)) {
    throw fail('kanban_approval_required', 'this materialization requires an approved review-gate input');
  }
  const executionMode = config.executionMode === 'auto' ? 'auto' : 'manual';
  const maxAttempts = Number.isInteger(config.maxAttempts) ? config.maxAttempts : undefined;
  if (maxAttempts !== undefined && (maxAttempts < 1 || maxAttempts > 10)) {
    throw fail('validation_error', 'maxAttempts must be an integer from 1 through 10');
  }
  const items = proposal.items.map((item, index) => {
    const workItem = object(item, `proposal.items[${index}]`);
    return {
      ...workItem,
      ...(workItem.execution ? {} : {
        execution: {
          mode: executionMode,
          ...(maxAttempts === undefined ? {} : { maxAttempts }),
        },
      }),
    };
  });
  const result = await ctx.kanban.materializeWorkItems({
    boardId,
    scope: proposal.scope,
    source: proposal.source,
    // A chain author can choose manual or automatic execution without teaching
    // a producer about Kanban persistence. A producer's explicit per-item
    // policy still wins, which is how domain adapters can mix review modes.
    items,
    idempotencyKey: deliveryKey(ctx, boardId, proposal),
    ...(config.dryRun === true ? { dryRun: true } : {}),
  });
  return { status: 'success', outputs: result };
}

export const nodes = {
  'core.openwop.kanban.work-items.materialize': materializeWorkItems,
};

export default nodes;
