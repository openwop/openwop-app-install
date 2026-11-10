/**
 * ADR 0773 OQ4 / ADR 0582 — the approval-gate set is the static host list UNION
 * every loaded pack manifest's `role:"gate"` node, and it can only ADD gates.
 *
 * Why it exists. `host/approvalGateTypeIds.ts` was a hard-coded list. A gate node
 * that a pack declares (`role:"gate"`), whether it comes from an adopter, a registry
 * install or a first-party pack the list never named, was a FALSE NEGATIVE.
 *   - Builder Pair (`features/builder-pair/editOps.ts`) marked an AI edit of it
 *     `gateSensitive: false`, so the edit could be auto-kept. ADR 0582 forbids
 *     exactly that: an effect must not quietly route around an approval.
 *   - The MCP campaign lane (`host/campaignRunGuard.ts` `isApprovalGate`) let an
 *     external agent resolve it.
 * Measured on `9a05b6cb8`: seven first-party pack gates were missed, among them
 * `brand.theme.review` and `core.chat.clarificationGate`.
 *
 * Every case goes through the two real consumers, never through a helper, so the
 * file also runs on the base and witnesses the hole there.
 *
 * Red when:
 *   - the manifest union is dropped (cases 1–3);
 *   - a manifest role can override a static entry (case 4: add-only);
 *   - a `@version` suffix defeats the lookup (case 1);
 *   - a repo pack ships a gate the union does not see (case 5, census);
 *   - the static list grows for a node that has a manifest (case 5, no-growth).
 *
 * No RFC needed. `role` is an existing pack-manifest field that the host already
 * reads (`nodeRoleMap`, ADR 0473). Which nodes count as gates is a host-internal
 * policy input for two host-local decisions: Builder Pair auto-keep, and the MCP
 * campaign lane. It adds no run event, endpoint, capability advert or schema
 * field, and classifying MORE nodes as gates only makes both consumers stricter.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeEditOps } from '../src/features/builder-pair/editOps.js';
import { isApprovalGate } from '../src/host/campaignRunGuard.js';
import { APPROVAL_GATE_TYPE_IDS } from '../src/host/approvalGateTypeIds.js';
import { __setNodeRolesForTests } from '../src/host/nodeCatalogBuilder.js';
import type { WorkflowDefinition } from '../src/executor/types.js';
import type { RunRecord } from '../src/types.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ADOPTER_GATE = 'vendor.acme-adopter.nodes.sign-off';
const ADOPTER_PURE = 'vendor.acme-adopter.nodes.score';

let packDir = '';
const savedPackDir = process.env.OPENWOP_PACK_DIR;

function writePack(name: string, nodes: Array<{ typeId: string; role?: string }>): void {
  mkdirSync(join(packDir, name), { recursive: true });
  writeFileSync(join(packDir, name, 'pack.json'), JSON.stringify({ name, version: '1.0.0', kind: 'node', nodes }));
  __setNodeRolesForTests(null); // drop the 60 s role cache so the new manifest is read
}

function head(gateTypeId: string): WorkflowDefinition {
  return {
    workflowId: 'wf.gate-union',
    nodes: [
      { nodeId: 'draft', typeId: 'core.noop' },
      { nodeId: 'gate', typeId: gateTypeId },
      { nodeId: 'send', typeId: 'core.noop' },
    ],
    edges: [
      { edgeId: 'e1', sourceNodeId: 'draft', targetNodeId: 'gate' },
      { edgeId: 'e2', sourceNodeId: 'gate', targetNodeId: 'send' },
    ],
  };
}

/** gateSensitive for each op, as Builder Pair computes it for the AI's edit. */
function sensitivity(def: WorkflowDefinition, rawOps: unknown[]): boolean[] {
  const r = normalizeEditOps({
    suggestionId: 'sg-gate-union',
    head: def,
    rawOps,
    validate: () => ({ ok: true, errors: [] }),
    isKnownTypeId: () => true,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.ops.map((o) => o.gateSensitive);
}

async function mcpSeesGate(typeId: string): Promise<boolean> {
  const def = head(typeId);
  const at = '2026-11-05T00:00:00.000Z';
  const run: RunRecord = {
    runId: 'run-gate-union', workflowId: def.workflowId, tenantId: 't-gate-union', status: 'waiting-input',
    inputs: {}, metadata: {}, configurable: {}, createdAt: at, updatedAt: at,
  };
  return isApprovalGate(
    { getRun: async () => run },
    { workflowCatalog: { getWorkflow: async () => ({ workflowId: def.workflowId, definition: def }) } },
    // A real non-approval kind, so only the node's typeId decides (line 75 path).
    { kind: 'clarification', runId: run.runId, nodeId: 'gate' },
  );
}

beforeAll(() => {
  packDir = mkdtempSync(join(tmpdir(), 'gate-union-'));
  process.env.OPENWOP_PACK_DIR = packDir;
  __setNodeRolesForTests(null);
});

afterEach(() => {
  for (const e of readdirSync(packDir)) rmSync(join(packDir, e), { recursive: true, force: true });
  __setNodeRolesForTests(null);
});

afterAll(() => {
  if (savedPackDir === undefined) delete process.env.OPENWOP_PACK_DIR;
  else process.env.OPENWOP_PACK_DIR = savedPackDir;
  rmSync(packDir, { recursive: true, force: true });
  __setNodeRolesForTests(null);
});

describe('ADR 0773 OQ4 — a pack-declared gate is a gate', () => {
  it('1. an adopter pack gate: every Builder Pair op that touches it is gateSensitive', () => {
    writePack('vendor.acme-adopter.nodes', [{ typeId: ADOPTER_GATE, role: 'gate' }, { typeId: ADOPTER_PURE, role: 'pure' }]);
    expect(sensitivity(head(ADOPTER_GATE), [
      { kind: 'setConfig', nodeId: 'gate', path: 'approvers', value: [] },
      { kind: 'removeNode', nodeId: 'draft' }, // its only edge runs into the gate
      { kind: 'addNode', ref: 'g2', typeId: `${ADOPTER_GATE}@1.0.0` }, // a pinned version is still the gate
    ])).toEqual([true, true, true]);
  });

  it('2. a first-party pack gate the static list never named (real manifest: vendor.myndhyve.brand)', () => {
    const src = join(REPO, 'packs', 'vendor.myndhyve.brand');
    mkdirSync(join(packDir, 'vendor.myndhyve.brand'), { recursive: true });
    cpSync(join(src, 'pack.json'), join(packDir, 'vendor.myndhyve.brand', 'pack.json'));
    __setNodeRolesForTests(null);
    expect(APPROVAL_GATE_TYPE_IDS.has('brand.theme.review'), 'precondition: the static list does not name it').toBe(false);
    expect(sensitivity(head('brand.theme.review'), [{ kind: 'setConfig', nodeId: 'gate', path: 'reviewers', value: [] }])).toEqual([true]);
  });

  it('3. the MCP campaign lane treats a pack gate as a gate, whatever kind it suspended with', async () => {
    writePack('vendor.acme-adopter.nodes', [{ typeId: ADOPTER_GATE, role: 'gate' }, { typeId: ADOPTER_PURE, role: 'pure' }]);
    expect(await mcpSeesGate(ADOPTER_GATE)).toBe(true);
    expect(await mcpSeesGate(`${ADOPTER_GATE}@2.1.0`)).toBe(true);
    // Non-vacuity: the union is not "everything is a gate".
    expect(await mcpSeesGate(ADOPTER_PURE)).toBe(false);
    expect(sensitivity(head(ADOPTER_PURE), [{ kind: 'setConfig', nodeId: 'gate', path: 'x', value: 1 }])).toEqual([false]);
  });
});

describe('ADR 0582 — the union only ADDS gates', () => {
  it('4. a manifest cannot demote a host gate: core.approvalGate declared role:"pure" stays a gate', async () => {
    writePack('vendor.acme-adopter.nodes', [
      { typeId: 'core.approvalGate', role: 'pure' },
      { typeId: 'feature.campaign-orchestration.nodes.autonomy-gate', role: 'side-effect' },
    ]);
    expect(sensitivity(head('core.approvalGate'), [{ kind: 'setConfig', nodeId: 'gate', path: 'approvers', value: [] }])).toEqual([true]);
    expect(await mcpSeesGate('feature.campaign-orchestration.nodes.autonomy-gate')).toBe(true);
  });
});

describe('census — every gate a repo pack ships is seen, and the static list does not grow for pack nodes', () => {
  const PACK_ROOTS = [join(REPO, 'packs')]; // examples/ ships chain and connection packs only
  const manifests: Array<{ dir: string; name: string; nodes: Array<{ typeId: string; role?: string }> }> = [];
  for (const root of PACK_ROOTS) {
    for (const d of readdirSync(root)) {
      const p = join(root, d, 'pack.json');
      if (!existsSync(p)) continue;
      try {
        const m = JSON.parse(readFileSync(p, 'utf8')) as { name?: string; nodes?: Array<{ typeId: string; role?: string }> };
        if (Array.isArray(m.nodes)) manifests.push({ dir: join(root, d), name: d, nodes: m.nodes });
      } catch { /* not a node pack */ }
    }
  }
  const packGates = manifests.flatMap((m) => m.nodes.filter((n) => n.role === 'gate').map((n) => n.typeId));

  it('5a. non-vacuity: the repo ships pack-declared gates, including ones the static list never named', () => {
    expect(packGates.length).toBeGreaterThanOrEqual(10);
    expect(packGates.filter((t) => !APPROVAL_GATE_TYPE_IDS.has(t)).length).toBeGreaterThanOrEqual(7);
  });

  it('5b. with the repo packs loaded, each of them is gateSensitive in Builder Pair', () => {
    for (const m of manifests) {
      mkdirSync(join(packDir, m.name), { recursive: true });
      cpSync(join(m.dir, 'pack.json'), join(packDir, m.name, 'pack.json'));
    }
    __setNodeRolesForTests(null);
    const missed = packGates.filter((t) => !sensitivity(head(t), [{ kind: 'setConfig', nodeId: 'gate', path: 'x', value: 1 }])[0]);
    expect(missed, 'a pack gate Builder Pair would auto-keep an edit of').toEqual([]);
  });

  it('5c. NO-GROWTH: the static list holds host gates plus the nine it held before the union; new pack gates come from manifests', () => {
    // A pack node's manifest `role:"gate"` is now enough. Adding a pack node here
    // instead hides it from every adopter's review of its own manifest.
    expect(APPROVAL_GATE_TYPE_IDS.size).toBeLessThanOrEqual(9);
  });
});
