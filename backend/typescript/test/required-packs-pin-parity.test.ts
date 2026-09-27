/**
 * NODE-PACK-AUDIT pin↔disk tripwire — requiredPacks + node-binding version
 * parity, automated. Three consecutive audit passes (2026-06-23, 07-17, 07-18)
 * caught features whose `requiredPacks` pin lagged a pack bump on disk —
 * replay binds the PINNED version (RFC 0076), so a pin behind disk silently
 * won't resolve for a fresh install/replay. The companion of
 * `pack-manifest-impl-parity.test.ts`: that one guards manifest↔impl inside a
 * pack; this one guards feature↔pack across the seam.
 *
 * Scope: (1) every BACKEND_FEATURES `requiredPacks` entry names a pack that
 * exists on disk whose pack.json version matches the pin EXACTLY; (2) every
 * toggle-variant binding with `ref.kind === 'node'` names a typeId some pack
 * declares, at the declared node version. Agent/prompt binding refs are out of
 * scope here (different version semantics; no drift observed in that class).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BACKEND_FEATURES } from '../src/features/index.js';
import type { BackendFeature } from '../src/features/types.js';
import type { ToggleConfig, VariantBinding } from '../src/host/featureToggles/types.js';

const PACKS_DIR = resolve(__dirname, '../../../packs');

interface PackManifest {
  version?: string;
  nodes?: Array<{ typeId: string; version?: string }>;
}

function readManifest(packName: string): PackManifest | null {
  const pj = join(PACKS_DIR, packName, 'pack.json');
  if (!existsSync(pj)) return null;
  return JSON.parse(readFileSync(pj, 'utf8')) as PackManifest;
}

/** typeId → { packName, nodeVersion } across every pack on disk. */
function nodeIndex(): Map<string, { pack: string; version: string | undefined }> {
  const idx = new Map<string, { pack: string; version: string | undefined }>();
  for (const dir of readdirSync(PACKS_DIR)) {
    const m = readManifest(dir);
    for (const n of m?.nodes ?? []) idx.set(n.typeId, { pack: dir, version: n.version });
  }
  return idx;
}

function nodeBindings(f: BackendFeature): VariantBinding[] {
  const toggles: ToggleConfig[] = [
    ...(f.toggleDefault ? [f.toggleDefault] : []),
    ...(f.extraToggleDefaults ?? []),
  ];
  return toggles
    .flatMap((t) => t.variants ?? [])
    .flatMap((v) => v.bindings ?? [])
    .filter((b) => b.ref.kind === 'node');
}

describe('requiredPacks pin ↔ pack.json version parity (every backend feature)', () => {
  const pinned = BACKEND_FEATURES.filter((f) => (f.requiredPacks ?? []).length > 0);
  it('finds the pinned corpus (non-empty)', () => { expect(pinned.length).toBeGreaterThan(20); });

  it.each(pinned.map((f) => [f.id, f] as const))('%s: every requiredPacks pin matches disk', (_id, f) => {
    for (const ref of f.requiredPacks ?? []) {
      const m = readManifest(ref.name);
      expect(m, `${f.id}: pinned pack \`${ref.name}\` must exist under packs/`).toBeTruthy();
      expect(m?.version, `${f.id}: pin ${ref.name}@${ref.version} must match pack.json (disk has ${m?.version})`)
        .toBe(ref.version);
    }
  });
});

describe('toggle node-binding refs resolve to declared nodes at the pinned version', () => {
  const idx = nodeIndex();
  const bound = BACKEND_FEATURES
    .map((f) => [f.id, nodeBindings(f)] as const)
    .filter(([, bs]) => bs.length > 0);

  it.each(bound)('%s: every node binding resolves', (_id, bindings) => {
    for (const b of bindings) {
      const hit = idx.get(b.ref.name);
      expect(hit, `binding slot \`${b.slot}\` names node \`${b.ref.name}\` — no pack declares it`).toBeTruthy();
      expect(hit?.version, `node \`${b.ref.name}\` pinned @${b.ref.version} but pack ${hit?.pack} declares ${hit?.version}`)
        .toBe(b.ref.version);
    }
  });
});
