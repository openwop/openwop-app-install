/**
 * ADR 0337 Phase 3 — the demo app-builder seed must be catalog-valid (it goes
 * through the SAME validateAppDoc gate as an editor PATCH) and idempotent.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerAppBuilderComponents } from '../src/features/app-builder/componentCatalog.js';
import { validateAppDoc } from '../src/features/app-builder/validateAppDoc.js';
import { seedDemoAppBuilder, countDemoAppBuilder, clearDemoAppBuilder, auroraDoc } from '../src/host/demoAppBuilderSeed.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault, registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { appBuilderFeature } from '../src/features/app-builder/feature.js';

const TENANT = 'org:demo-appbuilder-test';

beforeAll(() => { registerAppBuilderComponents(); if (appBuilderFeature.toggleDefault) registerToggleDefault(appBuilderFeature.toggleDefault); });
beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  const t = getToggleDefault('app-builder');
  if (t) await saveConfig({ ...t, status: 'on' }, 'test');
});

describe('demo app-builder seed (ADR 0337 P3)', () => {
  it('the seeded Aurora doc passes validateAppDoc (closed-world catalog)', async () => {
    const v = validateAppDoc(auroraDoc());
    expect(v.errors, JSON.stringify(v.errors.slice(0, 6))).toEqual([]);
    const res = await seedDemoAppBuilder(TENANT);
    expect(res.created).toBe(1);
    expect(await countDemoAppBuilder(TENANT)).toBe(1);
  });

  it('is idempotent — a second seed creates nothing; clear removes it', async () => {
    await seedDemoAppBuilder(TENANT);
    const again = await seedDemoAppBuilder(TENANT);
    expect(again.created).toBe(0);
    expect(await countDemoAppBuilder(TENANT)).toBe(1);
    const cleared = await clearDemoAppBuilder(TENANT);
    expect(cleared.cleared).toBe(1);
    expect(await countDemoAppBuilder(TENANT)).toBe(0);
  });

  it('skips honestly when the app-builder toggle is off', async () => {
    const t = getToggleDefault('app-builder');
    if (t) await saveConfig({ ...t, status: 'off' }, 'test');
    const res = await seedDemoAppBuilder(TENANT);
    expect(res.created).toBe(0);
    expect(await countDemoAppBuilder(TENANT)).toBe(0);
  });
});
