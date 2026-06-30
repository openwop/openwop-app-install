/**
 * ADR 0118 Phase 4 — the optional Langfuse OTLP sink config (no new dep; a 2nd OTLP
 * exporter on the same span tree). Asserts: configured ⇒ correct OTLP URL + Basic auth
 * from HOST-SIDE keys; missing any key ⇒ no sink; NO secret in the URL.
 */
import { describe, it, expect } from 'vitest';
import { langfuseSinkConfig } from '../src/observability/tracer.js';

const full = { OPENWOP_LANGFUSE_HOST: 'https://cloud.langfuse.com/', OPENWOP_LANGFUSE_PUBLIC_KEY: 'pk-123', OPENWOP_LANGFUSE_SECRET_KEY: 'sk-secret' } as NodeJS.ProcessEnv;

describe('langfuseSinkConfig', () => {
  it('builds the OTLP traces URL (trailing slash stripped) + Basic auth', () => {
    const cfg = langfuseSinkConfig(full)!;
    expect(cfg.url).toBe('https://cloud.langfuse.com/api/public/otel/v1/traces');
    expect(cfg.headers.Authorization).toBe(`Basic ${Buffer.from('pk-123:sk-secret').toString('base64')}`);
  });

  it('NEVER puts the secret (or key) in the URL', () => {
    const cfg = langfuseSinkConfig(full)!;
    expect(cfg.url).not.toContain('sk-secret');
    expect(cfg.url).not.toContain('pk-123');
  });

  it('returns null when ANY key is missing (no sink)', () => {
    expect(langfuseSinkConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(langfuseSinkConfig({ ...full, OPENWOP_LANGFUSE_SECRET_KEY: undefined } as NodeJS.ProcessEnv)).toBeNull();
    expect(langfuseSinkConfig({ ...full, OPENWOP_LANGFUSE_HOST: undefined } as NodeJS.ProcessEnv)).toBeNull();
  });
});
