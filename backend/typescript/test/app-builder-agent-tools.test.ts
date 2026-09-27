/**
 * ADR 0358 Phase B — the App Architect's real tools.
 *
 * The exchange contract under test: the model can REQUEST the catalog, READ an
 * existing design (+ CAS version), and RENDER through the one normalization
 * gate + closed-world validation with structured error feedback — all gated
 * exactly like the HTTP editor path (toggle, acting user, org RBAC).
 * Boots the REAL app (the ADR 0308 D2 registration seam is what's under test).
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import {
  APP_BUILDER_CATALOG_TOOL_ID,
  APP_BUILDER_GET_DESIGN_TOOL_ID,
  APP_BUILDER_RENDER_TOOL_ID,
} from '../src/features/app-builder/agentTools.js';
import { APP_BUILDER_COMPONENTS, catalogTypeListForPrompt } from '../src/features/app-builder/componentCatalog.js';
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

const setAppBuilder = async (status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault('app-builder');
  if (d) await saveConfig({ ...d, status }, 'test');
};

function provider(scope: { actingUserId?: string; runId?: string } = {}) {
  return createAgentToolProvider({ tenantId: TENANT, ...scope });
}

const VALID_APP = {
  name: 'Test App',
  screens: [
    { id: 'home', name: 'Home', isInitial: true, components: [
      { type: 'stack', props: { gap: 'md' }, children: [
        { type: 'heading', props: { text: 'Hi', level: '1' } },
        { type: 'button', props: { label: 'Go', variant: 'primary' } },
      ] },
    ] },
  ],
};

describe('ADR 0358 Phase C — the agents pack rides the real tools (no hand-copied catalog)', () => {
  const packDir = new URL('../../../packs/feature.app-builder.agents/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('pack.json', packDir), 'utf8')) as {
    agents: { toolAllowlist: string[]; systemPromptRef: string }[];
  };
  const prompt = readFileSync(new URL(manifest.agents[0]!.systemPromptRef, packDir), 'utf8');

  it('the allowlist is exactly the three registered tool ids', () => {
    expect([...manifest.agents[0]!.toolAllowlist].sort()).toEqual(
      [APP_BUILDER_RENDER_TOOL_ID, APP_BUILDER_CATALOG_TOOL_ID, APP_BUILDER_GET_DESIGN_TOOL_ID].sort(),
    );
  });

  it('the prompt teaches the error-feedback protocol (repair loop)', () => {
    // (Catalog-ABSENCE tripwires live beside the catalog:
    // src/features/app-builder/__tests__/catalogParity.test.ts.)
    expect(prompt).toContain('catalog_validation_failed');
    expect(prompt).toContain('canvas_version_conflict');
    expect(prompt).toContain('baseVersion');
  });
});

describe('ADR 0358 — registration + the schema-request path', () => {
  it('all three tools register into the builtin surface', () => {
    const ids = builtinAgentToolIds();
    for (const id of [APP_BUILDER_RENDER_TOOL_ID, APP_BUILDER_CATALOG_TOOL_ID, APP_BUILDER_GET_DESIGN_TOOL_ID]) {
      expect(ids).toContain(id);
    }
  });

  it('catalog tool returns the FULL machine-readable catalog (SSoT parity)', async () => {
    await setAppBuilder('on');
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: APP_BUILDER_CATALOG_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    const parsed = JSON.parse(out.content) as { canvasTypeId: string; components: { type: string; props?: unknown[] }[] };
    expect(parsed.canvasTypeId).toBe('canvas.app-builder');
    expect(parsed.components.map((c) => c.type).sort()).toEqual([...APP_BUILDER_COMPONENTS.map((c) => c.type)].sort());
    // Props ride along — the model gets schemas, not just names.
    const form = parsed.components.find((c) => c.type === 'form') as { allowedChildTypes?: string[] };
    expect(form?.allowedChildTypes).toContain('textInput');
  });

  it('catalog tool fails closed when the toggle is off', async () => {
    await setAppBuilder('off');
    const out = await provider().executeTool({ name: APP_BUILDER_CATALOG_TOOL_ID, input: {} });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'feature_disabled' });
    await setAppBuilder('on');
  });

  it('the prompt type list derives from the SSoT with constrained-container hints', () => {
    const list = catalogTypeListForPrompt();
    for (const c of APP_BUILDER_COMPONENTS) expect(list).toContain(c.type);
    expect(list).toContain('form (children: ');
  });
});

describe('ADR 0358 — render tool: gates, repair-loop errors, persistence', () => {
  it('requires a human-initiated turn', async () => {
    const out = await provider().executeTool({ name: APP_BUILDER_RENDER_TOOL_ID, input: { app: VALID_APP } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'acting_user_required' });
  });

  it('fails closed when the toggle is off (structured, not a throw)', async () => {
    await setAppBuilder('off');
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: APP_BUILDER_RENDER_TOOL_ID, input: { app: VALID_APP } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'feature_disabled' });
    await setAppBuilder('on');
  });

  it('returns closed-world validation errors the model can act on (the repair loop)', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({
      name: APP_BUILDER_RENDER_TOOL_ID,
      input: { app: { name: 'Bad', screens: [{ id: 'home', name: 'H', isInitial: true, components: [{ type: 'hologram', props: {} }] }] } },
    });
    expect(out.isError).toBe(true);
    const parsed = JSON.parse(out.content) as { error: string; errors: { message: string }[] };
    expect(parsed.error).toBe('catalog_validation_failed');
    expect(JSON.stringify(parsed.errors)).toContain('hologram');
  });

  it('creates a real canvas, normalized through the render node, and returns the reference', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({
      name: APP_BUILDER_RENDER_TOOL_ID,
      // Un-slugged screen id — the render node's normalization gate must fix it.
      input: { app: { ...VALID_APP, screens: [{ ...VALID_APP.screens[0]!, id: 'Home Screen' }] } },
    });
    expect(out.isError).toBeFalsy();
    const res = JSON.parse(out.content) as { canvasId: string; url: string; screenCount: number; version: number };
    expect(res.screenCount).toBe(1);
    expect(res.url).toBe(`/app-builder/${encodeURIComponent(res.canvasId)}`);
    const canvas = await getCanvasForTenant(TENANT, res.canvasId);
    expect(canvas?.canvasTypeId).toBe('canvas.app-builder');
    const state = canvas?.state as { screens: { id: string }[] };
    expect(state.screens[0]!.id).toBe('home-screen'); // slugged by the ONE gate
  });

  it('is idempotent within a run (retries do not mint duplicate canvases)', async () => {
    const p = provider({ actingUserId: 'u-1', runId: 'run-adr0358' });
    const a = JSON.parse((await p.executeTool({ name: APP_BUILDER_RENDER_TOOL_ID, input: { app: VALID_APP } })).content) as { canvasId: string };
    const b = JSON.parse((await p.executeTool({ name: APP_BUILDER_RENDER_TOOL_ID, input: { app: VALID_APP } })).content) as { canvasId: string };
    expect(b.canvasId).toBe(a.canvasId);
  });

  it('updates via CAS: stale baseVersion is a structured conflict, fresh one lands a new version', async () => {
    const p = provider({ actingUserId: 'u-1' });
    const created = JSON.parse((await p.executeTool({ name: APP_BUILDER_RENDER_TOOL_ID, input: { app: VALID_APP } })).content) as { canvasId: string; version: number };

    const updatedApp = { ...VALID_APP, name: 'Test App v2' };
    const ok = JSON.parse((await p.executeTool({
      name: APP_BUILDER_RENDER_TOOL_ID,
      input: { app: updatedApp, canvasId: created.canvasId, baseVersion: created.version },
    })).content) as { canvasId: string; version: number };
    expect(ok.canvasId).toBe(created.canvasId);
    expect(ok.version).toBeGreaterThan(created.version);

    // Same (now stale) basis again → typed conflict, never a clobber.
    const stale = await p.executeTool({
      name: APP_BUILDER_RENDER_TOOL_ID,
      input: { app: VALID_APP, canvasId: created.canvasId, baseVersion: created.version },
    });
    expect(stale.isError).toBe(true);
    expect(JSON.parse(stale.content)).toMatchObject({ error: 'canvas_version_conflict' });
  });

  it('update without baseVersion is rejected with guidance toward get-design', async () => {
    const p = provider({ actingUserId: 'u-1' });
    const created = JSON.parse((await p.executeTool({ name: APP_BUILDER_RENDER_TOOL_ID, input: { app: VALID_APP } })).content) as { canvasId: string };
    const out = await p.executeTool({ name: APP_BUILDER_RENDER_TOOL_ID, input: { app: VALID_APP, canvasId: created.canvasId } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content).message).toContain('get-design');
  });

  // Grade pass XCH-DATA-1 — agent provenance survives on the canvas row (the
  // documents `producedBy` precedent); the OWNER stays the human (ADR 0045).
  it('stamps producedBy provenance metadata (agent when agentProfileId, else user)', async () => {
    const p = createAgentToolProvider({ tenantId: TENANT, actingUserId: 'u-1', agentProfileId: 'feature.app-builder.agents.default', runId: 'run-prov' });
    const created = JSON.parse((await p.executeTool({ name: APP_BUILDER_RENDER_TOOL_ID, input: { app: { ...VALID_APP, name: 'Provenance App' } } })).content) as { canvasId: string };
    const canvas = await getCanvasForTenant(TENANT, created.canvasId);
    expect(canvas?.ownerSubject).toEqual({ kind: 'user', id: 'u-1' });
    const meta = canvas?.metadata as { producedBy?: { kind: string; id: string }; runId?: string } | undefined;
    expect(meta?.producedBy).toEqual({ kind: 'agent', id: 'feature.app-builder.agents.default' });
    expect(meta?.runId).toBe('run-prov');
  });
});

describe('ADR 0358 — get-design: the app-state read path', () => {
  it('reads the current design + CAS version; cross-type and missing ids are not found', async () => {
    const p = provider({ actingUserId: 'u-1' });
    const created = JSON.parse((await p.executeTool({ name: APP_BUILDER_RENDER_TOOL_ID, input: { app: VALID_APP } })).content) as { canvasId: string };
    const out = await p.executeTool({ name: APP_BUILDER_GET_DESIGN_TOOL_ID, input: { canvasId: created.canvasId } });
    expect(out.isError).toBeFalsy();
    const res = JSON.parse(out.content) as { canvasId: string; version: number; app: { name: string } };
    expect(res.app.name).toBe('Test App');
    expect(res.version).toBeGreaterThanOrEqual(1);

    const missing = await p.executeTool({ name: APP_BUILDER_GET_DESIGN_TOOL_ID, input: { canvasId: 'canvas-nope' } });
    expect(missing.isError).toBe(true);
    expect(JSON.parse(missing.content)).toMatchObject({ error: 'not_found' });
  });

  it('requires a human-initiated turn (tenant rows never leak to system runs)', async () => {
    const out = await provider().executeTool({ name: APP_BUILDER_GET_DESIGN_TOOL_ID, input: { canvasId: 'canvas-x' } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'acting_user_required' });
  });

  // Grade pass XCH-CODE-3 — tenant isolation proven AT THE TOOL BOUNDARY: a
  // canvas minted in another tenant is `not_found` here (no existence leak),
  // exactly the getCanvasForTenant contract the HTTP path relies on.
  it('never reads a canvas across tenants (no existence leak)', async () => {
    const foreign = await createCanvasForTenant('other-tenant', {
      canvasTypeId: 'canvas.app-builder',
      name: 'Foreign',
      initialState: { name: 'Foreign', screens: [{ id: 'home', name: 'H', isInitial: true, components: [] }] } as never,
    });
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: APP_BUILDER_GET_DESIGN_TOOL_ID, input: { canvasId: foreign.canvasId } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'not_found' });
  });
});
