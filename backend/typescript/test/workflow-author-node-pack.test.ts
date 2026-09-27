/**
 * ADR 0596 — `packs/feature.workflow-author.nodes/index.mjs` EXECUTION tests
 * (`WFAWF-11`: the entire authoring brain was executed by NO test in the repo,
 * which is exactly how `WFAC-2` / `WFAWF-10` shipped).
 *
 * These drive the real pack functions against the REAL feature surface
 * (`buildWorkflowAuthorSurface` → `workflowAuthorService`), stubbing only
 * `ctx.callAI`. That keeps the closed-world catalog, the shared validator, the
 * ownership layer and the registry honest rather than mocking the thing under
 * test.
 *
 * The headline assertion (`WFAC-2` = `WFAWF-10` = `WFAU-4`): when the model's
 * output cannot be repaired inside `maxAttempts`, `draft` MUST return a TYPED
 * FAILURE. `status:'success'` over a definition the node knows is invalid is the
 * success-with-empty shape CLAUDE.md's AI-exchange contract forbids — and here
 * it was compounded by `parseDefinition` fabricating a `workflowId` onto `{}`,
 * so an empty model response became a plausible-looking workflow object.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { buildWorkflowAuthorSurface } from '../src/features/workflow-author/surface.js';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { getRegisteredWorkflow } from '../src/host/workflowsRegistry.js';

let pack: typeof import('../../../packs/feature.workflow-author.nodes/index.mjs');

const TENANT = 'ws-pack';

beforeAll(async () => {
  ensureNodesRegistered();
  initHostExtPersistence(await openStorage('memory://'));
  pack = await import('../../../packs/feature.workflow-author.nodes/index.mjs');
});
afterAll(() => __resetHostExtPersistence());

/** A run ctx over the REAL workflow-author surface, with a scripted `callAI`. */
function ctxFor(opts: {
  inputs?: Record<string, unknown>;
  replies?: Array<{ content?: string; data?: unknown }>;
  runId?: string;
  tenantId?: string;
}) {
  const surface = buildWorkflowAuthorSurface({
    tenantId: opts.tenantId ?? TENANT,
    actingUserId: 'u-1',
  } as never);
  const replies = opts.replies ?? [];
  const calls: unknown[] = [];
  let i = 0;
  return {
    calls,
    ctx: {
      runId: opts.runId ?? 'run-pack-1',
      inputs: opts.inputs ?? {},
      features: { 'workflow-author': surface },
      callAI: async (req: unknown) => {
        calls.push(req);
        const r = replies[Math.min(i, replies.length - 1)] ?? { content: '' };
        i += 1;
        return r;
      },
    },
  };
}

/** A workflow the live catalog can actually run (`core.noop` is registered). */
const goodDef = (id: string) => ({
  workflowId: id,
  nodes: [{ nodeId: 'n1', typeId: 'core.noop', outputRole: 'primary' }],
});

describe('workflow-author node pack — the pack is loadable and declares its four nodes', () => {
  it('exports exactly the four typeIds the manifest declares', () => {
    expect(Object.keys(pack.nodes).sort()).toEqual([
      'feature.workflow-author.nodes.draft',
      'feature.workflow-author.nodes.get',
      'feature.workflow-author.nodes.persist',
      'feature.workflow-author.nodes.validate',
    ]);
  });
});

describe('WFAC-2 / WFAWF-10 — draft fails TYPED, never success-with-empty', () => {
  it('an INVALID-but-parseable draft after every attempt ⇒ status:failed, carrying the validator errors', async () => {
    const { ctx, calls } = ctxFor({
      inputs: { intent: 'triage inbound leads', maxAttempts: 2 },
      replies: [{ content: '{"nodes":[]}' }],
    });
    const out = await pack.draft(ctx);
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('workflow_author_unrepaired');
    // The validator's own errors must survive into the failure — otherwise the
    // repair feedback the model produced is lost at the door.
    expect(String(out.error?.message)).toMatch(/workflowId/);
    // The repair loop is BOUNDED: exactly `maxAttempts` model calls, no more.
    expect(calls.length).toBe(2);
    // NOT success-with-empty: no definition is presented as an authored result.
    expect(out.outputs).toBeUndefined();
  });

  it('unparseable prose after every attempt ⇒ status:failed, and the model is told WHY', async () => {
    const { ctx, calls } = ctxFor({
      inputs: { intent: 'triage inbound leads', maxAttempts: 2 },
      replies: [{ content: 'I am sorry, I cannot help with that.' }],
    });
    const out = await pack.draft(ctx);
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('workflow_author_unrepaired');
    expect(String(out.error?.message)).toMatch(/not parseable as a JSON object/);
    expect(calls.length).toBe(2);
    // The repair message actually carried the reason back to the model.
    const second = calls[1] as { messages: Array<{ content: string }> };
    expect(second.messages[0]!.content).toMatch(/not parseable as a JSON object/);
    expect(out.outputs).toBeUndefined();
  });

  it('an EMPTY model response does not become a plausible workflow object', async () => {
    const { ctx } = ctxFor({
      inputs: { intent: 'summarize documents', maxAttempts: 1 },
      replies: [{ content: '' }],
    });
    const out = await pack.draft(ctx);
    expect(out.status).toBe('failed');
    expect(out.outputs).toBeUndefined();
  });

  it('a definition the model never gave an id to is NOT given one from the runId', async () => {
    const { ctx } = ctxFor({
      inputs: { intent: 'notify on new lead', maxAttempts: 1 },
      replies: [{ data: { nodes: [{ nodeId: 'n1', typeId: 'core.noop' }] } }],
    });
    const out = await pack.draft(ctx);
    expect(out.status).toBe('failed');
    expect(JSON.stringify(out)).not.toMatch(/run-pack-1/);
  });

  it('a repairable draft succeeds on the SECOND attempt and reports attempts', async () => {
    const { ctx, calls } = ctxFor({
      inputs: { intent: 'noop pipeline', maxAttempts: 3 },
      replies: [
        { content: 'nonsense' },
        { data: goodDef('authored.repaired-1') },
      ],
    });
    const out = await pack.draft(ctx);
    expect(out.status).toBe('success');
    expect(calls.length).toBe(2);
    expect((out.outputs as { attempts: number }).attempts).toBe(2);
    const def = (out.outputs as { definition: Record<string, unknown> }).definition;
    expect(def.workflowId).toBe('authored.repaired-1');
    // Provenance is stamped (WFAU-2 / WFAC-9 read this back).
    expect((def.metadata as { authoring?: Record<string, unknown> }).authoring)
      .toMatchObject({ authoredVia: 'workflow-author', intent: 'noop pipeline', attempts: 2 });
  });

  it('a missing intent is a typed failure before any model call', async () => {
    const { ctx, calls } = ctxFor({ inputs: {} });
    const out = await pack.draft(ctx);
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('intent_required');
    expect(calls.length).toBe(0);
  });
});

describe('workflow-author node pack — validate / persist / get execute for real', () => {
  it('validate fails typed on an out-of-catalog typeId', async () => {
    const { ctx } = ctxFor({
      inputs: { definition: { workflowId: 'authored.bad-pack', nodes: [{ nodeId: 'n1', typeId: 'totally.made.up' }] } },
    });
    const out = await pack.validate(ctx);
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('workflow_invalid');
    expect(String(out.error?.message)).toMatch(/Unknown node typeId/);
  });

  it('persist registers a valid definition through the shared path', async () => {
    const { ctx } = ctxFor({ inputs: { definition: goodDef('authored.pack-persist-1') } });
    const out = await pack.persist(ctx);
    expect(out.status).toBe('success');
    expect((out.outputs as { workflowId: string }).workflowId).toBe('authored.pack-persist-1');
    expect(getRegisteredWorkflow('authored.pack-persist-1')).toBeTruthy();
  });

  it('persist relays a typed refusal rather than throwing out of the node', async () => {
    const { ctx } = ctxFor({ inputs: { definition: { workflowId: 'authored.pack-bad', nodes: [] } } });
    const out = await pack.persist(ctx);
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('validation_error');
  });

  it('get reads back what persist wrote, and misses typed on an unknown id', async () => {
    const { ctx } = ctxFor({ inputs: { definition: goodDef('authored.pack-get-1') } });
    expect((await pack.persist(ctx)).status).toBe('success');

    const read = await pack.get(ctxFor({ inputs: { workflowId: 'authored.pack-get-1' } }).ctx);
    expect(read.status).toBe('success');
    expect((read.outputs as { definition: { workflowId: string } }).definition.workflowId)
      .toBe('authored.pack-get-1');

    const miss = await pack.get(ctxFor({ inputs: { workflowId: 'authored.no-such-id' } }).ctx);
    expect(miss.status).toBe('failed');
    expect(miss.error?.code).toBe('not_found');
  });

  it('every node fails typed when the host does not expose the surface', async () => {
    for (const [typeId, fn] of Object.entries(pack.nodes)) {
      await expect(fn({ inputs: {}, features: {} }), typeId).rejects.toMatchObject({
        code: 'host_capability_missing',
      });
    }
  });
});

describe('WFAWF-9 — acyclicity is enforced on the authoring lane', () => {
  it('validate refuses a CYCLIC graph the model was told is illegal', async () => {
    const cyclic = {
      workflowId: 'authored.cyclic-1',
      nodes: [
        { nodeId: 'a', typeId: 'core.noop' },
        { nodeId: 'b', typeId: 'core.noop' },
        { nodeId: 'c', typeId: 'core.noop' },
      ],
      edges: [
        { edgeId: 'e1', sourceNodeId: 'a', targetNodeId: 'b' },
        { edgeId: 'e2', sourceNodeId: 'b', targetNodeId: 'c' },
        { edgeId: 'e3', sourceNodeId: 'c', targetNodeId: 'a' },
      ],
    };
    const out = await pack.validate(ctxFor({ inputs: { definition: cyclic } }).ctx);
    expect(out.status).toBe('failed');
    expect(String(out.error?.message)).toMatch(/cycle/i);
  });

  it('persist refuses the same cyclic graph — it can never reach durable state', async () => {
    const cyclic = {
      workflowId: 'authored.cyclic-2',
      nodes: [
        { nodeId: 'a', typeId: 'core.noop' },
        { nodeId: 'b', typeId: 'core.noop' },
      ],
      edges: [
        { edgeId: 'e1', sourceNodeId: 'a', targetNodeId: 'b' },
        { edgeId: 'e2', sourceNodeId: 'b', targetNodeId: 'a' },
      ],
    };
    const out = await pack.persist(ctxFor({ inputs: { definition: cyclic } }).ctx);
    expect(out.status).toBe('failed');
    expect(getRegisteredWorkflow('authored.cyclic-2')).toBeFalsy();
  });

  it('a self-loop is a cycle', async () => {
    const out = await pack.validate(ctxFor({
      inputs: {
        definition: {
          workflowId: 'authored.selfloop',
          nodes: [{ nodeId: 'a', typeId: 'core.noop' }],
          edges: [{ edgeId: 'e1', sourceNodeId: 'a', targetNodeId: 'a' }],
        },
      },
    }).ctx);
    expect(out.status).toBe('failed');
    expect(String(out.error?.message)).toMatch(/cycle/i);
  });

  it('a DISCONNECTED but acyclic graph is still accepted (connected != runnable)', async () => {
    const out = await pack.validate(ctxFor({
      inputs: {
        definition: {
          workflowId: 'authored.two-islands',
          nodes: [
            { nodeId: 'a', typeId: 'core.noop' },
            { nodeId: 'b', typeId: 'core.noop' },
          ],
        },
      },
    }).ctx);
    expect(out.status).toBe('success');
  });
});

describe('WFAC-9 / WFAU-2 — provenance is HOST-owned and reaches the surface that reads it', () => {
  it('the CHAT lane (no draft node) still gets provenance — it is stamped at the write choke', async () => {
    const { persistAuthoredWorkflow } = await import('../src/features/workflow-author/workflowAuthorService.js');
    const { getOwned } = await import('../src/host/workflowOwnership.js');
    // A definition with NO `metadata.authoring` at all — exactly what the agent
    // loop's `persist` tool passes, since there is no draft node in that lane.
    await persistAuthoredWorkflow(goodDef('authored.chat-lane-prov'), { tenantId: TENANT });
    const def = getRegisteredWorkflow('authored.chat-lane-prov') as
      { metadata?: { authoring?: { authoredVia?: string } } };
    expect(def.metadata?.authoring?.authoredVia).toBe('workflow-author');
    // …and it is on the ownership row, which is the ONLY thing the scoped list
    // (the dashboard + the `/` picker) projects from.
    const own = await getOwned(TENANT, 'authored.chat-lane-prov') as { authoredVia?: string } | null;
    expect(own?.authoredVia).toBe('workflow-author');
  });

  it('a model cannot FORGE the attribution — the host overwrites authoredVia', async () => {
    const { persistAuthoredWorkflow } = await import('../src/features/workflow-author/workflowAuthorService.js');
    await persistAuthoredWorkflow(
      { ...goodDef('authored.forged-prov'), metadata: { authoring: { authoredVia: 'a-human-definitely', intent: 'x' } } },
      { tenantId: TENANT },
    );
    const def = getRegisteredWorkflow('authored.forged-prov') as
      { metadata?: { authoring?: { authoredVia?: string; intent?: string } } };
    expect(def.metadata?.authoring?.authoredVia).toBe('workflow-author');
    // The descriptive half the RUN knows and the service does not is kept.
    expect(def.metadata?.authoring?.intent).toBe('x');
  });

  it('provenance is STICKY: a later ownership write from another lane cannot erase it', async () => {
    const { persistAuthoredWorkflow } = await import('../src/features/workflow-author/workflowAuthorService.js');
    const { recordOwnership, getOwned } = await import('../src/host/workflowOwnership.js');
    await persistAuthoredWorkflow(goodDef('authored.sticky-prov'), { tenantId: TENANT });
    // The builder's autosave / a revision restore records ownership WITHOUT
    // authoredVia. A machine-authored workflow does not stop being one because
    // a human edited it.
    await recordOwnership(TENANT, 'authored.sticky-prov', { nodeCount: 1, name: 'edited by a human' });
    const own = await getOwned(TENANT, 'authored.sticky-prov') as { authoredVia?: string; name?: string } | null;
    expect(own?.name).toBe('edited by a human');
    expect(own?.authoredVia).toBe('workflow-author');
  });
});
