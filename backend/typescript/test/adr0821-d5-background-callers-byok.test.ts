/**
 * ADR 0821 D5 follow-up — the two BACKGROUND text callers (chat auto-title,
 * memory extraction) honour the tenant's `preferForText` opt-in through the SAME
 * resolver every other headless text caller uses (`host/headlessAi.ts`
 * `resolveHeadlessAi`), instead of calling `dispatchManagedChat` directly.
 *
 * Pins:
 *   1. opt-in OFF (default): unchanged — the managed provider is called, with the
 *      ADR 0821 D4 attribution (`chat-autotitle` / `memory-auto-extract`) and, for
 *      extraction, the ADR 0721 acting subject;
 *   2. opt-in ON + a usable BYOK key: the tenant's provider is called and
 *      `dispatchManagedChat` (the ONLY door into the managed meter + the D4
 *      attribution write) is never reached — so no managed draw, no usage row;
 *   3. opt-in ON but the key no longer resolves: falls through to managed, metered
 *      (the resolver's existing step-0 posture);
 *   4. opt-in ON and the tenant's provider ERRORS: the background task is skipped
 *      (title → null placeholder, extraction → no facts) and managed is NOT tried —
 *      the tenant chose its own key; a silent managed retry would bill it anyway.
 *   5. auto-title runs on the provider's catalog `quick` class model, not on the
 *      binding's (possibly adaptive-thinking, 24-token-starved) chat model.
 *
 * RED witness: pins 2, 4 and 5 fail against the pre-change callers (they always
 * called `dispatchManagedChat`).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/providers/managedProvider.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/providers/managedProvider.js')>();
  return { ...original, dispatchManagedChat: vi.fn(async () => ({ provider: 'openwop-free', model: 'openwop-free', completion: 'Managed Title' })) };
});

import { dispatchManagedChat } from '../src/providers/managedProvider.js';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { setSecret, clearAllSecrets, removeSecret } from '../src/byok/secretResolver.js';
import { clearHeadlessAiDefault, setHeadlessAiDefault } from '../src/host/headlessAi.js';
import { getClassDefault } from '../src/providers/catalog.js';
import { generateTitle } from '../src/features/chat-autotitle/titleGenerator.js';
import { llmExtractFacts } from '../src/features/memory-auto-extract/memoryExtractor.js';

const NOW = '2026-10-05T00:00:00.000Z';
const T = 'tnt:d5-background';
const BOUND_MODEL = 'gemini-3.8-flash';

let urls: string[] = [];
let googleStatus = 200;
let googleText = 'Trip Planning';

function sse(text: string): Response {
  const chunk = { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 } };
  return new Response(`data: ${JSON.stringify(chunk)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

beforeEach(async () => {
  process.env.OPENWOP_BYOK_EPHEMERAL = 'true';
  await clearAllSecrets();
  initHostExtPersistence(await openStorage('memory://'));
  await clearHeadlessAiDefault(T);
  urls = [];
  googleStatus = 200;
  googleText = 'Trip Planning';
  vi.mocked(dispatchManagedChat).mockClear();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (googleStatus !== 200) {
      return new Response(JSON.stringify({ error: { code: googleStatus, message: 'API key not valid', status: 'UNAUTHENTICATED' } }), { status: googleStatus, headers: { 'content-type': 'application/json' } });
    }
    return sse(googleText);
  });
  await setSecret('gem', 'KEY', { tenantId: T });
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await clearAllSecrets(); process.env.OPENWOP_BYOK_EPHEMERAL = ''; });

const bind = (preferForText?: boolean) => setHeadlessAiDefault(
  { tenantId: T },
  { provider: 'google', model: BOUND_MODEL, credentialRef: 'gem', ...(preferForText !== undefined ? { preferForText } : {}) },
  NOW,
);
const googleCalls = () => urls.filter((u) => u.includes('generativelanguage.googleapis.com'));

describe('ADR 0821 D5 — chat auto-title honours the BYOK text opt-in', () => {
  it('opt-in OFF (default): stays on managed, attributed to chat-autotitle', async () => {
    await bind();
    expect(await generateTitle(T, 'plan a trip', 'sure')).toBe('Managed Title');
    expect(vi.mocked(dispatchManagedChat)).toHaveBeenCalledTimes(1);
    const req = vi.mocked(dispatchManagedChat).mock.calls[0]![0];
    expect(req).toMatchObject({ tenantId: T, featureId: 'chat-autotitle' });
    expect(req.signal, 'the ATC-2 wall-clock bound must still reach the managed dispatch').toBeInstanceOf(AbortSignal);
    expect(googleCalls()).toEqual([]);
  });

  it('no BYOK binding at all: managed, attributed (the common tenant)', async () => {
    expect(await generateTitle(T, 'plan a trip', 'sure')).toBe('Managed Title');
    expect(vi.mocked(dispatchManagedChat).mock.calls[0]![0]).toMatchObject({ featureId: 'chat-autotitle' });
  });

  it('opt-in ON + usable key: the tenant key is called on its quick model, managed is never reached', async () => {
    await bind(true);
    expect(await generateTitle(T, 'plan a trip', 'sure')).toBe('Trip Planning');
    expect(vi.mocked(dispatchManagedChat), 'a managed dispatch = a managed draw + usage increment on a tenant that opted out of it').not.toHaveBeenCalled();
    const quick = getClassDefault('google', 'quick');
    expect(quick, 'providers.json must declare a google `quick` class default').toBeTruthy();
    expect(googleCalls()).toHaveLength(1);
    expect(googleCalls()[0]).toContain(`/models/${quick}:`);
    expect(googleCalls()[0]).not.toContain(BOUND_MODEL);
  });

  it('opt-in ON but the key no longer resolves: falls back to managed, metered', async () => {
    await bind(true);
    await removeSecret('gem', { tenantId: T });
    expect(await generateTitle(T, 'plan a trip', 'sure')).toBe('Managed Title');
    expect(vi.mocked(dispatchManagedChat).mock.calls[0]![0]).toMatchObject({ featureId: 'chat-autotitle' });
    expect(googleCalls()).toEqual([]);
  });

  it('opt-in ON and the tenant provider errors: no title (placeholder), never throws, managed NOT tried', async () => {
    await bind(true);
    googleStatus = 401;
    await expect(generateTitle(T, 'plan a trip', 'sure')).resolves.toBeNull();
    expect(googleCalls().length).toBeGreaterThanOrEqual(1);
    expect(vi.mocked(dispatchManagedChat)).not.toHaveBeenCalled();
  });
});

describe('ADR 0821 D5 — memory extraction honours the BYOK text opt-in', () => {
  it('opt-in OFF (default): stays on managed, attributed + metered to the acting subject', async () => {
    await bind(false);
    vi.mocked(dispatchManagedChat).mockResolvedValueOnce({ provider: 'openwop-free', model: 'openwop-free', completion: 'Prefers dark mode' });
    expect(await llmExtractFacts(T, 'I like dark mode', 'user:alice')).toEqual(['Prefers dark mode']);
    expect(vi.mocked(dispatchManagedChat).mock.calls[0]![0]).toMatchObject({ tenantId: T, featureId: 'memory-auto-extract', actingSubject: 'user:alice' });
    expect(googleCalls()).toEqual([]);
  });

  it('opt-in ON + usable key: the tenant key is called on its bound model, managed is never reached', async () => {
    await bind(true);
    googleText = 'Prefers dark mode\nWorks at Acme';
    expect(await llmExtractFacts(T, 'I like dark mode, I work at Acme', 'user:alice')).toEqual(['Prefers dark mode', 'Works at Acme']);
    expect(vi.mocked(dispatchManagedChat)).not.toHaveBeenCalled();
    expect(googleCalls()).toHaveLength(1);
    expect(googleCalls()[0]).toContain(`/models/${BOUND_MODEL}:`);
  });

  it('opt-in ON but the key no longer resolves: falls back to managed, metered to the subject', async () => {
    await bind(true);
    await removeSecret('gem', { tenantId: T });
    vi.mocked(dispatchManagedChat).mockResolvedValueOnce({ provider: 'openwop-free', model: 'openwop-free', completion: 'NONE' });
    expect(await llmExtractFacts(T, 'hello', 'user:alice')).toEqual([]);
    expect(vi.mocked(dispatchManagedChat).mock.calls[0]![0]).toMatchObject({ featureId: 'memory-auto-extract', actingSubject: 'user:alice' });
  });

  it('opt-in ON and the tenant provider errors: no facts, never throws, managed NOT tried', async () => {
    await bind(true);
    googleStatus = 401;
    await expect(llmExtractFacts(T, 'I like dark mode', 'user:alice')).resolves.toEqual([]);
    expect(vi.mocked(dispatchManagedChat)).not.toHaveBeenCalled();
  });
});
