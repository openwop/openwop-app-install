/**
 * CFP-1 repair — the CAD Modeler's real tools (get-design + render).
 *
 * The exchange contract under test: the model can READ an existing model (+ CAS
 * version) and RENDER through the one normalization gate (the real
 * `feature.cad.nodes.render` node) + closed-world `validateCadDoc` with
 * structured error feedback — all gated exactly like the HTTP editor path
 * (toggle, acting user, org RBAC). Boots the REAL app (the ADR 0308 D2
 * registration seam is what's under test).
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import { CAD_GET_DESIGN_TOOL_ID, CAD_RENDER_TOOL_ID } from '../src/features/cad/agentTools.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createCanvasForTenant, getCanvasForTenant } from '../src/host/canvasSurface.js';
import { createOrg } from '../src/host/accessControlService.js';

const TENANT = 'default';

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  // The org RBAC gate mirrors the HTTP editor path — the sole org auto-resolves
  // and its owner (`u-1`) holds workspace:write.
  await createOrg({ tenantId: TENANT, createdBy: 'u-1', name: 'Acme', ownerSubject: 'u-1' });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const setCad = async (status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault('cad');
  if (d) await saveConfig({ ...d, status }, 'test');
};

function provider(scope: { actingUserId?: string; runId?: string } = {}) {
  return createAgentToolProvider({ tenantId: TENANT, ...scope });
}

const VALID_MODEL = {
  name: 'Bracket',
  units: 'mm',
  solids: [
    { kind: 'box', x: 0, y: 0, z: 0, width: 80, height: 10, depth: 40, color: '#9aa7b4', label: 'base' },
    { kind: 'cylinder', x: 20, y: 10, z: 20, radius: 6, length: 30, color: '#6b7280', label: 'post' },
  ],
};

describe('CFP-1 — the cad agents pack rides the real registered tools', () => {
  const packDir = new URL('../../../packs/feature.cad.agents/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('pack.json', packDir), 'utf8')) as {
    agents: { toolAllowlist: string[] }[];
  };

  it('the allowlist is exactly the two registered tool ids', () => {
    expect([...manifest.agents[0]!.toolAllowlist].sort()).toEqual(
      [CAD_GET_DESIGN_TOOL_ID, CAD_RENDER_TOOL_ID].sort(),
    );
  });

  it('both tools register into the builtin surface', () => {
    const ids = builtinAgentToolIds();
    expect(ids).toContain(CAD_GET_DESIGN_TOOL_ID);
    expect(ids).toContain(CAD_RENDER_TOOL_ID);
  });
});

describe('CFP-1 — cad render tool: gates, repair-loop errors, persistence', () => {
  it('requires a human-initiated turn', async () => {
    const out = await provider().executeTool({ name: CAD_RENDER_TOOL_ID, input: { model: VALID_MODEL } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'acting_user_required' });
  });

  it('fails closed when the toggle is off (structured, not a throw)', async () => {
    await setCad('off');
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: CAD_RENDER_TOOL_ID, input: { model: VALID_MODEL } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'feature_disabled' });
    await setCad('on');
  });

  it('returns a validation error the model can act on (the repair loop)', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({
      name: CAD_RENDER_TOOL_ID,
      input: { model: { solids: [{ kind: 'dodecahedron' }] } },
    });
    expect(out.isError).toBe(true);
    const parsed = JSON.parse(out.content) as { error: string };
    expect(parsed.error).toBe('validation_error');
    expect(JSON.stringify(parsed)).toContain('dodecahedron');
  });

  it('creates a real canvas.cad, normalized through the render node, with provenance', async () => {
    const p = createAgentToolProvider({ tenantId: TENANT, actingUserId: 'u-1', agentProfileId: 'feature.cad.agents.default', runId: 'run-cad-prov' });
    const out = await p.executeTool({ name: CAD_RENDER_TOOL_ID, input: { model: VALID_MODEL } });
    expect(out.isError).toBeFalsy();
    const res = JSON.parse(out.content) as { canvasId: string; url: string; solidCount: number; version: number };
    expect(res.solidCount).toBe(2);
    expect(res.url).toBe(`/cad/${encodeURIComponent(res.canvasId)}`);
    const canvas = await getCanvasForTenant(TENANT, res.canvasId);
    expect(canvas?.canvasTypeId).toBe('canvas.cad');
    expect(canvas?.ownerSubject).toEqual({ kind: 'user', id: 'u-1' });
    const meta = canvas?.metadata as { producedBy?: { kind: string; id: string } } | undefined;
    expect(meta?.producedBy).toEqual({ kind: 'agent', id: 'feature.cad.agents.default' });
  });

  it('is idempotent within a run (retries do not mint duplicate canvases)', async () => {
    const p = provider({ actingUserId: 'u-1', runId: 'run-cad-idem' });
    const a = JSON.parse((await p.executeTool({ name: CAD_RENDER_TOOL_ID, input: { model: VALID_MODEL } })).content) as { canvasId: string };
    const b = JSON.parse((await p.executeTool({ name: CAD_RENDER_TOOL_ID, input: { model: VALID_MODEL } })).content) as { canvasId: string };
    expect(b.canvasId).toBe(a.canvasId);
  });

  it('updates via CAS: stale baseVersion is a structured conflict, fresh one lands a new version', async () => {
    const p = provider({ actingUserId: 'u-1' });
    const created = JSON.parse((await p.executeTool({ name: CAD_RENDER_TOOL_ID, input: { model: VALID_MODEL } })).content) as { canvasId: string; version: number };

    const updated = { ...VALID_MODEL, name: 'Bracket v2' };
    const ok = JSON.parse((await p.executeTool({
      name: CAD_RENDER_TOOL_ID,
      input: { model: updated, canvasId: created.canvasId, baseVersion: created.version },
    })).content) as { canvasId: string; version: number };
    expect(ok.canvasId).toBe(created.canvasId);
    expect(ok.version).toBeGreaterThan(created.version);

    const stale = await p.executeTool({
      name: CAD_RENDER_TOOL_ID,
      input: { model: VALID_MODEL, canvasId: created.canvasId, baseVersion: created.version },
    });
    expect(stale.isError).toBe(true);
    expect(JSON.parse(stale.content)).toMatchObject({ error: 'canvas_version_conflict' });
  });

  it('update without baseVersion is rejected with guidance toward get-design', async () => {
    const p = provider({ actingUserId: 'u-1' });
    const created = JSON.parse((await p.executeTool({ name: CAD_RENDER_TOOL_ID, input: { model: VALID_MODEL } })).content) as { canvasId: string };
    const out = await p.executeTool({ name: CAD_RENDER_TOOL_ID, input: { model: VALID_MODEL, canvasId: created.canvasId } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content).message).toContain('get-design');
  });
});

describe('CFP-1 — cad get-design: the canvas-state read path', () => {
  it('reads the current model + CAS version; cross-type and missing ids are not found', async () => {
    const p = provider({ actingUserId: 'u-1' });
    const created = JSON.parse((await p.executeTool({ name: CAD_RENDER_TOOL_ID, input: { model: VALID_MODEL } })).content) as { canvasId: string };
    const out = await p.executeTool({ name: CAD_GET_DESIGN_TOOL_ID, input: { canvasId: created.canvasId } });
    expect(out.isError).toBeFalsy();
    const res = JSON.parse(out.content) as { version: number; model: { name: string } };
    expect(res.model.name).toBe('Bracket');
    expect(res.version).toBeGreaterThanOrEqual(1);

    const missing = await p.executeTool({ name: CAD_GET_DESIGN_TOOL_ID, input: { canvasId: 'canvas-nope' } });
    expect(missing.isError).toBe(true);
    expect(JSON.parse(missing.content)).toMatchObject({ error: 'not_found' });
  });

  it('fails EMPTY without a human-initiated turn (tenant rows never leak to system runs; the loop is not derailed)', async () => {
    const out = await provider().executeTool({ name: CAD_GET_DESIGN_TOOL_ID, input: { canvasId: 'canvas-x' } });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toEqual({ model: null });
  });

  it('never reads a canvas across tenants (no existence leak)', async () => {
    const foreign = await createCanvasForTenant('other-tenant', {
      canvasTypeId: 'canvas.cad',
      name: 'Foreign',
      initialState: { name: 'Foreign', units: 'mm', solids: [{ kind: 'box', x: 0, y: 0, z: 0, width: 10, height: 10, depth: 10 }] } as never,
    });
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: CAD_GET_DESIGN_TOOL_ID, input: { canvasId: foreign.canvasId } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'not_found' });
  });
});
