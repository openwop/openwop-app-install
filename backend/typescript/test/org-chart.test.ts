/**
 * Agent org-chart (RFCS/0087 reference impl) — structure + roll-up + the
 * non-authority guarantee.
 *
 * Covers:
 *   1. The pure service (host/orgChartService.ts): acyclic `reportsTo`
 *      validation; cross-tenant member rejection; the responsibility roll-up
 *      (union of members' RFC 0086 portfolios, recursive through
 *      sub-departments); and the §B structural guarantee that the stored
 *      chart carries NO authority field.
 *   2. The host-extension REST routes (`/host/openwop-app/org-chart/*`): PUT
 *      validate → GET department roll-up; a cycle 400s with its reason; an
 *      unknown department 404s; discovery advertises `agents.orgChart`.
 *      (Corrected w74: the header used to claim a full-chart GET and a
 *      route-level cross-tenant 400 here. Neither had a case; cross-tenant
 *      membership is asserted at the service level above, and the normative
 *      chart read lives in `org-chart-normative-route.test.ts`.)
 *
 * Sabotage, each red (w74 round 1): neutralising the cycle check (service +
 * route), the cross-tenant member check, or the route's error→400 mapping;
 * adding a field to stored members; never recursing; the route roll-up
 * answering no responsibilities; the route answering an unknown department;
 * changing the advertised `installScope`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { __resetRosterStore, createRosterEntry } from '../src/host/rosterService.js';
import { __resetOrgChartStore, putChart, responsibilityView } from '../src/host/orgChartService.js';

const DEPTS = [
  { departmentId: 'dept-marketing', name: 'Marketing', parentDepartmentId: null, roles: [{ roleId: 'role-cm', name: 'Campaign Manager' }, { roleId: 'role-bw', name: 'Brief Writer' }] },
  { departmentId: 'dept-social', name: 'Social', parentDepartmentId: 'dept-marketing', roles: [{ roleId: 'role-sm', name: 'Social Manager' }] },
];

describe('org-chart service (pure)', () => {
  const storage = openSqliteStorage(':memory:');
  beforeAll(() => {
    initHostExtPersistence(storage);
  });
  afterAll(async () => {
    __resetHostExtPersistence();
    await storage.close();
  });
  beforeEach(async () => {
    initHostExtPersistence(storage);
    await __resetRosterStore();
    await __resetOrgChartStore();
  });

  async function seedMembers() {
    const sally = await createRosterEntry({ tenantId: 't1', persona: 'Sally', agentRef: { agentId: 'a.b.c.d' }, workflows: ['email-campaign'] });
    const morgan = await createRosterEntry({ tenantId: 't1', persona: 'Morgan', agentRef: { agentId: 'a.b.c.d' }, workflows: ['quarterly-plan'] });
    const sage = await createRosterEntry({ tenantId: 't1', persona: 'Sage', agentRef: { agentId: 'a.b.c.d' }, workflows: ['social-post'] });
    return { sally, morgan, sage };
  }

  it('stores a valid chart and the member objects carry NO authority field (§B)', async () => {
    const { sally, morgan } = await seedMembers();
    const res = await putChart({
      tenantId: 't1',
      departments: DEPTS,
      members: [
        { rosterId: sally.rosterId, departmentId: 'dept-marketing', roleId: 'role-bw', reportsTo: morgan.rosterId },
        { rosterId: morgan.rosterId, departmentId: 'dept-marketing', roleId: 'role-cm', reportsTo: null },
      ],
    });
    if (!('chart' in res)) throw new Error(`a valid chart MUST store: ${JSON.stringify(res)}`);
    expect(res.chart.members).toHaveLength(2);
    for (const m of res.chart.members) {
      // RFC 0087 §B: an org edge is metadata only — no authority surface.
      // The exact key set proves there is no permissions/scopes/canDispatch
      // field anywhere on a member.
      expect(Object.keys(m).sort()).toEqual(['departmentId', 'reportsTo', 'roleId', 'rosterId']);
    }
  });

  it('rejects a reportsTo cycle (§A)', async () => {
    const { sally, morgan } = await seedMembers();
    const res = await putChart({
      tenantId: 't1',
      departments: DEPTS,
      members: [
        { rosterId: sally.rosterId, departmentId: 'dept-marketing', roleId: 'role-bw', reportsTo: morgan.rosterId },
        { rosterId: morgan.rosterId, departmentId: 'dept-marketing', roleId: 'role-cm', reportsTo: sally.rosterId },
      ],
    });
    expect(res).toMatchObject({ error: { code: 'cycle' } });
  });

  it('rejects a cross-tenant member (§C)', async () => {
    const beta = await createRosterEntry({ tenantId: 't2', persona: 'Beta', agentRef: { agentId: 'a.b.c.d' } });
    const res = await putChart({
      tenantId: 't1',
      departments: DEPTS,
      members: [{ rosterId: beta.rosterId, departmentId: 'dept-marketing', roleId: 'role-bw', reportsTo: null }],
    });
    expect(res).toMatchObject({ error: { code: 'cross_tenant_member', detail: beta.rosterId } });
  });

  it('rolls up responsibilities as the union of member portfolios, recursing sub-departments (§D)', async () => {
    const { sally, morgan, sage } = await seedMembers();
    await putChart({
      tenantId: 't1',
      departments: DEPTS,
      members: [
        { rosterId: sally.rosterId, departmentId: 'dept-marketing', roleId: 'role-bw', reportsTo: morgan.rosterId },
        { rosterId: morgan.rosterId, departmentId: 'dept-marketing', roleId: 'role-cm', reportsTo: null },
        { rosterId: sage.rosterId, departmentId: 'dept-social', roleId: 'role-sm', reportsTo: morgan.rosterId },
      ],
    });
    const recursive = await responsibilityView('t1', 'dept-marketing', true);
    expect(recursive?.responsibilities.sort()).toEqual(['email-campaign', 'quarterly-plan', 'social-post']);
    const direct = await responsibilityView('t1', 'dept-marketing', false);
    // Non-recursive excludes the sub-department (Social) member's portfolio.
    expect(direct?.responsibilities.sort()).toEqual(['email-campaign', 'quarterly-plan']);
  });
});

describe('org-chart routes (sqlite memory app)', () => {
  let server: http.Server;
  let BASE: string;
  const TOKEN = 'dev-token';

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await __resetRosterStore();
    await __resetOrgChartStore();
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  }, 120_000);

  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  async function jsonFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
    const text = await res.text();
    const body: unknown = text === '' ? undefined : JSON.parse(text);
    return { status: res.status, body: body as T };
  }

  async function makeMember(persona: string, workflows: string[]): Promise<string> {
    const r = await jsonFetch<{ rosterId: string }>('/host/openwop-app/roster', {
      method: 'POST',
      body: JSON.stringify({ persona, agentRef: { agentId: 'core.openwop.agents.brief-writer' }, workflows }),
    });
    return r.body.rosterId;
  }

  it('advertises agents.orgChart in discovery', async () => {
    // ADR 0812 P3c-0 — v2 spelling: presence of the facet is the claim (no `supported` flag).
    const { body } = await jsonFetch<{ agents?: { orgChart?: { installScope?: string } } }>('/.well-known/openwop', { headers: { 'OpenWOP-Version': '2' } });
    expect(body.agents?.orgChart?.installScope).toBe('tenant');
  });

  it('PUT → GET chart → GET department roll-up', async () => {
    const sally = await makeMember('Sally', ['email-campaign']);
    const morgan = await makeMember('Morgan', ['quarterly-plan']);
    const put = await jsonFetch('/host/openwop-app/org-chart', {
      method: 'PUT',
      body: JSON.stringify({
        departments: DEPTS,
        members: [
          { rosterId: sally, departmentId: 'dept-marketing', roleId: 'role-bw', reportsTo: morgan },
          { rosterId: morgan, departmentId: 'dept-marketing', roleId: 'role-cm', reportsTo: null },
        ],
      }),
    });
    expect(put.status).toBe(200);

    const view = await jsonFetch<{ responsibilities: string[] }>('/host/openwop-app/org-chart/dept-marketing');
    expect(view.status).toBe(200);
    expect(view.body.responsibilities.sort()).toEqual(['email-campaign', 'quarterly-plan']);
  });

  it('400s a cycle', async () => {
    const a = await makeMember('A', []);
    const b = await makeMember('B', []);
    const res = await jsonFetch<{ error?: string; details?: { reason?: string } }>('/host/openwop-app/org-chart', {
      method: 'PUT',
      body: JSON.stringify({
        departments: DEPTS,
        members: [
          { rosterId: a, departmentId: 'dept-marketing', roleId: 'role-bw', reportsTo: b },
          { rosterId: b, departmentId: 'dept-marketing', roleId: 'role-cm', reportsTo: a },
        ],
      }),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
    expect(res.body.details?.reason).toBe('cycle');
  });

  it('404s an unknown department roll-up', async () => {
    const res = await jsonFetch<{ error?: string }>('/host/openwop-app/org-chart/dept-nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });
});
