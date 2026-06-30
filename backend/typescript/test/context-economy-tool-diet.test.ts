/**
 * ADR 0148 Phase 2 (A3) — tool-surface diet schema compaction.
 */
import { describe, it, expect } from 'vitest';
import { compactToolSchema } from '../src/providers/toolSchemaCompaction.js';

describe('compactToolSchema', () => {
  const schema = {
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
  } as const;

  it('off → returns the schema unchanged (byte-identical request)', () => {
    expect(compactToolSchema(schema as unknown as Record<string, unknown>, false)).toBe(schema);
  });

  it('on → strips annotation keys at every depth', () => {
    const out = compactToolSchema(schema as unknown as Record<string, unknown>, true) as Record<string, any>;
    // Top-level annotations gone
    expect(out.$schema).toBeUndefined();
    expect(out.$id).toBeUndefined();
    expect(out.title).toBeUndefined();
    // Nested annotations gone
    expect(out.properties.q.title).toBeUndefined();
    expect(out.properties.q.examples).toBeUndefined();
    expect(out.properties.q.markdownDescription).toBeUndefined();
    expect(out.properties.mode.$comment).toBeUndefined();
    expect(out.properties.mode.deprecated).toBeUndefined();
    expect(out.$defs.Thing.title).toBeUndefined();
  });

  it('on → preserves EVERY functional/structural key', () => {
    const out = compactToolSchema(schema as unknown as Record<string, unknown>, true) as Record<string, any>;
    expect(out.type).toBe('object');
    expect(out.description).toBe('Functional description the model needs.');
    expect(out.additionalProperties).toBe(false);
    expect(out.required).toEqual(['q']);
    expect(out.properties.q.type).toBe('string');
    expect(out.properties.q.description).toBe('The search query.'); // descriptions kept
    expect(out.properties.mode.enum).toEqual(['fast', 'slow']);
    expect(out.properties.ref.$ref).toBe('#/$defs/Thing'); // $ref preserved
    expect(out.$defs.Thing.properties.id.type).toBe('string'); // $defs preserved → $ref resolves
  });

  it('on → does NOT mutate the caller schema (replay-safety invariant)', () => {
    const snapshot = JSON.stringify(schema);
    compactToolSchema(schema as unknown as Record<string, unknown>, true);
    expect(JSON.stringify(schema)).toBe(snapshot);
  });

  it('recurses through arrays (anyOf branches keep structure, lose annotations)', () => {
    const s = {
      anyOf: [
        { type: 'string', title: 'A' },
        { type: 'number', $comment: 'b' },
      ],
    };
    const out = compactToolSchema(s, true) as Record<string, any>;
    expect(out.anyOf[0]).toEqual({ type: 'string' });
    expect(out.anyOf[1]).toEqual({ type: 'number' });
  });
});
