/**
 * replay.md requirement 4 — the DERIVED floor snapshot, pinned inside the
 * backend suite as well as in `scripts/ci.sh`.
 *
 * `gen-side-effect-floor.mjs --check` already regenerates from the manifests
 * and fails on drift, so the committed file cannot lie about what the manifests
 * say. This suite adds the two things that check cannot:
 *
 *   1. It runs under a bare `npm test`, not only the full `npm run ci` lane.
 *   2. It asserts the SEMANTIC property rather than byte-equality — every
 *      member really does declare `side-effect` or the `side-effectful`
 *      capability, and the set is not empty.
 *
 *   3. Since ADR 0572 P3 — that the DERIVED served subset is what
 *      `isSideEffectingNode` consults, and that it excludes every node whose
 *      discharge is the ADR 0326 invocation log (the RFC 0041 §B guard).
 *
 * WHAT THIS DOES NOT CLAIM. Floor membership is still not coverage: 43 floor
 * typeIds are held back from the served set and remain UNDISCHARGED — safe via
 * the ADR 0531 backstop, counted by the ADR 0572 ratchet, and NOT replayable
 * to a successful outcome. A green here means the derivation and the wiring are
 * honest, not that requirement 4 is fully discharged.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST_SIDE_EFFECT_FLOOR, MANIFEST_DECLARED_TYPE_IDS, MANIFEST_FAST_PATH_SERVED } from '../src/executor/sideEffectFloor.generated.js';
import { isSideEffectingNode } from '../src/executor/sideEffects.js';

const PACKS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packs');

interface Declared { typeId: string; role: string | null; caps: string[] }

function scanManifests(): Declared[] {
  // NOT `if (!exists) return []` — an absent packs dir would make every
  // assertion below pass against nothing. In a checkout it is always present,
  // so its absence is a broken harness and must say so.
  expect(existsSync(PACKS), `packs dir missing at ${PACKS} — this suite would pass vacuously`).toBe(true);
  const out: Declared[] = [];
  const seen = new Set<string>();
  for (const dir of readdirSync(PACKS)) {
    const manifest = join(PACKS, dir, 'pack.json');
    if (!existsSync(manifest)) continue;
    let json: { nodes?: Array<{ typeId?: string; id?: string; role?: unknown; capabilities?: unknown }> };
    try {
      json = JSON.parse(readFileSync(manifest, 'utf8'));
    } catch {
      continue;
    }
    for (const n of json.nodes ?? []) {
      const typeId = n.typeId ?? n.id;
      if (typeof typeId !== 'string' || seen.has(typeId)) continue;
      seen.add(typeId);
      out.push({
        typeId,
        role: typeof n.role === 'string' ? n.role : null,
        caps: Array.isArray(n.capabilities) ? (n.capabilities as unknown[]).filter((c): c is string => typeof c === 'string') : [],
      });
    }
  }
  return out;
}

const ROLES = new Set(['pure', 'read', 'gate', 'action', 'side-effect', 'streaming-output']);

describe('replay.md req 4 — the manifest-derived side-effect floor', () => {
  it('the scan finds manifests at all', () => {
    // The vacuity guard for every test below it.
    const declared = scanManifests();
    expect(declared.length).toBeGreaterThan(100);
    expect(MANIFEST_SIDE_EFFECT_FLOOR.size).toBeGreaterThan(0);
    expect(MANIFEST_DECLARED_TYPE_IDS.size).toBe(declared.length);
  });

  it('every manifest node declares a role from the closed taxonomy', () => {
    // The build gate's assertion, restated where `npm test` can see it. A
    // missing or typo'd role must never resolve to a safe default: that is how
    // `core.storage.blob-put` (ADR 0563) was treated as pure while its own
    // manifest said `side-effect`.
    const bad = scanManifests()
      .filter((d) => d.role === null || !ROLES.has(d.role))
      .map((d) => `${d.typeId} role=${d.role ?? '(absent)'}`);
    expect(bad, 'run: node scripts/gen-side-effect-floor.mjs').toEqual([]);
  });

  it('the snapshot is exactly role `side-effect` UNION the `side-effectful` capability', () => {
    const declared = scanManifests();
    const expected = declared
      .filter((d) => d.role === 'side-effect' || d.caps.includes('side-effectful'))
      .map((d) => d.typeId)
      .sort();
    expect([...MANIFEST_SIDE_EFFECT_FLOOR].sort()).toEqual(expected);
  });

  it('the capability is the WIDER signal — the union is strictly larger than role alone', () => {
    // Load-bearing, not trivia: binding role alone would silently drop every
    // node that declares `side-effectful` under `action`/`gate`/
    // `streaming-output`. Requirement 4 permits classifying MORE, never fewer,
    // so the union is the honest floor. If this ever equalises, the union has
    // stopped doing anything and someone should know.
    const declared = scanManifests();
    const roleOnly = declared.filter((d) => d.role === 'side-effect').length;
    expect(MANIFEST_SIDE_EFFECT_FLOOR.size).toBeGreaterThan(roleOnly);
  });

  it('the two known drift cases are IN the floor (ADR 0563 + the ADR 0533 correction)', () => {
    // Both shipped a replay that re-fired a real effect while the manifest said
    // `side-effect` and nothing read it. They are the regression anchors.
    expect(MANIFEST_SIDE_EFFECT_FLOOR.has('core.storage.blob-put')).toBe(true);
    for (const t of [
      'core.openwop.http.openapi-call',
      'core.openwop.http.graphql-mutation',
      'core.openwop.http.upload-multipart',
    ]) {
      expect(MANIFEST_SIDE_EFFECT_FLOOR.has(t), `${t} missing from the floor`).toBe(true);
      // And the classifier already covers these — the one place the two
      // mechanisms are required to agree today.
      expect(isSideEffectingNode(t), `${t} lost its classification`).toBe(true);
    }
  });

  it('the derived served set IS the classifier — the wiring is live (ADR 0572 P3)', () => {
    // P2 shipped this suite asserting the OPPOSITE ("the gap exists"), and said
    // closing it should require deleting that test. This is that deletion.
    const unwired = [...MANIFEST_FAST_PATH_SERVED].filter((t) => !isSideEffectingNode(t));
    expect(unwired, 'a derived served typeId that the classifier does not classify').toEqual([]);
    expect(MANIFEST_FAST_PATH_SERVED.size).toBeGreaterThan(100);
  });

  it('the union ADDS coverage the hand-list never had — not a restatement of it', () => {
    // The failure this catches is a wiring that compiles, passes, and changes
    // nothing: if every derived member were already matched by a regex, the
    // union would be decoration and requirement 4 would still be unmet. Named
    // anchors, because a bare count could be satisfied by the legacy list
    // growing instead.
    for (const t of ['core.storage.table-insert', 'core.files.write', 'core.db.sql-execute']) {
      expect(MANIFEST_FAST_PATH_SERVED.has(t), `${t} is not in the derived served set`).toBe(true);
      expect(isSideEffectingNode(t), `${t} is not classified`).toBe(true);
    }
  });

  it('NO invocation-log node is fast-pathed — the RFC 0041 §B guard', () => {
    // THE load-bearing assertion of P3, and the one thing a blind union gets
    // wrong. A typeId whose discharge is the ADR 0326 invocation log must keep
    // RE-EXECUTING on a replay: the node runs, the log serves the provider call
    // from the SOURCE run, and divergence injection still has something to
    // diverge. Classifying it would short-circuit `module.execute` and make
    // divergence detection vacuously green — which is a silent loss, the worst
    // kind. `core.openwop.ai.*` are the fifteen the generated header names.
    for (const t of [
      'core.ai.chatCompletion',
      'core.ai.structuredOutput',
      'core.openwop.ai.classify',
      'core.openwop.ai.extract',
      'core.openwop.ai.transform',
      'core.openwop.ai.embeddings',
    ]) {
      expect(MANIFEST_SIDE_EFFECT_FLOOR.has(t), `${t} should be in the floor`).toBe(true);
      expect(
        MANIFEST_FAST_PATH_SERVED.has(t),
        `${t} reaches ctx.callAI — the invocation log is its discharge; fast-pathing it kills RFC 0041 §B divergence injection`,
      ).toBe(false);
      expect(isSideEffectingNode(t), `${t} must keep re-executing on a replay`).toBe(false);
    }
  });

  it('the floor is still LARGER than the served set — held-back nodes are not exempt', () => {
    // The served set is a subset by construction; if it ever equalled the floor
    // without the ratchet reaching zero, something stopped subtracting. An
    // absent typeId means "not yet served", never "safe to re-execute": at
    // runtime it still reaches an ADR 0531 seam and throws.
    expect(MANIFEST_FAST_PATH_SERVED.size).toBeLessThan(MANIFEST_SIDE_EFFECT_FLOOR.size);
    for (const t of MANIFEST_FAST_PATH_SERVED) {
      expect(MANIFEST_SIDE_EFFECT_FLOOR.has(t), `${t} is served but not in the floor`).toBe(true);
    }
  });
});
