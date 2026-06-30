/**
 * ADR 0088 run-stream-token — the two post-grade `/code-review` residuals:
 *   SEC-1 — the signing secret now reuses cookieSession's `readSessionSecret`, so minting
 *           fails CLOSED in production when `OPENWOP_SESSION_SECRET` is unset (was a silent
 *           ephemeral fallback — a defense-in-depth gap if a deploy ever decoupled streams
 *           from cookie mode).
 *   SEC-2 — a token rejection logs a coarse `reason` at DEBUG (the non-secret `runId` only,
 *           never the token/secret), so a stream 404 is diagnosable.
 */
import { vi } from 'vitest';
// Must run BEFORE the logger module initializes its level constant (hoisted above imports).
vi.hoisted(() => { process.env.OPENWOP_LOG_LEVEL = 'debug'; });

import { afterEach, describe, expect, it } from 'vitest';
import { mintRunStreamToken, verifyRunStreamToken } from '../src/host/runStreamToken.js';

describe('SEC-1 — signing secret fails closed in production', () => {
  const savedEnv = process.env.NODE_ENV;
  const savedSecret = process.env.OPENWOP_SESSION_SECRET;
  afterEach(() => {
    process.env.NODE_ENV = savedEnv;
    if (savedSecret === undefined) delete process.env.OPENWOP_SESSION_SECRET;
    else process.env.OPENWOP_SESSION_SECRET = savedSecret;
  });

  it('mint throws in production when OPENWOP_SESSION_SECRET is unset (no silent ephemeral secret)', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.OPENWOP_SESSION_SECRET;
    expect(() => mintRunStreamToken('run-A')).toThrow(/OPENWOP_SESSION_SECRET must be set in production/);
  });

  it('mint succeeds in production with a valid (≥32-char) secret', () => {
    process.env.NODE_ENV = 'production';
    process.env.OPENWOP_SESSION_SECRET = 'x'.repeat(40);
    const t = mintRunStreamToken('run-A');
    expect(verifyRunStreamToken('run-A', t)).toBe(true);
  });
});

describe('SEC-2 — token rejections log a debug reason without leaking the token', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs `run_stream_token_rejected` with a coarse reason and the runId only', () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      lines.push(typeof c === 'string' ? c : Buffer.from(c).toString());
      return true;
    });
    const t0 = 1_000_000_000_000;
    expect(verifyRunStreamToken('run-A', 'secrettokenvalue')).toBe(false);                 // malformed
    const expired = mintRunStreamToken('run-B', t0);
    expect(verifyRunStreamToken('run-B', expired, t0 + 2 * 3600_000)).toBe(false);         // expired
    spy.mockRestore();

    const out = lines.join('');
    expect(out).toContain('run_stream_token_rejected');
    expect(out).toContain('malformed');
    expect(out).toContain('expired');
    expect(out).toContain('run-A');
    expect(out).not.toContain('secrettokenvalue'); // the presented token is NEVER logged
  });
});
