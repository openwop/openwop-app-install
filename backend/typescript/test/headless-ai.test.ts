/**
 * Headless AI default + resolver (ADR 0110 Phase 1). Service-level: set-time validation
 * (ref must be in the tenant's BYOK store, provider/model bounded) + the capability-aware,
 * cost-ordered `resolveHeadlessAi` (managed MiniMax is text-only ⇒ media needs a BYOK
 * default; modality-gated per provider). Uses ephemeral BYOK secrets + in-memory persistence.
 *
 * The IDOR claim is held by TWO guards in `validateHeadlessSpec`, both 400: (1) the ref
 * must be one of THIS tenant's stored refs (`listSecretRefs`), (2) it must resolve now
 * (`resolveSecret`, scoped). Each is reached on its own here and told apart by its message:
 * a ref that exists only in ANOTHER tenant meets guard 1; a ref this tenant stores but
 * that resolves to nothing meets guard 2.
 *
 * Tracker TST-DFA-2. Red when (w71g1, witnessed): the stored-ref membership check or the
 * resolve check is dropped; the provider allowlist or the 100-char model bound is dropped;
 * Anthropic is marked audio-capable; the managed step skips its modality check; an
 * unresolvable bound key still returns a dispatch.
 */
import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { setSecret, clearAllSecrets } from '../src/byok/secretResolver.js';
import {
  setHeadlessAiDefault, getHeadlessAiDefault, clearHeadlessAiDefault, resolveHeadlessAi, resolveHeadlessAiDescribed,
} from '../src/host/headlessAi.js';

const NOW = '2026-06-23T00:00:00.000Z';
const T = 'tnt:headless';
const OTHER = 'tnt:headless-other';
const PRIOR_EPHEMERAL = process.env.OPENWOP_BYOK_EPHEMERAL;

const NOT_STORED = 'credentialRef is not a stored BYOK secret for this workspace.';
const NOT_RESOLVING = 'credentialRef does not currently resolve to a usable key.';

describe('headless AI default (ADR 0110)', () => {
  beforeEach(async () => {
    process.env.OPENWOP_BYOK_EPHEMERAL = 'true';
    await clearAllSecrets();
    initHostExtPersistence(await openStorage('memory://'));
    await clearHeadlessAiDefault(T);
    await clearHeadlessAiDefault(OTHER);
  });
  afterAll(async () => {
    await clearAllSecrets();
    if (PRIOR_EPHEMERAL === undefined) delete process.env.OPENWOP_BYOK_EPHEMERAL;
    else process.env.OPENWOP_BYOK_EPHEMERAL = PRIOR_EPHEMERAL;
  });

  it('rejects a default whose credentialRef is NOT in the tenant BYOK store (IDOR guard)', async () => {
    // The ref EXISTS — in another tenant. Positive control: its owner may bind it.
    await setSecret('theirs', 'KEY', { tenantId: OTHER });
    await expect(setHeadlessAiDefault({ tenantId: OTHER }, { provider: 'google', model: 'gemini-2.0-flash', credentialRef: 'theirs' }, NOW))
      .resolves.toMatchObject({ tenantId: OTHER, credentialRef: 'theirs' });
    // Guard 1 (stored-ref membership) refuses it for T, with its own message.
    await expect(setHeadlessAiDefault({ tenantId: T }, { provider: 'google', model: 'gemini-2.0-flash', credentialRef: 'theirs' }, NOW))
      .rejects.toMatchObject({ httpStatus: 400, code: 'validation_error', message: NOT_STORED });
    expect(await getHeadlessAiDefault(T)).toBeNull();
  });

  it('rejects a stored ref that does not resolve to a usable key (the second guard)', async () => {
    await setSecret('blank', '', { tenantId: T }); // listed for T, resolves to nothing
    await expect(setHeadlessAiDefault({ tenantId: T }, { provider: 'google', model: 'gemini-2.0-flash', credentialRef: 'blank' }, NOW))
      .rejects.toMatchObject({ httpStatus: 400, code: 'validation_error', message: NOT_RESOLVING });
  });

  it('rejects an unknown provider and an over-long model', async () => {
    await setSecret('gem', 'KEY', { tenantId: T });
    await expect(setHeadlessAiDefault({ tenantId: T }, { provider: 'cohere', model: 'x', credentialRef: 'gem' }, NOW))
      .rejects.toMatchObject({ httpStatus: 400, code: 'validation_error', message: 'provider MUST be one of: anthropic, openai, google.' });
    // One past the 100-char bound; exactly 100 is accepted.
    await expect(setHeadlessAiDefault({ tenantId: T }, { provider: 'google', model: 'x'.repeat(101), credentialRef: 'gem' }, NOW))
      .rejects.toMatchObject({ httpStatus: 400, code: 'validation_error', message: 'model MUST be a non-empty string ≤ 100 chars.' });
    await expect(setHeadlessAiDefault({ tenantId: T }, { provider: 'google', model: 'x'.repeat(100), credentialRef: 'gem' }, NOW))
      .resolves.toMatchObject({ model: 'x'.repeat(100) });
  });

  it('stores + round-trips a valid default', async () => {
    await setSecret('gem', 'KEY', { tenantId: T });
    const saved = await setHeadlessAiDefault({ tenantId: T }, { provider: 'google', model: 'gemini-2.0-flash', credentialRef: 'gem' }, NOW);
    expect(saved.provider).toBe('google');
    expect(await getHeadlessAiDefault(T)).toMatchObject({ provider: 'google', model: 'gemini-2.0-flash', credentialRef: 'gem' });
  });

  it('resolveHeadlessAi: managed (MiniMax) is text-only → null with no default; a closure with a capable default', async () => {
    expect(await resolveHeadlessAi(T, 'image')).toBeNull(); // managed can't, no default
    await setSecret('gem', 'KEY', { tenantId: T });
    await setHeadlessAiDefault({ tenantId: T }, { provider: 'google', model: 'gemini-2.0-flash', credentialRef: 'gem' }, NOW);
    expect(await resolveHeadlessAi(T, 'image')).toBeTypeOf('function'); // Gemini: vision
    expect(await resolveHeadlessAi(T, 'audio')).toBeTypeOf('function'); // Gemini: audio
    // And the rung that answered is the tenant's BYOK default, not managed.
    expect(await resolveHeadlessAiDescribed(T, 'image')).toMatchObject({ route: 'byok-default', provider: 'google', model: 'gemini-2.0-flash' });
  });

  it("resolveHeadlessAi('text'): managed always qualifies (OQ-C) — a closure even with NO default", async () => {
    // Every provider handles text, so the managed (MiniMax) provider resolves text directly —
    // this is what cms/translate now rides instead of a hardcoded managed dispatch.
    expect(await resolveHeadlessAi(T, 'text')).toBeTypeOf('function');
    expect(await resolveHeadlessAiDescribed(T, 'text')).toMatchObject({ route: 'managed' });
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
    expect(await getHeadlessAiDefault(T)).toMatchObject({ credentialRef: 'gem' });
    expect(await resolveHeadlessAi(T, 'image')).toBeNull(); // graceful — caller 422s
  });
});
