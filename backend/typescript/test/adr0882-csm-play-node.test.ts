/**
 * ADR 0882 D6 — `create-play-tasks` against fake surfaces (the post-implementation
 * /grade-code findings, each red against the first cut):
 *
 *  CSM2CD-1  a book with more renewals due than one surface read (50) used to fail
 *            the WHOLE run and create nothing; it is now read in slices, under a
 *            per-run ceiling that fails typed;
 *  CSM2CD-2  one account's CRM failure used to abort the node, so the same broken
 *            account (soonest renewal first) starved every later one on every run;
 *            a `not_found`/`validation_error` now SKIPS that account, and a missing
 *            authority is collected and fails the node AFTER the others are ensured;
 *  CSM2CD-3  a link to a merged/deleted company is skipped, not written to.
 *
 * Tracker TST-BHD-1. Red when (sabotage-witnessed, wave 62): the slice size exceeds
 * the surface limit, the per-run ceiling is skipped, a not_found/validation_error
 * aborts instead of skipping, a forbidden_scope is not collected, a gone link is
 * written to, or nothing-ensured returns success.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..', '..');
type Ctx = { runId: string; nodeId: string; config: Record<string, unknown>; inputs: Record<string, unknown>; features: Record<string, unknown> };
async function loadNode(): Promise<(ctx: Ctx) => Promise<{ status: string; outputs: { tasks: Array<{ accountId: string }>; skipped: Array<{ accountId: string; reason: string }> } }>> {
  const mod = (await import(pathToFileURL(join(REPO_ROOT, 'packs', 'feature.csm.nodes', 'index.mjs')).href)) as { createPlayTasks: never };
  return mod.createPlayTasks;
}

function fakes(opts: { failFor?: Record<string, string>; linkGone?: Set<string> } = {}) {
  const sliceSizes: number[] = [];
  const created: string[] = [];
  const csm = {
    listAccounts: async () => ({ accounts: [] }),
    playTargets: async ({ accountIds }: { accountIds: string[] }) => {
      if (accountIds.length > 50) throw Object.assign(new Error('MUST be 1–50 account ids'), { code: 'validation_error' });
      sliceSizes.push(accountIds.length);
      return { targets: accountIds.map((id) => ({ accountId: id, name: id, orgId: 'org-1', companyId: `cmp:${id}`, ...(opts.linkGone?.has(id) ? { linkGone: true } : {}) })) };
    },
  };
  const crm = {
    createTask: async (args: { taskId: string; companyId: string }) => {
      const id = args.companyId.slice(4);
      const code = opts.failFor?.[id];
      if (code) throw Object.assign(new Error(code), { code });
      created.push(args.taskId);
      return { task: { taskId: args.taskId } };
    },
  };
  return { csm, crm, sliceSizes, created };
}

const STEPS = [{ title: 'Step', dueInDays: 1 }];
const ctxFor = (f: ReturnType<typeof fakes>, accountIds: string[]): Ctx => ({
  runId: 'run-1', nodeId: 'plays', config: { playId: 'renewal-runway', steps: STEPS, cycle: 'run' }, inputs: { accountIds }, features: { csm: f.csm, crm: f.crm },
});

describe('ADR 0882 D6 — create-play-tasks', () => {
  it('CSM2CD-1: 120 due accounts are read in slices and every one is ensured', async () => {
    const node = await loadNode();
    const f = fakes();
    const ids = Array.from({ length: 120 }, (_, i) => `a${i}`);
    const out = await node(ctxFor(f, ids));
    expect(out.outputs.tasks).toHaveLength(120);
    expect(f.sliceSizes).toEqual([50, 50, 20]);
  });

  it('CSM2CD-1: past the per-run ceiling it fails typed instead of half-running', async () => {
    const node = await loadNode();
    const f = fakes();
    await expect(node(ctxFor(f, Array.from({ length: 501 }, (_, i) => `a${i}`)))).rejects.toMatchObject({ code: 'play_too_large' });
    expect(f.created).toHaveLength(0);
  });

  it('CSM2CD-2: a broken account is skipped, the rest are ensured', async () => {
    const node = await loadNode();
    const f = fakes({ failFor: { a0: 'not_found' } });
    const out = await node(ctxFor(f, ['a0', 'a1']));
    expect(out.outputs.tasks.map((t) => t.accountId)).toEqual(['a1']);
    expect(out.outputs.skipped).toEqual([{ accountId: 'a0', reason: 'not_found' }]);
  });

  it('CSM2CD-2: a missing authority fails the node, AFTER the others are ensured', async () => {
    const node = await loadNode();
    const f = fakes({ failFor: { a0: 'forbidden_scope' } });
    await expect(node(ctxFor(f, ['a0', 'a1']))).rejects.toMatchObject({ code: 'forbidden_scope' });
    expect(f.created).toHaveLength(1);
  });

  it('CSM2CD-3: a link to a merged or deleted company is skipped', async () => {
    const node = await loadNode();
    const f = fakes({ linkGone: new Set(['a0']) });
    const out = await node(ctxFor(f, ['a0', 'a1']));
    expect(out.outputs.skipped).toEqual([{ accountId: 'a0', reason: 'crm-link-gone' }]);
    expect(out.outputs.tasks.map((t) => t.accountId)).toEqual(['a1']);
  });

  it('nothing ensured is a typed failure, never success-with-empty', async () => {
    const node = await loadNode();
    const f = fakes({ linkGone: new Set(['a0']) });
    await expect(node(ctxFor(f, ['a0']))).rejects.toMatchObject({ code: 'no_play_targets' });
  });
});
