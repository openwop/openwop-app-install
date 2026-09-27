import { describe, it, expect } from 'vitest';
import { normaliseEmitArgs } from '../src/executor/normaliseEmitArgs.js';
import { OpenwopError } from '../src/types.js';

/**
 * ADR 0675 — the emit bridge normalises, and refuses what it cannot.
 *
 * `ctx.emit` is positional, `emit(type, payload)`. Several packs call it with a
 * single object instead. Nothing rejected that, so the OBJECT was written into
 * the `events.type` TEXT column.
 *
 * MEASURED in production 2026-09-14 (`scripts/era2-vendor-type-census.mjs`):
 * **376 rows** whose `type` is a serialised envelope. Nine of the ten
 * grammar-invalid (tenant, type) pairs in the entire log are this one bug.
 *
 * It was invisible from the source. A scan of `appendEvent({ type: '…' })`
 * literals returns ten well-formed names, because the corrupting write goes
 * through a VARIABLE. Only the data showed it.
 */
describe('ADR 0675 — ctx.emit argument normalisation', () => {
  it('passes the positional form through unchanged', () => {
    expect(normaliseEmitArgs('artifact.created', { id: 'a1' }))
      .toEqual({ type: 'artifact.created', payload: { id: 'a1' } });
  });

  it('accepts `{ type, data }` — the shape that produced the 376 rows', () => {
    // `core.openwop.http` retry path, verbatim.
    const out = normaliseEmitArgs(
      { type: 'node.progress', data: { phase: 'retry', attempt: 1, status: 503 } },
      undefined,
    );
    expect(out.type).toBe('node.progress');
    expect(out.payload).toEqual({ phase: 'retry', attempt: 1, status: 503 });
    // The regression in one line: the type must be the NAME, never the envelope.
    expect(typeof out.type).toBe('string');
    expect(out.type).not.toContain('{');
  });

  it('accepts `{ kind, payload }` — the a2a/agents spelling', () => {
    const out = normaliseEmitArgs({ kind: 'node.progress', payload: { step: 2 } }, undefined);
    expect(out).toEqual({ type: 'node.progress', payload: { step: 2 } });
  });

  it('REFUSES a type that is not a string and cannot be named', () => {
    // The whole point. A silent accept is what produced the corrupt rows, so
    // the failure has to be loud: a typed error surfaces as a node failure
    // rather than an unreadable row nobody notices for months.
    for (const bad of [42, null, undefined, [], { data: { no: 'name' } }, { type: 42 }]) {
      expect(() => normaliseEmitArgs(bad, undefined), `should refuse ${JSON.stringify(bad) ?? 'undefined'}`)
        .toThrow(OpenwopError);
    }
  });

  it('REFUSES an empty string — a nameless event is not a named one', () => {
    expect(() => normaliseEmitArgs('', {})).toThrow(OpenwopError);
  });

  it('the object form wins over a stray positional payload rather than merging', () => {
    // A caller passing both is confused; silently merging would invent a
    // payload neither side wrote.
    const out = normaliseEmitArgs({ type: 'node.progress', data: { a: 1 } }, { b: 2 });
    expect(out.payload).toEqual({ a: 1 });
  });
});
