/**
 * CFP-1 repair — the Slide Designer's real tools (the app-builder ADR 0358 trio
 * ported to slides).
 *
 * The exchange contract under test: the model can REQUEST the block catalog,
 * READ an existing deck (+ CAS version), and RENDER through the one
 * normalization gate (`feature.slides.nodes.render`) + closed-world validation
 * with structured error feedback — gated like the HTTP editor path (toggle,
 * acting user). Plus the allowlist-resolution pin: the pack's three ids are
 * exactly the three registered ids. Boots the REAL app.
 *
 * Not covered here (claim gap, recorded by /grade-tests wave 61): the org-RBAC
 * branch (`forbidden_scope` for a non-member). Every case acts as the org owner.
 *
 * What breaks it: dropping the acting-user / toggle gates, the CAS or the
 * baseVersion guard (exact code + message, so the CAS conflict — which also
 * says "get-design" — cannot stand in for it), the get-design type pin (a real
 * app-builder canvas must be not_found), the per-run idempotency key, or the
 * producedBy stamp. Sabotage-witnessed (8fw3g1-sat-*).
 *
 * The `slides` toggle is GLOBAL (`saveConfig(cfg, 'test')`): every case that
 * turns it off restores it in `finally`.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import {
  SLIDES_CATALOG_TOOL_ID,
  SLIDES_GET_DESIGN_TOOL_ID,
  SLIDES_RENDER_TOOL_ID,
} from '../src/features/slides/agentTools.js';
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

const setSlides = async (status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault('slides');
  expect(d, 'the slides toggle is registered').toBeTruthy();
  await saveConfig({ ...d!, status }, 'test');
};
/** Run `fn` with slides OFF, restoring ON even when an assertion fails. */
async function withSlidesOff(fn: () => Promise<void>): Promise<void> {
  await setSlides('off');
  try { await fn(); } finally { await setSlides('on'); }
}

function provider(scope: { actingUserId?: string; runId?: string; agentProfileId?: string } = {}) {
  return createAgentToolProvider({ tenantId: TENANT, ...scope });
}

/** Measured wave 61 from the render node's empty-slides refusal. */
const REPAIR_CODE = 'validation_error';
const REPAIR_MESSAGE = 'The deck failed structural normalization — fix and call again.';

const VALID_DECK = {
  title: 'Q3 Review',
  theme: 'default',
  slides: [
    { layout: 'title', title: 'Q3 Review', subtitle: 'Sales & Ops' },
    { layout: 'title-bullets', title: 'Highlights', bullets: ['NRR 118%', 'Two new markets'] },
  ],
};

describe('CFP-1 — the agents pack rides exactly the three registered tools', () => {
  const packDir = new URL('../../../packs/vendor.openwop-app.slides.agents/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('pack.json', packDir), 'utf8')) as {
    agents: { toolAllowlist: string[]; systemPromptRef: string }[];
  };
  const prompt = readFileSync(new URL(manifest.agents[0]!.systemPromptRef, packDir), 'utf8');

  it('the allowlist is exactly the three registered tool ids', () => {
    expect([...manifest.agents[0]!.toolAllowlist].sort()).toEqual(
      [SLIDES_RENDER_TOOL_ID, SLIDES_CATALOG_TOOL_ID, SLIDES_GET_DESIGN_TOOL_ID].sort(),
    );
  });

  it('every allowlisted id resolves in the live tool provider (no phantom ids)', () => {
    const universe = new Set(builtinAgentToolIds());
    for (const id of manifest.agents[0]!.toolAllowlist) expect(universe.has(id)).toBe(true);
  });

  it('the prompt teaches the repair-loop protocol', () => {
    expect(prompt).toContain('catalog_validation_failed');
    expect(prompt).toContain('canvas_version_conflict');
    expect(prompt).toContain('baseVersion');
  });
});

describe('CFP-1 — catalog tool: the schema-request path', () => {
  it('returns the closed block catalog (SSoT projection)', async () => {
    await setSlides('on');
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: SLIDES_CATALOG_TOOL_ID, input: {} });
    expect(out.isError).toBeFalsy();
    const parsed = JSON.parse(out.content) as { canvasTypeId: string; layouts: string[]; blockTypeList: string };
    expect(parsed.canvasTypeId).toBe('canvas.slides');
    expect(parsed.layouts).toContain('blocks');
    expect(parsed.blockTypeList).toContain('statCard');
  });

  it('fails closed when the toggle is off', async () => {
    await withSlidesOff(async () => {
      const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: SLIDES_CATALOG_TOOL_ID, input: {} });
      expect(out.isError).toBe(true);
      expect(JSON.parse(out.content)).toMatchObject({ error: 'feature_disabled' });
    });
  });
});

describe('CFP-1 — render tool: gates, repair-loop errors, persistence', () => {
  it('requires a human-initiated turn', async () => {
    const out = await provider().executeTool({ name: SLIDES_RENDER_TOOL_ID, input: { deck: VALID_DECK } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'acting_user_required' });
  });

  it('fails closed when the toggle is off (structured, not a throw)', async () => {
    await withSlidesOff(async () => {
      const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: SLIDES_RENDER_TOOL_ID, input: { deck: VALID_DECK } });
      expect(out.isError).toBe(true);
      expect(JSON.parse(out.content)).toMatchObject({ error: 'feature_disabled' });
    });
  });

  it('returns closed-world validation errors the model can act on (the repair loop)', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({
      name: SLIDES_RENDER_TOOL_ID,
      // An empty slide list — the render node throws; the tool returns typed, not empty.
      input: { deck: { title: 'Bad', slides: [] } },
    });
    expect(out.isError).toBe(true);
    const err = JSON.parse(out.content) as { error: string; message: string };
    expect(err.error).toBe(REPAIR_CODE);
    expect(err.message).toBe(REPAIR_MESSAGE);
    expect(JSON.parse(out.content).detail, 'the node failure rides back for the model to act on').toBeTruthy();
  });

  // Retitled (wave 61): this case used to be called "rejects a bad theme through
  // the closed-world validator" while asserting SUCCESS. What actually happens is
  // that the render node's normalization drops the unknown theme, so the deck is
  // saved — and what must hold is that `neon` never reaches the stored canvas.
  it('an unknown theme is normalized away, never persisted', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({
      name: SLIDES_RENDER_TOOL_ID,
      input: { deck: { title: 'X', theme: 'neon', slides: [{ layout: 'title', title: 'A' }] } },
    });
    expect(out.isError).toBeFalsy();
    const { canvasId } = JSON.parse(out.content) as { canvasId: string };
    const stored = (await getCanvasForTenant(TENANT, canvasId))?.state as { theme?: string; title?: string } | undefined;
    expect(stored?.title).toBe('X');
    expect(stored?.theme).toBeUndefined(); // dropped (measured), so the default theme renders
    expect(JSON.stringify(stored)).not.toContain('neon');
  });

  it('creates a real canvas, normalized through the render node, adds editor identity fields', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({
      name: SLIDES_RENDER_TOOL_ID,
      input: { deck: VALID_DECK },
    });
    expect(out.isError).toBeFalsy();
    const res = JSON.parse(out.content) as { canvasId: string; url: string; slideCount: number; version: number };
    expect(res.slideCount).toBe(2);
    expect(res.url).toBe(`/slides/${encodeURIComponent(res.canvasId)}`);
    const canvas = await getCanvasForTenant(TENANT, res.canvasId);
    expect(canvas?.canvasTypeId).toBe('canvas.slides');
    const state = canvas?.state as { slides: { id: string; name: string; layout: string }[] };
    expect(state.slides[0]!.id).toBe('slide-1'); // editor identity field added by the tool
    expect(state.slides[0]!.name).toBe('Q3 Review');
  });

  it('is idempotent within a run (retries do not mint duplicate canvases)', async () => {
    const p = provider({ actingUserId: 'u-1', runId: 'run-cfp1' });
    const a = JSON.parse((await p.executeTool({ name: SLIDES_RENDER_TOOL_ID, input: { deck: VALID_DECK } })).content) as { canvasId: string };
    const b = JSON.parse((await p.executeTool({ name: SLIDES_RENDER_TOOL_ID, input: { deck: VALID_DECK } })).content) as { canvasId: string };
    expect(b.canvasId).toBe(a.canvasId);
  });

  it('updates via CAS: stale baseVersion is a structured conflict, fresh one lands a new version', async () => {
    const p = provider({ actingUserId: 'u-1' });
    const created = JSON.parse((await p.executeTool({ name: SLIDES_RENDER_TOOL_ID, input: { deck: VALID_DECK } })).content) as { canvasId: string; version: number };

    const updated = { ...VALID_DECK, title: 'Q3 Review v2' };
    const ok = JSON.parse((await p.executeTool({
      name: SLIDES_RENDER_TOOL_ID,
      input: { deck: updated, canvasId: created.canvasId, baseVersion: created.version },
    })).content) as { canvasId: string; version: number };
    expect(ok.canvasId).toBe(created.canvasId);
    expect(ok.version).toBeGreaterThan(created.version);

    const stale = await p.executeTool({
      name: SLIDES_RENDER_TOOL_ID,
      input: { deck: VALID_DECK, canvasId: created.canvasId, baseVersion: created.version },
    });
    expect(stale.isError).toBe(true);
    expect(JSON.parse(stale.content)).toMatchObject({ error: 'canvas_version_conflict' });
  });

  it('update without baseVersion is rejected with guidance toward get-design', async () => {
    const p = provider({ actingUserId: 'u-1' });
    const created = JSON.parse((await p.executeTool({ name: SLIDES_RENDER_TOOL_ID, input: { deck: VALID_DECK } })).content) as { canvasId: string };
    const out = await p.executeTool({ name: SLIDES_RENDER_TOOL_ID, input: { deck: { ...VALID_DECK, title: 'No base' }, canvasId: created.canvasId } });
    expect(out.isError).toBe(true);
    // Exact code + message: the CAS conflict ALSO mentions get-design, so a
    // `toContain('get-design')` was satisfied with this guard deleted
    // (8fw3g1-sat-baseversion, round 1 vacuous).
    expect(JSON.parse(out.content)).toEqual({
      error: 'validation_error',
      message: 'Updating an existing deck requires `baseVersion` — read it with the get-design tool first.',
    });
    // …and nothing was written.
    const after = await getCanvasForTenant(TENANT, created.canvasId);
    expect(after?.version).toBe(1);
    expect((after?.state as { title?: string }).title).toBe('Q3 Review');
  });

  it('stamps producedBy provenance (agent when agentProfileId, else user); owner stays the human', async () => {
    const p = provider({ actingUserId: 'u-1', agentProfileId: 'vendor.openwop-app.slides.agents.default', runId: 'run-prov' });
    const created = JSON.parse((await p.executeTool({ name: SLIDES_RENDER_TOOL_ID, input: { deck: { ...VALID_DECK, title: 'Provenance' } } })).content) as { canvasId: string };
    const canvas = await getCanvasForTenant(TENANT, created.canvasId);
    expect(canvas?.ownerSubject).toEqual({ kind: 'user', id: 'u-1' });
    const meta = canvas?.metadata as { producedBy?: { kind: string; id: string }; runId?: string } | undefined;
    expect(meta?.producedBy).toEqual({ kind: 'agent', id: 'vendor.openwop-app.slides.agents.default' });
    expect(meta?.runId).toBe('run-prov');
  });
});

describe('CFP-1 — get-design: the deck-state read path', () => {
  it('reads the current deck + CAS version; cross-type and missing ids are not found', async () => {
    const p = provider({ actingUserId: 'u-1' });
    const created = JSON.parse((await p.executeTool({ name: SLIDES_RENDER_TOOL_ID, input: { deck: VALID_DECK } })).content) as { canvasId: string };
    const out = await p.executeTool({ name: SLIDES_GET_DESIGN_TOOL_ID, input: { canvasId: created.canvasId } });
    expect(out.isError).toBeFalsy();
    const res = JSON.parse(out.content) as { canvasId: string; version: number; deck: { title: string } };
    expect(res.deck.title).toBe('Q3 Review');
    expect(res.version).toBeGreaterThanOrEqual(1);

    const missing = await p.executeTool({ name: SLIDES_GET_DESIGN_TOOL_ID, input: { canvasId: 'canvas-nope' } });
    expect(missing.isError).toBe(true);
    expect(JSON.parse(missing.content)).toMatchObject({ error: 'not_found', message: "Slide deck 'canvas-nope' not found in this workspace." });

    // Cross-TYPE: a real app-builder canvas in the SAME tenant is not a deck.
    const appCanvas = await createCanvasForTenant(TENANT, {
      canvasTypeId: 'canvas.app-builder', name: 'App', ownerSubject: { kind: 'user', id: 'u-1' }, initialState: { name: 'App', screens: [] },
    });
    const crossType = await p.executeTool({ name: SLIDES_GET_DESIGN_TOOL_ID, input: { canvasId: appCanvas.canvasId } });
    expect(crossType.isError).toBe(true);
    expect(JSON.parse(crossType.content)).toMatchObject({ error: 'not_found', message: `Slide deck '${appCanvas.canvasId}' not found in this workspace.` });
  });

  it('fails EMPTY without a human-initiated turn (tenant rows never leak to system runs; the loop is not derailed)', async () => {
    const out = await provider().executeTool({ name: SLIDES_GET_DESIGN_TOOL_ID, input: { canvasId: 'canvas-x' } });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toEqual({ deck: null });
  });

  it('never reads a canvas across tenants (no existence leak)', async () => {
    const foreign = await createCanvasForTenant('other-tenant', {
      canvasTypeId: 'canvas.slides',
      name: 'Foreign',
      initialState: { title: 'Foreign', slides: [{ id: 'slide-1', name: 'S', layout: 'title', title: 'S' }] },
    });
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: SLIDES_GET_DESIGN_TOOL_ID, input: { canvasId: foreign.canvasId } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'not_found' });
  });
});
