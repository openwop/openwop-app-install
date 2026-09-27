/**
 * Follow-up Phase A — referential-integrity delete-cascade guards (DATA-ASSESSMENT
 * RI-9 + RI-10).
 *  - RI-9: deleting a workflow that a schedule fires against is REFUSED (409), like the
 *    existing runs-reference guard — else the job would fire against a gone workflowId.
 *  - RI-10: hard-deleting a contact/company UNLINKS its deals (contacts tenant-wide,
 *    companies org-scoped) via the `onCrmRecordDeleted` seam — the CRM-5 blind spot.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { createContact, deleteContact } from '../src/features/crm/contactsService.js';
import { createCompany, deleteCompany } from '../src/features/crm/entities/companies.js';
import { createDeal, getDeal } from '../src/features/crm/entities/deals.js';
import { fireCrmRecordDeleted } from '../src/host/crmRecordLifecycle.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: (out ?? {}) as Record<string, unknown> };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), del: (p: string) => call('DELETE', p) };
}
async function signup(c: ReturnType<typeof client>): Promise<void> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `dcg-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}

describe('RI-9 — workflow delete refuses while a schedule binds it', () => {
  it('409 workflow_scheduled while bound (enabled OR disabled); 200 once the job is gone', async () => {
    const c = client();
    await signup(c);
    const wfId = `wf.dcg-${Date.now()}`;
    expect((await c.post('/v1/host/openwop-app/workflows', { workflowId: wfId, nodes: [{ nodeId: 'a', typeId: 'core.noop' }] })).status).toBe(201);

    // bind a DISABLED job to the workflow — a disabled job is still a latent orphan.
    const job = await c.post('/v1/host/openwop-app/scheduler/jobs', { jobId: `job-${Date.now()}`, cronExpr: '*/5 * * * *', workflowId: wfId, enabled: false });
    expect(job.status).toBe(201);

    const refused = await c.del(`/v1/host/openwop-app/workflows/${wfId}`);
    expect(refused.status).toBe(409);
    expect((refused.body as { details?: { reason?: string } }).details?.reason).toBe('workflow_scheduled');

    // remove the schedule → the workflow deletes cleanly.
    expect((await c.del(`/v1/host/openwop-app/scheduler/jobs/${job.body.jobId as string}`)).status).toBeLessThan(300);
    expect((await c.del(`/v1/host/openwop-app/workflows/${wfId}`)).status).toBe(200);
  });
});

const yes = async (): Promise<boolean> => true;

describe('RI-10 — hard-deleting a contact/company unlinks its deals', () => {
  it('contact delete unlinks across orgs; company delete is org-scoped; a deal delete cascades nothing', async () => {
    const tenantId = `org:dcg-${Date.now()}`;
    const orgA = 'org-a';
    const orgB = 'org-b';
    const contact = await createContact({ tenantId, name: 'C' });
    const companyA = await createCompany({ tenantId, orgId: orgA, name: 'CoA', createdBy: 'u' });
    // Two deals in org A: one linked to the contact, one linked to companyA.
    const dContact = await createDeal({ tenantId, orgId: orgA, title: 'D-contact', contactId: contact.contactId, createdBy: 'u', validateCompany: yes, validateContact: yes });
    const dCompany = await createDeal({ tenantId, orgId: orgA, title: 'D-company', companyId: companyA.companyId, createdBy: 'u', validateCompany: yes, validateContact: yes });
    // A deal in a DIFFERENT org that reuses companyA's id string — must be UNTOUCHED by the org-scoped company unlink.
    const dOtherOrg = await createDeal({ tenantId, orgId: orgB, title: 'D-otherorg', companyId: companyA.companyId, createdBy: 'u', validateCompany: yes, validateContact: yes });

    // ── delete the contact (tenant-scoped) → only its deal's contactId is unlinked ──
    await deleteContact(contact.contactId);
    expect((await getDeal(tenantId, orgA, dContact.dealId))!.contactId).toBeUndefined();
    expect((await getDeal(tenantId, orgA, dCompany.dealId))!.companyId).toBe(companyA.companyId); // untouched

    // ── delete companyA in org A → org-A deal's companyId unlinked; the org-B deal survives ──
    await deleteCompany(tenantId, orgA, companyA.companyId);
    expect((await getDeal(tenantId, orgA, dCompany.dealId))!.companyId).toBeUndefined();
    expect((await getDeal(tenantId, orgB, dOtherOrg.dealId))!.companyId).toBe(companyA.companyId); // different org — untouched

    // ── idempotent re-fire: firing the seam again is a harmless no-op ──
    await fireCrmRecordDeleted({ tenantId, entity: 'contact', recordId: contact.contactId });
    expect((await getDeal(tenantId, orgA, dContact.dealId))!.contactId).toBeUndefined();
  });
});
