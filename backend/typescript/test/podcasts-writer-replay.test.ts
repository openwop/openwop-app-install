/**
 * ADR 0679 — podcast writer classification, the deterministic Document mint, and a leg that
 * PROVES why two of the writers are deliberately left undeclared.
 *
 * Born red on three counts: all five nodes were `role:"action"` with no `capabilities` key;
 * `writeDocument` passed no `documentId` and keyed `addVersion` off `ctx.runId`, so every
 * replay/fork/retry leaked a duplicate outline AND transcript Document; and the pack asserted
 * the opposite in three places, one of which (`pack.json`'s description) named the synthesizer
 * specifically — the node with no recorded-result path at all.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MANIFEST_SIDE_EFFECT_FLOOR, MANIFEST_FAST_PATH_SERVED } from '../src/executor/sideEffectFloor.generated.js';
import { isSideEffectingNode } from '../src/executor/sideEffects.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const P = 'feature.podcasts.nodes.';
const PACK = JSON.parse(readFileSync(join(REPO, 'packs', 'feature.podcasts.nodes', 'pack.json'), 'utf8')) as {
  version: string; description: string; nodes: { typeId: string; version: string; capabilities?: string[] }[];
};

describe('ADR 0679 D1 — the servable writers are served', () => {
  it('leg 1: mix and synthesize are in the floor AND served', () => {
    for (const n of ['mix', 'synthesize']) {
      expect(MANIFEST_SIDE_EFFECT_FLOOR.has(P + n), n).toBe(true);
      expect(MANIFEST_FAST_PATH_SERVED.has(P + n), `${n} must be SERVED, not merely declared`).toBe(true);
      expect(isSideEffectingNode(P + n), n).toBe(true);
    }
  });

  it('leg 2: every node declares a capabilities array — absence must be a decision', () => {
    expect(PACK.nodes.length).toBe(5);
    for (const n of PACK.nodes) expect(Array.isArray(n.capabilities), n.typeId).toBe(true);
  });

  it('leg 3: the pack and the two changed nodes moved version together', () => {
    expect(PACK.version).toBe('1.1.0');
    const by = new Map(PACK.nodes.map((n) => [n.typeId, n]));
    expect(by.get(P + 'mix')?.version).toBe('1.3.0');
    expect(by.get(P + 'synthesize')?.version).toBe('1.2.0');
    const feature = readFileSync(join(REPO, 'backend', 'typescript', 'src', 'features', 'podcasts', 'feature.ts'), 'utf8');
    expect(feature, 'the pin moves in lockstep or replay resolvability breaks (RFC 0076)')
      .toContain(`{ name: 'feature.podcasts.nodes', version: '${PACK.version}' }`);
  });
});

describe('ADR 0679 D2 — outline/transcript are undeclared ON PURPOSE, and declaring them would be a NO-OP', () => {
  it('leg 4: they are NOT classified, and the reason is structural — not an oversight', () => {
    for (const n of ['outline', 'transcript']) {
      expect(isSideEffectingNode(P + n), `${n} is deliberately unclassified (ADR 0679 D2)`).toBe(false);
    }
  });

  it('leg 5: THE PROOF — a node whose reach is invocation-log is held OUT of the served set, so a declaration cannot serve it', async () => {
    // This is the leg that stops a future author "completing the pattern". `isSideEffectingNode`
    // consults ONLY `MANIFEST_FAST_PATH_SERVED` (`sideEffects.ts:266`); the floor is never read.
    // The generator routes an `invocation-log` reach into `held`, not `served`
    // (`gen-side-effect-floor.mjs:126`). So declaring `side-effectful` on outline/transcript
    // would move them into the floor and change NOTHING observable.
    const { buildImplIndex, classifyNodeReach } = await import(join(REPO, 'scripts', 'lib', 'packNodeReach.mjs')) as {
      buildImplIndex: (root: string) => unknown; classifyNodeReach: (t: string, i: unknown) => { kind: string };
    };
    const idx = buildImplIndex(REPO);
    for (const n of ['outline', 'transcript']) {
      expect(classifyNodeReach(P + n, idx).kind, `${n} reaches ctx.callAI`).toBe('invocation-log');
    }
    for (const n of ['mix', 'synthesize']) {
      expect(classifyNodeReach(P + n, idx).kind, `${n} is servable`).toBe('no-ai-reach');
    }
    // And the corpus proves the holdback is real, not theoretical:
    const held = [...MANIFEST_SIDE_EFFECT_FLOOR].filter((t) => !MANIFEST_FAST_PATH_SERVED.has(t));
    expect(held.length, 'nodes declared side-effecting that isSideEffectingNode still reports FALSE for').toBeGreaterThan(0);
  });
});

describe('ADR 0679 D2b — the Document mint is content-derived, not runId-derived', () => {
  const loadNodes = async () => {
    const mod = await import(join(REPO, 'packs', 'feature.podcasts.nodes', 'index.mjs'));
    return (mod.nodes ?? mod.default) as Record<string, (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown> }>>;
  };
  /** Minimal podcasts + documents surfaces; records every document container minted. */
  const harness = () => {
    const minted: string[] = [];
    let owner: unknown;
    const episode = { id: 'ep1', orgId: 'o1', title: 'Ep', notebookId: 'nb1' };
    return {
      minted, get owner() { return owner; },
      ctxFor: (runId: string, text: string) => ({
        runId, nodeId: 'outline',
        inputs: { episodeId: 'ep1', outline: text, turns: [] },
        // The surface WRAPS: getEpisode -> { episode }, getEpisodeProfile -> { profile }.
        // An unwrapped stub makes `resolveConfig` return a null episode, the node returns
        // `episodeMissing`, and `writeDocument` never runs — which presents as a passing
        // "0 documents minted" rather than as a broken fixture.
        callAI: async () => ({ content: text }),
        features: {
          podcasts: {
            getEpisode: async () => ({ episode }),
            getEpisodeProfile: async () => ({ profile: { speakerProfileId: 'sp1' } }),
            getSpeakerProfile: async () => ({ profile: { speakers: [] } }),
            recordEpisodeResult: async () => ({ found: true, recorded: true }),
          },
          documents: {
            createDocument: async (a: { documentId?: string; ownerSubject?: unknown }) => {
              const id = a.documentId ?? `doc:${Math.random()}`;
              owner = a.ownerSubject;
              if (!minted.includes(id)) minted.push(id);
              return { document: { documentId: id } };
            },
            addVersion: async () => ({ version: { versionId: 'v1', version: 1 } }),
          },
        },
      }),
    };
  };

  it('leg 6: the SAME content under DIFFERENT runIds mints ONE document — the old key could never do this', async () => {
    const nodes = await loadNodes(); const h = harness();
    const a = await nodes[P + 'outline']!(h.ctxFor('run-A', 'the same outline body'));
    const b = await nodes[P + 'outline']!(h.ctxFor('run-B', 'the same outline body'));
    // Floor: a broken fixture would mint 0 documents and read as a pass otherwise.
    expect(a.status, 'the node must actually have run').toBe('success');
    expect(b.status).toBe('success');
    expect(h.minted.length, 'a fork changes runId; the document must not change').toBe(1);
    expect(h.minted[0]).toMatch(/^doc:podcast-outline:[0-9a-f]{32}$/);
    // Non-vacuity: different content MUST mint a different container.
    await nodes[P + 'outline']!(h.ctxFor('run-A', 'a DIFFERENT outline body'));
    expect(h.minted.length).toBe(2);
  });

  it('leg 7: ownerSubject survives — the ADR 0166 owner would have dropped it', async () => {
    const nodes = await loadNodes(); const h = harness();
    const r = await nodes[P + 'outline']!(h.ctxFor('run-A', 'body'));
    expect(r.status, 'the node must actually have run').toBe('success');
    expect(h.owner).toEqual({ kind: 'project', id: 'nb1' });
  });

  it('leg 8: no call site can reintroduce a runId — the base is computed inside writeDocument', () => {
    const src = readFileSync(join(REPO, 'packs', 'feature.podcasts.nodes', 'index.mjs'), 'utf8');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
    expect(code, 'runId must not appear in executable code').not.toMatch(/ctx\.runId/);
    expect(code).toMatch(/createHash\('sha256'\)/);
  });

  it('leg 9: the pack no longer advertises a replay guarantee it does not provide', () => {
    expect(PACK.description, 'the old description named the synthesizer, the least protected node')
      .not.toContain('replay/fork read the recorded result rather than re-calling the model/synthesizer');
  });
});
