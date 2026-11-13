/**
 * ADR 1112 P6 — AI rewrite of a large scheduleSim, in parts (CG-1112-17).
 *
 * Pins:
 *  - a section over one reply is rewritten in parts (`aiParts`, shared with translate): every
 *    decision's words rewritten, every behaviour key, id and link back from the base;
 *  - past the part budget the refusal is `validation_error` / `too_large` with the count,
 *    before any model call;
 *  - a part that drops a decision gets the one repair, then `rewrite_invalid`;
 *  - the parts run under one deadline (`rewrite_invalid`, `timeout`, 504).
 *
 * Sabotage, each restored, each red: plan the whole section as one part (the old refusal);
 * drop the per-part reply check; drop the deadline in `runParts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/host/headlessAi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/headlessAi.js')>();
  return { ...actual, resolveHeadlessAi: vi.fn() };
});

import { resolveHeadlessAi, type HeadlessDispatch } from '../src/host/headlessAi.js';
import { validateSection } from '../src/features/cms/cmsService.js';
import { AI_PARTS_DEADLINE_MS, planParts } from '../src/features/cms/aiParts.js';
import { rewriteSectionData } from '../src/features/cms/rewrite.js';

type Raw = Record<string, unknown>;
const mockResolve = vi.mocked(resolveHeadlessAi);
afterEach(() => { vi.useRealTimers(); mockResolve.mockReset(); });

const milestones = Array.from({ length: 12 }, (_, i) => ({ id: `m${i + 1}`, label: `Milestone ${i + 1}`, startWeek: i * 4, weeks: 4 }));
const sim = (n: number): Raw => validateSection({ type: 'scheduleSim', data: {
  milestones,
  decisions: Array.from({ length: n }, (_, i) => ({
    id: `DEC-${String(i).padStart(5, '0')}`, title: `What finish does item ${i} need`, element: `Kitchen zone ${i}`,
    milestone: `m${(i % 12) + 1}`, lockWeek: (i % 12) * 4 + 2, leadDays: (i % 7) * 7, ...(i > 0 ? { dependsOn: [`DEC-${String(i - 1).padStart(5, '0')}`] } : {}),
  })),
} }, 'en', 't1').data;

const sent = (messages: readonly { content: unknown }[]): Raw => {
  const user = String(messages[1]?.content ?? '');
  return JSON.parse(user.slice(user.indexOf('\n\n') + 2)) as Raw;
};
const tidy = (v: unknown, key = ''): unknown => {
  if (Array.isArray(v)) return v.map((x) => tidy(x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tidy(x, k)]));
  return typeof v === 'string' && key === 'title' ? `Tidy: ${v}`.slice(0, 39) : v;
};
function model(reply: (part: Raw) => unknown = (p) => tidy(p)) {
  const dispatch = vi.fn<HeadlessDispatch>(async (messages) => JSON.stringify(reply(sent(messages))));
  mockResolve.mockResolvedValue(dispatch);
  return dispatch;
}

describe('ADR 1112 P6 — rewrite in parts', () => {
  it('rewrites every decision of a large schedule, behaviour and ids from the base', async () => {
    const data = sim(200);
    const plan = planParts('scheduleSim', data);
    expect(plan.ok && plan.parts.length).toBeGreaterThan(1);
    const dispatch = model();
    const out = await rewriteSectionData('t1', 'scheduleSim', data, 'improve');
    expect(dispatch).toHaveBeenCalledTimes(plan.ok ? plan.parts.length : 0);
    const base = data.decisions as Raw[];
    (out.decisions as Raw[]).forEach((x, i) => {
      expect(String(x.title)).toMatch(/^Tidy: /);
      expect(x).toMatchObject({ id: base[i]!.id, milestone: base[i]!.milestone, lockWeek: base[i]!.lockWeek, leadDays: base[i]!.leadDays });
    });
    expect(out.milestones).toEqual(data.milestones);
  });
  it('refuses past the part budget with the count, before any model call', async () => {
    const dispatch = model();
    await expect(rewriteSectionData('t1', 'scheduleSim', sim(1_500), 'improve')).rejects.toMatchObject({
      code: 'validation_error', details: { reason: 'too_large', maxBatches: 8 },
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('repairs a part that drops a decision, then refuses it', async () => {
    model((p) => ({ ...(tidy(p) as Raw), decisions: (p.decisions as Raw[]).slice(1) }));
    await expect(rewriteSectionData('t1', 'scheduleSim', sim(200), 'improve')).rejects.toMatchObject({ code: 'rewrite_invalid', details: { repairAttempted: true } });
  });
  it('runs the parts under one deadline', async () => {
    vi.useFakeTimers();
    mockResolve.mockResolvedValue(vi.fn<HeadlessDispatch>((_m, opts) => new Promise<string>((_, reject) => opts.signal?.addEventListener('abort', () => reject(new Error('aborted'))))));
    const pending = rewriteSectionData('t1', 'scheduleSim', sim(200), 'improve');
    const settled = expect(pending).rejects.toMatchObject({ code: 'rewrite_invalid', httpStatus: 504, details: { reason: 'timeout' } });
    await vi.advanceTimersByTimeAsync(AI_PARTS_DEADLINE_MS + 1);
    await settled;
  });
});
