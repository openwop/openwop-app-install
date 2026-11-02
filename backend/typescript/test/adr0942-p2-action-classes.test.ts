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
 * Leg 2 has an in-file negative control (every `refused` entry, planted, is
 * found), and leg 3 asserts it saw the gates it checks (2 at w73).
 *
 * Denominators MEASURED at w73 (2026-11-01): 10 campaign chain packs carrying
 * 31 chains (the floor below asserts >= 10) and 2 autonomy gates
 * (campaign-orchestration, campaign-ops-reporting). The chain floor is slack by
 * 21; raising it is a ratchet decision for its owner (floor-slack human-ask row
 * TST-DPU-H1), so it is left as is.
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
const CLASS_NAMES: ReadonlySet<string> = new Set<string>(ACTION_CLASSES);

/** typeId → manifest role, from every pack manifest the repo ships. */
function manifestRoles(): Map<string, string | undefined> {
  const roles = new Map<string, string | undefined>();
  for (const root of [join(REPO, 'packs'), join(REPO, 'examples', 'node-packs')]) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root)) {
      const pj = join(root, dir, 'pack.json');
      if (!existsSync(pj)) continue;
      let m: unknown;
      try { m = JSON.parse(readFileSync(pj, 'utf8')); } catch { continue; }
      const nodes = typeof m === 'object' && m !== null && 'nodes' in m && Array.isArray(m.nodes) ? m.nodes : [];
      for (const n of nodes) {
        if (typeof n !== 'object' || n === null || !('typeId' in n) || typeof n.typeId !== 'string' || !n.typeId) continue;
        roles.set(n.typeId, 'role' in n && typeof n.role === 'string' ? n.role : undefined);
      }
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
    .flatMap((c) => c.chain.dag.nodes.map((n) => ({ chainId: c.chain.chainId, nodeId: n.id, typeId: bare(n.typeId), config: n.config ?? {} })));
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
      expect(e.class === 'none' || e.class === 'refused' || CLASS_NAMES.has(e.class), typeId).toBe(true);
      expect(e.why.length, typeId).toBeGreaterThan(10);
    }
  });

  it('no campaign chain contains a refused node', () => {
    const refusedIn = (nodes: ReadonlyArray<{ chainId: string; nodeId: string; typeId: string }>): string[] =>
      nodes.filter((n) => actionClassOf(n.typeId)?.class === 'refused').map((n) => `${n.chainId}/${n.nodeId}`);
    // Negative control: every refused entry in the table, planted into a chain, is found.
    const refusedTypeIds = Object.entries(NODE_ACTION_CLASSES).filter(([, e]) => e.class === 'refused').map(([typeId]) => typeId);
    expect(refusedTypeIds.length, 'the table has refused entries to plant').toBeGreaterThan(0);
    const planted = refusedTypeIds.map((typeId, i) => ({ chainId: 'planted', nodeId: `n${i}`, typeId }));
    expect(refusedIn(planted)).toEqual(planted.map((n) => `planted/${n.nodeId}`));
    expect(refusedIn(campaignNodes)).toEqual([]);
  });
});

describe('ADR 0942 D10.1 — autonomy gates in campaign chains', () => {
  it('no gate sets approvers in config, and each names a known interrupt-lane class', () => {
    const gates = campaignNodes.filter((n) => n.typeId === GATE);
    // Non-vacuity: the loop below checks real gates (2 measured at w73), never an empty list.
    expect(gates.length).toBeGreaterThanOrEqual(2);
    const isActionClass = (v: unknown): v is ActionClass => typeof v === 'string' && ACTION_CLASSES.some((c) => c === v);
    for (const g of gates) {
      const forged = ['approverRefs', 'approverRoleRefs', 'approverGroupRefs', 'approversList', 'requiredApprovals', 'rejectionPolicy', 'overrideScopes'].filter((k) => k in g.config);
      expect(forged, `${g.chainId}/${g.nodeId}`).toEqual([]);
      const cls = g.config.actionClass;
      expect(isActionClass(cls), `${g.chainId}/${g.nodeId} actionClass`).toBe(true);
      expect(isActionClass(cls) && PENDING_APPROVAL_LANE_CLASSES.has(cls), `${g.chainId}/${g.nodeId}: lane not built until P3`).toBe(false);
    }
  });
});
