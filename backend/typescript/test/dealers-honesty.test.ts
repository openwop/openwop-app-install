/**
 * Dealer Network ROUND 2 (UX_UPGRADE-dealers, pass 2) — the seams round 1 did not reach.
 *
 * Round 1 fixed three READS that rendered their failure as data. What it left is the
 * WRITE path, the operator's kill-switch, and the review queue:
 *
 *  - DLR2-B1  the public partner routes ignored the `dealers` toggle entirely
 *  - DLR2-B2  a review card that never landed was reported as "awaiting review"
 *  - DLR2-B3  deleting a dealer left review cards NO action could ever clear
 *  - DLR2-B4  a decision taken outside the inbox left its card pending (and wedged)
 *  - DLR2-M3  no subject eraser: `decidedBy` survived erasure on every row
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { listApprovals } from '../src/host/approvalService.js';

let BASE: string;
let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'crm', 'dealers']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => {
  const d = getToggleDefault('dealers'); if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  await new Promise<void>((res) => server.close(() => res()));
});

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(withCookie = true): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(withCookie && cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (withCookie) for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}
let n = 0;
const B = (orgId: string): string => `/v1/host/openwop-app/dealers/orgs/${encodeURIComponent(orgId)}`;
const setDealers = async (status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault('dealers'); if (d) await saveConfig({ ...d, status }, 'test'); };

async function setup(): Promise<{ owner: Client; orgId: string; dealerId: string; tenantId: string; token: string }> {
  const tenantId = `org:dlr2-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/v1/host/openwop-app/test/login', { email: `o-${Date.now()}-${n++}@acme.test`, tenantId });
  const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
  const companyId = (await owner.post(`/v1/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}/companies`, { name: 'Dealer Co' })).body.companyId;
  const dealerId = (await owner.post(`${B(orgId)}/dealers`, { name: 'North Dealer', companyId })).body.dealerId;
  await owner.post(`${B(orgId)}/dealers/${dealerId}/outlets`, { name: 'Store A', address: '1 Main St' });
  const token = (await owner.post(`${B(orgId)}/dealers/${dealerId}/portal-token`)).body.token;
  return { owner, orgId, dealerId, tenantId, token };
}

describe('DLR2-B1 — the toggle is the kill-switch, and the public routes ignored it', () => {
  it('an issued partner link stops serving, and stops accepting, when the feature is off', async () => {
    const { token } = await setup();
    const anon = client(false);
    expect((await anon.get(`/v1/host/openwop-app/partner/${token}`)).status).toBe(200);

    await setDealers('off');
    try {
      // Told: switching `dealers` off removes the surface (the nav hides, all 13 org
      // routes 404). True, before this: every issued link kept serving the dealer's
      // outlet names and STREET ADDRESSES to anyone holding it, and kept accepting new
      // deal registrations — durable rows, into a console that no longer exists.
      expect((await anon.get(`/v1/host/openwop-app/partner/${token}`)).status).toBe(404);
      const reg = await anon.post(`/v1/host/openwop-app/partner/${token}/register`, { dealTitle: 'Q4 fleet', companyName: 'Globex' });
      expect(reg.status).toBe(404);
    } finally {
      await setDealers('on');
    }
    // …and it works again when the operator turns it back on (the negative control:
    // this is a gate, not a break).
    expect((await anon.get(`/v1/host/openwop-app/partner/${token}`)).status).toBe(200);
  });
});

describe('DLR2-B2 — a review card that never landed is not "awaiting review"', () => {
  it('records the failure on the row, and the admin list retries it', async () => {
    const { owner, orgId, tenantId, token } = await setup();
    const approvals = await import('../src/host/approvalService.js');
    const spy = vi.spyOn(approvals, 'createDealerRegistrationApproval').mockRejectedValueOnce(new Error('db transient'));

    const anon = client(false);
    // The partner submit still succeeds — the reg row IS durable, and a public submit
    // must not 500 on a queue hiccup. That was always right; the SILENCE was not.
    expect((await anon.post(`/v1/host/openwop-app/partner/${token}/register`, { dealTitle: 'Q4 fleet', companyName: 'Globex' })).status).toBe(201);
    spy.mockRestore();

    // Read the row WITHOUT the admin route, because that route is also the repair:
    // the state to observe is "saved, and nobody has been asked to decide it".
    const { listRegistrations } = await import('../src/features/dealers/entities/registration.js');
    const before = await listRegistrations(tenantId, orgId);
    expect(before[0]!.queueFailed).toBe(true);
    expect(before[0]!.status).toBe('pending');     // …which is why `status` could not tell
    expect((await listApprovals(tenantId, 'pending')).filter((a) => a.kind === 'dealer-registration')).toHaveLength(0);

    // Opening the console is what heals it: the admin list re-queues and clears the flag.
    const repaired = (await owner.get(`${B(orgId)}/registrations`)).body.registrations;
    expect(repaired[0].queueFailed).toBeUndefined();
    expect((await listApprovals(tenantId, 'pending')).filter((a) => a.kind === 'dealer-registration')).toHaveLength(1);
  });

  it('the PUBLIC partner read never repairs — a public route stays side-effect-free', async () => {
    const { orgId, tenantId, token } = await setup();
    const approvals = await import('../src/host/approvalService.js');
    const spy = vi.spyOn(approvals, 'createDealerRegistrationApproval').mockRejectedValueOnce(new Error('db transient'));
    const anon = client(false);
    await anon.post(`/v1/host/openwop-app/partner/${token}/register`, { dealTitle: 'Q4 fleet', companyName: 'Globex' });
    spy.mockRestore();

    await anon.get(`/v1/host/openwop-app/partner/${token}`);
    const { listRegistrations } = await import('../src/features/dealers/entities/registration.js');
    expect((await listRegistrations(tenantId, orgId))[0]!.queueFailed).toBe(true);
    expect((await listApprovals(tenantId, 'pending')).filter((a) => a.kind === 'dealer-registration')).toHaveLength(0);
  });

  it('a normal submit is queued and carries no failure flag (the negative control)', async () => {
    const { owner, orgId, token } = await setup();
    const anon = client(false);
    await anon.post(`/v1/host/openwop-app/partner/${token}/register`, { dealTitle: 'Normal', companyName: 'Initech' });
    const rows = (await owner.get(`${B(orgId)}/registrations`)).body.registrations;
    expect(rows[0].queueFailed).toBeUndefined();
  });
});

describe('DLR2-B3/B4 — a review card must never outlive the thing it decides', () => {
  it('deleting a dealer closes its pending cards, instead of wedging them forever', async () => {
    const { owner, orgId, dealerId, tenantId, token } = await setup();
    const anon = client(false);
    await anon.post(`/v1/host/openwop-app/partner/${token}/register`, { dealTitle: 'Fleet pilot', companyName: 'Globex' });
    expect((await listApprovals(tenantId, 'pending')).filter((a) => a.kind === 'dealer-registration')).toHaveLength(1);

    expect((await owner.del(`${B(orgId)}/dealers/${dealerId}`)).status).toBe(200);

    // The card is not merely stale — its handler resolves the registration by id, so a
    // card whose row is gone 404s on approve AND on reject, and the compensating
    // `reopenApproval` puts it straight back: an inbox item no action can dismiss.
    expect((await listApprovals(tenantId, 'pending')).filter((a) => a.kind === 'dealer-registration')).toHaveLength(0);
  });

  it('a decision taken outside the inbox closes its card too', async () => {
    const { owner, orgId, dealerId, tenantId, token } = await setup();
    const anon = client(false);
    await anon.post(`/v1/host/openwop-app/partner/${token}/register`, { dealTitle: 'Sample order', companyName: 'Initech' });
    const regId = (await owner.get(`${B(orgId)}/registrations`)).body.registrations[0].regId;

    // The workflow surface and the demo seeder both decide this way. Leaving the card
    // pending is worse than untidy: approving an already-REJECTED row 409s, the handler
    // re-opens the approval, and the card can never be cleared by any action.
    const { decideRegistration } = await import('../src/features/dealers/entities/registration.js');
    await decideRegistration(tenantId, orgId, regId, 'rejected', 'user:ops');

    expect((await listApprovals(tenantId, 'pending')).filter((a) => a.kind === 'dealer-registration')).toHaveLength(0);
    expect((await owner.get(`${B(orgId)}/registrations`)).body.registrations[0].status).toBe('rejected');
    expect(dealerId).toBeTruthy();
  });
});

describe('review fold-in — defects the independent pass found in the fix', () => {
  it('B1: an APPROVED decision closes its card as approved, not as rejected', async () => {
    const { owner, orgId, tenantId, token } = await setup();
    const anon = client(false);
    await anon.post(`/v1/host/openwop-app/partner/${token}/register`, { dealTitle: 'Fleet', companyName: 'Globex' });
    const regId = (await owner.get(`${B(orgId)}/registrations`)).body.registrations[0].regId;

    // The first version hard-coded `rejected` for BOTH directions, so this — the demo
    // seed's own path, and the `approve-registration` node's — wrote "Rejected" onto the
    // card and into the ADR 0301 audit chain for a deal that was APPROVED. My own B4 case
    // decided `rejected`, the single direction where the two coincide, so it could not
    // fail on it.
    const { decideRegistration } = await import('../src/features/dealers/entities/registration.js');
    await decideRegistration(tenantId, orgId, regId, 'approved', 'user:ops');

    const resolved = (await listApprovals(tenantId, 'approved')).filter((a) => a.kind === 'dealer-registration');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.status).toBe('approved');
    expect((await listApprovals(tenantId, 'rejected')).filter((a) => a.kind === 'dealer-registration')).toHaveLength(0);

    // …and the ADR 0301 hash-chain, which is the record of record, agrees. `decidedBy`
    // is not stored on the approval row at all — it reaches the chain as `actor`, and
    // omitting it is how the first version recorded a decision by nobody.
    const { listChain } = await import('../src/host/auditChainService.js');
    const decision = (await listChain(tenantId)).filter((e) => e.kind === 'governance.decision');
    expect(decision).toHaveLength(1);
    expect((decision[0]!.payload as { outcome?: string }).outcome).toBe('approved');
    expect((decision[0]!.payload as { actor?: string }).actor).toBe('user:ops');
  });

  it('B1: a REJECTED decision still closes as rejected (the negative control)', async () => {
    const { owner, orgId, tenantId, token } = await setup();
    const anon = client(false);
    await anon.post(`/v1/host/openwop-app/partner/${token}/register`, { dealTitle: 'Sample', companyName: 'Initech' });
    const regId = (await owner.get(`${B(orgId)}/registrations`)).body.registrations[0].regId;
    const { decideRegistration } = await import('../src/features/dealers/entities/registration.js');
    await decideRegistration(tenantId, orgId, regId, 'rejected', 'user:ops');
    const resolved = (await listApprovals(tenantId, 'rejected')).filter((a) => a.kind === 'dealer-registration');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.status).toBe('rejected');
  });

  it('B2: the toggle-off 404 is BYTE-IDENTICAL to a bad token, not merely also a 404', async () => {
    const { token } = await setup();
    const anon = client(false);
    await setDealers('off');
    try {
      const real = await anon.get(`/v1/host/openwop-app/partner/${token}`);
      const bogus = await anon.get('/v1/host/openwop-app/partner/ptoken:definitely-not-a-token');
      expect(real.status).toBe(404);
      expect(bogus.status).toBe(404);
      // Asserting both are 404 is what the first version did, and it cannot see the
      // difference: the envelope emits `message` verbatim, so two different strings made
      // the pair a token-validity ORACLE — handed out precisely when the operator
      // believes the surface is gone.
      expect(JSON.stringify(real.body)).toBe(JSON.stringify(bogus.body));
    } finally { await setDealers('on'); }
  });

  it('B5: the review card id is DERIVED from the registration, so a second create cannot mint a second card', async () => {
    const { owner, orgId, tenantId, token } = await setup();
    const approvals = await import('../src/host/approvalService.js');
    const spy = vi.spyOn(approvals, 'createDealerRegistrationApproval').mockRejectedValueOnce(new Error('db transient'));
    const anon = client(false);
    await anon.post(`/v1/host/openwop-app/partner/${token}/register`, { dealTitle: 'Fleet', companyName: 'Globex' });
    spy.mockRestore();

    await Promise.all([owner.get(`${B(orgId)}/registrations`), owner.get(`${B(orgId)}/registrations`)]);
    const cards = (await listApprovals(tenantId, 'pending')).filter((a) => a.kind === 'dealer-registration');
    expect(cards).toHaveLength(1);
    // The two-request race does NOT reproduce here — both handlers run to completion on
    // one event loop, so a read-then-create dedup survives it (my first version of this
    // assertion passed against the un-fixed code, which is how I know). What makes the
    // race impossible is that the id is DERIVED from the registration, so a second create
    // is an idempotent put rather than a second row. That is what this pins.
    const regId = (await owner.get(`${B(orgId)}/registrations`)).body.registrations[0].regId;
    expect(cards[0]!.approvalId).toBe(`appr:dealreg:${regId}`);
  });

  it('I2: a pending row with NO card and no flag is repaired too', async () => {
    const { owner, orgId, tenantId, token } = await setup();
    const anon = client(false);
    await anon.post(`/v1/host/openwop-app/partner/${token}/register`, { dealTitle: 'Fleet', companyName: 'Globex' });
    // The shape a part-way delete cascade leaves behind — and the shape of every row
    // whose queue write failed BEFORE `queueFailed` existed. The first repair keyed on
    // the flag, so it could not see either.
    const card = (await listApprovals(tenantId, 'pending')).find((a) => a.kind === 'dealer-registration')!;
    const { resolveApproval } = await import('../src/host/approvalService.js');
    await resolveApproval(card.approvalId, { status: 'rejected', note: 'simulating a lost card' });
    expect((await listApprovals(tenantId, 'pending')).filter((a) => a.kind === 'dealer-registration')).toHaveLength(0);

    await owner.get(`${B(orgId)}/registrations`);
    expect((await listApprovals(tenantId, 'pending')).filter((a) => a.kind === 'dealer-registration')).toHaveLength(1);
  });

  it('B4: a dealer whose CRM company is gone cannot be walked back to active', async () => {
    const { owner, orgId, dealerId } = await setup();
    const companyId = (await owner.get(`${B(orgId)}/dealers/${dealerId}`)).body.companyId;
    expect((await owner.post(`${B(orgId)}/dealers/${dealerId}`, undefined)).status).toBeGreaterThan(0); // no-op probe
    await owner.del(`/v1/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}/companies/${encodeURIComponent(companyId)}`);
    // The company delete auto-suspends (ADR 0283), whose whole point is that a
    // dangling-company dealer must not read as active. Shipping the reversal without
    // this guard is a one-click route straight back into that state.
    const res = await owner.patch(`${B(orgId)}/dealers/${dealerId}`, { status: 'active' });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/company/i);
  });
});

describe('DLR2-M3 — subject erasure reaches the dealers rows', () => {
  it('severs the person-link on a decided registration, and leaves the decision', async () => {
    const { owner, orgId, tenantId, token } = await setup();
    const anon = client(false);
    await anon.post(`/v1/host/openwop-app/partner/${token}/register`, { dealTitle: 'Fleet', companyName: 'Globex' });
    const regId = (await owner.get(`${B(orgId)}/registrations`)).body.registrations[0].regId;
    const { decideRegistration } = await import('../src/features/dealers/entities/registration.js');
    await decideRegistration(tenantId, orgId, regId, 'approved', 'user:manager-a');

    // Driven through the HOST seam — the half that was missing is the registration,
    // not the mechanism: no dealers collection registered anything at all.
    await eraseSubject(tenantId, 'user:manager-a');

    const row = (await owner.get(`${B(orgId)}/registrations`)).body.registrations[0];
    expect(row.decidedBy).toBe('[erased]');
    expect(row.status).toBe('approved');           // the business decision survives
  });

  it('leaves another decider alone (the negative control)', async () => {
    const { owner, orgId, tenantId, token } = await setup();
    const anon = client(false);
    await anon.post(`/v1/host/openwop-app/partner/${token}/register`, { dealTitle: 'Fleet', companyName: 'Globex' });
    const regId = (await owner.get(`${B(orgId)}/registrations`)).body.registrations[0].regId;
    const { decideRegistration } = await import('../src/features/dealers/entities/registration.js');
    await decideRegistration(tenantId, orgId, regId, 'approved', 'user:manager-b');
    await eraseSubject(tenantId, 'user:someone-else');
    expect((await owner.get(`${B(orgId)}/registrations`)).body.registrations[0].decidedBy).toBe('user:manager-b');
  });
});

describe('R3 — the repair never writes for a viewer (the R2 deferral)', () => {
  it('a workspace:read viewer gets the SAME rows un-repaired (idempotent GET, no writes); the owner heals them', async () => {
    const { owner, orgId, tenantId, token } = await setup();
    const approvals = await import('../src/host/approvalService.js');
    const spy = vi.spyOn(approvals, 'createDealerRegistrationApproval').mockRejectedValueOnce(new Error('db transient'));
    const anon = client(false);
    expect((await anon.post(`/v1/host/openwop-app/partner/${token}/register`, { dealTitle: 'Viewer case', companyName: 'Initech' })).status).toBe(201);
    spy.mockRestore();

    // A same-tenant read-only viewer (the projects-route precedent).
    const viewer = client();
    const vlogin = await viewer.post('/v1/host/openwop-app/test/login', { email: `v-${Date.now()}-${n++}@acme.test`, tenantId });
    expect((await owner.post(`/v1/host/openwop-app/orgs/${orgId}/members`, { displayName: 'V', subject: vlogin.body.user.userId, roles: ['viewer'] })).status).toBe(201);

    const { listApprovals } = await import('../src/host/approvalService.js');
    // The viewer's GET returns the rows but performs NO repair.
    const seen = (await viewer.get(`${B(orgId)}/registrations`)).body.registrations;
    expect(seen.some((r: { queueFailed?: boolean }) => r.queueFailed === true)).toBe(true); // shown, un-repaired
    expect((await listApprovals(tenantId, 'pending')).filter((a) => a.kind === 'dealer-registration')).toHaveLength(0);

    // The owner's visit heals it — same route, write-capable caller.
    const healed = (await owner.get(`${B(orgId)}/registrations`)).body.registrations;
    expect(healed.every((r: { queueFailed?: boolean }) => r.queueFailed === undefined)).toBe(true);
    expect((await listApprovals(tenantId, 'pending')).filter((a) => a.kind === 'dealer-registration')).toHaveLength(1);
  });
});
