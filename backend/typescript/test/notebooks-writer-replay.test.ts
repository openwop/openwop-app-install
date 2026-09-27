/**
 * ADR 0678 D1 (`NBWF-8`) — the five notebooks durable writers are replay-classified, the nine
 * reads are deliberately not, and the transformation write dedupes at the MINT.
 *
 * Born red: all 14 nodes were `role:"action"` with NO `capabilities` key at all, so zero were
 * in `MANIFEST_SIDE_EFFECT_FLOOR` or `MANIFEST_FAST_PATH_SERVED` and a replay re-executed every
 * writer. The pack's own docblocks asserted the opposite in six places — including pack-wide at
 * `index.mjs:10-12` — which is what a reader checks instead of the manifest.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MANIFEST_SIDE_EFFECT_FLOOR, MANIFEST_FAST_PATH_SERVED } from '../src/executor/sideEffectFloor.generated.js';
import { isSideEffectingNode } from '../src/executor/sideEffects.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PACK = JSON.parse(readFileSync(join(REPO, 'packs', 'feature.notebooks.nodes', 'pack.json'), 'utf8')) as {
  version: string; nodes: { typeId: string; version: string; role: string; capabilities?: string[] }[];
};
const P = 'feature.notebooks.nodes.';

/** Named explicitly, NOT derived from the `capabilities` field under test — deriving them
 *  from it would make every leg below vacuous. Each was confirmed by reading its impl. */
const WRITERS = ['store-summary', 'write-transformation', 'ingest-source', 'mcp-add-source', 'mcp-create-note'].map((n) => P + n);
const READS = ['ask', 'search', 'read-source', 'list-notebooks', 'get-notebook', 'list-sources', 'list-notes'].map((n) => P + n);
/** Write no durable app state; classifying them would land them in the generator's
 *  invocation-log arm and report a discharge that does not hold for their egress half. */
const HELD_BACK = ['transcribe-source', 'fetch-youtube-source'].map((n) => P + n);

describe('ADR 0678 D1 — notebooks writer classification', () => {
  it('leg 1: all five writers are in the floor AND served, and every arm agrees', () => {
    for (const id of WRITERS) {
      expect(MANIFEST_SIDE_EFFECT_FLOOR.has(id), `${id} floor`).toBe(true);
      expect(MANIFEST_FAST_PATH_SERVED.has(id), `${id} served — classification must SERVE the replay, not just mark it`).toBe(true);
      expect(isSideEffectingNode(id), id).toBe(true);
    }
  });

  it('leg 2: the nine non-writers are NOT classified — the fix is scoped, not a prefix sweep', () => {
    for (const id of [...READS, ...HELD_BACK]) {
      expect(isSideEffectingNode(id), `${id} must stay unclassified`).toBe(false);
    }
  });

  it('leg 3: the manifest declares the capability on exactly the five', () => {
    const byId = new Map(PACK.nodes.map((n) => [n.typeId, n]));
    expect(PACK.nodes.length).toBe(14);
    for (const id of WRITERS) expect(byId.get(id)?.capabilities ?? [], id).toContain('side-effectful');
    for (const id of [...READS, ...HELD_BACK]) expect(byId.get(id)?.capabilities ?? [], id).not.toContain('side-effectful');
  });

  it('leg 4: EVERY node declares a capabilities array — absence must be a decision, not an omission', () => {
    // The state this ADR fixes was "nothing declares it", which `gen-side-effect-floor.mjs`
    // cannot detect: it fails closed only on a MISSING role, and "action" is a valid member of
    // the closed taxonomy. An explicit `[]` makes a read's non-classification reviewable.
    for (const n of PACK.nodes) {
      expect(Array.isArray(n.capabilities), `${n.typeId} must declare a capabilities array`).toBe(true);
    }
  });

  it('leg 5: the pack and the five changed nodes moved version together', () => {
    expect(PACK.version).toBe('1.1.0');
    const byId = new Map(PACK.nodes.map((n) => [n.typeId, n]));
    for (const id of WRITERS) expect(byId.get(id)?.version, id).toBe('1.1.0');
  });

  it('leg 6 (D1b): the transformation document id is CONTENT-derived, never runId-derived', async () => {
    const mod = await import(join(REPO, 'packs', 'feature.notebooks.nodes', 'index.mjs'));
    const nodes = (mod.nodes ?? mod.default) as Record<string, (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown> }>>;
    const minted: string[] = [];
    const docs = {
      createDocument: async (a: { documentId?: string; ownerSubject?: unknown }) => {
        const id = a.documentId ?? `doc:${Math.random()}`;
        if (!minted.includes(id)) minted.push(id);
        return { document: { documentId: id, ownerSubject: a.ownerSubject } };
      },
      addVersion: async () => ({ version: { versionId: 'v1', version: 1 } }),
    };
    const ctxFor = (content: string, runId: string) => ({
      runId, nodeId: 'write',
      inputs: { orgId: 'o1', title: 'T', kind: 'notebook-transformation', sourceId: 's1', content,
                ownerSubject: { kind: 'project', id: 'nb1' } },
      features: { documents: docs },
    });
    const a = await nodes['feature.notebooks.nodes.write-transformation']!(ctxFor('same body', 'run-A'));
    const b = await nodes['feature.notebooks.nodes.write-transformation']!(ctxFor('same body', 'run-B'));
    expect(a.outputs?.written).toBe(true);
    // A DIFFERENT runId must resolve the SAME document — that is the whole point, and the old
    // key (which embedded runId AND the fresh documentId) could never do it.
    expect(a.outputs?.documentId, 'a fork changes runId; the document must not change').toBe(b.outputs?.documentId);
    expect(minted.length, 'one body ⇒ one document').toBe(1);
    // Non-vacuity: different content MUST mint a different document.
    const c = await nodes['feature.notebooks.nodes.write-transformation']!(ctxFor('a different body', 'run-A'));
    expect(c.outputs?.documentId).not.toBe(a.outputs?.documentId);
    expect(minted.length).toBe(2);
  });

  it('leg 7 (D1b): ownerSubject SURVIVES the dedupe — the prescribed cure would have dropped it', async () => {
    // `createDraftDocument` (the ADR 0166 owner, used by ADR 0676 D1 for strategy) does NOT
    // accept `ownerSubject`, so routing through it would have silently discarded the ADR 0084
    // cross-subject hardening this node enforces. This leg pins that it is still passed.
    const mod = await import(join(REPO, 'packs', 'feature.notebooks.nodes', 'index.mjs'));
    const nodes = (mod.nodes ?? mod.default) as Record<string, (ctx: unknown) => Promise<{ outputs?: Record<string, unknown> }>>;
    let seen: unknown;
    const docs = {
      createDocument: async (a: { documentId?: string; ownerSubject?: unknown }) => { seen = a.ownerSubject; return { document: { documentId: a.documentId ?? 'd' } }; },
      addVersion: async () => ({ version: { versionId: 'v1', version: 1 } }),
    };
    await nodes['feature.notebooks.nodes.write-transformation']!({
      runId: 'r', nodeId: 'write',
      inputs: { orgId: 'o1', title: 'T', kind: 'k', sourceId: 's', content: 'body', ownerSubject: { kind: 'project', id: 'nb1' } },
      features: { documents: docs },
    });
    expect(seen).toEqual({ kind: 'project', id: 'nb1' });
  });
});
