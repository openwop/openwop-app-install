/**
 * CFP-1 tripwire (CHAT-FIRST-PORT-AUDIT 2026-07-21, cross-cutting finding #1):
 * ~10 features shipped agents whose `toolAllowlist` entries are node typeIds
 * (or otherwise unregistered ids) that NO provider resolves — `compileAgentTools`
 * silently drops them (`agentDispatch.ts` resolveAgentTools: "Tools the host
 * can't describe are silently dropped"), so the persona loads, responds, and can
 * call nothing. It shipped green because the prior lint
 * (`agent-prompt-tool-ids.test.ts`) pins mentions to a universe that INCLUDES
 * raw node typeIds — it asserts the string, not resolution.
 *
 * This test asserts RESOLUTION: after booting the real app (every feature's
 * `registerFeatureAgentTool` registration live — the same seam dispatch uses),
 * every `toolAllowlist` entry of every agent pack must be offerable to a model,
 * i.e. present in `builtinAgentToolIds()`. Both dispatch lanes intersect the
 * allowlist with exactly this universe (chat: `conversationToolLoop.ts`;
 * runs: `agentRunnerNode.ts` `availableTools: offerTools ?? builtinAgentToolIds()`),
 * so an entry outside it is a lie to the model in every transport.
 *
 * Escape hatch: an entry may be listed in RUN_ONLY_EXEMPTIONS below with a
 * rationale — for agents dispatched ONLY by a workflow whose `offerTools`
 * explicitly widens the surface with a caller-resolved tool. Keep this list
 * SHORT and justified; if it grows, that is the signal the projection seam
 * needs a real design (RFC), not more exemptions.
 *
 * Non-vacuity (w73 g4): a pack.json that fails to parse used to be skipped
 * silently (`catch { continue }`), so its agents were never checked. Parse
 * failures are now collected and asserted empty, and each case floors the
 * population it scanned. MEASURED at 9f4cca7d4: 112 agents, 309 allowlist
 * entries, 812 declared node typeIds.
 */
import http from 'node:http';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { builtinAgentToolIds, PROJECTABLE_COMPUTE_NODE_TYPE_IDS } from '../src/host/agentToolProvider.js';

const here = dirname(fileURLToPath(import.meta.url));
const PACKS_DIR = join(here, '../../..', 'packs');

/** agentId → entries excused from conversational resolution, each with a
 *  documented reason. EMPTY by design — see the header before adding one. */
const RUN_ONLY_EXEMPTIONS: Record<string, { entries: string[]; reason: string }> = {};

interface AgentManifestLite {
  agentId?: string;
  id?: string;
  toolAllowlist?: string[];
}

interface ManifestLite {
  agents?: AgentManifestLite[];
  nodes?: Array<{ typeId?: string; role?: string }>;
}

/** Every pack manifest under packs/, plus the dirs whose pack.json did not
 *  parse — those are a FAILURE, never a skip (a skipped manifest is unchecked). */
function readManifests(): { manifests: Array<{ pack: string; manifest: ManifestLite }>; unparsable: string[] } {
  const manifests: Array<{ pack: string; manifest: ManifestLite }> = [];
  const unparsable: string[] = [];
  for (const dir of readdirSync(PACKS_DIR)) {
    const manifestPath = join(PACKS_DIR, dir, 'pack.json');
    if (!existsSync(manifestPath)) continue;
    try {
      manifests.push({ pack: dir, manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) as ManifestLite });
    } catch (err) {
      unparsable.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { manifests, unparsable };
}

function agentPacks(): Array<{ pack: string; agents: AgentManifestLite[] }> {
  return readManifests().manifests
    .filter(({ manifest }) => (manifest.agents?.length ?? 0) > 0)
    .map(({ pack, manifest }) => ({ pack, agents: manifest.agents! }));
}

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => {
      void (server.address() as AddressInfo);
      res();
    });
  });
}, 120_000);
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

describe('agent-pack toolAllowlist entries resolve to real conversational tools (CFP-1)', () => {
  it('every allowlisted id is offerable by the live tool provider (or documented run-only)', () => {
    expect(readManifests().unparsable, 'pack.json files that do not parse are unchecked').toEqual([]);
    const universe = new Set(builtinAgentToolIds());
    const failures: string[] = [];
    let agentCount = 0;
    let entryCount = 0;
    for (const { pack, agents } of agentPacks()) {
      for (const agent of agents) {
        agentCount++;
        entryCount += agent.toolAllowlist?.length ?? 0;
        const agentId = agent.agentId ?? agent.id ?? '<unnamed>';
        const exempt = new Set(RUN_ONLY_EXEMPTIONS[agentId]?.entries ?? []);
        for (const entry of agent.toolAllowlist ?? []) {
          if (universe.has(entry) || exempt.has(entry)) continue;
          failures.push(`${pack} :: ${agentId} :: ${entry}`);
        }
      }
    }
    expect(
      failures,
      `toolAllowlist entries that resolve to NOTHING at dispatch (silently dropped — the agent is toothless):\n${failures.join('\n')}`,
    ).toEqual([]);
    // Non-vacuity: the scan really read the agent corpus (measured 112 / 309).
    expect(agentCount).toBeGreaterThanOrEqual(102); // 103 after the KickTodo agent pack left (ADR 1031 P3)
    expect(entryCount).toBeGreaterThanOrEqual(294); // 295 after the KickTodo agent pack left (ADR 1031 P3)
  });

  it('exemptions stay honest: every exempted entry still exists as a declared node', () => {
    // A run-only exemption must at least point at a REAL declared node typeId —
    // otherwise it is a phantom in both lanes and belongs deleted, not exempted.
    const { manifests, unparsable } = readManifests();
    expect(unparsable).toEqual([]);
    const declared = new Set<string>();
    for (const { manifest } of manifests) {
      for (const n of manifest.nodes ?? []) if (n.typeId) declared.add(`openwop:${n.typeId}`);
    }
    // The case asserts even while RUN_ONLY_EXEMPTIONS is empty (measured 812).
    expect(declared.size).toBeGreaterThanOrEqual(759); // 760 after the KickTodo node pack left (ADR 1031 P3)
    for (const [agentId, { entries }] of Object.entries(RUN_ONLY_EXEMPTIONS)) {
      for (const entry of entries) {
        expect(declared.has(entry), `${agentId} exemption ${entry} is not a declared node typeId`).toBe(true);
      }
    }
  });
});

/**
 * CFPT-7 purity pin — the node-as-tool projection lane (ADR 0081 P3;
 * `PROJECTABLE_COMPUTE_NODE_TYPE_IDS` in `agentToolProvider.ts`) synthesizes a
 * MINIMAL ctx (no storage, no acting-human Connection, no `connections:use`) and
 * runs the node's `execute` directly. That is only safe for PURE compute nodes —
 * a connector-backed or surface-reading node projected here would either fork the
 * egress path or read app state through an un-authorized ctx. The projection list
 * is a hand-maintained allowlist, so this test pins the invariant the list rests
 * on: EVERY projected typeId must resolve to a pack-manifest node declared
 * `role:"pure"`. A future edit that projects a non-pure node (or whose pack later
 * re-roles a projected node) turns this red BEFORE it ships a leak.
 */
describe('projected compute nodes are role:"pure" in their pack manifests (CFPT-7)', () => {
  it('every PROJECTABLE_COMPUTE_NODE_TYPE_IDS entry is a declared node with role "pure"', () => {
    const { manifests, unparsable } = readManifests();
    expect(unparsable).toEqual([]);
    const roleOf = new Map<string, string | undefined>();
    for (const { manifest } of manifests) {
      for (const n of manifest.nodes ?? []) if (n.typeId) roleOf.set(n.typeId, n.role);
    }
    expect(PROJECTABLE_COMPUTE_NODE_TYPE_IDS.length).toBeGreaterThan(0);
    const failures: string[] = [];
    for (const typeId of PROJECTABLE_COMPUTE_NODE_TYPE_IDS) {
      if (!roleOf.has(typeId)) { failures.push(`${typeId} — not a declared node in any pack manifest`); continue; }
      const role = roleOf.get(typeId);
      if (role !== 'pure') failures.push(`${typeId} — role is ${role ?? '<unset>'}, must be "pure"`);
    }
    expect(
      failures,
      `projected compute nodes that are NOT declared role:"pure" (projecting them synthesizes an un-brokered ctx — a leak):\n${failures.join('\n')}`,
    ).toEqual([]);
  });
});
