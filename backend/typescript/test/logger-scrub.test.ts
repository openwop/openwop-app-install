/**
 * SEC-8 — global log-sink scrubber. The structured logger runs every emitted
 * `msg` + `fields` value through the BYOK free-text scrubber before writing, so
 * a secret-shaped token that slips past call-site redaction can never reach
 * stdout/stderr verbatim. Also verifies emit() never throws into its caller on
 * a malformed (circular) field.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/observability/logger.js';

function capture(stream: 'stdout' | 'stderr', fn: () => void): string {
  const lines: string[] = [];
  const spy = vi.spyOn(process[stream], 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines.join('');
}

describe('logger SEC-8 scrubber', () => {
  afterEach(() => vi.restoreAllMocks());

  it('redacts a secret-shaped value passed in a structured field', () => {
    const log = createLogger('test.scrub');
    const out = capture('stdout', () => log.info('provider call failed', { rejectedKey: 'sk-abcdEFGH1234567890ijkl' }));
    expect(out).not.toContain('sk-abcdEFGH1234567890ijkl');
    expect(out).toContain('sk-***');
  });

  it('redacts a secret embedded in a nested field', () => {
    const log = createLogger('test.scrub');
    const out = capture('stdout', () => log.warn('upstream', { detail: { auth: 'Bearer abcdEFGH1234567890ijklmnop' } }));
    expect(out).not.toContain('Bearer abcdEFGH1234567890ijklmnop');
    expect(out).toContain('Bearer ***');
  });

  it('redacts a secret accidentally interpolated into the message', () => {
    const log = createLogger('test.scrub');
    const out = capture('stderr', () => log.error('token xai-abcdEFGH1234567890ijkl was rejected'));
    expect(out).not.toContain('xai-abcdEFGH1234567890ijkl');
    expect(out).toContain('xai-***');
  });

  it('leaves ordinary fields untouched', () => {
    const log = createLogger('test.scrub');
    const out = capture('stdout', () => log.info('run started', { runId: 'run_123', count: 7, ok: true }));
    expect(out).toContain('run_123');
    expect(out).toContain('"count":7');
    expect(out).toContain('"ok":true');
  });

  it('never throws into the caller on a malformed (circular) field', () => {
    const log = createLogger('test.scrub');
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular; // JSON.stringify would throw on this
    let out = '';
    expect(() => {
      out = capture('stdout', () => log.info('cyclic field', { circular }));
    }).not.toThrow();
    expect(out).toContain('test.scrub');
    expect(out).toContain('cyclic field');
    expect(out).toContain('logFieldsError');
  });
});

/**
 * ADR 0733 — the SINK WIRING. `adr0733-log-pii-value-shape.test.ts` proves the
 * `maskPiiDeep` mechanism, but it never constructs a logger: review finding 5 measured
 * that deleting `values: MASK_PII_VALUES` from `logger.ts` left all of its tests green.
 * These three tests are the ones that red when the wiring goes, not the mechanism.
 */
describe('ADR 0733 — value-shaped PII actually reaches the sink masked', () => {
  afterEach(() => vi.restoreAllMocks());

  it('masks an address embedded in an operational field on the way to stdout', () => {
    const log = createLogger('test.pii');
    const out = capture('stdout', () => log.info('insert failed', { error: 'unique violation: alice@example.com' }));
    expect(out).not.toContain('alice@example.com');
    expect(out).toMatch(/pii_[0-9a-f]{10}/);
    expect(out).toContain('unique violation:'); // substring-scoped — the rest still debuggable
  });

  it('masks it in the emit() CATCH branch too — the line that bypasses scrubFields', () => {
    const log = createLogger('test.pii');
    const boom = { toJSON() { throw new Error('row alice@example.com failed'); } };
    const out = capture('stdout', () => log.info('write failed', { row: boom }));
    expect(out).toContain('logFieldsError'); // we really took the fallback path
    expect(out).not.toContain('alice@example.com');
    expect(out).toMatch(/pii_[0-9a-f]{10}/);
  });

  it('OPENWOP_LOG_MASK_PII_VALUES=off returns the address — the flag is real, not decorative', async () => {
    const prev = process.env.OPENWOP_LOG_MASK_PII_VALUES;
    process.env.OPENWOP_LOG_MASK_PII_VALUES = 'off';
    vi.resetModules(); // the flag is read once at module load
    try {
      const { createLogger: freshLogger } = await import('../src/observability/logger.js');
      const log = freshLogger('test.pii');
      const out = capture('stdout', () => log.info('insert failed', { error: 'unique violation: alice@example.com' }));
      expect(out).toContain('alice@example.com');
    } finally {
      if (prev === undefined) delete process.env.OPENWOP_LOG_MASK_PII_VALUES;
      else process.env.OPENWOP_LOG_MASK_PII_VALUES = prev;
      vi.resetModules();
    }
  });
});
