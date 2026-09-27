/**
 * NODE-PACK-AUDIT step-3 tripwire — corpus-wide manifest↔impl parity, automated.
 * The 06-23 audit ran this as a manual sweep; a pack whose pack.json nodes[]
 * and index.mjs `nodes` export disagree ships a node that silently cannot load
 * (the loader reads the `nodes` export — tarballLoader.ts:101 — and the
 * resolver indexes pack.json typeIds; a mismatch on either side is invisible
 * drift). Walks every node pack in packs/ and asserts the two sides agree
 * EXACTLY, both directions.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKS_DIR = resolve(__dirname, '../../../packs');

function nodePackDirs(): string[] {
  return readdirSync(PACKS_DIR).filter((d) => {
    const pj = join(PACKS_DIR, d, 'pack.json');
    if (!existsSync(pj)) return false;
    const m = JSON.parse(readFileSync(pj, 'utf8')) as { nodes?: unknown[]; kind?: string };
    return Array.isArray(m.nodes) && m.nodes.length > 0;
  });
}

describe('pack manifest ↔ impl parity (every node pack)', () => {
  const dirs = nodePackDirs();
  it('finds the corpus (non-empty)', () => { expect(dirs.length).toBeGreaterThan(10); });

  it.each(dirs)('%s: pack.json nodes[] === index.mjs exports (both directions)', async (dir) => {
    const manifest = JSON.parse(readFileSync(join(PACKS_DIR, dir, 'pack.json'), 'utf8')) as
      { nodes: Array<{ typeId: string }>; runtime?: { entry?: string } };
    const entry = manifest.runtime?.entry ?? './index.mjs';
    const mod = (await import(pathToFileURL(join(PACKS_DIR, dir, entry)).href)) as { nodes?: Record<string, unknown> };
    expect(mod.nodes, `${dir}: entry must export a \`nodes\` map`).toBeTruthy();
    const declared = manifest.nodes.map((n) => n.typeId).sort();
    const implemented = Object.keys(mod.nodes ?? {}).sort();
    expect(implemented).toEqual(declared);
    for (const id of declared) expect(typeof (mod.nodes ?? {})[id], `${dir}:${id} must be a function`).toBe('function');
  });
});
