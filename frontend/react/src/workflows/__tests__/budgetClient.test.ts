/**
 * ADR 0482 §6 — the budget client fns: wire shape of GET/PUT/clear against
 * the owner-gated host-ext route (the dialog's only data dependency).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearWorkflowBudget, getWorkflowBudget, putWorkflowBudget } from '../workflowsClient.js';

function mockFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('workflow budget client (ADR 0482)', () => {
  it('getWorkflowBudget GETs the budget route and returns budget + spend', async () => {
    const fn = mockFetch(200, { budget: { dailyUsd: 2, hardCap: true, updatedAt: 't' }, spentTodayUsd: 0.4 });
    const out = await getWorkflowBudget('wf/1');
    expect(out.budget?.dailyUsd).toBe(2);
    expect(out.spentTodayUsd).toBe(0.4);
    const url = String(fn.mock.calls[0]![0]);
    expect(url).toContain('/host/openwop-app/workflows/wf%2F1/budget');
  });

  it('putWorkflowBudget PUTs { dailyUsd, hardCap } and unwraps the budget', async () => {
    const fn = mockFetch(200, { budget: { dailyUsd: 5, hardCap: false, updatedAt: 't' } });
    const out = await putWorkflowBudget('wf-2', { dailyUsd: 5, hardCap: false });
    expect(out.dailyUsd).toBe(5);
    const init = fn.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ dailyUsd: 5, hardCap: false });
  });

  it('clearWorkflowBudget PUTs the explicit { dailyUsd: null } clear form', async () => {
    const fn = mockFetch(200, { budget: null, removed: true });
    await clearWorkflowBudget('wf-3');
    const init = fn.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ dailyUsd: null });
  });

  it('non-OK surfaces as a typed-ish error (the dialog shows budgetSaveFailed)', async () => {
    mockFetch(400, { error: 'validation_error' });
    await expect(putWorkflowBudget('wf-4', { dailyUsd: -1, hardCap: false })).rejects.toThrow('budget_put_400');
  });
});
