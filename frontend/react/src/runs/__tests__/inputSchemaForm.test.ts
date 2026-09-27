/**
 * ADR 0197 Phase 1 — the pure schema→form logic. These tests pin the v1
 * keyword subset (type/title/description/default/required/enum/format),
 * the degrade paths (complex subschema → json field; non-object schema →
 * not renderable), and the validator's fail-closed required semantics.
 */
import { describe, expect, it } from 'vitest';
import {
  compactInputs, deriveFields, isRenderableSchema, seedDefaults, validateInputs,
} from '../inputSchemaForm.js';

const SCHEMA = {
  type: 'object',
  required: ['name', 'count'],
  properties: {
    name: { type: 'string', title: 'Customer name', description: 'Full legal name' },
    count: { type: 'integer', default: 1 },
    ratio: { type: 'number' },
    active: { type: 'boolean', default: true },
    tier: { type: 'string', enum: ['free', 'pro', 'enterprise'] },
    contact: { type: 'string', format: 'email' },
    site: { type: 'string', format: 'uri' },
    due: { type: 'string', format: 'date' },
    nested: { type: 'object' },
  },
} as const;

describe('isRenderableSchema', () => {
  it('accepts an object schema with properties', () => {
    expect(isRenderableSchema(SCHEMA)).toBe(true);
  });
  it('rejects non-objects, empty properties, and non-object types', () => {
    expect(isRenderableSchema(null)).toBe(false);
    expect(isRenderableSchema('x')).toBe(false);
    expect(isRenderableSchema({ type: 'object', properties: {} })).toBe(false);
    expect(isRenderableSchema({ type: 'array', properties: { a: {} } })).toBe(false);
    expect(isRenderableSchema({})).toBe(false);
  });
});

describe('deriveFields', () => {
  const byName = Object.fromEntries(deriveFields(SCHEMA).map((f) => [f.name, f]));

  it('maps the v1 kinds, labels, requireds, and defaults', () => {
    expect(byName.name).toMatchObject({ kind: 'text', label: 'Customer name', required: true, description: 'Full legal name' });
    expect(byName.count).toMatchObject({ kind: 'integer', required: true, defaultValue: 1 });
    expect(byName.ratio).toMatchObject({ kind: 'number', required: false });
    expect(byName.active).toMatchObject({ kind: 'boolean', defaultValue: true });
    expect(byName.tier).toMatchObject({ kind: 'enum', options: ['free', 'pro', 'enterprise'] });
    expect(byName.contact?.kind).toBe('email');
    expect(byName.site?.kind).toBe('uri');
    expect(byName.due?.kind).toBe('date');
  });

  it('degrades complex subschemas to a json field (never a hard failure)', () => {
    expect(byName.nested?.kind).toBe('json');
  });

  it('falls back to the property name when title is absent', () => {
    expect(byName.ratio?.label).toBe('ratio');
  });
});

describe('validateInputs', () => {
  const fields = deriveFields(SCHEMA);

  it('flags missing requireds and skips empty optionals', () => {
    const errs = validateInputs(fields, {});
    expect(errs).toEqual(expect.arrayContaining([
      { name: 'name', key: 'errRequired' },
      { name: 'count', key: 'errRequired' },
    ]));
    expect(errs).toHaveLength(2);
  });

  it('type-checks numbers, integers, enums, email, and uri', () => {
    const errs = validateInputs(fields, {
      name: 'Ada', count: 1.5, ratio: Number.NaN, tier: 'gold', contact: 'nope', site: 'not a url',
    });
    expect(errs).toEqual(expect.arrayContaining([
      { name: 'count', key: 'errInteger' },
      { name: 'ratio', key: 'errNumber' },
      { name: 'tier', key: 'errEnum' },
      { name: 'contact', key: 'errEmail' },
      { name: 'site', key: 'errUri' },
    ]));
  });

  it('passes a fully valid payload', () => {
    expect(validateInputs(fields, {
      name: 'Ada', count: 3, ratio: 0.5, active: false, tier: 'pro',
      contact: 'ada@example.com', site: 'https://example.com', due: '2026-07-02',
    })).toHaveLength(0);
  });
});

describe('seedDefaults + compactInputs', () => {
  const fields = deriveFields(SCHEMA);

  it('seeds only declared defaults', () => {
    expect(seedDefaults(fields)).toEqual({ count: 1, active: true });
  });

  it('drops empty entries from the launch payload', () => {
    expect(compactInputs(fields, { name: 'Ada', ratio: '', tier: undefined, count: 2 }))
      .toEqual({ name: 'Ada', count: 2 });
  });
});
