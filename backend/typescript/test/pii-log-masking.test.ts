/**
 * ADR 0077 Phase 2 — PII log masking.
 *
 * The logger masks the VALUES of PII-named fields (registry + heuristic), as a
 * correlation-preserving `pii_<hash>` token — fields only (the msg string is not
 * masked), composed AFTER the secret scrub, default ON. NOTE: masking is only as
 * complete as the loaded module graph (the registry is populated by feature
 * services' declarePiiFields side-effects), so this test imports them explicitly.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import '../src/features/crm/contactsService.js'; // declares crm.contact → name,email
import '../src/features/users/usersService.js'; // declares users.user → email,displayName
import { createLogger } from '../src/observability/logger.js';
import { maskPiiValue, maskPiiDeep } from '../src/host/dataClassification.js';

function capture(stream: 'stdout' | 'stderr', fn: () => void): string {
  const lines: string[] = [];
  const spy = vi.spyOn(process[stream], 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  });
  try { fn(); } finally { spy.mockRestore(); }
  return lines.join('');
}

describe('ADR 0077 §2 — maskPiiValue / maskPiiDeep (unit)', () => {
  it('maskPiiValue is a stable pii_<10hex> token', () => {
    const a = maskPiiValue('jane@acme.com');
    expect(a).toMatch(/^pii_[0-9a-f]{10}$/);
    expect(maskPiiValue('jane@acme.com')).toBe(a); // deterministic / correlatable
    expect(maskPiiValue('john@acme.com')).not.toBe(a);
  });

  it('masks values under PII keys, leaves operational fields untouched', () => {
    const out = maskPiiDeep({ email: 'jane@acme.com', runId: 'run_1', count: 7 }) as Record<string, unknown>;
    expect(out.email).toMatch(/^pii_/);
    expect(out.runId).toBe('run_1');
    expect(out.count).toBe(7);
  });

  it('masks nested PII + heuristic catches an undeclared PII key; heuristic:false skips it', () => {
    const nested = maskPiiDeep({ contact: { email: 'a@b.com', stage: 'lead' } }) as { contact: Record<string, unknown> };
    expect(nested.contact.email).toMatch(/^pii_/);
    expect(nested.contact.stage).toBe('lead');
    // `ssn` is not declared anywhere, but the heuristic matches it.
    expect((maskPiiDeep({ ssn: '123-45-6789' }) as Record<string, unknown>).ssn).toMatch(/^pii_/);
    expect((maskPiiDeep({ ssn: '123-45-6789' }, { heuristic: false }) as Record<string, unknown>).ssn).toBe('123-45-6789');
  });

  it('GOV-6: cycle-safe — a self-referential payload short-circuits instead of stack-overflowing', () => {
    const cyclic: Record<string, unknown> = { email: 'jane@acme.com', stage: 'lead' };
    cyclic.self = cyclic; // direct cycle
    const child: Record<string, unknown> = { parent: undefined, ssn: '123-45-6789' };
    child.parent = cyclic;
    cyclic.child = child; // indirect cycle back to root

    let out: Record<string, unknown> = {};
    expect(() => { out = maskPiiDeep(cyclic) as Record<string, unknown>; }).not.toThrow();
    expect(out.email).toMatch(/^pii_/); // PII still masked on the way down
    expect(out.stage).toBe('lead'); // operational field still untouched
    expect(out.self).toBe('[Circular]'); // the cycle is broken, not recursed
    expect((out.child as Record<string, unknown>).parent).toBe('[Circular]');
    expect((out.child as Record<string, unknown>).ssn).toMatch(/^pii_/); // heuristic still fires before the cycle cut
  });

  it('GOV-6: a shared (non-cyclic) reference reached via two paths still masks on both', () => {
    const shared = { email: 'dup@acme.com' };
    const out = maskPiiDeep({ a: shared, b: shared }) as { a: Record<string, unknown>; b: Record<string, unknown> };
    expect(out.a.email).toMatch(/^pii_/);
    expect(out.b.email).toMatch(/^pii_/); // NOT '[Circular]' — a diamond is not a cycle
  });
});

describe('ADR 0077 §2 — logger integration', () => {
  afterEach(() => vi.restoreAllMocks());

  it('masks a PII field value in a log line (default ON), not the raw value', () => {
    const log = createLogger('test.pii');
    const out = capture('stdout', () => log.info('contact synced', { email: 'jane@acme.com' }));
    expect(out).not.toContain('jane@acme.com');
    expect(out).toMatch(/pii_[0-9a-f]{10}/);
  });

  it('leaves ordinary fields untouched (no over-masking)', () => {
    const log = createLogger('test.pii');
    const out = capture('stdout', () => log.info('run started', { runId: 'run_123', count: 7, ok: true }));
    expect(out).toContain('run_123');
    expect(out).toContain('"count":7');
  });

  it('composes with the secret scrub — neither plaintext secret nor plaintext PII survives', () => {
    const log = createLogger('test.pii');
    const out = capture('stdout', () => log.info('weird', { email: 'sk-abcdEFGH1234567890ijkl' }));
    expect(out).not.toContain('sk-abcdEFGH1234567890ijkl'); // secret scrubbed
    expect(out).toMatch(/pii_/); // then PII-masked (email key)
  });

  it('does NOT mask PII in the msg string (fields-only boundary)', () => {
    const log = createLogger('test.pii');
    const out = capture('stdout', () => log.info('emailing jane@acme.com now'));
    // The message is secret-scrubbed but NOT PII-masked (no key on a bare string).
    expect(out).toContain('jane@acme.com');
  });
});
