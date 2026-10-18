/**
 * ADR 0832 D3 — `orgScopeSubject`, the member who CAUSED a run that acts for
 * nobody. It must NARROW (bound which orgs the run's surfaces reach) and must
 * never GRANT. This file pins both halves:
 *
 *  - stamped: reserved against callers, stamped from `startWorkflowRun`'s
 *    explicit parameter, inherited by a sub-workflow child from its parent's
 *    person, recorded on a materialized kanban WorkItem from the run scope;
 *  - never a grant: the toggle resolver does not see it (a closed-beta listing
 *    is a grant), and a static scan holds every reader of the field to a known
 *    list, so a new reader is a review, not an accident.
 */
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { startWorkflowRun, type StartRunDeps } from '../src/host/runStarter.js';
import { dispatchSubWorkflow, setSubWorkflowDispatcher } from '../src/executor/subWorkflowDispatcher.js';
import { createKanbanSurface } from '../src/host/kanbanSurface.js';
import { createBoard, getWorkItem } from '../src/host/kanbanService.js';
import { registerFeatureSurface, buildFeatureSurfaces } from '../src/host/featureSurfaces.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';

const TENANT = 'adr0832-subject';
let storage: Storage;

const catalog = { getWorkflow: async (id: string) => ({ workflowId: id, definition: { workflowId: id, nodes: [], edges: [], variables: [] } }) };
const hostSuite = { workflowCatalog: catalog, providerPolicyResolver: { resolveForRun: async () => [] } } as unknown as StartRunDeps['hostSuite'];

beforeAll(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-adr0832-')) });
  setSubWorkflowDispatcher({ storage, hostSuite: hostSuite as never, executeRun: async () => ({}) });
});
afterAll(async () => { __resetHostExtPersistence(); await storage.close(); });

const meta = async (runId: string | null): Promise<Record<string, unknown>> =>
  ((await storage.getRun(runId!))?.metadata ?? {}) as Record<string, unknown>;

describe('stamping', () => {
  it('startWorkflowRun stamps the explicit parameter and strips a caller-supplied value', async () => {
    const deps: StartRunDeps = { storage, hostSuite };
    const forged = await startWorkflowRun(deps, { tenantId: TENANT, workflowId: 'wf.a', metadata: { orgScopeSubject: 'user:forged' } });
    expect((await meta(forged)).orgScopeSubject).toBeUndefined();
    const stamped = await startWorkflowRun(deps, { tenantId: TENANT, workflowId: 'wf.a', metadata: { orgScopeSubject: 'user:forged' }, orgScopeSubject: 'user:poster' });
    expect((await meta(stamped)).orgScopeSubject).toBe('user:poster');
    expect((await meta(stamped)).actingUserId, 'the causing member is not the actor').toBeUndefined();
  });

  const parent = async (runId: string, metadata: Record<string, unknown>): Promise<void> => {
    const now = new Date().toISOString();
    await insertRunWithStartContext(storage, { runId, workflowId: 'wf.parent', tenantId: TENANT, status: 'running', inputs: {}, metadata, configurable: {}, createdAt: now, updatedAt: now } as RunRecord);
  };

  it('a sub-workflow child carries its parent person as orgScopeSubject, never as actor', async () => {
    await parent('p-actor', { actingUserId: 'user:parent' });
    const r = await dispatchSubWorkflow({ parentRunId: 'p-actor', parentTenantId: TENANT, childWorkflowId: 'wf.child', parentNodeId: 'n', waitForCompletion: false, childMetadata: { orgScopeSubject: 'user:handoff-forge' } });
    const child = await meta(r.childRunId);
    expect(child.orgScopeSubject).toBe('user:parent');
    expect(child.actingUserId).toBeUndefined();
  });

  it('…and a grandchild inherits the same person through an actorless parent', async () => {
    await parent('p-subject', { orgScopeSubject: 'user:poster' });
    const r = await dispatchSubWorkflow({ parentRunId: 'p-subject', parentTenantId: TENANT, childWorkflowId: 'wf.child', parentNodeId: 'n', waitForCompletion: false });
    expect((await meta(r.childRunId)).orgScopeSubject).toBe('user:poster');
  });

  it('a system parent (no person) yields a system child', async () => {
    await parent('p-system', {});
    const r = await dispatchSubWorkflow({ parentRunId: 'p-system', parentTenantId: TENANT, childWorkflowId: 'wf.child', parentNodeId: 'n', waitForCompletion: false });
    expect((await meta(r.childRunId)).orgScopeSubject).toBeUndefined();
  });

  it('a materialized WorkItem records the run person from the scope, not from node args', async () => {
    const board = await createBoard({ tenantId: TENANT, name: 'B' });
    const col = board.columns[0]!.id;
    const kanban = createKanbanSurface({ tenantId: TENANT, runId: 'r', actingUserId: 'user:requester' });
    const out = await kanban.materializeWorkItems({
      boardId: board.id, scope: { kind: 'canvas.example', externalRef: 'c1' }, source: { kind: 'example.plan', id: 'p1', revision: '1' },
      items: [{ key: 'k1', title: 'T', columnId: col }], idempotencyKey: 'idem-1', requestedBy: 'user:forged',
    } as never) as { workItems: Array<{ workItemId: string }> };
    expect((await getWorkItem(out.workItems[0]!.workItemId))?.requestedBy).toBe('user:requester');
    expect(JSON.stringify(out), 'the person id is not echoed into run outputs').not.toContain('user:requester');
  });

  it('a system run cannot name a requester through node args', async () => {
    const board = await createBoard({ tenantId: TENANT, name: 'B2' });
    const kanban = createKanbanSurface({ tenantId: TENANT, runId: 'r' });
    const out = await kanban.materializeWorkItems({
      boardId: board.id, scope: { kind: 'canvas.example', externalRef: 'c2' }, source: { kind: 'example.plan', id: 'p2', revision: '1' },
      items: [{ key: 'k1', title: 'T', columnId: board.columns[0]!.id }], idempotencyKey: 'idem-2', requestedBy: 'user:forged',
    } as never) as { workItems: Array<{ workItemId: string }> };
    expect((await getWorkItem(out.workItems[0]!.workItemId))?.requestedBy).toBeUndefined();
  });

  it('a handoff record cannot name the child subject when the parent has no person', async () => {
    await parent('p-system-2', {});
    const r = await dispatchSubWorkflow({ parentRunId: 'p-system-2', parentTenantId: TENANT, childWorkflowId: 'wf.child', parentNodeId: 'n', waitForCompletion: false, childMetadata: { orgScopeSubject: 'user:handoff-forge' } });
    expect((await meta(r.childRunId)).orgScopeSubject).toBeUndefined();
  });
});

describe('never a grant', () => {
  it('the toggle resolver does not see it: a closed-beta listing is not served to the causing member', async () => {
    const id = 'adr0832-beta-probe';
    registerToggleDefault({ id, status: 'off', bucketUnit: 'tenant', salt: id });
    await saveConfig({ id, status: 'beta', bucketUnit: 'tenant', salt: id, betaCohort: ['user:beta-person'] } as never, 'test');
    registerFeatureSurface(id, () => ({ ping: async () => ({ ok: true }) }));
    const asActor = buildFeatureSurfaces({ tenantId: TENANT, actingUserId: 'user:beta-person' })[id]!;
    await expect(asActor.ping!({})).resolves.toEqual({ ok: true });
    const asCause = buildFeatureSurfaces({ tenantId: TENANT, orgScopeSubject: 'user:beta-person' })[id]!;
    await expect(asCause.ping!({})).rejects.toMatchObject({ code: 'host_capability_disabled' });
  });

  it('every reader of orgScopeSubject (or runOrgScopeSubject) is on the reviewed list', () => {
    // A new reader must be a narrowing floor. Adding a file here is a review of
    // that claim; a reader that GRANTS on the value is the defect ADR 0832 D3 rules out.
    const READERS = new Set([
      'host/accessControlService.ts', // runOrgScopeSubject — the floors' subject
      'host/featureSurfaces.ts', // the seam floor (via runOrgScopeSubject) and its resolveOne note
      'host/inMemorySurfaces.ts', // BundleScope field
      'host/agentToolProvider.ts', // forwarded into the tool BundleScope
      'host/conversationToolLoop.ts', // read off the run row, forwarded
      'host/knowledgeSurface.ts', // forwarded as SubjectCaller.orgScopeSubject
      'host/subjectAccess.ts', // SubjectCaller field (documented: never read by filterReadable)
      'host/runDispatch.ts', // reserved key
      'host/runStarter.ts', // stamped from the explicit parameter
      'host/hostEventDispatcher.ts', // stamped: trigger author
      'host/workflowComposeTool.ts', // stamped: approver
      'host/kanbanService.ts', // WorkItem.requestedBy doc
      'host/kanbanSurface.ts', // via runOrgScopeSubject
      'host/kanbanWorkItemDelivery.ts', // stamped: Run clicker or requestedBy
      'host/canvasSurface.ts', // stamped: invoking run's person
      'executor/executor.ts', // threaded into the bundle scope
      'executor/subWorkflowDispatcher.ts', // stamped: parent person
      'features/channels/channelAgentDispatch.ts', // stamped: poster
      'features/kb/surface.ts', // forwarded as SubjectCaller.orgScopeSubject (org filter only)
      'features/kb/kbService.ts', // tenantRetrieve's org filter
      'features/media/surface.ts', // its own floor, via assertRunScopeOrg
      'features/bi/surface.ts', // ADR 0846 D3: its own floor, via assertRunScopeOrg (runMetric)
      'features/documents/surface.ts', // ADR 0838 D3: NARROWS only — the person must pass canReadDocument; absent ⇒ unchanged
      'features/crm/surface.ts', // ADR 0838 D3: NARROWS only — e-sign document target read-gated for the person; absent ⇒ unchanged
      'features/cms/surface.ts', // ADR 0859 D3/D4: NARROWS only — a causing member is recorded as a submitterCause, which only REFUSES a self-approval; never notified
      'features/brand/surface.ts', // ADR 0891 D1: NARROWS only — the org-less listBrands keeps only the orgs the person may read (runOrgScopeFilter, cause lane by membership); absent ⇒ tenant-trusted, unchanged
      'features/service-desk/surface.ts', // ADR 0878 D1: NARROWS only — getTicket/notifyTicketTeam floor the ticket's own org via assertRunScopeOrg
      'features/assistant/surface.ts', // ADR 0878 D6: NARROWS only — an org's pending action is listed only to a person who may decide it; the personal-owner exit is the ACTOR's only
      'features/computer-use/feature.ts', // ADR 0894 D2: NARROWS only — decide/status floor the SESSION's own org via assertRunScopeOrg (404 when refused); decide additionally requires actingUserId === the opener, so a cause never decides
      // ADR 0901 D1/D2: NARROWS only — the cause lane binds the run's surfaces to the member who
      // caused it (tenant trust before); every authority predicate still runs for THAT person,
      // the personal-owner exit is the ACTOR's only, and OFF (shadow) leaves the call unchanged
      'features/kicktodo-core/surfaceBinding.ts',
      'features/entities/namespaceAccess.ts', // ADR 0847 D1: NARROWS only — the run's person must hold the tenant tier + the project namespace; absent ⇒ root tenant-trusted, project refused
      // ADR 0879 D7 — the run-lane conversation WRITE gate. Reviewed claim: it NARROWS. A
      // channel append with no person is REFUSED; with the stamped person it is allowed only
      // if THAT person may post there now (role + access + posting policy) — the person's
      // own authority is the ceiling, and nothing else (credentials, tools, recall) reads it.
      'host/runConversationWrite.ts', // the gate's subject (actingUserId ?? orgScopeSubject); refuses, never widens
      'host/agentRunnerNode.ts', // forwarded from ctx into the gate
      'host/chatSurface.ts', // forwarded from the BundleScope into the gate
      'executor/types.ts', // NodeContext field doc (the executor threads the reserved key)
      'host/hostCapabilityGates.ts', // EXECUTOR_CTX_POLICY declares it run-context (G14)
      'host/approvalDecision.ts', // stamped: approver (the ADR 0832 D3 role runStarter documents)
      'features/scheduled-agent-chats/scheduledChatService.ts', // stamped: the schedule's creator (host-written job metadata) + its backfill
      'host/scheduleDaemon.ts', // forwarded from host-written job metadata onto the run
      'routes/scheduler.ts', // RESERVED job-metadata key — stripped from client metadata
      'host/schedulingService.ts', // DSAR: an erased creator's stamp is scrubbed
    ]);
    const src = join(import.meta.dirname, '../src');
    const found: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && /orgScopeSubject|assertRunScopeOrg/i.test(readFileSync(p, 'utf8'))) found.push(p.slice(src.length + 1));
      }
    };
    walk(src);
    expect(found.length, 'the scan must see the known readers').toBeGreaterThanOrEqual(READERS.size);
    expect(found.filter((f) => !READERS.has(f))).toEqual([]);
  });

  it('the lanes that cannot be driven here stamp the right person (source shape)', () => {
    const read = (f: string): string => readFileSync(join(import.meta.dirname, '../src', f), 'utf8');
    expect(read('host/hostEventDispatcher.ts')).toMatch(/orgScopeSubject: binding\.createdBy/);
    expect(read('host/workflowComposeTool.ts')).toMatch(/orgScopeSubject: opts\.decidedByUserId/);
    expect(read('executor/executor.ts')).toMatch(/orgScopeSubject: bundleOrgScopeSubject/);
    expect(read('host/conversationToolLoop.ts')).toMatch(/\{ orgScopeSubject \}/);
    expect(read('routes/kanban.ts')).toMatch(/deliverReservedWorkItem\(deps, reservation, Date\.now\(\), callerSubject\(req\)\)/);
  });
});
