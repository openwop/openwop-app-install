/**
 * ADR 0482 §6 — the budget client fns: wire shape of GET/PUT/clear against
 * the owner-gated host-ext route (the dialog's only data dependency).
 *
 * Every URL is asserted EXACTLY (a substring check passed `/budgets`); amounts are
 * non-whole (99.5 / 0.29) so a rounding or cent-drop would show; each of the three
 * calls must surface a non-OK status as its own typed error code.
 *
 * Sabotage that turns it red: a different path on any of the three; PUT a different
 * body; clear with anything but `{ dailyUsd: null }`; return the envelope instead of
 * `.budget`; swallow (or rename) any non-OK.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../client/config.js';
import { clearWorkflowBudget, getWorkflowBudget, putWorkflowBudget } from '../workflowsClient.js';

type FetchMock = ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;

function mockFetch(status: number, body: unknown): FetchMock {
  const fn = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const route = (encodedId: string): string => `${config.baseUrl}/host/openwop-app/workflows/${encodedId}/budget`;

afterEach(() => vi.unstubAllGlobals());

describe('workflow budget client (ADR 0482)', () => {
  it('getWorkflowBudget GETs the budget route and returns budget + spend', async () => {
    const fn = mockFetch(200, { budget: { dailyUsd: 99.5, hardCap: true, updatedAt: '2026-09-01T00:00:00.000Z' }, spentTodayUsd: 0.29 });
    const out = await getWorkflowBudget('wf/1');
    expect(out.budget?.dailyUsd).toBe(99.5);
    expect(out.spentTodayUsd).toBe(0.29);
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe(route('wf%2F1'));
    expect(init?.method ?? 'GET').toBe('GET');
  });

  it('putWorkflowBudget PUTs { dailyUsd, hardCap } and unwraps the budget', async () => {
    const fn = mockFetch(200, { budget: { dailyUsd: 99.5, hardCap: false, updatedAt: '2026-09-01T00:00:00.000Z' } });
    const out = await putWorkflowBudget('wf-2', { dailyUsd: 99.5, hardCap: false });
    expect(out).toEqual({ dailyUsd: 99.5, hardCap: false, updatedAt: '2026-09-01T00:00:00.000Z' });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe(route('wf-2'));
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual({ dailyUsd: 99.5, hardCap: false });
  });

  it('clearWorkflowBudget PUTs the explicit { dailyUsd: null } clear form', async () => {
    const fn = mockFetch(200, { budget: null, removed: true });
    await clearWorkflowBudget('wf-3');
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe(route('wf-3'));
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toEqual({ dailyUsd: null });
  });

  it('non-OK surfaces as a typed-ish error on every call (the dialog shows budgetSaveFailed)', async () => {
    mockFetch(403, { error: 'forbidden' });
    await expect(getWorkflowBudget('wf-4')).rejects.toThrow('budget_get_403');
    mockFetch(400, { error: 'validation_error' });
    await expect(putWorkflowBudget('wf-4', { dailyUsd: -1, hardCap: false })).rejects.toThrow('budget_put_400');
    mockFetch(500, { error: 'internal_error' });
    await expect(clearWorkflowBudget('wf-4')).rejects.toThrow('budget_clear_500');
  });
});
