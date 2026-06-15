/**
 * Legacy-persona migration on reconcile (ADR 0032 §"Migration / idempotency" / T2.A).
 *
 * ADR 0032 retires the five legacy demo personas (Sally/Marcus/Priya/Devon/Nora)
 * in favour of the ten canonical work-twins. A tenant seeded BEFORE the
 * reconciliation still carries the legacy personas; the demo seed must reconcile
 * them away — but only the demo-owned, untouched ones, and only on the explicit
 * `heal` path, never resurrecting a user-deleted one or clobbering user edits.
 *
 * This simulates a pre-reconciliation tenant by injecting legacy roster entries
 * directly (as the old seed would have), then asserts the heal prune:
 *   - a demo-owned legacy persona (name + original retired roleKey) is pruned;
 *   - a user-RE-ROLED legacy persona (same name, different roleKey) survives;
 *   - the silent path does NOT prune (heal-gated); the prune is idempotent.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { createRosterEntry, listRoster } from '../src/host/rosterService.js';

let server: http.Server;
const PORT = 18795;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'dev-token';
const TENANT = 'default';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true'; // single fixed 'default' tenant
  const app = await createApp({
    port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false,
  });
  await new Promise<void>((res) => { server = app.listen(PORT, res); });
});

afterAll(async () => {
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  await new Promise<void>((res) => server.close(() => res()));
});

async function seed(body: unknown = {}): Promise<{ status: number; body: { healed?: { prunedLegacy: number } } }> {
  const res = await fetch(`${BASE}/v1/host/openwop-app/example-data/seed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { healed?: { prunedLegacy: number } } };
}
const personas = async (): Promise<string[]> => (await listRoster(TENANT)).map((e) => e.persona);

describe('legacy-persona migration on reconcile (ADR 0032 / T2.A)', () => {
  it('heal prunes demo-owned legacy personas; spares user-re-roled; never resurrects', async () => {
    // A fresh tenant first seeds the ten-twin canonical set (stamps the marker).
    await seed();
    expect((await personas()).length).toBe(10);

    // Simulate a pre-reconciliation tenant: inject legacy personas as the old
    // seed would have. Sally + Marcus are demo-owned (name + original roleKey).
    // "Devon" was RE-ROLED by the user (kept the name, changed the roleKey) — it
    // must survive the prune.
    await createRosterEntry({ tenantId: TENANT, persona: 'Sally', agentRef: { agentId: 'user.default.sally' }, workflows: [], roleKey: 'sales-ops' });
    await createRosterEntry({ tenantId: TENANT, persona: 'Marcus', agentRef: { agentId: 'user.default.marcus' }, workflows: [], roleKey: 'support-triage' });
    await createRosterEntry({ tenantId: TENANT, persona: 'Devon', agentRef: { agentId: 'user.default.devon' }, workflows: [], roleKey: 'my-custom-role' });
    expect((await personas()).sort()).toContain('Sally');
    expect((await personas()).length).toBe(13); // 10 twins + 3 injected

    // Silent re-seed must NOT reconcile (heal-gated — respects user curation).
    const silent = await seed();
    expect(silent.body.healed).toBeUndefined();
    expect((await personas())).toContain('Sally');
    expect((await personas())).toContain('Marcus');

    // Explicit heal prunes the two demo-owned legacy personas; the re-roled
    // "Devon" survives (its roleKey no longer matches the retired pair).
    const healed = await seed({ heal: true });
    expect(healed.status).toBe(200);
    expect(healed.body.healed?.prunedLegacy).toBe(2);
    const after = await personas();
    expect(after).not.toContain('Sally');
    expect(after).not.toContain('Marcus');
    expect(after).toContain('Devon');        // user-re-roled → spared
    expect(after.length).toBe(11);           // 10 twins + the surviving re-roled Devon

    // Idempotent: a second heal finds no legacy left to prune, and the silent
    // path never resurrects the pruned personas.
    const again = await seed({ heal: true });
    expect(again.body.healed?.prunedLegacy).toBe(0);
    expect(await personas()).not.toContain('Sally');
  });
});
