/**
 * ADR 0363 P3 — the accessibility agent tools (chat-drivability seam) + the
 * auto-advertised `ctx.features.accessibility` surface. Booting the app runs
 * registerAccessibilityAgentTools() and registers the surface.
 *
 * `saveConfig` writes the toggle GLOBALLY (no tenant scope), so every case sets
 * it in `beforeEach` and the off cases restore the registered default in
 * `finally`.
 *
 * Tracker TST-BG1-21. Red when (probe-witnessed, wave 58): either tool stops
 * honouring the toggle; alt-text runs without an acting user; `check` stops
 * running the rules over the supplied model; the feature stops registering the
 * tools or the `accessibility` surface.
 */
import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider, builtinAgentToolIds } from '../src/host/agentToolProvider.js';
import { ACCESSIBILITY_CHECK_TOOL_ID, ACCESSIBILITY_ALT_TEXT_TOOL_ID } from '../src/features/accessibility/agentTools.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { registeredFeatureSurfaceIds } from '../src/host/featureSurfaces.js';

const TENANT = 'default';
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
});
afterAll(async () => {
  await restoreDefault();
  await new Promise<void>((res) => server.close(() => res()));
});

const setAccessibility = async (status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault('accessibility');
  if (!d) throw new Error('the accessibility toggle has no registered default');
  await saveConfig({ ...d, status }, 'test');
};
const restoreDefault = async (): Promise<void> => {
  const d = getToggleDefault('accessibility');
  if (d) await saveConfig(d, 'test');
};
beforeEach(async () => { await setAccessibility('on'); });
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
    const r = await run(ACCESSIBILITY_CHECK_TOOL_ID, { images: [{ alt: '' }], headings: [{ level: 1 }, { level: 4 }] });
    expect(r.isError).toBeFalsy();
    const body = parse(r);
    expect(body.count).toBe(2);
    expect((body.issues as { kind: string }[]).map((i) => i.kind).sort()).toEqual(['heading-skip', 'missing-alt']);
  });

  it('check: fail-closed with feature_disabled when the toggle is off', async () => {
    await setAccessibility('off');
    try {
      const r = await run(ACCESSIBILITY_CHECK_TOOL_ID, { images: [{ alt: '' }] });
      expect(r.isError).toBe(true);
      expect(parse(r)).toEqual({ error: 'feature_disabled', message: 'The Accessibility feature is not enabled for this workspace.' });
    } finally {
      await restoreDefault();
    }
  });

  it('alt-text: requires a human-initiated turn (no acting user → refusal)', async () => {
    const r = await run(ACCESSIBILITY_ALT_TEXT_TOOL_ID, { assetId: 'a1' }, {}); // no actingUserId
    expect(r.isError).toBe(true);
    expect(parse(r)).toEqual({ error: 'acting_user_required', message: 'Alt-text generation can only run from a human-initiated turn.' });
  });

  it('alt-text: fail-closed with feature_disabled when the toggle is off', async () => {
    await setAccessibility('off');
    try {
      const r = await run(ACCESSIBILITY_ALT_TEXT_TOOL_ID, { assetId: 'a1' }, { actingUserId: 'user:x' });
      expect(r.isError).toBe(true);
      expect(parse(r)).toEqual({ error: 'feature_disabled', message: 'The Accessibility feature is not enabled for this workspace.' });
    } finally {
      await restoreDefault();
    }
  });
});

describe('ctx.features.accessibility surface is auto-advertised (ADR 0363 P3)', () => {
  // ADR 0812 P3c-0: this read `hostExtensions.featureSurfaces` off the v1
  // discovery document; the v2 document has no such root, so it now asserts the
  // live registry that advertisement was derived from (populated by the boot).
  it('the booted app registers the accessibility feature surface', () => {
    expect(registeredFeatureSurfaceIds()).toContain('accessibility');
  });
});
