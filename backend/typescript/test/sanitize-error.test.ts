/**
 * Error-envelope sanitizer (DATA-6):
 *   - sanitizeForErrorMessage scrubs JWTs, provider-key prefixes, and long
 *     high-entropy substrings from VALUES.
 *   - sanitizeDetails walks nested objects/arrays and ALSO scrubs object KEY
 *     names — but keys use the high-signal-only rule so a legitimate long field
 *     name is NOT falsely redacted (a token-shaped key still is).
 *
 * SECURITY invariant `secret-leakage-error-envelope`: outputs are asserted
 * EXACTLY, so a replacement that appends the marker but keeps the secret fails.
 *
 * Sabotage witnessed red (8f grade-tests wave 2): the JWT rule removed
 * (`8fw2g3-san-jwt`), the high-entropy rule removed (`-san-entropy`), the
 * broad base64 rule applied to keys (`-san-keybroad`), the provider-key rule
 * dropped from keys (`-san-keyprov`), keys not walked (`-san-walkkey`), and
 * arrays not walked (`-san-walkarr`).
 */

import { describe, expect, it } from 'vitest';
import { sanitizeForErrorMessage, sanitizeKeyName, sanitizeDetails } from '../src/middleware/sanitize.js';

describe('sanitizeForErrorMessage (values)', () => {
  it('redacts a JWT', () => {
    const jwt = 'eyAbcdefgh.eyIjklmnop.SiGnAtUrE12345678';
    expect(sanitizeForErrorMessage(`token=${jwt}`)).toBe('token=<redacted:jwt>');
  });
  it('redacts a provider-key prefix and a long high-entropy blob', () => {
    expect(sanitizeForErrorMessage('key sk_abcdefghijklmno')).toBe('key <redacted:provider_key>');
    expect(sanitizeForErrorMessage('blob ' + 'A'.repeat(40))).toBe('blob <redacted:high-entropy>');
  });
});

describe('sanitizeKeyName (object keys — high-signal only)', () => {
  it('redacts a token-shaped key', () => {
    expect(sanitizeKeyName('sk_abcdefghijklmno')).toBe('<redacted:provider_key>');
  });
  it('does NOT redact a legitimate long field name (the false-positive the broad base64 rule would cause)', () => {
    const longName = 'a_very_long_but_legitimate_configuration_field_name';
    expect(longName.length).toBeGreaterThan(32);
    expect(sanitizeKeyName(longName)).toBe(longName);
  });
});

describe('sanitizeDetails (recursive, keys + values)', () => {
  it('scrubs values in nested objects/arrays and token-shaped keys, preserving structure + legit keys', () => {
    const input: Record<string, unknown> = {
      normalField: 'hello',
      a_very_long_but_legitimate_configuration_field_name: 'kept',
      sk_abcdefghijklmno: 'val',
      nested: { items: ['ok', 'sk_zyxwvutsrqponml'] },
    };
    const out = sanitizeDetails(input);
    // The whole output: legit keys preserved, the token-shaped key redacted (and
    // gone), the value inside the nested array redacted, structure kept.
    expect(out).toEqual({
      normalField: 'hello',
      a_very_long_but_legitimate_configuration_field_name: 'kept',
      '<redacted:provider_key>': 'val',
      nested: { items: ['ok', '<redacted:provider_key>'] },
    });
    expect(out).not.toHaveProperty('sk_abcdefghijklmno');
  });
});
