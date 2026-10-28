/**
 * ADR 0835 D5 + D6 — the approval the chains are built around, and a repo name.
 *
 *  - S6: the host advertises and accepts `approve` AND `accept` for one
 *    decision; the Kanban materializer admitted only `approve`, so an approved
 *    plan-to-kanban review failed the run with `kanban_approval_required`.
 *  - S7: the repair chain wired `review.approved` — a port the gate never
 *    emits — into `apply-repair.approval`, and the node never read it. A copy
 *    whose review edge is deleted in the builder wrote the candidate unreviewed.
 *  - S8: `.` / `..` passed `REPO_NAME_RE` and were spliced into GitHub paths.
 *
 * TST-BWA-2 (grade-tests w62): each apply-repair case owns its `writes` log (the shared
 * array made the file order-dependent under shuffle). Red when `isApproved` drops
 * `accept` or admits `override`, when apply-repair's approval guard is bypassed or drops
 * `accept`, when the chain wires `review.approved` instead of `review`, or when
 * `REPO_NAME_RE` loses its `(?!\.{1,2}$)` lookahead.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REPO_NAME_RE } from '../src/features/app-builder/publishService.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const kanban = await import('../../../packs/core.openwop.kanban-work-items/index.mjs');
const appNodes = await import('../../../packs/feature.app-builder.nodes/index.mjs');

const proposal = { scope: { kind: 'canvas', id: 'c1' }, source: { kind: 'app-builder', id: 'c1', revision: '3' }, items: [] };
function materializeCtx(approval: unknown): Record<string, unknown> {
  return {
    runId: 'run-1', nodeId: 'materialize', config: { requireApproval: true },
    inputs: { boardId: 'board-1', proposal, approval },
    kanban: { materializeWorkItems: async () => ({ workItems: [], cards: [] }) },
  };
}

describe('ADR 0835 D5 — both spellings of an approval are an approval (S6)', () => {
  const materialize = kanban.materializeWorkItems as (ctx: Record<string, unknown>) => Promise<{ status: string }>;

  for (const action of ['approve', 'accept']) {
    it(`materializes after a review resolved with "${action}"`, async () => {
      await expect(materialize(materializeCtx({ action }))).resolves.toMatchObject({ status: 'success' });
    });
  }

  it('still refuses a reject, a missing decision and the override bypass', async () => {
    for (const approval of [{ action: 'reject' }, undefined, { action: 'override' }]) {
      await expect(materialize(materializeCtx(approval)), JSON.stringify(approval)).rejects.toMatchObject({ code: 'kanban_approval_required' });
    }
  });
});

describe('ADR 0835 D5 — apply-repair writes only an approved candidate (S7)', () => {
  const apply = appNodes.applyDesignRepair as (ctx: Record<string, unknown>) => Promise<unknown>;
  /** A fresh write log per case, so no case reads another's writes. */
  const harness = () => {
    const writes: unknown[] = [];
    const ctx = (approval: unknown): Record<string, unknown> => ({
      inputs: { artifact: { payload: { name: 'A', screens: [] } }, canvasId: 'c1', baseVersion: 2, ...(approval === undefined ? {} : { approval }) },
      features: { 'app-builder': { applyRepair: async (a: unknown) => { writes.push(a); return { canvasId: 'c1', newVersion: 3 }; } } },
    });
    return { writes, ctx };
  };

  it('refuses without an approval, or with a reject', async () => {
    const { writes, ctx } = harness();
    for (const approval of [undefined, { action: 'reject' }, 'yes']) {
      await expect(apply(ctx(approval)), JSON.stringify(approval)).rejects.toMatchObject({ code: 'approval_required' });
    }
    expect(writes).toHaveLength(0);
  });

  it('writes after approve / accept', async () => {
    const { writes, ctx } = harness();
    for (const action of ['approve', 'accept']) await apply(ctx({ action }));
    expect(writes).toEqual([
      { canvasId: 'c1', expectedVersion: 2, app: { name: 'A', screens: [] } },
      { canvasId: 'c1', expectedVersion: 2, app: { name: 'A', screens: [] } },
    ]);
  });

  it('the repair chain feeds the review gate\'s decision into apply (no phantom port)', () => {
    const pack = JSON.parse(readFileSync(join(REPO, 'examples', 'workflow-chain-packs', 'app-builder', 'pack.json'), 'utf8')) as {
      chains: Array<{ chainId: string; dag: { edges: Array<{ from: string; to: string }> } }>;
    };
    const repair = pack.chains.find((c) => c.chainId === 'app-builder.repair')!;
    const feeds = repair.dag.edges.filter((e) => e.to === 'apply.approval').map((e) => e.from);
    expect(feeds).toEqual(['review']);
  });
});

describe('ADR 0835 D6 — repository names (S8)', () => {
  it('refuses . and .., keeps real names', () => {
    for (const bad of ['.', '..', '', 'a/b', 'x'.repeat(101)]) expect(REPO_NAME_RE.test(bad), bad).toBe(false);
    for (const ok of ['my-app', 'my.app', '.github', 'a..b', 'App_1']) expect(REPO_NAME_RE.test(ok), ok).toBe(true);
  });
});
