/**
 * `configFieldsFromSchema` — the pack-manifest JSON Schema → ConfigField[]
 * converter behind the builder Inspector's per-node config form (scalar
 * inference is the shared form engine's, ADR 0331 §D4-B). Pure function: no
 * React, no fetch, no stubs. Breaks if a pack schema keyword is silently
 * dropped (a default, a bound, `required`) or maps to the wrong control.
 *
 * The production fixture is READ from the shipped pack schema, never copied: a
 * copy kept here had drifted to the 1.1.2 shape (6 properties) while the pack
 * shipped 1.4.1 with a seventh (`modelClass`, ADR 0525 GRD-8), and the
 * "exactly the 6 properties" case kept passing against a schema nobody ships.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFieldsFromSchema } from '../configFieldsFromSchema.js';
import type { ConfigField } from '../nodeCatalog.js';

/** The real `core.ai.chatCompletion` configSchema, resolved from this file
 *  (repo-root `packs/` ships in the white-label bundle). */
const HERE = dirname(fileURLToPath(import.meta.url));
const CHAT_COMPLETION_CONFIG_SCHEMA = JSON.parse(
  readFileSync(resolve(HERE, '../../../../../../packs/core.openwop.ai/schemas/chat-completion.config.json'), 'utf8'),
) as { required?: string[]; properties: Record<string, unknown> };

function byKey(fields: readonly ConfigField[], key: string): ConfigField | undefined {
  return fields.find((f) => f.key === key);
}

describe('configFieldsFromSchema', () => {
  describe('top-level shape', () => {
    it('returns [] for non-object schema', () => {
      expect(configFieldsFromSchema(null)).toEqual([]);
      expect(configFieldsFromSchema(undefined)).toEqual([]);
      expect(configFieldsFromSchema('not a schema')).toEqual([]);
      expect(configFieldsFromSchema(42)).toEqual([]);
    });

    it('returns [] when schema has no `properties`', () => {
      expect(configFieldsFromSchema({ type: 'object' })).toEqual([]);
    });

    it('preserves property insertion order', () => {
      const fields = configFieldsFromSchema({
        type: 'object',
        properties: { c: { type: 'string' }, a: { type: 'string' }, b: { type: 'string' } },
      });
      expect(fields.map((f) => f.key)).toEqual(['c', 'a', 'b']);
    });

    it('marks required fields via `field.required`', () => {
      const fields = configFieldsFromSchema({
        type: 'object',
        required: ['a'],
        properties: { a: { type: 'string' }, b: { type: 'string' } },
      });
      expect(byKey(fields, 'a')?.required).toBe(true);
      expect(byKey(fields, 'b')?.required).toBe(false);
    });
  });

  describe('kind inference', () => {
    it('maps boolean → checkbox', () => {
      const fields = configFieldsFromSchema({
        type: 'object',
        properties: { flag: { type: 'boolean' } },
      });
      expect(byKey(fields, 'flag')?.kind).toBe('checkbox');
    });

    it('maps number / integer → number', () => {
      const fields = configFieldsFromSchema({
        type: 'object',
        properties: { n: { type: 'number' }, i: { type: 'integer' } },
      });
      expect(byKey(fields, 'n')?.kind).toBe('number');
      expect(byKey(fields, 'i')?.kind).toBe('number');
    });

    it('maps scalar enum → select with options', () => {
      const fields = configFieldsFromSchema({
        type: 'object',
        properties: { mode: { type: 'string', enum: ['a', 'b', 'c'] } },
      });
      const f = byKey(fields, 'mode')!;
      expect(f.kind).toBe('select');
      expect(f.options).toEqual([
        { value: 'a', label: 'a' },
        { value: 'b', label: 'b' },
        { value: 'c', label: 'c' },
      ]);
    });

    it('maps array<string> → string-list (NOT textarea)', () => {
      const fields = configFieldsFromSchema({
        type: 'object',
        properties: { tags: { type: 'array', items: { type: 'string' } } },
      });
      expect(byKey(fields, 'tags')?.kind).toBe('string-list');
    });

    it('maps array<object> → textarea (JSON authoring)', () => {
      const fields = configFieldsFromSchema({
        type: 'object',
        properties: { rules: { type: 'array', items: { type: 'object' } } },
      });
      expect(byKey(fields, 'rules')?.kind).toBe('textarea');
    });

    it('maps object → textarea', () => {
      const fields = configFieldsFromSchema({
        type: 'object',
        properties: { meta: { type: 'object', properties: { a: { type: 'string' } } } },
      });
      expect(byKey(fields, 'meta')?.kind).toBe('textarea');
    });

    it('defaults to text input', () => {
      const fields = configFieldsFromSchema({
        type: 'object',
        properties: { name: { type: 'string' } },
      });
      expect(byKey(fields, 'name')?.kind).toBe('text');
    });
  });

  describe('label + help', () => {
    it('uses `title` when present, falls back to key', () => {
      const fields = configFieldsFromSchema({
        type: 'object',
        properties: {
          a: { type: 'string', title: 'Alpha' },
          b: { type: 'string' },
        },
      });
      expect(byKey(fields, 'a')?.label).toBe('Alpha');
      expect(byKey(fields, 'b')?.label).toBe('b');
    });

    it('surfaces `description` as `help`', () => {
      const fields = configFieldsFromSchema({
        type: 'object',
        properties: { x: { type: 'string', description: 'some help' } },
      });
      expect(byKey(fields, 'x')?.help).toBe('some help');
    });

    it('appends items.pattern to help text on string-list fields', () => {
      const fields = configFieldsFromSchema({
        type: 'object',
        properties: {
          tags: {
            type: 'array',
            items: { type: 'string', pattern: '^[a-z]+$' },
            description: 'Lowercase tags.',
          },
        },
      });
      expect(byKey(fields, 'tags')?.help).toBe('Lowercase tags. (each line MUST match: ^[a-z]+$)');
    });
  });

  describe('default values', () => {
    it('passes through scalar defaults', () => {
      const fields = configFieldsFromSchema({
        type: 'object',
        properties: {
          s: { type: 'string', default: 'hi' },
          n: { type: 'number', default: 0.5 },
          b: { type: 'boolean', default: true },
        },
      });
      expect(byKey(fields, 's')?.defaultValue).toBe('hi');
      expect(byKey(fields, 'n')?.defaultValue).toBe(0.5);
      expect(byKey(fields, 'b')?.defaultValue).toBe(true);
    });

    it('passes through string[] defaults on string-list kind', () => {
      const fields = configFieldsFromSchema({
        type: 'object',
        properties: {
          stops: { type: 'array', items: { type: 'string' }, default: ['END', 'STOP'] },
        },
      });
      expect(byKey(fields, 'stops')?.kind).toBe('string-list');
      expect(byKey(fields, 'stops')?.defaultValue).toEqual(['END', 'STOP']);
    });

    it('passes through object defaults on textarea kind (renderer pretty-prints)', () => {
      const fields = configFieldsFromSchema({
        type: 'object',
        properties: {
          meta: { type: 'object', default: { region: 'us-east-1' } },
        },
      });
      // Pre-fix: this used to be silently dropped. The renderer now
      // pretty-prints the default into the textarea.
      expect(byKey(fields, 'meta')?.defaultValue).toEqual({ region: 'us-east-1' });
    });

    it('omits defaultValue entirely when default is absent', () => {
      const fields = configFieldsFromSchema({
        type: 'object',
        properties: { a: { type: 'string' } },
      });
      expect(byKey(fields, 'a')).not.toHaveProperty('defaultValue');
    });
  });

  describe('validation hints — number', () => {
    it('forwards minimum / maximum to min / max', () => {
      const fields = configFieldsFromSchema({
        type: 'object',
        properties: { t: { type: 'number', minimum: 0, maximum: 2 } },
      });
      const f = byKey(fields, 't')!;
      expect(f.min).toBe(0);
      expect(f.max).toBe(2);
    });

    it('forwards multipleOf to step', () => {
      const fields = configFieldsFromSchema({
        type: 'object',
        properties: { t: { type: 'number', multipleOf: 0.1 } },
      });
      expect(byKey(fields, 't')?.step).toBe(0.1);
    });

    it('defaults integer step to 1 when multipleOf absent', () => {
      const fields = configFieldsFromSchema({
        type: 'object',
        properties: { n: { type: 'integer' } },
      });
      expect(byKey(fields, 'n')?.step).toBe(1);
    });
  });

  describe('validation hints — text/textarea', () => {
    it('forwards minLength / maxLength on text', () => {
      const fields = configFieldsFromSchema({
        type: 'object',
        properties: { name: { type: 'string', minLength: 1, maxLength: 64 } },
      });
      const f = byKey(fields, 'name')!;
      expect(f.minLength).toBe(1);
      expect(f.maxLength).toBe(64);
    });

    it('forwards pattern on text', () => {
      const fields = configFieldsFromSchema({
        type: 'object',
        properties: { handle: { type: 'string', pattern: '^@[a-z]+$' } },
      });
      expect(byKey(fields, 'handle')?.pattern).toBe('^@[a-z]+$');
    });

    it('does NOT forward pattern to textarea (textarea has no HTML5 pattern attr)', () => {
      const fields = configFieldsFromSchema({
        type: 'object',
        properties: { body: { type: 'object', pattern: '.*' } },
      });
      expect(byKey(fields, 'body')).not.toHaveProperty('pattern');
    });
  });

  describe('validation hints — string-list', () => {
    it('forwards maxItems', () => {
      const fields = configFieldsFromSchema({
        type: 'object',
        properties: { tags: { type: 'array', items: { type: 'string' }, maxItems: 8 } },
      });
      expect(byKey(fields, 'tags')?.maxItems).toBe(8);
    });
  });

  describe('production-grade fixture — the shipped core.ai.chatCompletion configSchema', () => {
    const fields = configFieldsFromSchema(CHAT_COMPLETION_CONFIG_SCHEMA);

    it('produces one field per schema property, in the schema\'s order', () => {
      // The FILE is the oracle here, not the converter.
      expect(fields.map((f) => f.key)).toEqual(Object.keys(CHAT_COMPLETION_CONFIG_SCHEMA.properties));
    });

    it('marks exactly the schema\'s required properties as required', () => {
      // Since 1.5.0 the schema requires nothing: an unset provider/model takes
      // the run's AI default (openwop-app ADR 0903 D7), so the form must not
      // demand them. The positive control for `required` is the literal-schema
      // case under "top-level shape".
      const required = CHAT_COMPLETION_CONFIG_SCHEMA.required ?? [];
      expect(required).not.toContain('provider');
      expect(required).not.toContain('model');
      for (const f of fields) {
        expect(f.required, f.key).toBe(required.includes(f.key));
      }
    });

    it('maps every shipped property to the expected control (a new property must be decided here)', () => {
      expect(Object.fromEntries(fields.map((f) => [f.key, f.kind]))).toEqual({
        provider: 'text',
        model: 'text',
        systemPrompt: 'text',
        temperature: 'number',
        maxTokens: 'number',
        stopSequences: 'string-list',
        modelClass: 'text',
      });
    });
    // Per-keyword forwarding (min/max, integer step, maxItems, minLength) is
    // pinned by the unit cases above on literal schemas.
  });
});
