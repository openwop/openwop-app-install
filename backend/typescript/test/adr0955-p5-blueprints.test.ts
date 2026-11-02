/**
 * ADR 0955 P5 — the journey blueprints, through the REAL loader and the REAL executor.
 *
 * Exit criterion (ADR 0955 phase table, P5): the blueprints load with zero chain errors and
 * instantiate per client. Also the chain-level witness `J955WF-5` owed by P2a/P3a: `send-time`
 * and `send-sms` run inside an expanded chain, through a sign-off gate, a one-day durable timer
 * and the send-time timer, to a real SMS send (a local Twilio stub).
 *
 * Two defects this witness found, both fixed here (red before, green after):
 *  - J955WF-7: `core.flow.wait` returned the timer's resolution value bare, so the host read it
 *    as a failure and EVERY run failed the moment its wait ended (welcome-series on main too).
 *  - J955WF-8: `send-time` derived its resume key from the time it chose, so on re-entry (just
 *    after that time) it chose tomorrow's, the key never matched, and it re-parked daily forever.
 *
 * Sabotage witnessed (each reds the named case, restored after):
 *  - post-webinar's send bound from the gate artifact instead of the re-check → the corpus WF-EM
 *    witness (`workflow-chain-email-reject-witness`, 3 cases)
 *  - the per-client `orgId` not threaded into the SMS step                    → "a real text" (no_sender)
 *  - `waitNode` returning the bare resume value (the pre-fix code)            → "a real text"
 *  - a `send-window:${sendAt}` resume key in `send-time` (the pre-fix code)   → "a real text"
 *  - abandoned-signup's last send bound from `recheck` instead of `gate2`   → "an unsubscribe … stops it"
 *  - post-webinar's second one-day wait removed                            → "two one-day waits"
 *  - `stopOnSuppressed` turning EVERY ineligible reason into a clean stop   → "only an unsubscribe"
 *  - the stopped branch's condition never matching                          → "an unsubscribe … stops it"
 *
 * Probes (wave 73): w73g3-p5bp-stop-any, -resumekey, -wait-bare, -stopped-value, -second-wait,
 * -sms-org — all witnessed. The sign-off resumes assert the route's exact 200 (it answers with
 * `res.json`), not a set of statuses. Run-settle polls a real 25 ms tick: the executor exposes no
 * completion hook to await (honest ceiling).
 *
 * Order (wave 73, TST-DRK): every case shares the timer store and the capture arrays, so
 * timers are swept through `sweepRun(runId)`, which continues and counts only the case's own
 * run, and deliveries are counted from the case's own starting length. (A shuffle seed that ran
 * the email-only cases first made the welcome case read 5 emails and sweep 5 timers.)
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getChain, expandChain, loadWorkflowChainPacks, defaultWorkflowChainPackRoots } from '../src/host/workflowChainPackLoader.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { sweepDueTimers } from '../src/executor/timerResume.js';
import { timerResumeContinuation } from '../src/routes/interrupts.js';
import { createClient } from '../src/features/campaign-ops/clientService.js';
import { createSecretConnection } from '../src/features/connections/connectionsService.js';
import { setSmsSender } from '../src/features/crm/smsSenders.js';
import { recordConsent, recordClientChannelConsent } from '../src/features/consent/consentService.js';
import { setSendPolicy } from '../src/features/campaign-journeys/sendPolicy.js';
import { addSuppression } from '../src/features/crm/suppressionService.js';
import { bareRunId } from './support/bareRunId.js';

const BLUEPRINTS = ['campaign-journeys.welcome-email-sms', 'campaign-journeys.post-webinar', 'campaign-journeys.abandoned-signup'];
let BASE = '';
let server: http.Server;
let storage: Storage;
let hostSuite: HostAdapterSuite;
let stub: http.Server;
const emails: string[] = [];
const texts: string[] = [];

beforeAll(async () => {
  stub = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.url?.includes('/Messages.json')) { texts.push(raw); res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ sid: `SM${texts.length}`, status: 'queued' })); return; }
      emails.push(raw); res.writeHead(202, { 'x-message-id': `sg-${emails.length}` }); res.end();
    });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  process.env.OPENWOP_SENDGRID_API_BASE = origin;
  process.env.OPENWOP_TWILIO_API_BASE = origin;
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage; hostSuite = app.locals.hostSuite;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'crm', 'consent', 'campaign-journeys', 'campaign-journeys.sms', 'campaign-ops']) {
    const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
}, 120_000);
afterAll(async () => {
  delete process.env.OPENWOP_SENDGRID_API_BASE; delete process.env.OPENWOP_TWILIO_API_BASE;
  await new Promise<void>((r) => stub.close(() => r()));
  await new Promise<void>((r) => server.close(() => r()));
});

describe('ADR 0955 P5 — the blueprints load and instantiate per client', () => {
  it('load with zero chain errors', async () => {
    const loaded = await loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
    const mine = loaded.errors.filter((e) => JSON.stringify(e).includes('campaign-journeys'));
    expect(mine, JSON.stringify(mine)).toEqual([]);
    for (const id of BLUEPRINTS) expect(getChain(id), id).toBeTruthy();
  });

  it('two clients get two workflows, each bound to its own client', () => {
    for (const id of BLUEPRINTS) {
      const chain = getChain(id)!.chain;
      const a = expandChain(chain, { params: { orgId: 'org-a', triggerEventName: 'x', senderEmail: 's@x.test' } });
      const b = expandChain(chain, { params: { orgId: 'org-b', triggerEventName: 'x', senderEmail: 's@x.test' } });
      expect(a.workflowId, id).not.toBe(b.workflowId);
      // Replay re-resolves by id: the same client's expansion is byte-identical every time.
      expect(JSON.stringify(expandChain(chain, { params: { orgId: 'org-a', triggerEventName: 'x', senderEmail: 's@x.test' } })), id).toBe(JSON.stringify(a));
      const enrollA = a.nodes.find((n) => n.nodeId.endsWith('_enroll'))!;
      expect(JSON.stringify(enrollA), id).toContain('org-a');
      expect(JSON.stringify(a), id).not.toContain('org-b');
    }
  });
});

interface Res { status: number; body: unknown }
/** Walk an untyped JSON body without casts. */
const get = (b: unknown, ...path: string[]): unknown => path.reduce<unknown>((o, k) => (typeof o === 'object' && o !== null ? Reflect.get(o, k) : undefined), b);
const listOf = (b: unknown, key: string): unknown[] => { const v = get(b, key); return Array.isArray(v) ? v : []; };
const endsWith = (v: unknown, suffix: string): boolean => typeof v === 'string' && v.endsWith(suffix);
function client(): { call: (m: string, p: string, b?: unknown) => Promise<Res> } {
  let cookie = '';
  return {
    call: async (method, path, body) => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const c of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
      const parsed: unknown = res.status === 204 ? {} : await res.json().catch(() => ({}));
      return { status: res.status, body: parsed };
    },
  };
}

describe('ADR 0955 P5 — welcome-email-sms end to end (J955WF-5)', () => {
  it('sign-off → email → a day → the best time → a real text, for one client', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-20T09:00:00Z'));
      const tenantId = `org:p5-${randomBytes(3).toString('hex')}`;
      let owner = client();
      const email = `p5-${randomBytes(3).toString('hex')}@acme.test`;
      // The session cookie does not outlive a faked day, so the owner signs in again after each jump.
      const signIn = () => { owner = client(); return owner.call('POST', '/host/openwop-app/test/login', { email, tenantId }); };
      const login = await signIn();
      expect(login.status).toBe(201);
      const userId = String(get(login.body, 'user', 'userId') ?? '');
      const org = await owner.call('POST', '/host/openwop-app/orgs', { name: 'Client A (synthetic)' });
      const orgId = String(get(org.body, 'orgId'));
      await createClient({ tenantId, orgId, name: 'Client A (synthetic)', createdBy: userId });
      await createSecretConnection({ tenantId, provider: 'sendgrid', kind: 'api_key', secret: 'SG.testkey', scope: 'user', userId });
      const twilio = await createSecretConnection({ tenantId, provider: 'twilio', kind: 'basic', secret: 'ACp5:token', scope: 'user', userId });
      await setSmsSender({ tenantId, number: '+15550700001', orgId, connectionId: twilio.connectionId, boundBy: userId });
      await setSendPolicy({ tenantId, orgId, defaultTimezone: 'UTC', updatedBy: userId });
      const contact = await owner.call('POST', '/host/openwop-app/crm/contacts', { name: 'Pat', email: 'pat@acme.test', phone: '+15550709999' });
      expect(contact.status, JSON.stringify(contact.body)).toBe(201);
      const contactId = String(get(contact.body, 'contactId'));
      await recordConsent({ tenantId, subjectKey: contactId, categories: { 'marketing.email': true }, source: 'test' });
      await recordClientChannelConsent({ tenantId, orgId, subjectKey: contactId, channel: 'sms', granted: true, source: 'test' });

      // Other cases in this file share the capture arrays and leave runs waiting on timers:
      // count only this case's deliveries and continue only this run's timers (sweepRun).
      const emailsBefore = emails.length;
      const textsBefore = texts.length;
      const chain = getChain('campaign-journeys.welcome-email-sms')!.chain;
      const params = { contactId, orgId, triggerEventName: 'host.crm.contact.created', senderEmail: 'hello@acme.test' };
      const expanded = expandChain(chain, { params });
      registerWorkflow(expanded);
      const create = await owner.call('POST', '/runs', { workflowId: expanded.workflowId, inputs: params });
      expect(create.status, JSON.stringify(create.body)).toBe(201);
      const runId = String(get(create.body, 'runId'));
      const status = async (): Promise<string> => {
        for (let i = 0; i < 120; i++) {
          const b = (await owner.call('GET', `/runs/${runId}`)).body;
          const s = String(get(b, 'status'));
          if (s === 'failed') {
            const ev = listOf((await owner.call('GET', `/host/openwop-app/runs/${bareRunId(runId)}/debug-bundle`)).body, 'events');
            return `failed:${JSON.stringify(ev.filter((e) => get(e, 'type') === 'node.failed').map((e) => [get(e, 'nodeId'), get(e, 'payload')]))}`;
          }
          if (s.startsWith('waiting') || ['completed', 'cancelled'].includes(s)) return s;
          await new Promise((r) => setTimeout(r, 25));
        }
        return `timeout:${JSON.stringify((await owner.call('GET', `/runs/${runId}`)).body).slice(0, 400)}:${JSON.stringify(await open())}`;
      };
      const open = async (): Promise<unknown[]> => listOf((await owner.call('GET', `/host/openwop-app/runs/${bareRunId(runId)}/interrupts`)).body, 'interrupts');

      expect(await status()).toMatch(/^waiting/);
      const gate = (await open()).find((i) => endsWith(get(i, 'nodeId'), '_signoff'));
      expect(gate, 'the sign-off gate').toBeTruthy();
      expect((await owner.call('POST', `/interrupts/${String(get(gate, 'token'))}`, { resumeValue: { decision: 'accept' } })).status).toBe(200); // routes/interrupts.ts answers the resume with res.json
      expect(await status()).toMatch(/^waiting/); // the one-day timer
      expect(emails.length - emailsBefore).toBe(1);
      expect(emails[emailsBefore]).toContain('pat@acme.test');

      vi.setSystemTime(new Date('2026-10-21T09:00:01Z'));
      expect((await signIn()).status).toBe(201);
      const swept1 = await sweepRun(runId);
      expect(swept1, 'the one-day timer is due').toBe(1);
      const afterDay = await status(); expect(afterDay, afterDay).toMatch(/^waiting/); // send-time: no history ⇒ 10:00 UTC
      const st = (await open()).find((i) => endsWith(get(i, 'nodeId'), '_sendtime'));
      expect(get(st, 'data')).toMatchObject({ kind: 'until', timestamp: '2026-10-21T10:00:00.000Z', resumeKey: 'send-time', explain: { basis: 'default' } });

      vi.setSystemTime(new Date('2026-10-21T10:00:01Z'));
      expect((await signIn()).status).toBe(201);
      expect(await sweepRun(runId), 'the send-time timer is due').toBe(1);
      const end = await status();
      expect(end, `the run completes after the text: ${JSON.stringify(await open())}`).toBe('completed');
      expect(texts.length - textsBefore).toBe(1);
      expect(decodeURIComponent(texts[textsBefore]!)).toContain('From=+15550700001'); // the client's own number
      expect(decodeURIComponent(texts[textsBefore]!)).toContain('To=+15550709999');
    } finally { vi.useRealTimers(); }
  });
});

// ── J955WF-10 — the other two blueprints through the real executor ──
async function emailOnlyClient(tag: string): Promise<{ owner: ReturnType<typeof client>; tenantId: string; orgId: string; contactId: string; email: string; signIn: () => Promise<Res> }> {
  const tenantId = `org:${tag}-${randomBytes(3).toString('hex')}`;
  const login = `${tag}-${randomBytes(3).toString('hex')}@acme.test`;
  const holder = { owner: client() };
  const signIn = (): Promise<Res> => { holder.owner = client(); return holder.owner.call('POST', '/host/openwop-app/test/login', { email: login, tenantId }); };
  const first = await signIn();
  expect(first.status).toBe(201);
  const userId = String(get(first.body, 'user', 'userId') ?? '');
  const orgId = String(get((await holder.owner.call('POST', '/host/openwop-app/orgs', { name: `${tag} client (synthetic)` })).body, 'orgId'));
  await createClient({ tenantId, orgId, name: `${tag} client (synthetic)`, createdBy: userId });
  await createSecretConnection({ tenantId, provider: 'sendgrid', kind: 'api_key', secret: 'SG.testkey', scope: 'user', userId });
  const email = `${tag}-contact-${randomBytes(2).toString('hex')}@acme.test`;
  const c = await holder.owner.call('POST', '/host/openwop-app/crm/contacts', { name: 'Sam', email });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  const contactId = String(get(c.body, 'contactId'));
  await recordConsent({ tenantId, subjectKey: contactId, categories: { 'marketing.email': true }, source: 'test' });
  return { get owner() { return holder.owner; }, tenantId, orgId, contactId, email, signIn };
}

async function startAndApprove(chainId: string, ctx: Awaited<ReturnType<typeof emailOnlyClient>>, extraSweepAtStartMs?: number): Promise<{ runId: string; status: () => Promise<string> }> {
  const chain = getChain(chainId)!.chain;
  const params = { contactId: ctx.contactId, orgId: ctx.orgId, triggerEventName: 'host.test.event', senderEmail: 'hello@acme.test' };
  const expanded = expandChain(chain, { params });
  registerWorkflow(expanded);
  const create = await ctx.owner.call('POST', '/runs', { workflowId: expanded.workflowId, inputs: params });
  expect(create.status, JSON.stringify(create.body)).toBe(201);
  const runId = String(get(create.body, 'runId'));
  const status = async (): Promise<string> => {
    for (let i = 0; i < 120; i++) {
      const b = (await ctx.owner.call('GET', `/runs/${runId}`)).body;
      const s = String(get(b, 'status'));
      if (s.startsWith('waiting') || ['completed', 'failed', 'cancelled'].includes(s)) return s;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`run ${runId} did not settle within 120 polls`);
  };
  expect(await status()).toMatch(/^waiting/);
  if (extraSweepAtStartMs !== undefined) {
    vi.setSystemTime(new Date(Date.now() + extraSweepAtStartMs));
    expect((await ctx.signIn()).status).toBe(201);
    expect(await sweepRun(runId), 'the grace timer').toBe(1);
    expect(await status()).toMatch(/^waiting/);
  }
  const ints = listOf((await ctx.owner.call('GET', `/host/openwop-app/runs/${bareRunId(runId)}/interrupts`)).body, 'interrupts');
  const gate = ints.find((i) => endsWith(get(i, 'nodeId'), '_signoff'));
  expect(gate, JSON.stringify(ints)).toBeTruthy();
  expect((await ctx.owner.call('POST', `/interrupts/${String(get(gate, 'token'))}`, { resumeValue: { decision: 'accept' } })).status).toBe(200);
  return { runId, status };
}

/**
 * Sweep due timers but CONTINUE only `runId`'s, and return how many of its timers fired.
 * The store is shared by every case in this file, and a case that ran earlier leaves runs
 * waiting on timers that a later case's clock jump makes due; a global sweep would count
 * (and advance) those too, so the count would depend on case order.
 */
async function sweepRun(runId: string): Promise<number> {
  const cont = timerResumeContinuation(storage, hostSuite);
  let mine = 0;
  await sweepDueTimers(storage, async (interrupt) => {
    if (bareRunId(interrupt.runId) !== bareRunId(runId)) return;
    mine += 1;
    await cont(interrupt);
  }, Date.now());
  return mine;
}

async function sweepAfter(ctx: Awaited<ReturnType<typeof emailOnlyClient>>, ms: number, runId: string): Promise<number> {
  vi.setSystemTime(new Date(Date.now() + ms));
  expect((await ctx.signIn()).status).toBe(201);
  return sweepRun(runId);
}

describe('ADR 0955 P5 — post-webinar and abandoned-signup end to end (J955WF-10)', () => {
  it('only an unsubscribe stops cleanly: a withdrawn consent still fails the run (J955WF-12)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-20T09:00:00Z'));
      const ctx = await emailOnlyClient('p5c');
      const before = emails.length;
      const { status, runId } = await startAndApprove('campaign-journeys.post-webinar', ctx);
      expect(await status()).toMatch(/^waiting/);
      expect(emails.length - before).toBe(1);
      await recordConsent({ tenantId: ctx.tenantId, subjectKey: ctx.contactId, categories: { 'marketing.email': false }, source: 'test' });
      expect(await sweepAfter(ctx, 86_401_000, runId)).toBe(1);
      const mid = await status();
      expect(mid, 'after the first day').toMatch(/^waiting/);
      expect(await sweepAfter(ctx, 86_401_000, runId)).toBe(1);
      expect(await status(), 'consent withdrawn is not a clean stop').toBe('failed');
      expect(emails.length - before).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it('post-webinar: sign-off → thank-you → two one-day waits → a re-check → the follow-up', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-20T09:00:00Z'));
      const ctx = await emailOnlyClient('p5w');
      const before = emails.length;
      const { status, runId } = await startAndApprove('campaign-journeys.post-webinar', ctx);
      expect(await status()).toMatch(/^waiting/);
      expect(emails.length - before, 'the thank-you').toBe(1);
      expect(await sweepAfter(ctx, 86_401_000, runId), 'first day').toBe(1);
      expect(await status()).toMatch(/^waiting/);
      expect(emails.length - before, 'nothing more after one day').toBe(1);
      expect(await sweepAfter(ctx, 86_401_000, runId), 'second day').toBe(1);
      const end = await status();
      expect(end, end).toBe('completed');
      expect(emails.length - before, 'the follow-up').toBe(2);
      expect(emails.at(-1)).toContain(ctx.email);
    } finally { vi.useRealTimers(); }
  });

  it('abandoned-signup: an hour of grace, then the reminder; an unsubscribe before the last one stops it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-20T09:00:00Z'));
      const ctx = await emailOnlyClient('p5a');
      const before = emails.length;
      const { status, runId: runIdOf } = await startAndApprove('campaign-journeys.abandoned-signup', ctx, 3_601_000);
      expect(await status()).toMatch(/^waiting/);
      expect(emails.length - before, 'the reminder, after the grace hour and the sign-off').toBe(1);
      // The contact unsubscribes from this client's mail during the day's wait.
      await addSuppression(ctx.tenantId, ctx.email, 'unsubscribed', 'test', undefined, { channel: 'email', senderOrgId: ctx.orgId });
      expect(await sweepAfter(ctx, 86_401_000, runIdOf)).toBe(1);
      const end = await status();
      // J955WF-12 — an unsubscribe is a correct end of the journey: the run COMPLETES through the
      // "stopped" terminal, it does not fail (a failed run here would teach operators to ignore failures).
      expect(end, 'an unsubscribe ends the journey cleanly').toBe('completed');
      expect(emails.length - before, 'no last reminder after an unsubscribe').toBe(1);
      const ev = listOf((await ctx.owner.call('GET', `/host/openwop-app/runs/${bareRunId(runIdOf)}/debug-bundle`)).body, 'events');
      expect(ev.some((e) => get(e, 'type') === 'node.completed' && endsWith(get(e, 'nodeId'), '_stopped-gate2')), 'the stopped terminal ran').toBe(true);
      expect(get(ev.find((e) => get(e, 'type') === 'node.completed' && endsWith(get(e, 'nodeId'), '_gate2')), 'payload', 'outputs')).toMatchObject({ eligible: false, stopped: 'suppressed' });
    } finally { vi.useRealTimers(); }
  });
});
