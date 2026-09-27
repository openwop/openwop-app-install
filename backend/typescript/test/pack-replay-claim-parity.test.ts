/**
 * GEN-AKM-1 — a `role:"action"` docblock is not a replay guarantee.
 *
 * THE FAMILY. `git grep "role === 'action'" -- src/executor/` returns **zero**:
 * the executor never reads a node's `role`. Only the floor GENERATOR reads it, and
 * it reads `side-effect`. So a manifest description that says *"side-effect
 * recorded; replay/fork read the recorded result"* is asserting a mechanism the
 * host does not implement for that node unless the node is a MEMBER of
 * `MANIFEST_FAST_PATH_SERVED`. Three separate feature grades found this same
 * false claim independently (WF-AKM-1, WF-BOA-1, WF-COS-3); each time the prose
 * and the set disagreed silently and each time a `:fork` duplicated a real effect.
 *
 * THE GATE. Any node whose manifest description CLAIMS the recorded-outcome
 * mechanism must actually be served. This polices the INVARIANT (prose ⇒
 * membership), not a spelling: renaming the node, moving the sentence, or editing
 * `sideEffects.ts` cannot make it pass while the claim and the set disagree.
 *
 * MEASURED BEFORE ENFORCING (2026-08-19, 737 manifest nodes): exactly 2 nodes make
 * the claim and neither is served. Both are pre-existing findings from OTHER
 * feature grades and are out of this batch's scope, so they are QUARANTINED by
 * name and the ceiling is SHRINK-ONLY. A green run over an empty quarantine would
 * be a gate that had never been tested; a red main would be worse. Removing an
 * entry requires the two-leg #2871 fix on that pack, and the entry may never be
 * re-added.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MANIFEST_FAST_PATH_SERVED } from '../src/executor/sideEffectFloor.generated.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const PACKS = join(REPO, 'packs');

/**
 * The recorded-outcome MECHANISM claim, not the word "replay". A pure read that
 * says "read-only; replay-safe" is honest and is deliberately NOT matched — it is
 * replay-safe by nature, not because anything serves it. Verified: widening this
 * to /replay[- ]?safe/ matches 10 nodes, 8 of which are honest pure reads.
 */
const RECORDED_OUTCOME_CLAIM = /recorded\s*(→|->|;|,)?\s*replay|replay\/fork read the recorded|read the recorded result|side-effect recorded/i;

/**
 * SHRINK-ONLY. Nodes that make the claim and are not served. Each is a live
 * finding on another feature, tracked in `docs/steward/WORKFLOWS-ASSESSMENT.md`.
 * Fix = the #2871 two legs on that pack (`role:"side-effect"` + `side-effectful`
 * in its manifest AND an explicit typeId entry in `executor/sideEffects.ts`),
 * then delete the line. NEVER add to this list.
 */
const QUARANTINE: ReadonlySet<string> = new Set([
  'feature.assistant.nodes.log-decision', // WF-COS-3 family
  'feature.commerce.nodes.create-order', // same claim, `role:action (recorded → replay-safe)`
]);

interface ManifestNode {
  typeId: string;
  description?: string;
}

function claimingNodes(): string[] {
  const out: string[] = [];
  for (const dir of readdirSync(PACKS)) {
    const p = join(PACKS, dir, 'pack.json');
    if (!existsSync(p)) continue;
    let parsed: { nodes?: ManifestNode[] };
    try {
      parsed = JSON.parse(readFileSync(p, 'utf8')) as { nodes?: ManifestNode[] };
    } catch {
      continue;
    }
    for (const n of parsed.nodes ?? []) {
      if (typeof n?.typeId === 'string' && RECORDED_OUTCOME_CLAIM.test(n.description ?? '')) out.push(n.typeId);
    }
  }
  return out;
}

describe('GEN-AKM-1 — a manifest that CLAIMS the recorded-outcome mechanism must be served', () => {
  it('the scan is non-vacuous: it reads a real, populated manifest corpus', () => {
    // A gate whose denominator is zero reports green having examined nothing —
    // the single most reliable tell that a check is inert.
    let nodes = 0;
    for (const dir of readdirSync(PACKS)) {
      const p = join(PACKS, dir, 'pack.json');
      if (!existsSync(p)) continue;
      try {
        nodes += ((JSON.parse(readFileSync(p, 'utf8')) as { nodes?: unknown[] }).nodes ?? []).length;
      } catch {
        /* a malformed pack is another test's problem */
      }
    }
    expect(nodes).toBeGreaterThan(500);
    // …and the regex it uses actually matches something in that corpus.
    expect(claimingNodes().length).toBeGreaterThan(0);
  });

  it('every claiming node is in MANIFEST_FAST_PATH_SERVED, or is quarantined by name', () => {
    const unserved = claimingNodes().filter((t) => !MANIFEST_FAST_PATH_SERVED.has(t));
    const novel = unserved.filter((t) => !QUARANTINE.has(t));
    expect(novel, 'a NEW node claims replay/fork reads its recorded result but nothing serves it').toEqual([]);
  });

  it('SHRINK-ONLY: the quarantine never grows, and a fixed entry must be deleted', () => {
    const unserved = new Set(claimingNodes().filter((t) => !MANIFEST_FAST_PATH_SERVED.has(t)));
    expect(unserved.size).toBeLessThanOrEqual(QUARANTINE.size);
    // A quarantined entry that is now served is a STALE entry — delete it, so the
    // list can only ever shrink and cannot rot into a permanent allowlist.
    const stale = [...QUARANTINE].filter((t) => !unserved.has(t));
    expect(stale, 'these are fixed — remove them from QUARANTINE').toEqual([]);
  });
});
