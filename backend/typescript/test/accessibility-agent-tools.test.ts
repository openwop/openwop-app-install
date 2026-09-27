/**
 * ADR 0363 P3 — the accessibility agent tools (chat-drivability seam) + the
 * auto-advertised `ctx.features.accessibility` surface. Booting the app runs
 * registerAccessibilityAgentTools() and registers the surface.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import { ACCESSIBILITY_CHECK_TOOL_ID, ACCESSIBILITY_ALT_TEXT_TOOL_ID } from '../src/features/accessibility/agentTools.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

const TENANT = 'default';
let server: http.Server;
let BASE = '';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const setAccessibility = async (status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault('accessibility');
  if (d) await saveConfig({ ...d, status }, 'test');
};
const run = (name: string, input: Record<string, unknown>, scope: { actingUserId?: string } = {}) =>
  createAgentToolProvider({ tenantId: TENANT, runId: 'run-adr0363', ...scope }).executeTool({ name, input });
const parse = (r: { content: string }) => JSON.parse(r.content) as Record<string, unknown>;

describe('accessibility agent tools are chat-drivable (ADR 0363 P3)', () => {
  it('both tools are registered as builtin agent tools (the registerFeatureAgentTool seam)', () => {
    const ids = builtinAgentToolIds();
    expect(ids).toContain(ACCESSIBILITY_CHECK_TOOL_ID);
    expect(ids).toContain(ACCESSIBILITY_ALT_TEXT_TOOL_ID);
  });

  it('check: runs the rules over a supplied model when the toggle is on', async () => {
    await setAccessibility('on');
    const r = await run(ACCESSIBILITY_CHECK_TOOL_ID, { images: [{ alt: '' }], headings: [{ level: 1 }, { level: 4 }] });
    expect(r.isError).toBeFalsy();
    const body = parse(r);
    expect(body.count).toBe(2);
    expect((body.issues as { kind: string }[]).map((i) => i.kind).sort()).toEqual(['heading-skip', 'missing-alt']);
  });

  it('check: fail-closed with feature_disabled when the toggle is off', async () => {
    await setAccessibility('off');
    const r = await run(ACCESSIBILITY_CHECK_TOOL_ID, { images: [{ alt: '' }] });
    expect(r.isError).toBe(true);
    expect(parse(r).error).toBe('feature_disabled');
    await setAccessibility('on'); // restore
  });

  it('alt-text: requires a human-initiated turn (no acting user → refusal)', async () => {
    await setAccessibility('on');
    const r = await run(ACCESSIBILITY_ALT_TEXT_TOOL_ID, { assetId: 'a1' }, {}); // no actingUserId
    expect(r.isError).toBe(true);
    expect(parse(r).error).toBe('acting_user_required');
  });

  it('alt-text: fail-closed with feature_disabled when the toggle is off', async () => {
    await setAccessibility('off');
    const r = await run(ACCESSIBILITY_ALT_TEXT_TOOL_ID, { assetId: 'a1' }, { actingUserId: 'user:x' });
    expect(r.isError).toBe(true);
    expect(parse(r).error).toBe('feature_disabled');
    await setAccessibility('on');
  });
});

describe('ctx.features.accessibility surface is auto-advertised (ADR 0363 P3)', () => {
  it('/.well-known/openwop lists host.sample.accessibility', async () => {
    const res = await fetch(`${BASE}/.well-known/openwop`);
    expect(res.status).toBe(200);
    const doc = await res.json() as { hostExtensions?: { featureSurfaces?: string[] } };
    expect(doc.hostExtensions?.featureSurfaces).toContain('host.sample.accessibility');
  });
});
