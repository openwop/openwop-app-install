/**
 * The run admission preflight ADR (D3, ratchet) — every cross-feature read a
 * vendored node pack makes is DECLARED, so the required-feature check is
 * complete by construction, not by memory.
 *
 * A node in `packs/feature.<own>.nodes` that reads `ctx.features.<other>` (or
 * `ctx.features['<other>']`) must have `<other>` declared, required or
 * optional, either in its pack manifest (`x-requiresFeatureSurfaces` /
 * `x-optionalFeatureSurfaces`) or in the host table
 * (`src/host/nodeFeatureRequirements.ts`, an exact typeId of that pack or the
 * pack-wide `<pack>.*` entry). The table must also stay honest: no entry for a
 * pack or node type that does not exist, no declared read the pack no longer
 * makes, and a pack-wide entry is never `required` (it has not been reviewed
 * per node, so it may only ever be optional).
 *
 * Granularity: the read is attributed to the PACK (shared helpers make
 * per-node attribution unreliable from source text); per-node `required` is a
 * reviewed claim in the table.
 *
 * Sabotage witnesses (each must turn this file red):
 *  - delete the `'feature.production.nodes.*'` entry → "undeclared:
 *    feature.production.nodes → campaign-brief";
 *  - add `const x = ctx.features.crm;` to packs/feature.strategy.nodes/index.mjs
 *    → "undeclared: feature.strategy.nodes → crm";
 *  - add `'feature.strategy.nodes.*': { optional: ['documents', 'media'] }` → the
 *    stale-declaration case names `media`;
 *  - put `required: ['documents']` on a `.*` entry → the pack-wide case.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NODE_FEATURE_REQUIREMENTS, nodePackOf } from '../src/host/nodeFeatureRequirements.js';

const REPO = join(__dirname, '..', '..', '..');
const PACKS = join(REPO, 'packs');

const READ = /ctx\.features\s*(?:\?\.)?\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([^'"]+)['"]\s*\])/g;

function sourcesOf(dir: string): string {
  let out = '';
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'node_modules' || name.startsWith('.')) continue;
    if (statSync(p).isDirectory()) out += sourcesOf(p);
    else if (/\.(mjs|js|cjs)$/.test(name)) out += `\n${readFileSync(p, 'utf-8')}`;
  }
  return out;
}

interface PackInfo { own: string; reads: Set<string>; typeIds: Set<string>; manifestDeclared: Set<string> }

function scan(): Map<string, PackInfo> {
  const packs = new Map<string, PackInfo>();
  for (const name of readdirSync(PACKS)) {
    const m = /^feature\.(.+)\.nodes$/.exec(name);
    if (!m) continue;
    const dir = join(PACKS, name);
    const manifestPath = join(dir, 'pack.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { nodes?: Array<Record<string, unknown>> };
    const typeIds = new Set<string>();
    const manifestDeclared = new Set<string>();
    for (const n of manifest.nodes ?? []) {
      if (typeof n.typeId === 'string') typeIds.add(n.typeId);
      for (const k of ['x-requiresFeatureSurfaces', 'x-optionalFeatureSurfaces']) {
        const v = n[k];
        if (Array.isArray(v)) for (const id of v) if (typeof id === 'string') manifestDeclared.add(id);
      }
    }
    const own = m[1] ?? "";
    const reads = new Set<string>();
    for (const r of sourcesOf(dir).matchAll(READ)) {
      const id = r[1] ?? r[2];
      if (id && id !== own) reads.add(id);
    }
    packs.set(name, { own, reads, typeIds, manifestDeclared });
  }
  return packs;
}

function tableDeclaredFor(pack: string): Set<string> {
  const out = new Set<string>();
  for (const [key, entry] of Object.entries(NODE_FEATURE_REQUIREMENTS)) {
    const keyPack = key.endsWith('.*') ? key.slice(0, -2) : nodePackOf(key);
    if (keyPack !== pack) continue;
    for (const id of [...(entry.required ?? []), ...(entry.optional ?? [])]) out.add(id);
  }
  return out;
}

describe('run admission preflight D3 — the cross-feature read census', () => {
  const packs = scan();

  it('scans the vendored feature node packs (non-vacuous)', () => {
    expect(packs.size).toBeGreaterThan(20);
    expect(packs.get('feature.campaign-channels.nodes')?.reads.has('documents')).toBe(true);
  });

  it('every cross-feature read is declared (manifest or host table)', () => {
    const undeclared: string[] = [];
    for (const [pack, info] of packs) {
      const declared = new Set([...info.manifestDeclared, ...tableDeclaredFor(pack)]);
      for (const id of info.reads) if (!declared.has(id)) undeclared.push(`undeclared: ${pack} → ${id}`);
    }
    expect(undeclared).toEqual([]);
  });

  it('the host table names only real packs and node types, and no read a pack no longer makes', () => {
    const problems: string[] = [];
    for (const [key, entry] of Object.entries(NODE_FEATURE_REQUIREMENTS)) {
      const wildcard = key.endsWith('.*');
      const pack = wildcard ? key.slice(0, -2) : nodePackOf(key);
      const info = pack ? packs.get(pack) : undefined;
      if (!info) { problems.push(`no such pack: ${key}`); continue; }
      if (!wildcard && !info.typeIds.has(key)) problems.push(`no such node type: ${key}`);
      for (const id of [...(entry.required ?? []), ...(entry.optional ?? [])]) {
        if (!info.reads.has(id)) problems.push(`stale declaration: ${key} → ${id}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('a pack-wide entry is never required (it has not been reviewed per node)', () => {
    const wide = Object.entries(NODE_FEATURE_REQUIREMENTS).filter(([k, e]) => k.endsWith('.*') && (e.required?.length ?? 0) > 0).map(([k]) => k);
    expect(wide).toEqual([]);
  });
});
