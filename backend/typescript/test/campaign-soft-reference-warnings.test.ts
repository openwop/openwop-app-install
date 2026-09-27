/**
 * ADR 0727 — an asset that names a channel the campaign does not have is a SOFT warning:
 * the save succeeds and the warning rides back. Four hops, because a unit test on the
 * validator alone would pass while the warning died at either boundary:
 *
 *   1. the validator emits it (D1);
 *   2. the agent tool's SUCCESS result carries it AND the note names it (D2) — the note is
 *      the in-band instruction the model follows, so a warnings field it never mentions
 *      would be decorative;
 *   3. the chassis PATCH returns it in the 200 body (D3) — the hop the editor's
 *      `savedWithWarnings` toast depends on, and which no test asserted for ANY canvas type
 *      before this one (campaign is only the second emitter after `validateAppDoc`);
 *   4. a consistent doc warns zero times (non-vacuity).
 *
 * Born red on the pre-ADR validator: legs 1-3 fail (`warnings: []` unconditionally).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { validateCampaignDoc } from '../src/features/campaign-studio/validateCampaignDoc.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { createOrg } from '../src/host/accessControlService.js';
import { CAMPAIGN_STUDIO_RENDER_TOOL_ID } from '../src/features/campaign-studio/agentTools.js';

/** A campaign whose single asset points at a channel that does not exist. */
const DANGLING = {
  name: 'Spring launch',
  channels: [{ name: 'Lifecycle email', type: 'email' }],
  assets: [{ channel: 'LinkedIn ads', format: 'Single image', headline: 'Ship faster' }],
};
/** The same campaign with the asset pointing at a real channel. */
const CONSISTENT = {
  name: 'Spring launch',
  channels: [{ name: 'Lifecycle email', type: 'email' }],
  assets: [{ channel: 'Lifecycle email', format: 'Single image', headline: 'Ship faster' }],
};

describe('ADR 0727 D1 — the validator emits a soft reference warning', () => {
  it('leg 1: a dangling asset.channel warns, and does NOT error (the save must still succeed)', () => {
    const v = validateCampaignDoc(DANGLING);
    expect(v.errors).toEqual([]);
    expect(v.warnings).toHaveLength(1);
    expect(v.warnings[0]!.path).toBe('assets[0].channel');
    expect(v.warnings[0]!.message).toContain("references missing channel 'LinkedIn ads'");
  });

  it('leg 4 (non-vacuity): a consistent campaign warns zero times', () => {
    expect(validateCampaignDoc(CONSISTENT)).toEqual({ errors: [], warnings: [] });
  });

  it('an asset with no channel is UNASSIGNED, not dangling — never warned', () => {
    const v = validateCampaignDoc({ ...CONSISTENT, assets: [{ format: 'Single image' }, { channel: '' }] });
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
  });

  it('an INVALID channel does not also produce a reference warning (no noise on top of a hard failure)', () => {
    const v = validateCampaignDoc({
      name: 'X',
      channels: [{ name: 'Lifecycle email', type: 'not-a-type' }],
      assets: [{ channel: 'Lifecycle email' }],
    });
    expect(v.errors.some((e) => e.path === 'channels[0].type')).toBe(true);
    expect(v.warnings, 'the channel name was still valid, so the asset resolves').toEqual([]);
  });
});

describe('ADR 0727 D2 — the MODEL is told what the editor is told', () => {
  let server: http.Server;
  const TENANT = `org:test-cswtool-${Date.now()}`;

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
    const d = getToggleDefault('campaign-studio');
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
    // The tool refuses without an org to own the canvas ("org_required").
    await createOrg({ tenantId: TENANT, createdBy: 'u-csw', name: 'Acme', ownerSubject: 'u-csw' });
  }, 60_000);
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  const render = async (state: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const out = await createAgentToolProvider({ tenantId: TENANT, actingUserId: 'u-csw' })
      .executeTool({ name: CAMPAIGN_STUDIO_RENDER_TOOL_ID, input: { campaign: state } });
    expect(out.isError, `render must SUCCEED: ${String(out.content).slice(0, 300)}`).toBeFalsy();
    return JSON.parse(String(out.content)) as Record<string, unknown>;
  };

  it('leg 2: a dangling reference SUCCEEDS, carries `warnings`, and the NOTE names them', async () => {
    const body = await render(DANGLING);
    expect(body.canvasId, 'the campaign was created — a warning is not a failure').toBeTruthy();
    const warnings = body.warnings as { path: string; message: string }[] | undefined;
    expect(warnings).toHaveLength(1);
    expect(warnings![0]!.message).toContain("references missing channel 'LinkedIn ads'");
    // The note is the in-band instruction the model follows; a warnings field it never
    // mentions would be decorative (ADR 0727 D2).
    expect(String(body.note)).toContain('SAVED');
    expect(String(body.note)).toContain('warnings');
  }, 60_000);

  it('leg 2b (non-vacuity): a consistent campaign returns NO warnings key and the plain note', async () => {
    const body = await render(CONSISTENT);
    expect(body.warnings).toBeUndefined();
    expect(String(body.note)).toContain('Campaign created');
    expect(String(body.note)).not.toContain('SAVED, but');
  }, 60_000);
});

describe('ADR 0727 D3 — the chassis PATCH returns the warning (the hop the toast needs)', () => {
  let server: http.Server;
  let BASE = '';
  let n = 0;

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true'; // the seam that mints the session (authTestSeam.ts:33)
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
    const d = getToggleDefault('campaign-studio');
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }, 60_000);
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  const client = (): { post: (p: string, b?: unknown) => Promise<{ status: number; body: any }>; patch: (p: string, b?: unknown) => Promise<{ status: number; body: any }> } => {
    let cookie = '';
    const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
      return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
    };
    return { post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
  };

  it('leg 3: saving a campaign with a dangling asset returns 200 AND the warning', async () => {
    const c = client();
    const tenantId = `org:test-csw-${Date.now()}-${n++}`;
    expect((await c.post('/v1/host/openwop-app/test/login', { email: `csw-${Date.now()}-${n++}@acme.test`, tenantId })).status).toBe(201);
    const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
    expect(org.status).toBe(201);
    const orgId = org.body.orgId as string;

    const B = `/v1/host/openwop-app/campaign-studio/orgs/${encodeURIComponent(orgId)}`;
    const made = await c.post(`${B}/canvases`, { name: 'Spring launch' });
    expect(made.status, JSON.stringify(made.body).slice(0, 300)).toBe(201);
    const canvasId = made.body.canvasId as string;
    const version = made.body.version as number;

    const saved = await c.patch(`${B}/canvases/${canvasId}`, { state: DANGLING, expectedVersion: version });
    expect(saved.status, JSON.stringify(saved.body).slice(0, 300)).toBe(200);
    expect(saved.body.warnings, 'the save SUCCEEDED and reported').toHaveLength(1);
    expect(saved.body.warnings[0].message).toContain("references missing channel 'LinkedIn ads'");

    // And a consistent save reports none — so the field is not simply always populated.
    const clean = await c.patch(`${B}/canvases/${canvasId}`, { state: CONSISTENT, expectedVersion: saved.body.newVersion });
    expect(clean.status).toBe(200);
    expect(clean.body.warnings).toEqual([]);
  }, 60_000);
});
