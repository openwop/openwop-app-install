/**
 * ADR 0837 D7 — the contact Triage action runs real work (`CRM2WF-1`).
 *
 * Before: the route launched the demo `openwop-app.uppercase` workflow, which
 * never read the contact, and the toggle variant's `crm.triage` binding was
 * stamped and never consumed (ADR 0819 §6). Now the route starts `crm-ops.triage`
 * (chain-backed, same id) with `{ contactId, variant }` as run inputs, through the
 * REAL loader, starter, executor, node pack and surface, and the result lands on
 * the contact. Witnessed here end to end, plus the replay-determinism probe
 * (PROBE-CRM2-1) and the closed candidate set.
 *
 * Sabotage-witnessed (w4 grade-tests): defaulting the route back to the demo
 * workflow, dropping the enriched company bump, opening the candidate set,
 * un-guarding `restoreContactTriage`, admitting a member-chosen workflow, or a
 * nondeterministic chain-backed build each reds its own case.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildChainBackedDefinition } from '../src/host/chainBackedWorkflows.js';
import { getContact, restoreContactTriage, setContactTriage } from '../src/features/crm/contactsService.js';
import { triageVariantFor, CRM_TRIAGE_WORKFLOW_ID } from '../src/features/crm/triageDispatch.js';
import type { Storage } from '../src/storage/storage.js';

let BASE: string;
let server: http.Server;
let storage: Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_CRM_TRIAGE_WORKFLOW_ID;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const users = getToggleDefault('users');
  if (users) await saveConfig({ ...users, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function client() {
  let cookie = '';
  const post = async (path: string, body?: unknown): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  return { post };
}

/** Force every tenant onto one variant, keeping the shipped bindings. */
async function onlyVariant(key: 'basic' | 'enriched'): Promise<void> {
  const def = getToggleDefault('crm')!;
  await saveConfig({ ...def, status: 'on', variants: (def.variants ?? []).map((v) => ({ ...v, weight: v.key === key ? 100 : 0 })) }, 'test');
}

/** Honest ceiling: no run-settle hook exists to await, so this is a bounded
 *  (200 × 25 ms) poll on the real condition, not a fixed sleep. */
async function waitTerminal(runId: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const run = await storage.getRun(runId);
    if (run && ['completed', 'failed', 'cancelled'].includes(run.status)) return run.status;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`run ${runId} did not settle`);
}

let n = 0;
interface TriageStarted { runId: string; workflowId: string; triageVariant: string }
async function triage(variant: 'basic' | 'enriched'): Promise<{ contactId: string; runId: string; body: TriageStarted }> {
  await onlyVariant(variant);
  const c = client();
  const login = await c.post('/host/openwop-app/test/login', { email: `a0837tr-${Date.now()}-${n++}@acme.test`, tenantId: `org:a0837tr-${Date.now()}-${n++}` });
  expect(login.status).toBe(201);
  const contact = await c.post('/host/openwop-app/crm/contacts', { name: 'Ada', email: `ada-${n++}@acme.test`, company: 'Acme', stage: 'qualified' });
  expect(contact.status, JSON.stringify(contact.body)).toBe(201);
  const started = await c.post(`/host/openwop-app/crm/contacts/${encodeURIComponent((contact.body as { contactId: string }).contactId)}/triage`, {});
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  const body = started.body as TriageStarted;
  return { contactId: (contact.body as { contactId: string }).contactId, runId: body.runId, body };
}

describe('ADR 0837 D7 — the Triage action runs crm-ops.triage and records the result', () => {
  it('the enriched variant scores with the company bump and lands on the contact', async () => {
    const t = await triage('enriched');
    expect(t.body.workflowId).toBe(CRM_TRIAGE_WORKFLOW_ID); // RED on origin/main: openwop-app.uppercase
    expect(t.body.triageVariant).toBe('enriched');
    expect(await waitTerminal(t.runId)).toBe('completed');
    const contact = await getContact(t.contactId);
    expect(contact!.lastTriage).toMatchObject({ runId: t.runId, variant: 'enriched', score: 55, priority: 'normal' });
    const run = await storage.getRun(t.runId);
    expect(run!.inputs).toEqual({ contactId: t.contactId, variant: 'enriched' }); // what replay / :fork re-seed from
    expect((run!.metadata as { featureVariant?: { bindingSource?: string } }).featureVariant?.bindingSource).toBe('binding');
    // CRM2CD-1 (re-cut) — a host-trusted run of the OPERATOR's workflow: no
    // causing member is stamped (that broke operators / anon / unbound OIDC).
    expect((run!.metadata as { orgScopeSubject?: unknown }).orgScopeSubject).toBeUndefined();
  });

  it('the basic variant scores by stage only', async () => {
    const t = await triage('basic');
    expect(await waitTerminal(t.runId)).toBe('completed');
    expect((await getContact(t.contactId))!.lastTriage).toMatchObject({ runId: t.runId, variant: 'basic', score: 40, priority: 'normal' });
  });
});

describe('ADR 0837 D7 — dispatch rules', () => {
  it('PROBE-CRM2-1: the chain-backed definition builds byte-identically twice (replay determinism)', () => {
    const a = buildChainBackedDefinition(CRM_TRIAGE_WORKFLOW_ID);
    const b = buildChainBackedDefinition(CRM_TRIAGE_WORKFLOW_ID);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.workflowId).toBe(CRM_TRIAGE_WORKFLOW_ID);
    expect((a.variables ?? []).map((v) => v.name).sort()).toEqual(['contactId', 'variant']);
  });

  it('the candidate set is closed: no binding ⇒ basic (stamped default); an unknown node ⇒ 422', () => {
    expect(triageVariantFor(undefined)).toEqual({ variant: 'basic', bindingSource: 'default' });
    expect(triageVariantFor([{ slot: 'crm.triage', ref: { kind: 'node', name: 'feature.crm.nodes.triage-enriched', version: '9.9.9' } }]))
      .toEqual({ variant: 'enriched', bindingSource: 'binding' });
    expect(() => triageVariantFor([{ slot: 'crm.triage', ref: { kind: 'node', name: 'vendor.x.some-other-node', version: '1.0.0' } }]))
      .toThrow(expect.objectContaining({ httpStatus: 422 }));
  });
});

describe('ADR 0837 CRM2CD-2 — a dispatch stamp whose run never started is undone', () => {
  it('restores the previous stamp only while the stamp still names the failed run', async () => {
    const t = await triage('basic');
    expect(await waitTerminal(t.runId)).toBe('completed');
    const before = (await getContact(t.contactId))!.lastTriage!;
    const tenantId = (await getContact(t.contactId))!.tenantId;
    await setContactTriage(t.contactId, tenantId, { variant: 'basic', runId: 'run-never-started', at: new Date().toISOString() });
    await restoreContactTriage(t.contactId, tenantId, 'run-never-started', before);
    expect((await getContact(t.contactId))!.lastTriage).toEqual(before); // the last real result survives
    // A newer click is never reverted by an older failure.
    await setContactTriage(t.contactId, tenantId, { variant: 'basic', runId: 'run-newer', at: new Date().toISOString() });
    await restoreContactTriage(t.contactId, tenantId, 'run-never-started', before);
    expect((await getContact(t.contactId))!.lastTriage?.runId).toBe('run-newer');
  });
});

describe('ADR 0837 CRM2CD-1 — which workflow triage runs is the operator\'s choice', () => {
  it('a member naming a workflow is refused; the default runs; a personal workspace triages', async () => {
    await onlyVariant('basic');
    const c = client();
    // A PERSONAL workspace (no tenantId): R1 — the re-cut must work here too.
    expect((await c.post('/host/openwop-app/test/login', { email: `solo-${Date.now()}-${n++}@acme.test` })).status).toBe(201);
    const contact = await c.post('/host/openwop-app/crm/contacts', { name: 'Solo', email: `solo-c-${n++}@acme.test`, stage: 'lead' });
    expect(contact.status, JSON.stringify(contact.body)).toBe(201);
    const contactId = (contact.body as { contactId: string }).contactId;
    const path = `/host/openwop-app/crm/contacts/${encodeURIComponent(contactId)}/triage`;
    const chosen = await c.post(path, { workflowId: 'openwop-app.uppercase' });
    expect(chosen.status).toBe(400); // RED on origin/main: 202 — any member picked any workflow
    const started = await c.post(path, {});
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const { runId } = started.body as TriageStarted;
    expect(await waitTerminal(runId)).toBe('completed');
    expect((await getContact(contactId))!.lastTriage).toMatchObject({ runId, score: 10, priority: 'low' });
  });
});

