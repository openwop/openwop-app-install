/**
 * ADR 0479 — the `workflow-pins` config domain: workflow publish pins join
 * environments snapshots over the ADR 0474 revision handle.
 *  - export is deterministic (published rows only, map payload)
 *  - restore is APPLY-ONLY: omitted workflows keep their live pin (never a
 *    clear — a cleared pin would flip production launches back to head)
 *  - per-item failures are AGGREGATED AND NAMED (pruned revision, foreign
 *    workflow) and surface through applyToLive's per-domain 409
 *  - cross-tenant isolation: a snapshot restored on tenant B never touches
 *    tenant A's pins, and B's import fails NAMED on A's workflowIds
 *  - diff() counts only well-formed revision refs: a plaintext/secret-shaped
 *    value never reaches a diff (ENVC-8 / ENVP-1, moved here from the retired
 *    `env-grade-probe.test.ts`)
 *
 * TST-DAC-7. The concurrent-restore case FORCES its race with a test-side
 * storage proxy (no product seam): `recordOwnership` is parked right after it
 * read the old row, the pin restore lands, then the autosave resumes.
 *
 * Red when (sabotage-witnessed, wave 70): export includes unpublished rows; the
 * foreign-owner check or the revision-tenancy check is dropped; a pruned
 * revision is applied; malformed entries stop failing named; the HASH_RE
 * filter admits any string; `recordOwnership` writes blind instead of CAS;
 * `setPublishedRevision` succeeds on a missing row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { workflowPinsDomain } from '../src/features/environments/domains/workflowPinsDomain.js';
import { recordOwnership, getOwned, setPublishedRevision } from '../src/host/workflowOwnership.js';
import { recordRevision } from '../src/host/workflowRevisions.js';
import { revisionHashOf } from '../src/host/definitionHash.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

const T = 'org:pins-a';
const T2 = 'org:pins-b';

function def(workflowId: string, marker: string): WorkflowDefinition {
  return {
    workflowId,
    nodes: [{ nodeId: 'n1', typeId: 'core.noop', config: { marker } }],
    edges: [],
    metadata: { name: workflowId },
  };
}

/** One-shot hold on the NEXT read of a key ending in `suffix` (test-side race forcing). */
let hold: { suffix: string; arrived: () => void; release: Promise<void> } | null = null;

/** Register ownership + a revision for (tenant, wf, marker); returns the hash. */
async function seed(tenantId: string, workflowId: string, marker: string): Promise<string> {
  const d = def(workflowId, marker);
  await recordOwnership(tenantId, workflowId, { nodeCount: 1 });
  await recordRevision(tenantId, d, {});
  return revisionHashOf(d);
}

beforeAll(async () => {
  const storage = await openStorage('memory://');
  const parked = new Proxy(storage, {
    get(target, prop, receiver) {
      if (prop === 'kvGet') {
        return async (key: string) => {
          const value = await target.kvGet(key);
          const h = hold;
          if (h && key.endsWith(h.suffix)) {
            hold = null;
            h.arrived();
            await h.release; // the caller resumes holding the value it read BEFORE the hold
          }
          return value;
        };
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as Storage;
  initHostExtPersistence(parked);
});
afterAll(() => { /* memory:// dies with the process */ });

describe('workflow-pins config domain (ADR 0479)', () => {
  it('export captures ONLY published rows, deterministically', async () => {
    const TE = 'org:pins-export'; // own tenant: other cases publish pins on T
    const h1 = await seed(TE, 'wf-pub', 'v1');
    await seed(TE, 'wf-unpub', 'v1'); // owned, never published
    expect(await setPublishedRevision(TE, 'wf-pub', h1)).toBe(true);

    const a = await workflowPinsDomain.export(TE);
    const b = await workflowPinsDomain.export(TE);
    expect(a).toEqual({ 'wf-pub': h1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b)); // deterministic
  });

  it('import applies pins and is APPLY-ONLY: omitted workflows keep their live pin', async () => {
    const hA1 = await seed(T, 'wf-a', 'a1');
    const hB1 = await seed(T, 'wf-b', 'b1');
    await setPublishedRevision(T, 'wf-a', hA1);
    await setPublishedRevision(T, 'wf-b', hB1);

    // Move wf-a forward; snapshot only knows wf-a@hA1 (wf-b omitted).
    const hA2 = await seed(T, 'wf-a', 'a2');
    await setPublishedRevision(T, 'wf-a', hA2);

    await workflowPinsDomain.import(T, { 'wf-a': hA1 });
    expect((await getOwned(T, 'wf-a'))?.publishedRevision).toBe(hA1); // restored
    expect((await getOwned(T, 'wf-b'))?.publishedRevision).toBe(hB1); // UNTOUCHED — apply-only
  });

  it('a pruned/unknown revision fails NAMED, and valid siblings still apply (retry-safe)', async () => {
    const hC = await seed(T, 'wf-c', 'c1');
    await seed(T, 'wf-d', 'd1');
    const bogus = 'f'.repeat(64);

    await expect(workflowPinsDomain.import(T, { 'wf-c': hC, 'wf-d': bogus }))
      .rejects.toThrow(/wf-d.*not available to this workspace/);
    // The valid sibling landed despite the named failure (idempotent retry model).
    expect((await getOwned(T, 'wf-c'))?.publishedRevision).toBe(hC);
    expect((await getOwned(T, 'wf-d'))?.publishedRevision).toBeUndefined();
  });

  it('cross-tenant: importing tenant A\'s pins on tenant B fails NAMED and touches nothing', async () => {
    const hX = await seed(T, 'wf-x', 'x1');
    await setPublishedRevision(T, 'wf-x', hX);

    await expect(workflowPinsDomain.import(T2, { 'wf-x': hX }))
      .rejects.toThrow(/wf-x.*owned by another workspace/);
    expect((await getOwned(T, 'wf-x'))?.publishedRevision).toBe(hX); // A untouched
    expect(await getOwned(T2, 'wf-x')).toBeNull(); // no row minted for B
  });

  it('a workflow the tenant DELETED since the snapshot is SKIPPED, not a forever-409 (code-review M1)', async () => {
    // No owner anywhere: the entry is skipped (drift reports it) so older
    // snapshots keep applying; only a FOREIGN owner is a named failure.
    await expect(workflowPinsDomain.import(T, { 'wf-gone-forever': 'a'.repeat(64) }))
      .resolves.toBeUndefined();
  });

  it('a revision row owned by ANOTHER tenant fails NAMED — never a green apply that launches head (code-review H2)', async () => {
    // Dual ownership: T authored wf-dual (revision rows carry T's tenantId);
    // T2 also holds an ownership row for the same id. T2's snapshot pinning
    // T's revision must fail named — resolveLaunchWorkflow would silently
    // fall back to HEAD on the tenancy mismatch.
    const hD = await seed(T, 'wf-dual', 'd1');
    await recordOwnership(T2, 'wf-dual', { nodeCount: 1 });
    await expect(workflowPinsDomain.import(T2, { 'wf-dual': hD }))
      .rejects.toThrow(/wf-dual.*not available to this workspace/);
    expect((await getOwned(T2, 'wf-dual'))?.publishedRevision).toBeUndefined();
  });

  it('recordOwnership does NOT clobber a concurrent pin restore (grade-fix H2)', async () => {
    const hK = await seed(T, 'wf-cas', 'v1');
    await setPublishedRevision(T, 'wf-cas', hK);
    const hK2 = await seed(T, 'wf-cas', 'v2');
    // FORCE the race: the autosave's recordOwnership reads the row (pin hK) and
    // is parked; the pin restore to hK2 lands; then the autosave resumes with its
    // stale read. A blind get→put would write hK back; the CAS form must not.
    let arrived!: () => void;
    let release!: () => void;
    const arrivedP = new Promise<void>((r) => { arrived = r; });
    hold = { suffix: `workflow:ownership:${T}:wf-cas`, arrived, release: new Promise<void>((r) => { release = r; }) };
    try {
      const autosave = recordOwnership(T, 'wf-cas', { nodeCount: 2, name: 'renamed by autosave' });
      await Promise.race([
        arrivedP,
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('recordOwnership never read the row — the race was not forced')), 2000)),
      ]);
      expect(await setPublishedRevision(T, 'wf-cas', hK2)).toBe(true);
      release();
      await autosave;
    } finally {
      hold = null;
      release();
    }
    const row = await getOwned(T, 'wf-cas');
    // The pin survives, AND the autosave's own write landed (it retried, not dropped).
    expect(row?.publishedRevision).toBe(hK2);
    expect(row?.name).toBe('renamed by autosave');
    expect(row?.nodeCount).toBe(2);
  });

  it('setPublishedRevision fails closed on a missing ownership row', async () => {
    expect(await setPublishedRevision(T, 'wf-never-registered', 'a'.repeat(64))).toBe(false);
    expect(await getOwned(T, 'wf-never-registered')).toBeNull();
  });

  it('diff counts added/changed/removed by workflowId', () => {
    const d = workflowPinsDomain.diff(
      { 'wf-1': 'a'.repeat(64), 'wf-2': 'b'.repeat(64) },
      { 'wf-2': 'c'.repeat(64), 'wf-3': 'd'.repeat(64) },
    );
    expect(d).toEqual({ added: 1, changed: 1, removed: 1 });
  });

  it('diff ignores a non-hash (secret-shaped) value — ENVC-8 / ENVP-1', () => {
    // A plaintext secret beside one valid hash ref; `to` is empty. Only the ref
    // counts as removed: the secret-shaped value never reaches the diff.
    const d = workflowPinsDomain.diff(
      { leaked: 'sk-live-PLAINTEXT-SECRET-should-never-be-captured', real: 'a1b2c3d4e5f6a1b2c3d4e5f6' },
      {},
    );
    expect(d).toEqual({ added: 0, changed: 0, removed: 1 });
  });

  it('service round-trip: snapshot → pin moves → applyToLive restores it (domain reports ok)', async () => {
    const svc = await import('../src/features/environments/environmentsService.js');
    const domains = await import('../src/host/configDomains.js');
    domains.registerConfigDomain(workflowPinsDomain); // idempotent by id

    const T3 = 'org:pins-c';
    const h1 = await seed(T3, 'wf-ok', 'ok1');
    await setPublishedRevision(T3, 'wf-ok', h1);
    const snap = await svc.snapshotLiveConfig({ tenantId: T3, sourceEnv: null, createdBy: 'test' });
    expect((snap.domains['workflow-pins'] as Record<string, string>)['wf-ok']).toBe(h1);

    // The pin moves forward; applying the snapshot restores it.
    const h2 = await seed(T3, 'wf-ok', 'ok2');
    await setPublishedRevision(T3, 'wf-ok', h2);
    const applied = await svc.applyToLive({ tenantId: T3, snapshotHash: snap.hash, actor: 'test' });
    expect(applied.domains.find((d) => d.id === 'workflow-pins')?.ok).toBe(true);
    expect((await getOwned(T3, 'wf-ok'))?.publishedRevision).toBe(h1);
  });

  it('malformed payload entries FAIL NAMED — never a silent green apply (code-review M2)', async () => {
    const hE = await seed(T, 'wf-e', 'e1');
    await setPublishedRevision(T, 'wf-e', hE);
    await expect(workflowPinsDomain.import(T, { 'wf-e': 'not-a-hash!', bogus: 42 }))
      .rejects.toThrow(/malformed revision reference/);
    expect((await getOwned(T, 'wf-e'))?.publishedRevision).toBe(hE); // untouched
  });
});
