/**
 * CONS-4 / WF-CONS-1 — the tenant LEGAL HOLD must reach the DESTRUCTIVE lanes,
 * not just the run lane.
 *
 * `getRetentionHold` had exactly four call sites, all in the run/workflow lane.
 * `host/subjectErasure.ts`, `host/retentionPurger.ts` and `host/kvAgeOut.ts`
 * contained ZERO references to it (grep-verified in the assessment), so an
 * operator's hold read as tenant-wide and was not: the DSAR erasure ran, the
 * governance purge fan-out ran, and the default-ON KV age-out ran. Worse,
 * `deleteSubject` wrote `recordGovernanceDecision({ outcome: 'allow' })` for a
 * held tenant — an audit row asserting the deletion was permitted, from a path
 * with no notion holds exist. GDPR Art. 17(3)(b)/(e) makes a hold OVERRIDE
 * erasure, so the failure ran in the unrecoverable direction (spoliation).
 *
 * BOTH HALVES of the symmetric pair are asserted (hold ↔ release): a held
 * tenant refuses, and CLEARING the hold restores every lane. A gate with no
 * exit would be its own defect.
 *
 * NON-VACUITY: each lane's assertion is sabotage-probed independently — see the
 * commit message for the three probes and what each turned red.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { DurableCollection, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  setRetentionHold, clearRetentionHold, RetentionHoldError,
  RETENTION_HOLD_KV_PREFIX, listHeldTenantsFrom,
} from '../src/host/retentionHold.js';
import {
  eraseSubject, registerSubjectEraser, __resetSubjectErasers, __resetSubjectKeyResolvers,
} from '../src/host/subjectErasure.js';
import { purgeRetained, registerRetentionPurger, __resetRetentionPurgers } from '../src/host/retentionPurger.js';
import { registerKvAgeOut, __runKvAgeOutOnce, __clearKvAgeOutForTest } from '../src/host/kvAgeOut.js';
import { deleteSubject, __resetConsentStore } from '../src/features/consent/consentService.js';
import type { Storage } from '../src/storage/storage.js';

const HELD = 'ws:held-tenant';
const FREE = 'ws:free-tenant';

let storage: Storage;

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  __resetSubjectErasers();
  __resetSubjectKeyResolvers();
  __resetRetentionPurgers();
  __clearKvAgeOutForTest();
  await __resetConsentStore();
  await clearRetentionHold(HELD);
  await clearRetentionHold(FREE);
});

describe('CONS-4 — legal hold gates the DSAR erasure lane', () => {
  it('eraseSubject REFUSES (typed) under a hold, and no eraser runs', async () => {
    let ran = 0;
    registerSubjectEraser(async function countingEraser() { ran += 1; });
    await setRetentionHold(HELD, 'litigation: Acme v. Foo');

    await expect(eraseSubject(HELD, 'alice')).rejects.toBeInstanceOf(RetentionHoldError);
    // The refusal must be a REFUSAL, not a `failed: 0` no-op that reads as a
    // clean erasure — the whole point of typing it.
    expect(ran, 'no eraser may run under a hold').toBe(0);

    // …and an UNHELD tenant is unaffected (the hold is per-tenant, not a switch).
    const out = await eraseSubject(FREE, 'alice');
    expect(out.failed).toBe(0);
    expect(ran).toBe(1);
  });

  it('the release half works: clearing the hold restores erasure', async () => {
    let ran = 0;
    registerSubjectEraser(async function countingEraser() { ran += 1; });
    await setRetentionHold(HELD, 'litigation');
    await expect(eraseSubject(HELD, 'alice')).rejects.toBeInstanceOf(RetentionHoldError);
    expect(await clearRetentionHold(HELD)).toBe(true);
    const out = await eraseSubject(HELD, 'alice');
    expect(out.failed).toBe(0);
    expect(ran).toBe(1);
  });

  it('deleteSubject refuses BEFORE mutating, and records a DENY (never outcome:allow)', async () => {
    registerSubjectEraser(async function noopEraser() {});
    await setRetentionHold(HELD, 'litigation');
    await expect(deleteSubject(HELD, 'alice')).rejects.toBeInstanceOf(RetentionHoldError);

    // Nothing mutated: no erasure tombstone was minted for a subject who was
    // not erased (a partial fix that wrote one would silently deny marketing to
    // a person whose data is still fully present).
    const tombstones = new DurableCollection<Record<string, unknown>>('consent:erasure-tombstone', (r) => String(r.subjectHash));
    expect((await tombstones.list()).length).toBe(0);

    // The governance row is a DENY with a named reason — this path used to
    // write `outcome: 'allow'` for a held tenant.
    const rows = await storage.listAudit({ limit: 50 });
    const decision = rows.find((r) => r.action === 'governance.decision.retention');
    expect(decision, 'an attempted erasure under hold must leave an audit row').toBeTruthy();
    expect(decision!.outcome).toBe('deny');
    expect(JSON.stringify(decision!.payload)).toContain('erasure_refused_legal_hold');
  });
});

describe('CONS-4 — legal hold gates the retention-purge lane', () => {
  it('purgeRetained SKIPS a held tenant and reports the skip (never a silent empty)', async () => {
    let purged = 0;
    registerRetentionPurger({ feature: 'demo', async purge() { purged += 1; return 3; } });
    await setRetentionHold(HELD, 'litigation');

    const held = await purgeRetained(HELD, 'confidential-pii', new Date().toISOString());
    expect(purged, 'no purger may run under a hold').toBe(0);
    // A bare `[]` would be indistinguishable from "no purgers registered", so
    // the skip is ATTRIBUTED.
    expect(held.length).toBe(1);
    expect(held[0]!.ok).toBe(false);
    expect(held[0]!.error).toContain('legal_hold');

    const free = await purgeRetained(FREE, 'confidential-pii', new Date().toISOString());
    expect(purged).toBe(1);
    expect(free[0]!.ok).toBe(true);
    expect(free[0]!.deleted).toBe(3);
  });
});

describe('CONS-4 — legal hold gates the DEFAULT-ON kv age-out lane', () => {
  const OLD = new Date(Date.now() - 400 * 86_400_000).toISOString();

  it('a held tenant\'s rows survive the sweep; every other tenant\'s still age out', async () => {
    registerKvAgeOut({ id: 'test:aged', prefix: 'hostext:test:aged:', ttlDays: 30, timestampField: 'at' });
    // Row tenancy resolves two ways, and BOTH are exercised: a declared
    // `tenantId` field, and the `${tenantId}:` id shape (with a `ws:` tenant
    // prefix, which a naive `split(':')[0]` would truncate).
    await storage.kvSet(`hostext:test:aged:${HELD}:byId`, JSON.stringify({ at: OLD }));
    await storage.kvSet('hostext:test:aged:declared', JSON.stringify({ at: OLD, tenantId: HELD }));
    await storage.kvSet(`hostext:test:aged:${FREE}:byId`, JSON.stringify({ at: OLD }));

    await setRetentionHold(HELD, 'litigation');
    await __runKvAgeOutOnce(storage);

    expect(await storage.kvGet(`hostext:test:aged:${HELD}:byId`), 'id-shaped tenancy').not.toBeNull();
    expect(await storage.kvGet('hostext:test:aged:declared'), 'declared tenantId').not.toBeNull();
    expect(await storage.kvGet(`hostext:test:aged:${FREE}:byId`), 'an unheld tenant still ages out').toBeNull();

    // Release half: lifting the hold lets the swept rows go on the next tick.
    await clearRetentionHold(HELD);
    await __runKvAgeOutOnce(storage);
    expect(await storage.kvGet(`hostext:test:aged:${HELD}:byId`)).toBeNull();
    expect(await storage.kvGet('hostext:test:aged:declared')).toBeNull();
  });

  it('RETENTION_HOLD_KV_PREFIX matches what the hold collection actually writes', async () => {
    // The kv lane reads holds by RAW PREFIX (it is handed an explicit Storage
    // and must not touch the ambient host-ext handle). A constant that drifts
    // from the collection's key shape would make the guard read ZERO holds and
    // sweep silently — fail-open, invisibly. Pinned against a real write.
    await setRetentionHold(HELD, 'litigation');
    const keys = (await storage.kvList(RETENTION_HOLD_KV_PREFIX)).map((r) => r.key);
    expect(keys).toContain(`${RETENTION_HOLD_KV_PREFIX}${HELD}`);
    expect(await listHeldTenantsFrom(storage)).toEqual(new Set([HELD]));
  });

  it('with NO holds the sweep is unchanged (the fast path costs nothing)', async () => {
    registerKvAgeOut({ id: 'test:aged', prefix: 'hostext:test:aged:', ttlDays: 30, timestampField: 'at' });
    await storage.kvSet(`hostext:test:aged:${HELD}:byId`, JSON.stringify({ at: OLD }));
    await __runKvAgeOutOnce(storage);
    expect(await storage.kvGet(`hostext:test:aged:${HELD}:byId`)).toBeNull();
  });
});

describe('CONS-13 — the age-out lane can no longer fail silently', () => {
  it('reports per-store counters, and an inert registration is distinguishable from a healthy empty one', async () => {
    // `__runKvAgeOutOnce` returned `void` and logged only when
    // `deleted > 0 || skipped > 0 || derived > 0`, so a MIS-PREFIXED or renamed
    // store — one that scans nothing, forever — looked exactly like a healthy
    // empty one. On the only DEFAULT-ON deletion lane in the app.
    registerKvAgeOut({ id: 'test:healthy', prefix: 'hostext:test:healthy:', ttlDays: 30, timestampField: 'at' });
    registerKvAgeOut({ id: 'test:misprefixed', prefix: 'hostext:test:nothing-here:', ttlDays: 30, timestampField: 'at' });
    await storage.kvSet(`hostext:test:healthy:${FREE}:a`, JSON.stringify({ at: new Date(Date.now() - 400 * 86_400_000).toISOString() }));
    await storage.kvSet(`hostext:test:healthy:${FREE}:b`, JSON.stringify({ at: new Date().toISOString() }));

    const out = await __runKvAgeOutOnce(storage);
    const byId = new Map(out.map((r) => [r.id, r]));

    expect(byId.get('test:healthy')!.scanned, 'a live registration sees rows').toBe(2);
    expect(byId.get('test:healthy')!.deleted).toBe(1);
    // THE discriminator: a registration pointing at nothing scans nothing, and
    // now says so instead of staying silent.
    expect(byId.get('test:misprefixed')!.scanned).toBe(0);
    expect(byId.get('test:misprefixed')!.deleted).toBe(0);
  });
});

/**
 * Review F2 — the WHOLE-TENANT destruction lanes.
 *
 * ADR 0586 D2's heading said the hold "gates every destructive lane" and its
 * table listed six. Two lanes that destroy an ENTIRE TENANT were in neither:
 * `routes/account.ts` (self-service account deletion — covered by
 * `account-delete.test.ts`) and this one, the abandoned-anon-tenant teardown.
 * Both are strictly more destructive than the per-subject consent lane the PR
 * did gate with a 409.
 *
 * POSTURE, and why it differs from the account lane's throw: this is a
 * background sweep with nobody waiting. A throw would abort the whole batch
 * and starve the unheld tenants queued behind a held one, so a held tenant is
 * SKIPPED and reported — the same choice `purgeRetained` and
 * `runRetentionSweeper` (`skippedHold`) already made.
 */
describe('CONS-4 / review F2 — legal hold gates the anon-tenant TEARDOWN lane', () => {
  it('skips a held anon tenant, tears down the unheld one, and leaves the hold row intact', async () => {
    const { pruneAbandonedAnonTenants } = await import('../src/host/retentionSweepDaemon.js');
    const { getRetentionHold } = await import('../src/host/retentionHold.js');
    const HELD_ANON = 'anon:held-visitor';
    const FREE_ANON = 'anon:free-visitor';
    const NOW = Date.parse('2026-08-19T12:00:00.000Z');
    const old = new Date(NOW - 90 * 86_400_000).toISOString();
    const mkRun = (runId: string, tenantId: string) => ({
      runId, workflowId: 'wf', tenantId, status: 'completed' as const,
      inputs: null, metadata: {}, configurable: {}, createdAt: old, updatedAt: old,
    });

    process.env.OPENWOP_ANON_TENANT_RETENTION_DAYS = '14';
    try {
      await storage.insertRun(mkRun('held-r1', HELD_ANON));
      await storage.insertRun(mkRun('free-r1', FREE_ANON));
      await setRetentionHold(HELD_ANON, 'litigation: preserve visitor session');

      const torn = await pruneAbandonedAnonTenants({ storage }, NOW);

      // NON-VACUITY: the unheld tenant MUST be torn down in the same pass, or
      // this test would pass just as well against a sweep that did nothing at
      // all (a disabled env var, a mis-set cutoff, an empty candidate list).
      expect(torn, 'the unheld tenant is still swept — the hold is per-tenant, not a switch').toBe(1);
      expect(await storage.getRun('free-r1')).toBeNull();

      // The held tenant survives whole…
      expect(await storage.getRun('held-r1')).not.toBeNull();
      // …and so does the hold row. `purgeTenantHostExt` would have taken it in
      // the same pass (the collection declares `tenantOf`), so an ungated
      // teardown destroyed its own evidence with no operator in the loop.
      expect(await getRetentionHold(HELD_ANON)).not.toBeNull();

      // BOTH HALVES: lifting the hold restores the lane on the next tick.
      await clearRetentionHold(HELD_ANON);
      expect(await pruneAbandonedAnonTenants({ storage }, NOW)).toBe(1);
      expect(await storage.getRun('held-r1')).toBeNull();
    } finally {
      delete process.env.OPENWOP_ANON_TENANT_RETENTION_DAYS;
      await clearRetentionHold(HELD_ANON);
    }
  });
});

/**
 * Review F7 — the `kv_age_out_hold_unresolvable` tripwire was PRE-DESENSITISED.
 *
 * `heldUnresolved` counts rows a hold could not be applied to, and the warn on
 * it is a real tripwire for a store that SHOULD carry a tenant and doesn't. But
 * `analytics:visitor-salt` rows are `{day, salt, mintedAt}` with no `tenantId`,
 * and the row id IS a UTC date (`2026-08-19`) so it contains no `:`. Every salt
 * row therefore landed in `heldUnresolved` and the warn fired on EVERY tick for
 * as long as any tenant anywhere was held — for a host-global store that has no
 * tenant BY CONSTRUCTION. A tripwire guaranteed to fire while the condition it
 * watches is active is one an operator learns to ignore, and the real finding
 * arrives in the same noise.
 *
 * `hostGlobal: true` is a claim about the DATA MODEL, not a mute button, so the
 * second case pins that an ordinary store with the SAME row shape still counts
 * and still warns — otherwise the fix would have closed the tripwire rather
 * than de-noised it.
 */
describe('review F7 — a host-global store is not a hold-unresolvable finding', () => {
  it('a hostGlobal store reports ZERO heldUnresolved; an identical non-hostGlobal store still does', async () => {
    const OLD = new Date(Date.now() - 400 * 86_400_000).toISOString();
    // Identical shapes: no `tenantId` in the row, no `:` in the id. The ONLY
    // difference between them is the flag.
    registerKvAgeOut({ id: 'test:salt-like', prefix: 'hostext:test:salt-like:', ttlDays: 1, timestampField: 'at', hostGlobal: true });
    registerKvAgeOut({ id: 'test:should-carry-tenant', prefix: 'hostext:test:should-carry-tenant:', ttlDays: 1, timestampField: 'at' });
    await storage.kvSet('hostext:test:salt-like:2026-08-19', JSON.stringify({ at: OLD }));
    await storage.kvSet('hostext:test:should-carry-tenant:2026-08-19', JSON.stringify({ at: OLD }));

    // The warn only fires when SOME tenant is held — that is the whole trigger
    // condition, and the reason this was invisible until a hold existed.
    await setRetentionHold(HELD, 'litigation');
    const out = await __runKvAgeOutOnce(storage);
    const byId = new Map(out.map((r) => [r.id, r]));

    // NON-VACUITY: both stores must actually have been SCANNED, or "zero
    // unresolved" would just mean "saw nothing".
    expect(byId.get('test:salt-like')!.scanned).toBe(1);
    expect(byId.get('test:should-carry-tenant')!.scanned).toBe(1);

    expect(byId.get('test:salt-like')!.heldUnresolved, 'a host-global store has no tenant to resolve').toBe(0);
    // THE DISCRIMINATOR: the tripwire is de-noised, NOT disabled. A store that
    // should carry a tenant and doesn't is still counted and still warns.
    expect(byId.get('test:should-carry-tenant')!.heldUnresolved, 'the tripwire must still fire where it means something').toBe(1);

    // Both rows still age out — `hostGlobal` changes the ACCOUNTING, not the
    // sweep. A host-global row was never protectable by a hold anyway.
    expect(await storage.kvGet('hostext:test:salt-like:2026-08-19')).toBeNull();
    expect(await storage.kvGet('hostext:test:should-carry-tenant:2026-08-19')).toBeNull();
  });

  it('the SHIPPING visitor-salt registration is the one that declares itself host-global', async () => {
    // Pins the fix to the REAL registration, not just the flag's mechanics —
    // the module-level `registerKvAgeOut` call is what shipped the noise, and a
    // test of the flag alone would pass with the shipping call untouched.
    //
    // `vi.resetModules()` is required, and is the point: `beforeEach` calls
    // `__clearKvAgeOutForTest()`, and a module-level registration runs exactly
    // ONCE per module graph — so a plain `await import(...)` of an
    // already-loaded module registers nothing and this read returned
    // `undefined`. Both modules are pulled from the SAME fresh graph so the
    // registry being read is the one the import just populated.
    vi.resetModules();
    const kv = await import('../src/host/kvAgeOut.js');
    await import('../src/features/analytics/visitorIdentity.js');
    const salt = kv.__listKvAgeOutForTest().find((r) => r.id === 'analytics:visitor-salt');
    expect(salt, 'the visitor-salt registration must exist — else this assertion is vacuous').toBeTruthy();
    expect(salt!.hostGlobal).toBe(true);
    // Guard the guard: if NOTHING registered, `find` would also be undefined.
    expect(kv.__listKvAgeOutForTest().length).toBeGreaterThan(0);
  });
});
