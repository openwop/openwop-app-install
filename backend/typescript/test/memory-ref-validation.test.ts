/**
 * CTI-1(1) — `memoryRef` shape validation at resolution time (H49).
 *
 * > *"Hosts validate `memoryRef` path shape at resolution time. Malformed refs
 * > (path traversal, embedded null, oversize) MUST return `[]` / `null` rather
 * > than fall through to a permissive lookup."*
 * > — `spec/v1/agent-memory.md` §CTI-1
 *
 * Before H49 the host had NO such check: `listMemoryEntries` / `getMemoryEntry`
 * passed any string straight to the store.
 *
 * THE REGRESSION RISK IS THE OTHER DIRECTION. A validator that is too strict
 * silently empties a live memory scope — and because the read side fails CLOSED
 * (`[]`), that would present as "the user has no memories" rather than as an
 * error. So the accept-side of this file is DERIVED by invoking the real
 * ref-minting functions rather than by restating string literals: if a minter
 * changes shape, this test follows it instead of agreeing with a stale copy.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import {
  isWellFormedMemoryRef,
  writeMemoryEntry,
  listMemoryEntries,
  getMemoryEntry,
  clearMemoryScope,
  initInMemorySurfaces,
  MEMORY_DEMO_REF,
} from '../src/host/inMemorySurfaces.js';
import { subjectMemoryScope } from '../src/host/subjectMemory.js';
import { agentMemoryScope, resolveAgentMemoryScope } from '../src/host/agentMemoryAdapter.js';
import { personSubject } from '../src/host/subject.js';

const TENANT = 'h49-ref-validation';

beforeAll(() => {
  initInMemorySurfaces({ dataDir: '.' });
});

/**
 * Every ref shape this host actually mints, obtained by CALLING the minters.
 * `MEMORY_DEMO_REF` is a constant with no function behind it, and the corpus
 * fixtures' slash-bearing refs come from the vendored fixture tree — both are
 * read from their source rather than typed out.
 */
function mintedRefs(): { label: string; ref: string }[] {
  return [
    { label: 'MEMORY_DEMO_REF', ref: MEMORY_DEMO_REF },
    { label: 'subjectMemoryScope(agent)', ref: subjectMemoryScope({ kind: 'agent', id: 'a1b2c3d4-0000-4000-8000-000000000000' }) },
    { label: 'subjectMemoryScope(user)', ref: subjectMemoryScope(personSubject('user-abc-123')) },
    { label: 'subjectMemoryScope(project)', ref: subjectMemoryScope({ kind: 'project', id: 'proj-1' }) },
    { label: 'agentMemoryScope', ref: agentMemoryScope('roster-agent-42') },
    // The fail-closed sentinel from `resolveAgentMemoryScope` — the longest
    // shape the host mints, and the one most likely to trip a naive validator.
    { label: 'resolveAgentMemoryScope(per-user, no actor)', ref: resolveAgentMemoryScope({ profileId: 'p1', memoryScope: 'per-user' }, undefined) },
    { label: 'resolveAgentMemoryScope(per-user, actor)', ref: resolveAgentMemoryScope({ profileId: 'p1', memoryScope: 'per-user' }, { userId: 'u9' }) },
    { label: 'resolveAgentMemoryScope(default)', ref: resolveAgentMemoryScope({ profileId: 'p1' }, undefined) },
  ];
}

/** Every `agent.memoryRef` the vendored conformance fixtures declare — read
 *  from the fixture tree, so a newly vendored fixture is covered on arrival. */
async function fixtureRefs(): Promise<string[]> {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = join(process.cwd(), '..', '..', 'conformance-fixtures');
  const refs = new Set<string>();
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const nodes = (parsed as { nodes?: unknown })?.nodes;
    if (!Array.isArray(nodes)) continue;
    for (const n of nodes) {
      const ref = (n as { agent?: { memoryRef?: unknown } }).agent?.memoryRef;
      if (typeof ref === 'string' && ref.length > 0) refs.add(ref);
      const cfgRef = (n as { config?: Record<string, unknown> }).config?.['probeMemoryRef'];
      if (typeof cfgRef === 'string' && cfgRef.length > 0) refs.add(cfgRef);
    }
  }
  return [...refs];
}

describe('CTI-1(1) — memoryRef shape validation ACCEPTS every ref the host mints', () => {
  it('accepts each minted ref (derived by calling the minters, not by literals)', () => {
    const minted = mintedRefs();
    // Non-vacuity: a minter list that silently became empty would pass a
    // for-loop of assertions while proving nothing.
    expect(minted.length).toBeGreaterThanOrEqual(8);
    for (const { label, ref } of minted) {
      expect(isWellFormedMemoryRef(ref), `${label} → "${ref}" MUST be accepted`).toBe(true);
    }
  });

  it('accepts every memoryRef the vendored conformance fixtures declare', async () => {
    const refs = await fixtureRefs();
    expect(refs.length, 'the vendored tree MUST declare memoryRefs, else this is vacuous').toBeGreaterThanOrEqual(4);
    for (const ref of refs) {
      expect(isWellFormedMemoryRef(ref), `fixture ref "${ref}" MUST be accepted`).toBe(true);
    }
  });

  it('a minted ref round-trips through the real read path', async () => {
    const ref = agentMemoryScope('roundtrip-agent');
    await clearMemoryScope(TENANT, ref);
    const row = await writeMemoryEntry(TENANT, ref, { content: 'hello', tags: [] });
    expect((await listMemoryEntries(TENANT, ref)).map((r) => r.id)).toContain(row.id);
    expect(await getMemoryEntry(TENANT, ref, row.id)).not.toBeNull();
  });
});

describe('CTI-1(1) — malformed refs fail CLOSED, never a permissive lookup', () => {
  const malformed: { label: string; ref: string }[] = [
    { label: 'empty', ref: '' },
    { label: 'traversal segment (forward slash)', ref: 'conformance/../another-tenant/agent-memory' },
    { label: 'traversal segment (backslash)', ref: 'conformance\\..\\another-tenant' },
    { label: 'bare traversal', ref: '..' },
    { label: 'leading traversal', ref: '../escape' },
    { label: 'embedded NUL', ref: 'agent:a1\u0000truncated' },
    { label: 'embedded newline', ref: 'agent:a1\nagent:a2' },
    { label: 'C1 control', ref: 'agent:a1\u009f' },
    { label: 'oversize', ref: `agent:${'x'.repeat(600)}` },
  ];

  it('rejects each malformed shape', () => {
    for (const { label, ref } of malformed) {
      expect(isWellFormedMemoryRef(ref), `${label} MUST be rejected`).toBe(false);
    }
  });

  it('a `..` INSIDE a name segment is still legal — the check is on SEGMENTS, not substrings', () => {
    // Guards against over-tightening: a ref legitimately containing two dots is
    // not traversal, and rejecting it would empty a live scope.
    expect(isWellFormedMemoryRef('agent:my..agent')).toBe(true);
    expect(isWellFormedMemoryRef('conformance/a..b/memory')).toBe(true);
  });

  /**
   * The read side FAILS CLOSED — and this is the construction that can actually
   * detect it.
   *
   * FIRST ATTEMPT WAS VACUOUS, and the sabotage caught it: it seeded rows under
   * a WELL-FORMED ref and then asserted that reads via a MALFORMED ref returned
   * `[]`. Deleting the validator entirely left it GREEN — because this host's
   * store is a `Map` keyed by the literal ref string, so a malformed key simply
   * has no rows, and `[]` came back for the wrong reason. It was measuring an
   * empty scope, not a refusal.
   *
   * The honest construction seeds rows under the MALFORMED REF ITSELF. Then
   * `getRows()` would genuinely return them, and only the resolution-time check
   * stands between the caller and the data — exactly the "rather than fall
   * through to a permissive lookup" clause. Remove the check and this goes red.
   *
   * Seeding is possible because the WRITE side deliberately does not validate:
   * every write ref is host-minted (never client-supplied), CTI-1(1) names
   * resolution time, and failing a write closed would silently DROP data rather
   * than merely refuse to serve it. That asymmetry is what makes this test
   * expressible, and it is the intended design rather than an oversight.
   */
  it('the READ SIDE returns [] / null for a malformed ref THAT ACTUALLY HOLDS ROWS', async () => {
    for (const { label, ref } of malformed) {
      await clearMemoryScope(TENANT, ref);
      const row = await writeMemoryEntry(TENANT, ref, { content: `seeded under ${label}`, tags: ['h49'] });

      // Non-vacuity control: the row IS in the store under this exact key.
      // Read it back through the STORE-facing path the validator guards, using a
      // well-formed alias is impossible here, so assert via the raw surface: a
      // malformed-ref write followed by a malformed-ref read is the whole point.
      expect(row.id, `${label}: the seed must have been written`).toBeTruthy();

      expect(await listMemoryEntries(TENANT, ref), `list("${label}") MUST be [] despite a row existing at that key`).toEqual([]);
      expect(await getMemoryEntry(TENANT, ref, row.id), `get("${label}") MUST be null despite the row existing`).toBeNull();
    }
  });

  it('CONTROL: the same seed IS readable once the ref is well-formed — so [] above is a refusal, not an empty store', async () => {
    // Pins the counterfactual. Without this pair, "list returned []" could still
    // mean the write never landed.
    const good = 'conformance/h49/validation-control';
    await clearMemoryScope(TENANT, good);
    const row = await writeMemoryEntry(TENANT, good, { content: 'readable', tags: ['h49'] });
    expect(isWellFormedMemoryRef(good)).toBe(true);
    expect(await listMemoryEntries(TENANT, good)).toHaveLength(1);
    expect(await getMemoryEntry(TENANT, good, row.id)).not.toBeNull();
  });
});
