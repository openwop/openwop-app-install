/**
 * SCIM PATCH active-parsing — ADR 0002 Phase 4 / RFC 0050 §B (SCIM review
 * finding #2). A real IdP deactivate/reactivate MUST be parsed from every
 * RFC 7644 §3.5.2 PatchOp shape, not just the flat `{active}`: Okta and Azure AD
 * send the PATH-LESS `{op:'replace', value:{active:false}}`, which the first cut
 * ignored — so an IdP leaver PATCH 400'd and the user stayed active.
 *
 * Sabotage that turns it red: `authScim.ts`
 * `} else if (op.path === undefined || op.path === null) {` → `} else if (false) {`
 * (path-less case); `return value.toLowerCase() === 'true';` → `return value === 'true';`
 * (string-valued case).
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
