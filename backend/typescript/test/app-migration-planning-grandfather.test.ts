/**
 * ADR 0892 extension — app migration 24 `grandfather-planning-on-for-existing-users`.
 * strategy / priority-matrix / advisory-board moved on → off. Per toggle: data for
 * that feature and no saved row ⇒ keep it on; otherwise unchanged.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { APP_MIGRATIONS } from '../src/host/appMigrations.js';

const migration = APP_MIGRATIONS.find((m) => m.name === 'grandfather-planning-on-for-existing-users')!;
let storage: Storage;
beforeEach(async () => { storage = await openStorage('memory://'); initHostExtPersistence(storage); });
const row = async (id: string): Promise<Record<string, unknown> | null> => {
  const raw = await storage.kvGet(`hostext:feature-toggle:${id}`);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
};

describe('app migration 24 — grandfather planning surfaces on for installs that use them', () => {
  it('is version 24, after the CRM grandfather (23)', () => {
    expect(migration.version).toBe(24);
    expect(APP_MIGRATIONS.filter((m) => m.version === 24)).toHaveLength(1);
  });

  it('a fresh install keeps all three on the off default', async () => {
    await migration.run(storage);
    for (const id of ['strategy', 'priority-matrix', 'advisory-board']) expect(await row(id)).toBeNull();
  });

  it('decides per feature: only the ones with data are kept on', async () => {
    await storage.kvSet('hostext:strategy:record:r1', JSON.stringify({ id: 'r1', tenantId: 'user:a' }));
    await storage.kvSet('hostext:advisory:board:b1', JSON.stringify({ id: 'b1', tenantId: 'user:a' }));
    await migration.run(storage);
    expect(await row('strategy')).toMatchObject({ id: 'strategy', status: 'on', updatedBy: 'app-migration:24', overriddenDefaultStatus: 'off' });
    expect(await row('advisory-board')).toMatchObject({ id: 'advisory-board', status: 'on' });
    expect(await row('priority-matrix')).toBeNull();
  });

  it('priority-matrix lists keep priority-matrix on', async () => {
    await storage.kvSet('hostext:priority-matrix:list:l1', JSON.stringify({ id: 'l1', tenantId: 'user:a' }));
    await migration.run(storage);
    expect((await row('priority-matrix'))?.status).toBe('on');
  });

  it('never touches a saved row, and is idempotent', async () => {
    const admin = JSON.stringify({ id: 'strategy', status: 'off', updatedBy: 'superadmin' });
    await storage.kvSet('hostext:feature-toggle:strategy', admin);
    await storage.kvSet('hostext:strategy:record:r1', JSON.stringify({ id: 'r1', tenantId: 'user:a' }));
    await migration.run(storage);
    await migration.run(storage);
    expect(await storage.kvGet('hostext:feature-toggle:strategy')).toBe(admin);
  });
});
