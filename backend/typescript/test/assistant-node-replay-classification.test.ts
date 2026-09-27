/**
 * WF-COS-2 / WF-COS-3 — the assistant's non-convergent nodes are classified, on
 * both legs, and the pack no longer claims a replay guarantee the engine does not
 * implement.
 *
 * THE DOC DEFECT (WF-COS-3). `packs/feature.assistant.nodes/index.mjs` asserted
 * that `role:"action"` nodes are "recorded → replay/fork read the recorded
 * output". The executor never reads a node's `role` —
 * `git grep "role === 'action'" -- src/executor/` returns zero; the only readers
 * are the catalog builder, the review projector and the compose tool, all
 * presentational. A past-tense safety claim outliving its mechanism, on the
 * surface an author reads before trusting the node.
 *
 * THE CLASSIFICATION DEFECT (WF-COS-2). `compose-briefing` with
 * `config.notify:true` reaches `getNotificationEmitter` through the HOST SURFACE
 * (`features/assistant/surface.ts`), invisible in pack source — the same way
 * `feature.comments.nodes.post` did. It matched no pattern and sat in neither
 * effect set, so a `:fork` of `assistant.loop.morning-briefing` re-emitted a
 * durable Notifications row + Web Push. `enqueue-action` is the same family and
 * worse: it mints an `act:<uuid>` PLUS a host PendingApproval PLUS an
 * "approval needed" notification, i.e. a fork asks a human to approve an
 * outbound action a second time.
 *
 * WHAT THIS DOES NOT PROVE. It does not execute a run and fork it — that is
 * `PROBE-COS-2`, a live probe. It proves the predicate `executor.ts` branches on,
 * that BOTH independent legs are present (the #2871 lesson: a fix that lands one
 * leg looks identical to a fix that landed both), and that the corrected
 * docblock's specific falsehood cannot come back.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MANIFEST_SIDE_EFFECT_FLOOR, MANIFEST_FAST_PATH_SERVED } from '../src/executor/sideEffectFloor.generated.js';
import { isSideEffectingNode } from '../src/executor/sideEffects.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const CLASSIFIED = ['feature.assistant.nodes.compose-briefing', 'feature.assistant.nodes.enqueue-action'] as const;

describe('WF-COS-2 — the two non-convergent assistant nodes are classified on both legs', () => {
  it('leg 1: the pack manifest declares role side-effect AND the side-effectful capability', () => {
    const pack = JSON.parse(readFileSync(join(REPO, 'packs/feature.assistant.nodes/pack.json'), 'utf8')) as {
      version: string;
      nodes: Array<{ typeId: string; role?: string; capabilities?: string[] }>;
    };
    for (const typeId of CLASSIFIED) {
      const node = pack.nodes.find((n) => n.typeId === typeId);
      expect(node, `${typeId} not found in the manifest — this test would pass vacuously`).toBeTruthy();
      expect(node!.role, typeId).toBe('side-effect');
      expect(node!.capabilities ?? [], typeId).toContain('side-effectful');
    }
    // THE PACK RULE'S THIRD STEP. A bumped pack whose `requiredPacks` pin was not
    // bumped fetches the OLD content from the registry, so the flip above would
    // never reach a real host — green here, broken in production.
    const feature = readFileSync(join(REPO, 'backend/typescript/src/features/assistant/feature.ts'), 'utf8');
    expect(
      feature.includes(`{ name: 'feature.assistant.nodes', version: '${pack.version}' }`),
      `feature.ts must pin feature.assistant.nodes at ${pack.version} — the pin is the registry install target`,
    ).toBe(true);
  });

  it('leg 2: sideEffects.ts carries the explicit typeId pattern (independent of the manifest)', () => {
    const src = readFileSync(join(REPO, 'backend/typescript/src/executor/sideEffects.ts'), 'utf8');
    const patterns = /const SIDE_EFFECTING_TYPE_PATTERNS: readonly RegExp\[\] = \[([\s\S]*?)\n\];/.exec(src);
    expect(patterns, 'SIDE_EFFECTING_TYPE_PATTERNS literal not found — this gate is inert').toBeTruthy();
    expect(patterns![1]).toContain(String.raw`/^feature\.assistant\.nodes\.(compose-briefing|enqueue-action)$/`);
  });

  it('the derived floor holds them AND the fast path SERVES them', () => {
    // Floor membership alone is UNDISCHARGED — a "held" node still re-fires.
    for (const typeId of CLASSIFIED) {
      expect(MANIFEST_SIDE_EFFECT_FLOOR.has(typeId), typeId).toBe(true);
      expect(MANIFEST_FAST_PATH_SERVED.has(typeId), typeId).toBe(true);
    }
  });

  it('isSideEffectingNode — the exact predicate executor.ts branches on — returns true', () => {
    for (const typeId of CLASSIFIED) expect(isSideEffectingNode(typeId, null), typeId).toBe(true);
  });

  it('the CONVERGENT graph writers are deliberately NOT classified — a judgement, not an omission', () => {
    // Every id below is a tenant-folded content hash, so re-execution converges
    // on the same row, mints nothing and notifies nobody; `populate-board`
    // converges via the commitment's durable `kanbanCardId` back-ref. This is the
    // `feature.comments.nodes.resolve` precedent. Asserted so the judgement is a
    // pinned fact rather than a gap — and so that a future change which makes one
    // of them notify or mint a random id turns this red instead of shipping.
    for (const typeId of [
      'feature.assistant.nodes.upsert-commitment',
      'feature.assistant.nodes.ingest-commitments',
      'feature.assistant.nodes.log-decision',
      'feature.assistant.nodes.record-meeting',
      'feature.assistant.nodes.upsert-stakeholder',
      'feature.assistant.nodes.set-commitment-card',
      'feature.assistant.nodes.populate-board',
    ]) {
      expect(isSideEffectingNode(typeId, null), typeId).toBe(false);
    }
    // …and a pure read stays live on a fork.
    expect(isSideEffectingNode('feature.assistant.nodes.list-commitments', null)).toBe(false);
  });
});

describe('WF-COS-3 — the false replay claim is gone from the pack', () => {
  // WHOLE FILE, not `.slice(0, 4000)`. The first round hardened this regex
  // against REWORDING and left it unhardened against LOCATION: two more copies
  // of the same claim sat at bytes ~30k and ~32k of a 36.5 kB file, outside the
  // window, so the pack contradicted itself and the gate could not see it BY
  // CONSTRUCTION. A window is itself a way for an assertion to be vacuous.
  const SRC_PATH = join(REPO, 'packs/feature.assistant.nodes/index.mjs');
  const src = readFileSync(SRC_PATH, 'utf8');
  const header = src.slice(0, 4000);

  it('the reading window really is the whole file (the bug that hid the survivors)', () => {
    // If this file is ever re-sliced, this reddens rather than the coverage
    // quietly shrinking again.
    expect(src.length, 'the pack is ~36 kB — a 4 kB window covers ~11% of it').toBeGreaterThan(20_000);
    expect(src.length).toBe(readFileSync(SRC_PATH, 'utf8').length);
  });

  it('the specific falsehood cannot come back, ANYWHERE in the file', () => {
    // Assert the CLAIM is absent, not that some prose is present — a sentence can
    // be reworded and stay false (the EM-3 precedent).
    expect(
      /role:"action" nodes read\/write the tenant graph \(recorded → replay\/fork read the\s*\*?\s*recorded output\)/.test(src),
      'the pack must not claim `role:"action"` implies a replay-served output',
    ).toBe(false);
  });

  it('no section-level restatement of it survives either', () => {
    // The two survivors were PARAPHRASES in the reads/writes section banners, not
    // copies of the header sentence — so match the SHAPE of the claim (a
    // `replay/fork` that READS a RECORDED result) rather than its wording.
    //
    // Matched over NORMALIZED prose, not per line. A comment wraps at ~80 cols,
    // so a line-scoped detector splits both the claim and its negation across
    // lines and reports garbage — which is what it did on the first draft of
    // this very assertion. Strip the comment markers, collapse the whitespace,
    // then require every surviving occurrence to sit inside an explicitly
    // NEGATING sentence (the header quotes the old claim in order to correct it,
    // and each section banner now does the same).
    const prose = src.replace(/^\s*(?:\/\/|\*|\/\*\*?)\s?/gm, ' ').replace(/\s+/g, ' ');
    const offenders: string[] = [];
    for (const m of prose.matchAll(/replay\/fork\s+(?:read|reads)/g)) {
      const before = prose.slice(Math.max(0, m.index - 220), m.index);
      if (/\bNOT\b|\bnot\b mean|used to|no longer|does NOT/.test(before)) continue;
      offenders.push(prose.slice(Math.max(0, m.index - 120), m.index + 90));
    }
    expect(
      offenders,
      'a `role:"action"` node is NOT served from a recording — say what the replay actually does',
    ).toEqual([]);
  });

  it('and the header names the mechanism that actually governs a replay', () => {
    // A maintainer reading only the pack must be able to find the real seam.
    expect(header).toContain('isSideEffectingNode');
    expect(header).toContain('MANIFEST_FAST_PATH_SERVED');
    expect(header).toContain('side-effectful');
  });

  it('pack.json does not restate the claim either (nodeCatalogBuilder surfaces it)', () => {
    // The third copy. `nodeCatalogBuilder.ts` surfaces node-level descriptions,
    // so a falsehood here reaches a model, not just a maintainer.
    const manifest = readFileSync(join(REPO, 'packs/feature.assistant.nodes/pack.json'), 'utf8');
    expect(/replay-safe|replay\/fork read|recorded →/.test(manifest), 'pack.json must not claim role:action ⇒ replay-served').toBe(false);
  });

  it('the executor really does not read `role` (the premise this correction rests on)', () => {
    // A premise nobody enforces is how the original claim survived. If the
    // executor ever DOES branch on `role`, this reddens and the header's
    // correction needs revisiting rather than silently becoming wrong again.
    const executorSrc = ['executor.ts', 'scheduler.ts', 'sideEffects.ts']
      .map((f) => readFileSync(join(REPO, 'backend/typescript/src/executor', f), 'utf8'))
      .join('\n');
    expect(/\brole\s*===\s*['"]action['"]/.test(executorSrc)).toBe(false);
  });
});
