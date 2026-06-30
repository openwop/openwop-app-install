/**
 * Error-envelope sanitizer (DATA-6):
 *   - sanitizeForErrorMessage scrubs JWTs, provider-key prefixes, and long
 *     high-entropy substrings from VALUES.
 *   - sanitizeDetails walks nested objects/arrays and ALSO scrubs object KEY
 *     names — but keys use the high-signal-only rule so a legitimate long field
 *     name is NOT falsely redacted (a token-shaped key still is).
 */

import { describe, expect, it } from 'vitest';
import { sanitizeForErrorMessage, sanitizeKeyName, sanitizeDetails } from '../src/middleware/sanitize.js';

describe('sanitizeForErrorMessage (values)', () => {
  it('redacts a JWT', () => {
    const jwt = 'eyAbcdefgh.eyIjklmnop.SiGnAtUrE12345678';
    expect(sanitizeForErrorMessage(`token=${jwt}`)).toContain('<redacted:jwt>');
  });
  it('redacts a provider-key prefix and a long high-entropy blob', () => {
    expect(sanitizeForErrorMessage('key sk_abcdefghijklmno')).toContain('<redacted:provider_key>');
    expect(sanitizeForErrorMessage('blob ' + 'A'.repeat(40))).toContain('<redacted:high-entropy>');
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
    expect(out.normalField).toBe('hello');
    // legit long key preserved
    expect(out.a_very_long_but_legitimate_configuration_field_name).toBe('kept');
    // token-shaped key redacted
    expect(out['<redacted:provider_key>']).toBe('val');
    // value inside nested array redacted
    expect((out.nested as { items: string[] }).items[1]).toContain('<redacted:provider_key>');
  });
});
