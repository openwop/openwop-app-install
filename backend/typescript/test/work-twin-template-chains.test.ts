/**
 * ADR 0775 P2 (`ARWF-1`) — the Work-Twin `tmpl.*` templates moved, batch by
 * batch (P2a, P2b, …), from the in-tree `host/workflowTemplates.ts` catalog to
 * the `vendor.openwop-app.workflows.work-twin-templates` chain pack. They stay
 * `internal` as replay archives (the user's decision of 2026-10-10).
 *
 * "It still boots" proves almost nothing about a migration like this:
 * `expandChain` produces a different object (prefixed node ids, metadata, a
 * configurable schema). What a pre-migration run needs is the SAME definition:
 * its `definitionRevision` pin is `revisionHashOf(<in-tree def>)` and its
 * checkpoints are keyed by bare node id. So each case below pins one measured
 * property:
 *
 *  - the GOLDEN hashes were computed from the in-tree definitions at
 *    `51f5a323f`, BEFORE they were deleted. Byte identity is the replay claim;
 *  - a run stamped with the old pin resolves `resolvedFrom: 'revision'`;
 *  - composition still binds the same child id (RFC 0133 `subChainRef`);
 *  - every chain is `internal` (RFC 0135). That keeps them out of the gallery
 *    AND out of the zero-config tenant seed (`seedWorkflows.ts`), which is the
 *    ADR 0190 posture, and the user decided 2026-10-10 that it stays (replay archives);
 *  - every node reference is exactly pinned (ADR 0766);
 *  - the real executor runs a draft template to completion and a gated one to
 *    its gate under the BARE node id.
 *
 * Sabotage-witnessed (grade-tests wave 64): a changed node typeId breaks the
 * golden hash (8fw5g5-wttc-hash); `internal:false` on one chain; resolving the
 * head instead of the pinned revision; dropping the boot `recordRevision`; and a
 * wrong sub-chain bind each red their case.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/index.js';
import { getChainBackedWorkflow, validateChainBackedSubChainBinds } from '../src/host/chainBackedWorkflows.js';
import { getChain } from '../src/host/workflowChainPackLoader.js';
import { WORKFLOW_TEMPLATE_CHAIN_IDS } from '../src/host/workflowTemplates.js';
import { revisionHashOf } from '../src/host/definitionHash.js';
import { resolveRunDefinition } from '../src/host/resolveRunDefinition.js';
import { getRevision } from '../src/host/workflowRevisions.js';
import { openStorage } from '../src/storage/index.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { setSuspendBackend } from '../src/executor/suspendManager.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { executeRun } from '../src/executor/executor.js';
import type { RunRecord } from '../src/types.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const PACK = join(REPO, 'examples/workflow-chain-packs/work-twin-templates/pack.json');

/** revisionHashOf(<in-tree definition>), measured before each batch deleted it (P2a at 51f5a323f). */
const GOLDEN: Record<string, string> = {
  'tmpl.meeting-ops.meeting-brief': '484d198ada56d23159b02cb2c0b3df7f71b44d8b74d8f396b81c7b33dc308615',
  'tmpl.meeting-ops.attendee-dossier': '1f5f91666cd425b6d710cb3d5131f76d1182b5d2bfb153f75ff8705ca6dd4b8c',
  'tmpl.meeting-ops.action-extraction': '666f6eb3efa87559e9391fc105ebf98ecda023cf57d829b51bc7470a934f6a10',
  'tmpl.meeting-ops.post-meeting-follow-up': 'f95eb2e6d1af67ca064e61bb3f1b88fb91f41f77f4081a6060456d72d2ec5020',
  'tmpl.reporting.daily-summary': '1fb440ff1542d9a561a39e1c8f8694696e1b0ef4c9a372dcaa42944abf8f3b02',
  'tmpl.reporting.weekly-business-review': '188238b6fb9203fb7f6e584c7429ca0d3b4084a68d7b990473891ebdbde08dab',
  'tmpl.reporting.monthly-scorecard': '175453cdcb15e189969c1a0cf01e57b756cfa26d119157588b07866134919ccf',
  'tmpl.reporting.quarterly-retrospective': 'f84a22e6d051d3309b161652e603142640c7c4375f5bf01d491ab322716447fc',
  'tmpl.intake-triage.request-classification': 'e7e1af36162349b268a067c111d606426d5c1d73484c5b5b2f63a669e405ac51',
  'tmpl.intake-triage.priority-routing': 'f636cbef6647e9d529c46fc7e69af55a3bb474772810de7941c0428d39eff44f',
  'tmpl.intake-triage.required-field-completion': 'eee6692260dc23a288b8f3d76589639faa9a488d551339252b17b701f268be81',
  'tmpl.intake-triage.escalation-routing': '209b3adc221a4c72a821a05b07e70425b7672356c1ba057ffabf0c9225237a6d',
  'tmpl.scheduling.availability-match': '3b0103ac2c4a353470e27c48c08f4101bb80c15d41be70209a106ef70c1c4368',
  'tmpl.scheduling.hold-creation': 'f44978b0115d793d4100b6dea162aec0621827ec53e89200c95ba60faf43b11a',
  'tmpl.scheduling.prep-reminders': 'c6ff64fe37a233c29291233baa5ff6d78738bde137780548157fb64c3146d084',
  'tmpl.scheduling.no-response-chase': '0a5d5b71f91a3ed78b39c4dc165de6c90cb0451d73040a299625a360a1fede8b',
  // P2b — measured at 0b45e04ec, before deletion.
  'tmpl.approvals.single-approver': 'd5d84036f28cea1f46a8c50f9d76c9cb8561019fec3ed8d23661fcc737447ee1',
  'tmpl.approvals.dual-approver': '10ad4a9d3c0323c4cd3685caedbb076164c536b30c26f98e03bb30b408488dde',
  'tmpl.approvals.manager-plus-compliance': '72b4e1a42a2c772bfe1b1beec027accc7991ed21c12b3049a8f42e5d798e87bf',
  'tmpl.approvals.threshold-based': '13d83829ea99776998e87b52e9b7cc70e83497f7f206d90089bfa71740e25e55',
  'tmpl.knowledge.source-pack-assembly': 'f468469b1c960137c0b71b90347f86a2cafa39209be96248677d67f759dff7e6',
  'tmpl.knowledge.comparison-summary': 'd02e2090cb40ab3721d31b2dfbbec9666d17fa78ec2e83fc97bd79311792b41d',
  'tmpl.knowledge.faq-update': '55523d9d4b947070c3fc61bcd7a9c7c70e49ffba40c728f731057154108c594b',
  'tmpl.knowledge.policy-summarization': '0204ada69f8d03847d68e15fb32eba29b9f900c2aed0cd0a1926fce4a65e75d3',
  'tmpl.people.onboarding-checklist': '50fabadeaa7c8b43c39cf84bfbf882a794508b0d3538a4808af7a1903bdbf9ce',
  'tmpl.people.offboarding-checklist': '1509f87f717a08feb26c6e5ac899b8a5183aef1d957b78293b9a0e19bdf42840',
  'tmpl.people.manager-nudge': '235a4811fe15d0fb3454a1096c26a2ab69a030683e06b30c632fd3f1a9eac08c',
  'tmpl.people.leave-request-routing': 'cd69c94134fad943b8508051f2af4c9d60c2a749371b73097fbe378993971b2a',
  'tmpl.finance.close-checklist': '77227f8fcdddd3bfdce47c1329d0bcaaad5024b4fc9a9ffac0fee86e4daa554f',
  'tmpl.finance.support-collection': '97404827ddc531d6b9a6b5fd91e6550ae9c90b10abdd81802a695dbbb684c265',
  'tmpl.finance.variance-note-draft': '65c7e56705556cd50589445c3b916cbf5452d808ef502bea7c74ae92c3dac389',
  'tmpl.finance.approval-chase': '43c1f4e4fcc7654b84b44e151db329dede54a9b37c1c1a70571b823cba15c111',
  // P2c — measured at 452795789, before deletion.
  'tmpl.commercial.account-brief': 'ff3c7c877f370742757b23775afca2944b89e0064a7cfeb488e29a5dad640456',
  'tmpl.commercial.next-step-draft': '385d59fca420ce2401983c715a837b81a99c843c22c8d1e91496a29bc751d793',
  'tmpl.commercial.renewal-pack': 'd6260fcbd7f513dc97123c4eba0e4d36ede74e3c5fabb639cb44b393a306b853',
  'tmpl.commercial.risk-digest': '7d02532bb4d28ff6abd37f014c89126f38ebee56ef3d16b9696f039d5ed17d38',
  'tmpl.it.incident-triage': '02acd41f0dd7b7ca2374e2ba9ceda801c8b31ea4f7fb4584fd4033975a96be9f',
  'tmpl.it.kb-recommendation': '25e0b8c1c242ed0ba8ca5d8e995fb75b1a4481d64240a137210a69beda74e653',
  'tmpl.it.standard-request-routing': '5dae1e101b646d8656936019f9a7612f70709614f9e92f40fb51e37b099a3561',
  'tmpl.it.major-incident-update': '8a687f02dbab4bb8e4a35b314d710e0812ff75dd3c51d5389e0955a2a732cb23',
  'tmpl.comms.announcement-draft': '4d4859db4840975a5d8564970f23d5b872fc18d1e1e24b4f5922892c05eb122a',
  'tmpl.comms.audience-adaptation': '28b2e6ed302730d9d05766de05b5c13bfa2f598e4c4d980a9c0f1de92bfc6001',
  'tmpl.comms.faq-draft': 'c9b7e911736e6a61c346e2a4e515b1c3fb2f6184610424791323ee9d5222b64b',
  'tmpl.comms.all-hands-prep': '25039e9a2ca85bb21f2cf9b88d8ca6de287fad98e07d558e99d39ad1d14d9507',
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 18961, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});

const defOf = (id: string): WorkflowDefinition => {
  const def = getChainBackedWorkflow(id);
  if (!def) throw new Error(`${id} is not registered chain-backed`);
  return def;
};

describe('ADR 0775 P2a — the migrated templates resolve, same id, byte-identical', () => {
  it('the batch list and the golden table name the same ids', () => {
    expect([...WORKFLOW_TEMPLATE_CHAIN_IDS].sort()).toEqual(Object.keys(GOLDEN).sort());
  });

  it('every id is registered chain-backed by the real boot (the in-tree catalog is deleted)', () => {
    expect(WORKFLOW_TEMPLATE_CHAIN_IDS).toHaveLength(44);
    for (const id of WORKFLOW_TEMPLATE_CHAIN_IDS) expect(getChainBackedWorkflow(id), id).toBeDefined();
  });

  it('every expansion hashes to the pre-migration definition (the replay claim)', () => {
    for (const id of WORKFLOW_TEMPLATE_CHAIN_IDS) {
      const def = defOf(id);
      expect(def.workflowId).toBe(id);
      expect(revisionHashOf(def), id).toBe(GOLDEN[id]);
      // the readable half of the same claim
      for (const n of def.nodes) expect(n.nodeId, id).not.toContain('_');
      expect(def.metadata, id).toBeUndefined();
    }
  });

  it('a run stamped before the migration resolves its pinned revision, not just the head', async () => {
    const id = 'tmpl.intake-triage.escalation-routing';
    // recordRevision is fire-and-forget at registration; wait for the row, and
    // FAIL (naming it) if it never lands rather than proceeding to read the head.
    await vi.waitFor(async () => {
      expect(await getRevision(id, GOLDEN[id]!), `revision ${id}@${GOLDEN[id]} never recorded`).not.toBeNull();
    }, { timeout: 2000, interval: 20 });
    const at = '2026-10-01T00:00:00.000Z';
    const run: RunRecord = {
      runId: 'run-pre-p2a', workflowId: id, tenantId: 'demo', status: 'completed', inputs: {},
      metadata: { definitionRevision: GOLDEN[id] }, configurable: {}, createdAt: at, updatedAt: at,
    };
    const catalog = { getWorkflow: async (wid: string) => { const d = getChainBackedWorkflow(wid); return d ? { workflowId: wid, definition: d } : null; } };
    const resolved = await resolveRunDefinition(run, catalog);
    expect(resolved?.resolvedFrom).toBe('revision');
    expect(revisionHashOf(resolved!.definition)).toBe(GOLDEN[id]);
  });

  it('composition binds the same child id, and the child is registered (no dangling bind)', () => {
    const parent = defOf('tmpl.meeting-ops.post-meeting-follow-up');
    const extract = parent.nodes.find((n) => n.nodeId === 'extract');
    expect(extract?.typeId).toBe('core.subWorkflow');
    expect((extract?.config as { workflowId?: unknown }).workflowId).toBe('tmpl.meeting-ops.action-extraction');
    expect((extract?.config as { subChainRef?: unknown }).subChainRef).toBeUndefined();
    const chase = defOf('tmpl.finance.approval-chase').nodes.find((n) => n.nodeId === 'request-approval');
    expect((chase?.config as { workflowId?: unknown }).workflowId).toBe('tmpl.approvals.single-approver');
    expect(validateChainBackedSubChainBinds().filter((d) => d.parentId.startsWith('tmpl.'))).toEqual([]);
  });
});

describe('ADR 0775 P2a — the pack', () => {
  const pack = JSON.parse(readFileSync(PACK, 'utf8')) as {
    name: string; kind: string; chains: Array<{ chainId: string; internal?: boolean; dag: { nodes: Array<{ typeId: string }> } }>;
  };

  it('is the pack the loader registered every chain from', () => {
    expect(pack.kind).toBe('workflow-chain');
    expect(pack.chains.map((c) => c.chainId).sort()).toEqual([...WORKFLOW_TEMPLATE_CHAIN_IDS].sort());
    for (const id of WORKFLOW_TEMPLATE_CHAIN_IDS) expect(getChain(id)?.packName, id).toBe(pack.name);
  });

  it('every chain is internal: out of the gallery AND out of the zero-config tenant seed (ADR 0190 posture)', () => {
    for (const c of pack.chains) expect(c.internal, c.chainId).toBe(true);
    for (const id of WORKFLOW_TEMPLATE_CHAIN_IDS) expect(getChain(id)?.chain.internal, id).toBe(true);
  });

  it('every definition is a well-formed DAG over the three demo/core node types, one primary', () => {
    const allowed = new Set(['local.sample.demo.mock-ai', 'core.approvalGate', 'core.subWorkflow']);
    for (const id of WORKFLOW_TEMPLATE_CHAIN_IDS) {
      const def = defOf(id);
      const ids = new Set(def.nodes.map((n) => n.nodeId));
      expect(ids.size, id).toBe(def.nodes.length);
      for (const n of def.nodes) expect(allowed.has(n.typeId), `${id} ${n.typeId}`).toBe(true);
      for (const e of def.edges ?? []) {
        expect(ids.has(e.sourceNodeId), id).toBe(true);
        expect(ids.has(e.targetNodeId), id).toBe(true);
      }
      expect(def.nodes.filter((n) => n.outputRole === 'primary'), id).toHaveLength(1);
    }
  });

  it('every approvals.* template carries a core.approvalGate', () => {
    const approvals = WORKFLOW_TEMPLATE_CHAIN_IDS.filter((id) => id.startsWith('tmpl.approvals.'));
    // Measured: exactly these four (P2b).
    expect([...approvals].sort()).toEqual([
      'tmpl.approvals.dual-approver',
      'tmpl.approvals.manager-plus-compliance',
      'tmpl.approvals.single-approver',
      'tmpl.approvals.threshold-based',
    ]);
    for (const id of approvals) expect(defOf(id).nodes.some((n) => n.typeId === 'core.approvalGate'), id).toBe(true);
  });

  it('composition is closed: every core.subWorkflow binds a template in the pack', () => {
    const binds = WORKFLOW_TEMPLATE_CHAIN_IDS.flatMap((id) => defOf(id).nodes.filter((n) => n.typeId === 'core.subWorkflow').map((n) => [id, (n.config as { workflowId?: unknown }).workflowId] as const));
    // post-meeting-follow-up → action-extraction (P2a), approval-chase → single-approver (P2b)
    // Measured: the pack carries exactly two `subChainRef`s.
    expect(binds.map(([id, child]) => `${id}→${String(child)}`).sort()).toEqual([
      'tmpl.finance.approval-chase→tmpl.approvals.single-approver',
      'tmpl.meeting-ops.post-meeting-follow-up→tmpl.meeting-ops.action-extraction',
    ]);
    for (const [id, child] of binds) expect(WORKFLOW_TEMPLATE_CHAIN_IDS, id).toContain(child as string);
  });

  it('every node reference is exactly pinned (ADR 0766)', () => {
    for (const c of pack.chains) {
      for (const n of c.dag.nodes) expect(n.typeId, c.chainId).toMatch(/^[a-z][\w.-]*@\d+\.\d+\.\d+$/);
    }
  });
});

describe('ADR 0775 P2a — the real executor runs the migrated definitions', () => {
  const storageP = openStorage('memory://').then((s) => {
    setEventLogBackend(s);
    setSuspendBackend(s);
    initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-twin-chains-')) });
    return s;
  });
  const newRun = async (workflowId: string): Promise<RunRecord> => {
    const now = new Date().toISOString();
    const run: RunRecord = {
      runId: `run-${workflowId}`, workflowId, tenantId: 'demo', status: 'pending',
      inputs: { topic: 'Q2 planning' }, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
    };
    await (await storageP).insertRun(run);
    return run;
  };

  it('a draft template runs to completion', async () => {
    const storage = await storageP;
    const run = await newRun('tmpl.reporting.daily-summary');
    const result = await executeRun(storage, run, defOf('tmpl.reporting.daily-summary'));
    expect(result.status).toBe('completed');
  });

  it('an approvals template suspends at its gate under the BARE node id', async () => {
    const storage = await storageP;
    const run = await newRun('tmpl.approvals.single-approver');
    const result = await executeRun(storage, run, defOf('tmpl.approvals.single-approver'));
    expect(result.status).toBe('waiting-approval');
    expect(result.pausedNodeIds).toContain('approve');
  });

  it('a gated template suspends at its gate under the BARE node id', async () => {
    const storage = await storageP;
    const run = await newRun('tmpl.scheduling.hold-creation');
    const result = await executeRun(storage, run, defOf('tmpl.scheduling.hold-creation'));
    expect(result.status).toBe('waiting-approval');
    expect(result.pausedNodeIds).toContain('confirm-hold');
  });
});
