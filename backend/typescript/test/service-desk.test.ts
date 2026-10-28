/**
 * ADR 0422 P1 — the ticket kernel + service invariants:
 *  kernel-backed system entity (generic entities API refuses writes; scalars
 *  queryable; neverPublic), find-or-create by deterministic externalKey (a
 *  webhook retry never duplicates), messageId-idempotent CAS appends, thread
 *  cap, inbound-reply re-open, CAS status transitions, tenant/org isolation,
 *  and host.servicedesk.ticket.* emission (asserted through a pass-through spy
 *  on `emitHostEvent`: exact type + ids-only payload).
 * P5: the PUBLIC widget thread is read through the real route, so the
 * redaction asserted is the product's `publicView`, not a copy of it.
 *
 * PROTECTED (security floor / PII / org isolation; ADR 0422 + ADR 0878).
 * Ceiling, PROTECTED-LOW (SD-OBS-SEAM-1): the inbound multi-observer FAN-OUT
 * has no reachable test seam (`notifyInboundObserver` is private to
 * connections/inboundWebhooks.ts and is reached only by a provider-signed
 * webhook through `handleInboundEvent`), so that case asserts registration
 * only and the dedupe probe sd-observer stays vacuous by design.
 * The service-desk toggles are GLOBAL config writes (`saveConfig` is not
 * tenant-scoped): their stored state is captured before the file and restored
 * after it. Sabotage witnesses (grade-tests 8f w2): sd-* in g4-probes.json and
 * g4-reprobes.json.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { createTicket, appendMessage, setStatus, assignTicket, getTicket, listTickets, TICKET_TYPE } from '../src/features/service-desk/tickets.js';
import { MAX_MESSAGES_PER_TICKET } from '../src/features/service-desk/ticketTypes.js';
import { getStoredConfig, saveConfig, deleteConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import type { HostEvent } from '../src/host/hostEventDispatcher.js';
import type { FormDef, Submission } from '../src/features/forms/formsService.js';
import type { ToggleConfig } from '../src/host/featureToggles/types.js';

/** Every host event the product emitted, recorded by a PASS-THROUGH spy (the real
 *  dispatcher still runs). Every export of the module is kept (wave 42). */
const emitted = vi.hoisted(() => [] as Array<{ type: string; tenantId: string; payload: Record<string, unknown> }>);
vi.mock('../src/host/hostEventDispatcher.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/host/hostEventDispatcher.js')>();
  return {
    ...real,
    emitHostEvent: (event: HostEvent): Promise<void> => {
      emitted.push({ type: event.type, tenantId: event.tenantId, payload: event.payload });
      return real.emitHostEvent(event);
    },
  };
});

let server: http.Server;
let HTTP_BASE = '';
const T = 'tenant-sd-1';
const ORG = 'org-1';
const BASE = { tenantId: T, orgId: ORG, subject: 'Printer on fire', channel: 'manual', createdBy: 'u1' };
const TOGGLES = ['service-desk', 'service-desk.widget'] as const;
const priorToggles = new Map<string, ToggleConfig | null>();

/** Turn a (global) toggle ON from its registry default. */
async function toggleOn(id: (typeof TOGGLES)[number]): Promise<void> {
  await saveConfig({ ...getToggleDefault(id)!, status: 'on' }, 'test');
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { HTTP_BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of TOGGLES) priorToggles.set(id, await getStoredConfig(id));
});
afterAll(async () => {
  for (const id of TOGGLES) {
    const prior = priorToggles.get(id) ?? null;
    if (prior) await saveConfig(prior, 'test'); else await deleteConfig(id, 'test');
  }
  await new Promise<void>((res) => server.close(() => res()));
});

describe('ticket lifecycle', () => {
  it('creates, find-or-creates by externalKey (retry-safe), and appends idempotently', async () => {
    const key = 'wa:+15550001:2026-07-18';
    const first = await createTicket({ ...BASE, channel: 'whatsapp', externalKey: key, firstMessage: { messageId: 'SM1', body: 'help!', author: 'contact:c1' } });
    expect(first.created).toBe(true);
    expect(first.ticket.messages).toHaveLength(1);
    // The SAME externalKey + a NEW message = same ticket, thread grows.
    const again = await createTicket({ ...BASE, channel: 'whatsapp', externalKey: key, firstMessage: { messageId: 'SM2', body: 'still broken', author: 'contact:c1' } });
    expect(again.created).toBe(false);
    expect(again.ticket.ticketId).toBe(first.ticket.ticketId);
    expect(again.ticket.messages).toHaveLength(2);
    // A webhook RETRY (same messageId) is a no-op.
    const retry = await appendMessage(T, first.ticket.ticketId, { messageId: 'SM2', body: 'still broken', author: 'contact:c1' });
    expect(retry.messages).toHaveLength(2);
  });

  it('CAS status transitions; an inbound reply on a solved ticket re-opens it', async () => {
    const { ticket } = await createTicket({ ...BASE, subject: 'Login loop', externalKey: 'form:abc' });
    const solved = await setStatus(T, ticket.ticketId, 'solved', 'user:u1');
    expect(solved.status).toBe('solved');
    const reopened = await appendMessage(T, ticket.ticketId, { messageId: 'm-cust-1', body: 'it broke again', author: 'contact:c9', direction: 'inbound' });
    expect(reopened.status).toBe('open');
    // Internal notes do NOT re-open.
    await setStatus(T, ticket.ticketId, 'closed', 'user:u1');
    const noted = await appendMessage(T, ticket.ticketId, { messageId: 'm-note-1', body: 'wontfix', author: 'user:u1', direction: 'internal' });
    expect(noted.status).toBe('closed');
    await expect(setStatus(T, ticket.ticketId, 'bogus', 'user:u1')).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('assignment set/clear + list filters + tenant/org isolation', async () => {
    const { ticket } = await createTicket({ ...BASE, subject: 'Billing question', externalKey: 'form:def' });
    const assigned = await assignTicket(T, ticket.ticketId, 'member-1', 'user:u1');
    expect(assigned.assigneeMemberId).toBe('member-1');
    const cleared = await assignTicket(T, ticket.ticketId, undefined, 'user:u1');
    expect(cleared.assigneeMemberId).toBeUndefined();
    const open = await listTickets(T, ORG, { status: 'open' });
    expect(open.some((t) => t.ticketId === ticket.ticketId)).toBe(true);
    expect(await listTickets(T, 'org-other')).toEqual([]);
    expect(await getTicket('tenant-other', ticket.ticketId)).toBeNull();
  });

  it('the thread cap fails closed', async () => {
    const { ticket } = await createTicket({ ...BASE, subject: 'Chatty', externalKey: 'form:cap' });
    const { ticketStore } = await import('../src/features/service-desk/tickets.js');
    const stuffed = { ...ticket, messages: Array.from({ length: MAX_MESSAGES_PER_TICKET }, (_, i) => ({ messageId: `m${i}`, direction: 'inbound' as const, body: 'x', author: 'c', at: ticket.createdAt })) };
    await ticketStore.put(stuffed);
    await expect(appendMessage(T, ticket.ticketId, { messageId: 'overflow', body: 'x', author: 'c' })).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('kernel discipline', () => {
  it('the generic entities API refuses ticket writes (system type) and the type is minted neverPublic', async () => {
    await createTicket({ ...BASE, subject: 'Seed the type', externalKey: 'form:mint' });
    const { createEntity, getEntityType } = await import('../src/features/entities/entitiesService.js');
    await expect(createEntity({ tenantId: T, typeName: TICKET_TYPE, values: { org_id: ORG, subject: 'sneak', ticket_status: 'open', priority: 'low', channel: 'manual' }, createdBy: 'u1' }))
      .rejects.toMatchObject({ code: 'validation_error' });
    const type = await getEntityType(T, undefined, TICKET_TYPE);
    expect(type?.system).toBe(true);
    expect(type?.neverPublic).toBe(true);
  });

  it('emits host.servicedesk.ticket.* on mutations (ids-only payload)', async () => {
    const { ticket } = await createTicket({ ...BASE, subject: 'Event check', externalKey: 'form:evt' });
    const after = await setStatus(T, ticket.ticketId, 'pending', 'user:u1');
    expect(after.status).toBe('pending');
    const mine = emitted.filter((e) => e.payload.ticketId === ticket.ticketId);
    expect(mine.map((e) => e.type)).toEqual(['host.servicedesk.ticket.created', 'host.servicedesk.ticket.status-changed']);
    // The exact ids-only payload: no subject, no messages, no bodies.
    expect(mine[1]).toEqual({
      type: 'host.servicedesk.ticket.status-changed',
      tenantId: T,
      payload: { ticketId: ticket.ticketId, orgId: ORG, status: 'pending', channel: 'manual', from: 'open', actor: 'user:u1' },
    });
    for (const e of mine) {
      expect(Object.keys(e.payload)).not.toContain('subject');
      expect(Object.keys(e.payload)).not.toContain('messages');
    }
  });
});

describe('ADR 0422 P2 — intake', () => {
  it('whatsapp inbound files onto ONE continuous ticket; provider retries dedupe; unconfigured no-ops', async () => {
    const { onWhatsAppInboundForTickets, setIntakeConfig } = await import('../src/features/service-desk/intake.js');
    // ADR 0878 D9 — intake files only while Service desk is ON.
    await toggleOn('service-desk');
    const t2 = 'tenant-sd-intake';
    // Unconfigured: no ticket minted.
    await onWhatsAppInboundForTickets({ tenantId: t2, connectionId: 'conn-1', body: { From: '+15550001', Body: 'help', MessageSid: 'SMa' } });
    expect(await listTickets(t2, 'org-intake')).toEqual([]);
    // Configured: find-or-create per sender, dedupe by MessageSid.
    await setIntakeConfig(t2, 'org-intake', 'admin-1');
    await onWhatsAppInboundForTickets({ tenantId: t2, connectionId: 'conn-1', body: { From: '+15550001', Body: 'help', MessageSid: 'SMa' } });
    await onWhatsAppInboundForTickets({ tenantId: t2, connectionId: 'conn-1', body: { From: '+15550001', Body: 'help', MessageSid: 'SMa' } }); // retry
    await onWhatsAppInboundForTickets({ tenantId: t2, connectionId: 'conn-1', body: { From: '+15550001', Body: 'and my invoice?', MessageSid: 'SMb' } });
    const tickets = await listTickets(t2, 'org-intake');
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.channel).toBe('whatsapp');
    expect(tickets[0]!.messages.map((m) => m.messageId)).toEqual(['SMa', 'SMb']);
    // A DIFFERENT sender = a different ticket.
    await onWhatsAppInboundForTickets({ tenantId: t2, connectionId: 'conn-1', body: { From: '+15550002', Body: 'hi', MessageSid: 'SMc' } });
    expect(await listTickets(t2, 'org-intake')).toHaveLength(2);
  });

  it('the forms sink files a ticket keyed by submissionId and reuses the chain contact marker', async () => {
    const { registerServiceDeskIntake, setIntakeConfig } = await import('../src/features/service-desk/intake.js');
    const { clearSubmissionSinksForTest, registerSubmissionSink, runSubmissionSinks } = await import('../src/features/forms/submissionSinks.js');
    const t3 = 'tenant-sd-forms';
    await setIntakeConfig(t3, 'org-f', 'admin-1');
    clearSubmissionSinksForTest();
    // A stand-in "CRM sink" resolves the contact BEFORE our sink runs.
    registerSubmissionSink({ id: 'crm-contact', async onSubmission() { return { contactId: 'contact-42' }; } });
    registerServiceDeskIntake(); // registers after — reuses the marker
    // ADR 0850 D1 — the form sink now reads the service-desk toggle (FRMWF-13: it
    // was the only sink that read none), so the tenant has it on here.
    await toggleOn('service-desk');
    // ADR 0850 D1 — a form files tickets only when it opted in, into its own org.
    const at = '2026-07-18T00:00:00.000Z';
    const form: FormDef = {
      formId: 'form-1', tenantId: t3, orgId: 'org-f', title: 'Support request', status: 'published', fields: [],
      createToContact: false, createTicket: true, createdBy: 'admin-1', createdAt: at, updatedAt: at,
    };
    // A real submission carries its form's org; the ticket files into that org.
    const submission: Submission = { submissionId: 'sub-1', tenantId: t3, orgId: 'org-f', formId: 'form-1', values: { email: 'a@b.co', message: 'it broke' }, meta: {}, createdAt: at };
    await runSubmissionSinks(form, submission);
    await runSubmissionSinks(form, submission); // sink retry — idempotent
    const tickets = await listTickets(t3, 'org-f');
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.channel).toBe('form');
    expect(tickets[0]!.contactId).toBe('contact-42');
    expect(tickets[0]!.messages).toHaveLength(1);
  });

  it('the multi-observer seam runs BOTH registrants (window ledger + tickets coexist)', async () => {
    // PROTECTED-LOW (SD-OBS-SEAM-1) — kept by ruling, NOT a witness of its title.
    // The fan-out (`notifyInboundObserver`) is private to inboundWebhooks.ts and
    // reachable only through a provider-signed webhook, and no test-only seam is
    // exported, so this case can assert only that REGISTERING several observers
    // on one provider is accepted and invokes none of them. That both registrants
    // run, and that a re-registered fn is not run twice, is UNWITNESSED here
    // (probe sd-observer is vacuous by design). The earlier "covered structurally
    // by the intake test above" comment was false: the intake test calls the
    // ticket handler directly and never goes through the observer list.
    const { registerInboundObserver } = await import('../src/features/connections/inboundWebhooks.js');
    const calls: string[] = [];
    const a = async (): Promise<void> => { calls.push('a'); };
    const b = async (): Promise<void> => { calls.push('b'); };
    // A real provider id (no cast). Nothing in this file sends a zoom webhook.
    expect(() => {
      registerInboundObserver('zoom-webinar', a);
      registerInboundObserver('zoom-webinar', b);
      registerInboundObserver('zoom-webinar', a); // same fn re-registered = no dup (unwitnessed)
    }).not.toThrow();
    expect(calls, 'registration must never invoke an observer').toEqual([]);
  });
});

describe('ADR 0422 P3 — the governed agent lane', () => {
  const exec = async (name: string, input: Record<string, unknown>, scope: { tenantId: string; actingUserId?: string }) => {
    const { createAgentToolProvider } = await import('../src/host/agentToolProvider.js');
    return createAgentToolProvider({ tenantId: scope.tenantId, runId: 'run-sd', ...(scope.actingUserId ? { actingUserId: scope.actingUserId } : {}) }).executeTool({ name, input });
  };

  const enableServiceDesk = (): Promise<void> => toggleOn('service-desk');

  // CHAT-FIRST-PORT-AUDIT D8: the agent tools now share the routes' org-scope
  // predicate, so the acting user needs a real membership + scope in the ticket's
  // org (demo mode is OFF in the test env — an unknown subject resolves to zero
  // scopes). Grant u1 editor (workspace:read+write) in tenant-sd-1/org-1.
  beforeAll(async () => {
    const { createMember } = await import('../src/host/accessControlService.js');
    await createMember({ orgId: ORG, tenantId: T, displayName: 'Support Agent User', subject: 'u1', roles: ['editor'] });
  });

  it('draft-reply enqueues an approval and NEVER writes the thread; approval executes the outbound append', async () => {
    await enableServiceDesk();

    const { ticket } = await createTicket({ ...BASE, subject: 'Reply lane', externalKey: 'form:reply-lane', firstMessage: { messageId: 'in-1', body: 'where is my order?', author: 'contact:c1' } });
    const drafted = await exec('openwop:servicedesk.draft-reply', { ticketId: ticket.ticketId, reply: 'It ships tomorrow.' }, { tenantId: T, actingUserId: 'u1' });
    const parsed = JSON.parse(drafted.content) as { queued?: { actionId: string } };
    expect(parsed.queued?.actionId).toBeTruthy();
    // The thread is UNTOUCHED until a human decides.
    expect((await getTicket(T, ticket.ticketId))!.messages).toHaveLength(1);

    // The approval decision executes the append (the executor case). Deps:
    // the servicedesk branch touches neither the catalog nor run starting —
    // only policy (default approval-required) reads storage for the audit.
    const { executeApprovedAction } = await import('../src/features/assistant/actionExecution.js');
    const { getPendingAction } = await import('../src/features/assistant/assistantService.js');
    const { openStorage } = await import('../src/storage/index.js');
    const depsStorage = await openStorage('memory://');
    const runDeps = { storage: depsStorage, hostSuite: {} } as unknown as Parameters<typeof executeApprovedAction>[0]; // test-only justified cast: the servicedesk branch reads only deps.storage (policy audit); it never starts a run, so the hostSuite slots are unreachable
    const action = await getPendingAction(T, parsed.queued!.actionId);
    expect(action).toBeTruthy();
    // UX_UPGRADE-assistant R2 (AST2-B2) — this used to assert `outcome === 'sent'`,
    // which PINNED THE DEFECT: `executeApprovedAction` is documented as returning
    // "the execution runId when one was dispatched", and this branch dispatches
    // no run. The literal `'sent'` it returned was the string the code was also
    // wrongly writing into `executionRunId` instead of into `status` — so the
    // test asserted the symptom and the row's real state was never checked at
    // all. It now asserts the STATUS, which is what the product claims.
    const outcome = await executeApprovedAction(runDeps, T, action!, 'approver-1');
    expect(outcome, 'no run is dispatched for a servicedesk reply').toBeNull();
    // ADR 0878 (grade-code SD2CD-1) — this asserted `sent`, and it was the same
    // defect class as the AST2-B2 note above: the ticket is a FORM ticket, which
    // has no reply channel, so nothing reached the customer. The reply is on the
    // thread (asserted below); the SEND failed, and the action now says so.
    expect((await getPendingAction(T, parsed.queued!.actionId))!.status).toBe('failed');
    const after = await getTicket(T, ticket.ticketId);
    expect(after!.messages).toHaveLength(2);
    expect(after!.messages[1]!.direction).toBe('outbound');
    expect(after!.messages[1]!.body).toContain('ships tomorrow');
    // Idempotent on re-execution (same actionId → same messageId).
    await executeApprovedAction(runDeps, T, action!, 'approver-1');
    expect((await getTicket(T, ticket.ticketId))!.messages).toHaveLength(2);
  });

  it('tools fail empty without an acting user (system runs)', async () => {
    const anon = await exec('openwop:servicedesk.get-ticket', { ticketId: 'x' }, { tenantId: T });
    expect(JSON.parse(anon.content).note).toContain('unavailable');
  });

  it('the node pack wraps the surface reads (honest-off without it)', async () => {
    // @ts-expect-error — .mjs pack module has no type declarations (pure-JS node pack).
    const { nodes } = await import('../../../packs/feature.service-desk.nodes/index.mjs');
    await expect(nodes['feature.service-desk.nodes.list-tickets']({ inputs: {}, features: {} })).rejects.toMatchObject({ code: 'host_capability_missing' });
    // Own fixtures (shuffle-safe): one ticket in ORG, one in another org of the same tenant.
    const { ticket: mineTicket } = await createTicket({ ...BASE, subject: 'Pack read', externalKey: 'form:pack-mine' });
    const { ticket: otherTicket } = await createTicket({ ...BASE, orgId: 'org-other-pack', subject: 'Pack other', externalKey: 'form:pack-other' });
    const { buildServiceDeskSurface } = await import('../src/features/service-desk/surface.js');
    const out = await nodes['feature.service-desk.nodes.list-tickets']({ inputs: { orgId: ORG }, features: { 'service-desk': buildServiceDeskSurface({ tenantId: T, runId: 'r' }) } });
    expect(out.status).toBe('success');
    const ids = (out.outputs.tickets as Array<{ ticketId: string }>).map((t) => t.ticketId);
    expect(ids).toContain(mineTicket.ticketId);
    expect(ids, 'the pack read crossed into another org').not.toContain(otherTicket.ticketId);
  });

  // CHAT-FIRST-PORT-AUDIT D8 — cross-org isolation within a SHARED tenant.
  describe('D8 — the agent tools enforce the routes\' org scope', () => {
    const TT = 'tenant-sd-d8';
    const ORG_A = 'org-a';
    const ORG_B = 'org-b';

    beforeAll(async () => {
      await enableServiceDesk();
      const { createMember } = await import('../src/host/accessControlService.js');
      // alice: editor in org-A only (no membership at all in org-B).
      await createMember({ orgId: ORG_A, tenantId: TT, displayName: 'Alice', subject: 'alice', roles: ['editor'] });
      // bob: viewer in org-A (read, but NOT write).
      await createMember({ orgId: ORG_A, tenantId: TT, displayName: 'Bob', subject: 'bob', roles: ['viewer'] });
    });

    const mk = (org: string, key: string) =>
      createTicket({ tenantId: TT, orgId: org, subject: `T ${key}`, channel: 'manual', externalKey: `d8:${key}`, createdBy: 'system',
        firstMessage: { messageId: `in-${key}`, body: 'help', author: 'contact:c1' } });

    it('a user scoped to org-A cannot list/read/act on org-B tickets (reads EMPTY, actions typed)', async () => {
      const { ticket: tb } = await mk(ORG_B, 'b1');

      // list org-B as alice → EMPTY (indistinguishable from an org with no tickets).
      const listed = await exec('openwop:servicedesk.list-tickets', { orgId: ORG_B }, { tenantId: TT, actingUserId: 'alice' });
      expect(JSON.parse(listed.content).tickets).toEqual([]);

      // get org-B ticket as alice → null (same shape as an unknown id, no leak).
      const got = await exec('openwop:servicedesk.get-ticket', { ticketId: tb.ticketId }, { tenantId: TT, actingUserId: 'alice' });
      expect(JSON.parse(got.content).ticket).toBeNull();

      // draft-reply / set-status on org-B as alice → typed error, NOT silent success.
      const drafted = await exec('openwop:servicedesk.draft-reply', { ticketId: tb.ticketId, reply: 'hi' }, { tenantId: TT, actingUserId: 'alice' });
      expect(drafted.isError).toBe(true);
      expect(JSON.parse(drafted.content).error.code).toBe('not_found'); // no read ⇒ no existence leak
      const statused = await exec('openwop:servicedesk.set-status', { ticketId: tb.ticketId, status: 'solved' }, { tenantId: TT, actingUserId: 'alice' });
      expect(statused.isError).toBe(true);
      expect(JSON.parse(statused.content).error.code).toBe('not_found');
      // The org-B ticket is untouched.
      expect((await getTicket(TT, tb.ticketId))!.status).not.toBe('solved');
    });

    it('happy path unchanged: a member acts within their OWN org', async () => {
      const { ticket: ta } = await mk(ORG_A, 'a1');
      const listed = await exec('openwop:servicedesk.list-tickets', { orgId: ORG_A }, { tenantId: TT, actingUserId: 'alice' });
      expect(JSON.parse(listed.content).tickets.map((t: { ticketId: string }) => t.ticketId)).toContain(ta.ticketId);
      const got = await exec('openwop:servicedesk.get-ticket', { ticketId: ta.ticketId }, { tenantId: TT, actingUserId: 'alice' });
      expect(JSON.parse(got.content).ticket.ticketId).toBe(ta.ticketId);
      const statused = await exec('openwop:servicedesk.set-status', { ticketId: ta.ticketId, status: 'solved' }, { tenantId: TT, actingUserId: 'alice' });
      expect(statused.isError).toBeUndefined();
      expect(JSON.parse(statused.content).ticket.status).toBe('solved');
    });

    it('a read-only member gets a TYPED forbidden_scope on write actions (readable, not writable)', async () => {
      const { ticket: ta } = await mk(ORG_A, 'a2');
      // bob can READ org-A…
      const got = await exec('openwop:servicedesk.get-ticket', { ticketId: ta.ticketId }, { tenantId: TT, actingUserId: 'bob' });
      expect(JSON.parse(got.content).ticket.ticketId).toBe(ta.ticketId);
      // …but write actions fail TYPED forbidden_scope (not empty-success).
      const drafted = await exec('openwop:servicedesk.draft-reply', { ticketId: ta.ticketId, reply: 'hi' }, { tenantId: TT, actingUserId: 'bob' });
      expect(drafted.isError).toBe(true);
      expect(JSON.parse(drafted.content).error.code).toBe('forbidden_scope');
      const statused = await exec('openwop:servicedesk.set-status', { ticketId: ta.ticketId, status: 'closed' }, { tenantId: TT, actingUserId: 'bob' });
      expect(statused.isError).toBe(true);
      expect(JSON.parse(statused.content).error.code).toBe('forbidden_scope');
    });
  });
});

describe('ADR 0422 P4 — SLA clocks', () => {
  it('stamps sla_due_at from the priority table, sweeps a breach exactly once, settles on solve', async () => {
    const { sweepSlaTimers, slaTimers } = await import('../src/features/service-desk/sla.js');
    // The sweep fires only while Service desk is ON (it suppresses otherwise), so
    // this case sets the toggle itself instead of inheriting it from an earlier
    // case (it went red under --sequence.seed=17 before this line).
    await toggleOn('service-desk');
    const t4 = 'tenant-sd-sla';
    const { ticket } = await createTicket({ tenantId: t4, orgId: 'org-s', subject: 'SLA me', channel: 'manual', priority: 'urgent', externalKey: 'form:sla-1', createdBy: 'u1', slaHoursByPriority: { urgent: 1 } });
    expect(ticket.slaDueAt).toBeTruthy();
    // Not yet due — sweep fires nothing.
    expect(await sweepSlaTimers(new Date())).toBe(0);
    // Past due — fires exactly once (CAS), then never again.
    const past = new Date(Date.parse(ticket.slaDueAt!) + 1000);
    expect(await sweepSlaTimers(past)).toBe(1);
    expect(await sweepSlaTimers(past)).toBe(0);
    // Solving settles (deletes) the timer row.
    const { ticket: t2 } = await createTicket({ tenantId: t4, orgId: 'org-s', subject: 'Settle me', channel: 'manual', priority: 'high', externalKey: 'form:sla-2', createdBy: 'u1' });
    expect(await slaTimers.get(`${t4}:${t2.ticketId}`)).toBeTruthy();
    await setStatus(t4, t2.ticketId, 'solved', 'user:u1');
    expect(await slaTimers.get(`${t4}:${t2.ticketId}`)).toBeNull();
  });

  it('a 0-hour priority disables the clock', async () => {
    const t4 = 'tenant-sd-sla';
    const { ticket } = await createTicket({ tenantId: t4, orgId: 'org-s', subject: 'No clock', channel: 'manual', priority: 'low', externalKey: 'form:sla-3', createdBy: 'u1', slaHoursByPriority: { low: 0 } });
    expect(ticket.slaDueAt).toBeUndefined();
  });
});

describe('ADR 0422 P5 — the public widget lane', () => {
  it('token round-trip: mint → same-thread appends → own-thread read with internal notes REDACTED; forged/foreign fails 404-shaped', async () => {
    const { mintVisitorToken, verifyVisitorToken, mintPublicIntakeKey, tenantForIntakeKey } = await import('../src/features/service-desk/widgetRoutes.js');
    const t5 = 'tenant-sd-widget';
    // Key resolution: minted key resolves; garbage/foreign shapes do not.
    const key = await mintPublicIntakeKey(t5);
    expect(await tenantForIntakeKey(key)).toBe(t5);
    expect(await tenantForIntakeKey('sdk_' + 'f'.repeat(32))).toBeNull();
    expect(await tenantForIntakeKey('../../etc/passwd')).toBeNull();
    // Re-mint replaces (old key dies).
    const key2 = await mintPublicIntakeKey(t5);
    expect(await tenantForIntakeKey(key)).toBeNull();
    expect(await tenantForIntakeKey(key2)).toBe(t5);
    // Visitor token: verify round-trip; tampering fails.
    const { visitorId, token } = mintVisitorToken(t5);
    expect(verifyVisitorToken(token, t5)).toBe(visitorId);
    expect(verifyVisitorToken(token.slice(0, -1) + (token.endsWith('0') ? '1' : '0'), t5)).toBeNull();
    expect(verifyVisitorToken('sdv2.aaaaaaaaaaaaaaaaaaaa.' + 'b'.repeat(32), t5)).toBeNull();
    // ADR 0878 D3a — bound to the tenant: another tenant's widget refuses it.
    expect(verifyVisitorToken(token, 'tenant-other')).toBeNull();
  });

  it('the visitor thread is find-or-create per visitor and the public view never contains internal notes', async () => {
    const { setIntakeConfig } = await import('../src/features/service-desk/intake.js');
    const { mintPublicIntakeKey } = await import('../src/features/service-desk/widgetRoutes.js');
    const t5 = 'tenant-sd-widget-thread';
    await toggleOn('service-desk');
    await toggleOn('service-desk.widget');
    await setIntakeConfig(t5, 'org-w', 'admin-1');
    const key = await mintPublicIntakeKey(t5);
    const PUB = `${HTTP_BASE}/host/openwop-app/public-service-desk/${key}`;

    // The visitor's first message mints the session and the thread (the real route).
    const sent = await fetch(`${PUB}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'hello' }) });
    expect(sent.status).toBe(201);
    const { visitorToken, ticket } = (await sent.json()) as { visitorToken: string; ticket: { ticketId: string } };
    // A second message with the token lands on the SAME thread (find-or-create per visitor).
    const again = await fetch(`${PUB}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'anyone there?', visitorToken }) });
    expect(again.status).toBe(201);
    expect(((await again.json()) as { ticket: { ticketId: string } }).ticket.ticketId).toBe(ticket.ticketId);

    await appendMessage(t5, ticket.ticketId, { messageId: 'note-1', body: 'internal: refund approved up to $50', author: 'user:agent1', direction: 'internal' });
    await appendMessage(t5, ticket.ticketId, { messageId: 'out-1', body: 'We are on it!', author: 'user:agent1', direction: 'outbound' });
    expect((await getTicket(t5, ticket.ticketId))!.messages, 'premise: the internal note IS on the thread').toHaveLength(4);

    // What the widget route actually serves the visitor.
    const read = await fetch(`${PUB}/thread`, { headers: { 'x-visitor-token': visitorToken } });
    expect(read.status).toBe(200);
    const view = (await read.json()) as { ticket: { messages: Array<Record<string, unknown>> } };
    expect(view.ticket.messages.map((m) => m.body)).toEqual(['hello', 'anyone there?', 'We are on it!']);
    expect(JSON.stringify(view)).not.toContain('refund approved'); // the internal note NEVER leaks
    for (const m of view.ticket.messages) expect(Object.keys(m).sort()).toEqual(['at', 'body', 'direction']); // no author / internal ids
  });
});
