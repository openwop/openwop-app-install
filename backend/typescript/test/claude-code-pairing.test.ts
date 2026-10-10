/**
 * ADR 0785 P1 — Claude Code companion pairing, through the HTTP boundary.
 *
 * The exit gates the ADR names for P1, each pinned here:
 *   - pair → key → revoke round trip, with the key's authority DERIVED from the
 *     ADR 0270 developer key (revoking the device refuses the key's next request);
 *   - the operator gate: unset ⇒ every route 404s, public or signed in;
 *   - the minted key carries exactly `workspace:read` + `workspace:write` and
 *     NEVER `approvals:respond`;
 *   - an api-key principal cannot approve a pairing or manage devices (a key
 *     minting keys is an escalation path) — only a human session can;
 *   - the key is returned exactly once, even to two racing polls;
 *   - the only public surface is `/pair/device/*`.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { issueApiKey, verifyApiKey } from '../src/features/developer-keys/apiKeyService.js';
import { CLAUDE_CODE_OPERATOR_ENV, consentHash } from '../src/features/claude-code/constants.js';
import { decidePairing, eraseClaudeCodeSubject, pollPairing, startPairing as startPairingDirect } from '../src/features/claude-code/pairingService.js';
import { __resetPairingRateLimitForTest } from '../src/features/claude-code/routes.js';
import { isPublicPath } from '../src/middleware/auth.js';

const BASE_PATH = '/host/openwop-app/claude-code';
let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const users = getToggleDefault('users'); if (users) await saveConfig({ ...users, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function setToggle(status: 'on' | 'off'): Promise<void> {
  const t = getToggleDefault('claude-code');
  if (!t) throw new Error('claude-code toggle is not registered');
  await saveConfig({ ...t, status }, 'test');
}

beforeEach(async () => {
  process.env[CLAUDE_CODE_OPERATOR_ENV] = 'true';
  __resetPairingRateLimitForTest();
  await setToggle('on');
});
afterEach(() => { delete process.env[CLAUDE_CODE_OPERATOR_ENV]; });

interface Res { status: number; body: any }
function client(bearer?: string) {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b?: unknown) => call('POST', p, b),
    del: (p: string) => call('DELETE', p),
  };
}

let seq = 0;
async function person(tenantId = `org:cc-${Date.now()}-${seq++}`) {
  const c = client();
  const subject = `cc-user-${Date.now()}-${seq++}`;
  const r = await c.post('/host/openwop-app/test/login', { subject, tenantId, email: `${subject}@a.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { c, tenantId, userId: r.body.user.userId as string };
}

/** A companion: no cookie, no identity — exactly what the public routes serve. */
const companion = () => client();

async function startPairing(label = 'dev laptop', forwardedFor?: string) {
  const r = forwardedFor
    ? await fetch(`${BASE}${BASE_PATH}/pair/device/start`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': forwardedFor }, body: JSON.stringify({ label, platform: 'darwin-arm64' }) })
        .then(async (res) => ({ status: res.status, body: await res.json() }))
    : await companion().post(`${BASE_PATH}/pair/device/start`, { label, platform: 'darwin-arm64' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { deviceCode: string; userCode: string; interval: number; expiresIn: number; verificationPath: string };
}

async function pairFully(owner: Awaited<ReturnType<typeof person>>) {
  const started = await startPairing();
  const ok = await owner.c.post(`${BASE_PATH}/pair/requests/${started.userCode}/approve`, { consentHash: consentHash() });
  expect(ok.status, JSON.stringify(ok.body)).toBe(204);
  const polled = await companion().post(`${BASE_PATH}/pair/device/poll`, { deviceCode: started.deviceCode });
  expect(polled.status, JSON.stringify(polled.body)).toBe(200);
  expect(polled.body.status).toBe('approved');
  return { ...started, token: polled.body.token as string, deviceId: polled.body.deviceId as string };
}

describe('ADR 0785 P1 — operator gate (D2 lever 1)', () => {
  it('unset ⇒ every route 404s, public and signed-in alike', async () => {
    const owner = await person();
    delete process.env[CLAUDE_CODE_OPERATOR_ENV];
    expect((await companion().post(`${BASE_PATH}/pair/device/start`, { label: 'x' })).status).toBe(404);
    expect((await companion().post(`${BASE_PATH}/pair/device/poll`, { deviceCode: 'owdc_x' })).status).toBe(404);
    expect((await owner.c.get(`${BASE_PATH}/devices`)).status).toBe(404);
    expect((await owner.c.get(`${BASE_PATH}/consent`)).status).toBe(404);
  });

  it('set, but the toggle is off for the caller ⇒ the signed-in routes 404', async () => {
    const owner = await person();
    await setToggle('off');
    expect((await owner.c.get(`${BASE_PATH}/devices`)).status).toBe(404);
    const started = await startPairing(); // public routes carry no identity, so no toggle to resolve
    expect((await owner.c.post(`${BASE_PATH}/pair/requests/${started.userCode}/approve`, { consentHash: consentHash() })).status).toBe(404);
  });
});

describe('ADR 0785 P1 — pair → key → revoke', () => {
  it('round-trips, and the device key is an ordinary developer key with exactly the device scopes', async () => {
    const owner = await person();
    const started = await startPairing('work mac');
    expect(started.userCode).toMatch(/^[B-Z2-9]{4}-[B-Z2-9]{4}$/);
    // RFC 8628 §5.4 — the link never carries the code; the user types it.
    expect(started.verificationPath).toBe('/claude-code/pair');
    expect(started.verificationPath).not.toContain(started.userCode);

    // Pending until a person approves.
    const pending = await companion().post(`${BASE_PATH}/pair/device/poll`, { deviceCode: started.deviceCode });
    expect(pending.body).toEqual({ status: 'pending', interval: started.interval });

    // The approval page sees the device and the consent it binds to.
    const page = await owner.c.get(`${BASE_PATH}/pair/requests/${started.userCode.toLowerCase().replace('-', ' ')}`);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect(page.body.request.label).toBe('work mac');
    expect(page.body.consent.quote).toContain('Free, Pro, or Max plan credentials');
    expect(page.body.consentHash).toBe(consentHash());
    // Phishing context: where and when the request started, and which workspace it joins.
    expect(typeof page.body.request.requestedFrom).toBe('string');
    expect(Date.parse(page.body.request.createdAt)).toBeGreaterThan(0);
    expect(page.body.workspaceId).toBe(owner.tenantId);

    // A stale consent hash is refused, never silently upgraded.
    const stale = await owner.c.post(`${BASE_PATH}/pair/requests/${started.userCode}/approve`, { consentHash: 'old' });
    expect(stale.status).toBe(409);

    expect((await owner.c.post(`${BASE_PATH}/pair/requests/${started.userCode}/approve`, { consentHash: consentHash() })).status).toBe(204);

    const polled = await companion().post(`${BASE_PATH}/pair/device/poll`, { deviceCode: started.deviceCode });
    expect(polled.status).toBe(200);
    expect(polled.body.status).toBe('approved');
    expect(polled.body.tenantId).toBe(owner.tenantId);
    const token = polled.body.token as string;
    expect(token.startsWith('owk_')).toBe(true);

    // The key is delivered ONCE.
    expect((await companion().post(`${BASE_PATH}/pair/device/poll`, { deviceCode: started.deviceCode })).status).toBe(404);

    const key = await verifyApiKey(token);
    expect(key).toBeTruthy();
    expect([...key!.scopes].sort()).toEqual(['workspace:read', 'workspace:write']);
    expect(key!.scopes).not.toContain('approvals:respond');
    expect(key!.createdBy).toBe(owner.userId); // the delegating human — the future runner subject (ADR 0785 D3)

    const listed = await owner.c.get(`${BASE_PATH}/devices`);
    expect(listed.body.devices).toHaveLength(1);
    expect(listed.body.devices[0]).toMatchObject({ deviceId: polled.body.deviceId, label: 'work mac', status: 'active' });
    expect(listed.body.devices[0].keyId).toBeUndefined();

    expect((await owner.c.del(`${BASE_PATH}/devices/${polled.body.deviceId}`)).status).toBe(204);
    expect(await verifyApiKey(token)).toBeNull();
    const afterRevoke = await client(token).get('/host/openwop-app/developer-keys');
    expect(afterRevoke.status).toBe(401);
    expect((await owner.c.get(`${BASE_PATH}/devices`)).body.devices[0].status).toBe('revoked');
  });

  it('deny ⇒ the companion is told so, and gets no key', async () => {
    const owner = await person();
    const started = await startPairing();
    expect((await owner.c.post(`${BASE_PATH}/pair/requests/${started.userCode}/deny`)).status).toBe(204);
    const polled = await companion().post(`${BASE_PATH}/pair/device/poll`, { deviceCode: started.deviceCode });
    expect(polled.body).toEqual({ status: 'denied' });
    // A decided pairing is no longer approvable.
    expect((await owner.c.post(`${BASE_PATH}/pair/requests/${started.userCode}/approve`, { consentHash: consentHash() })).status).toBe(404);
  });

  it('two racing polls after approval mint exactly one key', async () => {
    const owner = await person();
    const started = await startPairing();
    await owner.c.post(`${BASE_PATH}/pair/requests/${started.userCode}/approve`, { consentHash: consentHash() });
    const [a, b] = await Promise.all([
      companion().post(`${BASE_PATH}/pair/device/poll`, { deviceCode: started.deviceCode }),
      companion().post(`${BASE_PATH}/pair/device/poll`, { deviceCode: started.deviceCode }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 404]);
    expect((await owner.c.get(`${BASE_PATH}/devices`)).body.devices).toHaveLength(1);
  });

  // The HTTP race above can pass by accident: two requests over one connection
  // pool may simply serialize, so it could not tell a CAS from a blind write
  // (MEASURED: it stayed green with the claim replaced by `put`). This one calls
  // the service twice in the same tick, so both reads land before either write.
  it('two polls in the same tick: the claim-before-mint CAS lets exactly one mint', async () => {
    const owner = await person();
    const started = await startPairingDirect({ label: 'race', platform: 'test' });
    await decidePairing(started.userCode, { approve: true, subject: owner.userId, tenantId: owner.tenantId, consentHash: consentHash() });
    const results = await Promise.all([pollPairing(started.deviceCode), pollPairing(started.deviceCode), pollPairing(started.deviceCode)]);
    expect(results.filter((r) => r?.status === 'approved')).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(2);
  });

  it('an unknown or malformed device code is a uniform 404', async () => {
    expect((await companion().post(`${BASE_PATH}/pair/device/poll`, { deviceCode: 'owdc_nope' })).status).toBe(404);
    expect((await companion().post(`${BASE_PATH}/pair/device/poll`, { deviceCode: 42 })).status).toBe(404);
  });
});

describe('ADR 0785 P1 — only a human session holds pairing authority', () => {
  it('a paired device key cannot approve another pairing, list, or revoke devices', async () => {
    const owner = await person();
    const { token, deviceId } = await pairFully(owner);
    const asKey = client(token);
    const next = await startPairing('second');
    expect((await asKey.post(`${BASE_PATH}/pair/requests/${next.userCode}/approve`, { consentHash: consentHash() })).status).toBe(401);
    expect((await asKey.get(`${BASE_PATH}/devices`)).status).toBe(401);
    expect((await asKey.del(`${BASE_PATH}/devices/${deviceId}`)).status).toBe(401);
    // …and the device is untouched.
    expect(await verifyApiKey(token)).toBeTruthy();
  });

  it('an anonymous visitor cannot approve', async () => {
    const started = await startPairing();
    const anon = client();
    await anon.get('/host/openwop-app/health').catch(() => undefined);
    expect((await anon.post(`${BASE_PATH}/pair/requests/${started.userCode}/approve`, { consentHash: consentHash() })).status).toBe(401);
  });

  it('another person cannot see or revoke my device (404, no existence leak)', async () => {
    const owner = await person();
    const { deviceId, token } = await pairFully(owner);
    const other = await person(owner.tenantId); // same workspace, different human
    expect((await other.c.get(`${BASE_PATH}/devices`)).body.devices).toEqual([]);
    expect((await other.c.del(`${BASE_PATH}/devices/${deviceId}`)).status).toBe(404);
    expect(await verifyApiKey(token)).toBeTruthy();
  });

  it('the canonical version-agnostic root serves the same routes the companion calls', async () => {
    // ADR 0652 — the companion calls /host/openwop-app/…, which does not retire with /v1.
    const r = await companion().post('/host/openwop-app/claude-code/pair/device/start', { label: 'canonical' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it('the ONLY public surface is /pair/device/*', () => {
    expect(isPublicPath(`${BASE_PATH}/pair/device/start`)).toBe(true);
    expect(isPublicPath(`${BASE_PATH}/pair/device/poll`)).toBe(true);
    for (const p of ['/devices', '/consent', '/pair/requests/ABCD-EFGH', '/pair/requests/ABCD-EFGH/approve', '']) {
      expect(isPublicPath(`${BASE_PATH}${p}`), p).toBe(false);
    }
  });
});

describe('ADR 0785 P1 — abuse bounds + erasure', () => {
  it('the start limit is per CLIENT address (X-Forwarded-For), not per proxy — one busy address never locks out another', async () => {
    // Behind Cloud Run every request arrives from the front end's address. A
    // limit keyed on `req.ip` would be ONE global limit (code review #1).
    for (let i = 0; i < 10; i += 1) await startPairing(`a${i}`, '203.0.113.7');
    const blocked = await fetch(`${BASE}${BASE_PATH}/pair/device/start`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' }, body: '{}' });
    expect(blocked.status).toBe(429);
    const other = await startPairing('b', '198.51.100.9');
    expect(other.userCode).toBeTruthy();
  });

  it('approval is refused, with a reason a person can act on, when the workspace is at its key ceiling', async () => {
    const owner = await person();
    for (let i = 0; i < 100; i += 1) await issueApiKey({ tenantId: owner.tenantId, name: `k${i}`, createdBy: owner.userId });
    const started = await startPairing('full');
    const r = await owner.c.post(`${BASE_PATH}/pair/requests/${started.userCode}/approve`, { consentHash: consentHash() });
    expect(r.status).toBe(409);
    expect(r.body.details?.reason ?? r.body.reason).toBe('key_limit');
    // …and the pairing is still pending, so it can be approved after a revoke.
    expect((await companion().post(`${BASE_PATH}/pair/device/poll`, { deviceCode: started.deviceCode })).body.status).toBe('pending');
  });

  it('rate-limits pairing starts per address', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) statuses.push((await companion().post(`${BASE_PATH}/pair/device/start`, { label: `n${i}` })).status);
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('the DSAR eraser removes the subject\'s devices and revokes their keys', async () => {
    const owner = await person();
    const { token } = await pairFully(owner);
    const erased = await eraseClaudeCodeSubject(owner.tenantId, new Set([owner.userId]));
    expect(erased.devices).toBe(1);
    expect(await verifyApiKey(token)).toBeNull();
    expect((await owner.c.get(`${BASE_PATH}/devices`)).body.devices).toEqual([]);
  });
});

describe('ADR 0785 P1 — the real companion against the real routes', () => {
  it('clients/agent-host pairs end to end: start → approve → poll → a working key', async () => {
    // A dynamic import of a path held in a variable: the companion is plain JS
    // outside the backend build, so it is loaded, not type-resolved.
    const companionPath = new URL('../../../clients/agent-host/src/pairing.js', import.meta.url).href;
    const companion = (await import(companionPath)) as {
      startPairing: (a: { host: string; label: string; platform: string }) => Promise<{ deviceCode: string; userCode: string; interval: number; expiresIn: number; verificationUrl: string }>;
      waitForApproval: (a: { host: string; deviceCode: string; interval: number; expiresIn: number; sleepFn: (ms: number) => Promise<void> }) => Promise<{ status: string; token?: string; deviceId?: string }>;
    };
    const owner = await person();
    const started = await companion.startPairing({ host: BASE, label: 'companion e2e', platform: 'test' });
    expect(started.verificationUrl).toBe(`${BASE}/claude-code/pair`);

    // The human approves while the companion is polling.
    let approved = false;
    const result = await companion.waitForApproval({
      host: BASE, deviceCode: started.deviceCode, interval: started.interval, expiresIn: started.expiresIn,
      sleepFn: async () => {
        if (!approved) {
          approved = true;
          const ok = await owner.c.post(`${BASE_PATH}/pair/requests/${started.userCode}/approve`, { consentHash: consentHash() });
          expect(ok.status).toBe(204);
        }
      },
    });
    expect(result.status).toBe('approved');
    expect(await verifyApiKey(result.token!)).toBeTruthy();
    const listed = await owner.c.get(`${BASE_PATH}/devices`);
    expect(listed.body.devices.map((d: { label: string }) => d.label)).toEqual(['companion e2e']);
  });
});

