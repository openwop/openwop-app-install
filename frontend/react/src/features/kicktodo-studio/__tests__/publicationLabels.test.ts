/**
 * KTUX-16 — pubStateLabel maps the publication phase to a localized key and falls
 * back to the raw value for anything unknown (never a wrong label).
 */
import { describe, it, expect } from 'vitest';
import { pubStateLabel } from '../publicationLabels.js';

const key = (k: string): string => k; // passthrough "t" — returns the key it would look up

describe('pubStateLabel', () => {
  it('maps the known publication phases to their i18n keys', () => {
    expect(pubStateLabel('submitted', key)).toBe('kicktodo-studio:pubState_submitted');
    expect(pubStateLabel('completed', key)).toBe('kicktodo-studio:pubState_completed');
  });
  it('falls back to the raw value for an unknown phase', () => {
    expect(pubStateLabel('weird', key)).toBe('weird');
    expect(pubStateLabel('', key)).toBe('');
  });
});
