/**
 * The single-completion path (`dispatchReply`) retries a TRANSIENT provider
 * failure once, as the tool loop does.
 *
 * MEASURED 2026-10-03: Google answered `gemini-3.8-flash` with 503 "high demand"
 * for minutes, and every chat turn died on its first call. The tool loop's
 * wrapper is unit-tested in conversation-tool-loop-429-retry.test.ts; this
 * drives the OTHER seam (group-room advisor turns and every non-tool reply)
 * through the real function, with only the network and the key stubbed.
 *
 * What breaks it: dropping the retry (case 1), retrying a permanent error
 * (case 2), or retrying more than ONCE — a retry that recursed into itself
 * passed case 1, whose fixture fails only once (8fw3g1-rty-once, round-1
 * vacuous); case 3 fails twice and pins exactly two calls.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
let failures: Error[] = [];
vi.mock('../src/providers/dispatch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/dispatch.js')>();
  return {
    ...actual,
    dispatchChat: vi.fn(async (req: { model: string }) => {
      calls.push(req.model);
      const next = failures.shift();
      if (next) throw next;
      return { completion: 'answered', usage: { inputTokens: 1, outputTokens: 1 } };
    }),
  };
});
vi.mock('../src/byok/secretResolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/byok/secretResolver.js')>();
  return { ...actual, resolveSecret: vi.fn(async () => 'test-key') };
});

import { dispatchReply } from '../src/host/exchange/dispatchTurn.js';
import type { RunRecord } from '../src/types.js';

const run: RunRecord = {
  runId: 'r',
  workflowId: 'wf-retry',
  tenantId: 'tenant-retry',
  status: 'running',
  inputs: { provider: 'google', model: 'gemini-3.8-flash', credentialRef: 'byok:k' },
  metadata: {},
  configurable: {},
  createdAt: '2026-10-03T00:00:00.000Z',
  updatedAt: '2026-10-03T00:00:00.000Z',
};

let saved: string | undefined;
let reset: () => void = () => {};
beforeAll(async () => {
  saved = process.env.OPENWOP_PROVIDER_429_RETRY_MS;
  process.env.OPENWOP_PROVIDER_429_RETRY_MS = '1';
  const { initHostExtPersistence, __resetHostExtPersistence } = await import('../src/host/hostExtPersistence.js');
  const { openStorage } = await import('../src/storage/index.js');
  initHostExtPersistence(await openStorage('memory://'));
  reset = __resetHostExtPersistence;
});
afterAll(() => {
  if (saved === undefined) delete process.env.OPENWOP_PROVIDER_429_RETRY_MS; else process.env.OPENWOP_PROVIDER_429_RETRY_MS = saved;
  reset();
});

describe('dispatchReply — one retry on a transient provider failure', () => {
  it('a 503 "high demand" is retried once and the turn succeeds', async () => {
    calls.length = 0;
    failures = [new Error('google_503: This model is currently experiencing high demand.')];
    const out = await dispatchReply(run, [{ role: 'user', content: 'hi' }]);
    expect(out.completion).toContain('answered');
    expect(calls).toEqual(['gemini-3.8-flash', 'gemini-3.8-flash']);
  });

  it('a permanent failure (400) is not retried', async () => {
    calls.length = 0;
    failures = [new Error('google_400: bad request')];
    await expect(dispatchReply(run, [{ role: 'user', content: 'hi' }])).rejects.toThrow(/google_400/);
    expect(calls).toHaveLength(1);
  });

  it('a second consecutive 503 is NOT retried again: exactly two calls, then the error surfaces', async () => {
    calls.length = 0;
    failures = [
      new Error('google_503: This model is currently experiencing high demand.'),
      new Error('google_503: still busy'),
      new Error('google_503: a third failure a recursing retry would reach'),
    ];
    await expect(dispatchReply(run, [{ role: 'user', content: 'hi' }])).rejects.toThrow('google_503: still busy');
    expect(calls).toEqual(['gemini-3.8-flash', 'gemini-3.8-flash']);
    failures = [];
  });
});
