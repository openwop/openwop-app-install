/**
 * CDP-F — label-based record access policy (ADR 0268). A confidential-pii entity is
 * `masked` for a caller without a PII-read grant, `full` otherwise; non-PII entities
 * are always `full`.
 */
import { describe, expect, it } from 'vitest';
import { declarePiiFields, classificationOf } from '../src/host/dataClassification.js';
import { resolveRecordAccess } from '../src/host/recordAccessPolicy.js';

describe('CDP-F resolveRecordAccess', () => {
  it('masks a confidential-pii entity for a caller without a grant', () => {
    declarePiiFields('test.person-acl', ['ssn', 'email']);
    expect(classificationOf('test.person-acl')).toBe('confidential-pii');
    expect(resolveRecordAccess('test.person-acl', false)).toBe('masked');
    expect(resolveRecordAccess('test.person-acl', true)).toBe('full');
  });

  it('serves a non-PII entity in full to anyone', () => {
    expect(resolveRecordAccess('test.no-pii-entity', false)).toBe('full');
    expect(resolveRecordAccess('test.no-pii-entity', true)).toBe('full');
  });
});
