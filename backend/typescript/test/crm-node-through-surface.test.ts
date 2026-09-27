/**
 * ADR 0627 D1 (`CRMWF-5`) — all 27 `feature.crm.nodes` driven THROUGH the real
 * `buildCrmSurface` (via the production `buildHostSurfaceBundle`) on a seeded
 * tenant, with the pack's OWN `nodes` map. The `profiles-node-through-surface`
 * shape: the pack→surface edge is crossed for every node, so a key drift on
 * either side (the `UPWF-1` class — `{ profileId }` sent, `userId` read, six
 * weeks of success-with-null) turns this red rather than the parity scan's
 * denominators alone.
 *
 * Every node is exercised; a node whose success path needs a target this test
 * cannot seed (`sign-request` / `sign-status` need a rendered document or
 * commerce quote) is exercised on its TYPED-REFUSAL path — the refusal must
 * cross the edge as a thrown `OpenwopError`, never a success-with-empty.
 *
 * The gmail-sync leg runs the REAL surface (a real opt-in row from
 * `createGmailSync`, a real contact match, a real activity append and cursor
 * advance) with only `ctx.connectors` stubbed — and asserts the ADR 0627 D5 pin:
 * every connector invoke carries the sync row's `connectionId`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { getOrCreateDefaultPipeline, getActivity } from '../src/features/crm/crmEntitiesService.js';
import { createGmailSync, getGmailSync } from '../src/features/crm/gmailSyncService.js';
import { upsertOAuthConnection } from '../src/features/connections/connectionsService.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const PACK_DIR = join(REPO, 'packs/feature.crm.nodes');
type NodeOut = { status: string; outputs?: Record<string, any>; error?: { code: string; message: string } };
type NodeFn = (ctx: Record<string, unknown>) => Promise<NodeOut>;

const manifest = JSON.parse(readFileSync(join(PACK_DIR, 'pack.json'), 'utf8')) as { runtime: { entry: string }; nodes: Array<{ typeId: string }> };
const T = 'org:crm-node-surface';
const ORG = 'org-1';
const RUN = 'run-crm-surface';
const USER = 'user:crm-surface-owner';

let server: http.Server;
let nodes: Record<string, NodeFn>;
const exercised = new Set<string>();

/** A NodeContext the way the executor binds one for a run in tenant T. */
function ctxFor(inputs: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { runId: RUN, nodeId: 'n', inputs, config: {}, features: buildHostSurfaceBundle({ tenantId: T, runId: RUN }).features, ...extra };
}
async function run(typeId: string, inputs: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<NodeOut> {
  exercised.add(typeId);
  const fn = nodes[typeId];
  expect(fn, `${typeId} is not exported by index.mjs`).toBeTypeOf('function');
  return fn!(ctxFor(inputs, extra));
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', res); });
  const crm = getToggleDefault('crm');
  if (crm) await saveConfig({ ...crm, status: 'on' }, 'test');
  const mod = (await import(pathToFileURL(join(PACK_DIR, manifest.runtime.entry)).href)) as { nodes: Record<string, NodeFn> };
  nodes = mod.nodes;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('feature.crm.nodes through the REAL ctx.features.crm surface (CRMWF-5)', () => {
  let contactId = '';
  let leadId = '';
  let companyId = '';
  let dealId = '';
  let taskId = '';
  let segmentId = '';

  it('pure: triage + triage-enriched score a contact deterministically (no surface)', async () => {
    const basic = await run('feature.crm.nodes.triage', { contact: { stage: 'qualified', company: 'Acme' } });
    expect(basic.outputs).toEqual({ triage: { variant: 'basic', score: 40, priority: 'normal' } });
    const enriched = await run('feature.crm.nodes.triage-enriched', { contact: { stage: 'qualified', company: 'Acme' } });
    expect(enriched.outputs).toEqual({ triage: { variant: 'enriched', score: 55, priority: 'normal' } });
  });

  it('create-contact → update-contact-stage → update-contact-owner (entityId fallback) land on the SAME tenant row', async () => {
    const created = await run('feature.crm.nodes.create-contact', { name: 'Ada Lovelace', email: 'ada@acme.test', stage: 'lead' });
    expect(created.status).toBe('success');
    contactId = created.outputs!.contact.contactId as string;
    expect(contactId).toBe(`crm:${RUN}:n`); // the per-run dedupe key (ADR 0162)
    expect('tenantId' in created.outputs!.contact).toBe(false); // projected

    const staged = await run('feature.crm.nodes.update-contact-stage', { contactId, stage: 'qualified' });
    expect(staged.outputs!.contact.stage).toBe('qualified');

    // The trigger-edge shape: `{entityId}` (a host.crm.contact.* payload) — no contactId key.
    const owned = await run('feature.crm.nodes.update-contact-owner', { entityId: contactId, owner: 'user:sales-1' });
    expect(owned.outputs!.contact.contactId).toBe(contactId);
    expect(owned.outputs!.contact.owner).toBe('user:sales-1');
  });

  it('a foreign-tenant or empty contactId is a TYPED refusal crossing the edge (never a success-with-empty)', async () => {
    const foreign = await createContact({ tenantId: 'org:someone-else', name: 'Foreign' });
    await expect(run('feature.crm.nodes.update-contact-stage', { contactId: foreign.contactId, stage: 'qualified' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(run('feature.crm.nodes.update-contact-owner', { owner: 'user:x' })).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('create-company → create-deal (linked) → move-deal-stage derives won', async () => {
    const company = await run('feature.crm.nodes.create-company', { orgId: ORG, name: 'Acme', domain: 'acme.test' });
    companyId = company.outputs!.company.companyId as string;
    expect(companyId).toBe(`cmp:${RUN}:n`);

    const deal = await run('feature.crm.nodes.create-deal', { orgId: ORG, title: 'Acme deal', amount: 1200, companyId, contactId });
    dealId = deal.outputs!.deal.dealId as string;
    expect(dealId).toBe(`deal:${RUN}:n`);
    expect(deal.outputs!.deal.companyId).toBe(companyId);

    const pipeline = await getOrCreateDefaultPipeline(T, ORG);
    const won = pipeline.stages.find((s) => s.name === 'Won')!;
    const moved = await run('feature.crm.nodes.move-deal-stage', { orgId: ORG, dealId, stageId: won.stageId });
    expect(moved.outputs!.deal.status).toBe('won');
  });

  it('create-task (linked to the deal) → complete-task; log-activity appends to the contact timeline', async () => {
    const task = await run('feature.crm.nodes.create-task', { orgId: ORG, title: 'Send the contract', dealId });
    taskId = task.outputs!.task.taskId as string;
    expect(taskId).toBe(`task:${RUN}:n`);
    const done = await run('feature.crm.nodes.complete-task', { orgId: ORG, taskId });
    expect(done.outputs!.task.status).toBe('done');

    const act = await run('feature.crm.nodes.log-activity', { orgId: ORG, kind: 'note', body: 'Left a voicemail', contactId });
    expect(act.outputs!.activity.activityId).toBe(`act:${RUN}:n`);
    expect(act.outputs!.activity.contactId).toBe(contactId);
  });

  it('convert-contact get-or-creates a company + deal for a lead and advances its stage', async () => {
    const lead = await createContact({ tenantId: T, name: 'Grace Hopper', email: 'grace@newco.test', stage: 'lead' });
    leadId = lead.contactId;
    const out = await run('feature.crm.nodes.convert-contact', { entityId: leadId, orgId: ORG, companyName: 'Newco' });
    expect(out.status).toBe('success');
    expect(out.outputs!.company.name).toBe('Newco');
    expect(typeof out.outputs!.deal.dealId).toBe('string');
    expect(out.outputs!.created).toBeTruthy();
    expect(out.outputs!.contact.contactId).toBe(leadId);
  });

  it('reads: list/get companies, deals, tasks; suppression-summary', async () => {
    const companies = await run('feature.crm.nodes.list-companies', { orgId: ORG, q: 'Acme' });
    expect(companies.outputs!.companies.map((c: { companyId: string }) => c.companyId)).toContain(companyId);
    const company = await run('feature.crm.nodes.get-company', { orgId: ORG, companyId });
    expect(company.outputs!.company.companyId).toBe(companyId);
    expect((await run('feature.crm.nodes.get-company', { orgId: ORG, companyId: 'cmp:nope' })).outputs).toEqual({ company: null });

    const deals = await run('feature.crm.nodes.list-deals', { orgId: ORG, companyId });
    expect(deals.outputs!.deals.map((d: { dealId: string }) => d.dealId)).toEqual([dealId]);
    const deal = await run('feature.crm.nodes.get-deal', { orgId: ORG, dealId });
    expect(deal.outputs!.deal.status).toBe('won');

    const tasks = await run('feature.crm.nodes.list-tasks', { orgId: ORG, status: 'done' });
    expect(tasks.outputs!.tasks.map((t: { taskId: string }) => t.taskId)).toEqual([taskId]);

    const summary = await run('feature.crm.nodes.suppression-summary', {});
    expect(summary.status).toBe('success');
    expect(summary.outputs!.summary).toBeTruthy();
    expect(JSON.stringify(summary.outputs)).not.toContain('@'); // counts only, no addresses
  });

  it('segments: vocabulary → validate → persist (fail-closed on an invalid draft) → live members', async () => {
    const vocab = await run('feature.crm.nodes.segment-vocabulary', {});
    expect(vocab.outputs!.fields).toContain('stage');
    expect(vocab.outputs!.ops).toContain('eq');

    const filters = [{ field: 'stage', op: 'eq', value: 'qualified' }];
    const valid = await run('feature.crm.nodes.validate-segment', { filters });
    expect(valid.outputs!.valid).toBe(true);
    const invalid = await run('feature.crm.nodes.validate-segment', { filters: [{ field: 'bogus', op: 'eq', value: 'x' }] });
    expect(invalid.outputs!.valid).toBe(false);

    const refused = await run('feature.crm.nodes.persist-segment', { name: 'Bad', filters: [{ field: 'bogus', op: 'eq', value: 'x' }] });
    expect(refused.outputs!.success).toBe(false);
    expect(refused.outputs!.segment).toBeUndefined();
    expect(Array.isArray(refused.outputs!.errors)).toBe(true);

    const persisted = await run('feature.crm.nodes.persist-segment', { name: 'Qualified', filters });
    expect(persisted.outputs!.success).toBe(true);
    segmentId = persisted.outputs!.segment.segmentId as string;
    expect(segmentId).toBe(`seg:${RUN}:n`);

    const members = await run('feature.crm.nodes.list-segment-members', { segmentId });
    const memberIds = members.outputs!.members.map((m: { contactId: string }) => m.contactId);
    expect(memberIds).toContain(contactId); // Ada — staged to 'qualified' above
    expect(memberIds).toContain(leadId); // Grace — convert-contact advanced her lead → qualified (ADR 0209 §3)
    expect(memberIds).toHaveLength(2); // and nobody else: live evaluation against the tenant rolodex
  });

  it('booking: create a link, then list bookings (none claimed yet)', async () => {
    const link = await run('feature.crm.nodes.booking-create-link', {
      orgId: ORG, title: 'Intro call', timezone: 'UTC', weeklyHours: [{ day: 1, start: '09:00', end: '17:00' }], durations: [30], ownerUserId: USER,
    });
    expect(link.status).toBe('success');
    expect(link.outputs!.bookingLink.bookingLinkId).toBe(`booking-link:${RUN}:n`);
    const bookings = await run('feature.crm.nodes.booking-list', { orgId: ORG, bookingLinkId: link.outputs!.bookingLink.bookingLinkId });
    expect(bookings.outputs).toEqual({ bookings: [] });
  });

  it('e-sign: a request against a missing document and a status read of an unknown id are typed refusals / explicit misses', async () => {
    await expect(run('feature.crm.nodes.sign-request', {
      orgId: ORG, target: { kind: 'document', id: 'doc:does-not-exist' }, signers: [{ email: 'signer@acme.test' }],
    })).rejects.toMatchObject({ code: 'not_found' });
    // A malformed target never reaches the service: the surface refuses the key.
    await expect(run('feature.crm.nodes.sign-request', { orgId: ORG, target: {}, signers: [] })).rejects.toMatchObject({ code: 'validation_error' });
    const status = await run('feature.crm.nodes.sign-status', { orgId: ORG, signRequestId: 'sign-request:nope' });
    expect(status.status).toBe('success');
    expect(status.outputs).toEqual({ signRequest: null });
  });

  it('gmail-sync: real opt-in row, real contact match, real append + cursor — every connector invoke PINS the sync connectionId (ADR 0627 D5)', async () => {
    const conn = await upsertOAuthConnection({
      tenantId: T, provider: 'google', userId: USER,
      tokens: { accessToken: 'x', tokenType: 'Bearer', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] },
    });
    const sync = await createGmailSync({ tenantId: T, orgId: ORG, userId: USER, connectionId: conn.connectionId, cadence: 'daily' });
    const invokes: Array<{ connectorId: string; request: { url: string; connectionId?: string } }> = [];
    // DERIVED FROM NOW, not a literal — this was `Date.parse('2026-08-30T10:00:00.000Z')`
    // and it detonated on 2026-09-06, exactly seven days later, failing every gate
    // on `origin/main` in an area no change had touched.
    //
    // The pack scans from `sync.cursor ? Date.parse(cursor) : Date.now() - SEVEN_DAYS_MS`
    // (`packs/feature.crm.nodes/index.mjs`), so a first pass has a SEVEN-DAY
    // window measured against the real clock. A fixed fixture date is inside that
    // window the week it is written and outside it forever after: the message
    // stops being scanned, the cursor never advances, and the assertion reads
    // `undefined` — which looks like a cursor bug, not an expired fixture.
    //
    // Two days back keeps it comfortably inside the window at any wall-clock time,
    // and it is floored to a whole second because the cursor lands one second
    // before the message (`after:` is seconds-granular) and a sub-second fixture
    // would make that arithmetic depend on when the test happened to run.
    const internalDate = Math.floor((Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000) * 1000;
    const connectors = {
      invoke: async (connectorId: string, request: { url: string; connectionId?: string }) => {
        invokes.push({ connectorId, request });
        if (request.url.includes('/messages?')) return { ok: true, status: 200, data: { messages: [{ id: 'msg-1' }] } };
        return { ok: true, status: 200, data: { threadId: 'th-1', internalDate: String(internalDate), payload: { headers: [{ name: 'From', value: 'Ada <ada@acme.test>' }, { name: 'To', value: 'me@corp.test' }] } } };
      },
    };
    const out = await run('feature.crm.nodes.gmail-sync', {}, { config: { gmailSyncId: sync.syncId }, connectors });
    expect(out.status, JSON.stringify(out.error)).toBe('success');
    expect(out.outputs).toEqual({ scanned: 1, matched: 1, truncated: false });
    expect(invokes.length).toBe(2);
    for (const i of invokes) {
      expect(i.connectorId).toBe('google');
      expect(i.request.connectionId, 'every invoke must pin the sync row connection').toBe(conn.connectionId);
    }
    // The activity really landed (metadata-only, back-dated) and the cursor advanced to the message time.
    const activity = await getActivity(T, ORG, `act:gmail:${ORG}:msg-1:${contactId}`);
    expect(activity).toBeTruthy();
    expect(activity!.createdAt).toBe(new Date(internalDate).toISOString());
    expect(JSON.stringify(activity)).not.toContain('ada@acme.test');
    // Uniform landing: one second BEFORE the newest settled message (`after:` is seconds-granular).
    expect((await getGmailSync(T, sync.syncId))!.cursor).toBe(new Date(internalDate - 1000).toISOString());

    // A re-sync of the same message is `duplicate`: NOT a match (matched counts appends actually logged), no second row, cursor unchanged.
    const again = await run('feature.crm.nodes.gmail-sync', {}, { config: { gmailSyncId: sync.syncId }, connectors });
    expect(again.outputs).toEqual({ scanned: 1, matched: 0, truncated: false });
    expect((await getGmailSync(T, sync.syncId))!.cursor).toBe(new Date(internalDate - 1000).toISOString());
  });

  it('every one of the 27 manifest nodes was exercised through the real surface (no vacuous coverage)', () => {
    const declared = manifest.nodes.map((n) => n.typeId).sort();
    expect(declared).toHaveLength(27);
    expect([...exercised].sort()).toEqual(declared);
  });
});
