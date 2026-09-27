/**
 * CFP-1 (chat-first port E1) — the Campaign Strategist's real tools.
 *
 * The exchange contract under test: the model can READ an existing campaign
 * (+ CAS version) and RENDER through the one normalization node + closed-world
 * validation with structured error feedback — all gated exactly like the HTTP
 * editor path (toggle, acting user, org RBAC). Boots the REAL app (the ADR 0308
 * D2 registration seam is what's under test), so the CFP-1 tripwire
 * (agent-allowlist-resolution.test.ts) can see the ids resolve.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import {
  CAMPAIGN_STUDIO_RENDER_TOOL_ID,
  CAMPAIGN_STUDIO_GET_DESIGN_TOOL_ID,
} from '../src/features/campaign-studio/agentTools.js';
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

const setCampaignStudio = async (status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault('campaign-studio');
  if (d) await saveConfig({ ...d, status }, 'test');
};

function provider(scope: { actingUserId?: string; runId?: string; agentProfileId?: string } = {}) {
  return createAgentToolProvider({ tenantId: TENANT, ...scope });
}

const VALID_CAMPAIGN = {
  name: 'Spring launch',
  objective: 'Drive 2,000 trial signups in Q2.',
  channels: [
    { name: 'Lifecycle email', type: 'email', tactic: '3-touch nurture' },
    { name: 'LinkedIn ads', type: 'social', tactic: 'ABM', budget: 8000 },
  ],
  funnel: [{ stage: 'awareness', description: 'Reach', kpis: ['Impressions'] }],
};

describe('CFP-1 — the agents pack rides the real registered tools', () => {
  const packDir = new URL('../../../packs/feature.campaign-studio.agents/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('pack.json', packDir), 'utf8')) as {
    agents: { toolAllowlist: string[]; systemPromptRef: string }[];
  };
  const prompt = readFileSync(new URL(manifest.agents[0]!.systemPromptRef, packDir), 'utf8');

  it('the allowlist is exactly the two registered tool ids', () => {
    expect([...manifest.agents[0]!.toolAllowlist].sort()).toEqual(
      [CAMPAIGN_STUDIO_RENDER_TOOL_ID, CAMPAIGN_STUDIO_GET_DESIGN_TOOL_ID].sort(),
    );
  });

  it('both tools register into the builtin surface (the CFP-1 resolution the tripwire pins)', () => {
    const ids = builtinAgentToolIds();
    for (const id of [CAMPAIGN_STUDIO_RENDER_TOOL_ID, CAMPAIGN_STUDIO_GET_DESIGN_TOOL_ID]) {
      expect(ids).toContain(id);
    }
  });

  it('the prompt names the real tools and teaches the error-feedback protocol', () => {
    expect(prompt).toContain(CAMPAIGN_STUDIO_RENDER_TOOL_ID);
    expect(prompt).toContain(CAMPAIGN_STUDIO_GET_DESIGN_TOOL_ID);
    expect(prompt).toContain('campaign_validation_failed');
    expect(prompt).toContain('canvas_version_conflict');
    expect(prompt).toContain('baseVersion');
    // The phantom ids the audit found must be gone.
    expect(prompt).not.toContain('core.coordination.canvasRead');
    expect(prompt).not.toContain('feature.campaign-studio.nodes.render');
  });
});

describe('CFP-1 — render tool: gates, repair-loop errors, persistence', () => {
  it('requires a human-initiated turn', async () => {
    const out = await provider().executeTool({ name: CAMPAIGN_STUDIO_RENDER_TOOL_ID, input: { campaign: VALID_CAMPAIGN } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'acting_user_required' });
  });

  it('fails closed when the toggle is off (structured, not a throw)', async () => {
    await setCampaignStudio('off');
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: CAMPAIGN_STUDIO_RENDER_TOOL_ID, input: { campaign: VALID_CAMPAIGN } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'feature_disabled' });
    await setCampaignStudio('on');
  });

  it('rejects invalid model input as a typed error the model can act on, never success-with-empty', async () => {
    await setCampaignStudio('on');
    // The render node fail-fasts on the structural essentials (name + ≥1
    // channel) with a typed `validation_error` the repair loop feeds back — it
    // never persists a half-formed campaign as a "success".
    const noChannels = await provider({ actingUserId: 'u-1' }).executeTool({
      name: CAMPAIGN_STUDIO_RENDER_TOOL_ID,
      input: { campaign: { name: 'Empty' } },
    });
    expect(noChannels.isError).toBe(true);
    expect(JSON.parse(noChannels.content)).toMatchObject({ error: 'validation_error' });

    const noName = await provider({ actingUserId: 'u-1' }).executeTool({
      name: CAMPAIGN_STUDIO_RENDER_TOOL_ID,
      input: { campaign: { channels: [{ name: 'X', type: 'email' }] } },
    });
    expect(noName.isError).toBe(true);
    expect(JSON.parse(noName.content)).toMatchObject({ error: 'validation_error' });
  });

  it('R2 CS-SP-2 — an unknown channel type / funnel stage is a TYPED failure the model can repair, never a silent substitution', async () => {
    // The old normalizers rewrote "tiktok" → 'content' and unknown stages →
    // 'awareness' BEFORE validation, so ok:true came back for a campaign the
    // model never described and the repair loop never fired.
    const badType = await provider({ actingUserId: 'u-1' }).executeTool({
      name: CAMPAIGN_STUDIO_RENDER_TOOL_ID,
      input: { campaign: { ...VALID_CAMPAIGN, channels: [{ name: 'TikTok push', type: 'tiktok' }] } },
    });
    expect(badType.isError).toBe(true);
    const bt = JSON.parse(badType.content) as { error: string; message: string };
    expect(bt.error).toBe('validation_error');
    expect(bt.message).toMatch(/tiktok/);
    expect(bt.message).toMatch(/email, social/); // the repairable allowlist is named

    const badStage = await provider({ actingUserId: 'u-1' }).executeTool({
      name: CAMPAIGN_STUDIO_RENDER_TOOL_ID,
      input: { campaign: { ...VALID_CAMPAIGN, funnel: [{ stage: 'virality' }] } },
    });
    expect(badStage.isError).toBe(true);
    expect(JSON.parse(badStage.content)).toMatchObject({ error: 'validation_error' });
  });

  it('R2 CS-SP-1 — an agent revision PRESERVES the board coordinates get-design returned', async () => {
    const p = provider({ actingUserId: 'u-1' });
    const withLayout = { ...VALID_CAMPAIGN, funnel: [{ stage: 'awareness', x: 120, y: 340 }, { stage: 'conversion', x: 480, y: 90 }] };
    const created = JSON.parse((await p.executeTool({ name: CAMPAIGN_STUDIO_RENDER_TOOL_ID, input: { campaign: withLayout } })).content) as { canvasId: string; version: number };
    const canvas = await getCanvasForTenant(TENANT, created.canvasId);
    const funnel = (canvas?.state as { funnel: Array<{ stage: string; x?: number; y?: number }> }).funnel;
    // The old normalizeStage DROPPED x/y — every Strategist revision silently
    // reset the user's board arrangement to the auto-grid.
    expect(funnel.find((f) => f.stage === 'awareness')).toMatchObject({ x: 120, y: 340 });
    expect(funnel.find((f) => f.stage === 'conversion')).toMatchObject({ x: 480, y: 90 });
  });

  it('creates a real canvas, normalized through the render node, and returns the reference', async () => {
    const out = await provider({ actingUserId: 'u-1' }).executeTool({
      name: CAMPAIGN_STUDIO_RENDER_TOOL_ID,
      input: { campaign: VALID_CAMPAIGN },
    });
    expect(out.isError).toBeFalsy();
    const res = JSON.parse(out.content) as { canvasId: string; url: string; channelCount: number; version: number };
    expect(res.channelCount).toBe(2);
    expect(res.url).toBe(`/campaign-studio/${encodeURIComponent(res.canvasId)}`);
    const canvas = await getCanvasForTenant(TENANT, res.canvasId);
    expect(canvas?.canvasTypeId).toBe('canvas.campaign');
    expect((canvas?.state as { name: string }).name).toBe('Spring launch');
  });

  it('is idempotent within a run (retries do not mint duplicate canvases)', async () => {
    const p = provider({ actingUserId: 'u-1', runId: 'run-cfp1' });
    const a = JSON.parse((await p.executeTool({ name: CAMPAIGN_STUDIO_RENDER_TOOL_ID, input: { campaign: VALID_CAMPAIGN } })).content) as { canvasId: string };
    const b = JSON.parse((await p.executeTool({ name: CAMPAIGN_STUDIO_RENDER_TOOL_ID, input: { campaign: VALID_CAMPAIGN } })).content) as { canvasId: string };
    expect(b.canvasId).toBe(a.canvasId);
  });

  it('updates via CAS: stale baseVersion is a structured conflict, fresh one lands a new version', async () => {
    const p = provider({ actingUserId: 'u-1' });
    const created = JSON.parse((await p.executeTool({ name: CAMPAIGN_STUDIO_RENDER_TOOL_ID, input: { campaign: VALID_CAMPAIGN } })).content) as { canvasId: string; version: number };

    const updated = { ...VALID_CAMPAIGN, name: 'Spring launch v2' };
    const ok = JSON.parse((await p.executeTool({
      name: CAMPAIGN_STUDIO_RENDER_TOOL_ID,
      input: { campaign: updated, canvasId: created.canvasId, baseVersion: created.version },
    })).content) as { canvasId: string; version: number };
    expect(ok.canvasId).toBe(created.canvasId);
    expect(ok.version).toBeGreaterThan(created.version);

    const stale = await p.executeTool({
      name: CAMPAIGN_STUDIO_RENDER_TOOL_ID,
      input: { campaign: VALID_CAMPAIGN, canvasId: created.canvasId, baseVersion: created.version },
    });
    expect(stale.isError).toBe(true);
    expect(JSON.parse(stale.content)).toMatchObject({ error: 'canvas_version_conflict' });
  });

  it('update without baseVersion is rejected with guidance toward get-design', async () => {
    const p = provider({ actingUserId: 'u-1' });
    const created = JSON.parse((await p.executeTool({ name: CAMPAIGN_STUDIO_RENDER_TOOL_ID, input: { campaign: VALID_CAMPAIGN } })).content) as { canvasId: string };
    const out = await p.executeTool({ name: CAMPAIGN_STUDIO_RENDER_TOOL_ID, input: { campaign: VALID_CAMPAIGN, canvasId: created.canvasId } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content).message).toContain('get-design');
  });

  it('stamps producedBy provenance metadata (agent when agentProfileId, else user); owner stays the human', async () => {
    const p = provider({ actingUserId: 'u-1', agentProfileId: 'feature.campaign-studio.agents.default', runId: 'run-prov' });
    const created = JSON.parse((await p.executeTool({ name: CAMPAIGN_STUDIO_RENDER_TOOL_ID, input: { campaign: { ...VALID_CAMPAIGN, name: 'Provenance' } } })).content) as { canvasId: string };
    const canvas = await getCanvasForTenant(TENANT, created.canvasId);
    expect(canvas?.ownerSubject).toEqual({ kind: 'user', id: 'u-1' });
    const meta = canvas?.metadata as { producedBy?: { kind: string; id: string }; runId?: string } | undefined;
    expect(meta?.producedBy).toEqual({ kind: 'agent', id: 'feature.campaign-studio.agents.default' });
    expect(meta?.runId).toBe('run-prov');
  });
});

describe('CFP-1 — get-design: the campaign-state read path', () => {
  it('reads the current campaign + CAS version; cross-type and missing ids are not found', async () => {
    const p = provider({ actingUserId: 'u-1' });
    const created = JSON.parse((await p.executeTool({ name: CAMPAIGN_STUDIO_RENDER_TOOL_ID, input: { campaign: VALID_CAMPAIGN } })).content) as { canvasId: string };
    const out = await p.executeTool({ name: CAMPAIGN_STUDIO_GET_DESIGN_TOOL_ID, input: { canvasId: created.canvasId } });
    expect(out.isError).toBeFalsy();
    const res = JSON.parse(out.content) as { canvasId: string; version: number; campaign: { name: string } };
    expect(res.campaign.name).toBe('Spring launch');
    expect(res.version).toBeGreaterThanOrEqual(1);

    const missing = await p.executeTool({ name: CAMPAIGN_STUDIO_GET_DESIGN_TOOL_ID, input: { canvasId: 'canvas-nope' } });
    expect(missing.isError).toBe(true);
    expect(JSON.parse(missing.content)).toMatchObject({ error: 'not_found' });
  });

  it('fails EMPTY without a human-initiated turn (tenant rows never leak to system runs; the loop is not derailed)', async () => {
    const out = await provider().executeTool({ name: CAMPAIGN_STUDIO_GET_DESIGN_TOOL_ID, input: { canvasId: 'canvas-x' } });
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.content)).toEqual({ campaign: null });
  });

  it('never reads a canvas across tenants (no existence leak)', async () => {
    const foreign = await createCanvasForTenant('other-tenant', {
      canvasTypeId: 'canvas.campaign',
      name: 'Foreign',
      initialState: { name: 'Foreign', channels: [{ name: 'C', type: 'email' }] } as never,
    });
    const out = await provider({ actingUserId: 'u-1' }).executeTool({ name: CAMPAIGN_STUDIO_GET_DESIGN_TOOL_ID, input: { canvasId: foreign.canvasId } });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content)).toMatchObject({ error: 'not_found' });
  });
});
