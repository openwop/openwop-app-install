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
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
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
  });

  it('is idempotent and fail-closed on falsy input', async () => {
    await putUserConfig(T, 'dave', CONFIG);
    await eraseNavigationSettingsSubject(T, 'user:dave');
    await eraseNavigationSettingsSubject(T, 'user:dave');
    await eraseNavigationSettingsSubject('', 'user:dave');
    await eraseNavigationSettingsSubject(T, '');
    expect(Object.keys((await getBundle(T, 'dave')).user.items)).toHaveLength(0);
  });
});
