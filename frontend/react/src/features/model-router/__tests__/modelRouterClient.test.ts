/**
 * ADR 0130 Phase 5 / ADR 1016 D1-D2 — the model-router client reads the WORKSPACE
 * config: it unwraps the `{ config, canManage }` envelope, reads a `null` config as
 * "none saved yet", and calls the workspace path (no organization in it — a
 * per-org config was never read by a chat).
 *
 * Breaks if the envelope is returned un-unwrapped, a `null` config stops reading
 * as "none set yet", `canManage` defaults to true when the server omits it (the
 * page would offer writes the server refuses), or the client goes back to an
 * `/orgs/:orgId/` path (or any other path than the exact workspace URL).
 * Re-graded /grade-tests wave 108 (TST-ARA-8): probes on the path, the unwrap,
 * the null read and the `canManage` default.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getRouterConfig, type StoredRouterConfig } from '../modelRouterClient.js';
import { config as clientConfig } from '../../../client/config.js';

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

afterEach(() => { vi.unstubAllGlobals(); });

describe('getRouterConfig', () => {
  it('returns stored:null when no config exists yet, at the workspace path', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ config: null, canManage: true }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await getRouterConfig()).toEqual({ stored: null, canManage: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Exact URL (a suffix match passes a path with an extra segment in front).
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toBe(`${clientConfig.baseUrl}/host/openwop-app/model-router/config`);
    expect(url).not.toContain('/orgs/');
  });

  it('unwraps the stored config envelope; canManage is false unless the server says true', async () => {
    const config: StoredRouterConfig = { enabled: true, config: { rules: [] } };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ config })));
    expect(await getRouterConfig()).toEqual({ stored: config, canManage: false });
  });
});
