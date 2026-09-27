/**
 * ADR 0595 — the AI Workflow Author's DURABLE-WRITE contract.
 *
 * Every case below was written RED, against `origin/main`, before the cure. They
 * are the witnesses for the seven data-integrity/authority defects the three
 * graders converged on (`WFAWF-1/-2/-4/-5/-7/-8`, `WFAC-1/-4` — feature 25/71):
 *
 *  W1  a revise must not silently strip fields the model's response schema
 *      cannot express (`WFAWF-1`).
 *  W2  the write must never leave a definition REGISTERED-but-UNOWNED, which
 *      `listAuthoredWorkflows` classifies as a host built-in visible to EVERY
 *      tenant and overwritable by NONE (`WFAWF-5`).
 *  W3  a durable def write that FAILS must not be reported as success
 *      (`WFAC-1` = `WFAWF-4`).
 *  W4  the sibling `openwop:workflows.propose` lane must apply the SAME
 *      closed-world typeId law (`WFAC-4` = `WFAWF-3`).
 *  W5  `metadata.lifecycle` is NOT model-writable (`WFAWF-7`).
 *  W6  the host STAMPS the ADR 0369 §5 lifecycle server-side, on CREATE only
 *      (`WFAWF-2`).
 *  W7  tenant teardown reaches `wfreg:` rows on BOTH lanes (`WFAWF-8`).
 *
 * These exercise the SERVICE + the agent-tool seam, not a spy: a test that
 * asserts "the helper was called" proves the mechanism and says nothing about
 * whether the lane reaches it (ADR 0502, paid for twice in this repo).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import {
  persistAuthoredWorkflow,
  listAuthoredWorkflows,
  readAuthoredWorkflow,
} from '../src/features/workflow-author/workflowAuthorService.js';
import {
  getRegisteredWorkflowAsync,
  deleteRegisteredWorkflow,
  __clearRegistryCacheForTests,
} from '../src/host/workflowsRegistry.js';
import { lifecycleOf } from '../src/host/workflowLifecycle.js';
import { getOwned, listOwned, purgeTenantOwnedWorkflowDefs, removeOwnership } from '../src/host/workflowOwnership.js';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { setDurableStorage } from '../src/host/durable/durableStore.js';
import { pruneAbandonedAnonTenants } from '../src/host/retentionSweepDaemon.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

const T = 'ws-wfa-integrity';
let storage: Storage;

beforeAll(async () => {
  ensureNodesRegistered();
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  setDurableStorage(storage); // `wfreg:` rows must actually land
});
afterAll(() => {
  setDurableStorage(null);
  __resetHostExtPersistence();
});

const noop = (nodeId: string) => ({ nodeId, typeId: 'core.noop' });

/** A head carrying every field the node pack's RESPONSE_SCHEMA cannot express
 *  (`packs/feature.workflow-author.nodes/index.mjs:44-80`). */
const richHead = (id: string): Record<string, unknown> => ({
  workflowId: id,
  nodes: [
    { ...noop('a'), inputs: { greeting: { type: 'variable', variableName: 'who' } } },
    { ...noop('b'), compensation: { nodeTypeId: 'core.noop' } },
  ],
  edges: [{ id: 'e1', sourceNodeId: 'a', targetNodeId: 'b', triggerRule: 'all_success' }],
  variables: [{ name: 'who', type: 'string', required: true }],
  settings: { concurrency: 2 },
  configurableSchema: { type: 'object', properties: { who: { type: 'string' } } },
  metadata: { name: 'Rich head' },
});

/** What an AI *revise* looks like: the same graph, re-emitted through a schema
 *  that models only `workflowId`/`nodes`/`edges`. */
const modelRevise = (id: string): Record<string, unknown> => ({
  workflowId: id,
  nodes: [noop('a'), noop('b')],
  edges: [{ id: 'e1', sourceNodeId: 'a', targetNodeId: 'b', triggerRule: 'all_success' }],
});

const head = async (id: string): Promise<WorkflowDefinition> => {
  const def = await getRegisteredWorkflowAsync(id);
  if (!def) throw new Error(`no head for ${id}`);
  return def;
};

// ── W1 (WFAWF-1) — a revise must not strip what the model cannot express ─────
describe('W1 — an AI revise round-trips the fields its response schema cannot express', () => {
  const id = 'authored.w1-revise';

  it('seeds a rich head through the authoring lane', async () => {
    await persistAuthoredWorkflow(richHead(id), { tenantId: T });
    const h = await head(id);
    expect(h.variables).toHaveLength(1);
    expect(h.settings).toEqual({ concurrency: 2 });
    expect(h.nodes.find((n) => n.nodeId === 'a')?.inputs).toBeDefined();
    expect(h.nodes.find((n) => n.nodeId === 'b')?.compensation).toBeDefined();
    expect(h.configurableSchema).toBeDefined();
  });

  it('a revise that omits them wholesale does NOT destroy them', async () => {
    await persistAuthoredWorkflow(modelRevise(id), { tenantId: T });
    const h = await head(id);
    expect(h.variables, 'def-level `variables` survived the revise').toHaveLength(1);
    expect(h.settings, 'def-level `settings` survived the revise').toEqual({ concurrency: 2 });
    expect(h.configurableSchema, '`configurableSchema` survived the revise').toBeDefined();
    expect(
      h.nodes.find((n) => n.nodeId === 'a')?.inputs,
      'node `inputs` survived the revise (restored onto the SURVIVING nodeId)',
    ).toEqual({ greeting: { type: 'variable', variableName: 'who' } });
    expect(
      h.nodes.find((n) => n.nodeId === 'b')?.compensation,
      'node `compensation` survived — RFC 0151: a dropped inverse makes an unwind report a clean `none` for a run that committed effects',
    ).toBeDefined();
  });

  it('a PARTIAL drop is honoured as a deletion, not resurrected (the discriminator is not unconditional)', async () => {
    const partial = {
      ...richHead(id),
      // node `a` keeps its inputs; node `b` loses its compensation — a
      // whole-set omission for `compensation`, so it WOULD restore. Give `b`
      // an input instead so `inputs` is a PARTIAL, not whole-set, change.
      nodes: [
        { ...noop('a'), inputs: { greeting: { type: 'static', value: 'hi' } } },
        noop('b'),
      ],
    };
    await persistAuthoredWorkflow(partial, { tenantId: T });
    const h = await head(id);
    expect(h.nodes.find((n) => n.nodeId === 'a')?.inputs).toEqual({ greeting: { type: 'static', value: 'hi' } });
    expect(h.nodes.find((n) => n.nodeId === 'b')?.inputs).toBeUndefined();
  });

  it('a FIRST write (no prior head) restores nothing — there is nothing to compare against', async () => {
    const fresh = 'authored.w1-fresh';
    await persistAuthoredWorkflow(modelRevise(fresh), { tenantId: T });
    const h = await head(fresh);
    expect(h.variables).toBeUndefined();
    expect(h.settings).toBeUndefined();
  });
});

// ── W2 (WFAWF-5) — never registered-but-unowned ─────────────────────────────
describe('W2 — the write never leaves a definition REGISTERED but UNOWNED', () => {
  it('ownership lands no later than registration (the pair is never half-applied in the exposing direction)', async () => {
    const id = 'authored.w2-order';
    await persistAuthoredWorkflow({ workflowId: id, nodes: [noop('a')] }, { tenantId: T });
    expect(await getOwned(T, id), 'the ownership row exists').not.toBeNull();
    // The exposure this closes: an UNOWNED registered def is classified a host
    // BUILT-IN by `listAuthoredWorkflows` — visible to every tenant and
    // overwritable by none.
    const other = 'ws-w2-stranger';
    const seen = (await listAuthoredWorkflows({ tenantId: other })).map((w) => w.workflowId);
    expect(seen, 'a tenant-authored def must never read as a host built-in to a stranger').not.toContain(id);
    expect(await readAuthoredWorkflow(id, { tenantId: other })).toEqual({ found: false });
  });

  it('a FAILING ownership write leaves NOTHING registered (the pair cannot half-apply)', async () => {
    // The ordering witness. On the pre-fix lane the definition was registered
    // FIRST, with an awaited `recordRevision` between, so a throw before
    // `recordOwnership` stranded a permanently unowned definition. Inject the
    // failure at the ownership write and assert the registry stayed clean.
    const id = 'authored.w2-fault';
    const failing = new Proxy(storage, {
      get(target, prop, recv) {
        if (prop === 'kvSet') {
          return async (key: string, value: string): Promise<void> => {
            if (key.startsWith('hostext:workflow:ownership:')) throw new Error('ownership write failed');
            return Reflect.get(target, prop, recv).call(target, key, value);
          };
        }
        if (prop === 'kvCompareAndSwap') {
          return async (key: string): Promise<boolean> => {
            if (key.startsWith('hostext:workflow:ownership:')) throw new Error('ownership CAS failed');
            return false;
          };
        }
        return Reflect.get(target, prop, recv);
      },
    }) as Storage;
    // The ownership index rides `hostExtPersistence`'s OWN storage ref, not the
    // durable-store one — a real distinction, and getting it wrong is how a
    // fault-injection probe ends up injecting nothing and reporting green.
    setDurableStorage(failing);
    initHostExtPersistence(failing);
    try {
      await expect(
        persistAuthoredWorkflow({ workflowId: id, nodes: [noop('a')] }, { tenantId: T }),
      ).rejects.toThrow();
    } finally {
      setDurableStorage(storage);
      initHostExtPersistence(storage);
    }
    __clearRegistryCacheForTests();
    expect(
      await getRegisteredWorkflowAsync(id),
      'a failed ownership write must not leave a globally-readable, un-overwritable definition behind',
    ).toBeNull();
  });

  it('an unowned registered definition IS readable as a built-in by a stranger — what the ordering fix costs if it regresses', async () => {
    // The stake, stated rather than implied. Constructed directly, because the
    // WRITE lane can no longer produce it (that is case 2's assertion).
    //
    // Note the def must be PROMOTED for the exposure to bite: a born-transient
    // draft is catalog-hidden from non-owners anyway, so the ADR 0369 §5 stamp
    // narrows this hole incidentally. It does not CLOSE it — a workflow the
    // user promoted and whose ownership row later vanished is fully exposed —
    // which is why the ordering fix carries the invariant, not the stamp.
    const id = 'authored.w2-stranded';
    await persistAuthoredWorkflow({ workflowId: id, nodes: [noop('a')] }, { tenantId: T });
    const { withLifecycle } = await import('../src/host/workflowLifecycle.js');
    const { registerWorkflowDurable } = await import('../src/host/workflowsRegistry.js');
    await registerWorkflowDurable(withLifecycle(await head(id), { transient: undefined }));
    await removeOwnership(T, id);
    const other = 'ws-w2-stranger2';
    const seen = (await listAuthoredWorkflows({ tenantId: other })).map((w) => w.workflowId);
    expect(seen, 'THIS is the exposure: unowned ⇒ every tenant sees it').toContain(id);
    // ...and its own author can no longer overwrite it.
    await expect(persistAuthoredWorkflow({ workflowId: id, nodes: [noop('a')] }, { tenantId: T }))
      .rejects.toMatchObject({ code: 'conflict' });
    deleteRegisteredWorkflow(id);
  });
});

// ── W3 (WFAC-1 = WFAWF-4) — no success over an unlanded write ───────────────
describe('W3 — a durable definition write that FAILS is not reported as success', () => {
  const id = 'authored.w3-durability';
  afterEach(() => setDurableStorage(storage));

  it('rejects when the `wfreg:` write fails, instead of returning 201 over nothing', async () => {
    const failing = new Proxy(storage, {
      get(target, prop, recv) {
        if (prop === 'kvSet') {
          return async (key: string, value: string): Promise<void> => {
            if (key.startsWith('wfreg:')) throw new Error('durable write failed');
            return Reflect.get(target, prop, recv).call(target, key, value);
          };
        }
        return Reflect.get(target, prop, recv);
      },
    }) as Storage;
    setDurableStorage(failing);
    await expect(
      persistAuthoredWorkflow({ workflowId: id, nodes: [noop('a')] }, { tenantId: T }),
    ).rejects.toThrow();
    setDurableStorage(storage);
    // And the caller can retry: the failure left no row another tenant reads.
    __clearRegistryCacheForTests();
    expect(await getRegisteredWorkflowAsync(id)).toBeNull();
  });
});

// ── W4 (WFAC-4 = WFAWF-3) — the sibling write lane obeys the same law ───────
describe('W4 — `openwop:workflows.propose` applies the SAME closed-world typeId law', () => {
  const propose = async (definition: unknown, dryRun = false): Promise<{ content: string; isError?: boolean }> => {
    const { registerWorkflowProposeTool } = await import('../src/host/workflowComposeTool.js');
    const { createAgentToolProvider } = await import('../src/host/agentToolProvider.js');
    // The real tool, against a read-only resolver — proposing can never execute
    // (that is the lane's own design), so no run-starter deps are needed.
    registerWorkflowProposeTool({ workflowCatalog: { getWorkflow: async (id) => getRegisteredWorkflowAsync(id) } });
    return createAgentToolProvider({ tenantId: T, actingUserId: 'u-1' }).executeTool({
      name: 'openwop:workflows.propose',
      input: { definition, ...(dryRun ? { dryRun: true } : {}) },
    });
  };

  it('refuses an out-of-catalog typeId (reports the refusal, does not throw)', async () => {
    const out = await propose({ workflowId: 'proposed.w4-bogus', nodes: [{ nodeId: 'n1', typeId: 'totally.made.up.node' }] });
    expect(out.isError, 'the propose lane must refuse an invented typeId').toBe(true);
    expect(out.content).toMatch(/Unknown node typeId/);
    expect(await getRegisteredWorkflowAsync('proposed.w4-bogus'), 'and nothing is registered').toBeNull();
  });

  it('still accepts a legal composition (the refusal is not a blanket block)', async () => {
    const out = await propose({ workflowId: 'proposed.w4-ok', nodes: [noop('n1')] }, true);
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toMatchObject({ valid: true });
  });
});

// ── W5b (ADR 0595 §Correction 2) — the SIBLING door's lifecycle ─────────────
//
// `WFAWF-7` was closed on the author lane and NOT on the propose/composeAndRun
// lane this same PR reached into for its closed-world check. `registerTransientDraft`
// — the shared step 5 of BOTH tools — called `withLifecycle`, which seeds from
// `lifecycleOf(def)` and patches only `transient`/`generatedBy`, so a
// model-supplied `archivedAt` SURVIVED: the exact hole `withHostLifecycle`'s
// docblock says it exists to close, one layer down. W5 above covers the author
// lane; no assertion covered this one — the "sabotage cannot invent an
// assertion nobody wrote" shape.
describe('W5b — `openwop:workflows.propose` also refuses a model-written lifecycle', () => {
  const propose = async (definition: unknown): Promise<{ content: string; isError?: boolean }> => {
    const { registerWorkflowProposeTool } = await import('../src/host/workflowComposeTool.js');
    const { createAgentToolProvider } = await import('../src/host/agentToolProvider.js');
    registerWorkflowProposeTool({ workflowCatalog: { getWorkflow: async (id) => getRegisteredWorkflowAsync(id) } });
    return createAgentToolProvider({ tenantId: T, actingUserId: 'u-1' }).executeTool({
      name: 'openwop:workflows.propose',
      input: { definition, summary: 'W5b' },
    });
  };

  it('a model-supplied `archivedAt` cannot mint a born-archived proposal', async () => {
    // The end-to-end harm: the proposal reports `pending_approval` (success),
    // while the draft is catalog-hidden, GC-eligible FROM BIRTH, and the
    // ownership row (which is written `transient:true` with no `archivedAt`)
    // disagrees with the definition. Approve & run → Save → `promote` calls
    // `withLifecycle(def,{transient:undefined})`, which KEEPS `archivedAt` —
    // so the workflow vanishes the instant the user saves it.
    const id = 'proposed.w5b-born-archived';
    const out = await propose({
      workflowId: id,
      nodes: [noop('n1')],
      metadata: { name: 'W5b', lifecycle: { archivedAt: '2020-01-01T00:00:00.000Z' } },
    });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toMatchObject({ status: 'pending_approval' });
    const lc = lifecycleOf(await head(id));
    expect(lc.archivedAt, 'the host, not the model, decides archival — on BOTH write doors').toBeUndefined();
    expect(lc.transient, 'and the host stamp still lands').toBe(true);
    expect((await getOwned(T, id))?.archivedAt, 'the ownership row and the definition agree').toBeUndefined();
  });

  it('a model-supplied `generatedBy` cannot forge agent provenance', async () => {
    const id = 'proposed.w5b-forged';
    await propose({
      workflowId: id,
      nodes: [noop('n1')],
      metadata: { lifecycle: { generatedBy: 'agent:trust-me', transient: false } },
    });
    expect(lifecycleOf(await head(id)).generatedBy, 'attribution is minted from the scope, never read from the body')
      .toBe('agent:unattributed');
  });
});

// ── W4b (WFAWF-3, resource half) — ONE budget across both write doors ───────
describe('W4b — `persist` draws on the SAME transient budget as `propose`', () => {
  const t = 'ws-wfa-cap';
  afterEach(() => { delete process.env.OPENWOP_AGENT_TRANSIENT_WORKFLOWS_MAX; });

  it('refuses a NEW draft past the cap, and names the way out', async () => {
    process.env.OPENWOP_AGENT_TRANSIENT_WORKFLOWS_MAX = '2';
    await persistAuthoredWorkflow({ workflowId: 'authored.cap-1', nodes: [noop('a')] }, { tenantId: t });
    await persistAuthoredWorkflow({ workflowId: 'authored.cap-2', nodes: [noop('a')] }, { tenantId: t });
    await expect(persistAuthoredWorkflow({ workflowId: 'authored.cap-3', nodes: [noop('a')] }, { tenantId: t }))
      .rejects.toMatchObject({ code: 'conflict', details: { reason: 'transient_workflow_cap' } });
  });

  it('still lets the tenant EDIT a draft it already owns — a cap with no exit is a defect', async () => {
    process.env.OPENWOP_AGENT_TRANSIENT_WORKFLOWS_MAX = '2';
    await expect(persistAuthoredWorkflow({ workflowId: 'authored.cap-1', nodes: [noop('a'), noop('b')] }, { tenantId: t }))
      .resolves.toMatchObject({ workflowId: 'authored.cap-1', nodeCount: 2 });
  });

  it('the refusal names the population it actually counts, and the remedy that works (§Correction 7)', async () => {
    // Two defects in one sentence. The counter counts EVERY live transient the
    // tenant owns — agent `propose` drafts and recorded walkthrough tours
    // included — while the message said "unsaved AI-authored drafts", so a user
    // whose budget is full of tours is sent looking for authored workflows that
    // may not exist. And it led with "Save (promote)", which needs a completed
    // non-debug run plus green `requiredForPromote` evals, so it 409s for
    // exactly the un-run drafts consuming the budget. Archive always works.
    process.env.OPENWOP_AGENT_TRANSIENT_WORKFLOWS_MAX = '1';
    const t2 = 'ws-wfa-cap-msg';
    // Fill the budget from a NON-author lane — a recorded-tour-shaped draft, the
    // population the old message did not name.
    const { recordOwnership } = await import('../src/host/workflowOwnership.js');
    await recordOwnership(t2, 'walkthrough.authored.tour-1', { name: 'A tour', nodeCount: 2, transient: true });
    let message = '';
    await persistAuthoredWorkflow({ workflowId: 'authored.cap-msg', nodes: [noop('a')] }, { tenantId: t2 })
      .catch((e: Error) => { message = e.message; });
    expect(message, 'a NON-author draft consumes the author lane budget — one budget, by design').not.toBe('');
    expect(message, 'the message must name what it counts, not just this lane').toMatch(/tours/i);
    expect(message).toMatch(/proposals/i);
    expect(
      message.toLowerCase().indexOf('archive') < message.toLowerCase().indexOf('promote'),
      'lead with the remedy that always works — promote 409s for an un-run draft',
    ).toBe(true);
  });

  it('archiving frees budget (the refusal names an action that works)', async () => {
    process.env.OPENWOP_AGENT_TRANSIENT_WORKFLOWS_MAX = '2';
    const { withLifecycle } = await import('../src/host/workflowLifecycle.js');
    const { registerWorkflowDurable } = await import('../src/host/workflowsRegistry.js');
    const archived = withLifecycle(await head('authored.cap-1'), { archivedAt: new Date().toISOString() });
    await registerWorkflowDurable(archived);
    const { recordOwnership } = await import('../src/host/workflowOwnership.js');
    await recordOwnership(t, 'authored.cap-1', { nodeCount: 2, transient: true, archivedAt: lifecycleOf(archived).archivedAt });
    await expect(persistAuthoredWorkflow({ workflowId: 'authored.cap-3', nodes: [noop('a')] }, { tenantId: t }))
      .resolves.toMatchObject({ workflowId: 'authored.cap-3' });
  });
});

// ── W5 (WFAWF-7) — lifecycle is not model-writable ──────────────────────────
describe('W5 — `metadata.lifecycle` supplied by the model is ignored', () => {
  it('a model-supplied `archivedAt` cannot mint a born-archived workflow', async () => {
    const id = 'authored.w5-born-archived';
    await persistAuthoredWorkflow(
      { workflowId: id, nodes: [noop('a')], metadata: { name: 'W5', lifecycle: { archivedAt: '2020-01-01T00:00:00.000Z' } } },
      { tenantId: T },
    );
    expect(lifecycleOf(await head(id)).archivedAt, 'the host, not the model, decides archival').toBeUndefined();
    expect((await getOwned(T, id))?.archivedAt).toBeUndefined();
    expect((await listAuthoredWorkflows({ tenantId: T })).map((w) => w.workflowId))
      .toContain(id); // reported success ⇒ actually visible
  });

  it('a model-supplied `generatedBy` cannot forge provenance', async () => {
    const id = 'authored.w5-forged';
    await persistAuthoredWorkflow(
      { workflowId: id, nodes: [noop('a')], metadata: { lifecycle: { generatedBy: 'agent:trust-me' } } },
      { tenantId: T },
    );
    expect(lifecycleOf(await head(id)).generatedBy).toBe('workflow-author');
  });
});

// ── W6 (WFAWF-2) — the host stamps ADR 0369 §5 lifecycle, on CREATE only ────
describe('W6 — ADR 0369 §5 lifecycle stamping', () => {
  it('a newly authored definition is born transient + attributed', async () => {
    const id = 'authored.w6-new';
    await persistAuthoredWorkflow({ workflowId: id, nodes: [noop('a')] }, { tenantId: T });
    const lc = lifecycleOf(await head(id));
    expect(lc.transient, 'born transient ⇒ GC-eligible and cap-counted').toBe(true);
    expect(lc.generatedBy).toBe('workflow-author');
    expect((await getOwned(T, id))?.transient, 'the denormalized ownership row agrees').toBe(true);
  });

  it("the tenant's OWN transient draft still appears in its authored index", async () => {
    // Without this the Architect could not `get`-list the workflow it had just
    // authored, breaking read-before-write on the very next turn.
    const id = 'authored.w6-listable';
    await persistAuthoredWorkflow({ workflowId: id, nodes: [noop('a')] }, { tenantId: T });
    expect((await listAuthoredWorkflows({ tenantId: T })).map((w) => w.workflowId)).toContain(id);
  });

  it('a transient draft is NOT visible to another tenant', async () => {
    const id = 'authored.w6-scoped';
    await persistAuthoredWorkflow({ workflowId: id, nodes: [noop('a')] }, { tenantId: T });
    expect((await listAuthoredWorkflows({ tenantId: 'ws-w6-stranger' })).map((w) => w.workflowId)).not.toContain(id);
  });

  it('an UNOWNED transient definition is hidden from everyone (ADR 0595 §Correction 6)', async () => {
    // The compensating filter (`if (!isOwn && !catalogVisible(w)) continue`) had
    // no witness: deleting it left the file green, because the "not visible to
    // another tenant" case above exits at the EARLIER `!isOwn && !isBuiltin`
    // continue — it passes for the wrong reason, and passes on `origin/main` too.
    //
    // The state that reaches the second filter is the stranded one W2
    // constructs: registered, UNOWNED (so it classifies as a host BUILT-IN and
    // clears the first continue) and TRANSIENT. That is a host/foreign DRAFT and
    // must stay hidden — from a stranger AND from the tenant that authored it,
    // which no longer owns the row.
    const id = 'authored.w6-unowned-transient';
    await persistAuthoredWorkflow({ workflowId: id, nodes: [noop('a')] }, { tenantId: T });
    expect(lifecycleOf(await head(id)).transient, 'the fixture must actually be transient').toBe(true);
    await removeOwnership(T, id);
    expect(
      (await listAuthoredWorkflows({ tenantId: 'ws-w6-unowned-stranger' })).map((w) => w.workflowId),
      'an unowned TRANSIENT draft reads as a built-in and must still be catalog-hidden',
    ).not.toContain(id);
    expect(
      (await listAuthoredWorkflows({ tenantId: T })).map((w) => w.workflowId),
      'and the former owner does not get it back through the built-in classification either',
    ).not.toContain(id);
    deleteRegisteredWorkflow(id);
  });

  it('an AI revise of an already-PROMOTED workflow does NOT demote it back to transient', async () => {
    // The regression the naive reading of ADR 0369 §5 would ship: stamping on
    // every write would silently pull a saved, catalog-listed workflow back out
    // of the `/` picker the moment its owner asked the AI to tweak it.
    const id = 'authored.w6-promoted';
    await persistAuthoredWorkflow({ workflowId: id, nodes: [noop('a')] }, { tenantId: T });
    const { withLifecycle } = await import('../src/host/workflowLifecycle.js');
    const { registerWorkflowDurable } = await import('../src/host/workflowsRegistry.js');
    await registerWorkflowDurable(withLifecycle(await head(id), { transient: undefined })); // promote
    expect(lifecycleOf(await head(id)).transient).toBeUndefined();

    await persistAuthoredWorkflow({ workflowId: id, nodes: [noop('a'), noop('b')] }, { tenantId: T });
    expect(lifecycleOf(await head(id)).transient, 'a promoted workflow stays promoted across an AI revise').toBeUndefined();
    expect((await getOwned(T, id))?.transient).toBeFalsy();
  });
});

// ── W8 (ADR 0595 §Correction 1) — the preserve guard MUST have an exit ──────
//
// ADR 0524's discriminated merge is only safe because "explicitly cleared" is
// REPRESENTABLE: `inputs:{}` / `variables:[]` / `configurableSchema:{}` /
// `settings:{}` all validate, so `carries()` stands down and the author's
// deletion is honoured. `compensation` has NO such form — RFC 0151 §B is a
// CLOSED block with `nodeTypeId` REQUIRED, so `compensation:{}` is a 400 and
// `compensation:null` normalizes to `undefined`, indistinguishable from
// omission. Widening `PreservableField` to `compensation` without an exit made
// a node's inverse action PERMANENTLY UNDELETABLE on this lane — verbatim the
// forbidden state `preserveDroppedFields`'s own docblock names ("an
// unconditional merge makes DELETION IMPOSSIBLE"), shipped by the change whose
// ADR warns against it.
describe('W8 — an explicit clear is representable and honoured on the author lane', () => {
  const withComp = (id: string): Record<string, unknown> => ({
    workflowId: id,
    nodes: [noop('a'), { ...noop('b'), compensation: { nodeTypeId: 'core.noop' } }],
  });
  const withoutComp = (id: string): Record<string, unknown> => ({
    workflowId: id,
    nodes: [noop('a'), noop('b')],
  });

  it('the two forms that LOOK like a clear are not one (the mechanism, pinned)', async () => {
    const id = 'authored.w8-forms';
    await persistAuthoredWorkflow(withComp(id), { tenantId: T });
    // `{}` — a 400 from the closed RFC 0151 §B block, so it can never be a clear.
    await expect(
      persistAuthoredWorkflow(
        { workflowId: id, nodes: [noop('a'), { ...noop('b'), compensation: {} }] },
        { tenantId: T },
      ),
    ).rejects.toMatchObject({ code: 'validation_error' });
    // `null` — normalized to `undefined` by the ONE shared validator, so it is
    // byte-identical to omission by the time any merge sees it.
    await persistAuthoredWorkflow(
      { workflowId: id, nodes: [noop('a'), { ...noop('b'), compensation: null }] },
      { tenantId: T },
    );
    expect(
      (await head(id)).nodes.find((n) => n.nodeId === 'b')?.compensation,
      'null reads as omission — resurrected, exactly like omitting it',
    ).toBeDefined();
  });

  it('a two-step decoy cannot drain the carrying set (there is no back door)', async () => {
    // The obvious workaround — "drop it once, then persist again" — never works:
    // the first persist restores it, so the carrying-node count can never reach
    // zero. Stated because it is the first thing a user (or a model) will try.
    const id = 'authored.w8-decoy';
    await persistAuthoredWorkflow(withComp(id), { tenantId: T });
    await persistAuthoredWorkflow(withoutComp(id), { tenantId: T });
    await persistAuthoredWorkflow(withoutComp(id), { tenantId: T });
    expect((await head(id)).nodes.find((n) => n.nodeId === 'b')?.compensation).toBeDefined();
  });

  it('declaring the field CLEARS it — the exit, on the service', async () => {
    const id = 'authored.w8-service-clear';
    await persistAuthoredWorkflow(withComp(id), { tenantId: T });
    await persistAuthoredWorkflow(withoutComp(id), {
      tenantId: T,
      declaredFields: new Set(['compensation'] as const),
    });
    expect(
      (await head(id)).nodes.find((n) => n.nodeId === 'b')?.compensation,
      'a caller that DECLARES it models the field is deleting, not losing',
    ).toBeUndefined();
  });

  it('declaring one field does not stand the guard down for the others', async () => {
    const id = 'authored.w8-narrow';
    await persistAuthoredWorkflow(
      {
        workflowId: id,
        nodes: [
          { ...noop('a'), inputs: { greeting: { type: 'static', value: 'hi' } } },
          { ...noop('b'), compensation: { nodeTypeId: 'core.noop' } },
        ],
        settings: { concurrency: 2 },
      },
      { tenantId: T },
    );
    await persistAuthoredWorkflow(withoutComp(id), {
      tenantId: T,
      declaredFields: new Set(['compensation'] as const),
    });
    const h = await head(id);
    expect(h.nodes.find((n) => n.nodeId === 'b')?.compensation).toBeUndefined();
    expect(h.nodes.find((n) => n.nodeId === 'a')?.inputs, 'inputs were NOT declared ⇒ still protected').toBeDefined();
    expect(h.settings, 'settings were NOT declared ⇒ still protected').toEqual({ concurrency: 2 });
  });

  it('THE REAL ROUTE — the persist agent tool exposes the exit as `clearFields`', async () => {
    // The exit only counts if the population that needs it can REACH it. The
    // builder is header-pinned to three fields by an explicit ratchet, the
    // collab lane has no request to carry a header, and the authoring brain's
    // RESPONSE_SCHEMA cannot express `compensation` at all — so without a
    // parameter ON THIS TOOL the model has no way to say "delete it" and the
    // disclosure's own instruction ("say so explicitly") is unactionable prose.
    const { registerWorkflowAuthorAgentTools } = await import('../src/features/workflow-author/agentTools.js');
    const { createAgentToolProvider } = await import('../src/host/agentToolProvider.js');
    registerWorkflowAuthorAgentTools();
    const provider = createAgentToolProvider({ tenantId: T, actingUserId: 'u-1' });
    const id = 'authored.w8-tool-clear';

    await provider.executeTool({ name: 'openwop:feature.workflow-author.nodes.persist', input: { definition: withComp(id) } });
    expect((await head(id)).nodes.find((n) => n.nodeId === 'b')?.compensation).toBeDefined();

    // Omitting it alone is a LOSS signal — preserved, and disclosed.
    const kept = await provider.executeTool({
      name: 'openwop:feature.workflow-author.nodes.persist',
      input: { definition: withoutComp(id) },
    });
    expect(JSON.parse(kept.content).preservedFields).toContain('compensation');
    expect((await head(id)).nodes.find((n) => n.nodeId === 'b')?.compensation).toBeDefined();

    // Declaring it is a DELETE signal — honoured, and NOT reported as preserved.
    const cleared = await provider.executeTool({
      name: 'openwop:feature.workflow-author.nodes.persist',
      input: { definition: withoutComp(id), clearFields: ['compensation'] },
    });
    expect(cleared.isError).toBeFalsy();
    expect(JSON.parse(cleared.content).preservedFields, 'nothing was preserved — it was cleared')
      .toBeUndefined();
    expect(
      (await head(id)).nodes.find((n) => n.nodeId === 'b')?.compensation,
      'the model CAN delete an inverse action it was asked to remove',
    ).toBeUndefined();
  });

  it('THE OTHER REAL ROUTE — the node-facing surface honours the same declaration', async () => {
    // `ctx.features['workflow-author'].persistDraft` is the in-run door (the
    // `feature.workflow-author.nodes.persist` node calls it). Two doors onto one
    // service must not disagree about how a deletion is expressed — that
    // divergence is how this whole defect class started.
    const { buildWorkflowAuthorSurface } = await import('../src/features/workflow-author/surface.js');
    const surface = buildWorkflowAuthorSurface({ tenantId: T, actingUserId: 'u-1' } as never);
    const id = 'authored.w8-surface-clear';
    await surface.persistDraft?.({ definition: withComp(id) });
    expect((await head(id)).nodes.find((n) => n.nodeId === 'b')?.compensation).toBeDefined();
    const out = await surface.persistDraft?.({ definition: withoutComp(id), clearFields: ['compensation'] });
    expect((out as { preservedFields?: unknown }).preservedFields).toBeUndefined();
    expect((await head(id)).nodes.find((n) => n.nodeId === 'b')?.compensation).toBeUndefined();
  });

  it('the disclosure names the exit by its real parameter (an unactionable instruction is a dead end)', async () => {
    const { registerWorkflowAuthorAgentTools } = await import('../src/features/workflow-author/agentTools.js');
    const { createAgentToolProvider } = await import('../src/host/agentToolProvider.js');
    registerWorkflowAuthorAgentTools();
    const provider = createAgentToolProvider({ tenantId: T, actingUserId: 'u-1' });
    const id = 'authored.w8-note';
    await provider.executeTool({ name: 'openwop:feature.workflow-author.nodes.persist', input: { definition: withComp(id) } });
    const kept = await provider.executeTool({
      name: 'openwop:feature.workflow-author.nodes.persist',
      input: { definition: withoutComp(id) },
    });
    expect(JSON.parse(kept.content).preservedNote, 'the note must name `clearFields`, the only mechanism that works')
      .toMatch(/clearFields/);
  });
});

// ── W9 (ADR 0595 §Correction 3) — the disclosure survives to the SURFACE ────
//
// ADR 0524 §5's "NOT SILENT" ruling is only honoured if the disclosure reaches
// something a person reads. It has to cross FOUR seams — service → surface →
// NODE → agent tool — and the node seam is in a different artifact (a vendored
// pack with a closed `additionalProperties:false` output schema), which is
// exactly why a code comment and an ADR could both claim it was relayed while
// the diff contained zero pack changes. Follow the field, seam by seam.
describe('W9 — `preservedFields` crosses every seam from the merge to the reader', () => {
  const withComp = (id: string): Record<string, unknown> => ({
    workflowId: id,
    nodes: [noop('a'), { ...noop('b'), compensation: { nodeTypeId: 'core.noop' } }],
  });
  const withoutComp = (id: string): Record<string, unknown> => ({
    workflowId: id,
    nodes: [noop('a'), noop('b')],
  });

  it('SEAM 1 — the service returns it', async () => {
    const id = 'authored.w9-service';
    await persistAuthoredWorkflow(withComp(id), { tenantId: T });
    const out = await persistAuthoredWorkflow(withoutComp(id), { tenantId: T });
    expect(out.preservedFields).toContain('compensation');
  });

  it('SEAM 2 — the node-facing surface relays it', async () => {
    const { buildWorkflowAuthorSurface } = await import('../src/features/workflow-author/surface.js');
    const surface = buildWorkflowAuthorSurface({ tenantId: T, actingUserId: 'u-1' } as never);
    const id = 'authored.w9-surface';
    await surface.persistDraft?.({ definition: withComp(id) });
    const out = await surface.persistDraft?.({ definition: withoutComp(id) });
    expect((out as { preservedFields?: string[] }).preservedFields).toContain('compensation');
  });

  it('SEAM 3 — the NODE puts it in its run outputs, and its output schema admits it', async () => {
    // The seam the claims were false about. The node builds its own output
    // object, and `persist.output.schema.json` is `additionalProperties:false`,
    // so relaying the field WITHOUT declaring it would be a contract violation
    // rather than a fix — both halves are asserted here.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const packDir = resolve(process.cwd(), '../../packs/feature.workflow-author.nodes');
    const schema = JSON.parse(readFileSync(resolve(packDir, 'schemas/persist.output.schema.json'), 'utf8'));
    expect(schema.additionalProperties, 'the closed shape is the point — do not open it instead').toBe(false);
    expect(
      Object.keys(schema.properties),
      'a relayed field an `additionalProperties:false` schema does not declare is a contract violation',
    ).toContain('preservedFields');

    const mod = await import(resolve(packDir, 'index.mjs'));
    const { buildWorkflowAuthorSurface } = await import('../src/features/workflow-author/surface.js');
    const surface = buildWorkflowAuthorSurface({ tenantId: T, actingUserId: 'u-1' } as never);
    const runNode = async (definition: unknown): Promise<{ status: string; outputs?: Record<string, unknown> }> =>
      mod.persist({ inputs: { definition }, features: { 'workflow-author': surface } });

    const id = 'authored.w9-node';
    await runNode(withComp(id));
    const out = await runNode(withoutComp(id));
    expect(out.status).toBe('success');
    expect(out.outputs?.preservedFields, 'the node relays the disclosure into the run outputs').toContain('compensation');
  });

  it('SEAM 4 — the agent tool relays it with an instruction the model can act on', async () => {
    const { registerWorkflowAuthorAgentTools } = await import('../src/features/workflow-author/agentTools.js');
    const { createAgentToolProvider } = await import('../src/host/agentToolProvider.js');
    registerWorkflowAuthorAgentTools();
    const provider = createAgentToolProvider({ tenantId: T, actingUserId: 'u-1' });
    const id = 'authored.w9-tool';
    await provider.executeTool({ name: 'openwop:feature.workflow-author.nodes.persist', input: { definition: withComp(id) } });
    const out = await provider.executeTool({
      name: 'openwop:feature.workflow-author.nodes.persist',
      input: { definition: withoutComp(id) },
    });
    const body = JSON.parse(out.content);
    expect(body.preservedFields).toContain('compensation');
    expect(body.preservedNote).toMatch(/clearFields/);
  });

  it('the two field lists a MODEL reads are pinned to the guard\'s own set (no hand-copies)', async () => {
    // `PreservableField` is a TYPE — it vanishes at runtime, so a JSON Schema
    // `enum` and a tool-input `enum` have to be written out, and each copy is a
    // drift site. CLAUDE.md: schema text reaching a model is generated from its
    // SSoT or test-pinned to it. The tool imports the array; the pack's schema
    // is a separate artifact that cannot import, so it is pinned here.
    //
    // Drift in either direction lies to the model: an enum listing a field the
    // guard does not protect invites a `clearFields` token that does nothing,
    // and one MISSING a protected field hides the only exit that field has.
    const { PRESERVABLE_FIELDS } = await import('../src/host/preserveDroppedFields.js');
    const { registerWorkflowAuthorAgentTools } = await import('../src/features/workflow-author/agentTools.js');
    const { createAgentToolProvider } = await import('../src/host/agentToolProvider.js');
    registerWorkflowAuthorAgentTools();
    const def = createAgentToolProvider({ tenantId: T, actingUserId: 'u-1' })
      .resolveTool('openwop:feature.workflow-author.nodes.persist');
    const clearFields = (def?.inputSchema as { properties?: Record<string, { items?: { enum?: string[] } }> })
      ?.properties?.clearFields?.items?.enum;
    expect([...(clearFields ?? [])].sort(), 'the persist tool\'s `clearFields` enum drifted from the guard')
      .toEqual([...PRESERVABLE_FIELDS].sort());

    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const schema = JSON.parse(readFileSync(
      resolve(process.cwd(), '../../packs/feature.workflow-author.nodes/schemas/persist.output.schema.json'),
      'utf8',
    ));
    expect(
      [...(schema.properties.preservedFields.items.enum as string[])].sort(),
      'the pack\'s `preservedFields` enum drifted from the guard',
    ).toEqual([...PRESERVABLE_FIELDS].sort());
  });

  it('a LOSSLESS save discloses nothing (the field is a signal, not decoration)', async () => {
    const id = 'authored.w9-lossless';
    await persistAuthoredWorkflow(withComp(id), { tenantId: T });
    const out = await persistAuthoredWorkflow(withComp(id), { tenantId: T });
    expect(out.preservedFields).toBeUndefined();
  });
});

// ── W7 (WFAWF-8) — teardown reachability, PER LANE ──────────────────────────
describe('W7 — tenant teardown reaches `wfreg:` rows on every lane', () => {
  const DAY = 86_400_000;
  const NOW = Date.parse('2026-08-21T12:00:00.000Z');
  afterEach(() => { delete process.env.OPENWOP_ANON_TENANT_RETENTION_DAYS; });

  it('LANE 1 (account delete) — `purgeTenantOwnedWorkflowDefs` removes the def', async () => {
    const t = 'ws-w7-account';
    const id = 'authored.w7-account';
    await persistAuthoredWorkflow({ workflowId: id, nodes: [noop('a')] }, { tenantId: t });
    await purgeTenantOwnedWorkflowDefs(t, deleteRegisteredWorkflow);
    __clearRegistryCacheForTests();
    expect(await getRegisteredWorkflowAsync(id)).toBeNull();
    expect(await listOwned(t)).toHaveLength(0);
  });

  it('LANE 2 (anon-tenant retention daemon) — the def is reached too', async () => {
    const t = 'anon:w7-daemon';
    const id = 'authored.w7-daemon';
    await persistAuthoredWorkflow({ workflowId: id, nodes: [noop('a')] }, { tenantId: t });
    const r: RunRecord = {
      runId: 'w7-r1', workflowId: id, tenantId: t, status: 'completed',
      inputs: {}, configurable: {}, metadata: {},
      createdAt: new Date(NOW - 90 * DAY).toISOString(), updatedAt: new Date(NOW - 90 * DAY).toISOString(),
    };
    await storage.insertRun(r);
    process.env.OPENWOP_ANON_TENANT_RETENTION_DAYS = '14';
    await pruneAbandonedAnonTenants({ storage }, NOW);
    __clearRegistryCacheForTests();
    expect(
      await getRegisteredWorkflowAsync(id),
      'every workflow an anon tenant authored is otherwise orphaned permanently — `wfreg:` sits outside the hostext walk',
    ).toBeNull();
  });
});
