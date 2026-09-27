import { describe, it, expect } from 'vitest';
import { translateInstallError } from '../src/features/marketplace/routes.js';
import { OpenwopError } from '../src/types.js';

const NAME = 'core.openwop.skills-bridge';
const VER = '1.0.0';

describe('translateInstallError', () => {
  it('a 404 manifest fetch → not_found (404) with a "not published" message, NOT a 500', () => {
    const e = translateInstallError(new Error(`manifest_fetch_failed (404): https://packs.openwop.dev/v1/packs/${NAME}/-/${VER}.json`), NAME, VER);
    expect(e).toBeInstanceOf(OpenwopError);
    expect(e.code).toBe('not_found');
    expect(e.httpStatus).toBe(404);
    expect(e.message).toContain("isn't published");
    expect(e.message).toContain(NAME);
  });

  it('a registry outage (5xx / tarball / signature fetch) → runner_unavailable (502)', () => {
    for (const m of ['manifest_fetch_failed (503): x', 'tarball_fetch_failed (500): x', 'signature_fetch_failed (502): x']) {
      const e = translateInstallError(new Error(m), NAME, VER);
      expect(e.code).toBe('runner_unavailable');
      expect(e.httpStatus).toBe(502);
    }
  });

  it('signature / integrity verification failures → validation_error (422)', () => {
    for (const m of ['pack_signature_invalid', 'pack_integrity_mismatch: expected a, got b', 'pack_signature_unverifiable: no key', 'unsupported_integrity_algorithm: md5']) {
      const e = translateInstallError(new Error(m), NAME, VER);
      expect(e.code).toBe('validation_error');
      expect(e.httpStatus).toBe(422);
    }
  });

  it('an unknown failure is mapped to a clear 502, never a bare 500', () => {
    const e = translateInstallError(new Error('boom'), NAME, VER);
    expect(e.httpStatus).toBe(502);
    expect(e.message).toContain('boom');
  });

  it('an existing OpenwopError passes through unchanged', () => {
    const orig = new OpenwopError('forbidden', 'nope', 403);
    expect(translateInstallError(orig, NAME, VER)).toBe(orig);
  });
});
