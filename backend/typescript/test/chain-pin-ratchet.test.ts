/**
 * ADR 0766 D2 — the unpinned-chain ratchet may only SHRINK, and it must not
 * carry a stale entry.
 *
 * `UNPINNED_CHAIN_PACK_ALLOWLIST` waives the RFC 0177 §E.1 register-time refusal
 * for the in-tree chain packs that were unpinned when the refusal landed. P3 pins
 * them; this test is what makes each pinning PR also delete its waiver, and what
 * stops a new unpinned pack from shipping behind the list.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chainPinFindings } from '../src/host/chainPinRule.js';
import { UNPINNED_CHAIN_PACK_ALLOWLIST } from '../src/host/unpinnedChainPackAllowlist.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// The e2e boot (`scripts/ci.sh`, OPENWOP_WORKFLOW_CHAIN_PACKS_DIR) loads its own
// fixture copies under ratchet names; without this root P3 could drain an entry
// the fixtures still need and nothing here would notice (code-review finding).
const ROOTS = [
  join(REPO, 'examples', 'workflow-chain-packs'),
  join(REPO, 'packs'),
  join(REPO, 'frontend', 'react', 'e2e', 'fixtures', 'chain-packs'),
];

interface InTreeChainPack { name: string; path: string; unpinned: boolean }

function inTreeChainPacks(): InTreeChainPack[] {
  const out: InTreeChainPack[] = [];
  for (const root of ROOTS) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const file = join(root, entry, 'pack.json');
      if (!existsSync(file)) continue;
      const manifest = JSON.parse(readFileSync(file, 'utf8')) as { name: string; kind?: string; chains?: unknown[] };
      if (manifest.kind !== 'workflow-chain') continue;
      const unpinned = (manifest.chains ?? []).some((c) => chainPinFindings(c as Record<string, unknown>).length > 0);
      out.push({ name: manifest.name, path: file, unpinned });
    }
  }
  return out;
}

describe('ADR 0766 D2 — unpinned chain-pack ratchet', () => {
  const packs = inTreeChainPacks();

  it('the scan found the in-tree chain packs (a vacuous scan would pass everything)', () => {
    expect(packs.length).toBeGreaterThanOrEqual(60);
  });

  it('every UNPINNED in-tree chain pack is on the ratchet (a new one ships pinned)', () => {
    const offList = packs.filter((p) => p.unpinned && !UNPINNED_CHAIN_PACK_ALLOWLIST.has(p.name)).map((p) => p.name);
    expect(offList, 'these packs carry unpinned node references and are not waived — pin them (`npm run chains:pin -- --write` in backend/typescript)').toEqual([]);
  });

  it('no ratchet entry is STALE — a pinned or missing pack must leave the list', () => {
    // A name can appear in more than one root (the e2e fixtures copy four packs);
    // the waiver is still needed while ANY copy is unpinned.
    const needsWaiver = new Set(packs.filter((p) => p.unpinned).map((p) => p.name));
    const stale = [...UNPINNED_CHAIN_PACK_ALLOWLIST].filter((name) => !needsWaiver.has(name));
    expect(stale, 'these waivers no longer waive anything — delete them from unpinnedChainPackAllowlist.ts').toEqual([]);
  });

  it('the ratchet is EMPTY since ADR 0766 P3 — a new chain pack ships pinned or does not load', () => {
    expect([...UNPINNED_CHAIN_PACK_ALLOWLIST]).toEqual([]);
  });
});
