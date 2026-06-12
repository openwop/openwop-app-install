/**
 * Feature toggles + multivariant testing (host-extension, ADR 0001 §3).
 *
 * Covers:
 *   1. Bucketing (bucketing.ts) — deterministic/sticky, weight distribution,
 *      single-variant and no-variant cases.
 *   2. Resolution (service.ts) — on/off, beta cohort eligibility, per-tenant
 *      overrides, sticky variant assignment, durable store round-trip.
 *   3. Validation (validate.ts) — weights-sum-to-100, unique keys, bindings.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { assignVariant, bucketOf, hashString } from '../src/host/featureToggles/bucketing.js';
import {
  __resetToggleDefaults,
  registerToggleDefault,
} from '../src/host/featureToggles/registry.js';
import {
  __clearToggleStore,
  getEffectiveConfig,
  listEffectiveConfigs,
  pruneOrphanedConfigs,
  resolveConfig,
  resolveOne,
  saveConfig,
} from '../src/host/featureToggles/service.js';
import { validateToggleConfig } from '../src/host/featureToggles/validate.js';
import type { ToggleConfig, ToggleSubject } from '../src/host/featureToggles/types.js';

const AB: ToggleConfig = {
  id: 'demo.experiment',
  status: 'on',
  bucketUnit: 'user',
  salt: 's1',
  variants: [
    { key: 'A', weight: 50 },
    { key: 'B', weight: 50 },
  ],
};

describe('bucketing (pure, deterministic)', () => {
  it('hashString is stable for the same input', () => {
    expect(hashString('user-1:demo:salt')).toBe(hashString('user-1:demo:salt'));
  });

  it('bucketOf is in [0, 10000)', () => {
    for (const id of ['u1', 'u2', 'u3', 'tenant:abc', 'anon:xyz']) {
      const b = bucketOf(id, 'demo.experiment', 's1');
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(10_000);
    }
  });

  it('assignVariant is sticky for a given unit/toggle/salt', () => {
    const first = assignVariant('user-1', 'demo.experiment', 's1', AB.variants!);
    for (let i = 0; i < 5; i++) {
      expect(assignVariant('user-1', 'demo.experiment', 's1', AB.variants!)).toBe(first);
    }
  });

  it('a different salt can re-bucket the same user (decorrelation)', () => {
    // Not guaranteed different for every user, but over many users the salt
    // must change *some* assignments — proves the salt feeds the hash.
    let changed = 0;
    for (let i = 0; i < 200; i++) {
      const u = `user-${i}`;
      if (assignVariant(u, 'demo', 'saltA', AB.variants!) !== assignVariant(u, 'demo', 'saltB', AB.variants!)) {
        changed++;
      }
    }
    expect(changed).toBeGreaterThan(0);
  });

  it('50/50 split is roughly balanced over many units', () => {
    let a = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      if (assignVariant(`user-${i}`, 'demo.experiment', 's1', AB.variants!) === 'A') a++;
    }
    const ratio = a / N;
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(0.6);
  });

  it('returns null when there are no variants', () => {
    expect(assignVariant('user-1', 'demo', 's1', [])).toBeNull();
  });

  it('a single 100% variant always returns that variant', () => {
    for (let i = 0; i < 50; i++) {
      expect(assignVariant(`u${i}`, 'demo', 's1', [{ key: 'only', weight: 100 }])).toBe('only');
    }
  });
});

describe('resolution (service, pure given config+subject)', () => {
  const sub = (tenantId: string, userId?: string): ToggleSubject =>
    userId ? { tenantId, userId } : { tenantId };

  it('off ⇒ disabled, no variant', () => {
    const r = resolveConfig({ ...AB, status: 'off' }, sub('t1', 'u1'));
    expect(r).toEqual({ id: 'demo.experiment', status: 'off', enabled: false, variant: null });
  });

  it('on ⇒ enabled with a sticky variant', () => {
    const r = resolveConfig(AB, sub('t1', 'u1'));
    expect(r.enabled).toBe(true);
    expect(['A', 'B']).toContain(r.variant);
    expect(resolveConfig(AB, sub('t1', 'u1')).variant).toBe(r.variant); // sticky
  });

  it('closed beta (non-empty cohort) ⇒ disabled unless the subject is in the cohort', () => {
    const beta: ToggleConfig = { ...AB, status: 'beta', betaCohort: ['t-in', 'u-in'] };
    expect(resolveConfig(beta, sub('t-out', 'u-out')).enabled).toBe(false);
    expect(resolveConfig(beta, sub('t-in', 'u-out')).enabled).toBe(true); // tenant in cohort
    expect(resolveConfig(beta, sub('t-out', 'u-in')).enabled).toBe(true); // user in cohort
  });

  it('open beta (empty/no cohort) ⇒ enabled for everyone, status stays beta (badge)', () => {
    const r = resolveConfig({ ...AB, status: 'beta' }, sub('t1', 'u1'));
    expect(r.enabled).toBe(true);
    expect(r.status).toBe('beta'); // FE renders a Beta badge off this
    expect(resolveConfig({ ...AB, status: 'beta', betaCohort: [] }, sub('t9', 'u9')).enabled).toBe(true);
  });

  it('a per-tenant override beats the global default', () => {
    const cfg: ToggleConfig = { ...AB, status: 'on', tenantOverrides: { t1: { status: 'off' } } };
    expect(resolveConfig(cfg, sub('t1', 'u1')).enabled).toBe(false); // overridden off
    expect(resolveConfig(cfg, sub('t2', 'u1')).enabled).toBe(true); // global on
  });

  it('tenant bucketUnit buckets every user in a tenant the same', () => {
    const cfg: ToggleConfig = { ...AB, bucketUnit: 'tenant' };
    const a = resolveConfig(cfg, sub('tenant-1', 'userA')).variant;
    const b = resolveConfig(cfg, sub('tenant-1', 'userB')).variant;
    expect(a).toBe(b);
  });
});

describe('durable store + effective config', () => {
  const storage = openSqliteStorage(':memory:');
  beforeAll(() => initHostExtPersistence(storage));
  afterAll(async () => {
    __resetHostExtPersistence();
    await storage.close();
  });
  beforeEach(async () => {
    initHostExtPersistence(storage);
    await __clearToggleStore();
    __resetToggleDefaults();
  });

  it('effective config = default until an override is saved', async () => {
    registerToggleDefault({ ...AB, status: 'off' });
    expect((await getEffectiveConfig('demo.experiment'))?.status).toBe('off');
    await saveConfig({ ...AB, status: 'on' }, 'admin-tenant');
    const eff = await getEffectiveConfig('demo.experiment');
    expect(eff?.status).toBe('on');
    expect(eff?.updatedBy).toBe('admin-tenant');
  });

  it('listEffectiveConfigs unions defaults and stored overrides', async () => {
    registerToggleDefault({ ...AB, id: 'a.feature', status: 'off' });
    registerToggleDefault({ ...AB, id: 'b.feature', status: 'on' });
    await saveConfig({ ...AB, id: 'a.feature', status: 'on' }, 'admin');
    const ids = (await listEffectiveConfigs()).map((c) => c.id);
    expect(ids).toContain('a.feature');
    expect(ids).toContain('b.feature');
    expect((await listEffectiveConfigs()).find((c) => c.id === 'a.feature')?.status).toBe('on');
  });

  it('resolveOne returns null for an unknown toggle', async () => {
    expect(await resolveOne('nope', { tenantId: 't1' })).toBeNull();
  });

  it('a GRADUATED feature (no default) hides + prunes its orphaned saved row', async () => {
    // A feature had a toggle, an admin saved a config, then it graduated
    // (toggleDefault removed) — like assistant/profiles. The stored row must NOT
    // resurface as a live toggle.
    registerToggleDefault({ ...AB, id: 'live.feature', status: 'on' });
    await saveConfig({ ...AB, id: 'live.feature', status: 'on' }, 'admin');
    await saveConfig({ ...AB, id: 'graduated.feature', status: 'on' }, 'admin'); // no default registered
    // Hidden from admin + not resolvable.
    const ids = (await listEffectiveConfigs()).map((c) => c.id);
    expect(ids).toContain('live.feature');
    expect(ids).not.toContain('graduated.feature');
    expect(await getEffectiveConfig('graduated.feature')).toBeNull();
    expect(await resolveOne('graduated.feature', { tenantId: 't1' })).toBeNull();
    // Pruned from the store.
    const pruned = await pruneOrphanedConfigs();
    expect(pruned).toBe(1);
    expect(await pruneOrphanedConfigs()).toBe(0); // idempotent
    // The live one survives the prune.
    expect((await listEffectiveConfigs()).map((c) => c.id)).toContain('live.feature');
  });
});

describe('validation', () => {
  it('accepts a well-formed A/B config', () => {
    const c = validateToggleConfig('x', { status: 'on', bucketUnit: 'user', variants: [{ key: 'A', weight: 60 }, { key: 'B', weight: 40 }] });
    expect(c.variants).toHaveLength(2);
    expect(c.salt).toBe('x'); // defaults to id
  });

  it('rejects weights that do not sum to 100', () => {
    expect(() => validateToggleConfig('x', { status: 'on', variants: [{ key: 'A', weight: 50 }, { key: 'B', weight: 40 }] })).toThrow(/sum to exactly 100/);
  });

  it('rejects duplicate variant keys', () => {
    expect(() => validateToggleConfig('x', { status: 'on', variants: [{ key: 'A', weight: 50 }, { key: 'A', weight: 50 }] })).toThrow(/Duplicate variant key/);
  });

  it('rejects a bad status', () => {
    expect(() => validateToggleConfig('x', { status: 'maybe' })).toThrow(/on.*off.*beta/);
  });

  it('validates variant bindings', () => {
    const c = validateToggleConfig('x', {
      status: 'on',
      variants: [
        { key: 'A', weight: 50, bindings: [{ slot: 'crm.triage', ref: { kind: 'agent', name: 'feature.crm.agents/triage-v2', version: '1.0.0' } }] },
        { key: 'B', weight: 50 },
      ],
    });
    expect(c.variants?.[0]?.bindings?.[0]?.ref.kind).toBe('agent');
  });

  it('rejects a binding with a bad ref kind', () => {
    expect(() => validateToggleConfig('x', {
      status: 'on',
      variants: [{ key: 'A', weight: 100, bindings: [{ slot: 's', ref: { kind: 'weapon', name: 'n', version: '1' } }] }],
    })).toThrow(/agent.*node.*prompt/);
  });
});
