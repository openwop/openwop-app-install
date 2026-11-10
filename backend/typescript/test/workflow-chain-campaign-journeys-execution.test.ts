/**
 * campaign-journeys workflow-chain pack — REAL execution (ADR 0222, RFC 0013).
 *
 * The REAL expanded definition (loader → `expandChain`), the REAL node packs
 * (`feature.campaign-journeys.nodes`, `feature.crm.nodes`,
 * `core.openwop.integration`), the REAL `ctx.features` surfaces over REAL seeded
 * CRM data, and the REAL executor (`POST /v1/runs`, direct run-start — no
 * host-event binding). Each run is driven to the sign-off gate's SUSPEND (a
 * designed human gate is never forced); `re-engage-contact`'s happy path then
 * RESUMES it (`POST /v1/interrupts/:token`) and runs to `completed`.
 *
 * Every run uses ONLY the chain's declared `parameters`. The chain's node-level
 * `inputs` (the literal `journeyId`, the `{{params.contactId}}` token) reach
 * `ctx.inputs` through ADR 0237 `resolveDeclaredInputs` / `buildNodeCtxInputs`
 * (`executor/nodeCtxInputs.ts`; declared inputs win on conflict) and CHAINX-5
 * (`validateWorkflowDefinition` preserves `inputs`). This file's header used to
 * document that path as broken and every case passed an extra `journeyId` run
 * input as a "workaround" — inert since those fixes (corrected /grade-tests w31).
 *
 * What each case witnesses:
 *  - happy path: real eligibility read → approval → ONE send to the mock
 *    SendGrid with the contact's address and the chain's `senderEmail` → the
 *    follow-up task lands in the run's org (`orgId` param);
 *  - ADR 0655 D2: no email Connection ⇒ the approved send is a typed NODE
 *    FAILURE (`email_not_connected`), the run FAILS;
 *  - ADR 0655 D1 / JRNY-1: a SUPPRESSED contact is refused at the enroll
 *    pre-check — never reaches sign-off or the provider. Since ADR 1024 D6 the
 *    refusal ENDS the run cleanly (`completed`, through the `not-enrolled`
 *    terminal, `stopped: suppressed`) instead of failing it. (The send-step floor itself is witnessed by
 *    `email-egress-guard.test.ts` › 'a SUPPRESSED address is refused …, no
 *    provider call'; in this chain the enroll pre-check and the post-approval
 *    recheck both refuse before it.)
 *  - JRNY-1: a no-email contact stops at `enroll` (ADR 1024: `completed`,
 *    `stopped` set, the sign-off never reached);
 *  - the enrollment guard: a second run for the same (journey, contact) stops at
 *    `enroll` with `stopped: already_enrolled` and never re-sends;
 *  - welcome-series: the trigger → enroll → eligibility path suspends at sign-off.
 *
 * Sabotage: replacing enroll's CAS with a put reds the enrollment-guard case;
 * mapping a returned node error to `pack_node_error` reds the two code cases;
 * returning `sent:true` on no_connection reds D2; `suppressionBlocksSend` →
 * 'clear' reds D1; ignoring declared node inputs reds every enroll-dependent
 * case. The 25 ms × 80 run-settle poll is an honest ceiling (no settle hook).
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getChain, expandChain } from '../src/host/workflowChainPackLoader.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { bareRunId } from './support/bareRunId.js';

let BASE: string;
let server: http.Server;

let sgCalls = 0;
/** Parsed SendGrid v3 bodies the mock received (the real recipient + sender). */
let sgBodies: Array<{ personalizations?: Array<{ to?: Array<{ email: string }> }>; from?: { email?: string } }> = [];
let sgServer: http.Server | undefined;
beforeAll(async () => {
  // ADR 0655 D2 — a REAL send target so the approval path can complete: a failed
  // send is a typed node failure now, so the old "no provider ⇒ sent:false ⇒ run
  // still completes" shape no longer proves the downstream task lands.
  sgServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { chunks.push(c); });
    req.on('end', () => {
      sgCalls += 1;
      try { sgBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { sgBodies.push({}); }
      res.writeHead(202, { 'x-message-id': `sg-${sgCalls}` }); res.end();
    });
  });
  await new Promise<void>((r) => sgServer!.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_SENDGRID_API_BASE = `http://127.0.0.1:${(sgServer.address() as AddressInfo).port}`;
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const users = getToggleDefault('users');
  if (users) await saveConfig({ ...users, status: 'on' }, 'test');
  const crm = getToggleDefault('crm');
  if (crm) await saveConfig({ ...crm, status: 'on' }, 'test');
  const campaignJourneys = getToggleDefault('campaign-journeys');
  if (campaignJourneys) await saveConfig({ ...campaignJourneys, status: 'on' }, 'test');
});
afterAll(async () => { delete process.env.OPENWOP_SENDGRID_API_BASE; delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE; if (sgServer) await new Promise<void>((r) => sgServer!.close(() => r())); await new Promise<void>((res) => server.close(() => res())); });

/** The union of response-body fields this file reads (each route returns a subset). */
interface Body {
  contactId?: string; runId?: string; orgId?: string; status?: string; workflowId?: string;
  user?: { userId?: string };
  events?: BundleEvent[];
  interrupts?: Array<{ token: string; nodeId: string }>;
  tasks?: Array<{ title: string }>;
  error?: { code: string; message: string };
}
interface Res { status: number; body: Body }
interface Client {
  get: (p: string) => Promise<Res>;
  post: (p: string, b?: unknown) => Promise<Res>;
}
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const sc = getSetCookies(res.headers);
    for (const c of sc as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = (res.status === 204 ? {} : await res.json().catch(() => ({}))) as Body;
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}

let n = 0;
async function ownerOrg(): Promise<{ owner: Client; orgId: string; tenantId: string; userId: string }> {
  const tenantId = `org:cjchain-${Date.now()}-${n++}`;
  const owner = client();
  const r = await owner.post('/host/openwop-app/test/login', { email: `cjchain-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.post('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId as string, tenantId, userId: String(r.body.user?.userId ?? '') };
}
/** ADR 0655 — bind a SendGrid connection to the run's acting user so the executor's
 *  `ctx.email.send` reaches the mock (the brokered egress resolves the USER's connection). */
async function connectSendgrid(tenantId: string, userId: string): Promise<void> {
  const { createSecretConnection } = await import('../src/features/connections/connectionsService.js');
  await createSecretConnection({ tenantId, provider: 'sendgrid', kind: 'api_key', secret: 'SG.testkey', scope: 'user', userId });
}

interface RunSnapshot { status: string; error?: { code: string; message: string } }
async function pollRun(owner: Client, runId: string): Promise<RunSnapshot> {
  let snap: RunSnapshot = { status: 'pending' };
  for (let i = 0; i < 80; i++) {
    const r = await owner.get(`/runs/${runId}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    snap = r.body as RunSnapshot;
    if (snap.status === 'completed' || snap.status === 'failed' || snap.status === 'cancelled' || snap.status.startsWith('waiting')) break;
    await new Promise((res) => setTimeout(res, 25));
  }
  return snap;
}

interface BundleEvent { type?: string; nodeId?: string; payload?: Record<string, unknown> }
async function bundleEvents(owner: Client, runId: string): Promise<BundleEvent[]> {
  const b = await owner.get(`/host/openwop-app/runs/${bareRunId(runId)}/debug-bundle`);
  expect(b.status, JSON.stringify(b.body)).toBe(200);
  return (b.body.events as BundleEvent[]) ?? [];
}
function completedOutputs(events: BundleEvent[], nodeSuffix: string): Record<string, unknown> {
  const ev = events.find((e) => e.type === 'node.completed' && e.nodeId?.endsWith(`_${nodeSuffix}`));
  expect(ev, `expected a node.completed event for node "${nodeSuffix}": ${JSON.stringify(events.map((e) => ({ type: e.type, nodeId: e.nodeId })))}`).toBeTruthy();
  return (ev!.payload!.outputs as Record<string, unknown>) ?? {};
}

/** ADR 1024 D6 — a run that stopped at `enroll` for the person's own state: it COMPLETES
 *  through the `not-enrolled` terminal, `enroll` records why, and nothing past it ran. */
function expectStoppedAtEnroll(events: BundleEvent[], stopped: RegExp): void {
  const where = JSON.stringify(events.map((e) => ({ type: e.type, nodeId: e.nodeId })));
  expect(events.filter((e) => e.type === 'node.failed'), where).toHaveLength(0);
  expect(completedOutputs(events, 'enroll'), where).toMatchObject({ enrolled: false });
  expect(JSON.stringify(completedOutputs(events, 'enroll')), where).toMatch(stopped);
  expect(events.some((e) => e.type === 'node.completed' && e.nodeId?.endsWith('_not-enrolled')), `the not-enrolled terminal ran: ${where}`).toBe(true);
  expect(events.some((e) => e.nodeId?.endsWith('_signoff')), 'never reaches the sign-off gate').toBe(false);
}

/** Resolve the open interrupt whose nodeId ends with `nodeSuffix` via the
 *  RFC 0093 capability-token resume path (`chat-suspend-resume.test.ts`). */
async function resumeInterrupt(owner: Client, runId: string, nodeSuffix: string, resumeValue: Record<string, unknown>): Promise<void> {
  const ints = await owner.get(`/host/openwop-app/runs/${bareRunId(runId)}/interrupts`);
  expect(ints.status, JSON.stringify(ints.body)).toBe(200);
  const interrupts = ints.body.interrupts as Array<{ token: string; nodeId: string }>;
  const target = interrupts.find((i) => i.nodeId.endsWith(nodeSuffix));
  expect(target, `expected an open interrupt for a node ending in "${nodeSuffix}": ${JSON.stringify(interrupts)}`).toBeTruthy();
  const resolve = await owner.post(`/interrupts/${target!.token}`, { resumeValue });
  expect([200, 202, 204]).toContain(resolve.status);
}

describe('campaign-journeys.re-engage-contact — end-to-end execution (real executor, direct run-start)', () => {
  it('suspends at the sign-off gate with real eligibility data, then on approval creates the follow-up task in the correct org', async () => {
    const { owner, orgId, tenantId, userId } = await ownerOrg();
    sgCalls = 0; sgBodies = [];
    await connectSendgrid(tenantId, userId);
    const contact = await owner.post('/host/openwop-app/crm/contacts', { name: 'Quiet Customer', email: 'quiet@acme.test' });
    expect(contact.status, JSON.stringify(contact.body)).toBe(201);
    const contactId = contact.body.contactId as string;

    const found = getChain('campaign-journeys.re-engage-contact');
    expect(found, 'campaign-journeys.re-engage-contact chain must be loaded at boot').toBeTruthy();
    const params = { contactId, senderEmail: 'sender@acme.test', orgId, subject: 'We miss you', body: 'Come back!' };
    const expanded = expandChain(found!.chain, { params });
    registerWorkflow(expanded);

    const create = await owner.post('/runs', { workflowId: expanded.workflowId, inputs: params });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId as string;

    const snap = await pollRun(owner, runId);
    expect(snap.status.startsWith('waiting'), `expected the run to suspend at the sign-off gate: ${JSON.stringify(snap)}`).toBe(true);

    const events = await bundleEvents(owner, runId);
    // Real CRM read: the eligibility gate saw the REAL seeded contact.
    expect(completedOutputs(events, 'gate')).toMatchObject({ eligible: true, contactId, email: 'quiet@acme.test', name: 'Quiet Customer' });

    await resumeInterrupt(owner, runId, '_signoff', { decision: 'accept' });

    const done = await pollRun(owner, runId);
    // ADR 0655 D2 (WF-EM-7 / EMWF-5) — this used to pin `completed` with
    // `{sent:false, error:'email_not_connected'}`: a run that mailed nobody
    // completed green. A failed send is now a typed NODE FAILURE (its own test
    // below), so this happy path connects a REAL send target and asserts the send.
    expect(done.status, `run should complete after approval: ${JSON.stringify(done)}`).toBe('completed');
    const doneEvents = await bundleEvents(owner, runId);
    expect(completedOutputs(doneEvents, 'send')).toMatchObject({ sent: true });
    expect(sgCalls, 'the mock provider received exactly one send').toBe(1);
    // …to the contact's real address, from the chain's `senderEmail` param.
    expect(sgBodies[0]?.personalizations?.[0]?.to?.map((t) => t.email)).toEqual(['quiet@acme.test']);
    expect(sgBodies[0]?.from?.email).toBe('sender@acme.test');

    // BUG-2 fix proof: the follow-up task landed in the RIGHT org.
    const tasks = await owner.get(`/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}/tasks`);
    expect(tasks.status, JSON.stringify(tasks.body)).toBe(200);
    const followUp = (tasks.body.tasks as Array<{ title: string }>).find((t) => t.title === 'Follow up on re-engagement');
    expect(followUp, `expected a follow-up task in org ${orgId}: ${JSON.stringify(tasks.body)}`).toBeTruthy();
  });

  // ADR 0655 D2 — with NO email Connection for this tenant, the approved send is a
  // typed NODE FAILURE (`email_not_connected`) and the run FAILS. It used to
  // complete green with `sent:false`.
  it('ADR 0655 D2: with no email Connection the approved send FAILS the run typed (email_not_connected)', async () => {
    const { owner, orgId } = await ownerOrg();
    const contact = await owner.post('/host/openwop-app/crm/contacts', { name: 'Unwired', email: 'unwired@acme.test' });
    expect(contact.status).toBe(201);
    const contactId = contact.body.contactId as string;
    const found = getChain('campaign-journeys.re-engage-contact');
    const params = { contactId, senderEmail: 'sender@acme.test', orgId, subject: 'Hello', body: 'Hi' };
    const expanded = expandChain(found!.chain, { params });
    registerWorkflow(expanded);
    const create = await owner.post('/runs', { workflowId: expanded.workflowId, inputs: params });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId as string;
    const snap = await pollRun(owner, runId);
    expect(snap.status.startsWith('waiting'), JSON.stringify(snap)).toBe(true);
    await resumeInterrupt(owner, runId, '_signoff', { decision: 'accept' });
    const done = await pollRun(owner, runId);
    expect(done.status, JSON.stringify(done)).toBe('failed');
    const failed = (await bundleEvents(owner, runId)).filter((e) => e.type === 'node.failed');
    expect(JSON.stringify(failed)).toContain('email_not_connected');
  });

  // ADR 0655 D1 / JRNY-1 — a SUPPRESSED contact is refused at the FIRST guard the
  // chain has: the enroll pre-check. (This case used to claim the refusal came from
  // the send node; with the suppression in place before the run, the enroll
  // pre-check always refuses first and the run never suspends. The send floor is
  // witnessed by email-egress-guard.test.ts.)
  it('ADR 0655 D1 / JRNY-1: a SUPPRESSED contact is refused at the enroll pre-check — never reaches sign-off or the provider', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const contact = await owner.post('/host/openwop-app/crm/contacts', { name: 'Opted Out', email: 'optedout@acme.test' });
    expect(contact.status, JSON.stringify(contact.body)).toBe(201);
    const contactId = contact.body.contactId as string;
    const { addSuppression } = await import('../src/features/crm/suppressionService.js');
    await addSuppression(tenantId, 'optedout@acme.test', 'unsubscribed', `contact:${contactId}`, 'test');

    const found = getChain('campaign-journeys.re-engage-contact');
    expect(found, 're-engage chain must load').toBeTruthy();
    const params = { contactId, senderEmail: 'sender@acme.test', orgId, subject: 'We miss you', body: 'Come back!' };
    const expanded = expandChain(found!.chain, { params });
    registerWorkflow(expanded);
    const create = await owner.post('/runs', { workflowId: expanded.workflowId, inputs: params });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId as string;
    const snap = await pollRun(owner, runId);
    expect(snap.status, JSON.stringify(snap)).toBe('completed');
    const events = await bundleEvents(owner, runId);
    expectStoppedAtEnroll(events, /"stopped":"suppressed"/);
    expect(JSON.stringify(events)).not.toContain('email_not_connected');
  });

  it('stops cleanly for an ineligible contact at the enroll pre-check — never enrolls or reaches the sign-off gate (JRNY-1, ADR 1024 D6)', async () => {
    const { owner, orgId } = await ownerOrg();
    const contact = await owner.post('/host/openwop-app/crm/contacts', { name: 'No Email Contact' });
    expect(contact.status, JSON.stringify(contact.body)).toBe(201);
    const contactId = contact.body.contactId as string;

    const found = getChain('campaign-journeys.re-engage-contact');
    expect(found, 'campaign-journeys.re-engage-contact chain must be loaded at boot').toBeTruthy();
    const params = { contactId, senderEmail: 'sender@acme.test', orgId };
    const expanded = expandChain(found!.chain, { params });
    registerWorkflow(expanded);

    const create = await owner.post('/runs', { workflowId: expanded.workflowId, inputs: params });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId as string;

    const snap = await pollRun(owner, runId);
    // ADR 1024 D6: a person with no address is a correct end of their journey, not a failed
    // run. JRNY-1 still holds: the stop is at `enroll`, before the ledger claim.
    expect(snap.status, `run should stop at the enroll pre-check: ${JSON.stringify(snap)}`).toBe('completed');
    expectStoppedAtEnroll(await bundleEvents(owner, runId), /"stopped":"no_(email|address)"/);
  });

  it('enrollment guard: a second run for the same (journey, contact) stops at enroll with already_enrolled', async () => {
    const { owner, orgId } = await ownerOrg();
    const contact = await owner.post('/host/openwop-app/crm/contacts', { name: 'Repeat Customer', email: 'repeat@acme.test' });
    expect(contact.status, JSON.stringify(contact.body)).toBe(201);
    const contactId = contact.body.contactId as string;

    const found = getChain('campaign-journeys.re-engage-contact');
    expect(found, 'campaign-journeys.re-engage-contact chain must be loaded at boot').toBeTruthy();
    const params = { contactId, senderEmail: 'sender@acme.test', orgId };
    const expanded = expandChain(found!.chain, { params });
    registerWorkflow(expanded);
    const inputs = params;

    const first = await owner.post('/runs', { workflowId: expanded.workflowId, inputs });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const firstSnap = await pollRun(owner, first.body.runId as string);
    expect(firstSnap.status.startsWith('waiting'), `first run should reach the sign-off gate: ${JSON.stringify(firstSnap)}`).toBe(true);

    const second = await owner.post('/runs', { workflowId: expanded.workflowId, inputs });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const secondSnap = await pollRun(owner, second.body.runId as string);
    // ADR 1024 D6: the guard still refuses the second enrollment (nothing re-sends); the run
    // now ENDS there instead of failing.
    expect(secondSnap.status, `second run should stop — already enrolled: ${JSON.stringify(secondSnap)}`).toBe('completed');
    expectStoppedAtEnroll(await bundleEvents(owner, second.body.runId as string), /"stopped":"already_enrolled"/);
  });
});

describe('campaign-journeys.welcome-series — end-to-end execution (real executor, trigger-fed direct run-start)', () => {
  it('a client-bound welcome reaches approval with frozen client inputs and no provider calls', async () => {
    const { owner, orgId, tenantId, userId } = await ownerOrg();
    const { createClient } = await import('../src/features/campaign-ops/clientService.js');
    await createClient({ tenantId, orgId, name: 'Welcome client (synthetic)', createdBy: userId });
    const contact = await owner.post('/host/openwop-app/crm/contacts', { name: 'Client Signup', email: 'client-signup@acme.test' });
    expect(contact.status, JSON.stringify(contact.body)).toBe(201);
    const contactId = String(contact.body.contactId);
    const found = getChain('campaign-journeys.welcome-series');
    if (!found) throw new Error('Welcome series must be loaded');
    const params = { contactId, orgId, senderEmail: 'sender@acme.test', triggerEventName: 'host.webinar.registered' };
    const installed = await owner.post('/host/openwop-app/workflows/from-chain', { chainId: found.chain.chainId, params });
    expect(installed.status, JSON.stringify(installed.body)).toBe(201);
    const workflowId = installed.body.workflowId;
    if (!workflowId) throw new Error('From-chain must return the owned workflow id');
    const before = sgCalls;
    // An event-started run does not copy instantiation parameters into run inputs.
    // The frozen chain itself must carry the client all the way to each guard.
    const create = await owner.post('/runs', { workflowId, inputs: {} });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = String(create.body.runId);
    const snap = await pollRun(owner, runId);
    const events = await bundleEvents(owner, runId);
    expect(sgCalls).toBe(before);
    expect(snap.status.startsWith('waiting'), JSON.stringify({ snap, events })).toBe(true);
    expect(completedOutputs(events, 'gate1')).toMatchObject({ eligible: true, contactId, email: 'client-signup@acme.test' });
    const { listEnrollments } = await import('../src/features/campaign-journeys/journeyService.js');
    expect(await listEnrollments(tenantId, 'welcome-series', orgId)).toEqual([
      expect.objectContaining({ orgId, contactId }),
    ]);
  });

  it('walks the REAL trigger → enroll → eligibility path and suspends at the sign-off gate with real contact data', async () => {
    const { owner } = await ownerOrg();
    const contact = await owner.post('/host/openwop-app/crm/contacts', { name: 'New Signup', email: 'newsignup@acme.test' });
    expect(contact.status, JSON.stringify(contact.body)).toBe(201);
    const contactId = contact.body.contactId as string;

    const found = getChain('campaign-journeys.welcome-series');
    expect(found, 'campaign-journeys.welcome-series chain must be loaded at boot').toBeTruthy();
    const params = { contactId, senderEmail: 'sender@acme.test', triggerEventName: 'host.crm.contact.created' };
    const expanded = expandChain(found!.chain, { params });
    registerWorkflow(expanded);

    const create = await owner.post('/runs', { workflowId: expanded.workflowId, inputs: params });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = create.body.runId as string;

    const snap = await pollRun(owner, runId);
    expect(snap.status.startsWith('waiting'), `expected the run to suspend at the sign-off gate: ${JSON.stringify(snap)}`).toBe(true);

    const events = await bundleEvents(owner, runId);
    // Real CRM read via the trigger→enroll→eligibility path (a DIFFERENT
    // ctx.inputs-threading route than re-engage-contact's source-node path —
    // worth proving separately).
    expect(completedOutputs(events, 'gate1')).toMatchObject({ eligible: true, contactId, email: 'newsignup@acme.test', name: 'New Signup' });

    const ints = await owner.get(`/host/openwop-app/runs/${bareRunId(runId)}/interrupts`);
    expect(ints.status, JSON.stringify(ints.body)).toBe(200);
    const gate = (ints.body.interrupts as Array<{ nodeId: string }>).find((i) => i.nodeId.endsWith('_signoff'));
    expect(gate, `expected a pending interrupt for the sign-off gate: ${JSON.stringify(ints.body)}`).toBeTruthy();
  });
});
