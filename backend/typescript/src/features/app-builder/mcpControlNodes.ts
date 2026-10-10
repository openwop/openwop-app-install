/**
 * ADR 0393 Lane B — the MCP control lane's backing nodes (in-tree thin
 * adapters, the ADR 0368 `ui.walkthrough.*` registration precedent). Each node
 * is a few lines over an EXISTING owner — `canvasSurface` reads/creates,
 * `renderCore.renderDesign` (the ONE pipeline the ADR 0358 chat tool shares),
 * the component-catalog projection, the ADR 0345 share projection, and the
 * interrupts `resolveAndResume` service. No handler logic is duplicated.
 *
 * Trust posture: these execute inside an MCP-mount run (`trustBoundary:
 * 'untrusted'`, tenant from the caller's principal — ADR 0087). Each node
 * re-checks the `app-builder` toggle per-tenant (fail-closed, the agent-tool
 * convention) even though the registry gate already filters listing/calling.
 *
 * `resolve-paused-task` is deliberately NARROW: it resolves ONLY interrupts
 * raised by this tenant's app-builder design/repair chain runs (the v0
 * "resolve YOUR paused build" semantic). It can never touch another
 * workflow's approvals — that would let an untrusted MCP client answer org
 * HITL gates.
 */
import { getNodeRegistry } from '../../executor/nodeRegistry.js';
import type { NodeContext, NodeOutcome } from '../../executor/types.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { createCanvasForTenant, getCanvasForCaller, listCanvasesForCaller } from '../../host/canvasSurface.js';
import type { Storage } from '../../storage/storage.js';
import type { HostAdapterSuite } from '../../host/index.js';
import { resolveAndResume } from '../../routes/interrupts.js';
import { OpenwopError } from '../../types.js';
import { APP_BUILDER_CANVAS_TYPE, projectComponentCatalog, catalogTypeListForPrompt } from './componentCatalog.js';
import { projectAppForShare } from './shareProjection.js';
import { renderDesign } from './renderCore.js';
import { APP_BUILDER_DESIGN_WORKFLOW_ID, APP_BUILDER_REPAIR_WORKFLOW_ID } from './designWorkflow.js';
import { assertTenantScope } from '../../host/accessControlService.js';
import { isPersonalTenantId } from '../../host/requestSubject.js';

/**
 * ADR 0835 D4 — the gates `resolve-paused-task` may answer, per chain: the
 * chain's OWN human gates, by node id. A run started from the gallery is a
 * template copy with a minted workflow id (so matching `run.workflowId` refused
 * every real run), and a copy is builder-editable (so matching the chain alone
 * would admit any gate a member added to it). Expansion prefixes every node id
 * `<chainId with _>_<12 hex>_`; a bare id is the un-expanded shape.
 */
const MCP_RESOLVABLE_GATES: Readonly<Record<string, readonly string[]>> = {
  [APP_BUILDER_DESIGN_WORKFLOW_ID]: ['clarify', 'review'],
  [APP_BUILDER_REPAIR_WORKFLOW_ID]: ['review'],
};

function isChainGate(chainId: string, nodeId: string): boolean {
  const gates = MCP_RESOLVABLE_GATES[chainId] ?? [];
  const prefix = `${chainId.replace(/\./g, '_')}_`;
  return gates.some((g) => nodeId === g || (nodeId.startsWith(prefix) && new RegExp(`^${prefix}[0-9a-f]{12}_${g}$`).test(nodeId)));
}

export const MCP_NODE_PREFIX = 'app-builder.mcp-node.';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

function fail(code: string, message: string): NodeOutcome {
  return { status: 'failure', error: { code, message } };
}

async function toggleGate(tenantId: string): Promise<NodeOutcome | null> {
  const assignment = await resolveOne('app-builder', { tenantId }).catch(() => null);
  if (!assignment?.enabled) return fail('feature_disabled', 'The App Builder feature is not enabled for this workspace.');
  return null;
}

const inputsOf = (ctx: NodeContext): Record<string, unknown> =>
  (ctx.inputs && typeof ctx.inputs === 'object' ? ctx.inputs : {}) as Record<string, unknown>;

type Exec = (ctx: NodeContext) => Promise<NodeOutcome>;

/** `sideEffecting` (ADR 0341) on the WRITE nodes: a replay-mode fork
 *  reproduces the recorded outcome instead of re-creating/re-writing. */
function node(id: string, execute: Exec, opts?: { sideEffecting?: boolean }): { typeId: string; version: string; sideEffecting?: boolean; execute: Exec } {
  return { typeId: `${MCP_NODE_PREFIX}${id}`, version: '1.0.0', ...(opts?.sideEffecting ? { sideEffecting: true } : {}), execute };
}

export function registerAppBuilderMcpNodes(deps: { storage: Storage; hostSuite: HostAdapterSuite }): void {
  const registry = getNodeRegistry();

  // create-project — a blank draft canvas (the editor `blankState` shape:
  // one Home screen, exactly one `isInitial`). Tenant-owned; provenance
  // records the MCP client (no human session exists on this lane).
  registry.register(node('create-project', async (ctx) => {
    const gated = await toggleGate(ctx.tenantId);
    if (gated) return gated;
    const name = str(inputsOf(ctx).name) ?? 'Untitled app';
    const created = await createCanvasForTenant(ctx.tenantId, {
      canvasTypeId: APP_BUILDER_CANVAS_TYPE,
      name,
      initialState: { name, screens: [{ id: 'home', name: 'Home', isInitial: true, components: [] }] } as never,
      metadata: { producedBy: { kind: 'mcp-client' }, runId: ctx.runId },
    });
    return { status: 'success', outputs: { canvasId: created.canvasId, version: created.version, url: `/app-builder/${encodeURIComponent(created.canvasId)}` } };
  }, { sideEffecting: true }));

  // open-project — with `canvasId`: one project's handle (id + version, the
  // CAS basis); without: the tenant's app-builder project list.
  registry.register(node('open-project', async (ctx) => {
    const gated = await toggleGate(ctx.tenantId);
    if (gated) return gated;
    const canvasId = str(inputsOf(ctx).canvasId);
    if (!canvasId) {
      const all = await listCanvasesForCaller(ctx.tenantId, { subject: ctx.actingUserId });
      const projects = all
        .filter((c) => c.canvasTypeId === APP_BUILDER_CANVAS_TYPE)
        .map((c) => ({ canvasId: c.canvasId, name: c.name, version: c.version, url: `/app-builder/${encodeURIComponent(c.canvasId)}` }));
      return { status: 'success', outputs: { projects } };
    }
    const canvas = await getCanvasForCaller(ctx.tenantId, canvasId, { subject: ctx.actingUserId });
    if (!canvas || canvas.canvasTypeId !== APP_BUILDER_CANVAS_TYPE) return fail('not_found', `App Builder canvas '${canvasId}' not found in this workspace.`);
    return { status: 'success', outputs: { canvasId, name: canvas.name, version: canvas.version, url: `/app-builder/${encodeURIComponent(canvasId)}` } };
  }));

  // get-design — the full app JSON + version (the ADR 0358 read-before-write).
  registry.register(node('get-design', async (ctx) => {
    const gated = await toggleGate(ctx.tenantId);
    if (gated) return gated;
    const canvasId = str(inputsOf(ctx).canvasId);
    if (!canvasId) return fail('validation_error', '`canvasId` is required.');
    const canvas = await getCanvasForCaller(ctx.tenantId, canvasId, { subject: ctx.actingUserId });
    if (!canvas || canvas.canvasTypeId !== APP_BUILDER_CANVAS_TYPE) return fail('not_found', `App Builder canvas '${canvasId}' not found in this workspace.`);
    return { status: 'success', outputs: { canvasId, version: canvas.version, app: canvas.state } };
  }));

  // catalog — the closed component catalog, generated LIVE from the SSoT
  // (never a hand-copied list; the parity-tested projection).
  registry.register(node('catalog', async (ctx) => {
    const gated = await toggleGate(ctx.tenantId);
    if (gated) return gated;
    return { status: 'success', outputs: { ...projectComponentCatalog(), promptTypeList: catalogTypeListForPrompt() } };
  }));

  // render-design — the ONE normalize → validate → CAS pipeline (renderCore,
  // shared verbatim with the chat tool). Validation errors come back as a
  // typed failure the MCP client can react to (the repair loop).
  registry.register(node('render-design', async (ctx) => {
    const gated = await toggleGate(ctx.tenantId);
    if (gated) return gated;
    const inputs = inputsOf(ctx);
    const baseVersionRaw = inputs.baseVersion;
    const result = await renderDesign(ctx.tenantId, {
      app: inputs.app,
      canvasId: str(inputs.canvasId),
      ...(baseVersionRaw !== undefined ? { baseVersion: Number(baseVersionRaw) } : {}),
      producedBy: { kind: 'mcp-client' },
      runId: ctx.runId,
      ...(ctx.actingUserId ? { actingUserId: ctx.actingUserId } : {}),
    });
    if (!result.ok) return fail(result.error, `${result.message}${result.extra ? ` ${JSON.stringify(result.extra)}` : ''}`);
    return { status: 'success', outputs: { canvasId: result.canvasId, version: result.version, screenCount: result.screenCount, url: result.url, created: result.created } };
  }, { sideEffecting: true }));

  // get-preview-url — the ADR 0345 SANITIZED share projection (name/screens
  // summary, secrets/state stripped) + the deep-link URLs. Read-only.
  registry.register(node('get-preview-url', async (ctx) => {
    const gated = await toggleGate(ctx.tenantId);
    if (gated) return gated;
    const canvasId = str(inputsOf(ctx).canvasId);
    if (!canvasId) return fail('validation_error', '`canvasId` is required.');
    const canvas = await getCanvasForCaller(ctx.tenantId, canvasId, { subject: ctx.actingUserId });
    if (!canvas || canvas.canvasTypeId !== APP_BUILDER_CANVAS_TYPE) return fail('not_found', `App Builder canvas '${canvasId}' not found in this workspace.`);
    const projected = projectAppForShare((canvas.state ?? {}) as Record<string, unknown>);
    return {
      status: 'success',
      outputs: {
        canvasId,
        version: canvas.version,
        url: `/app-builder/${encodeURIComponent(canvasId)}`,
        previewUrl: `/app-builder/${encodeURIComponent(canvasId)}/preview`,
        app: projected,
      },
    };
  }));

  // resolve-paused-task — NARROW by construction: only THIS tenant's
  // app-builder design/repair chain interrupts (v0's resolve-paused-task
  // semantic — an external agent answering its own build's review question).
  registry.register(node('resolve-paused-task', async (ctx) => {
    const gated = await toggleGate(ctx.tenantId);
    if (gated) return gated;
    const inputs = inputsOf(ctx);
    const interruptId = str(inputs.interruptId);
    if (!interruptId) return fail('validation_error', '`interruptId` is required.');
    const interrupt = await deps.storage.getInterrupt(interruptId);
    if (!interrupt) return fail('not_found', `Interrupt '${interruptId}' not found.`);
    const run = await deps.storage.getRun(interrupt.runId);
    // Tenant + workflow allowlist, fail-closed: never resolve another
    // tenant's interrupt, never a non-app-builder workflow's HITL gate.
    if (!run || run.tenantId !== ctx.tenantId) return fail('not_found', `Interrupt '${interruptId}' not found.`);
    // Lazy: the dispatcher + launch resolver sit above the feature registry.
    const chainId = MCP_RESOLVABLE_GATES[run.workflowId] ? run.workflowId : await (async () => {
      const [{ resolveTenantWorkflow }, { chainIdOfDefinition }] = await Promise.all([import('../../host/resolveLaunchDefinition.js'), import('../../host/hostEventDispatcher.js')]);
      return chainIdOfDefinition((await resolveTenantWorkflow(deps.hostSuite.workflowCatalog, run.tenantId, run.workflowId).catch(() => null))?.definition);
    })();
    if (!chainId || !isChainGate(chainId, interrupt.nodeId)) {
      return fail('forbidden', 'Only the app-builder design and repair chains\' own review gates can be resolved over MCP.');
    }
    // ADR 0835 D4 — WHO answers. The run's principal is the MCP caller; with no
    // reviewer the resolve took the token lane, which on an open single-approver
    // gate (the repair review is one) consults no scope at all — so any MCP
    // client could approve a repair that then wrote the canvas, attributed to
    // nobody. `approvals:respond` is checked here because the eligibility
    // helpers skip it on open gates; the subject rides as the reviewer.
    const reviewer = ctx.actingUserId;
    if (!reviewer) return fail('forbidden', 'Resolving a review needs an identified caller.');
    try {
      await assertTenantScope(run.tenantId, reviewer, 'approvals:respond', isPersonalTenantId(run.tenantId) ? { personalTenant: run.tenantId } : {});
    } catch {
      return fail('forbidden', 'Your role in this workspace cannot answer reviews (approvals:respond).');
    }
    if (inputs.value === undefined) return fail('validation_error', '`value` is required — the answer to the paused question or review (e.g. { action: "approve" }).');
    try {
      await resolveAndResume(deps.storage, deps.hostSuite, interruptId, inputs.value, { subjectRef: reviewer });
    } catch (err) {
      // ADR 0778 C1 — lost to a concurrent resolve: a typed conflict, not a crash.
      if (err instanceof OpenwopError && err.httpStatus === 409) return fail('conflict', `Interrupt '${interruptId}' was already resolved.`);
      throw err;
    }
    return { status: 'success', outputs: { interruptId, runId: interrupt.runId, resolved: true } };
  }, { sideEffecting: true }));
}
