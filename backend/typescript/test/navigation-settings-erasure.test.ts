/**
 * ADR 0587 §3 — `navigation-settings:config` subject erasure.
 *
 * Surfaced by widening the feature-store erasure gate to bind the bare field name
 * `subject` (the AGMEM-4 ninth blind mechanism). Before that widening this store
 * was in NO denominator: a person's stored navigation personalization survived
 * their DSAR and nothing counted it.
 *
 * Registering the eraser rather than recording a tenth debt entry is deliberate —
 * a six-line point-delete is cheaper and more honest than raising a ceiling.
 *
 * Erasure is read back from the RAW store (`navigation-settings:config`, keys
 * `<t>:tenant` / `<t>:user:<u>`): `getBundle` answers an empty config both for a
 * deleted row and for a blanked one, so it cannot show the row is GONE.
 *
 * Sabotage witnesses (w35): dropping the user-row delete, deleting the tenant row
 * instead of re-attributing it, dropping the `updatedBy` re-attribution, and
 * dropping the falsy-input guard each red a case below.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { DurableCollection, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import {
  putUserConfig,
  putTenantConfig,
  getBundle,
  getTenantBundle,
  eraseNavigationSettingsSubject,
} from '../src/features/navigation-settings/service.js';
import { EMPTY_MENU_CONFIG } from '../src/features/navigation-settings/types.js';

const T = 'nav-erase-tenant';
const T2 = 'nav-erase-other';
const T3 = 'nav-erase-falsy';
/** The store's raw rows: only the fields this file asserts. */
const raw = new DurableCollection<{ id: string; updatedBy: string }>('navigation-settings:config', (s) => s.id);
const CONFIG = { ...EMPTY_MENU_CONFIG, items: { dashboard: { order: 1 } } };

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-nav-')) });
  initHostExtPersistence(await openStorage('memory://'));
});

describe('eraseNavigationSettingsSubject', () => {
  it('deletes the subject\'s USER layer and leaves the TENANT layer standing', async () => {
    await putTenantConfig(T, 'admin', CONFIG);
    await putUserConfig(T, 'alice', CONFIG);
    await putUserConfig(T, 'bob', CONFIG);
    await putUserConfig(T2, 'alice', CONFIG);

    await eraseNavigationSettingsSubject(T, 'user:alice');

    expect(await raw.get(`${T}:user:alice`), 'the user row is GONE, not blanked').toBeNull();
    expect(Object.keys((await getBundle(T, 'alice')).user.items)).toHaveLength(0);
    // ANTI-ROT — this is not "delete everything". Another member's menu, the same
    // person in another tenant (CTI-1), and the WORKSPACE's own config all survive;
    // deleting the tenant layer on one member's DSAR would reset everyone's menu.
    expect(Object.keys((await getBundle(T, 'bob')).user.items)).toHaveLength(1);
    expect(Object.keys((await getBundle(T2, 'alice')).user.items)).toHaveLength(1);
    expect(Object.keys((await getTenantBundle(T)).tenant.items)).toHaveLength(1);
  });

  it('re-attributes the tenant row\'s actor without deleting the tenant config', async () => {
    await putTenantConfig(T2, 'carol', CONFIG);
    await eraseNavigationSettingsSubject(T2, 'user:carol');
    const bundle = await getTenantBundle(T2);
    expect(Object.keys(bundle.tenant.items)).toHaveLength(1); // the workspace keeps its menu
    const row = await raw.get(`${T2}:tenant`);
    expect(row?.updatedBy).toBe('erased:subject');
    expect(JSON.stringify(row)).not.toContain('carol');
  });

  it('is idempotent', async () => {
    await putUserConfig(T, 'dave', CONFIG);
    await eraseNavigationSettingsSubject(T, 'user:dave');
    await eraseNavigationSettingsSubject(T, 'user:dave');
    expect(await raw.get(`${T}:user:dave`)).toBeNull();
  });

  it('is fail-closed on falsy input: it touches no row', async () => {
    // Seed exactly the rows a guardless eraser would reach: an empty tenant id
    // still builds `:user:<id>`, and an empty subject expands to the forms
    // '' and 'user:' (so `<t>:user:user:` and a tenant row attributed to '').
    await putUserConfig('', 'dave', CONFIG);
    await putUserConfig(T3, 'user:', CONFIG);
    await putTenantConfig(T3, '', CONFIG);
    await eraseNavigationSettingsSubject('', 'user:dave');
    await eraseNavigationSettingsSubject(T3, '');
    expect(await raw.get(':user:dave'), 'empty tenant id: nothing erased').not.toBeNull();
    expect(await raw.get(`${T3}:user:user:`), 'empty subject: nothing erased').not.toBeNull();
    expect((await raw.get(`${T3}:tenant`))?.updatedBy, 'empty subject: nothing re-attributed').toBe('');
  });
});
