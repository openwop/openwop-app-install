import { describe, it, expect, beforeEach } from 'vitest';
import { __persistConfigForTest as writeLs } from '../useBYOKConfig.js';

/**
 * Codifies the BYOK "ref-name-only" persistence invariant
 * (useBYOKConfig.ts header / threat-model-secret-leakage): the credential
 * VALUE must never reach localStorage — only the credentialRef name. The
 * whitelist in writeLs() guards against a future field on BYOKActiveConfig
 * (or an over-wide caller object) carrying plaintext through.
 */
const LS_KEY = 'openwop-app.byok.activeConfig';

describe('BYOK active-config persistence — ref-name-only invariant', () => {
  beforeEach(() => localStorage.clear());

  it('persists only provider/model/credentialRef', () => {
    writeLs({ provider: 'openai', model: 'gpt-4o', credentialRef: 'openai:default' });
    const raw = localStorage.getItem(LS_KEY)!;
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['credentialRef', 'model', 'provider']);
  });

  it('drops any plaintext secret a future regression might attach', () => {
    // Simulate a regression: an extra plaintext field on the persisted object.
    const leaky = {
      provider: 'openai',
      model: 'gpt-4o',
      credentialRef: 'openai:default',
      value: 'sk-PLAINTEXT-SECRET',
      apiKey: 'sk-ALSO-SECRET',
    };
    writeLs(leaky as never);
    const raw = localStorage.getItem(LS_KEY)!;
    expect(raw).not.toContain('sk-PLAINTEXT-SECRET');
    expect(raw).not.toContain('sk-ALSO-SECRET');
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['credentialRef', 'model', 'provider']);
  });

  it('clears the key when passed null', () => {
    writeLs({ provider: 'openai', model: 'gpt-4o', credentialRef: 'openai:default' });
    writeLs(null);
    expect(localStorage.getItem(LS_KEY)).toBeNull();
  });
});
