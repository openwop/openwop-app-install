/**
 * ADR 0627 D2 (`CRMWF-2` / `CRMWF-4`) — CRM lifecycle host events from ONE
 * site per transition, enumerated by CALL GRAPH.
 *
 * Before this ADR `host.crm.contact.created` fired from 2 of the 5+ contact
 * creation lanes (the route + the surface verb); the forms sink, CSV import,
 * the anon lead-capture tool, public booking, commerce checkout and the
 * webinar processor called `createContact`/`ensureContact` directly and
 * emitted nothing — so the chain advertised as "auto-route every new lead"
 * never fired for the lanes that produce leads. And `deal.won`, `task.completed`
 * re-fired on every re-PATCH. The emit now lives in the entity service that
 * performs the write, guarded on the LANDED row.
 *
 * WHAT IS PINNED (the ADR's lane-enumerated witness), observed on the REAL
 * dispatcher with a captured webhook fanout — the `users-lifecycle-host-
 * events.test.ts` shape, but on the booted app so every HTTP lane is the
 * production path:
 *   contact.created — route 1, surface 1, forms sink 1, anon tool 1 (+0 on the
 *   existing-email retry), public booking 1, the commerce `ensureContact` seam
 *   1 (+0 on retry), CSV import 0 + ONE `imported { count }`, webinar sync 0 +
 *   ONE `imported { source:'webinar', count }`, demo seed 0 (and teardown 0);
 *   surface emits carry `origin` — a binding on the emitting run's OWN
 *   workflow is skipped (ADR 0617 D1a) while the route lane starts it;
 *   transition guards — won→won re-PATCH ⇒ ONE `won` and ONE `updated` (the
 *   second PATCH changes nothing); same-stage re-PATCH ⇒ no `stage-changed`;
 *   done→done ⇒ ONE `completed` and ONE `updated`; a deterministic-id
 *   activity re-append ⇒ ONE `logged`; an empty contact patch ⇒ nothing, and a
 *   VALUE-EQUAL re-PATCH (deal title, contact name, task status) ⇒ no `updated`
 *   either — `changed` is the pre-image→landed DIFF (review S1), never the
 *   patch's keys; the self-trigger skip is ORIGIN-based, proven by a second
 *   workflow bound to the same event that DOES start.
 *
 * Sabotage (run during the ADR 0627 build): dropping the `next.status !==
 * d.status` guard in `updateDeal` turns the won→won row red; reverting deals'
 * `changedFields(d, next)` to `Object.keys(patch)` turns the no-op title
 * re-PATCH row AND the won→won `updated` count red.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import {
  createHostEventBinding,
  initHostEventDispatcher,
  type HostEventEnvelope,
} from '../src/host/hostEventDispatcher.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { CRM_LEAD_CAPTURE_TOOL_ID } from '../src/features/crm/agentTools.js';
import { buildCrmSurface } from '../src/features/crm/surface.js';
import type { BundleScope } from '../src/host/inMemorySurfaces.js';
import { ensureContact, updateContact } from '../src/features/crm/contactsService.js';
import { createActivity, createDeal, createTask, getOrCreateDefaultPipeline, makeLinkValidators, updateDeal, updateTask } from '../src/features/crm/crmEntitiesService.js';
import { createForm, recordSubmission, setFormStatus } from '../src/features/forms/formsService.js';
import { flushWebinarContactImports, ingestWebinarEvent, type WebinarContactBatch } from '../src/features/webinars/webinarProcessor.js';
import { seedDemoPeople } from '../src/host/demoPeopleSeed.js';
import { clearDemoCrm, seedDemoCrm } from '../src/host/demoCrmSeed.js';

let BASE = '';
let server: http.Server;
let app: Express;
let storage: Storage;
let n = 0;

let delivered: HostEventEnvelope[] = [];
let startRunCalls: Array<{ tenantId: string; workflowId: string; metadata?: Record<string, unknown> }> = [];
const settle = () => new Promise((r) => setTimeout(r, 25));
const ofType = (type: string, tenantId?: string) => delivered.filter((e) => e.type === type && (!tenantId || e.tenantId === tenantId));
const CREATED = 'host.crm.contact.created';
const IMPORTED = 'host.crm.contact.imported';

interface Res<T = Record<string, any>> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res<any>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    const single = res.headers.get('set-cookie');
    const setCookies: string[] = typeof h.getSetCookie === 'function' ? h.getSetCookie() : single ? [single] : [];
    for (const sc of setCookies) { const m = /(__session=[^;]+)/.exec(sc); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b?: unknown) => call('POST', p, b),
    patch: (p: string, b?: unknown) => call('PATCH', p, b),
  };
}
type Client = ReturnType<typeof client>;

async function signup(c: Client): Promise<{ userId: string; tenantId: string }> {
  const tenantId = `org:crm-ls-${Date.now()}-${n++}`;
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `crm-ls-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { userId: r.body.user.userId, tenantId };
}
async function orgOf(c: Client): Promise<string> {
  const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return org.body.orgId as string;
}

const CRM = '/v1/host/openwop-app/crm';
const ALL_DAYS = Array.from({ length: 7 }, (_, day) => ({ day, start: '00:00', end: '23:30' }));

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'orgs', 'crm', 'forms']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  // Re-point the REAL dispatcher's two fanouts at capture seams (the app's own
  // storage + hostSuite stay, so bindings + the self-trigger guard are real).
  initHostEventDispatcher({
    storage,
    hostSuite: app.locals.hostSuite as StartRunDeps['hostSuite'],
    deliverWebhooks: async (event) => { delivered.push(event); },
    startRun: async (_deps, input) => { startRunCalls.push(input); return `run:fake-${startRunCalls.length}`; },
  });
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  delete process.env.OPENWOP_TEST_AUTH_ENABLED;
});
beforeEach(() => { delivered = []; startRunCalls = []; });

describe('ADR 0627 D2 — contact.created by lane (ONE site: contactsService.createContact)', () => {
  it('route lane: POST /contacts → exactly 1, ids-only payload, no `origin` on the wire', async () => {
    const c = client();
    const { tenantId } = await signup(c);
    const r = await c.post(`${CRM}/contacts`, { name: 'Route Lead', email: `route-${n++}@x.test` });
    expect(r.status).toBe(201);
    await settle();
    const evs = ofType(CREATED, tenantId);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload).toEqual({ entityType: 'contact', entityId: r.body.contactId });
    expect('origin' in evs[0]!).toBe(false);
  });

  it('surface lane: 1 created, stamped with the run origin — a binding on the emitting workflow is SKIPPED, the route lane starts it', async () => {
    const c = client();
    const { tenantId, userId } = await signup(c);
    const binding = await createHostEventBinding({ tenantId, eventType: CREATED, workflowId: 'wf-self-trigger', createdBy: userId });
    // Positive control: a SECOND workflow bound to the same event. If the
    // self-trigger row passed because nothing was dispatched at all, this one
    // would not start either — it must, so the skip is proven origin-based.
    await createHostEventBinding({ tenantId, eventType: CREATED, workflowId: 'wf-other-listener', createdBy: userId });
    const surface = buildCrmSurface({ tenantId, runId: 'run:surface-1', workflowId: 'wf-self-trigger' } as BundleScope);
    const out = (await surface.createContact!({ name: 'Surface Lead' })) as { success: boolean; contact: { contactId: string } };
    expect(out.success).toBe(true);
    await settle();
    expect(ofType(CREATED, tenantId)).toHaveLength(1);
    expect(startRunCalls.filter((r) => r.workflowId === 'wf-self-trigger'), 'ADR 0617 D1a — the emitting run must not re-trigger its own workflow').toHaveLength(0);
    expect(startRunCalls.filter((r) => r.workflowId === 'wf-other-listener'), 'the skip is origin-based: a different workflow bound to the same event DOES start').toHaveLength(1);

    const r = await c.post(`${CRM}/contacts`, { name: 'Route Lead 2' });
    expect(r.status).toBe(201);
    await settle();
    expect(ofType(CREATED, tenantId)).toHaveLength(2);
    expect(startRunCalls.filter((r) => r.workflowId === 'wf-self-trigger'), 'a human/route emit carries no origin and DOES start the bound workflow').toHaveLength(1);
    expect(startRunCalls.filter((r) => r.workflowId === 'wf-other-listener')).toHaveLength(2);
    expect(startRunCalls.find((r) => r.workflowId === 'wf-self-trigger')!.metadata).toMatchObject({ hostEvent: { bindingId: binding.bindingId } });
  });

  it('forms sink lane: a submission with createToContact → exactly 1 (this lane emitted nothing before)', async () => {
    const c = client();
    const { tenantId } = await signup(c);
    const orgId = await orgOf(c);
    const form = await createForm({
      tenantId, orgId, title: 'Lead form',
      fields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
        { key: 'email', label: 'Email', type: 'email', required: false },
      ],
      createToContact: true, createdBy: 'user:test',
    });
    await setFormStatus(tenantId, orgId, form.formId, 'published');
    const sub = await recordSubmission(form, { name: 'Form Lead', email: `form-${n++}@x.test` }, {});
    expect(sub.contactId, 'the crm-contact sink must have created the contact').toMatch(/^crm:/);
    await settle();
    const evs = ofType(CREATED, tenantId);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload.entityId).toBe(sub.contactId);
  });

  it('anon lead-capture lane: 1 on the first capture, 0 on the same-email retry (ensureContact found-existing)', async () => {
    const { tenantId } = await signup(client());
    const anon = createAgentToolProvider({ tenantId });
    const email = `anon-${n++}@x.test`;
    const first = await anon.executeTool({ name: CRM_LEAD_CAPTURE_TOOL_ID, input: { email, name: 'Visitor' } });
    expect(first.isError, first.content).toBeFalsy();
    await settle();
    expect(ofType(CREATED, tenantId)).toHaveLength(1);
    const again = await anon.executeTool({ name: CRM_LEAD_CAPTURE_TOOL_ID, input: { email, name: 'Visitor' } });
    expect(again.isError, again.content).toBeFalsy();
    await settle();
    expect(ofType(CREATED, tenantId), 'an existing contact is not a creation').toHaveLength(1);
  });

  it('public booking lane: a claimed slot mints the invitee contact → 1 created (+1 activity.logged)', async () => {
    const owner = client();
    const { tenantId } = await signup(owner);
    const orgId = await orgOf(owner);
    const linkBase = `${CRM}/orgs/${encodeURIComponent(orgId)}/booking-links`;
    const create = await owner.post(linkBase, { title: 'Intro call', timezone: 'UTC', weeklyHours: ALL_DAYS, durations: [30], minNoticeMin: 0, maxAdvanceDays: 30 });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    expect((await owner.patch(`${linkBase}/${create.body.bookingLinkId}`, { status: 'published' })).status).toBe(200);
    delivered = [];
    const now = Date.now();
    const anon = client();
    const slots = await anon.get(`/v1/host/openwop-app/public-book/${create.body.slug}/slots?from=${now}&to=${now + 3 * 86400_000}&durationMin=30`);
    expect(slots.status, JSON.stringify(slots.body)).toBe(200);
    const slot = (slots.body.slots as Array<{ startUtcMs: number } | number>)[1]!;
    const startUtcMs = typeof slot === 'number' ? slot : slot.startUtcMs;
    const claim = await anon.post(`/v1/host/openwop-app/public-book/${create.body.slug}/claim`, { slotStartUtcMs: startUtcMs, durationMin: 30, inviteeName: 'Visitor', inviteeEmail: `book-${n++}@x.test` });
    expect(claim.status, JSON.stringify(claim.body)).toBe(201);
    await settle();
    expect(ofType(CREATED, tenantId)).toHaveLength(1);
    expect(ofType('host.crm.activity.logged', tenantId)).toHaveLength(1);
  });

  it('commerce checkout lane (the shared ensureContact seam): 1 on a new email, 0 on the retry', async () => {
    const { tenantId } = await signup(client());
    const email = `guest-${n++}@x.test`;
    const a = await ensureContact({ tenantId, email, name: 'Guest', actor: 'public:guest' });
    const b = await ensureContact({ tenantId, email, name: 'Guest', actor: 'public:guest' });
    expect(a?.contactId).toBe(b?.contactId);
    await settle();
    expect(ofType(CREATED, tenantId)).toHaveLength(1);
  });

  it('CSV import lane: 3 rows → 0 created + ONE imported { count: 3 }', async () => {
    const c = client();
    const { tenantId } = await signup(c);
    const orgId = await orgOf(c);
    const r = await c.post(`${CRM}/orgs/${encodeURIComponent(orgId)}/import`, {
      entityType: 'contact',
      rows: [{ name: 'A', email: `a-${n++}@x.test` }, { name: 'B', email: `b-${n++}@x.test` }, { name: 'C' }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.created).toBe(3);
    await settle();
    expect(ofType(CREATED, tenantId), 'a 10k-row import must not start 10k bound runs').toHaveLength(0);
    const imported = ofType(IMPORTED, tenantId);
    expect(imported).toHaveLength(1);
    expect(imported[0]!.payload).toMatchObject({ entityType: 'contact', count: 3 });
  });

  it('webinar lanes: the attendance sync batch → 0 created + ONE imported { count }; a single webhook event → 0 created + 1 imported { count: 1 }', async () => {
    const c = client();
    const { tenantId } = await signup(c);
    const orgId = await orgOf(c);
    const batch: WebinarContactBatch = { contactsCreated: 0 };
    for (const who of ['p1', 'p2']) {
      await ingestWebinarEvent(tenantId, orgId, undefined, { provider: 'zoom', providerEventId: 'web-1', phase: 'attended', participantEmail: `${who}-${n}@x.test`, participantName: who }, { batch });
    }
    // The same participant again — a found-existing contact, not a creation.
    await ingestWebinarEvent(tenantId, orgId, undefined, { provider: 'zoom', providerEventId: 'web-1', phase: 'attended', participantEmail: `p1-${n}@x.test` }, { batch });
    flushWebinarContactImports(tenantId, orgId, batch);
    await settle();
    expect(ofType(CREATED, tenantId)).toHaveLength(0);
    expect(ofType(IMPORTED, tenantId)).toHaveLength(1);
    expect(ofType(IMPORTED, tenantId)[0]!.payload).toMatchObject({ entityType: 'contact', count: 2 });

    delivered = [];
    await ingestWebinarEvent(tenantId, orgId, undefined, { provider: 'zoom', providerEventId: 'web-2', phase: 'registered', participantEmail: `p3-${n++}@x.test` });
    await settle();
    expect(ofType(CREATED, tenantId)).toHaveLength(0);
    expect(ofType(IMPORTED, tenantId)).toHaveLength(1);
    expect(ofType(IMPORTED, tenantId)[0]!.payload).toMatchObject({ count: 1 });
  });

  it('demo seed lane: seedDemoCrm + clearDemoCrm emit ZERO host.crm.* events', async () => {
    const tenantId = `demo-crm-ls-${Date.now()}-${n++}`;
    await seedDemoPeople(tenantId);
    delivered = [];
    const seeded = await seedDemoCrm(tenantId);
    expect(seeded.created).toBeGreaterThan(100);
    await settle();
    expect(delivered.filter((e) => e.tenantId === tenantId && e.type.startsWith('host.crm.'))).toEqual([]);
    const cleared = await clearDemoCrm(tenantId);
    expect(cleared.cleared).toBeGreaterThan(100);
    await settle();
    expect(delivered.filter((e) => e.tenantId === tenantId && e.type.startsWith('host.crm.'))).toEqual([]);
  });
});

describe('ADR 0627 D2 — transition guards decided on the landed row', () => {
  it('deal: a value-equal re-PATCH ⇒ no updated; won→won ⇒ ONE won + ONE updated; same-stage re-PATCH ⇒ no stage-changed; a real move ⇒ one', async () => {
    const c = client();
    const { tenantId, userId } = await signup(c);
    const orgId = await orgOf(c);
    const pipeline = await getOrCreateDefaultPipeline(tenantId, orgId);
    const v = makeLinkValidators(tenantId, orgId);
    const deal = await createDeal({ tenantId, orgId, title: 'D', createdBy: userId, validateCompany: v.validateCompany, validateContact: v.validateContact });
    await settle();
    expect(ofType('host.crm.deal.created', tenantId)).toHaveLength(1);

    // Review S1 — `changed` is a DIFF: re-sending the title the row already
    // holds changes nothing on the landed row, so no `updated` (the patch has
    // a key; the diff is empty).
    await updateDeal(tenantId, orgId, deal.dealId, { title: deal.title }, v, userId);
    await settle();
    expect(ofType('host.crm.deal.updated', tenantId), 'a value-equal re-PATCH is not an update').toHaveLength(0);

    await updateDeal(tenantId, orgId, deal.dealId, { status: 'won' }, v, userId);
    await updateDeal(tenantId, orgId, deal.dealId, { status: 'won' }, v, userId);
    await settle();
    expect(ofType('host.crm.deal.won', tenantId), 'a re-PATCH of won on a won deal is not a transition').toHaveLength(1);
    const updated = ofType('host.crm.deal.updated', tenantId);
    expect(updated, 'the first PATCH changed `status`; the second changed nothing ⇒ ONE updated, not two').toHaveLength(1);
    expect(updated[0]!.payload).toMatchObject({ changed: ['status'] });

    delivered = [];
    await updateDeal(tenantId, orgId, deal.dealId, { stageId: deal.stageId }, v, userId);
    await settle();
    expect(ofType('host.crm.deal.stage-changed', tenantId), 'same stage ⇒ no move').toHaveLength(0);
    const other = pipeline.stages.find((s) => s.stageId !== deal.stageId)!;
    await updateDeal(tenantId, orgId, deal.dealId, { stageId: other.stageId }, v, userId);
    await settle();
    expect(ofType('host.crm.deal.stage-changed', tenantId)).toHaveLength(1);
  });

  it('task: done→done ⇒ ONE completed + ONE updated; activity: a deterministic-id re-append ⇒ ONE logged; contact: an empty or value-equal patch ⇒ nothing', async () => {
    const c = client();
    const { tenantId, userId } = await signup(c);
    const orgId = await orgOf(c);
    const v = makeLinkValidators(tenantId, orgId);
    const task = await createTask({ tenantId, orgId, title: 'T', createdBy: userId, validators: v });
    await updateTask(tenantId, orgId, task.taskId, { status: 'done' });
    await updateTask(tenantId, orgId, task.taskId, { status: 'done' });
    await settle();
    expect(ofType('host.crm.task.created', tenantId)).toHaveLength(1);
    expect(ofType('host.crm.task.completed', tenantId), 'done→done is a re-PATCH, not a completion').toHaveLength(1);
    expect(ofType('host.crm.task.updated', tenantId), 'review S1 — the done→done re-PATCH changed nothing ⇒ no second updated').toHaveLength(1);

    const act = { tenantId, orgId, kind: 'note' as const, body: 'hi', createdBy: userId, validators: v, activityId: `act:ls-${n++}` };
    await createActivity(act);
    await createActivity(act);
    await settle();
    expect(ofType('host.crm.activity.logged', tenantId), 'the dedup hit is not a new log entry').toHaveLength(1);

    const r = await c.post(`${CRM}/contacts`, { name: 'Patch Me' });
    delivered = [];
    await updateContact(r.body.contactId, {});
    await settle();
    expect(ofType('host.crm.contact.updated', tenantId), 'an empty patch is not an update').toHaveLength(0);
    await updateContact(r.body.contactId, { name: 'Patch Me' });
    await settle();
    expect(ofType('host.crm.contact.updated', tenantId), 'review S1 — a value-equal re-PATCH is not an update').toHaveLength(0);
    await updateContact(r.body.contactId, { stage: 'qualified' });
    await settle();
    expect(ofType('host.crm.contact.updated', tenantId)).toHaveLength(1);
    expect(ofType('host.crm.contact.updated', tenantId)[0]!.payload).toMatchObject({ changed: ['stage'] });
    await updateContact(r.body.contactId, { stage: 'qualified', name: 'Patch Me' });
    await settle();
    expect(ofType('host.crm.contact.updated', tenantId), 'a multi-key patch that changes nothing is still not an update').toHaveLength(1);
  });
});
