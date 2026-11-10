/**
 * Journey event triggers are bound to their client (found by fl2-86; feature-loop row 73 area).
 *
 * A journey chain is instantiated once per client, with `params.orgId`. Its host-event
 * binding carried no org, so client A's post-webinar journey started on client B's
 * `host.webinar.attended` and enrolled and mailed B's attendee under A's brand
 * (`bindJourneyOrg` takes the CHAIN's orgId for an event-triggered run, and the event's
 * `payload.orgId` was never compared).
 *
 * Through the REAL dispatcher (`emitHostEvent` → bindings → `startRun`), with real
 * bindings on two real per-client instances:
 *  - an event for client B starts B's journey only;
 *  - an event naming no org starts neither org-bound journey;
 *  - in a workspace with NO clients a journey is not org-bound, and still starts (the
 *    workspace is the only scope there, ADR 0955 D1).
 *
 * And at the binding route (#5562, lead decision A): a client's journey may only be bound to
 * an event that names the client. Contact events never do (contacts are tenant-scoped), so
 * binding one is a typed 422 `journey_event_has_no_org`, and an existing such binding
 * starts nothing.
 *
 * The contact-event case waits on a positive control (a client-less journey bound to the
 * same event must start), because `contact.created` is emitted fire-and-forget.
 * Double guard in `eventMatchesBoundOrg`: an event naming no org is refused by its own
 * `event_has_no_org` line AND by the `other_org` comparison (`undefined === bound` is false);
 * deleting either alone changes nothing (w88 probe: vacuous), deleting both reds cases 1-2.
 *
 * Red on main before the fix (A's journey also started for B's event). Sabotage-witnessed:
 * removing the dispatcher's scope check or the journeys resolver's registration turns the
 * first two cases red; removing the route refusal, or putting contact events in the
 * org-carrying set, turns the route case red.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getChain, expandChain } from '../src/host/workflowChainPackLoader.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { createClient } from '../src/features/campaign-ops/clientService.js';
import { createHostEventBinding, emitHostEvent } from '../src/host/hostEventDispatcher.js';

let server: http.Server;
let BASE = '';
let storage: Storage;

interface Res { status: number; body: Record<string, unknown> }
function client(): { call: (m: string, p: string, b?: unknown) => Promise<Res> } {
  let cookie = '';
  return {
    call: async (method, path, body) => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const c of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
      return { status: res.status, body: (res.status === 204 ? {} : await res.json().catch(() => ({}))) as Record<string, unknown> };
    },
  };
}

beforeAll(async () => {
  vi.stubEnv('OPENWOP_STORAGE_DSN', 'memory://');
  vi.stubEnv('OPENWOP_SESSION_SECRET', 'test-session-secret-at-least-32-characters-long');
  vi.stubEnv('OPENWOP_TEST_AUTH_ENABLED', 'true');
  vi.stubEnv('OPENWOP_AUTH_DISABLE_COOKIES', '');
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
  for (const id of ['users', 'crm', 'consent', 'campaign-journeys', 'campaign-ops', 'webinars']) {
    const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
}, 120_000);
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  vi.unstubAllEnvs();
});

async function workspace(tag: string): Promise<{ owner: ReturnType<typeof client>; tenantId: string; userId: string }> {
  const tenantId = `org:${tag}-${randomBytes(3).toString('hex')}`;
  const owner = client();
  const login = await owner.call('POST', '/host/openwop-app/test/login', { email: `${tag}-${randomBytes(3).toString('hex')}@acme.test`, tenantId });
  expect(login.status).toBe(201);
  const userId = String((login.body.user as { userId?: string } | undefined)?.userId ?? '');
  return { owner, tenantId, userId };
}

async function newClient(ws: Awaited<ReturnType<typeof workspace>>, name: string): Promise<string> {
  const org = await ws.owner.call('POST', '/host/openwop-app/orgs', { name });
  const orgId = String(org.body.orgId);
  await createClient({ tenantId: ws.tenantId, orgId, name, createdBy: ws.userId });
  return orgId;
}

/** Instantiate the post-webinar journey for `orgId` and bind it to the webinar event. */
async function journeyFor(ws: Awaited<ReturnType<typeof workspace>>, orgId: string, chainId = 'campaign-journeys.post-webinar', eventType = 'host.webinar.attended'): Promise<string> {
  const chain = getChain(chainId)!.chain;
  const def = expandChain(chain, { params: { orgId, triggerEventName: eventType, senderEmail: 'hello@acme.test' } });
  registerWorkflow(def);
  await createHostEventBinding({ tenantId: ws.tenantId, eventType, workflowId: def.workflowId, createdBy: ws.userId });
  return def.workflowId;
}

async function runsOf(tenantId: string, workflowId: string): Promise<number> {
  return (await storage.listRuns({ tenantId, workflowId })).length;
}

/** The error envelope the binding route answers with (`middleware/errorEnvelope.ts`). */
interface Refusal { error?: string; details?: { reason?: string; eventType?: string } }

describe('a journey\'s event trigger is bound to its client', () => {
  it.each(['campaign-journeys.post-webinar', 'campaign-journeys.welcome-series'])('an event for client B starts only B’s %s journey', async (chainId) => {
    const ws = await workspace('jorg');
    const a = await newClient(ws, 'Client A (synthetic)');
    const b = await newClient(ws, 'Client B (synthetic)');
    const wfA = await journeyFor(ws, a, chainId);
    const wfB = await journeyFor(ws, b, chainId);

    await emitHostEvent({ type: 'host.webinar.attended', tenantId: ws.tenantId, payload: { entityType: 'webinar', entityId: 'w1', orgId: b, contactId: 'crm:attendee', phase: 'attended' } });

    expect(await runsOf(ws.tenantId, wfB), 'B\'s own journey starts').toBe(1);
    expect(await runsOf(ws.tenantId, wfA), 'A\'s journey must not start for B\'s attendee').toBe(0);
  });

  it.each(['campaign-journeys.post-webinar', 'campaign-journeys.welcome-series'])('an event that names no org starts no org-bound %s journey', async (chainId) => {
    const ws = await workspace('jorg-none');
    const a = await newClient(ws, 'Client A (synthetic)');
    const wfA = await journeyFor(ws, a, chainId);
    await emitHostEvent({ type: 'host.webinar.attended', tenantId: ws.tenantId, payload: { entityType: 'webinar', entityId: 'w1', contactId: 'crm:attendee', phase: 'attended' } });
    expect(await runsOf(ws.tenantId, wfA)).toBe(0);
  });

  it('in a workspace with no clients the journey is not org-bound, and still starts', async () => {
    const ws = await workspace('jorg-solo');
    const wf = await journeyFor(ws, ws.tenantId);
    await emitHostEvent({ type: 'host.webinar.attended', tenantId: ws.tenantId, payload: { entityType: 'webinar', entityId: 'w1', contactId: 'crm:attendee', phase: 'attended' } });
    expect(await runsOf(ws.tenantId, wf)).toBe(1);
  });
});

describe('which events can start a client\'s journey (#5562, decision A)', () => {
  it('a real new-contact event names no client and starts no client journey; a form submission naming the client does', async () => {
    const ws = await workspace('jorg-contact');
    const a = await newClient(ws, 'Client A (synthetic)');
    // Bound directly (as a binding made before the route refusal would be).
    const wfContact = await journeyFor(ws, a, 'campaign-journeys.welcome-email-sms', 'host.crm.contact.created');
    // Positive control on the SAME event: a journey with no client (welcome-series) must start.
    // `contact.created` is emitted fire-and-forget (`crm/emit.ts` `void emitHostEvent`), so
    // without this the count below could read 0 before the dispatch ran at all.
    const series = expandChain(getChain('campaign-journeys.welcome-series')!.chain, { params: { triggerEventName: 'host.crm.contact.created', senderEmail: 'hello@acme.test' } });
    registerWorkflow(series);
    await createHostEventBinding({ tenantId: ws.tenantId, eventType: 'host.crm.contact.created', workflowId: series.workflowId, createdBy: ws.userId });
    const created = await ws.owner.call('POST', '/host/openwop-app/crm/contacts', { name: 'Sam', email: 'sam@acme.test' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await vi.waitFor(async () => expect(await runsOf(ws.tenantId, series.workflowId), 'the dispatch ran for this contact event').toBe(1), { timeout: 8_000, interval: 25 });
    // The bindings are evaluated one after another, in id (uuid) order, so the client binding may
    // come after the control. Drain the rest of that loop: memory storage does no real I/O, so
    // its awaits settle within a few macrotask turns.
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
    expect(await runsOf(ws.tenantId, wfContact), 'contact events carry no orgId: the client journey does not start').toBe(0);

    const wfForm = await journeyFor(ws, a, 'campaign-journeys.welcome-email-sms', 'host.forms.submission.created');
    await emitHostEvent({ type: 'host.forms.submission.created', tenantId: ws.tenantId, payload: { formId: 'f1', submissionId: 's1', orgId: a } });
    expect(await runsOf(ws.tenantId, wfForm)).toBe(1);
  });

  it('the binding route refuses a client journey on an event that never names the client, and allows one that does', async () => {
    const ws = await workspace('jorg-route');
    const a = await newClient(ws, 'Client A (synthetic)');
    const chain = getChain('campaign-journeys.welcome-email-sms')!.chain;
    const def = expandChain(chain, { params: { orgId: a, triggerEventName: 'host.crm.contact.created', senderEmail: 'hello@acme.test' } });
    registerWorkflow(def);
    for (const eventType of ['host.crm.contact.created', 'openwop-app.crm.contact-created', 'host.crm.contact.updated']) {
      const refused = await ws.owner.call('POST', '/host/openwop-app/host-events/bindings', { eventType, workflowId: def.workflowId });
      expect(refused.status, `${eventType}: ${JSON.stringify(refused.body)}`).toBe(422);
      const body = refused.body as Refusal;
      expect(body.error).toBe('validation_error');
      expect(body.details?.reason).toBe('journey_event_has_no_org');
      expect(body.details?.eventType).toBe(eventType);
    }
    const ok = await ws.owner.call('POST', '/host/openwop-app/host-events/bindings', { eventType: 'host.crm.contact.converted', workflowId: def.workflowId });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);

    // A legacy welcome-series instance with no client selected may bind a contact event.
    const series = expandChain(getChain('campaign-journeys.welcome-series')!.chain, { params: { triggerEventName: 'host.crm.contact.created', senderEmail: 'hello@acme.test' } });
    registerWorkflow(series);
    const free = await ws.owner.call('POST', '/host/openwop-app/host-events/bindings', { eventType: 'host.crm.contact.created', workflowId: series.workflowId });
    expect(free.status, JSON.stringify(free.body)).toBe(201);
  });
});

