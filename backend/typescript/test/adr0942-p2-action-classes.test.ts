/**
 * ADR 0942 D6 / D10.1 — the action-class ratchet over every Campaign Studio chain,
 * loaded through the REAL chain loader (`loadWorkflowChainPacks`), not a synthetic
 * registry.
 *
 *  1. Every node whose manifest role is `side-effect`/`action`, or that has no pack
 *     manifest and is not an approval gate, has a `NODE_ACTION_CLASSES` entry.
 *  2. No campaign chain contains a `refused` node (egress outside a chokepoint, G5).
 *  3. No `autonomy-gate` carries approver fields in its config (approvers come from
 *     the policy only, D10.1), and every one names a known action class.
 *  4. Until P3 builds the PendingApproval lane, no campaign chain gates a class
 *     decided on that lane (it would fail at run time with `autonomy_lane_unavailable`).
 *
 * Sabotage notes (each run, 2026-10-20):
 *  - delete the `feature.campaign-ops.nodes.execute` entry → red (leg 1);
 *  - map `core.openwop.integration.email-send` to `refused` → red (leg 2);
 *  - add `approverRoleRefs` to the orchestration chain's kernel-approve config → red (leg 3).
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { _resetChainRegistryForTest, listChains, loadWorkflowChainPacks } from '../src/host/workflowChainPackLoader.js';
import { APPROVAL_GATE_TYPE_IDS } from '../src/host/approvalGateTypeIds.js';
import { ACTION_CLASSES, NODE_ACTION_CLASSES, PENDING_APPROVAL_LANE_CLASSES, actionClassOf, type ActionClass } from '../src/host/autonomyPolicy/index.js';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const CAMPAIGN_PACK_PREFIX = 'core.openwop.workflows.campaign-';
const GATE = 'feature.campaign-orchestration.nodes.autonomy-gate';

/** typeId → manifest role, from every pack manifest the repo ships. */
function manifestRoles(): Map<string, string | undefined> {
  const roles = new Map<string, string | undefined>();
  for (const root of [join(REPO, 'packs'), join(REPO, 'examples', 'node-packs')]) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root)) {
      const pj = join(root, dir, 'pack.json');
      if (!existsSync(pj)) continue;
      let m: { nodes?: Array<{ typeId?: string; role?: string }> };
      try { m = JSON.parse(readFileSync(pj, 'utf8')) as typeof m; } catch { continue; }
      for (const n of m.nodes ?? []) if (n.typeId) roles.set(n.typeId, n.role);
    }
  }
  return roles;
}

const bare = (typeId: string): string => typeId.replace(/@.*$/, '');
let campaignNodes: Array<{ chainId: string; nodeId: string; typeId: string; config: Record<string, unknown> }>;

beforeAll(() => {
  _resetChainRegistryForTest();
  const out = loadWorkflowChainPacks({ roots: [join(REPO, 'examples', 'workflow-chain-packs')] });
  const campaignErrors = out.errors.filter((e) => e.pack.includes('campaign'));
  expect(campaignErrors, JSON.stringify(campaignErrors)).toEqual([]);
  campaignNodes = listChains()
    .filter((c) => c.packName.startsWith(CAMPAIGN_PACK_PREFIX))
    .flatMap((c) => c.chain.dag.nodes.map((n) => ({ chainId: c.chain.chainId, nodeId: n.id, typeId: bare(n.typeId), config: (n.config ?? {}) as Record<string, unknown> })));
});

describe('ADR 0942 D6 — the action-class table covers every campaign chain node', () => {
  it('non-vacuity: the loader found the campaign chains, including the orchestration gate', () => {
    expect(new Set(campaignNodes.map((n) => n.chainId)).size).toBeGreaterThanOrEqual(10);
    expect(campaignNodes.some((n) => n.typeId === GATE)).toBe(true);
  });

  it('every side-effect / action / unmanifested non-gate node has an entry', () => {
    const roles = manifestRoles();
    const missing = campaignNodes.filter((n) => {
      if (APPROVAL_GATE_TYPE_IDS.has(n.typeId)) return false;
      const role = roles.get(n.typeId);
      const needs = roles.has(n.typeId) ? role === 'side-effect' || role === 'action' : true;
      return needs && !actionClassOf(n.typeId);
    }).map((n) => `${n.chainId}/${n.nodeId}: ${n.typeId}`);
    expect(missing, 'add each to host/autonomyPolicy/actionClasses.ts with its class and why').toEqual([]);
  });

  it('every entry names a real class, none or refused, with a reason', () => {
    for (const [typeId, e] of Object.entries(NODE_ACTION_CLASSES)) {
      expect(e.class === 'none' || e.class === 'refused' || (ACTION_CLASSES as readonly string[]).includes(e.class), typeId).toBe(true);
      expect(e.why.length, typeId).toBeGreaterThan(10);
    }
  });

  it('no campaign chain contains a refused node', () => {
    const refused = campaignNodes.filter((n) => actionClassOf(n.typeId)?.class === 'refused').map((n) => `${n.chainId}/${n.nodeId}`);
    expect(refused).toEqual([]);
  });
});

describe('ADR 0942 D10.1 — autonomy gates in campaign chains', () => {
  it('no gate sets approvers in config, and each names a known interrupt-lane class', () => {
    const gates = campaignNodes.filter((n) => n.typeId === GATE);
    for (const g of gates) {
      const forged = ['approverRefs', 'approverRoleRefs', 'approverGroupRefs', 'approversList', 'requiredApprovals', 'rejectionPolicy', 'overrideScopes'].filter((k) => k in g.config);
      expect(forged, `${g.chainId}/${g.nodeId}`).toEqual([]);
      expect((ACTION_CLASSES as readonly unknown[]).includes(g.config.actionClass), `${g.chainId}/${g.nodeId} actionClass`).toBe(true);
      expect(PENDING_APPROVAL_LANE_CLASSES.has(g.config.actionClass as ActionClass), `${g.chainId}/${g.nodeId}: lane not built until P3`).toBe(false);
    }
  });
});
