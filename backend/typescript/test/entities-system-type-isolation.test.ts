/**
 * ADR 0409 — SYSTEM types (crm.company/deal, cms.page, commerce.product) are
 * INVISIBLE to the generic user-facing entities API. Without this, a user with
 * `workspace:read` + the `entities` toggle on could query `crm.company` via the
 * generic routes and read companies ACROSS ALL ORGS, bypassing the CRM façade's
 * per-org RBAC. Pinned at the HTTP boundary (routes) + the workflow surface.
 *
 * TST-DAA-8. Red when (sabotage-witnessed, wave 70): `requireEntitiesScope`
 * stops 404ing a system type; the `/types` list or the surface `listTypes`
 * stops filtering `system`; surface `getType`/`query` serve a system type;
 * `assertNotSystemWrite` stops refusing a delete.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createCompany, getCompany } from '../src/features/crm/entities/companies.js';
import type { BundleScope } from '../src/host/inMemorySurfaces.js';
import { buildEntitiesSurface } from '../src/features/entities/surface.js';

let BASE: string;
let server: http.Server;

function client() {
  let cookie = '';
  const send = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const c of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    return res;
  };
  return {
    get: (p: string) => send('GET', p),
    post: (p: string, b?: unknown) => send('POST', p, b),
    login: async (subject: string, tenantId: string) => {
      const res = await send('POST', '/host/openwop-app/test/login', { subject, tenantId });
      expect([200, 201]).toContain(res.status);
    },
  };
}

const T = 'tenant-sys-iso';
const SCOPE: BundleScope = { tenantId: T, runId: 'r1' };
let COMPANY_ID = '';

/** The system-type refusal: the uniform 404, not a toggle-off 404. */
async function expectTypeNotFound(res: Response): Promise<void> {
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error?: string; message?: string };
  expect(body.error).toBe('not_found');
  expect(body.message).toBe('Entity type not found.');
}
const E = '/host/openwop-app/entities';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; resolve(); }); });
  const d = getToggleDefault('entities');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  // A company exists (a crm.company system-type kernel row).
  COMPANY_ID = (await createCompany({ tenantId: T, orgId: 'org-secret', name: 'Confidential Co', createdBy: 'u1' })).companyId;
});

afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

describe('ADR 0409 — system types are invisible to the generic entities API', () => {
  it('the generic /entities/types list excludes crm.company', async () => {
    const c = client();
    await c.login('owner-sys', T);
    const res = await c.get(`${E}/types`);
    expect(res.status).toBe(200);
    const names = ((await res.json()) as { types: Array<{ name: string }> }).types.map((t) => t.name);
    expect(names).not.toContain('crm.company');
  });

  it('the generic query/get routes 404 a system type (no cross-org RBAC bypass)', async () => {
    const c = client();
    await c.login('owner-sys', T);
    await expectTypeNotFound(await c.post(`${E}/types/crm.company/query`, { filters: [] }));
    await expectTypeNotFound(await c.get(`${E}/types/crm.company`));
    await expectTypeNotFound(await c.get(`${E}/types/crm.company/entities`));
  });

  it('the workflow surface read verbs refuse a system type', async () => {
    const surface = buildEntitiesSurface(SCOPE);
    const types = (await surface.listTypes!({})) as { types: Array<{ name: string }> };
    expect(types.types.map((t) => t.name)).not.toContain('crm.company');
    expect((await surface.getType!({ typeName: 'crm.company' })) as { type: unknown }).toEqual({ type: null });
    expect((await surface.query!({ typeName: 'crm.company' })) as { entities: unknown[] }).toMatchObject({ entities: [], total: 0 });
  });

  it('the workflow surface DELETE verb refuses a system type (façade cascade + org-RBAC bypass guard)', async () => {
    // Without the deleteEntity system-write guard, a workflow node could delete
    // a crm.company kernel row straight out from under the CRM façade — skipping
    // the cascade (dangling companyId on deals) and the org scope.
    const surface = buildEntitiesSurface(SCOPE);
    await expect((surface.delete!({ typeName: 'crm.company', entityId: COMPANY_ID })) as Promise<unknown>)
      .rejects.toThrow(/`crm\.company` is a system type/);
    // The REAL company row survives — the refusal is not a no-op on an absent id.
    expect((await getCompany(T, 'org-secret', COMPANY_ID))?.name).toBe('Confidential Co');
  });
});
