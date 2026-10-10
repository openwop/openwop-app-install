/**
 * The pinned `/builder` gallery fixture (`frontend/react/e2e/fixtures/chain-packs`,
 * ADR 0626 P2) must pin the node versions this repo actually ships.
 *
 * WHY: the fixture freezes the gallery so its visual baseline stops decaying with
 * repo content. But its chains pin node versions (ADR 0766 `typeId@version`), and
 * a node bump in `packs/` turns a fixture pin into a PIN MISMATCH. The gallery
 * then moves that template out of "Start here" — in the test environment only,
 * because the shipped in-tree chain pack is re-pinned with the bump. MEASURED
 * 2026-10-08: two ADR 0835 bumps (apply-repair 1.0.1, kanban materialize 1.1.1)
 * reddened the advisory builder snapshot for two days with a layout that no user
 * could see, and nothing said why. This test says why, at the bump.
 *
 * Built-in node types that no `packs/` manifest declares (e.g. `core.approvalGate`)
 * are out of scope: they are not versioned through packs, so they cannot drift here.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURE_ROOT = join(REPO, 'frontend', 'react', 'e2e', 'fixtures', 'chain-packs');
const PACKS = join(REPO, 'packs');

function installedNodeVersions(): Map<string, string> {
  const out = new Map<string, string>();
  for (const dir of readdirSync(PACKS)) {
    const manifest = join(PACKS, dir, 'pack.json');
    if (!existsSync(manifest)) continue;
    let pack: { nodes?: Array<{ typeId?: unknown; version?: unknown }> };
    try { pack = JSON.parse(readFileSync(manifest, 'utf8')); } catch { continue; }
    for (const n of pack.nodes ?? []) {
      if (typeof n.typeId === 'string' && typeof n.version === 'string') out.set(n.typeId, n.version);
    }
  }
  return out;
}

describe('the /builder gallery fixture pins the node versions this repo ships', () => {
  it('every pinned pack node in the fixture matches its installed version', () => {
    const installed = installedNodeVersions();
    expect(installed.size, 'the packs/ walk found node manifests').toBeGreaterThan(50);
    const packs = readdirSync(FIXTURE_ROOT).filter((d) => existsSync(join(FIXTURE_ROOT, d, 'pack.json')));
    expect(packs.length, 'the fixture walk found chain packs').toBeGreaterThan(0);

    const mismatches: string[] = [];
    let checked = 0;
    for (const dir of packs) {
      const pack = JSON.parse(readFileSync(join(FIXTURE_ROOT, dir, 'pack.json'), 'utf8')) as {
        chains?: Array<{ chainId: string; dag?: { nodes?: Array<{ typeId?: string }> } }>;
      };
      for (const chain of pack.chains ?? []) {
        for (const node of chain.dag?.nodes ?? []) {
          const [typeId, pinned] = (node.typeId ?? '').split('@');
          if (!typeId || !pinned || !installed.has(typeId)) continue;
          checked += 1;
          if (installed.get(typeId) !== pinned) {
            mismatches.push(`${dir}/${chain.chainId}: ${typeId} pinned ${pinned}, packs/ ships ${installed.get(typeId)}`);
          }
        }
      }
    }
    expect(checked, 'at least one pack-versioned pin was compared').toBeGreaterThan(5);
    expect(
      mismatches,
      'Re-pin the fixture to the shipped version (mirror the in-tree chain pack under examples/workflow-chain-packs). '
      + 'A stale pin silently moves the template out of "Start here" in the /builder snapshot only:\n'
      + mismatches.join('\n'),
    ).toEqual([]);
  });
});
