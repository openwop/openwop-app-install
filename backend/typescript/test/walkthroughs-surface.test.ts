/**
 * Guided-tours workflow surface (ADR 0368 P6d) — `ctx.features.guidedTours`.
 * READ-only + honest: listWalkthroughs (published, tour-tagged, non-transient) and
 * walkthroughProgress (tenant-level). Verifies the projection, the transient/non-tour
 * exclusions, tenant isolation, AND the toggle gate through the real bundle
 * (a guided-tours-OFF tenant gets host_capability_disabled; ON resolves).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { buildWalkthroughsSurface } from '../src/features/walkthroughs/surface.js';
import { putWalkthroughProgress } from '../src/features/walkthroughs/progressStore.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { recordOwnership } from '../src/host/workflowOwnership.js';
import { loadWorkflowChainPacks, defaultWorkflowChainPackRoots, _resetChainRegistryForTest } from '../src/host/workflowChainPackLoader.js';
import { registerWalkthroughWorkflows } from '../src/features/walkthroughs/feature.js';
import { withLifecycle } from '../src/host/workflowLifecycle.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

let server: http.Server;
const tourDef = (id: string, name: string): WorkflowDefinition => ({ workflowId: id, metadata: { name, walkthrough: true }, nodes: [], edges: [] });

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface WalkthroughsOut { walkthroughs: Array<{ walkthroughId: string; name: string }> }
interface ProgressOut { progress: Array<{ walkthroughId: string; status: string; runId: string; updatedAt: string }> }
const as = <T>(v: unknown): T => JSON.parse(JSON.stringify(v));

describe('guided-tours surface (ctx.features.guidedTours) — ADR 0368 P6d', () => {
  it('listWalkthroughs = system chain-backed tours ∪ the caller-tenant OWN tours; other tenants isolated; non-tour/transient excluded', async () => {
    // ADR 0472 P4 — the SYSTEM walkthroughs migrated to chain packs; the surface reads
    // them from the chain-backed registry now (not the deleted builtin field). Register
    // the real pack-backed set + assert a real system walkthrough surfaces.
    _resetChainRegistryForTest();
    loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
    registerWalkthroughWorkflows();
    registerWorkflow(tourDef('p6d.mine.tour', 'My Tour'));                       // caller's own …
    await recordOwnership('t-p6d', 'p6d.mine.tour', { name: 'My Tour', nodeCount: 0 });
    registerWorkflow(tourDef('p6d.foreign.tour', 'Foreign Tour'));              // ANOTHER tenant's — must NOT leak
    await recordOwnership('t-other', 'p6d.foreign.tour', { name: 'Foreign Tour', nodeCount: 0 });
    registerWorkflow({ workflowId: 'p6d.mine.plain', metadata: { name: 'Plain' }, nodes: [], edges: [] }); // owned non-tour
    await recordOwnership('t-p6d', 'p6d.mine.plain', { name: 'Plain', nodeCount: 0 });
    registerWorkflow(withLifecycle(tourDef('p6d.mine.draft', 'Draft'), { transient: true, generatedBy: 'test', archivedAt: undefined }));
    await recordOwnership('t-p6d', 'p6d.mine.draft', { name: 'Draft', nodeCount: 0, transient: true });

    const out = as<WalkthroughsOut>(await buildWalkthroughsSurface({ tenantId: 't-p6d' }).listWalkthroughs({}));
    const ids = out.walkthroughs.map((t) => t.walkthroughId);
    expect(ids).toContain('walkthrough.agents.roster');  // a real chain-backed system tour
    expect(ids).toContain('p6d.mine.tour');             // caller's own
    expect(out.walkthroughs.find((t) => t.walkthroughId === 'walkthrough.agents.roster')?.name).toBe('Agents: meet the roster');
    expect(ids).not.toContain('p6d.foreign.tour');      // OTHER tenant — not leaked (ADR 0163 R1)
    expect(ids).not.toContain('p6d.mine.plain');        // untagged def excluded
    expect(ids).not.toContain('p6d.mine.draft');        // transient draft hidden (ADR 0369)
  });

  it('walkthroughProgress returns the tenant rows projected (no tenantId/key leak) and isolates other tenants', async () => {
    await putWalkthroughProgress({ tenantId: 't-p6d-a', walkthroughId: 'tour.x', status: 'completed', runId: 'run-a', updatedAt: '2026-07-16T00:00:00.000Z' });
    await putWalkthroughProgress({ tenantId: 't-p6d-b', walkthroughId: 'tour.y', status: 'started', runId: 'run-b', updatedAt: '2026-07-16T00:00:00.000Z' });

    const out = as<ProgressOut>(await buildWalkthroughsSurface({ tenantId: 't-p6d-a' }).walkthroughProgress({}));
    expect(out.progress).toEqual([{ walkthroughId: 'tour.x', status: 'completed', runId: 'run-a', updatedAt: '2026-07-16T00:00:00.000Z' }]);
    expect(JSON.stringify(out)).not.toContain('t-p6d-a'); // tenantId not leaked in the projection
  });

  it('walkthroughProgress sees the caller-user rows when the run carries actingUserId (grade-pass)', async () => {
    await putWalkthroughProgress({ tenantId: 't-p6d-u', userId: 'user:alice', walkthroughId: 'tour.u', status: 'completed', runId: 'r-u', updatedAt: '2026-07-17T00:00:00.000Z' });
    // With the acting user: the per-user row is visible.
    const withUser = as<ProgressOut>(await buildWalkthroughsSurface({ tenantId: 't-p6d-u', actingUserId: 'user:alice' }).walkthroughProgress({}));
    expect(withUser.progress).toEqual([expect.objectContaining({ walkthroughId: 'tour.u', status: 'completed' })]);
    // System runs (no actingUserId) get the legacy tenant-level view only.
    const noUser = as<ProgressOut>(await buildWalkthroughsSurface({ tenantId: 't-p6d-u' }).walkthroughProgress({}));
    expect(noUser.progress).toEqual([]);
  });

  it('the surface is toggle-gated through the real bundle: OFF ⇒ host_capability_disabled, ON ⇒ resolves', async () => {
    const bundleFor = () => buildHostSurfaceBundle({ tenantId: 't-p6d-gate' }).features['walkthroughs'] as Record<string, (a: Record<string, unknown>) => Promise<unknown>>;
    const codeOf = async (fn: () => Promise<unknown>): Promise<string | undefined> => {
      try { await fn(); return undefined; } catch (err) { return (err as { code?: string }).code; }
    };
    // Default OFF (guided-tours ships status:'off') — both methods refuse uniformly.
    const off = bundleFor();
    expect(await codeOf(() => off.listWalkthroughs!({}))).toBe('host_capability_disabled');
    expect(await codeOf(() => off.walkthroughProgress!({}))).toBe('host_capability_disabled');

    // Enable for the tenant — the surface resolves (no gate denial).
    const d = getToggleDefault('walkthroughs');
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
    const on = bundleFor();
    expect(await codeOf(() => on.listWalkthroughs!({}))).toBeUndefined();
    expect(await codeOf(() => on.walkthroughProgress!({}))).toBeUndefined();
  });
});
