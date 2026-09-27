/**
 * ADR 0712 OQ4 — an explicit `credentialRef` named for ANOTHER vendor is refused before
 * the key leaves the process.
 *
 * The explicit rung trusted a node's own ref blindly: a Google key passed to an
 * Anthropic step was sent to Anthropic (the call failed upstream, but a third party had
 * already received a key it should never see). ADR 0712 Phase 2 routed the SPA around
 * this; this closes it at the resolver, for every caller.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { explicitRefNamesOtherProvider } from '../src/aiProviders/credentialRefLadder.js';
import { createAiProvidersAdapter } from '../src/aiProviders/aiProvidersHost.js';
import { openStorage } from '../src/storage/index.js';
import { setInvocationBackend } from '../src/executor/invocationLog.js';

const KNOWN = ['anthropic', 'openai', 'google', 'minimax', 'replicate', 'elevenlabs'];

describe('ADR 0712 OQ4 — explicitRefNamesOtherProvider (pure)', () => {
  it('names the other vendor for a mis-paired ref, in every host naming convention', () => {
    expect(explicitRefNamesOtherProvider('anthropic', 'google-work', KNOWN)).toBe('google');
    expect(explicitRefNamesOtherProvider('anthropic', 'byok:google', KNOWN)).toBe('google');
    expect(explicitRefNamesOtherProvider('openai', 'anthropic:prod', KNOWN)).toBe('anthropic');
    expect(explicitRefNamesOtherProvider('google', 'replicate', KNOWN)).toBe('replicate');
  });

  it('stays out of the way of everything that works today', () => {
    expect(explicitRefNamesOtherProvider('google', 'byok:google', KNOWN), 'own provider').toBeNull();
    expect(explicitRefNamesOtherProvider('google', 'my-key', KNOWN), 'provider-less name is the operator\'s choice').toBeNull();
    expect(explicitRefNamesOtherProvider('compat', 'openai:gateway', KNOWN), 'compat may take any vendor key').toBeNull();
    expect(explicitRefNamesOtherProvider('mock', 'google', KNOWN), 'mock never sends a key').toBeNull();
    expect(explicitRefNamesOtherProvider('anthropic', 'managed:openwop-free', KNOWN), 'managed refs never reach this rung').toBeNull();
    expect(explicitRefNamesOtherProvider('anthropic', undefined, KNOWN), 'no explicit ref').toBeNull();
    expect(explicitRefNamesOtherProvider('google', 'googleish', KNOWN), 'a prefix is not a provider').toBeNull();
  });
});

describe('ADR 0712 OQ4 — the adapter never sends a mis-paired key', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  async function adapterWith(secrets: Record<string, string>, sent: string[]) {
    setInvocationBackend(await openStorage('memory://'));
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      sent.push(String(init?.headers?.['x-goog-api-key'] ?? init?.headers?.['x-api-key'] ?? init?.headers?.authorization ?? ''));
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    return createAiProvidersAdapter({
      runId: `run-oq4-${Math.random().toString(36).slice(2, 8)}`, nodeId: 'n1', tenantId: 'oq4', attempt: 1,
      secrets, policyResolver: { async resolveForRun() { return []; } },
    });
  }

  it('refuses a Google-step call carrying an Anthropic key — typed, and nothing reaches fetch', async () => {
    const sent: string[] = [];
    const adapter = await adapterWith({ 'anthropic:prod': 'sk-ant-SECRET', 'byok:google': 'AIza-own' }, sent);
    const err = await adapter.callAI({ provider: 'google', model: 'gemini-2.5-flash', credentialRef: 'anthropic:prod', messages: [{ role: 'user', content: 'hi' }] })
      .then(() => null, (e: unknown) => e as { code?: string; details?: Record<string, unknown>; message?: string });
    expect(err?.code).toBe('byok_required_but_unresolved');
    expect(err?.details).toMatchObject({ reason: 'explicit_ref_wrong_provider', provider: 'google', refProvider: 'anthropic' });
    expect(err?.message ?? '').not.toContain('sk-ant-SECRET');
    expect(sent, 'the mis-paired key must never leave the process').toEqual([]);
  });

  it('still dispatches with the step\'s own key, and with a provider-less operator-named key', async () => {
    const sentOwn: string[] = [];
    const own = await adapterWith({ 'byok:google': 'AIza-own' }, sentOwn);
    await own.callAI({ provider: 'google', model: 'gemini-2.5-flash', credentialRef: 'byok:google', messages: [{ role: 'user', content: 'hi' }] }).catch(() => undefined);
    expect(sentOwn.length).toBeGreaterThan(0);
    expect(sentOwn.every((k) => k === 'AIza-own')).toBe(true);

    const sentNamed: string[] = [];
    const named = await adapterWith({ 'my-key': 'AIza-named' }, sentNamed);
    await named.callAI({ provider: 'google', model: 'gemini-2.5-flash', credentialRef: 'my-key', messages: [{ role: 'user', content: 'hi' }] }).catch(() => undefined);
    expect(sentNamed.length).toBeGreaterThan(0);
    expect(sentNamed.every((k) => k === 'AIza-named')).toBe(true);
  });
});
