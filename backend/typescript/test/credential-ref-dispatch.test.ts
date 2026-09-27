/**
 * ADR 0706 Phase-1 gate — the bound ref reaches the REAL dispatcher.
 *
 * The chain-backed e2e stubs `ctx.callAI` per node, so it proves the binding is
 * FORWARDED but never runs `resolveCredential` (review of #3889, finding 2). This
 * test drives the real AI adapter (`createAiProvidersAdapter`, the object the
 * executor wires as `ctx.callAI`) with only `dispatchChat` mocked at the network
 * edge, and asserts WHICH key left the process.
 *
 * Two Google keys are in the run's secret set. With the explicit ref the second
 * one must be used; without it the ladder's prefix rung takes the first. That
 * pair is what makes ADR 0706 §3.1 item 1 load-bearing: without passing the ref
 * explicitly, a tenant bound to `google:two` would dispatch on `google:one`.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sent: Array<{ provider: string; apiKey: string }> = [];
vi.mock('../src/providers/dispatch.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/providers/dispatch.js')>();
  return {
    ...original,
    dispatchChat: vi.fn(async (req: { provider: string; apiKey: string; model: string }) => {
      sent.push({ provider: req.provider, apiKey: req.apiKey });
      return { provider: req.provider, model: req.model, completion: '{"ok":true}', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' };
    }),
  };
});

const { openStorage } = await import('../src/storage/index.js');
const { setEventLogBackend } = await import('../src/executor/eventLog.js');
const { setInvocationBackend } = await import('../src/executor/invocationLog.js');
const { initHostExtPersistence } = await import('../src/host/hostExtPersistence.js');
const { initInMemorySurfaces } = await import('../src/host/inMemorySurfaces.js');
const { createHostAdapterSuite } = await import('../src/host/index.js');
const { createAiProvidersAdapter } = await import('../src/aiProviders/aiProvidersHost.js');

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const SECRETS = { 'google:one': 'gemini-key-ONE', 'google:two': 'gemini-key-TWO' };
let policyResolver: ReturnType<typeof createHostAdapterSuite>['providerPolicyResolver'];

beforeAll(async () => {
  const storage = await openStorage('memory://');
  setEventLogBackend(storage);
  setInvocationBackend(storage);
  initHostExtPersistence(storage);
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-credref-dispatch-')) });
  policyResolver = createHostAdapterSuite({ storage }).providerPolicyResolver;
});
beforeEach(() => { sent.length = 0; });

const call = async (nodeId: string, credentialRef?: string) => {
  const adapter = createAiProvidersAdapter({
    runId: `run-credref-${nodeId}`, nodeId, tenantId: 'tenant-credref', attempt: 1,
    secrets: { ...SECRETS }, policyResolver,
  });
  return adapter.callAI({
    provider: 'google', model: 'gemini-3.1-flash-lite',
    messages: [{ role: 'user', content: `probe ${nodeId}` }],
    ...(credentialRef ? { credentialRef } : {}),
  });
};

describe('ADR 0706 — the explicit ref decides which key leaves the process', () => {
  it('with credentialRef google:two, the second key is sent and hashed', async () => {
    const r = await call('explicit', 'google:two');
    expect(sent).toEqual([{ provider: 'google', apiKey: 'gemini-key-TWO' }]);
    expect(r.credentialRefHashed).toBe(sha256('google:two'));
  });

  it('without a ref, the prefix rung takes the FIRST key — the case the explicit ref exists to prevent', async () => {
    const r = await call('implicit');
    expect(sent).toEqual([{ provider: 'google', apiKey: 'gemini-key-ONE' }]);
    expect(r.credentialRefHashed).toBe(sha256('google:one'));
  });

  it('an explicit ref absent from the run secret set fails typed, never falls back', async () => {
    await expect(call('absent', 'google:gone')).rejects.toMatchObject({ code: 'byok_required_but_unresolved' });
    expect(sent).toEqual([]);
  });
});
