/**
 * ADR 0943 D1 — the campaign agent team is DATA. No source file keys on a team
 * agentId (David's law, "agent capability is core, not named"): a role's
 * capability is a tool in a feature's node pack or tool registry, activated by
 * the role's allowlist; a role's identity lives only in its agent pack.
 *
 * The team ids are read from the packs, not typed here, so a role added later is
 * covered without editing this file: every agent of the campaign-studio agents
 * pack except the canvas author (`default`, ADR 0153), plus the two reused
 * personas (Strategist, Media Buyer).
 *
 * One pre-existing occurrence is allowed, pinned exactly: the orchestration
 * tool's fallback speaker id (ADR 0158), which predates the team. The allowance
 * can only shrink: it fails when the occurrence is gone, so the entry is removed.
 *
 * Sabotage-witnessed (2026-10-20): planting a role id as a string in
 * `src/features/campaign-ops/types.ts` → red; dropping the pinned allowance → red.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SRC = join(ROOT, 'backend/typescript/src');

function agentIdsOf(pack: string): string[] {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'packs', pack, 'pack.json'), 'utf8')) as { agents: Array<{ agentId: string }> };
  return manifest.agents.map((a) => a.agentId);
}

const TEAM: string[] = [
  ...agentIdsOf('vendor.openwop-app.campaign-studio.agents').filter((id) => !id.endsWith('.default')),
  'vendor.openwop-app.campaign-orchestration.agents.campaign-strategist',
  'vendor.openwop-app.campaign-intel.agents.intelligence-analyst',
];

/** `relative path` → the team ids it may contain. Shrink-only. */
const ALLOWED: Record<string, string[]> = {
  'features/campaign-orchestration/agentTools.ts': ['vendor.openwop-app.campaign-orchestration.agents.campaign-strategist'],
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__') continue;
      out.push(...sourceFiles(p));
    } else if (/\.(ts|tsx|mts|js|mjs|json)$/.test(name) && !/\.test\./.test(name)) {
      out.push(p);
    }
  }
  return out;
}

describe('ADR 0943 D1 — no campaign team agentId in backend source', () => {
  it('the team is ten roles read from the packs', () => {
    expect(TEAM).toHaveLength(10);
    expect(new Set(TEAM).size).toBe(10);
  });

  const hits = new Map<string, string[]>();
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    const found = TEAM.filter((id) => text.includes(id));
    if (found.length > 0) hits.set(relative(SRC, file), found);
  }

  it('no source file names a team agentId outside the pinned allowance', () => {
    const unexpected = [...hits].flatMap(([file, ids]) => ids.filter((id) => !(ALLOWED[file] ?? []).includes(id)).map((id) => `${file}: ${id}`));
    expect(unexpected).toEqual([]);
  });

  it('the allowance only shrinks: every pinned occurrence still exists', () => {
    for (const [file, ids] of Object.entries(ALLOWED)) {
      for (const id of ids) expect(hits.get(file) ?? [], `${file} no longer names ${id}; delete the allowance`).toContain(id);
    }
  });
});
