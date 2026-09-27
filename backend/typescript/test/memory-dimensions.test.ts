/**
 * RFC 0080 §A — the reconciled memory-capability model (`host/memoryDimensions.ts`).
 *
 * The route-level §C wire shape is `test/memory-degraded-projection-route.test.ts`.
 * This file is about the DERIVATION: does the host's dimension set follow the
 * subsystem it claims to describe, on each tier, and does it stay pinned to the
 * corpus's closed vocabulary.
 *
 * Two properties are load-bearing and each has its own leg:
 *   1. the vocabulary is the corpus's, read FROM the corpus — not restated here
 *      (a hand-copied restatement agrees with a drift for as long as it exists);
 *   2. the dimension set is read OFF the advertisement, so advert and projection
 *      cannot disagree — proven by moving an advert input and watching BOTH move.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  MEMORY_DIMENSIONS,
  closeAndOrderDimensions,
  longTermMemoryDurable,
  memoryCapability,
  projectMemoryDegradation,
  requestedMemoryDimensions,
  satisfiedMemoryDimensions,
  type MemoryDimension,
} from '../src/host/memoryDimensions.js';
import { corpusSchema } from './support/corpusSchema.js';

/** Env this file moves (`OPENWOP_SURFACE_MEMORY`, `OPENWOP_SURFACE_BACKEND`,
 *  `OPENWOP_TEST_TRIGGER_COMPACTION`), restored after EVERY test so a leaked
 *  tier cannot make a later leg pass for the wrong reason — the H49 lesson about
 *  a case that read ambient env while the resolver consulted two vars. */
const saved = new Map<string, string | undefined>();
function setEnv(name: string, value: string | undefined): void {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

/** Put the host on its DEFAULT (process-local) memory tier, explicitly. Both
 *  vars are cleared because `resolveBackendId` consults the per-surface var
 *  first and the global one second — clearing only one leaves the answer to
 *  whatever the ambient process happens to carry. */
function defaultTier(): void {
  for (const k of ['OPENWOP_SURFACE_MEMORY', 'OPENWOP_SURFACE_BACKEND']) setEnv(k, undefined);
}
/** Put the host on the cross-run DURABLE memory tier (what `conformance/run.ts`
 *  selects). Only the ID matters to this module — it asks "which backend", not
 *  "hand me a store" — so no adapter registration is needed to exercise it. */
function durableTier(): void {
  setEnv('OPENWOP_SURFACE_BACKEND', undefined);
  setEnv('OPENWOP_SURFACE_MEMORY', 'durable');
}

describe('RFC 0080 §A — the dimension vocabulary is the CORPUS vocabulary', () => {
  it('MEMORY_DIMENSIONS equals the degradedMemoryDimensions enum, in order', () => {
    // Derived from the SSoT: the enum shipped in @openwop/openwop-conformance,
    // not the repo's vendored copy and not a literal restated here. A ninth
    // dimension upstream turns this red instead of silently narrowing the model.
    const schema = corpusSchema('agent-inventory-response.schema.json');
    const entry = (schema.$defs?.AgentInventoryEntry ?? {}) as {
      properties?: { degradedMemoryDimensions?: { items?: { enum?: unknown } } };
    };
    const corpusEnum = entry.properties?.degradedMemoryDimensions?.items?.enum;

    // Non-vacuity: an unreadable schema would make the comparison below trivial.
    expect(Array.isArray(corpusEnum), 'the corpus schema MUST declare the closed enum').toBe(true);
    expect((corpusEnum as unknown[]).length, 'RFC 0080 §A names EIGHT dimensions').toBe(8);

    expect([...MEMORY_DIMENSIONS]).toEqual(corpusEnum);
  });

  it('the enum is closed STRUCTURALLY — an unknown name cannot reach the projection', () => {
    // This leg exists because of a measurement. Sabotage C3 made
    // `requestedMemoryDimensions` emit `longTerm` (not a §A name) and the corpus
    // scenario stayed GREEN — not because the scenario is blind, but because
    // `closeAndOrderDimensions` filters `MEMORY_DIMENSIONS` and the bad name
    // never left the module. Only disabling that filter too (C3b) let the
    // scenario see it, and then it went red on exactly the enum assertion.
    //
    // So the closure is doing real work, and it was resting on nothing but a
    // `.filter` a future editor could "simplify" to `[...dims]` while preserving
    // the ordering behaviour for every valid input. It gets an assertion.
    const rogue = new Set(['longTerm', 'read', 'scratchpad', 'long-term'] as unknown as MemoryDimension[]);
    expect(closeAndOrderDimensions(rogue)).toEqual(['read']);

    // ...and the ordering half still holds: §A declaration order, not insertion
    // order and not alphabetical (`read` sorts after `long-term-durability`).
    const valid = new Set<MemoryDimension>(['retention', 'read', 'long-term-durability']);
    expect(closeAndOrderDimensions(valid)).toEqual(['read', 'long-term-durability', 'retention']);
  });

  it('the §A names are NOT the memoryShape keys and NOT the memoryBackends value', () => {
    // RFC 0080 UQ2 resolved the vocabulary explicitly, and the schema calls the
    // `long-term-durability` / `long-term` split deliberate. Both are easy to
    // "simplify" away by someone who has not read either.
    for (const shapeKey of ['scratchpad', 'conversation', 'longTerm']) {
      expect(MEMORY_DIMENSIONS as readonly string[]).not.toContain(shapeKey);
    }
    expect(MEMORY_DIMENSIONS as readonly string[]).toContain('long-term-durability');
    expect(MEMORY_DIMENSIONS as readonly string[]).not.toContain('long-term');
  });
});

describe('RFC 0080 §A — satisfaction is DERIVED per tier, never asserted', () => {
  it('long-term-durability is the ONE dimension the deployed tier moves', () => {
    defaultTier();
    expect(longTermMemoryDurable(), 'the default `memory` backend is process-local').toBe(false);
    const onDefault = satisfiedMemoryDimensions();
    expect(onDefault.has('long-term-durability')).toBe(false);

    durableTier();
    expect(longTermMemoryDurable(), 'a selected real backend survives a restart').toBe(true);
    const onDurable = satisfiedMemoryDimensions();
    expect(onDurable.has('long-term-durability')).toBe(true);

    // ...and it is the ONLY difference. If a second dimension started moving with
    // the tier, that is a real change in the model and should be stated, not
    // absorbed silently by a looser assertion.
    const delta = MEMORY_DIMENSIONS.filter((d) => onDefault.has(d) !== onDurable.has(d));
    expect(delta).toEqual(['long-term-durability']);
  });

  it('read + write are satisfied on BOTH tiers — the four-op adapter is tier-independent', () => {
    // `memory.supported` advertises the HOST-INTERNAL adapter (§B), which does
    // not become more or less present because the rows moved to durable storage.
    for (const tier of [defaultTier, durableTier]) {
      tier();
      const s = satisfiedMemoryDimensions();
      expect(s.has('read'), 'listMemoryEntries/getMemoryEntry exist').toBe(true);
      expect(s.has('write'), 'writeMemoryEntry/removeMemoryEntry exist; writable is not false').toBe(true);
    }
  });

  it('search + retention are honestly UNSATISFIED — neither is advertised', () => {
    defaultTier();
    const mem = memoryCapability();
    expect(mem.search, 'ranking is recency-only; RFC 0113 rank:relevance is not offered').toBeUndefined();
    expect(mem.retention, 'TTL + delete-by-subject exist but are not advertised — ADR 0041 §H51 residue').toBeUndefined();
    const s = satisfiedMemoryDimensions();
    expect(s.has('search')).toBe(false);
    expect(s.has('retention')).toBe(false);
  });

  it('compaction follows its SEAM switch, in both directions', () => {
    // The coupling this leg really proves: the dimension is read off the advert,
    // so moving ONE advert input moves the advert AND the dimension together.
    defaultTier();
    setEnv('OPENWOP_TEST_TRIGGER_COMPACTION', undefined);
    expect(memoryCapability().compaction).toBeUndefined();
    expect(satisfiedMemoryDimensions().has('compaction')).toBe(false);

    setEnv('OPENWOP_TEST_TRIGGER_COMPACTION', 'true');
    expect(memoryCapability().compaction?.supported).toBe(true);
    expect(satisfiedMemoryDimensions().has('compaction'), 'advert and model move as one').toBe(true);
  });

  it('attribution is satisfied unconditionally — the host really emits memory.written', () => {
    defaultTier();
    expect(memoryCapability().attribution).toEqual({ supported: true, emitsWriteEvents: true });
    expect(satisfiedMemoryDimensions().has('attribution')).toBe(true);
  });

  it('the advertised block validates against capabilities.schema.json §memory', () => {
    // The block this module now OWNS is the one that reaches the wire, and this
    // repo has no whole-document ajv check over the advert — so the field being
    // flipped gets its own. Validated against the CORPUS copy (the lockfile-pinned
    // package), never the vendored one: a vendored copy certifies the advert
    // against whatever that copy happens to say, which is how `capabilities`
    // once sat seven properties behind upstream while everything stayed green.
    const caps = corpusSchema('capabilities.schema.json');
    const memorySchema = (caps.properties as Record<string, unknown> | undefined)?.memory;
    expect(memorySchema, 'capabilities.schema.json MUST declare the memory family').toBeDefined();

    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validate = ajv.compile(memorySchema as object);

    // Both tiers AND both compaction postures — the advert varies across all of
    // them, so validating one shape would leave the others unchecked.
    for (const tier of [defaultTier, durableTier]) {
      for (const compaction of [undefined, 'true']) {
        tier();
        setEnv('OPENWOP_TEST_TRIGGER_COMPACTION', compaction);
        const block = memoryCapability();
        if (!validate(block)) {
          throw new Error(`capabilities.memory failed its own schema: ${ajv.errorsText(validate.errors)}`);
        }
      }
    }

    // Non-vacuity: the compiled schema must actually reject something, or the
    // loop above proves only that ajv ran.
    expect(validate({ supported: 'yes' }), 'the schema must constrain `supported`').toBe(false);
  });
});

describe('RFC 0080 §A — replay-snapshot is not derived from the bare formula', () => {
  it('stays UNSATISFIED even on the tier where the §A formula would say yes', () => {
    durableTier();
    const s = satisfiedMemoryDimensions();
    // The formula is (memoryBackends long-term ∧ executionModel >= 2). Its first
    // term is now TRUE, so a host deriving from the formula alone would claim the
    // dimension on any phase-2 boot. This host does not implement RFC 0004 §A's
    // run-start snapshot rule, so it must not.
    expect(s.has('long-term-durability'), 'precondition: the formula\'s first term holds').toBe(true);
    expect(s.has('replay-snapshot')).toBe(false);
  });

  it('SOURCE ratchet — listMemoryEntries really has no run-start snapshot filter', () => {
    // The constant above is an assertion ABOUT THE CODE, and a comment cannot
    // keep it true. This derives the absence from the source: implement the
    // snapshot and this goes red, forcing the constant to be reconsidered rather
    // than leaving a stale `false` advertising a determinism the host now has.
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'host', 'inMemorySurfaces.ts'), 'utf8');
    const start = src.indexOf('export async function listMemoryEntries');
    expect(start, 'listMemoryEntries MUST exist for this ratchet to mean anything').toBeGreaterThan(0);
    const end = src.indexOf('\nexport ', start + 1);
    const body = src.slice(start, end > start ? end : undefined).replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');

    // Non-vacuity: the slice must be the real body, not an empty string.
    expect(body, 'the extracted body must be the real function').toContain('isWellFormedMemoryRef');

    for (const marker of ['snapshotAt', 'snapshotId', 'runStartedAt', 'asOfSeq', 'visibleAtRunStart']) {
      expect(body, `listMemoryEntries references ${marker} — the run-start snapshot may now be implemented; re-evaluate LIST_HONORS_RUN_START_SNAPSHOT in host/memoryDimensions.ts`).not.toContain(marker);
    }
  });
});

describe('RFC 0080 §C — memoryShape → dimension mapping (the schema\'s own mapping)', () => {
  it('longTerm requests long-term-durability AND the read/write it rides on', () => {
    expect(requestedMemoryDimensions({ longTerm: true })).toEqual(['read', 'write', 'long-term-durability']);
  });

  it('scratchpad / conversation request read + write only', () => {
    expect(requestedMemoryDimensions({ scratchpad: true })).toEqual(['read', 'write']);
    expect(requestedMemoryDimensions({ conversation: true })).toEqual(['read', 'write']);
    expect(requestedMemoryDimensions({ scratchpad: true, conversation: true })).toEqual(['read', 'write']);
  });

  it('an absent, empty, or all-false memoryShape requests nothing', () => {
    expect(requestedMemoryDimensions(undefined)).toEqual([]);
    expect(requestedMemoryDimensions({})).toEqual([]);
    expect(requestedMemoryDimensions({ scratchpad: false, conversation: false, longTerm: false })).toEqual([]);
  });

  it('a non-boolean memoryShape value is NOT a declaration (strict === true)', () => {
    // Reachable: `packs/agentLoader.ts` casts raw manifest JSON. A truthy string
    // must not let a malformed manifest author a degraded-dimension list on the
    // wire; `agent-manifest.schema.json` is where that manifest is rejected.
    const malformed = { longTerm: 'yes', scratchpad: 1 } as unknown as { longTerm?: boolean; scratchpad?: boolean };
    expect(requestedMemoryDimensions(malformed)).toEqual([]);
    expect(projectMemoryDegradation(malformed)).toEqual({});
  });

  it('only the three memoryShape-reachable names can ever be requested', () => {
    // Closed-world in the other direction: the five dimensions no `memoryShape`
    // can express must never appear in a request, whatever shape is supplied.
    const everyShape = [
      { scratchpad: true, conversation: true, longTerm: true },
      { scratchpad: true }, { conversation: true }, { longTerm: true }, {},
    ];
    const seen = new Set<MemoryDimension>();
    for (const shape of everyShape) for (const d of requestedMemoryDimensions(shape)) seen.add(d);
    expect([...seen].sort()).toEqual(['long-term-durability', 'read', 'write']);
  });
});

describe('RFC 0080 §C — the projection, per tier', () => {
  it('DEGRADED on the default tier: a longTerm agent loses long-term-durability', () => {
    defaultTier();
    expect(projectMemoryDegradation({ scratchpad: true, conversation: true, longTerm: true })).toEqual({
      memoryDegraded: true,
      degradedMemoryDimensions: ['long-term-durability'],
    });
  });

  it('NOT degraded on the durable tier — and the fields are ABSENT, not false', () => {
    durableTier();
    // §C-1: "Absent ⇒ memory fully satisfied". `memoryDegraded: false` would also
    // validate but draws a distinction the RFC does not.
    const projection = projectMemoryDegradation({ scratchpad: true, conversation: true, longTerm: true });
    expect(projection).toEqual({});
    expect(Object.hasOwn(projection, 'memoryDegraded')).toBe(false);
    expect(Object.hasOwn(projection, 'degradedMemoryDimensions')).toBe(false);
  });

  it('a scratchpad-only agent is NOT degraded on either tier (read+write always hold)', () => {
    for (const tier of [defaultTier, durableTier]) {
      tier();
      expect(projectMemoryDegradation({ scratchpad: true })).toEqual({});
    }
  });

  it('the §C-1 iff holds structurally: stamped ⇒ non-empty, unique, closed-enum', () => {
    defaultTier();
    const shapes = [
      undefined, {}, { scratchpad: true }, { conversation: true }, { longTerm: true },
      { scratchpad: true, conversation: true, longTerm: true },
      { scratchpad: false, longTerm: true },
    ];
    let stampedAtLeastOnce = false;
    for (const shape of shapes) {
      const p = projectMemoryDegradation(shape);
      if (p.memoryDegraded === true) {
        stampedAtLeastOnce = true;
        expect(Array.isArray(p.degradedMemoryDimensions)).toBe(true);
        expect(p.degradedMemoryDimensions!.length).toBeGreaterThan(0);
        expect(new Set(p.degradedMemoryDimensions).size).toBe(p.degradedMemoryDimensions!.length);
        for (const d of p.degradedMemoryDimensions!) {
          expect(MEMORY_DIMENSIONS as readonly string[]).toContain(d);
        }
      } else {
        expect(p.degradedMemoryDimensions, 'a non-degraded entry carries no dimension list').toBeUndefined();
      }
    }
    // Non-vacuity: the degraded branch above must actually have run.
    expect(stampedAtLeastOnce, 'the loop MUST reach the degraded branch').toBe(true);
  });
});
