/**
 * ADR 0686 D1 (`CEWF-1`) — the code-exec node is replay-classified, so a `:fork` serves the
 * recorded result instead of re-running arbitrary user code in a paid sandbox.
 *
 * Born red: `feature.code-exec.nodes.run` was `role:"action"` with NO `capabilities` key, so it
 * sat in `MANIFEST_DECLARED_TYPE_IDS` alone and `isSideEffectingNode` returned false. Its own
 * docblock claimed, in capitals, that replay/fork "NEVER re-execute" — the same false inference
 * from `role:"action"` that ADR 0673/0676/0678/0679 corrected elsewhere, on the highest-stakes
 * node in the corpus.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MANIFEST_SIDE_EFFECT_FLOOR, MANIFEST_FAST_PATH_SERVED } from '../src/executor/sideEffectFloor.generated.js';
import { isSideEffectingNode } from '../src/executor/sideEffects.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TYPE_ID = 'feature.code-exec.nodes.run';
const PACK = JSON.parse(readFileSync(join(REPO, 'packs', 'feature.code-exec.nodes', 'pack.json'), 'utf8')) as {
  version: string; nodes: { typeId: string; version: string; capabilities?: string[] }[];
};

describe('ADR 0686 D1 — a fork must not re-run sandboxed code', () => {
  it('leg 1: the node is in the floor AND served — classification must SERVE, not merely mark', () => {
    expect(MANIFEST_SIDE_EFFECT_FLOOR.has(TYPE_ID), 'floor').toBe(true);
    expect(MANIFEST_FAST_PATH_SERVED.has(TYPE_ID), 'served').toBe(true);
    expect(isSideEffectingNode(TYPE_ID), 'every arm must agree').toBe(true);
  });

  it('leg 2: the manifest declares the capability, and the pack + node versions moved together', () => {
    const n = PACK.nodes.find((x) => x.typeId === TYPE_ID);
    expect(n?.capabilities ?? [], 'role:"action" confers nothing — the capability is what binds').toContain('side-effectful');
    expect(PACK.version).toBe('1.1.0');
    expect(n?.version).toBe('1.1.0');
  });

  it('leg 3: the feature pin moves in lockstep (RFC 0076 replay resolvability)', () => {
    const feature = readFileSync(join(REPO, 'backend', 'typescript', 'src', 'features', 'code-exec', 'feature.ts'), 'utf8');
    expect(feature).toContain(`{ name: 'feature.code-exec.nodes', version: '${PACK.version}' }`);
  });

  it('leg 4: the docblock no longer asserts a guarantee the manifest does not provide', () => {
    const src = readFileSync(join(REPO, 'packs', 'feature.code-exec.nodes', 'index.mjs'), 'utf8');
    // The retired sentence survives in the file ON PURPOSE — this repo corrects claims rather
    // than rewriting them, so the reasoning trail stays readable. A blunt `not.toContain` went
    // red against my own correction note (the second time this trap has bitten this session).
    // So assert the POSITION instead: the sentence may appear only as a QUOTED retired claim,
    // never as a live one.
    const RETIRED = 'read the recorded result and NEVER re-execute';
    const at = src.indexOf(RETIRED);
    if (at !== -1) {
      const preamble = src.slice(Math.max(0, at - 400), at);
      expect(preamble, 'the retired claim may appear only inside a correction that disowns it')
        .toMatch(/used to claim|CORRECTED/);
      expect(src.indexOf(RETIRED, at + RETIRED.length), 'it must appear ONCE, quoted').toBe(-1);
    }
    // And the corrected text must name what actually binds, so the next reader checks the
    // manifest rather than the role.
    expect(src).toMatch(/capabilities:\s*\["side-effectful"\]/);
  });

  it('leg 5: the in-process-runtime claim is corrected too — the sandbox ladder has three rungs', () => {
    const src = readFileSync(join(REPO, 'packs', 'feature.code-exec.nodes', 'index.mjs'), 'utf8');
    expect(src, 'Phase 8 added an opt-in in-process WASI rung').not.toContain('there is no in-process\n * runtime by design');
    // Non-vacuity in the other direction: honest-off is NOT being weakened — the claim that an
    // unconfigured host throws `capability_not_provided` must survive.
    expect(src).toContain('capability_not_provided');
  });
});
