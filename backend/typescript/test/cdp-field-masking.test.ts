/**
 * CDP-F Phase 2 — data-plane field masking (ADR 0268). `maskRecordForRead` reuses
 * the entity PII registry to mask a record's declared PII field VALUES at a read
 * seam (the counterpart to the log-only maskPiiDeep), without over-masking
 * operational fields.
 */
import { describe, expect, it } from 'vitest';
import { declarePiiFields, maskRecordForRead } from '../src/host/dataClassification.js';

describe('CDP-F maskRecordForRead', () => {
  it('masks declared PII field values, leaves operational fields intact', () => {
    declarePiiFields('test.person', ['name', 'email', 'phone']);
    const masked = maskRecordForRead('test.person', {
      name: 'Ada Lovelace',
      email: 'ada@acme.test',
      phone: '+15551234567',
      stage: 'customer',
      contactId: 'crm:abc',
    });
    expect(masked.name).toMatch(/^pii_/);
    expect(masked.email).toMatch(/^pii_/);
    expect(masked.phone).toMatch(/^pii_/);
    // operational fields untouched
    expect(masked.stage).toBe('customer');
    expect(masked.contactId).toBe('crm:abc');
  });

  it('is deterministic (same value → same mask) and reversible-safe (no plaintext leak)', () => {
    declarePiiFields('test.person', ['email']);
    const a = maskRecordForRead('test.person', { email: 'ada@acme.test' });
    const b = maskRecordForRead('test.person', { email: 'ada@acme.test' });
    expect(a.email).toBe(b.email);
    expect(String(a.email)).not.toContain('ada@acme.test');
  });

  it('masks nothing for an entity with no declared PII fields', () => {
    const rec = { a: 'x', b: 'y@z.test' };
    expect(maskRecordForRead('test.unknown-entity', rec)).toEqual(rec);
  });
});
