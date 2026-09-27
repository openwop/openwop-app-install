/**
 * ADR 0672 D1 (`CMSAWF-18`) — the approvals LIST route filters by the audience owner, on
 * every kind.
 *
 * Born red: `routes/approvals.ts` implemented FOUR of the nine audiences by hand and
 * `return a`'d every other kind, so `GET /approvals` handed any tenant principal rows that
 * `/reviews` hides — a widget visitor's captured PII, a coach's note ABOUT a participant,
 * the three field-sales kinds, and superadmin-only listing rows.
 *
 * **This file exists because the fix was otherwise UNWITNESSED.** After wiring the owner,
 * all 29 approval/review suites still passed — and a grep showed ZERO of them exercise the
 * list route with any of the six kinds. A green suite that would be green either way is why
 * the leak survived in the first place; the mechanism is witnessed in
 * `approval-audience-owner.test.ts`, and this witnesses the WIRING.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';

interface Row {
  approvalId: string; tenantId: string; status: string; kind?: string; orgId?: string;
  proposal: string; createdAt: string; rosterId: string; persona: string; workflowId: string;
  policy?: { approverRefs?: string[] };
}
const approvals = new DurableCollection<Row>('approval', (a) => a.approvalId);
const ix = new DurableCollection<{ ixId: string; approvalId: string }>('approval:by-tenant-status', (r) => r.ixId);

let BASE = '';
let server: http.Server;
let cookie = '';
let tenantId = '';

/** The six kinds `/reviews` scopes and the list route did not. */
const SCOPED = [
  'anon-surface-write', 'kicktodo-plan-proposal', 'dealer-registration',
  'territory-model-transition', 'commission-statement', 'commerce-listing-publish',
] as const;

const seed = async (kind: string, proposal: string): Promise<string> => {
  const approvalId = `appr:seed-${kind}`;
  const row: Row = {
    approvalId, tenantId, status: 'pending', kind, orgId: 'org-other',
    proposal, createdAt: new Date().toISOString(),
    rosterId: 'r1', persona: 'p', workflowId: 'wf',
    ...(kind === 'kicktodo-plan-proposal' ? { policy: { approverRefs: ['someone-else'] } } : {}),
  };
  await approvals.put(row);
  await ix.put({ ixId: `${tenantId}:pending:${approvalId}`, approvalId });
  return approvalId;
};

beforeAll(async () => {
  // The test-login seam is env-gated (`routes/authTestSeam.ts:33`). Without this it 404s
  // and the request falls through to a DIFFERENT tenant — which is how the first version of
  // this fixture read an empty list and made legs 1-2 pass against nothing. The positive
  // control in leg 3 is what exposed it.
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 't', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
  // The repo's route tests drive the test-login seam with an EXPLICIT tenantId rather than
  // reading one back from signup — `/auth/me` does not carry it, which is what made the
  // first version of this fixture vacuous (caught by the assertion below).
  tenantId = `org:audience-${Date.now()}`;
  const login = await fetch(`${BASE}/v1/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `audience-${Date.now()}@acme.test`, tenantId }),
  });
  cookie = getSetCookies(login.headers).join('; ');
  expect(tenantId, 'the fixture needs a real tenant — otherwise every leg is vacuous').toBeTruthy();
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

const listKinds = async (): Promise<string[]> => {
  const res = await fetch(`${BASE}/v1/host/openwop-app/approvals?status=pending`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = await res.json() as { items?: Array<{ kind?: string }>; approvals?: Array<{ kind?: string }> };
  return (body.items ?? body.approvals ?? []).map((a) => a.kind ?? 'run-proposal');
};

describe('ADR 0672 D1 — the list route filters by the audience owner', () => {
  it('leg 1: a plain tenant member sees NONE of the six kinds the projection scopes', async () => {
    for (const k of SCOPED) await seed(k, `SECRET-${k}`);
    const kinds = await listKinds();
    for (const k of SCOPED) {
      expect(kinds, `${k} must not reach a member who cannot decide it`).not.toContain(k);
    }
  });

  it('leg 2: the row TEXT never reaches them either — existence and content both withheld', async () => {
    const res = await fetch(`${BASE}/v1/host/openwop-app/approvals?status=pending`, { headers: { cookie } });
    const raw = JSON.stringify(await res.json());
    for (const k of SCOPED) {
      expect(raw, `the proposal text for ${k} leaked`).not.toContain(`SECRET-${k}`);
    }
  });

  it('leg 3 (positive control): a TENANT-SCOPED kind is still listed — the filter is not a blanket deny', async () => {
    // Without this, legs 1-2 would pass against a route that returns nothing at all.
    await seed('run-proposal', 'VISIBLE-run-proposal');
    const kinds = await listKinds();
    expect(kinds, 'run-proposal has no audience rule and must stay visible').toContain('run-proposal');
  });
});
