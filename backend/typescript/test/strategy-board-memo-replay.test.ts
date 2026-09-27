/**
 * ADR 0676 D1 (`SPWF-13`) — the strategy document writers are replay-classified and
 * their dedupe actually dedupes.
 *
 * Born red on all four legs before the ADR:
 *  - `create-board-memo` was in NEITHER the side-effect floor NOR the served set while its
 *    three sibling writers were in both, so a `:fork` re-executed it and minted a SECOND
 *    board-update Document. Its own pack docblock claimed the opposite.
 *  - Its idempotency key embedded `document.documentId`, minted by the `createDocument`
 *    call two lines above — unique by construction, so `addVersion`'s document-scoped
 *    lookup (`documentsService.ts:481-485`) searched an EMPTY list and no key could match.
 *  - `record-decision` carried the byte-identical defect 80 lines away.
 *  - Both returned `status:'success'` carrying the error when the write FAILED (`SPC-20`).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MANIFEST_SIDE_EFFECT_FLOOR, MANIFEST_FAST_PATH_SERVED } from '../src/executor/sideEffectFloor.generated.js';
import { isSideEffectingNode } from '../src/executor/sideEffects.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PACK = JSON.parse(readFileSync(join(REPO, 'packs', 'feature.strategy.nodes', 'pack.json'), 'utf8')) as {
  version: string;
  nodes: { typeId: string; role: string; capabilities?: string[] }[];
};

/** The four verbs that write durable state. Named explicitly, not derived from the very
 *  field under test — deriving them from `capabilities` would make every leg vacuous. */
const DURABLE_WRITERS = [
  'feature.strategy.nodes.create-board-memo',
  'feature.strategy.nodes.check-in',
  'feature.strategy.nodes.record-decision',
  'feature.strategy.nodes.sync-metrics',
];
const READ_VERBS = [
  'feature.strategy.nodes.list-strategies',
  'feature.strategy.nodes.get-strategy',
  'feature.strategy.nodes.get-context',
  'feature.strategy.nodes.get-health',
  'feature.strategy.nodes.list-check-ins',
  'feature.strategy.nodes.list-stale-krs',
];

const loadNodes = async (): Promise<Record<string, (ctx: unknown) => Promise<{ status: string; outputs?: Record<string, unknown>; error?: { code: string } }>>> => {
  const mod = await import(join(REPO, 'packs', 'feature.strategy.nodes', 'index.mjs'));
  return (mod.nodes ?? mod.default) as never;
};

/** A documents surface that records every mint, so a duplicate is observable. */
function docsSurface(opts?: { throwOnWrite?: boolean }) {
  const minted: string[] = [];
  return {
    minted,
    surface: {
      createDraftDocument: async (args: { orgId: string; title: string; kind: string; content: string; idemBase?: string }) => {
        if (opts?.throwOnWrite) throw new Error('documents unavailable');
        // Mirrors the real owner: the documentId is DERIVED from idemBase, and an
        // existing id short-circuits (`documentsService.ts:326-329`).
        const documentId = `doc:${args.idemBase ?? 'run'}`;
        if (!minted.includes(documentId)) minted.push(documentId);
        return { document: { documentId }, version: { versionId: 'v1', version: 1 } };
      },
    },
  };
}

describe('ADR 0676 D1 — strategy document writers are replay-safe', () => {
  it('leg 1: all FOUR durable writers are in the floor AND the served set', () => {
    for (const id of DURABLE_WRITERS) {
      expect(MANIFEST_SIDE_EFFECT_FLOOR.has(id), `${id} must be in the side-effect floor`).toBe(true);
      expect(MANIFEST_FAST_PATH_SERVED.has(id), `${id} must be replay-served`).toBe(true);
      expect(isSideEffectingNode(id), `${id}: every arm of the predicate must agree`).toBe(true);
    }
  });

  it('leg 2: the six READ verbs are NOT classified — the fix is scoped, not a prefix sweep', () => {
    for (const id of READ_VERBS) {
      expect(isSideEffectingNode(id), `${id} is a read and must stay unclassified`).toBe(false);
    }
  });

  it('leg 3: the manifest declares side-effectful on exactly the four writers', () => {
    const byId = new Map(PACK.nodes.map((n) => [n.typeId, n]));
    for (const id of DURABLE_WRITERS) {
      expect(byId.get(id)?.capabilities ?? [], id).toContain('side-effectful');
    }
    for (const id of READ_VERBS) {
      expect(byId.get(id)?.capabilities ?? [], id).not.toContain('side-effectful');
    }
  });

  it('leg 4: the feature pin equals the manifest version', () => {
    const feature = readFileSync(join(REPO, 'backend', 'typescript', 'src', 'features', 'strategy', 'feature.ts'), 'utf8');
    expect(feature).toContain(`{ name: 'feature.strategy.nodes', version: '${PACK.version}' }`);
  });

  it('leg 5: the SAME memo content re-resolves to the SAME documentId — the dedupe that the old key could not do', async () => {
    const nodes = await loadNodes();
    const { minted, surface } = docsSurface();
    const ctx = {
      inputs: { orgId: 'o1', markdown: '# Q3 board pre-read', strategyId: 's1' },
      config: { title: 'Board pre-read' },
      features: { documents: surface },
    };
    const a = await nodes['feature.strategy.nodes.create-board-memo']!(ctx);
    const b = await nodes['feature.strategy.nodes.create-board-memo']!(ctx);
    expect(a.status).toBe('success');
    expect(b.status).toBe('success');
    expect(a.outputs?.documentId, 'a re-execution must resolve the SAME document').toBe(b.outputs?.documentId);
    expect(minted.length, 'exactly ONE document may exist for one memo').toBe(1);
    // Non-vacuity: DIFFERENT content must mint a DIFFERENT document, or leg 5 would pass
    // on a constant id and prove nothing.
    const c = await nodes['feature.strategy.nodes.create-board-memo']!({
      ...ctx, inputs: { ...ctx.inputs, markdown: '# A DIFFERENT memo' },
    });
    expect(c.outputs?.documentId).not.toBe(a.outputs?.documentId);
    expect(minted.length).toBe(2);
  });

  it('leg 6: record-decision — the twin 80 lines away — dedupes the same way', async () => {
    const nodes = await loadNodes();
    const { minted, surface } = docsSurface();
    const ctx = {
      inputs: { orgId: 'o1', title: 'Ship it', markdown: 'We decided X.', strategyId: 's1' },
      features: { documents: surface },
    };
    const a = await nodes['feature.strategy.nodes.record-decision']!(ctx);
    const b = await nodes['feature.strategy.nodes.record-decision']!(ctx);
    expect(a.outputs?.documentId).toBe(b.outputs?.documentId);
    expect(minted.length, 'the twin must not mint twice either').toBe(1);
  });

  it('leg 7 (SPC-20): an ATTEMPTED write that FAILS is a typed failure, never success-with-a-note', async () => {
    const nodes = await loadNodes();
    const { surface } = docsSurface({ throwOnWrite: true });
    for (const id of ['feature.strategy.nodes.create-board-memo', 'feature.strategy.nodes.record-decision']) {
      const res = await nodes[id]!({
        inputs: { orgId: 'o1', title: 'T', markdown: 'body' },
        config: {},
        features: { documents: surface },
      });
      expect(res.status, `${id}: a failed write must not report success`).toBe('error');
      expect(res.error?.code).toBe('document_write_failed');
    }
  });

  it('leg 8: documents OFF still DEGRADES to success — nothing was attempted, so nothing failed', async () => {
    const nodes = await loadNodes();
    const res = await nodes['feature.strategy.nodes.create-board-memo']!({
      inputs: { orgId: 'o1', markdown: 'body' }, config: {}, features: {},
    });
    expect(res.status).toBe('success');
    expect(res.outputs?.persisted).toBe(false);
  });
});
