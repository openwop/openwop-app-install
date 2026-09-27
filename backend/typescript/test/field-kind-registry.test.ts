/**
 * Field-kind validator registry (ADR 0408 D2) — the seam's pluggable-kind
 * inversion: extension kinds register from features; built-ins are
 * non-overridable; duplicates rejected; registered kinds are NOT
 * authoring-visible (FIELD_TYPES stays the closed built-in vocabulary).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  FIELD_TYPES,
  buildFieldSpec,
  getFieldKindValidator,
  registerFieldKindValidator,
  __unregisterFieldKindValidator,
} from '../src/host/customFields/index.js';

afterEach(() => __unregisterFieldKindValidator('blocks-test'));

describe('field-kind validator registry (ADR 0408 D2)', () => {
  it('registers an extension kind and resolves it', () => {
    const v = { validate: (x: unknown) => x };
    registerFieldKindValidator('blocks-test', v);
    expect(getFieldKindValidator('blocks-test')).toBe(v);
    expect(getFieldKindValidator('unregistered')).toBeUndefined();
  });

  it('rejects overriding a built-in kind and duplicate registration', () => {
    for (const builtin of FIELD_TYPES) {
      expect(() => registerFieldKindValidator(builtin, { validate: (x) => x })).toThrow(/built-in/);
    }
    registerFieldKindValidator('blocks-test', { validate: (x) => x });
    expect(() => registerFieldKindValidator('blocks-test', { validate: (x) => x })).toThrow(/already registered/);
  });

  it('registered kinds are NOT authoring-visible — buildFieldSpec still closed-world', () => {
    registerFieldKindValidator('blocks-test', { validate: (x) => x });
    expect(() => buildFieldSpec({ key: 'b', label: 'B', type: 'blocks-test' })).toThrow(/type must be one of/);
  });

  it('localizable flag: boolean, string-only (ADR 0406 D2)', () => {
    const spec = buildFieldSpec({ key: 'title', label: 'Title', type: 'string', localizable: true });
    expect(spec.localizable).toBe(true);
    const off = buildFieldSpec({ key: 'title', label: 'Title', type: 'string', localizable: false });
    expect(off.localizable).toBeUndefined();
    expect(() => buildFieldSpec({ key: 'n', label: 'N', type: 'number', localizable: true })).toThrow(/localizable/);
    expect(() => buildFieldSpec({ key: 't', label: 'T', type: 'string', localizable: 'yes' })).toThrow(/boolean/);
  });
});
