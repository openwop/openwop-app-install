/**
 * ADR 0889 grade remediation (A1, AEV-2) — `resolveHeadlessAiDescribed` names WHO a
 * headless dispatch calls, and `resolveHeadlessAi` (now a projection of it) still
 * makes the same choice on every rung of the ADR 0821 D5 ladder. The eval judge
 * records that identity on each verdict, so a regression can tell a judge change
 * from an agent change.
 *
 * Same fixture as `adr0821-p4-headless-byok-preference.test.ts`: `fetch` is spied,
 * so "who was called" is observed, not inferred.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { setSecret, clearAllSecrets, removeSecret } from '../src/byok/secretResolver.js';
import { clearHeadlessAiDefault, resolveHeadlessAi, resolveHeadlessAiDescribed, setHeadlessAiDefault } from '../src/host/headlessAi.js';
import { managedUnderlyingProvider, MANAGED_FREE_REF } from '../src/providers/managedProvider.js';
import { tenantEvalJudge } from '../src/host/workflowEvalJudge.js';

const NOW = '2026-10-05T00:00:00.000Z';
const T = 'tnt:headless-0889';
const MSG = [{ role: 'user' as const, content: 'judge' }];
const GOOGLE = { provider: 'google', model: 'gemini-2.0-flash', credentialRef: 'gem' };

let urls: string[] = [];

beforeEach(async () => {
  process.env.OPENWOP_BYOK_EPHEMERAL = 'true';
  await clearAllSecrets();
  initHostExtPersistence(await openStorage('memory://'));
  await clearHeadlessAiDefault(T);
  urls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'not a verdict' }] }, finishReason: 'STOP' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  await setSecret('gem', 'KEY', { tenantId: T });
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await clearAllSecrets(); process.env.OPENWOP_BYOK_EPHEMERAL = ''; });

describe('resolveHeadlessAiDescribed — the ladder, described; resolveHeadlessAi unchanged', () => {
  it('default OFF: managed is described, and resolveHeadlessAi still never calls the BYOK provider', async () => {
    await setHeadlessAiDefault({ tenantId: T }, GOOGLE, NOW);
    const d = (await resolveHeadlessAiDescribed(T, 'text'))!;
    expect(d).toMatchObject({ route: 'managed', provider: managedUnderlyingProvider(MANAGED_FREE_REF) });
    expect(d.model).toBeUndefined();
    await expect((await resolveHeadlessAi(T, 'text'))!(MSG, { maxTokens: 50 })).rejects.toMatchObject({ name: 'ManagedProviderError' });
    expect(urls).toEqual([]);
  });

  it('opted in: the BYOK provider and model are described, and that is who resolveHeadlessAi calls', async () => {
    await setHeadlessAiDefault({ tenantId: T }, { ...GOOGLE, preferForText: true }, NOW);
    expect(await resolveHeadlessAiDescribed(T, 'text')).toMatchObject({ route: 'byok-preferred', provider: 'google', model: 'gemini-2.0-flash' });
    await (await resolveHeadlessAi(T, 'text'))!(MSG, { maxTokens: 50 }).catch(() => undefined);
    expect(urls.some((u) => u.includes('generativelanguage.googleapis.com'))).toBe(true);
  });

  it('opted in with a dead key: both fall through to managed', async () => {
    await setHeadlessAiDefault({ tenantId: T }, { ...GOOGLE, preferForText: true }, NOW);
    await removeSecret('gem', { tenantId: T });
    expect((await resolveHeadlessAiDescribed(T, 'text'))?.route).toBe('managed');
    await expect((await resolveHeadlessAi(T, 'text'))!(MSG, { maxTokens: 50 })).rejects.toMatchObject({ name: 'ManagedProviderError' });
    expect(urls).toEqual([]);
  });

  it('the eval judge stamps the identity it actually dispatched to, even on a judge failure', async () => {
    await setHeadlessAiDefault({ tenantId: T }, { ...GOOGLE, preferForText: true }, NOW);
    const v = await tenantEvalJudge(T)({ criteria: 'is polite', output: 'hi', subject: 'agent' });
    expect(v).toMatchObject({ pass: false, failure: 'error', judge: { provider: 'google', model: 'gemini-2.0-flash' } });
  });
});
