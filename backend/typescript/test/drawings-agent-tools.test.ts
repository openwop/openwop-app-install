/**
 * CFP-1 repair — the Illustrator's real tools (get-design + render).
 *
 * The exchange contract under test: the model can READ an existing drawing (+ CAS
 * version) and RENDER through the one normalization gate (the real
 * `feature.drawings.nodes.render` node) + closed-world `validateDrawingDoc` with
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
import { DRAWINGS_GET_DESIGN_TOOL_ID, DRAWINGS_RENDER_TOOL_ID } from '../src/features/drawings/agentTools.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createCanvasForTenant, getCanvasForTenant } from '../src/host/canvasSurface.js';
import { createOrg, createMember, listOrgs } from '../src/host/accessControlService.js';
import { MAX_SHAPES, MAX_POINTS } from '../src/features/drawings/validateDrawingDoc.js';

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

const setDrawings = async (status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault('drawings');
  if (d) await saveConfig({ ...d, status }, 'test');
};

function provider(scope: { actingUserId?: string; runId?: string } = {}) {
  return createAgentToolProvider({ tenantId: TENANT, ...scope });
}

const VALID_DRAWING = {
  title: 'House',
  width: 400,
  height: 300,
  shapes: [
    { kind: 'rect', x: 120, y: 150, width: 160, height: 120, fill: '#e8d6b3', stroke: '#7a5c2e', strokeWidth: 2 },
    { kind: 'circle', cx: 200, cy: 60, r: 18, fill: '#f4c542' },
  ],
};

describe('CFP-1 — the drawings agents pack rides the real registered tools', () => {
  const packDir = new URL('../../../packs/feature.drawings.agents/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('pack.json', packDir), 'utf8')) as {
    agents: { toolAllowlist: string[] }[];
  };

  it('the allowlist is exactly the two registered tool ids', () => {
    expect([...manifest.agents[0]!.toolAllowlist].sort()).toEqual(
      [DRAWINGS_GET_DESIGN_TOOL_ID, DRAWINGS_RENDER_TOOL_ID].sort(),
    );
  });

  it('both tools register into the builtin surface', () => {
    const ids = builtinAgentToolIds();
    expect(ids).toContain(DRAWINGS_GET_DESIGN_TOOL_ID);
    expect(ids).toContain(DRAWINGS_RENDER_TOOL_ID);
  });
});

describe('CFP-1 — drawings render tool: gates, repair-loop errors, persistence', () => {
  it('requires a human-initiated turn', async () => {
    const out = await provider().executeTool({ name: DRAWINGS_RENDER_TOOL_ID, input: { drawing: VALID_DRAWING } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'acting_user_required' });
  });

  it('fails closed when the toggle is off (structured, not a throw)', async () => {
    await setDrawings('off');
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: DRAWINGS_RENDER_TOOL_ID, input: { drawing: VALID_DRAWING } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'feature_disabled' });
    await setDrawings('on');
  });

  it('returns a validation error the model can act on (the repair loop)', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({
      name: DRAWINGS_RENDER_TOOL_ID,
      input: { drawing: { shapes: [{ kind: 'hologram' }] } },
    });
    expect(out.isError).toBe(true);
    const parsed = JSON.parse(out.content) as { error: string };
    expect(parsed.error).toBe('validation_error');
    expect(JSON.stringify(parsed)).toContain('hologram');
  });

  it('creates a real canvas.drawing, normalized through the render node, with provenance', async () => {
    const p = createAgentToolProvider({ tenantId: TENANT, actingUserId: 'u-1', agentProfileId: 'feature.drawings.agents.default', runId: 'run-draw-prov' });
    const out = await p.executeTool({ name: DRAWINGS_RENDER_TOOL_ID, input: { drawing: VALID_DRAWING } });
    expect(out.isError).toBeFalsy();
    const res = JSON.parse(out.content) as { canvasId: string; url: string; shapeCount: number; version: number };
    expect(res.shapeCount).toBe(2);
    expect(res.url).toBe(`/drawings/${encodeURIComponent(res.canvasId)}`);
    const canvas = await getCanvasForTenant(TENANT, res.canvasId);
    expect(canvas?.canvasTypeId).toBe('canvas.drawing');
    expect(canvas?.ownerSubject).toEqual({ kind: 'user', id: 'u-1' });
    const meta = canvas?.metadata as { producedBy?: { kind: string; id: string } } | undefined;
    expect(meta?.producedBy).toEqual({ kind: 'agent', id: 'feature.drawings.agents.default' });
  });

  it('is idempotent within a run (retries do not mint duplicate canvases)', async () => {
    const p = provider({ actingUserId: 'u-1', runId: 'run-draw-idem' });
    const a = JSON.parse((await p.executeTool({ name: DRAWINGS_RENDER_TOOL_ID, input: { drawing: VALID_DRAWING } })).content) as { canvasId: string };
    const b = JSON.parse((await p.executeTool({ name: DRAWINGS_RENDER_TOOL_ID, input: { drawing: VALID_DRAWING } })).content) as { canvasId: string };
    expect(b.canvasId).toBe(a.canvasId);
  });

  it('updates via CAS: stale baseVersion is a structured conflict, fresh one lands a new version', async () => {
    const p = provider({ actingUserId: 'u-1' });
    const created = JSON.parse((await p.executeTool({ name: DRAWINGS_RENDER_TOOL_ID, input: { drawing: VALID_DRAWING } })).content) as { canvasId: string; version: number };

    const updated = { ...VALID_DRAWING, title: 'House v2' };
    const ok = JSON.parse((await p.executeTool({
      name: DRAWINGS_RENDER_TOOL_ID,
      input: { drawing: updated, canvasId: created.canvasId, baseVersion: created.version },
    })).content) as { canvasId: string; version: number };
    expect(ok.canvasId).toBe(created.canvasId);
    expect(ok.version).toBeGreaterThan(created.version);

    const stale = await p.executeTool({
      name: DRAWINGS_RENDER_TOOL_ID,
      input: { drawing: VALID_DRAWING, canvasId: created.canvasId, baseVersion: created.version },
    });
    expect(stale.isError).toBe(true);
    expect(JSON.parse(stale.content)).toMatchObject({ error: 'canvas_version_conflict' });
  });

  it('update without baseVersion is rejected with guidance toward get-design', async () => {
    const p = provider({ actingUserId: 'u-1' });
    const created = JSON.parse((await p.executeTool({ name: DRAWINGS_RENDER_TOOL_ID, input: { drawing: VALID_DRAWING } })).content) as { canvasId: string };
    const out = await p.executeTool({ name: DRAWINGS_RENDER_TOOL_ID, input: { drawing: VALID_DRAWING, canvasId: created.canvasId } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content).message).toContain('get-design');
  });
});

describe('CFP-1 — drawings get-design: the canvas-state read path', () => {
  it('reads the current drawing + CAS version; cross-type and missing ids are not found', async () => {
    const p = provider({ actingUserId: 'u-1' });
    const created = JSON.parse((await p.executeTool({ name: DRAWINGS_RENDER_TOOL_ID, input: { drawing: VALID_DRAWING } })).content) as { canvasId: string };
    const out = await p.executeTool({ name: DRAWINGS_GET_DESIGN_TOOL_ID, input: { canvasId: created.canvasId } });
    expect(out.isError).toBeFalsy();
    const res = JSON.parse(out.content) as { version: number; drawing: { title: string } };
    expect(res.drawing.title).toBe('House');
    expect(res.version).toBeGreaterThanOrEqual(1);

    const missing = await p.executeTool({ name: DRAWINGS_GET_DESIGN_TOOL_ID, input: { canvasId: 'canvas-nope' } });
    expect(missing.isError).toBe(true);
    expect(JSON.parse(missing.content)).toMatchObject({ error: 'not_found' });
  });

  it('fails EMPTY without a human-initiated turn (tenant rows never leak to system runs; the loop is not derailed)', async () => {
    const out = await provider().executeTool({ name: DRAWINGS_GET_DESIGN_TOOL_ID, input: { canvasId: 'canvas-x' } });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toEqual({ drawing: null });
  });

  it('never reads a canvas across tenants (no existence leak)', async () => {
    const foreign = await createCanvasForTenant('other-tenant', {
      canvasTypeId: 'canvas.drawing',
      name: 'Foreign',
      initialState: { title: 'Foreign', shapes: [{ kind: 'rect', x: 0, y: 0, width: 10, height: 10 }] } as never,
    });
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: DRAWINGS_GET_DESIGN_TOOL_ID, input: { canvasId: foreign.canvasId } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'not_found' });
  });
});

describe('DRC-3 — org RBAC forbidden_scope: the write door closes while the read door stays open', () => {
  // Every OTHER test in this file runs as the org OWNER (`u-1`, full scope), so
  // resolveOrgScope's `access.scopes.includes(needed) === false` branch
  // (agentTools.ts:74-76) — the org-RBAC gate — was never exercised. A `viewer`
  // member holds `workspace:read` but NOT `workspace:write`, so the SAME principal
  // is granted the read tool and refused the write tool: the sharpest witness that
  // the two tools gate on DIFFERENT scopes, mirroring the HTTP editor path.
  //
  // Deliberately uses a real member row (deterministic viewer scopes) rather than a
  // non-member: the non-member path forks on the demo-mode owner bypass (LEAK-9,
  // accessControlService.ts:1272-1287), which is env-dependent and would flake.
  let drawingId: string;
  beforeAll(async () => {
    await setDrawings('on');
    const [org] = await listOrgs(TENANT);
    await createMember({ tenantId: TENANT, orgId: org!.orgId, subject: 'u-viewer', displayName: 'Vera Viewer', roles: ['viewer'] });
    // A real drawing (authored by the owner) for the read-allowed assertion.
    const created = JSON.parse(
      (await provider({ actingUserId: 'u-1' }).executeTool({ name: DRAWINGS_RENDER_TOOL_ID, input: { drawing: VALID_DRAWING } })).content,
    ) as { canvasId: string };
    drawingId = created.canvasId;
  });

  it('render (workspace:write) is refused for a viewer — structured forbidden_scope, not a throw', async () => {
    const out = await provider({ actingUserId: 'u-viewer' }).executeTool({ name: DRAWINGS_RENDER_TOOL_ID, input: { drawing: VALID_DRAWING } });
    expect(out.isError).toBe(true);
    const parsed = JSON.parse(out.content) as { error: string; message: string };
    expect(parsed.error).toBe('forbidden_scope');
    expect(parsed.message).toContain('write');
  });

  it('get-design (workspace:read) is ALLOWED for that same viewer — the two doors gate on different scopes', async () => {
    const out = await provider({ actingUserId: 'u-viewer' }).executeTool({ name: DRAWINGS_GET_DESIGN_TOOL_ID, input: { canvasId: drawingId } });
    expect(out.isError).toBeFalsy();
    const res = JSON.parse(out.content) as { drawing: { title: string } | null };
    expect(res.drawing?.title).toBe('House');
  });
});

describe('DRC-2 — the render producer node mirrors the SSoT drawing caps (ADR 0333 Phase 3)', () => {
  // The `feature.drawings.nodes.render` node is the ONE normalization gate the
  // render tool AND the workflow chain both run through. ADR 0333 Phase 3 raised
  // the caps in the SSoT (`artifactTypes.ts` schema + `validateDrawingDoc.ts`):
  // shapes 500→2000, polyline/polygon points 200→600. The node pack was left at
  // the pre-migration values, so it was STRICTER than the SSoT the REST editor
  // honours — a cross-door inconsistency (and the points case silently truncated).
  //
  // These are a PARITY RATCHET, not a spelling check: they drive the node with the
  // imported SSoT constants (MAX_SHAPES/MAX_POINTS), so a FUTURE SSoT bump that is
  // not mirrored into the `.mjs` node re-reddens here (the node cannot import the
  // TS constant, so the test is the only thing that binds the two). Exercised
  // through the REAL dispatch path (tool → registry → ADR 0555 attestation →
  // node), so the pack must be dispatchable — this also witnesses that the steward
  // manifest was regenerated for the pack edit (a stale digest fails the render).
  const rect = () => ({ kind: 'rect', x: 0, y: 0, width: 1, height: 1 });

  it('accepts a drawing at the SSoT shape cap (MAX_SHAPES) — not the stale pre-migration 500', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({
      name: DRAWINGS_RENDER_TOOL_ID,
      input: { drawing: { title: 'Dense', shapes: Array.from({ length: MAX_SHAPES }, rect) } },
    });
    expect(out.isError).toBeFalsy();
    expect((JSON.parse(out.content) as { shapeCount: number }).shapeCount).toBe(MAX_SHAPES);
  });

  it('rejects a drawing ABOVE the SSoT shape cap (MAX_SHAPES + 1), naming the current cap', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({
      name: DRAWINGS_RENDER_TOOL_ID,
      input: { drawing: { shapes: Array.from({ length: MAX_SHAPES + 1 }, rect) } },
    });
    expect(out.isError).toBe(true);
    expect(JSON.stringify(JSON.parse(out.content))).toContain(`${MAX_SHAPES} shapes`);
  });

  it('preserves a MAX_POINTS-point polyline — the SSoT points cap, NOT silently truncated to 200', async () => {
    const points = Array.from({ length: MAX_POINTS }, (_, i) => ({ x: i, y: i }));
    const res = JSON.parse((await provider({ actingUserId: 'u-1' }).executeTool({
      name: DRAWINGS_RENDER_TOOL_ID,
      input: { drawing: { title: 'Long polyline', shapes: [{ kind: 'polyline', points }] } },
    })).content) as { canvasId: string };
    const canvas = await getCanvasForTenant(TENANT, res.canvasId);
    const state = canvas?.state as { shapes: { points?: unknown[] }[] };
    expect(state.shapes[0]!.points).toHaveLength(MAX_POINTS);
  });
});
