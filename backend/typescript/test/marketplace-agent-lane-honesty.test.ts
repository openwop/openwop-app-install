/**
 * UX_UPGRADE-marketplace R2 — MKT2-B1 on the AGENT lane.
 *
 * `marketplace.search` already annotates both of its empty answers: no acting
 * user, and feature-off. Its docstring states the rule outright — "Read tool:
 * fail EMPTY (annotated), never a probe" — and `cfp1-small-packs-agent-tools`
 * pins the acting-user one.
 *
 * The catalog-read failure was the third empty and the ONLY unannotated one.
 * That inverts the rule where it matters most: the two annotated empties are
 * states the model could infer anyway, while the unannotated one is the single
 * case where `[]` is not a fact about the catalog. A model receiving it reports
 * that nothing matched — a claim the failed read never established.
 */
import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

const failRead = { code: '' };
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    readdirSync: ((...args: Parameters<typeof actual.readdirSync>) => {
      if (failRead.code) {
        const e = new Error(`${failRead.code}: injected`) as NodeJS.ErrnoException;
        e.code = failRead.code;
        throw e;
      }
      return actual.readdirSync(...args);
    }) as typeof actual.readdirSync,
  };
});

import { createApp } from '../src/index.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { registerMarketplaceAgentTools, MARKETPLACE_SEARCH_TOOL_ID } from '../src/features/marketplace/agentTools.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

const TENANT = 'org:mkt-agent';

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  // The toggle resolver reads through storage, so the app has to be wired
  // before `saveConfig` means anything — without this the tool short-circuits
  // on "feature not enabled" and the test asserts the wrong empty.
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', res); });
  registerMarketplaceAgentTools();
  const d = getToggleDefault('marketplace');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
beforeEach(() => { failRead.code = ''; });
afterEach(() => { failRead.code = ''; });

const search = async () => {
  const { executeTool } = createAgentToolProvider({ tenantId: TENANT, actingUserId: 'u-1' });
  const out = await executeTool({ name: MARKETPLACE_SEARCH_TOOL_ID, input: {} });
  return { out, body: JSON.parse(out.content) as { listings?: unknown[]; note?: string } };
};

describe('MKT2-B1 (agent lane) — the one empty that is not an answer says so', () => {
  it('annotates the empty when the catalog cannot be READ', async () => {
    failRead.code = 'EACCES';
    const { out, body } = await search();

    // Still a read tool: it does not become a typed error / a probe.
    expect(out.isError, 'a read tool must not fail typed here').toBeFalsy();
    expect(body.listings, 'and it is still empty').toEqual([]);

    // The property under test — the model is told this is not an answer.
    expect(typeof body.note, 'the failed read must be annotated').toBe('string');
    expect(body.note, 'and must forbid the false claim, not merely hint').toMatch(/could not be read/i);
    expect(body.note).toMatch(/not|do not/i);
  });

  it('does NOT annotate a genuinely empty catalog (the negative control)', async () => {
    // Without this, "the failure is annotated" would be satisfied by a tool that
    // annotates EVERY empty, which would make the note meaningless — the model
    // could no longer tell a real empty catalog from an unreadable one.
    const { body } = await search();
    expect(Array.isArray(body.listings), 'the read succeeded').toBe(true);
    expect(body.note, 'a successful read carries no failure note').toBeUndefined();
  });
});
