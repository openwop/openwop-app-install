/**
 * Boot perf (2026-10-08) — the agent loader validates handoff schemas against ONE shared
 * compiled 2020-12 meta-schema, while user schemas still compile on a per-pack
 * instance. Pins: invalid schema ⇒ agent skipped at load (RFC 0003 §D); a `$id`
 * reused across two packs never collides; error text is byte-identical to a
 * plain Ajv2020; the warm (shared-meta already compiled) path yields working
 * validators.
 *
 * Tracker TST-BKY-5. Red when the shared meta instance is not cached (a fresh
 * Ajv per call — the boot-perf regression), an invalid schema stops throwing
 * the plain message, the meta errors are not copied, a non-2020-12 `$schema`
 * is validated against the 2020-12 meta instead of failing like a plain
 * Ajv2020, or the per-pack instance becomes shared (`$id` collision) — each
 * sabotage-witnessed (w65). The non-2020-12 branch is witnessed with a CUSTOM
 * meta-schema registered on the per-pack instance: only that instance knows it,
 * so routing the schema to the shared 2020-12 meta validator throws "no schema
 * with key or ref". (An UNKNOWN `$schema` such as draft-07 cannot witness it:
 * the shared meta validator is itself a plain Ajv2020 and throws the identical
 * lookup error — equivalent on that input, w65 round 3.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Ajv2020 from 'ajv/dist/2020.js';
import { loadAgentsFromManifest } from '../src/packs/agentLoader.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { SharedMetaAjv2020, sharedMetaInstanceCount } from '../src/packs/sharedMetaAjv.js';
import { attestPackDir } from './setup/attestPackFixture.js';

const dirs: string[] = [];

function makePack(name: string, agents: Array<{ leaf: string; task?: unknown; ret?: unknown }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentpack-ajv-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'schemas'), { recursive: true });
  const manifestAgents = agents.map(({ leaf, task, ret }) => {
    const handoff: Record<string, string> = {};
    if (task !== undefined) {
      writeFileSync(join(dir, 'schemas', `${leaf}.task.json`), JSON.stringify(task));
      handoff.taskSchemaRef = `schemas/${leaf}.task.json`;
    }
    if (ret !== undefined) {
      writeFileSync(join(dir, 'schemas', `${leaf}.return.json`), JSON.stringify(ret));
      handoff.returnSchemaRef = `schemas/${leaf}.return.json`;
    }
    return {
      agentId: `${name}.${leaf}`, persona: leaf, modelClass: 'general', systemPrompt: `you are ${leaf}`,
      ...(Object.keys(handoff).length > 0 ? { handoff } : {}),
    };
  });
  writeFileSync(join(dir, 'pack.json'), JSON.stringify({ name, version: '1.0.0', nodes: [], agents: manifestAgents }));
  attestPackDir(dir);
  return dir;
}

const SHARED_ID = 'https://example.test/schemas/shared-task.json';

describe('agentLoader — shared 2020-12 meta-schema', () => {
  beforeEach(() => getAgentRegistry()._resetForTest());
  afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

  it('an invalid handoff schema still skips that agent at load; a valid sibling loads', () => {
    const dir = makePack('local.ajv.invalid', [
      { leaf: 'bad', task: { type: 'not-a-json-schema-type' } },
      { leaf: 'good', task: { type: 'object', required: ['q'], properties: { q: { type: 'string' } } } },
    ]);
    const loaded = loadAgentsFromManifest(dir);
    expect(loaded.map((a) => a.agentId)).toEqual(['local.ajv.invalid.good']);
    expect(getAgentRegistry().has('local.ajv.invalid.bad')).toBe(false);
    const good = loaded[0]!;
    expect(good.handoff?.validateTask?.({ q: 'x' })).toEqual({ ok: true });
    expect(good.handoff?.validateTask?.({})).toEqual({ ok: false, errors: "data must have required property 'q'" });
  });

  it('two packs reusing one `$id` with DIFFERENT schemas both load and each validates by its own schema', () => {
    const a = makePack('local.ajv.packa', [{ leaf: 'x', task: {
      $schema: 'https://json-schema.org/draft/2020-12/schema', $id: SHARED_ID,
      type: 'object', required: ['alpha'], properties: { alpha: { type: 'string' } },
    } }]);
    const b = makePack('local.ajv.packb', [{ leaf: 'x', task: {
      $schema: 'https://json-schema.org/draft/2020-12/schema', $id: SHARED_ID,
      type: 'object', required: ['beta'], properties: { beta: { type: 'number' } },
    } }]);
    const [la] = loadAgentsFromManifest(a);
    const [lb] = loadAgentsFromManifest(b);
    expect(la?.agentId).toBe('local.ajv.packa.x');
    expect(lb?.agentId).toBe('local.ajv.packb.x');
    expect(la!.handoff!.validateTask!({ alpha: 's' })).toEqual({ ok: true });
    expect(la!.handoff!.validateTask!({ beta: 1 })).toEqual({ ok: false, errors: "data must have required property 'alpha'" });
    expect(lb!.handoff!.validateTask!({ beta: 1 })).toEqual({ ok: true });
    expect(lb!.handoff!.validateTask!({ beta: 'no' })).toEqual({ ok: false, errors: 'data/beta must be number' });
  });

  it('warm path: repeated loads reuse ONE shared meta instance and still yield working validators', () => {
    const schema = { type: 'object', required: ['n'], properties: { n: { type: 'integer', minimum: 1 } } };
    for (let i = 0; i < 5; i += 1) {
      getAgentRegistry()._resetForTest();
      const [agent] = loadAgentsFromManifest(makePack(`local.ajv.warm${i}`, [{ leaf: 'w', task: schema, ret: schema }]));
      expect(agent!.handoff!.validateTask!({ n: 2 })).toEqual({ ok: true });
      expect(agent!.handoff!.validateReturn!({ n: 0 })).toEqual({ ok: false, errors: 'data/n must be >= 1' });
    }
    // At least one (the shared meta IS cached) and one per `allErrors` value at
    // most — never one per pack. `≤ 2` alone also held at 0, i.e. never cached.
    const n = sharedMetaInstanceCount();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(2);
  });
});

describe('SharedMetaAjv2020 — parity with a plain Ajv2020', () => {
  const thrown = (ajv: Ajv2020, schema: unknown): string => {
    try { ajv.compile(schema as object); return '(no throw)'; } catch (err) { return (err as Error).message; }
  };
  const invalid: unknown[] = [
    { type: 'nope' },
    { $schema: 'https://json-schema.org/draft/2020-12/schema', properties: { a: { minimum: 'x' } }, required: 'a' },
    { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' },
    { $schema: 42 },
  ];

  for (const allErrors of [true, false]) {
    it(`invalid schemas throw the same message (allErrors=${allErrors})`, () => {
      for (const schema of invalid) {
        const want = thrown(new Ajv2020({ allErrors, strict: false }), schema);
        expect(want).not.toBe('(no throw)');
        expect(thrown(new SharedMetaAjv2020({ allErrors, strict: false }), schema)).toBe(want);
      }
    });
  }

  it('validateSchema returns the same verdict and errors without throwing', () => {
    const plain = new Ajv2020({ allErrors: true, strict: false });
    const shared = new SharedMetaAjv2020({ allErrors: true, strict: false });
    const schema = { type: 'object', minProperties: -1 };
    expect(shared.validateSchema(schema)).toBe(plain.validateSchema(schema));
    expect(shared.errorsText()).toBe(plain.errorsText());
    expect(shared.validateSchema({ type: 'string' })).toBe(true);
    expect(shared.errors).toBeNull();
  });

  it('a non-2020-12 `$schema` is checked against the meta-schema registered on THIS instance', () => {
    // A custom meta-schema known only to the per-pack instance: it requires `title`.
    const CUSTOM_META = { $id: 'https://example.test/meta/titled', type: 'object', required: ['title'] };
    const plain = new Ajv2020({ allErrors: true, strict: false });
    const shared = new SharedMetaAjv2020({ allErrors: true, strict: false });
    plain.addMetaSchema(CUSTOM_META);
    shared.addMetaSchema(CUSTOM_META);
    const titled = { $schema: CUSTOM_META.$id, title: 'T', type: 'string' };
    const untitled = { $schema: CUSTOM_META.$id, type: 'string' };
    expect(plain.validateSchema(titled)).toBe(true);
    expect(shared.validateSchema(titled)).toBe(true);
    expect(plain.validateSchema(untitled)).toBe(false);
    expect(shared.validateSchema(untitled)).toBe(false);
    expect(shared.errorsText()).toBe(plain.errorsText());
  });

  it('the 2020-12 meta-schema stays resolvable as a $ref target on the per-pack instance', () => {
    const ajv = new SharedMetaAjv2020({ allErrors: true, strict: false });
    const isSchema = ajv.compile({ $ref: 'https://json-schema.org/draft/2020-12/schema' });
    expect(isSchema({ type: 'string' })).toBe(true);
    expect(isSchema({ type: 'nope' })).toBe(false);
  });

  it('a `$id` reused on ONE instance still collides (per-instance registry unchanged)', () => {
    const ajv = new SharedMetaAjv2020({ allErrors: true, strict: false });
    ajv.compile({ $id: SHARED_ID, type: 'string' });
    expect(() => ajv.compile({ $id: SHARED_ID, type: 'number' })).toThrow(/already exists/);
  });
});
