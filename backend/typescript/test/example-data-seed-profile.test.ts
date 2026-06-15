/**
 * Demo-seed → agentProfile persistence (ADR 0031 §1c / T1.2).
 *
 * The seed path now writes a rich `agentProfile` (ADR 0031) for every demo
 * persona that authors one in `exampleAgents.json`, keyed by the new member's
 * `rosterId`. Coverage:
 *
 *  1. A first seed persists each persona's profile; it is retrievable via
 *     `GET /v1/host/openwop-app/agents/:rosterId/profile` with the authored
 *     governance fields and the autonomy `level` DERIVED from `specLevel`,
 *     consistent with the roster member's own `autonomyLevel`.
 *  2. A silent re-seed does NOT duplicate (the profile key is the rosterId) —
 *     the same single profile round-trips unchanged.
 *  3. `heal: true` BACKFILLS a profile that went missing (a tenant seeded
 *     before this feature), while a silent re-seed does NOT (heal-gated,
 *     mirroring board/schedule heal semantics).
 *
 * Fixed-`default`-tenant posture (cookies disabled), same device the
 * demo-seed dedup/cascade test uses.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { __resetAgentProfileStore } from '../src/host/agentProfileService.js';

let server: http.Server;
const PORT = 18793;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'dev-token';

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

interface RosterEntry { rosterId: string; persona: string; roleKey?: string; autonomyLevel?: 'auto' | 'guided' | 'review' }
interface ProfileResp {
  profileId: string;
  roleKey: string;
  autonomy: { level: 'auto' | 'guided' | 'review'; specLevel: string; withinPolicyActions?: string[] };
  permissions?: { read: string[]; write: string[]; never: string[] };
  hitl?: string[];
  requiredConnections?: string[];
  metrics?: string[];
  createdAt: string;
  updatedAt: string;
}

async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: (text.length ? JSON.parse(text) : null) as T };
}
const seed = (body: unknown = {}): Promise<{ status: number; body: { seeded: boolean } }> =>
  api('/v1/host/openwop-app/example-data/seed', { method: 'POST', body: JSON.stringify(body) });
const roster = async (): Promise<RosterEntry[]> => (await api<{ roster: RosterEntry[] }>('/v1/host/openwop-app/roster')).body.roster;
const profileOf = (rosterId: string): Promise<{ status: number; body: ProfileResp }> =>
  api(`/v1/host/openwop-app/agents/${encodeURIComponent(rosterId)}/profile`);

describe('demo-seed → agentProfile persistence (ADR 0031 §1c)', () => {
  it('persists a retrievable profile per seeded persona, level derived from specLevel', async () => {
    expect((await seed()).body.seeded).toBe(true);
    const entries = await roster();
    expect(entries.length).toBe(10); // 8 twins + Iris + Executive Operations (ADR 0032)

    // Every seeded persona has a profile (all ten author one).
    for (const e of entries) {
      const { status, body } = await profileOf(e.rosterId);
      expect(status).toBe(200);
      expect(body.profileId).toBe(e.rosterId);        // keyed by rosterId
      expect(body.roleKey).toBe(e.roleKey);           // single-sourced from the SeedAgent
      // The enforced roster level the profile carries matches the member's own
      // autonomy (undefined roster level == 'auto').
      expect(body.autonomy.level).toBe(e.autonomyLevel ?? 'auto');
    }

    // Spot-check a `recommend` twin (Sales Execution → derived review) survived.
    const sales = entries.find((e) => e.roleKey === 'sales-execution');
    expect(sales).toBeDefined();
    const salesProfile = (await profileOf(sales!.rosterId)).body;
    expect(salesProfile.autonomy.specLevel).toBe('recommend');
    expect(salesProfile.autonomy.level).toBe('review');
    expect(salesProfile.permissions?.never).toContain('email.send');
    expect(salesProfile.requiredConnections).toContain('google');

    // And a within-policy twin (IT Service Desk → derived guided) keeps its allowlist.
    const it = entries.find((e) => e.roleKey === 'it-service-desk');
    expect(it).toBeDefined();
    const itProfile = (await profileOf(it!.rosterId)).body;
    expect(itProfile.autonomy.specLevel).toBe('execute-with-approval');
    expect(itProfile.autonomy.level).toBe('guided');
    expect(itProfile.autonomy.withinPolicyActions).toContain('ticket.tag');
  });

  it('silent re-seed does not duplicate — one profile per rosterId, unchanged', async () => {
    const before = await roster();
    const sales = before.find((e) => e.roleKey === 'sales-execution')!;
    const first = (await profileOf(sales.rosterId)).body;

    expect((await seed()).body.seeded).toBe(false); // already initialized → no-op
    const after = await roster();
    expect(after.length).toBe(before.length);       // no duplicate personas

    const second = (await profileOf(sales.rosterId)).body;
    expect(second.profileId).toBe(first.profileId);
    expect(second.createdAt).toBe(first.createdAt);  // same row, not re-created
  });

  it('heal:true backfills a missing profile; a silent re-seed does not', async () => {
    const entries = await roster();
    const iris = entries.find((e) => e.roleKey === 'chief-of-staff')!;
    expect((await profileOf(iris.rosterId)).status).toBe(200);

    // Simulate a tenant seeded before this feature: roster exists, profiles gone.
    await __resetAgentProfileStore();
    expect((await profileOf(iris.rosterId)).status).toBe(404);

    // Silent re-seed must NOT backfill (deletions/absence are respected).
    expect((await seed()).body.seeded).toBe(false);
    expect((await profileOf(iris.rosterId)).status).toBe(404);

    // Explicit heal restores every missing profile.
    const healed = await seed({ heal: true });
    expect(healed.status).toBe(200);
    const restored = await profileOf(iris.rosterId);
    expect(restored.status).toBe(200);
    expect(restored.body.profileId).toBe(iris.rosterId);
    expect(restored.body.autonomy.level).toBe('review'); // recommend → review
  });
});
