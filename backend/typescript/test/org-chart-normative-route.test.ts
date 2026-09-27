/**
 * RFC 0087 §D — the NORMATIVE org-chart read pair, and the registration-order
 * trap that makes it silently unreachable.
 *
 * The host advertised `agents.orgChart.supported: true` while serving the chart
 * ONLY at the host-extension alias `/v1/host/openwop-app/org-chart`. The spec
 * names `GET /v1/agents/org-chart` (§D), and the conformance scenario
 * `org-position-no-authority-escalation` reads exactly that path to check the
 * §B no-authority invariant on the live wire. So the capability was real and
 * the wire the spec names was absent — an advertised-but-unobservable claim,
 * which the conformance suite forgave as a soft-skip until `seamAbsent()`
 * (RFC 0148 §B) started failing it.
 *
 * Two things need pinning, and the second is the one that would rot silently:
 *
 *  1. the routes behave per §C/§D — tenant-scoped, roll-up, `?recursive=false`,
 *     404 for unknown/cross-tenant department;
 *  2. **`/v1/agents/org-chart` is not shadowed.** `routes/agents.ts` serves
 *     `GET /v1/agents/:agentId`, which matches the literal segment `org-chart`
 *     and answers `404 not_found`. Express resolves in registration order, so
 *     if `orgChartNormative` were ever moved after `agents` in
 *     `registerAllRoutes.ts`, these endpoints would go dead — and dead in the
 *     most misleading way available, because a 404 is precisely what the
 *     conformance suite reads as "the seam is absent". The failure would look
 *     identical to never having built them.
 *
 * Two tenants throughout, because the §C carry-forward (CTI-1) is that a chart
 * outside the caller's owner triple is never disclosed, and a single-tenant
 * test cannot tell a tenant-scoped read from a global one.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { __resetRosterStore, createRosterEntry } from '../src/host/rosterService.js';
import { __resetOrgChartStore, putChart } from '../src/host/orgChartService.js';

const KEY_A = 'key-tenant-a';
const KEY_B = 'key-tenant-b';
const TENANT_A = 'acme';
const TENANT_B = 'globex';

const DEPTS = [
  {
    departmentId: 'dept-marketing',
    name: 'Marketing',
    parentDepartmentId: null,
    roles: [{ roleId: 'role-cm', name: 'Campaign Manager' }],
  },
  {
    departmentId: 'dept-social',
    name: 'Social',
    parentDepartmentId: 'dept-marketing',
    roles: [{ roleId: 'role-sm', name: 'Social Manager' }],
  },
];

interface ChartBody {
  tenantId?: string;
  departments?: { departmentId: string }[];
  members?: { rosterId: string }[];
  error?: string;
}

interface ViewBody {
  department?: { departmentId: string };
  members?: { rosterId: string }[];
  responsibilities?: string[];
  error?: string;
}

describe('RFC 0087 §D — normative GET /v1/agents/org-chart', () => {
  let server: http.Server;
  let BASE: string;
  const prevKeys = process.env.OPENWOP_API_KEYS;

  beforeAll(async () => {
    // Two CONFIGURED, tenant-scoped keys — `auth.ts` pins `req.tenantId` to the
    // key's own tenant, which is the guard the normative route inherits.
    process.env.OPENWOP_API_KEYS = `${KEY_A}:${TENANT_A},${KEY_B}:${TENANT_B}`;
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({
      port: 0,
      storageDsn: 'memory://',
      serviceName: 'test',
      serviceVersion: '0.0.1',
      enableConsoleTracer: false,
    });
    await new Promise<void>((res) => {
      server = app.listen(0, '127.0.0.1', () => {
        BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        res();
      });
    });
  });

  afterAll(async () => {
    if (prevKeys === undefined) delete process.env.OPENWOP_API_KEYS;
    else process.env.OPENWOP_API_KEYS = prevKeys;
    await new Promise<void>((res) => server.close(() => res()));
  });

  beforeEach(async () => {
    await __resetRosterStore();
    await __resetOrgChartStore();
  });

  async function get<T>(path: string, key: string): Promise<{ status: number; body: T }> {
    const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${key}` } });
    return { status: res.status, body: (await res.json()) as T };
  }

  /** Seed a one-member chart owned by `tenantId`, through the SAME service the
   *  routes read — no second store, so the test cannot pass against a fixture
   *  the production path never sees. */
  async function seedChart(tenantId: string, workflows: string[]): Promise<string> {
    const entry = await createRosterEntry({
      tenantId,
      persona: `persona-${tenantId}`,
      agentRef: { agentId: 'core.openwop.agents.brief-writer' },
      workflows,
    });
    const rosterId = (entry as { rosterId: string }).rosterId;
    const result = await putChart({
      tenantId,
      departments: DEPTS,
      members: [
        { rosterId, departmentId: 'dept-social', roleId: 'role-sm', reportsTo: null },
      ],
    });
    expect('error' in result, JSON.stringify(result)).toBe(false);
    return rosterId;
  }

  it('serves the chart at the NORMATIVE path — it is not shadowed by /v1/agents/:agentId', async () => {
    const rosterId = await seedChart(TENANT_A, ['wf-a']);
    const { status, body } = await get<ChartBody>('/v1/agents/org-chart', KEY_A);

    expect(status).toBe(200);
    // The shadowing failure mode is specifically a 404 whose body is the
    // agent-not-installed error, so assert the SHAPE, not merely the status.
    expect(body.error).toBeUndefined();
    expect(body.departments?.map((d) => d.departmentId).sort()).toEqual(['dept-marketing', 'dept-social']);
    expect(body.members?.map((m) => m.rosterId)).toEqual([rosterId]);
  });

  it('is tenant-scoped — a second tenant never sees the first tenant\'s chart', async () => {
    await seedChart(TENANT_A, ['wf-a']);

    const a = await get<ChartBody>('/v1/agents/org-chart', KEY_A);
    const b = await get<ChartBody>('/v1/agents/org-chart', KEY_B);

    expect(a.body.members).toHaveLength(1);
    // §C / CTI-1 — B has no chart, so B reads an EMPTY chart, never A's rows.
    expect(b.status).toBe(200);
    expect(b.body.departments).toEqual([]);
    expect(b.body.members).toEqual([]);
  });

  it('serves the §D responsibility roll-up, and narrows it with ?recursive=false', async () => {
    await seedChart(TENANT_A, ['wf-social-1', 'wf-social-2']);

    const recursive = await get<ViewBody>('/v1/agents/org-chart/dept-marketing', KEY_A);
    expect(recursive.status).toBe(200);
    expect(recursive.body.department?.departmentId).toBe('dept-marketing');
    // The member sits in the SUB-department, so a recursive roll-up reaches it.
    expect(recursive.body.responsibilities?.sort()).toEqual(['wf-social-1', 'wf-social-2']);

    const direct = await get<ViewBody>('/v1/agents/org-chart/dept-marketing?recursive=false', KEY_A);
    expect(direct.status).toBe(200);
    // §D — narrowing changes the CONTENT, never the SHAPE.
    expect(direct.body.department?.departmentId).toBe('dept-marketing');
    expect(direct.body).toHaveProperty('responsibilities');
    expect(direct.body.responsibilities).toEqual([]);
  });

  it('404s an unknown department, and a cross-tenant one identically', async () => {
    await seedChart(TENANT_A, ['wf-a']);

    const unknown = await get<ViewBody>('/v1/agents/org-chart/dept-nope', KEY_A);
    expect(unknown.status).toBe(404);

    // B asking for a department that exists ONLY in A's chart gets the SAME
    // 404 as a department that exists nowhere — the response must not
    // distinguish "absent" from "not yours".
    const crossTenant = await get<ViewBody>('/v1/agents/org-chart/dept-social', KEY_B);
    expect(crossTenant.status).toBe(404);
    expect(crossTenant.body.error).toBe(unknown.body.error);
  });

  it('keeps the host-extension alias serving the same chart', async () => {
    await seedChart(TENANT_A, ['wf-a']);
    const normative = await get<ChartBody>('/v1/agents/org-chart', KEY_A);
    const hostExt = await get<ChartBody>('/v1/host/openwop-app/org-chart', KEY_A);
    expect(hostExt.status).toBe(200);
    expect(hostExt.body.members).toEqual(normative.body.members);
  });
});
