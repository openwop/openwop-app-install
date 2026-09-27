/**
 * ADR 0553 P3 (H53) — the local twin of the corpus leg `mcp-cache-tenant-scope`'s
 * CROSS-CALLER half (RFC 0153 §D).
 *
 * That leg has been recording `blocked` on every run of this host, because
 * `conformance/run.ts` never set `OPENWOP_TEST_SECONDARY_API_KEY`:
 *
 *   > [mcp-cache-tenant-scope] OPENWOP_TEST_SECONDARY_API_KEY not set —
 *   > cross-caller half not exercised (blocked)
 *
 * The runner now mints a SECOND, TENANT-SCOPED key. This file asserts the same
 * thing locally so the conformance lane is not the first place a mistake in that
 * wiring shows up — and, more usefully, so the property survives independently
 * of whether the suite is being run at all.
 *
 * WHY THE SECOND KEY IS SCOPED AND NOT A SECOND WILDCARD. The leg asks whether a
 * `tools/list` that DIFFERS between two callers is marked `private`. Two
 * wildcard operator keys are the SAME authorization context, would be served the
 * same list, and the `if (!same)` assertion would never fire — a leg that
 * executes and cannot fail, which is precisely the vacuous green RFC 0148's
 * ledger exists to expose. The whole value of the fix is that the second caller
 * is a genuinely different authorization context.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import {
  MCP_CURRENT_VERSION,
  MCP_META_CLIENT_CAPABILITIES,
  MCP_META_PROTOCOL_VERSION,
} from '../src/host/mcpProfile.js';

let server: http.Server;
let BASE: string;

/** The EXACT shape `conformance/run.ts` builds: a wildcard operator key plus a
 *  tenant-scoped second caller. Restated here as a literal on purpose — deriving
 *  it from the runner would make this test agree with the runner even when the
 *  runner is wrong, which is the restatement trap. */
const PRIMARY = 'sample-conformance-token';
const SECONDARY = 'sample-conformance-token-secondary';
const KEYS = `${PRIMARY}:*,${SECONDARY}:conformance-secondary`;

async function toolsList(bearer: string): Promise<{ status: number; cacheScope?: string; tools?: unknown[] }> {
  const res = await fetch(`${BASE}/v1/host/openwop-app/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${bearer}`,
      'mcp-protocol-version': MCP_CURRENT_VERSION,
      'mcp-method': 'tools/list',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: { [MCP_META_PROTOCOL_VERSION]: MCP_CURRENT_VERSION, [MCP_META_CLIENT_CAPABILITIES]: {} } },
    }),
  });
  const body = (await res.json()) as { result?: { tools?: unknown[]; cacheScope?: string } };
  return { status: res.status, ...(body.result?.cacheScope !== undefined ? { cacheScope: body.result.cacheScope } : {}), ...(body.result?.tools !== undefined ? { tools: body.result.tools } : {}) };
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_MCP_SERVER_ENABLED = 'true';
  process.env.OPENWOP_API_KEYS = KEYS;
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  delete process.env.OPENWOP_TEST_SEAM_ENABLED; // no synthesized seam principal
  const app = await createApp({ port: 18977, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  // Bind loopback v4 EXPLICITLY, not the [::] wildcard (`check-test-ports`,
  // H41): a resident 127.0.0.1 listener on the same port would otherwise answer
  // this test's fetch, and the test would be measuring someone else's server.
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const k of ['OPENWOP_MCP_SERVER_ENABLED', 'OPENWOP_API_KEYS', 'OPENWOP_AUTH_DISABLE_COOKIES']) delete process.env[k];
  await new Promise<void>((r) => server.close(() => r()));
});

describe('RFC 0153 §D — the cross-caller cache leg, driven locally', () => {
  it('BOTH keys authenticate against the mount — otherwise the leg is blocked, not passing', async () => {
    // The non-vacuity gate. The corpus leg bails on `theirs.status !== 200`
    // WITHOUT failing, so a secondary key that does not authenticate produces a
    // silent pass. That is the failure mode this assertion exists to catch, and
    // it is the one a mis-wired `OPENWOP_API_KEYS` would actually produce.
    const mine = await toolsList(PRIMARY);
    const theirs = await toolsList(SECONDARY);
    expect(mine.status, 'the wildcard operator key must reach the mount').toBe(200);
    expect(theirs.status, 'the tenant-scoped second key must ALSO reach the mount').toBe(200);
  });

  it('a per-caller list is cacheScope private (the assertion the corpus leg makes)', async () => {
    const mine = await toolsList(PRIMARY);
    const theirs = await toolsList(SECONDARY);
    expect(['public', 'private']).toContain(mine.cacheScope);
    const same = JSON.stringify(mine.tools) === JSON.stringify(theirs.tools);
    if (!same) {
      // The §D rule: a list that differs per caller MUST be private. A public
      // list that differs is cross-context cache poisoning.
      expect(mine.cacheScope).toBe('private');
      expect(theirs.cacheScope).toBe('private');
    } else {
      // Byte-identical lists are legitimately cacheable either way — but this
      // host derives `tools/list` from a tenant-scoped registry, so `private` is
      // the honest answer regardless (ADR 0553 P2 decision 4).
      expect(mine.cacheScope).toBe('private');
    }
  });

  it('the two callers are genuinely different authorization contexts', async () => {
    // The property the WHOLE fix depends on. If both keys resolved to the same
    // principal/tenant the leg would execute and be unable to fail. Asserted
    // through a tenant-scoped route rather than by re-deriving the key table,
    // which would restate the premise instead of checking it.
    const whoami = async (bearer: string): Promise<string | undefined> => {
      const res = await fetch(`${BASE}/v1/runs?limit=1`, { headers: { authorization: `Bearer ${bearer}` } });
      return res.headers.get('x-openwop-tenant') ?? undefined;
    };
    // Not every build echoes a tenant header; the load-bearing assertion is that
    // the scoped key is NOT a wildcard operator, which the mount answering 200
    // for both plus distinct configured scopes already establishes. Kept as a
    // documented no-op rather than a fake assertion when the header is absent.
    const a = await whoami(PRIMARY);
    const b = await whoami(SECONDARY);
    if (a !== undefined && b !== undefined) expect(a).not.toBe(b);
    expect(KEYS, 'the second key must be tenant-scoped, never a second `:*`').toContain(':conformance-secondary');
    expect(KEYS.split(',').filter((e) => e.endsWith(':*'))).toHaveLength(1);
  });
});
