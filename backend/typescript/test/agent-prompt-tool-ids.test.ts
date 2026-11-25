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
 *   3. every host agent tool, read from the RUNTIME registry
 *      (`builtinAgentToolIds()` after `createApp`, so every feature, adopter
 *      features included, has registered).
 *   4. every client tool (ADR 1099 D5), from `clientProjectToolIds()` — the
 *      registry a collaborator turn compiles from.
 * A prompt that names a tool the model cannot call is a lie to the model; a new
 * one fails here instead of shipping.
 *
 * #5992: step 3 used to scan files named `agentTools.ts`. A tool registered from
 * any other module (`askUserTool.ts`, `walkthroughAuthorTool.ts`, an adopter's
 * `offers.ts`) read as a phantom, and every `openwop:` string in a scanned file
 * counted as registered, comments included. The registry is the truth on both
 * counts, the same instrument as schema-read-exemption-completeness.
 *
 * TST-BLS-2. Red when: any agent-pack prompt/README/manifest names a phantom
 * `openwop:` id (w65 probe: `openwop:knowledge.search-phantom` in kb-researcher).
 */
import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { createApp } from '../src/index.js';
import { builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import { clientProjectToolIds } from '../src/host/clientProjectTools.js';

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
  // 3. host agent tools, from the runtime registry (the caller booted the app)
  for (const id of builtinAgentToolIds()) universe.add(trim(id));
  // 4. ADR 1099 D5 — client tools, from their own runtime registry. A collaborator
  //    turn compiles ONLY these, so they never appear in the agent tool registry.
  for (const id of clientProjectToolIds()) universe.add(trim(id));
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

/** The `openwop:` mentions in `text` that resolve to nothing. */
function phantomMentions(text: string, universe: Set<string>): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(ID_RE)) {
    const mention = trim(m[0]);
    if (mention.length === 0) continue; // `openwop:...` placeholder prose
    if (!resolves(mention, universe)) out.push(`openwop:${mention}`);
  }
  return out;
}

describe('every openwop:-prefixed tool id in agent packs resolves (XCH-AGT-1)', () => {
  let server: http.Server | undefined;
  let universe = new Set<string>();
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', res); });
    universe = collectUniverse();
  });
  afterAll(async () => {
    await new Promise<void>((res) => (server ? server.close(() => res()) : res()));
  });

  it('collected a plausible universe', () => {
    // MEASURED 2026-11-16: 966 with the runtime registry (982 on 2026-10-24
    // under the file scan, which also counted every `openwop:` string in a
    // scanned file). A near-truth floor, so a universe that silently shrinks
    // (a registration path that stops running) reds instead of passing every mention.
    expect(universe.size).toBeGreaterThan(951);
    expect(universe.has('core.files.read')).toBe(true);
    expect(universe.has('core.files.fs-read')).toBe(false);
  });

  it('counts a tool registered outside an agentTools.ts file (#5992)', () => {
    // Both register from modules the old filename scan never read.
    expect(universe.has('walkthroughs.register-draft')).toBe(true);
    expect(universe.has('runs.diagnose')).toBe(true);
  });

  it('still refuses an id that no module registers (sabotage witness, #5992)', () => {
    expect(resolves('phantom.never-registered', universe)).toBe(false);
    expect(phantomMentions('see openwop:phantom.never-registered and openwop:core.files.read', universe))
      .toEqual(['openwop:phantom.never-registered']);
  });

  it('finds zero phantom tool ids across all agent packs', () => {
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
        for (const m of phantomMentions(readFileSync(file, 'utf8'), universe)) offenders.push(`${dir}/${file.split('/').pop()}: ${m}`);
      }
    }
    expect(offenders, `phantom tool ids mentioned to models:\n${offenders.join('\n')}`).toEqual([]);
  });
});

/**
 * ADR 0904 D11 — the knowledge tools' model-facing text is true in EVERY retrieval
 * configuration. It said "lexical retrieval over the seeded corpus (deterministic, no
 * network)", false under BYOK embeddings and false for everyone once an operator embedder
 * is on (the query may leave the host to an embeddings API). One fixed string, not a
 * per-tenant one, so the tool block stays byte-stable for prompt caching (ADR 0315).
 * Sabotage: restore "lexical" in either description or the kb-researcher prompt ⇒ red.
 */
describe('ADR 0904 D11 — knowledge tool text tells the model the truth', () => {
  it('the tool descriptions and the kb-researcher prompt never promise lexical / no network / a seeded corpus', async () => {
    const { KNOWLEDGE_TOOL_DESCRIPTION, KNOWLEDGE_RETRIEVER_DESCRIPTION } = await import('../src/host/agentToolProvider.js');
    for (const text of [KNOWLEDGE_TOOL_DESCRIPTION, KNOWLEDGE_RETRIEVER_DESCRIPTION]) {
      expect(text).not.toMatch(/lexical|no network|deterministic|seeded corpus/i);
      expect(text).toMatch(/semantic and keyword/);
    }
    const prompt = readFileSync(join(PACKS_DIR, 'vendor.openwop-app.kb.agents/prompts/kb-researcher.md'), 'utf8');
    expect(prompt).not.toMatch(/lexical|seeded corpus/i);
    const src = readFileSync(join(SRC_DIR, 'host/agentToolProvider.ts'), 'utf8');
    expect(src, 'both tools use the shared constants').toMatch(/description:\s*\n?\s*KNOWLEDGE_TOOL_DESCRIPTION/);
    expect(src).toMatch(/description:\s*\n?\s*KNOWLEDGE_RETRIEVER_DESCRIPTION/);
  });
});
