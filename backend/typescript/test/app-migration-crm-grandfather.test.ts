/**
 * ADR 0892 — app migration 23 `grandfather-crm-on-for-existing-users`.
 *
 * CRM's compiled default moved on → off. An install that already uses CRM but
 * never saved a `crm` toggle row rode the old default; without this migration its
 * CRM UI and API would vanish on upgrade (and any enabled CRM dependent would run
 * with CRM off). The migration writes the CRM default with status `on` only when
 * no `crm` row exists AND a CRM contact or an enabled dependent is present.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { APP_MIGRATIONS, CRM_DEPENDENT_TOGGLES } from '../src/host/appMigrations.js';
import { BACKEND_FEATURES } from '../src/features/index.js';
import { crmFeature } from '../src/features/crm/feature.js';

const KEY = 'hostext:feature-toggle:crm';
const migration = APP_MIGRATIONS.find((m) => m.name === 'grandfather-crm-on-for-existing-users')!;
let storage: Storage;

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

const row = async (): Promise<Record<string, unknown> | null> => {
  const raw = await storage.kvGet(KEY);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
};

describe('app migration 23 — grandfather CRM on for installs that use it', () => {
  it('is version 23 in the real APP_MIGRATIONS set', () => {
    expect(migration.version).toBe(23);
    expect(APP_MIGRATIONS.filter((m) => m.version === 23)).toHaveLength(1);
  });

  it('a fresh install (no CRM data, no dependents) stays on the off default', async () => {
    await migration.run(storage);
    expect(await row()).toBeNull();
  });

  it('an install with CRM contacts keeps CRM on, with its A/B variants', async () => {
    await storage.kvSet('hostext:crm:contact:c1', JSON.stringify({ contactId: 'c1', tenantId: 'user:a' }));
    await migration.run(storage);
    const r = await row();
    expect(r).toMatchObject({ id: 'crm', status: 'on', bucketUnit: 'tenant', salt: 'crm', updatedBy: 'app-migration:23', overriddenDefaultStatus: 'off' });
    expect((r!.variants as Array<{ key: string }>).map((v) => v.key).sort()).toEqual(['basic', 'enriched']);
  });

  it('an enabled dependent (globally or for one tenant) keeps CRM on', async () => {
    await storage.kvSet('hostext:feature-toggle:commerce', JSON.stringify({ id: 'commerce', status: 'off', tenantOverrides: { 'ws:shop': { status: 'on' } } }));
    await migration.run(storage);
    expect((await row())?.status).toBe('on');
  });

  it('a killed or off dependent does not', async () => {
    await storage.kvSet('hostext:feature-toggle:csm', JSON.stringify({ id: 'csm', status: 'on', killed: true }));
    await storage.kvSet('hostext:feature-toggle:email', JSON.stringify({ id: 'email', status: 'off' }));
    await migration.run(storage);
    expect(await row()).toBeNull();
  });

  it('never touches an existing crm row (an admin choice wins), and is idempotent', async () => {
    const admin = JSON.stringify({ id: 'crm', status: 'off', updatedBy: 'superadmin' });
    await storage.kvSet(KEY, admin);
    await storage.kvSet('hostext:crm:contact:c1', JSON.stringify({ contactId: 'c1', tenantId: 'user:a' }));
    await migration.run(storage);
    await migration.run(storage);
    expect(await storage.kvGet(KEY)).toBe(admin);
  });

  it('CRM_DEPENDENT_TOGGLES is exactly the dependsOn closure that reaches crm', () => {
    const deps = new Map(BACKEND_FEATURES.map((f) => [f.toggleDefault?.id ?? f.id, f.dependsOn ?? []]));
    const reaches = (id: string, seen = new Set<string>()): boolean => {
      for (const d of deps.get(id) ?? []) {
        if (d === 'crm') return true;
        if (!seen.has(d)) { seen.add(d); if (reaches(d, seen)) return true; }
      }
      return false;
    };
    const closure = [...deps.keys()].filter((id) => id !== 'crm' && reaches(id)).sort();
    expect([...CRM_DEPENDENT_TOGGLES].sort()).toEqual(closure);
    expect(crmFeature.toggleDefault?.status).toBe('off');
  });
});
