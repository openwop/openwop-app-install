/**
 * SCIM PATCH active-parsing (review finding #2). A real IdP deactivate/reactivate
 * MUST be parsed from every standard PatchOp shape, not just the flat `{active}`.
 */

import { describe, expect, it } from 'vitest';
import { readActive } from '../src/routes/authScim.js';

describe('readActive (RFC 7644 PatchOp shapes)', () => {
  it('flat body', () => {
    expect(readActive({ active: false })).toBe(false);
    expect(readActive({ active: true })).toBe(true);
  });

  it('path-targeted replace', () => {
    expect(readActive({ Operations: [{ op: 'replace', path: 'active', value: false }] })).toBe(false);
    expect(readActive({ Operations: [{ op: 'replace', path: 'active', value: 'True' }] })).toBe(true);
  });

  it('path-less replace with a value object (Okta/Azure AD) — finding #2', () => {
    expect(readActive({ Operations: [{ op: 'replace', value: { active: false } }] })).toBe(false);
    expect(readActive({ Operations: [{ op: 'replace', value: { active: true } }] })).toBe(true);
  });

  it('returns undefined when no active is present (route then 400s)', () => {
    expect(readActive({})).toBeUndefined();
    expect(readActive({ Operations: [{ op: 'replace', path: 'displayName', value: 'x' }] })).toBeUndefined();
  });
});
