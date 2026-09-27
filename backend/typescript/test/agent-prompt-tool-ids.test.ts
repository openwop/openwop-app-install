/**
 * XCH-AGT-1 / XCH-ADS-1 tripwire (LLM-EXCHANGE-AUDIT 2026-07-13): agent packs
 * told models to call tool ids that do not exist — 13 core prompts carried an
 * aliased vocabulary (`core.files.fs-read`, `core.http.fetch`,
 * `core.rag.retrieve`, …) while their allowlists carried the real ids, and
 * vendor.myndhyve.ads-crew ALLOWLISTED four phantom nodes. This lint pins every
 * `openwop:`-prefixed id mentioned in any agent-pack prompt, README, manifest
 * description, or toolAllowlist to the real tool universe:
 *   1. every pack-declared node typeId (packs/&#42;/pack.json nodes[]),
 *   2. every host-registered node typeId (bootstrap/nodes.ts),
 *   3. every host agent tool (agentToolProvider.ts + features/&#42;/agentTools.ts).
 * A prompt that names a tool the model cannot call is a lie to the model; a new
 * one fails here instead of shipping.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '../../..');
const PACKS_DIR = join(REPO_ROOT, 'packs');
const SRC_DIR = join(here, '../src');

const ID_RE = /openwop:[A-Za-z0-9._-]+/g;
const trim = (id: string) => id.replace(/^openwop:/, '').replace(/[.\s]+$/, '');

function collectUniverse(): Set<string> {
  const universe = new Set<string>();
  // 1. pack-declared node typeIds
  for (const dir of readdirSync(PACKS_DIR)) {
    const manifestPath = join(PACKS_DIR, dir, 'pack.json');
    if (!existsSync(manifestPath)) continue;
    let manifest: { nodes?: Array<{ typeId?: string }> };
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { continue; }
    for (const n of manifest.nodes ?? []) if (n.typeId) universe.add(n.typeId);
  }
  // 2. host-registered node typeIds (source scan — same style as the
  //    voice-tool-parity source pins)
  const bootstrap = readFileSync(join(SRC_DIR, 'bootstrap/nodes.ts'), 'utf8');
  for (const m of bootstrap.matchAll(/typeId:\s*'([^']+)'/g)) universe.add(m[1]!);
  // 3. host agent tools: static builtins + every registerFeatureAgentTool site
  //    (+ the core composition-lane tools, ADR 0369/0473 — declared in
  //    host/workflowComposeTool.ts, the one core module outside the two scan
  //    patterns whose tool ids appear in pack manifests/prompts)
  const toolSources = [join(SRC_DIR, 'host/agentToolProvider.ts'), join(SRC_DIR, 'host/workflowComposeTool.ts')];
  const featuresDir = join(SRC_DIR, 'features');
  for (const feature of readdirSync(featuresDir)) {
    const agentTools = join(featuresDir, feature, 'agentTools.ts');
    if (existsSync(agentTools)) toolSources.push(agentTools);
  }
  for (const source of toolSources) {
    const text = readFileSync(source, 'utf8');
    for (const m of text.matchAll(ID_RE)) universe.add(trim(m[0]));
  }
  return universe;
}

/** A mention resolves if it is a known id, or a namespace/brace-expansion
 *  prefix of one — prompts legitimately say `openwop:ads.publish.{meta,…}`
 *  (regex stops at the brace, leaving a `-` or `.` suffixed stem). A bare
 *  `openwop:...` placeholder trims to empty and is skipped by the caller. */
function resolves(mention: string, universe: Set<string>): boolean {
  if (universe.has(mention)) return true;
  const stems = mention.endsWith('-') ? [mention] : [`${mention}.`, `${mention}-`];
  for (const id of universe) if (stems.some((s) => id.startsWith(s))) return true;
  return false;
}

describe('every openwop:-prefixed tool id in agent packs resolves (XCH-AGT-1)', () => {
  const universe = collectUniverse();
  it('collected a plausible universe', () => {
    expect(universe.size).toBeGreaterThan(500);
    expect(universe.has('core.files.read')).toBe(true);
    expect(universe.has('core.files.fs-read')).toBe(false);
  });

  const offenders: string[] = [];
  for (const dir of readdirSync(PACKS_DIR)) {
    const packDir = join(PACKS_DIR, dir);
    const manifestPath = join(packDir, 'pack.json');
    if (!existsSync(manifestPath)) continue;
    let manifest: { agents?: unknown[] };
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { continue; }
    if (!Array.isArray(manifest.agents) || manifest.agents.length === 0) continue;
    const files = [manifestPath, join(packDir, 'README.md')];
    const promptsDir = join(packDir, 'prompts');
    if (existsSync(promptsDir)) for (const f of readdirSync(promptsDir)) files.push(join(promptsDir, f));
    for (const file of files) {
      if (!existsSync(file)) continue;
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(ID_RE)) {
        const mention = trim(m[0]);
        if (mention.length === 0) continue; // `openwop:...` placeholder prose
        if (!resolves(mention, universe)) offenders.push(`${dir}/${file.split('/').pop()}: openwop:${mention}`);
      }
    }
  }

  it('finds zero phantom tool ids across all agent packs', () => {
    expect(offenders, `phantom tool ids mentioned to models:\n${offenders.join('\n')}`).toEqual([]);
  });
});
