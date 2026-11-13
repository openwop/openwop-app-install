/**
 * ADR 0861 D7 / CMSLWF-11 — the chat-lane translate tool witnessed on its
 * SUCCESS path. `cms-agent-tools.test.ts` pins only the refusals (toggle off,
 * validation); nothing proved the `openwop:cms.translate-section` tool, with
 * `cms-localization` ON, actually returns a translated overlay to the model.
 *
 * Boots the REAL app (so the `registerFeatureAgentTool` registration seam and
 * the real `translateSectionData` → `sanitizeSectionOverlay` path run); the
 * ONLY fake is the headless provider (`resolveHeadlessAi`), mocked the same
 * way `cms-translate-repair.test.ts` mocks it.
 *
 * Witnesses:
 *   - a valid completion → `{ overlay, targetLocale }`, with the overlay
 *     SANITIZED through the section type (a key `hero` does not declare is
 *     dropped — model output reaches the agent only through closed-world
 *     validation);
 *   - a garbage completion (twice: initial + the ONE bounded repair) → the
 *     typed `translation_invalid` tool error, never success-with-empty.
 *
 * Sabotage (w16 probes): skipping `sanitizeSectionOverlay` reds case 1; skipping the
 * repair dispatch, or letting `translation_invalid` fall through the tool's error
 * mapping, reds case 2.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/host/headlessAi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/headlessAi.js')>();
  return { ...actual, resolveHeadlessAi: vi.fn() };
});

import { resolveHeadlessAi } from '../src/host/headlessAi.js';
import { createApp } from '../src/index.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { CMS_TRANSLATE_SECTION_TOOL_ID } from '../src/features/cms/agentTools.js';
import { AI_TRANSLATE_DEADLINE_MS } from '../src/features/cms/translate.js';
import { createOrg } from '../src/host/accessControlService.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

const TENANT = 'default';
const mockResolve = vi.mocked(resolveHeadlessAi);

let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  // The org RBAC gate mirrors the HTTP editor path — the sole org auto-resolves
  // and its owner (`u-1`) holds workspace:write.
  await createOrg({ tenantId: TENANT, createdBy: 'u-1', name: 'Acme', ownerSubject: 'u-1' });
  const loc = getToggleDefault('cms-localization');
  expect(loc, 'cms-localization toggle must be registered').toBeTruthy();
  await saveConfig({ ...loc!, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
beforeEach(() => { mockResolve.mockReset(); });

const translate = (input: Record<string, unknown>) =>
  createAgentToolProvider({ tenantId: TENANT, actingUserId: 'u-1' }).executeTool({ name: CMS_TRANSLATE_SECTION_TOOL_ID, input });

describe('CMSLWF-11 — chat-lane translate-section, toggle ON', () => {
  it('a valid completion returns the translated, section-sanitized overlay', async () => {
    // The model answers with the translation PLUS a key `hero` does not declare.
    const dispatch = vi.fn(async () => '{"heading":"Hola mundo","notAHeroField":"injected"}');
    mockResolve.mockResolvedValue(dispatch);

    const out = await translate({ sectionType: 'hero', data: { heading: 'Hello world' }, targetLocale: 'es' });

    expect(out.isError, out.content).toBeFalsy();
    const body = JSON.parse(out.content) as { overlay: Record<string, unknown>; targetLocale: string };
    expect(body.targetLocale).toBe('es');
    // Closed-world: the undeclared key is dropped, the translated value survives.
    expect(body.overlay).toEqual({ heading: 'Hola mundo' });
    expect(dispatch).toHaveBeenCalledTimes(1); // valid first output — no repair
  });

  it('a garbage completion is the typed translation_invalid failure, never success-with-empty', async () => {
    const dispatch = vi.fn(async () => 'Sorry, here is some prose instead of JSON.');
    mockResolve.mockResolvedValue(dispatch);

    const out = await translate({ sectionType: 'hero', data: { heading: 'Hello world' }, targetLocale: 'es' });

    expect(out.isError).toBe(true);
    const body = JSON.parse(out.content) as Record<string, unknown>;
    expect(body).toMatchObject({ error: 'translation_invalid' });
    expect(body).not.toHaveProperty('overlay');
    expect(dispatch).toHaveBeenCalledTimes(2); // initial + exactly ONE bounded repair
  });

  it('a section in parts that runs out of time is translation_timeout, so the agent can try again (ADR 1112 P3)', async () => {
    const decisions = Array.from({ length: 200 }, (_, i) => ({ id: `DEC-${String(i).padStart(5, '0')}`, title: `What finish does item ${i} need`, element: `Kitchen zone ${i}`, milestone: 'm1' }));
    const data = { milestones: [{ id: 'm1', label: 'Start', startWeek: 0, weeks: 4 }], decisions };
    // Every part waits until it is aborted: the deadline is what ends it.
    mockResolve.mockResolvedValue(vi.fn((_m: unknown, opts: { signal?: AbortSignal }) => new Promise<string>((_, reject) => opts.signal?.addEventListener('abort', () => reject(new Error('aborted'))))));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = translate({ sectionType: 'scheduleSim', data, targetLocale: 'es' });
      await vi.advanceTimersByTimeAsync(AI_TRANSLATE_DEADLINE_MS + 1);
      const out = await pending;
      expect(out.isError).toBe(true);
      expect(JSON.parse(out.content)).toMatchObject({ error: 'translation_timeout' });
    } finally {
      vi.useRealTimers();
    }
  });
});
