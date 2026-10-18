/**
 * ADR 0738 (reusable WorkItems) — the core `core.openwop.kanban-work-items`
 * materializer forwards a producer's proposal to the tenant-scoped
 * `ctx.kanban.materializeWorkItems` boundary with a DETERMINISTIC delivery key
 * (per run/node/board/source), and never a tenantId (the host fills tenant from
 * the run scope). Red if the key gains entropy or the command carries a tenant
 * (probes w37g1-pack-key-deterministic, w37g1-pack-no-tenant).
 *
 * The review-policy gate (`requireApproval`) is owned by
 * `adr0835-approvals-and-repo.test.ts` (S6: approve/accept pass; reject, missing
 * and override refuse) — not duplicated here.
 */
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
    await materializeWorkItems(ctx);
    expect(first).toMatchObject({ status: 'success', outputs: { dryRun: false, workItems: [{ workItemId: 'work-1' }] } });
    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({ boardId: 'board-1', ...proposal });
    expect(received[0]?.idempotencyKey).toMatch(/^kanban-work-[0-9a-f]{32}$/);
    expect(received[0]?.idempotencyKey).toEqual(received[1]?.idempotencyKey);
    expect(received[0]).not.toHaveProperty('tenantId');
  });
});
