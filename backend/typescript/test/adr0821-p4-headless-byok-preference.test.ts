/**
 * ADR 0821 D5 (corrected by architect #8) / P4 — headless TEXT calls honour the
 * tenant's BYOK key only when the tenant OPTED IN, default OFF.
 *
 * The opt-in rides the EXISTING tenant BYOK settings store — the ADR 0110
 * headless default row (`host:headlessAiDefault`, `PUT /byok/ai-default`) — as a
 * `preferForText` flag, not a new store.
 *
 * Pins:
 *   1. default (flag absent): a BYOK tenant's text call still goes to the managed
 *      provider (who pays does not change without consent);
 *   2. opted in: the text call goes to the tenant's own provider;
 *   3. opted in but the key no longer resolves: falls through to managed;
 *   4. the flag is validated (boolean only) and never set implicitly.
 *
 * Tracker TST-BUL-6. Sabotage-witnessed (w62): red when the opt-in check is
 * dropped or always-off, a stale key is dispatched anyway, a non-boolean flag is
 * accepted, or `preferForText: false` is persisted.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { setSecret, clearAllSecrets, removeSecret } from '../src/byok/secretResolver.js';
import { clearHeadlessAiDefault, getHeadlessAiDefault, resolveHeadlessAi, setHeadlessAiDefault } from '../src/host/headlessAi.js';

const NOW = '2026-10-05T00:00:00.000Z';
const T = 'tnt:headless-0821';
const MSG = [{ role: 'user' as const, content: 'translate' }];

let urls: string[] = [];

beforeEach(async () => {
  process.env.OPENWOP_BYOK_EPHEMERAL = 'true';
  await clearAllSecrets();
  initHostExtPersistence(await openStorage('memory://'));
  await clearHeadlessAiDefault(T);
  urls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hola' }] }, finishReason: 'STOP' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  await setSecret('gem', 'KEY', { tenantId: T });
});
afterEach(() => { vi.restoreAllMocks(); });
const prevEphemeral = process.env.OPENWOP_BYOK_EPHEMERAL;
afterAll(async () => {
  await clearAllSecrets();
  if (prevEphemeral === undefined) delete process.env.OPENWOP_BYOK_EPHEMERAL; else process.env.OPENWOP_BYOK_EPHEMERAL = prevEphemeral;
});

describe('ADR 0821 D5 — headless text BYOK preference is an opt-in', () => {
  it('default OFF: a tenant WITH a BYOK default still runs headless text on managed', async () => {
    await setHeadlessAiDefault({ tenantId: T }, { provider: 'google', model: 'gemini-2.0-flash', credentialRef: 'gem' }, NOW);
    expect((await getHeadlessAiDefault(T))?.preferForText).toBeUndefined();
    const dispatch = (await resolveHeadlessAi(T, 'text'))!;
    // The managed provider is not configured in this test, so the managed closure
    // fails WITHOUT any network call — proving the BYOK provider was not chosen.
    await expect(dispatch(MSG, { maxTokens: 50 })).rejects.toMatchObject({ name: 'ManagedProviderError' });
    expect(urls).toEqual([]);
  });

  it('opted in: headless text runs on the tenant\'s own provider', async () => {
    await setHeadlessAiDefault({ tenantId: T }, { provider: 'google', model: 'gemini-2.0-flash', credentialRef: 'gem', preferForText: true }, NOW);
    const dispatch = (await resolveHeadlessAi(T, 'text', { featureId: 'cms' }))!;
    await dispatch(MSG, { maxTokens: 50 }).catch(() => undefined); // the response shape is the dispatcher's concern; WHO was called is ours
    expect(urls.map((u) => new URL(u).host)).toContain('generativelanguage.googleapis.com');
  });

  it('opted in but the key no longer resolves: falls through to managed (never fails closed on a stale pointer)', async () => {
    await setHeadlessAiDefault({ tenantId: T }, { provider: 'google', model: 'gemini-2.0-flash', credentialRef: 'gem', preferForText: true }, NOW);
    await removeSecret('gem', { tenantId: T });
    const dispatch = (await resolveHeadlessAi(T, 'text'))!;
    await expect(dispatch(MSG, { maxTokens: 50 })).rejects.toMatchObject({ name: 'ManagedProviderError' });
    expect(urls).toEqual([]);
  });

  it('the flag is boolean-only and is not set unless asked for', async () => {
    await expect(setHeadlessAiDefault({ tenantId: T }, { provider: 'google', model: 'gemini-2.0-flash', credentialRef: 'gem', preferForText: 'yes' }, NOW))
      .rejects.toMatchObject({ httpStatus: 400, code: 'validation_error', details: { field: 'preferForText' } });
    const saved = await setHeadlessAiDefault({ tenantId: T }, { provider: 'google', model: 'gemini-2.0-flash', credentialRef: 'gem', preferForText: false }, NOW);
    expect('preferForText' in saved).toBe(false);
  });
});
