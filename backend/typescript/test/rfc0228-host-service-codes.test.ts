/**
 * RFC 0228 gap G3 — the per-service names v1 gave `ctx` rejections.
 *
 *  1. On the MAJOR-2 wire a storage rejection is the generic registered code
 *     plus `details.service` (and `details.reason` for a sandbox escape). The
 *     host code is untouched, because the major-1 suite still asserts it.
 *  2. The three ads-publish packs branch on BOTH spellings of a secrets
 *     rejection, so they run on either major.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { projectV2ErrorObject, v2EventErrorCode } from '../src/middleware/protocolVersion.js';

describe('storage rejections on the major-2 wire (RFC 0228 §Decisions)', () => {
  it('a sandbox escape is forbidden, with service and reason', () => {
    expect(v2EventErrorCode('path_outside_sandbox')).toBe('forbidden');
    expect(projectV2ErrorObject({ code: 'path_outside_sandbox', message: 'Path escapes tenant sandbox.' })).toEqual({
      code: 'forbidden', message: 'Path escapes tenant sandbox.',
      details: { service: 'fs', reason: 'path-outside-sandbox', hostCode: 'path_outside_sandbox' },
    });
  });

  it('a table schema violation is validation_error, with service', () => {
    expect(projectV2ErrorObject({ code: 'table_schema_violation', message: 'm' })).toEqual({
      code: 'validation_error', message: 'm',
      details: { service: 'tableStorage', hostCode: 'table_schema_violation' },
    });
  });

  it('details the failure already carries win over the defaults', () => {
    const out = projectV2ErrorObject({ code: 'path_outside_sandbox', message: 'm', details: { reason: 'symlink-escape', path: 'x' } }) as { details: Record<string, unknown> };
    expect(out.details).toEqual({ service: 'fs', reason: 'symlink-escape', path: 'x', hostCode: 'path_outside_sandbox' });
  });

  it('is stable when projected twice, and leaves other aliases without service details', () => {
    const once = projectV2ErrorObject({ code: 'path_outside_sandbox', message: 'm' });
    expect(projectV2ErrorObject(once)).toBe(once);
    expect((projectV2ErrorObject({ code: 'invalid_args', message: 'm' }) as { details: Record<string, unknown> }).details).toEqual({ hostCode: 'invalid_args' });
  });
});

type Mapped = { code: string; retryable: boolean };
/** The pack's own function, lifted from its source so the shipped text is what runs. */
function loadMapSecretError(pack: string): (err: unknown) => Mapped {
  const src = readFileSync(fileURLToPath(new URL(`../../../packs/vendor.myndhyve.ads-publish-${pack}/index.mjs`, import.meta.url)), 'utf8');
  const m = /function mapSecretError\(err\) \{\n[\s\S]*?\n\}\n/.exec(src);
  if (!m) throw new Error(`ads-publish-${pack}: mapSecretError not found`);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${m[0]}; return mapSecretError;`)() as (err: unknown) => Mapped;
}

describe.each(['google', 'meta', 'tiktok'])('ads-publish-%s maps a secrets rejection on either major', (pack) => {
  const map = loadMapSecretError(pack);
  const e = (code: string, reason?: string) => ({ code, details: { service: 'secrets', ...(reason ? { reason } : {}) } });

  it.each([
    ['secret_not_found', undefined, 'CREDENTIAL_NOT_FOUND', false],
    ['secret_access_denied', undefined, 'CREDENTIAL_ACCESS_DENIED', false],
    ['secret_expired', undefined, 'CREDENTIAL_EXPIRED', false],
    ['secret_revoked', undefined, 'CREDENTIAL_REVOKED', false],
    ['secret_quota_exhausted', undefined, 'CREDENTIAL_RESOLVE_FAILED', true],
    ['credential_not_found', undefined, 'CREDENTIAL_NOT_FOUND', false],
    ['credential_not_found', 'revoked', 'CREDENTIAL_REVOKED', false],
    ['credential_not_found', 'expired', 'CREDENTIAL_EXPIRED', false],
    ['credential_forbidden', undefined, 'CREDENTIAL_ACCESS_DENIED', false],
    ['rate_limited', undefined, 'CREDENTIAL_RESOLVE_FAILED', true],
    ['something_else', undefined, 'CREDENTIAL_RESOLVE_FAILED', false],
  ] as const)('%s (%s) → %s', (code, reason, expected, retryable) => {
    expect(map(e(code, reason))).toEqual({ code: expected, retryable });
  });

  it('the pack actually calls it (a mapping nobody reads is not a fix)', () => {
    const src = readFileSync(fileURLToPath(new URL(`../../../packs/vendor.myndhyve.ads-publish-${pack}/index.mjs`, import.meta.url)), 'utf8');
    expect(src.split('mapSecretError(err)').length - 1).toBeGreaterThanOrEqual(2);
    expect(src).not.toMatch(/err\?\.code === 'secret_/);
  });
});
