/**
 * ADR 0755 (WIT-FIX-4) — the REAL installed-pack probe behind `isResolvable`.
 *
 * `conformance-fixture-advert-pack-lane.test.ts` proves the advert CONSULTS the
 * probe, but injects a fake one; nothing ran `nodePackResolver.ts` itself. A
 * regression in `packEntryFor` (the manifest index, the parked-dir filter) would
 * silently withhold every pack-backed fixture in a real boot — ten of them ride
 * `core.ai.structuredOutput` — while every test stayed green. This drives the
 * real probe against a real `pack.json` in the per-worker pack dir. Its own file
 * because the resolver is a process-global.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDefaultPackDir } from '../src/packs/registryInstaller.js';
import { ensureNodePackResolverInstalled } from '../src/bootstrap/nodePackResolver.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import type { Storage } from '../src/storage/storage.js';

const TYPE_ID = 'vendor.adr0755.probe.node';
const DIR = join(resolveDefaultPackDir(), 'vendor.adr0755.probe');
const PARKED = `${DIR}.registry-1`;

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  rmSync(PARKED, { recursive: true, force: true });
});

describe('ADR 0755 (WIT-FIX-4) — nodePackResolver probe', () => {
  it('an installed manifest declaring the typeId makes it resolvable; parking the pack withdraws it', () => {
    ensureNodePackResolverInstalled({} as Storage);
    const registry = getNodeRegistry();
    expect(registry.has(TYPE_ID), 'premise: not registered in-process').toBe(false);
    expect(registry.isResolvable(TYPE_ID), 'nothing installed yet').toBe(false);

    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, 'pack.json'), JSON.stringify({ name: 'vendor.adr0755.probe', version: '1.0.0', nodes: [{ typeId: TYPE_ID }] }));
    expect(registry.isResolvable(TYPE_ID), 'the real probe reads the installed manifest').toBe(true);

    // A parked `.registry-<n>` dir is a displaced install, not a live one.
    renameSync(DIR, PARKED);
    expect(registry.isResolvable(TYPE_ID), 'a parked pack is not resolvable').toBe(false);
  });
});
