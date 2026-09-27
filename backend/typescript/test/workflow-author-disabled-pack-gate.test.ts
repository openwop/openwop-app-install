/**
 * ADR 0595 §Correction 4 — the ADR 0194 P3 disabled-pack gate on the MODEL doors.
 *
 * ADR 0595 §4 rules that *"the two write doors agree on legality"*. They did not.
 * `assertNoDisabledPacks` (the ONE registration choke, ADR 0194 P3 / ADR 0481)
 * guards the REST create, the revision restore, the from-chain instantiation and
 * the collab derive — and NEITHER model-driven door:
 * `persistAuthoredWorkflow` (the `…nodes.persist` lane) nor `prepareComposedDraft`
 * (the shared step of `openwop:workflows.propose` + `.compose-and-run`).
 *
 * The AI author's MENU is tenant-curated (`buildAuthoringCatalog` takes
 * `disabledPacks`), so the gap is invisible while the model only uses what it
 * was shown. It bites when it does not: `findUnknownTypeIds` resolves against
 * the HOST-GLOBAL `buildNodeCatalog()`, so a disabled pack's typeId — named from
 * a prior turn, from `openwop:schema.lookup`, or from the model's own memory —
 * passes the closed-world check and is written. The tenant's curation is then
 * enforced on the door a human uses and skipped on the door a model uses.
 *
 * PRE-EXISTING on both doors, so not a regression of the fix — but §4's ruling
 * claimed a completeness it did not have, which is the defect being closed here.
 *
 * HERMETIC: the gate maps typeId → packName through `buildNodeCatalog()`, whose
 * pack half scans `OPENWOP_PACK_DIR`. The suite's per-worker dir is empty, so
 * this file writes ONE synthetic manifest into it and removes it afterwards
 * (env outlives a file inside a vitest worker — see `test/setup/isolatePackDir.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { buildNodeCatalog, findUnknownTypeIds } from '../src/host/nodeCatalogBuilder.js';
import { setDisabledPacksResolver, __resetDisabledPacksResolver } from '../src/host/packVisibility.js';
import { persistAuthoredWorkflow } from '../src/features/workflow-author/workflowAuthorService.js';
import { getRegisteredWorkflowAsync } from '../src/host/workflowsRegistry.js';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { setDurableStorage } from '../src/host/durable/durableStore.js';
import type { Storage } from '../src/storage/storage.js';

const PACK_NAME = 'synthetic.wfa-gate';
const TYPE_ID = 'synthetic.wfa-gate.step';
const T = 'ws-wfa-packgate';

let packEntryDir: string | null = null;
let storage: Storage;

beforeAll(async () => {
  ensureNodesRegistered();
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  setDurableStorage(storage);

  const packDir = process.env.OPENWOP_PACK_DIR;
  if (!packDir) throw new Error('OPENWOP_PACK_DIR unset — test/setup/isolatePackDir.ts should have set it');
  packEntryDir = join(packDir, PACK_NAME);
  mkdirSync(packEntryDir, { recursive: true });
  writeFileSync(
    join(packEntryDir, 'pack.json'),
    JSON.stringify({
      name: PACK_NAME,
      version: '1.0.0',
      description: 'ADR 0595 §Correction 4 witness fixture — one pack-declared node.',
      nodes: [{ typeId: TYPE_ID, version: '1.0.0', label: 'Synthetic step', category: 'flow', role: 'pure' }],
      runtime: { language: 'javascript', format: 'esm', entry: './index.mjs' },
    }),
  );
});

afterAll(() => {
  if (packEntryDir) rmSync(packEntryDir, { recursive: true, force: true });
  __resetDisabledPacksResolver();
  setDurableStorage(null);
  __resetHostExtPersistence();
});

const def = (id: string): Record<string, unknown> => ({ workflowId: id, nodes: [{ nodeId: 'n1', typeId: TYPE_ID }] });

describe('the fixture is real (a witness over a node nothing declares would pass forever)', () => {
  it('the synthetic pack node is in the catalog, and is closed-world LEGAL', () => {
    const node = buildNodeCatalog().find((n) => n.typeId === TYPE_ID);
    expect(node, 'the synthetic manifest did not reach buildNodeCatalog').toBeTruthy();
    expect(node?.packName).toBe(PACK_NAME);
    // THIS is why the disabled gate is a SEPARATE law: closed-world sees the
    // host-global catalog and says "legal" no matter what the tenant curated.
    expect(
      findUnknownTypeIds({ workflowId: 'x', nodes: [{ nodeId: 'n1', typeId: TYPE_ID }] } as never),
      'the closed-world check is host-global — it can never see tenant curation',
    ).toEqual([]);
  });
});

describe('DOOR 1 — `persistAuthoredWorkflow` honours the tenant disabled-pack gate', () => {
  it('refuses a definition whose node comes from a pack the workspace disabled', async () => {
    setDisabledPacksResolver(async (tenantId) => (tenantId === T ? new Set([PACK_NAME]) : new Set()));
    const id = 'authored.packgate-refused';
    await expect(persistAuthoredWorkflow(def(id), { tenantId: T })).rejects.toMatchObject({
      code: 'forbidden',
      details: { disabledPacks: [PACK_NAME] },
    });
    expect(await getRegisteredWorkflowAsync(id), 'and nothing is written').toBeNull();
  });

  it('is TENANT-scoped — another workspace is untouched', async () => {
    setDisabledPacksResolver(async (tenantId) => (tenantId === T ? new Set([PACK_NAME]) : new Set()));
    const id = 'authored.packgate-other-tenant';
    await expect(persistAuthoredWorkflow(def(id), { tenantId: 'ws-wfa-packgate-other' })).resolves.toMatchObject({ workflowId: id });
  });

  it('re-enabling restores the write (the refusal names an action that works)', async () => {
    setDisabledPacksResolver(async () => new Set());
    const id = 'authored.packgate-reenabled';
    await expect(persistAuthoredWorkflow(def(id), { tenantId: T })).resolves.toMatchObject({ workflowId: id });
  });
});

describe('DOOR 2 — `openwop:workflows.propose` honours the same gate', () => {
  const propose = async (definition: unknown, tenantId: string): Promise<{ content: string; isError?: boolean }> => {
    const { registerWorkflowProposeTool } = await import('../src/host/workflowComposeTool.js');
    const { createAgentToolProvider } = await import('../src/host/agentToolProvider.js');
    registerWorkflowProposeTool({ workflowCatalog: { getWorkflow: async (id) => getRegisteredWorkflowAsync(id) } });
    return createAgentToolProvider({ tenantId, actingUserId: 'u-1' }).executeTool({
      name: 'openwop:workflows.propose',
      input: { definition, summary: 'pack gate' },
    });
  };

  it('reports the refusal (the agent repairs from it) and registers nothing', async () => {
    setDisabledPacksResolver(async (tenantId) => (tenantId === T ? new Set([PACK_NAME]) : new Set()));
    const id = 'proposed.packgate-refused';
    const out = await propose(def(id), T);
    expect(out.isError, 'the propose door must refuse a disabled pack too').toBe(true);
    expect(out.content).toMatch(/disabled/i);
    expect(await getRegisteredWorkflowAsync(id)).toBeNull();
  });

  it('still accepts the same composition for a workspace that has not disabled it', async () => {
    setDisabledPacksResolver(async (tenantId) => (tenantId === T ? new Set([PACK_NAME]) : new Set()));
    const id = 'proposed.packgate-allowed';
    const out = await propose(def(id), 'ws-wfa-packgate-other');
    expect(out.isError, 'the refusal must not be a blanket block').toBeFalsy();
    expect(await getRegisteredWorkflowAsync(id)).not.toBeNull();
  });
});
