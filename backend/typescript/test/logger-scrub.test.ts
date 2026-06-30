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
