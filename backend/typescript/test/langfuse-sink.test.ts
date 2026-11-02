/**
 * ADR 0118 Phase 4 — the optional Langfuse OTLP sink config (no new dep; a 2nd OTLP
 * exporter on the same span tree). Asserts: configured ⇒ correct OTLP URL + Basic auth
 * from HOST-SIDE keys; missing any key ⇒ no sink; NO secret in the URL.
 *
 * TST-DKD-1 (grade-tests wave 72). Expected values are literals (the Basic value is
 * base64 of `pk-123:sk-secret`, not recomputed). Red when (w72 probes): the trailing
 * slash is kept (lf-slash), a key reaches the URL (lf-url-secret), the auth pair is
 * wrong (lf-auth), or a missing PUBLIC key still yields a sink (lf-pub).
 */
import { describe, it, expect } from 'vitest';
import { langfuseSinkConfig } from '../src/observability/tracer.js';

const full: NodeJS.ProcessEnv = { OPENWOP_LANGFUSE_HOST: 'https://cloud.langfuse.com/', OPENWOP_LANGFUSE_PUBLIC_KEY: 'pk-123', OPENWOP_LANGFUSE_SECRET_KEY: 'sk-secret' };

describe('langfuseSinkConfig', () => {
  it('builds the OTLP traces URL (trailing slash stripped) + Basic auth', () => {
    expect(langfuseSinkConfig(full)).toStrictEqual({
      url: 'https://cloud.langfuse.com/api/public/otel/v1/traces',
      headers: { Authorization: 'Basic cGstMTIzOnNrLXNlY3JldA==' },
    });
  });

  it('NEVER puts the secret (or key) in the URL', () => {
    const cfg = langfuseSinkConfig(full)!;
    expect(cfg.url).not.toContain('sk-secret');
    expect(cfg.url).not.toContain('pk-123');
  });

  it('returns null when ANY key is missing (no sink)', () => {
    expect(langfuseSinkConfig({})).toBeNull();
    expect(langfuseSinkConfig({ ...full, OPENWOP_LANGFUSE_SECRET_KEY: undefined })).toBeNull();
    expect(langfuseSinkConfig({ ...full, OPENWOP_LANGFUSE_PUBLIC_KEY: undefined })).toBeNull();
    expect(langfuseSinkConfig({ ...full, OPENWOP_LANGFUSE_HOST: undefined })).toBeNull();
  });
});
