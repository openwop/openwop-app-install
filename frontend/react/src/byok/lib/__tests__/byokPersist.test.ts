import { describe, it, expect, beforeEach } from 'vitest';
import { __persistConfigForTest as writeLs, type BYOKActiveConfig } from '../useBYOKConfig.js';

/**
 * Codifies the BYOK "ref-name-only" persistence invariant
 * (useBYOKConfig.ts header / threat-model-secret-leakage): the credential
 * VALUE must never reach localStorage — only the credentialRef name. The
 * whitelist in writeLs() guards against a future field on BYOKActiveConfig
 * (or an over-wide caller object) carrying plaintext through.
 *
 * Sabotage that turns these red (useBYOKConfig.ts `writeLs`): serialising `cfg`
 * instead of the whitelisted `safe`; dropping a whitelisted field; not removing
 * the key on null.
 */
const LS_KEY = 'openwop-app.byok.activeConfig';

describe('BYOK active-config persistence — ref-name-only invariant', () => {
  beforeEach(() => localStorage.clear());

  it('persists only provider/model/credentialRef', () => {
    writeLs({ provider: 'openai', model: 'gpt-4o', credentialRef: 'openai:default' });
    const raw = localStorage.getItem(LS_KEY)!;
    expect(JSON.parse(raw)).toEqual({ provider: 'openai', model: 'gpt-4o', credentialRef: 'openai:default' });
  });

  it('drops any plaintext secret a future regression might attach', () => {
    // Simulate a regression: an extra plaintext field on the persisted object.
    const leaky: BYOKActiveConfig & { value: string; apiKey: string } = {
      provider: 'openai',
      model: 'gpt-4o',
      credentialRef: 'openai:default',
      value: 'sk-PLAINTEXT-SECRET',
      apiKey: 'sk-ALSO-SECRET',
    };
    writeLs(leaky);
    const raw = localStorage.getItem(LS_KEY)!;
    expect(raw).not.toContain('sk-PLAINTEXT-SECRET');
    expect(raw).not.toContain('sk-ALSO-SECRET');
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['credentialRef', 'model', 'provider']);
  });

  it('clears the key when passed null', () => {
    writeLs({ provider: 'openai', model: 'gpt-4o', credentialRef: 'openai:default' });
    expect(localStorage.getItem(LS_KEY)).not.toBeNull(); // the clear below has something to clear
    writeLs(null);
    expect(localStorage.getItem(LS_KEY)).toBeNull();
  });
});
