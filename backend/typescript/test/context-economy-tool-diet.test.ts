/**
 * ADR 0148 Phase 2 (A3) — tool-surface diet schema compaction.
 *
 * Guards `compactToolSchema` (the tool INPUT schema sent to the model — not tool
 * OUTPUTS; the never-compact-schema-reads rule is witnessed by
 * schema-read-exemption-completeness.test.ts): off ⇒ the same object back
 * (byte-identical request); on ⇒ the annotation denylist stripped at every depth,
 * through arrays, while every functional key ($ref/$defs, description, enum,
 * required, …) survives; and the caller's schema is never mutated (the replay
 * cache key projects the logical schema, ADR 0148 A3 replay-safety invariant).
 *
 * Sabotage (grade-tests w28): ignoring the flag, un-listing an annotation key,
 * listing a functional key, skipping object or array recursion, or deleting keys
 * from the caller's schema each turn a case red. Every case builds a FRESH schema
 * so one case's mutation cannot pre-satisfy another's snapshot.
 */
import { describe, it, expect } from 'vitest';
import { compactToolSchema } from '../src/providers/toolSchemaCompaction.js';

/** Typed path reader over an untyped JSON value (no casts at the call sites). */
const at = (o: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((v, k) => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o);

describe('compactToolSchema', () => {
  const makeSchema = (): Record<string, unknown> => ({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://example.com/tool.json',
    title: 'My Tool Input',
    type: 'object',
    description: 'Functional description the model needs.',
    additionalProperties: false,
    required: ['q'],
    properties: {
      q: {
        type: 'string',
        title: 'Query',
        description: 'The search query.',
        examples: ['hello world', 'a very long example string that costs tokens'],
        markdownDescription: '**Query** in _markdown_',
      },
      mode: {
        type: 'string',
        enum: ['fast', 'slow'],
        $comment: 'internal note nobody needs',
        deprecated: false,
      },
      ref: { $ref: '#/$defs/Thing' },
    },
    $defs: {
      Thing: { type: 'object', title: 'Thing', properties: { id: { type: 'string' } } },
    },
  });

  it('off → returns the schema unchanged (byte-identical request)', () => {
    const schema = makeSchema();
    expect(compactToolSchema(schema, false)).toBe(schema);
  });

  it('on → strips annotation keys at every depth', () => {
    const out = compactToolSchema(makeSchema(), true);
    // Top-level annotations gone
    expect(at(out, '$schema')).toBeUndefined();
    expect(at(out, '$id')).toBeUndefined();
    expect(at(out, 'title')).toBeUndefined();
    // Nested annotations gone
    expect(at(out, 'properties', 'q', 'title')).toBeUndefined();
    expect(at(out, 'properties', 'q', 'examples')).toBeUndefined();
    expect(at(out, 'properties', 'q', 'markdownDescription')).toBeUndefined();
    expect(at(out, 'properties', 'mode', '$comment')).toBeUndefined();
    expect(at(out, 'properties', 'mode', 'deprecated')).toBeUndefined();
    expect(at(out, '$defs', 'Thing', 'title')).toBeUndefined();
  });

  it('on → preserves EVERY functional/structural key', () => {
    const out = compactToolSchema(makeSchema(), true);
    expect(at(out, 'type')).toBe('object');
    expect(at(out, 'description')).toBe('Functional description the model needs.');
    expect(at(out, 'additionalProperties')).toBe(false);
    expect(at(out, 'required')).toEqual(['q']);
    expect(at(out, 'properties', 'q', 'type')).toBe('string');
    expect(at(out, 'properties', 'q', 'description')).toBe('The search query.'); // descriptions kept
    expect(at(out, 'properties', 'mode', 'enum')).toEqual(['fast', 'slow']);
    expect(at(out, 'properties', 'ref', '$ref')).toBe('#/$defs/Thing'); // $ref preserved
    expect(at(out, '$defs', 'Thing', 'properties', 'id', 'type')).toBe('string'); // $defs preserved → $ref resolves
  });

  it('on → does NOT mutate the caller schema (replay-safety invariant)', () => {
    const schema = makeSchema();
    const snapshot = JSON.stringify(schema);
    compactToolSchema(schema, true);
    expect(JSON.stringify(schema)).toBe(snapshot);
  });

  it('recurses through arrays (anyOf branches keep structure, lose annotations)', () => {
    const s = {
      anyOf: [
        { type: 'string', title: 'A' },
        { type: 'number', $comment: 'b' },
      ],
    };
    const out = compactToolSchema(s, true);
    expect(at(out, 'anyOf', '0')).toEqual({ type: 'string' });
    expect(at(out, 'anyOf', '1')).toEqual({ type: 'number' });
  });
});
