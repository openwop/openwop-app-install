import { describe, expect, it } from 'vitest';

type CorePack = typeof import('../../../packs/core.openwop.kanban-work-items/index.mjs');

const proposal = {
  scope: { kind: 'canvas.example', externalRef: 'canvas-1' },
  source: { kind: 'example.plan', id: 'plan-1', revision: '2' },
  items: [{ key: 'first', title: 'First work item', columnId: 'todo' }],
};

describe('core.openwop.kanban-work-items', () => {
  const pack = (): Promise<CorePack> => import('../../../packs/core.openwop.kanban-work-items/index.mjs');

  it('binds a generic producer proposal to the tenant-scoped host command with a deterministic run delivery key', async () => {
    const { materializeWorkItems } = await pack();
    const received: Array<Record<string, unknown>> = [];
    const ctx = {
      runId: 'run-1',
      nodeId: 'node-1',
      inputs: { boardId: 'board-1', proposal },
      config: {},
      kanban: {
        materializeWorkItems: async (command: Record<string, unknown>) => {
          received.push(command);
          return { dryRun: false, workItems: [{ workItemId: 'work-1' }], cards: [{ id: 'card-1' }] };
        },
      },
    };
    const first = await materializeWorkItems(ctx);
    const second = await materializeWorkItems(ctx);
    expect(first.outputs).toMatchObject({ dryRun: false, workItems: [{ workItemId: 'work-1' }] });
    expect(second.outputs).toEqual(first.outputs);
    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({ boardId: 'board-1', ...proposal });
    expect(received[0]?.idempotencyKey).toEqual(received[1]?.idempotencyKey);
    expect(received[0]).not.toHaveProperty('tenantId');
  });

  it('makes review policy composable rather than hard-coding it into every producer', async () => {
    const { materializeWorkItems } = await pack();
    const ctx = {
      runId: 'run-1', nodeId: 'node-1',
      inputs: { boardId: 'board-1', proposal, approval: false },
      config: { requireApproval: true },
      kanban: { materializeWorkItems: async () => ({ dryRun: false, workItems: [], cards: [] }) },
    };
    await expect(materializeWorkItems(ctx)).rejects.toMatchObject({ code: 'kanban_approval_required' });

    await expect(materializeWorkItems({
      ...ctx,
      inputs: { boardId: 'board-1', proposal, approval: { action: 'approve' } },
    })).resolves.toMatchObject({ status: 'success' });
  });
});
