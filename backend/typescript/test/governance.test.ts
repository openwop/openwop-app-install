/**
 * ADR 0028 — admin governance (ADR 0023 §12 T7):
 *   - policy CRUD on /v1/host/openwop-app/governance/policy, superadmin-gated
 *     (shared host/superadmin.ts gate — a signed-in NON-admin is 403);
 *   - the provider allowlist enforced with ONE predicate at BOTH seams:
 *     connect routes (403) and resolveConnectionCredential — the choke point
 *     every broker consumer (http egress seam, Slack adapter) flows through —
 *     fail-closed null; a policy added after a connection exists wins;
 *   - per-kind action policy at the assistant seams: 'disabled' refuses
 *     enqueue; 'draft-only' records the human decision but dispatches
 *     nothing (audited);
 *   - the audit READ VIEW composes storage.appendAudit rows (no new store).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { __clearToggleStore } from '../src/host/featureToggles/service.js';
import { __resetConnectionsStore, resolveConnectionCredential } from '../src/features/connections/connectionsService.js';
import { __resetGovernanceStore, setGovernancePolicy } from '../src/host/governanceService.js';
import { __resetAssistantStore, getPendingAction } from '../src/features/assistant/assistantService.js';
import { enqueueActionWithApproval, decideActionViaApproval } from '../src/features/assistant/actionApproval.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';

let BASE: string;
const TOKEN = 'dev-token';
const TENANT = 'default';

let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await __clearToggleStore();
  await __resetConnectionsStore();
  await __resetGovernanceStore();
  await __resetAssistantStore();
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  // Connections is toggle-less (permanent admin surface, ADR 0024 § Correction);
  // only the assistant feature still gates on a toggle.
  const on = await jf('/v1/host/openwop-app/feature-toggles/admin/configs/assistant', {
    method: 'PUT',
    body: JSON.stringify({ status: 'on', bucketUnit: 'tenant', salt: 'assistant' }),
  });
  if (on.status !== 200) throw new Error('assistant toggle enable failed');
});
afterAll(async () => {
  delete process.env.OPENWOP_TEST_AUTH_ENABLED;
  await new Promise<void>((res) => server.close(() => res()));
});

/** Extract the `__session` cookie across however many Set-Cookie headers the
 *  login response carries. The login flow sets TWO `__session` cookies (the
 *  anon bootstrap first, then the user session) — take the LAST, which is
 *  what a browser would retain. */
function sessionCookieOf(res: Response): string {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  const all: string[] = typeof h.getSetCookie === 'function' ? h.getSetCookie() : [res.headers.get('set-cookie') ?? ''];
  let found = '';
  for (const sc of all) {
    const m = /(__session=[^;]+)/.exec(sc);
    if (m) found = m[1]!;
  }
  return found;
}

async function jf<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...((init.headers as Record<string, string>) ?? {}) },
  });
  const raw = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  return { status: res.status, body: raw as T };
}

describe('policy administration', () => {
  it('superadmin can read defaults and upsert; validation rejects unknown kinds; a signed-in non-admin is 403', async () => {
    const empty = await jf<{ policy: { tenantId: string }; defaults: Record<string, unknown> }>('/v1/host/openwop-app/governance/policy');
    expect(empty.status).toBe(200);
    expect(empty.body.defaults.actionPolicy).toBe('approval-required');

    const bad = await jf('/v1/host/openwop-app/governance/policy', {
      method: 'PUT',
      body: JSON.stringify({ actionPolicy: { 'rm.rf': 'disabled' } }),
    });
    expect(bad.status).toBe(400);

    const put = await jf<{ policy: { providerAllowlist: string[] } }>('/v1/host/openwop-app/governance/policy', {
      method: 'PUT',
      body: JSON.stringify({ providerAllowlist: ['google'], actionPolicy: { 'email.send': 'draft-only' } }),
    });
    expect(put.status).toBe(200);
    expect(put.body.policy.providerAllowlist).toEqual(['google']);

    // A real signed-in user without superadmin standing: fail closed.
    const login = await fetch(`${BASE}/v1/host/openwop-app/test/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'gov-nonadmin@example.com' }),
    });
    expect(login.status).toBe(201);
    const cookie = sessionCookieOf(login);
    expect(cookie).toBeTruthy();
    const denied = await fetch(`${BASE}/v1/host/openwop-app/governance/policy`, { headers: { cookie } });
    expect(denied.status).toBe(403);

    await __resetGovernanceStore(); // leave no policy behind for later suites
  });

  it('GOV-2: the admin route persists the retention windows the sweep enforces, and rejects a negative window', async () => {
    // The sweep daemon enforces `confidentialPiiDays` / `internalDays`; before GOV-2 the
    // route dropped them, so they could never be set via the API. Assert they round-trip.
    const put = await jf<{ policy: { retention?: { confidentialPiiDays?: number; internalDays?: number } } }>(
      '/v1/host/openwop-app/governance/policy',
      { method: 'PUT', body: JSON.stringify({ retention: { confidentialPiiDays: 365, internalDays: 90 } }) },
    );
    expect(put.status).toBe(200);
    expect(put.body.policy.retention).toMatchObject({ confidentialPiiDays: 365, internalDays: 90 });

    const got = await jf<{ policy: { retention?: { confidentialPiiDays?: number } } }>('/v1/host/openwop-app/governance/policy');
    expect(got.body.policy.retention?.confidentialPiiDays).toBe(365);

    // A negative window would push the sweep's cutoff into the future and purge everything.
    const bad = await jf('/v1/host/openwop-app/governance/policy', {
      method: 'PUT',
      body: JSON.stringify({ retention: { confidentialPiiDays: -1 } }),
    });
    expect(bad.status).toBe(400);

    await __resetGovernanceStore();
  });

  it('COS-2: a LEGACY row carrying a dead retention window still round-trips GET → edit → PUT', async () => {
    // The regression this exists to prevent. COS-2 removed `assistantGraphDays`
    // / `sourceDerivedDays` (declared, settable, read by nothing) and left them
    // on already-persisted rows. Refusing them on the way in — the first attempt
    // — made GET → edit → PUT hard-400 on every such tenant, blocking EVERY
    // OTHER governance change until an operator hand-stripped a field the API
    // itself had just handed them.
    await __resetGovernanceStore();
    // Seed a legacy row THROUGH THE SERVICE (the route can no longer create
    // one), which is exactly the shape a pre-COS-2 tenant has on disk.
    await setGovernancePolicy(TENANT, {
      retention: { confidentialPiiDays: 365, assistantGraphDays: 30 } as never,
    }, 'seed');

    type P = { policy: { retention?: Record<string, unknown>; providerAllowlist?: string[] }; warnings?: string[] };
    const got = await jf<P>('/v1/host/openwop-app/governance/policy');
    expect(got.status).toBe(200);
    // The dead window is not advertised back — a control that does nothing must
    // not look like one that does.
    expect(got.body.policy.retention?.assistantGraphDays).toBeUndefined();
    expect(got.body.policy.retention?.confidentialPiiDays).toBe(365);
    expect(got.body.warnings?.join(' '), 'the operator must learn WHY it vanished').toMatch(/assistantGraphDays/);

    // …and a client that DOES echo the legacy field back (a script holding an
    // older GET) still gets its unrelated edit applied.
    const put = await jf<P>('/v1/host/openwop-app/governance/policy', {
      method: 'PUT',
      body: JSON.stringify({
        providerAllowlist: ['openai'],
        retention: { confidentialPiiDays: 365, assistantGraphDays: 30 },
      }),
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.policy.providerAllowlist, 'the OTHER edit must land').toEqual(['openai']);
    expect(put.body.policy.retention?.assistantGraphDays, 'the dead window must not be re-persisted').toBeUndefined();
    expect(put.body.policy.retention?.confidentialPiiDays).toBe(365);
    expect(put.body.warnings?.join(' ')).toMatch(/confidentialPiiDays/);

    await __resetGovernanceStore();
  });

  it('BRAND-CODE-6: the admin route persists the tenant-default brandCompliance policy (set → get), and rejects a bad blockPublish', async () => {
    await __resetGovernanceStore();
    type P = { policy: { brandCompliance?: { blockPublish?: string; blockThreshold?: number; defaultBrandId?: string } } };
    const put = await jf<P>('/v1/host/openwop-app/governance/policy', {
      method: 'PUT',
      body: JSON.stringify({ brandCompliance: { blockPublish: 'threshold', blockThreshold: 70, defaultBrandId: 'brand-1' } }),
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.policy.brandCompliance).toMatchObject({ blockPublish: 'threshold', blockThreshold: 70, defaultBrandId: 'brand-1' });

    const got = await jf<P>('/v1/host/openwop-app/governance/policy');
    expect(got.body.policy.brandCompliance).toMatchObject({ blockPublish: 'threshold', blockThreshold: 70, defaultBrandId: 'brand-1' });

    // An invalid blockPublish is rejected.
    const bad = await jf('/v1/host/openwop-app/governance/policy', {
      method: 'PUT',
      body: JSON.stringify({ brandCompliance: { blockPublish: 'nonsense' } }),
    });
    expect(bad.status).toBe(400);

    // `null` clears it.
    const cleared = await jf<P>('/v1/host/openwop-app/governance/policy', {
      method: 'PUT',
      body: JSON.stringify({ brandCompliance: null }),
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.policy.brandCompliance).toBeUndefined();

    await __resetGovernanceStore();
  });

  it('BRAND-CODE-6: the sibling media-budget + byok-chat-budget PUTs PRESERVE a set brandCompliance (cross-route read-modify-write)', async () => {
    await __resetGovernanceStore();
    type P = { policy: { brandCompliance?: { blockPublish?: string; defaultBrandId?: string } } };
    // Seed the tenant-default brand policy via the main policy PUT.
    await jf('/v1/host/openwop-app/governance/policy', {
      method: 'PUT',
      body: JSON.stringify({ brandCompliance: { blockPublish: 'critical', defaultBrandId: 'brand-1' } }),
    });
    // A media-budget PUT must not wipe it (its own read-modify-write path).
    await jf('/v1/host/openwop-app/governance/media-budget', { method: 'PUT', body: JSON.stringify({ ttsChars: 12 }) });
    const afterMedia = await jf<P>('/v1/host/openwop-app/governance/policy');
    expect(afterMedia.body.policy.brandCompliance).toMatchObject({ blockPublish: 'critical', defaultBrandId: 'brand-1' });
    // Nor a byok-chat-budget PUT.
    await jf('/v1/host/openwop-app/governance/byok-chat-budget', { method: 'PUT', body: JSON.stringify({ dailyTokenCap: 1000 }) });
    const afterByok = await jf<P>('/v1/host/openwop-app/governance/policy');
    expect(afterByok.body.policy.brandCompliance).toMatchObject({ blockPublish: 'critical', defaultBrandId: 'brand-1' });

    await __resetGovernanceStore();
  });
});

describe('media-budget readout (ADR 0106 Phase 3)', () => {
  it('superadmin reads configured budgets + usage; a signed-in non-admin is 403', async () => {
    process.env.OPENWOP_MEDIA_DAILY_TTS_CHARS = '100000';
    try {
      const r = await jf<{ date: string; budgets: { ttsChars: number; sttBytes: number }; usage: { ttsChars: number; sttBytes: number } }>(
        '/v1/host/openwop-app/governance/media-budget',
      );
      expect(r.status).toBe(200);
      expect(r.body.budgets.ttsChars).toBe(100000);
      expect(r.body.budgets.sttBytes).toBe(0); // unset ⇒ uncapped
      expect(r.body.usage).toEqual({ ttsChars: 0, sttBytes: 0, images: 0, video: 0 }); // ADR 0411 P2 — video unit
      expect(r.body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    } finally {
      delete process.env.OPENWOP_MEDIA_DAILY_TTS_CHARS;
    }

    const login = await fetch(`${BASE}/v1/host/openwop-app/test/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'media-nonadmin@example.com' }),
    });
    const cookie = sessionCookieOf(login);
    const denied = await fetch(`${BASE}/v1/host/openwop-app/governance/media-budget`, { headers: { cookie } });
    expect(denied.status).toBe(403);
  });
});

describe('media-budget editable override (ADR 0106)', () => {
  type Budget = { override: { ttsChars?: number; sttBytes?: number } | null; budgets: { ttsChars: number; sttBytes: number }; envDefaults?: { ttsChars: number; sttBytes: number } };

  it('superadmin sets a per-org override; GET reflects it as the effective cap', async () => {
    await __resetGovernanceStore();
    const put = await jf<Budget>('/v1/host/openwop-app/governance/media-budget', {
      method: 'PUT', body: JSON.stringify({ ttsChars: 4242, sttBytes: 0 }),
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.override).toEqual({ ttsChars: 4242, sttBytes: 0 });
    const get = await jf<Budget>('/v1/host/openwop-app/governance/media-budget');
    expect(get.body.budgets.ttsChars).toBe(4242); // effective = override
    expect(get.body.budgets.sttBytes).toBe(0);     // 0 = uncapped for this org
    expect(get.body.override).toEqual({ ttsChars: 4242, sttBytes: 0 });
    await __resetGovernanceStore();
  });

  it('ADR 0411 P2 — a video-generation override (videoJobs) roundtrips (previously unsettable: resolveBudget read the key with no route writer)', async () => {
    await __resetGovernanceStore();
    const put = await jf<{ status: number; override: { videoJobs?: number } | null; budgets: { video: number } }>('/v1/host/openwop-app/governance/media-budget', {
      method: 'PUT', body: JSON.stringify({ videoJobs: 25 }),
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.override).toEqual({ videoJobs: 25 });
    expect(put.body.budgets.video).toBe(25); // effective = override
    const get = await jf<{ budgets: { video: number }; override: { videoJobs?: number } | null }>('/v1/host/openwop-app/governance/media-budget');
    expect(get.body.budgets.video).toBe(25);
    expect(get.body.override?.videoJobs).toBe(25);
    await __resetGovernanceStore();
  });

  it('read-modify-write preserves OTHER policy fields (does not wipe the provider allowlist)', async () => {
    await __resetGovernanceStore();
    // set a provider allowlist via the policy route first
    await jf('/v1/host/openwop-app/governance/policy', { method: 'PUT', body: JSON.stringify({ providerAllowlist: ['github'] }) });
    // then set the media budget — must NOT drop the allowlist
    await jf('/v1/host/openwop-app/governance/media-budget', { method: 'PUT', body: JSON.stringify({ ttsChars: 10 }) });
    const policy = await jf<{ policy: { providerAllowlist?: string[]; mediaBudget?: { ttsChars?: number } } }>('/v1/host/openwop-app/governance/policy');
    expect(policy.body.policy.providerAllowlist).toEqual(['github']); // preserved
    expect(policy.body.policy.mediaBudget?.ttsChars).toBe(10);
    await __resetGovernanceStore();
  });

  it('rejects a negative budget (400) and a non-admin (403)', async () => {
    const bad = await jf('/v1/host/openwop-app/governance/media-budget', { method: 'PUT', body: JSON.stringify({ ttsChars: -1 }) });
    expect(bad.status).toBe(400);

    const login = await fetch(`${BASE}/v1/host/openwop-app/test/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'media-put-nonadmin@example.com' }),
    });
    const cookie = sessionCookieOf(login);
    const denied = await fetch(`${BASE}/v1/host/openwop-app/governance/media-budget`, {
      method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ttsChars: 5 }),
    });
    expect(denied.status).toBe(403);
  });
});

describe('byok-chat-budget editable override (ADR 0178)', () => {
  type ByokBudget = {
    override: { dailyTokenCap?: number; softWarningPct?: number } | null;
    budget: { dailyTokenCap: number; softWarningPct: number };
    envDefaults?: { dailyTokenCap: number };
  };

  it('superadmin sets a per-org override; GET reflects it as the effective cap + threshold', async () => {
    await __resetGovernanceStore();
    const put = await jf<ByokBudget>('/v1/host/openwop-app/governance/byok-chat-budget', {
      method: 'PUT', body: JSON.stringify({ dailyTokenCap: 50000, softWarningPct: 75 }),
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.override).toEqual({ dailyTokenCap: 50000, softWarningPct: 75 });
    expect(put.body.budget).toEqual({ dailyTokenCap: 50000, softWarningPct: 75 });

    const get = await jf<ByokBudget & { date: string }>('/v1/host/openwop-app/governance/byok-chat-budget');
    expect(get.body.budget.dailyTokenCap).toBe(50000); // effective = override
    expect(get.body.budget.softWarningPct).toBe(75);
    expect(get.body.override).toEqual({ dailyTokenCap: 50000, softWarningPct: 75 });
    await __resetGovernanceStore();
  });

  it('read-modify-write preserves OTHER policy fields (mediaBudget + retention)', async () => {
    await __resetGovernanceStore();
    // seed retention first (the policy PUT), then mediaBudget (its PUT preserves
    // retention) — so both are present before the byok PUT runs.
    await jf('/v1/host/openwop-app/governance/policy', { method: 'PUT', body: JSON.stringify({ retention: { internalDays: 30 } }) });
    await jf('/v1/host/openwop-app/governance/media-budget', { method: 'PUT', body: JSON.stringify({ ttsChars: 321 }) });
    // set the byok budget — must NOT drop mediaBudget or retention
    await jf('/v1/host/openwop-app/governance/byok-chat-budget', { method: 'PUT', body: JSON.stringify({ dailyTokenCap: 7 }) });
    const policy = await jf<{ policy: { mediaBudget?: { ttsChars?: number }; retention?: { internalDays?: number }; byokChatBudget?: { dailyTokenCap?: number } } }>('/v1/host/openwop-app/governance/policy');
    expect(policy.body.policy.mediaBudget?.ttsChars).toBe(321);      // preserved
    expect(policy.body.policy.retention?.internalDays).toBe(30);      // preserved
    expect(policy.body.policy.byokChatBudget?.dailyTokenCap).toBe(7);
    await __resetGovernanceStore();
  });

  it('rejects a non-integer/negative cap and an out-of-range pct (400) and a non-admin (403)', async () => {
    const badCap = await jf('/v1/host/openwop-app/governance/byok-chat-budget', { method: 'PUT', body: JSON.stringify({ dailyTokenCap: -1 }) });
    expect(badCap.status).toBe(400);
    const badFloat = await jf('/v1/host/openwop-app/governance/byok-chat-budget', { method: 'PUT', body: JSON.stringify({ dailyTokenCap: 1.5 }) });
    expect(badFloat.status).toBe(400);
    const badPct = await jf('/v1/host/openwop-app/governance/byok-chat-budget', { method: 'PUT', body: JSON.stringify({ softWarningPct: 150 }) });
    expect(badPct.status).toBe(400);

    const login = await fetch(`${BASE}/v1/host/openwop-app/test/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'byok-put-nonadmin@example.com' }),
    });
    const cookie = sessionCookieOf(login);
    const denied = await fetch(`${BASE}/v1/host/openwop-app/governance/byok-chat-budget`, {
      method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ dailyTokenCap: 5 }),
    });
    expect(denied.status).toBe(403);
    await __resetGovernanceStore();
  });
});

describe('provider allowlist — one predicate, both seams', () => {
  it('connect route 403s a non-allowlisted provider; the resolver withholds an EXISTING one (fail closed)', async () => {
    // Create a servicenow workspace connection while no policy restricts.
    const created = await jf<{ connectionId: string }>('/v1/host/openwop-app/connections', {
      method: 'POST',
      body: JSON.stringify({ provider: 'servicenow', kind: 'api_key', secret: 'sn-key-1234567', scope: 'workspace' }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    await setGovernancePolicy(TENANT, { providerAllowlist: ['google'] }, 'test-admin');

    // Seam 1 — connect route refuses new non-allowlisted connections.
    const refused = await jf('/v1/host/openwop-app/connections', {
      method: 'POST',
      body: JSON.stringify({ provider: 'zoom', kind: 'bearer', secret: 'z-token-1234567', scope: 'workspace' }),
    });
    expect(refused.status).toBe(403);

    // Seam 2 — the broker's resolve choke point (which the http egress seam
    // and the Slack adapter both flow through) withholds the EXISTING
    // servicenow connection: a policy added later still wins; fail closed.
    expect(await resolveConnectionCredential({ tenantId: TENANT, provider: 'servicenow' })).toBeNull();
    await setGovernancePolicy(TENANT, { providerAllowlist: ['google', 'servicenow'] }, 'test-admin');
    expect(await resolveConnectionCredential({ tenantId: TENANT, provider: 'servicenow' })).not.toBeNull();

    await __resetGovernanceStore();
  });
});

describe('per-kind action policy at the assistant seams', () => {
  it("'disabled' refuses enqueue; 'draft-only' records the decision but dispatches nothing (audited)", async () => {
    await setGovernancePolicy(TENANT, {
      actionPolicy: { 'email.send': 'disabled', 'calendar.invite': 'draft-only' },
    }, 'test-admin');

    await expect(
      enqueueActionWithApproval(TENANT, { kind: 'email.send', payload: {}, draft: 'never drafted' }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const action = await enqueueActionWithApproval(TENANT, {
      kind: 'calendar.invite',
      payload: { event: { summary: 'Q3 review' } },
      draft: 'Invite: Q3 review',
    });
    const decided = await decideActionViaApproval(TENANT, action.approvalId!, 'approved', { decidedByUserId: 'u-admin' });
    expect(decided?.changed).toBe(true);
    const row = await getPendingAction(TENANT, action.actionId);
    // COS-8: `draft-only` is a non-`approval-required` policy that suppresses the
    // send, so the honest terminal status is `suppressed`, not a misleading
    // `approved` (which would imply a send happened + inflate approvalRate). The
    // human's decision is recorded in the audit asserted below, not in the status.
    expect(row?.status).toBe('suppressed'); // decision recorded (audit below)…
    expect(row?.executionRunId).toBeUndefined(); // …nothing dispatched

    const audit = await __hostExtStorage()!.listAudit({ actionPrefix: 'assistant.action.execution_policy_skipped' });
    expect(audit.some((r) => r.resource === `assistant-action:${action.actionId}`)).toBe(true);

    await __resetGovernanceStore();
  });

  it('the audit read view serves assistant rows to the admin', async () => {
    const res = await jf<{ items: Array<{ action: string }> }>('/v1/host/openwop-app/governance/audit?actionPrefix=assistant.');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.some((i) => i.action.startsWith('assistant.action.'))).toBe(true);
  });

  it('a TENANT-SCOPED superadmin sees only its own tenant\'s audit rows (wildcard sees all)', async () => {
    const storage = __hostExtStorage()!;
    await storage.appendAudit({
      timestamp: new Date().toISOString(),
      action: 'assistant.action.approved',
      resource: 'assistant-action:other-tenant-row',
      payload: { approvalId: 'x', tenantId: 'tenant-b' },
    });

    // Wildcard bearer admin: unfiltered.
    const all = await jf<{ items: Array<{ payload?: { tenantId?: string } }> }>('/v1/host/openwop-app/governance/audit?actionPrefix=assistant.');
    expect(all.body.items.some((i) => i.payload?.tenantId === 'tenant-b')).toBe(true);

    // Tenant-scoped superadmin (OPENWOP_SUPERADMIN_TENANTS, the documented
    // prod mechanism) via a real session: only rows stamped with THEIR
    // tenant; foreign + unstamped rows withheld (fail closed).
    const ADMIN_TENANT = 'tenant-scoped-admin';
    await storage.appendAudit({
      timestamp: new Date().toISOString(),
      action: 'assistant.action.rejected',
      resource: 'assistant-action:own-tenant-row',
      payload: { approvalId: 'y', tenantId: ADMIN_TENANT },
    });
    process.env.OPENWOP_SUPERADMIN_TENANTS = ADMIN_TENANT;
    try {
      const login = await fetch(`${BASE}/v1/host/openwop-app/test/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'gov-tenant-admin@example.com', tenantId: ADMIN_TENANT }),
      });
      expect(login.status).toBe(201);
      const cookie = sessionCookieOf(login);
      expect(cookie).toBeTruthy();
      const scoped = await fetch(`${BASE}/v1/host/openwop-app/governance/audit?actionPrefix=assistant.`, { headers: { cookie } });
      expect(scoped.status).toBe(200);
      const body = (await scoped.json()) as { items: Array<{ payload?: { tenantId?: string } }> };
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.items.every((i) => i.payload?.tenantId === ADMIN_TENANT)).toBe(true);
    } finally {
      delete process.env.OPENWOP_SUPERADMIN_TENANTS;
    }
  });
});

describe('scheduler job metadata trust boundary (confused-deputy fix)', () => {
  it('strips spoofed actingUserId + attribution keys and stamps the authenticated principal', async () => {
    const created = await jf<{ job: { jobId: string; metadata?: Record<string, unknown> } } & { jobId?: string; metadata?: Record<string, unknown> }>(
      '/v1/host/openwop-app/scheduler/jobs',
      {
        method: 'POST',
        body: JSON.stringify({
          cronExpr: '0 9 * * *',
          workflowId: 'conformance-noop',
          metadata: {
            actingUserId: 'victim-user', // spoof attempt — must be overridden
            heartbeat: { rosterId: 'fake-roster' }, // attribution spoof — must be stripped
            schedule: { jobId: 'fake' }, // reserved — must be stripped
            note: 'legit free-form key survives',
          },
        }),
      },
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const raw = (created.body as Record<string, unknown>).job ?? created.body;
    const job = raw as { jobId: string; metadata?: Record<string, unknown> };
    expect(job.metadata?.actingUserId).toBeTruthy();
    expect(job.metadata?.actingUserId).not.toBe('victim-user');
    expect(job.metadata?.heartbeat).toBeUndefined();
    expect(job.metadata?.schedule).toBeUndefined();
    expect(job.metadata?.note).toBe('legit free-form key survives');
  });
});

describe('egress firewall rules (ADR 0187)', () => {
  it('superadmin reads default off, upserts allow/deny rules (normalized), and validates', async () => {
    const empty = await jf<{ mode: string; hosts: string[] }>('/v1/host/openwop-app/governance/egress-rules');
    expect(empty.status).toBe(200);
    expect(empty.body.mode).toBe('off');
    expect(empty.body.hosts).toEqual([]);

    const put = await jf<{ mode: string; hosts: string[] }>('/v1/host/openwop-app/governance/egress-rules', {
      method: 'PUT',
      body: JSON.stringify({ mode: 'allowlist', hosts: ['  API.Example.com ', 'example.com'] }),
    });
    expect(put.status).toBe(200);
    expect(put.body.mode).toBe('allowlist');
    expect(put.body.hosts).toEqual(['api.example.com', 'example.com']); // normalized + de-duped

    const get = await jf<{ mode: string; hosts: string[] }>('/v1/host/openwop-app/governance/egress-rules');
    expect(get.body.mode).toBe('allowlist');

    const badMode = await jf('/v1/host/openwop-app/governance/egress-rules', { method: 'PUT', body: JSON.stringify({ mode: 'nope', hosts: [] }) });
    expect(badMode.status).toBe(400);
    const badHosts = await jf('/v1/host/openwop-app/governance/egress-rules', { method: 'PUT', body: JSON.stringify({ mode: 'off', hosts: 'x' }) });
    expect(badHosts.status).toBe(400);
  });
});
