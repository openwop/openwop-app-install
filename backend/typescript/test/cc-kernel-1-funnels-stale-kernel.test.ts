/**
 * CC-KERNEL-1 — a funnel step refuses a STALE messaging kernel, the same way the
 * channel generators do (ADR 1020 D8).
 *
 * Observed live on app.openwop.dev (build 373d4863a, 2026-11-12): brief
 * 0cf0f586 was edited to revision 5 after its kernel was approved, so the brief
 * page showed "Kernel stale". The `funnels.step.thankyou` run b3d2e0a3… still
 * wrote its copy from the stale kernel, created a CMS page and submitted it for
 * review. `feature.campaign-channels.nodes` refuses `kernel_stale`; the funnel
 * step's context node (`feature.funnels.nodes.offer-context`) read
 * `brief.kernel` straight off the get-brief row and never looked at
 * `brief.kernelStale`.
 *
 * Seam: the REAL brief row (create → setKernel → content edit), in the shape the
 * get-brief node outputs (`{ brief }`), fed to the real offer-context node.
 *
 * Pins: stale ⇒ typed `kernel_stale` with an honest message, no context;
 * controls — a fresh kernel still projects into the context; a brief with no
 * kernel at all still works (funnels do not require one).
 *
 * Sabotage witness: remove the kernelStale check in offerContext ⇒ "a stale
 * kernel is refused" goes red (the stale headline reaches the copy model).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { nodes as funnelNodes } from '../../../packs/feature.funnels.nodes/index.mjs';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { createBrief, setKernel, updateBrief, getBrief } from '../src/features/campaign-brief/briefService.js';

const T = 'ws:cc-kernel-1';
const KERNEL = {
  headline: 'Make room for the goal you keep postponing.', supportingStatement: 'One clear step a day.',
  proofPoints: ['Free 7-day challenge'], primaryCta: 'Start with Make Room · 7 days', secondaryCta: '', tone: 'Warm',
  channelTones: {}, sourceDocIds: [], generatedAt: '2026-11-12T01:48:39.685Z',
};
type NodeOut = { status: string; outputs?: { context?: { brief?: { kernel?: { headline?: string } } } }; error?: { code?: string; message?: string } };
const offerContext = (brief: unknown) => funnelNodes['feature.funnels.nodes.offer-context']!({ inputs: { brief } }) as Promise<NodeOut>;

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

async function briefWithKernel(name: string) {
  const b = await createBrief(T, 'org-a', 'u', { name, productName: 'KickTodo', objective: 'Start the free 7-day challenge' });
  await setKernel(T, b.id, KERNEL, 'u');
  return b.id;
}

describe('CC-KERNEL-1 — funnel steps and the stale kernel', () => {
  it('a stale kernel is refused as kernel_stale (no copy context is built from it)', async () => {
    const id = await briefWithKernel('Stale brief');
    await updateBrief(T, id, { objective: 'Start the free 7-day challenge. QA stale-check edit.' }, 'u');
    const row = await getBrief(T, id);
    expect(row?.kernelStale).toBe(true); // the get-brief row carries the flag
    const out = await offerContext({ brief: row });
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('kernel_stale');
    expect(out.error?.message).toMatch(/Regenerate and approve the kernel/);
    expect(JSON.stringify(out)).not.toContain(KERNEL.headline);
  });

  it('control: a fresh kernel still reaches the copy context', async () => {
    const id = await briefWithKernel('Fresh brief');
    const out = await offerContext({ brief: await getBrief(T, id) });
    expect(out.status).toBe('success');
    expect(out.outputs?.context?.brief?.kernel?.headline).toBe(KERNEL.headline);
  });

  it('control: a brief with no kernel still builds a context (funnels do not require one)', async () => {
    const b = await createBrief(T, 'org-a', 'u', { name: 'No kernel', productName: 'KickTodo' });
    const out = await offerContext({ brief: await getBrief(T, b.id) });
    expect(out.status).toBe('success');
    expect(out.outputs?.context?.brief?.kernel).toBeUndefined();
  });
});
