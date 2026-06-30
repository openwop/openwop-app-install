/**
 * Headless AI default + resolver (ADR 0110 Phase 1). Service-level: set-time validation
 * (ref must be in the tenant's BYOK store, provider/model bounded) + the capability-aware,
 * cost-ordered `resolveHeadlessAi` (managed MiniMax is text-only ⇒ media needs a BYOK
 * default; modality-gated per provider). Uses ephemeral BYOK secrets + in-memory persistence.
 */
import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { setSecret, clearAllSecrets } from '../src/byok/secretResolver.js';
import { setHeadlessAiDefault, getHeadlessAiDefault, clearHeadlessAiDefault, resolveHeadlessAi } from '../src/host/headlessAi.js';

const NOW = '2026-06-23T00:00:00.000Z';
const T = 'tnt:headless';

describe('headless AI default (ADR 0110)', () => {
  beforeEach(async () => {
    process.env.OPENWOP_BYOK_EPHEMERAL = 'true';
    await clearAllSecrets();
    initHostExtPersistence(await openStorage('memory://'));
    await clearHeadlessAiDefault(T);
  });
  afterAll(async () => { await clearAllSecrets(); process.env.OPENWOP_BYOK_EPHEMERAL = ''; });

  it('rejects a default whose credentialRef is NOT in the tenant BYOK store (IDOR guard)', async () => {
    await expect(setHeadlessAiDefault({ tenantId: T }, { provider: 'google', model: 'gemini-2.0-flash', credentialRef: 'not-mine' }, NOW))
      .rejects.toMatchObject({ httpStatus: 400 });
  });

  it('rejects an unknown provider and an over-long model', async () => {
    await setSecret('gem', 'KEY', { tenantId: T });
    await expect(setHeadlessAiDefault({ tenantId: T }, { provider: 'cohere', model: 'x', credentialRef: 'gem' }, NOW)).rejects.toMatchObject({ httpStatus: 400 });
    await expect(setHeadlessAiDefault({ tenantId: T }, { provider: 'google', model: 'x'.repeat(200), credentialRef: 'gem' }, NOW)).rejects.toMatchObject({ httpStatus: 400 });
  });

  it('stores + round-trips a valid default', async () => {
    await setSecret('gem', 'KEY', { tenantId: T });
    const saved = await setHeadlessAiDefault({ tenantId: T }, { provider: 'google', model: 'gemini-2.0-flash', credentialRef: 'gem' }, NOW);
    expect(saved.provider).toBe('google');
    expect((await getHeadlessAiDefault(T))?.credentialRef).toBe('gem');
  });

  it('resolveHeadlessAi: managed (MiniMax) is text-only → null with no default; a closure with a capable default', async () => {
    expect(await resolveHeadlessAi(T, 'image')).toBeNull(); // managed can't, no default
    await setSecret('gem', 'KEY', { tenantId: T });
    await setHeadlessAiDefault({ tenantId: T }, { provider: 'google', model: 'gemini-2.0-flash', credentialRef: 'gem' }, NOW);
    expect(await resolveHeadlessAi(T, 'image')).toBeTypeOf('function'); // Gemini: vision
    expect(await resolveHeadlessAi(T, 'audio')).toBeTypeOf('function'); // Gemini: audio
  });

  it("resolveHeadlessAi('text'): managed always qualifies (OQ-C) — a closure even with NO default", async () => {
    // Every provider handles text, so the managed (MiniMax) provider resolves text directly —
    // this is what cms/translate now rides instead of a hardcoded managed dispatch.
    expect(await resolveHeadlessAi(T, 'text')).toBeTypeOf('function');
  });

  it('resolveHeadlessAi: gates on the default provider\'s modality (Anthropic has no audio)', async () => {
    await setSecret('cl', 'KEY', { tenantId: T });
    await setHeadlessAiDefault({ tenantId: T }, { provider: 'anthropic', model: 'claude-4', credentialRef: 'cl' }, NOW);
    expect(await resolveHeadlessAi(T, 'image')).toBeTypeOf('function'); // Anthropic: vision
    expect(await resolveHeadlessAi(T, 'audio')).toBeNull();             // Anthropic: no audio input
  });

  it('resolveHeadlessAi: returns null when the bound ref no longer resolves (ephemeral/expired)', async () => {
    await setSecret('gem', 'KEY', { tenantId: T });
    await setHeadlessAiDefault({ tenantId: T }, { provider: 'google', model: 'gemini-2.0-flash', credentialRef: 'gem' }, NOW);
    await clearAllSecrets(); // the key evaporates but the binding persists
    expect(await resolveHeadlessAi(T, 'image')).toBeNull(); // graceful — caller 422s
  });
});
