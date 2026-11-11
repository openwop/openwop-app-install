/**
 * ADR 1024 P3 — the CDP collect seam: who may write, what may be written over HTTP, on
 * what consent basis, and what a scope-limited reader sees (feature-loop row 73,
 * `CDP2WF-1/-2/-3/-11/-12/-21`).
 *
 * One describe per decision, each written so removing its mechanism fails it:
 *  D1   a Viewer can no longer collect or register schemas; a schema needs host:org:manage;
 *  D4.2 `funnel.`/`kicktodo.`/`forms.` are refused over HTTP (after the trim), and an
 *       in-process `first-party` caller still writes them;
 *  D4.3 the five consent witnesses the lead set (user decision Q1, N1 resolved
 *       2026-11-02), plus `transactional` refused and the purpose stored;
 *  D4.4 schema registration is bounded (versions, size, regex keywords) and validation
 *       still answers by version;
 *  D4.5 an API-key reader gets masked collected and merge events (as `/resolve` masks);
 *  D4.6 an email-shaped value under any key is tagged, so the erasure barrier sees it.
 *
 * Red when (sabotage-witnessed in this PR, each applied and reverted in one step): any
 * route's `requireWrite` → `requireRead`; the `host:org:manage` check removed; the
 * reserved-prefix check removed or moved before the trim; `assertConsentedCollection`
 * skipped, or reading only the person keys; `transactional` admitted; the version cap,
 * size cap or keyword refusal removed; the read masking removed; the value-shape tag
 * removed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import { userIdFor } from '../src/features/users/usersService.js';
import { setPolicy, recordConsent, writeErasureTombstone } from '../src/features/consent/consentService.js';
import { collectEvent, listCollectedEvents, __resetCollectDenialWindows, DENIAL_WINDOW_MS } from '../src/features/cdp/collectService.js';
import { listGovernanceDecisions } from '../src/host/governanceDecisionLog.js';
import { registerEventSchema, validateEvent, MAX_SCHEMA_VERSIONS } from '../src/features/cdp/eventSchemaService.js';

let server: Server;
let BASE = '';
let WS = '';
const OWNER = 'oidc:c1024-owner';
const EDITOR = 'oidc:c1024-editor';
const VIEWER = 'oidc:c1024-viewer';
let n = 0;
const tenant = (): string => `tenant-1024-collect-${++n}`;

async function setToggle(id: string, status: 'on' | 'off'): Promise<void> {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle ${id}`);
  await saveConfig({ ...d, status }, 'test');
}
async function login(subject: string): Promise<string> {
  const res = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject, tenantId: WS, displayName: subject, sharedWorkspace: true }),
  });
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}
async function call(auth: { cookie?: string; bearer?: string }, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE}/host/openwop-app${path}`, {
    method,
    headers: {
      ...(auth.cookie ? { cookie: auth.cookie } : {}),
      ...(auth.bearer ? { authorization: `Bearer ${auth.bearer}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}
async function codeOf(p: Promise<unknown>): Promise<{ status?: number; reason?: string; code?: string }> {
  try { await p; return {}; } catch (e) {
    const err = e as { httpStatus?: number; code?: string; details?: { reason?: string } };
    return { status: err.httpStatus, code: err.code, reason: err.details?.reason };
  }
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
  await setToggle('cdp', 'on');
  await setToggle('crm', 'on');
  const ws = await createWorkspace({ name: 'ADR 1024 collect', ownerSubject: OWNER });
  WS = ws.orgId ?? ws.tenantId;
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Editor', subject: userIdFor(WS, EDITOR), roles: ['editor'] });
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Viewer', subject: userIdFor(WS, VIEWER), roles: ['viewer'] });
});
afterAll(async () => {
  await setToggle('consent', 'off');
  await new Promise<void>((r) => server.close(() => r()));
});

describe('D1 — writes need workspace:write; a schema needs host:org:manage', () => {
  it('a viewer is refused every write; an editor collects; only an admin registers a schema', async () => {
    const viewer = { cookie: await login(VIEWER) };
    const editor = { cookie: await login(EDITOR) };
    const owner = { cookie: await login(OWNER) };
    const ev = { eventType: 'page_view', payload: { page: '/a' } };
    expect((await call(viewer, 'POST', '/cdp/collect', ev)).status).toBe(403);
    expect((await call(viewer, 'POST', '/cdp/collect/batch', { events: [ev] })).status).toBe(403);
    expect((await call(viewer, 'POST', '/cdp/collect/import', { csv: 'page\n/a', eventType: 'page_view' })).status).toBe(403);
    expect((await call(viewer, 'POST', '/cdp/event-schemas', { eventType: 'page_view', schema: { type: 'object' } })).status).toBe(403);
    expect((await call(viewer, 'GET', '/cdp/collected-events')).status, 'reads stay open').toBe(200);

    const collected = await call(editor, 'POST', '/cdp/collect', ev);
    expect(collected.status, JSON.stringify(collected.body)).toBe(201);
    expect(collected.body.purpose).toBe('analytics');
    expect((await call(editor, 'POST', '/cdp/event-schemas', { eventType: 'page_view', schema: { type: 'object' } })).status).toBe(403);
    expect((await call(owner, 'POST', '/cdp/event-schemas', { eventType: 'page_view', schema: { type: 'object' } })).status).toBe(201);
  });
});

describe('D4.2 — in-process event families are not writable over HTTP', () => {
  it('refuses funnel./kicktodo./forms. over HTTP, also behind a leading space; a first-party owner writes them', async () => {
    const t = tenant();
    for (const et of ['funnel.step_completed', ' funnel.step_viewed', 'kicktodo.participant.joined', 'forms.submitted']) {
      expect(await codeOf(collectEvent(t, et, { stepId: 's' })), et).toMatchObject({ status: 422, reason: 'reserved_event_type' });
    }
    const editor = { cookie: await login(EDITOR) };
    expect((await call(editor, 'POST', '/cdp/collect', { eventType: 'funnel.step_completed', payload: { stepId: 's' } })).status).toBe(422);
    const batch = await call(editor, 'POST', '/cdp/collect/batch', { events: [{ eventType: 'kicktodo.x', payload: {} }] });
    expect(batch.body.rejected, JSON.stringify(batch.body)).toBe(1);
    const ok = await collectEvent(t, 'funnel.step_completed', { stepId: 's' }, undefined, { source: 'first-party' });
    expect(ok.eventId).toMatch(/^evt:/);
  });
});

describe('D4.3 — consent for every identifier, on the tenant policy default (Q1)', () => {
  it('(1) a visitor-only event with no consent in an opt-in tenant is REFUSED', async () => {
    await setToggle('consent', 'on');
    const t = tenant();
    await setPolicy(t, { defaultMode: 'opt-in' });
    expect(await codeOf(collectEvent(t, 'page_view', { anonymousId: 'anon-1', page: '/' }))).toMatchObject({ status: 403, reason: 'consent_required' });
    expect(await listCollectedEvents(t)).toEqual([]);
  });

  it('(2) the same event in an opt-out tenant is ACCEPTED with its purpose stored', async () => {
    await setToggle('consent', 'on');
    const t = tenant();
    await setPolicy(t, { defaultMode: 'opt-out' });
    const r = await collectEvent(t, 'page_view', { anonymousId: 'anon-1', page: '/' }, undefined, { purpose: 'personalization' });
    expect(r.purpose).toBe('personalization');
    expect((await listCollectedEvents(t))[0]?.purpose).toBe('personalization');
  });

  it('(3) an event that names NO identifier is ACCEPTED, even in an opt-in tenant', async () => {
    await setToggle('consent', 'on');
    const t = tenant();
    await setPolicy(t, { defaultMode: 'opt-in' });
    expect((await collectEvent(t, 'page_view', { page: '/' })).purpose).toBe('analytics');
  });

  it('(4) a contactId event with no consent is REFUSED; a recorded consent admits it', async () => {
    await setToggle('consent', 'on');
    const t = tenant();
    await setPolicy(t, { defaultMode: 'opt-in' });
    expect(await codeOf(collectEvent(t, 'signup', { contactId: 'crm:c-1' }))).toMatchObject({ status: 403, reason: 'consent_required' });
    await recordConsent({ tenantId: t, subjectKey: 'crm:c-1', categories: { analytics: true }, source: 'test' });
    expect((await collectEvent(t, 'signup', { contactId: 'crm:c-1' })).eventId).toMatch(/^evt:/);
  });

  it('(5) with the consent toggle OFF everything passes as before (purpose still stored)', async () => {
    await setToggle('consent', 'off');
    const t = tenant();
    await setPolicy(t, { defaultMode: 'opt-in' });
    expect((await collectEvent(t, 'page_view', { anonymousId: 'anon-2', contactId: 'crm:c-2' })).purpose).toBe('analytics');
  });

  it('an ERASED identifier is the barrier\'s 409, not a consent 403 (L2)', async () => {
    await setToggle('consent', 'on');
    const t = tenant();
    await setPolicy(t, { defaultMode: 'opt-out' });
    await writeErasureTombstone(t, 'crm:gone');
    expect(await codeOf(collectEvent(t, 'signup', { contactId: 'crm:gone' }))).toMatchObject({ status: 409, code: 'subject_erased' });
  });

  it('refused events are rolled up: one audit row per window, then one "suppressed K" row (CDP2WF-30)', async () => {
    await setToggle('consent', 'on');
    __resetCollectDenialWindows();
    const t = tenant();
    await setPolicy(t, { defaultMode: 'opt-in' });
    const settle = () => new Promise((r) => setTimeout(r, 50));
    const rows = async () => (await listGovernanceDecisions(t, { kind: 'consent' })).map((r) => (r.payload as { reason?: string; suppressed?: number }));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-02T10:00:00Z'));
      for (let i = 0; i < 50; i++) await codeOf(collectEvent(t, 'page_view', { anonymousId: `anon-${i}` }));
      await settle();
      expect((await rows()).length, 'fifty refusals, one durable row').toBe(1);
      vi.setSystemTime(new Date(Date.parse('2026-11-02T10:00:00Z') + DENIAL_WINDOW_MS + 1));
      await codeOf(collectEvent(t, 'page_view', { anonymousId: 'anon-late' }));
      await settle();
      const after = await rows();
      expect(after.length).toBe(3);
      expect(after.find((r) => r.reason === 'collect-denials-suppressed')).toMatchObject({ suppressed: 49 });
    } finally { vi.useRealTimers(); }
  });

  it('refuses `transactional` (it would skip the consent module and the erasure tombstone) and unknown purposes', async () => {
    const t = tenant();
    for (const purpose of ['transactional', 'whatever']) {
      expect(await codeOf(collectEvent(t, 'page_view', { anonymousId: 'a' }, undefined, { purpose }))).toMatchObject({ status: 400 });
    }
  });
});

describe('D4.4 — schema registration is bounded; validation still answers by version', () => {
  it('caps versions, size and regex keywords', async () => {
    const t = tenant();
    for (let i = 0; i < MAX_SCHEMA_VERSIONS; i++) await registerEventSchema(t, 'capped', { type: 'object' });
    expect(await codeOf(registerEventSchema(t, 'capped', { type: 'object' }))).toMatchObject({ status: 400 });
    expect(await codeOf(registerEventSchema(t, 'rx', { type: 'object', properties: { a: { type: 'string', pattern: '^(a+)+$' } } }))).toMatchObject({ status: 400 });
    expect(await codeOf(registerEventSchema(t, 'rx2', { type: 'object', patternProperties: { '^x': { type: 'string' } } }))).toMatchObject({ status: 400 });
    expect(await codeOf(registerEventSchema(t, 'big', { type: 'object', description: 'x'.repeat(70 * 1024) }))).toMatchObject({ status: 400 });
    // A pattern buried below the walk's depth limit is refused, not waved through (H1).
    let deep: Record<string, unknown> = { type: 'string', pattern: '^(a+)+$' };
    for (let i = 0; i < 65; i++) deep = { type: 'array', items: deep };
    expect(await codeOf(registerEventSchema(t, 'deep', deep))).toMatchObject({ status: 400 });
  });

  it('a PROPERTY named pattern, and pattern inside const/default data, are not keywords (M1)', async () => {
    const t = tenant();
    const rec = await registerEventSchema(t, 'named', { type: 'object', properties: { pattern: { type: 'string' } }, default: { pattern: 'x' } });
    expect(rec.version).toBe(1);
    expect((await validateEvent(t, 'named', { pattern: 'stripes' })).valid).toBe(true);
  });

  it('two tenants may register schemas with the same $id (M4)', async () => {
    const a = tenant(); const b = tenant();
    await registerEventSchema(a, 'ided', { $id: 'https://example.test/order', type: 'object' });
    await validateEvent(a, 'ided', {});
    expect((await registerEventSchema(b, 'ided', { $id: 'https://example.test/order', type: 'object', required: ['x'] })).version).toBe(1);
    expect((await validateEvent(b, 'ided', {})).valid).toBe(false);
  });

  it('the cached validator is per version: v2 refuses what v1 accepted, and v1 still answers when pinned', async () => {
    const t = tenant();
    await registerEventSchema(t, 'order', { type: 'object' });
    expect((await validateEvent(t, 'order', { total: 'x' })).valid).toBe(true);
    await registerEventSchema(t, 'order', { type: 'object', properties: { total: { type: 'number' } } });
    expect((await validateEvent(t, 'order', { total: 'x' })).valid).toBe(false);
    expect((await validateEvent(t, 'order', { total: 'x' }, 1)).valid).toBe(true);
  });
});

describe('D4.5 — an API-key reader gets masked collected and merge events', () => {
  it('masks the payload PII for a bearer key and leaves it clear for a session', async () => {
    await setToggle('consent', 'off');
    const owner = { cookie: await login(OWNER) };
    expect((await call(owner, 'POST', '/cdp/collect', { eventType: 'checkout', payload: { email: 'buyer@example.test', traits: { contact: 'nested@example.test' }, total: 3 } })).status).toBe(201);
    // A merge to read back (the merge-event masking is otherwise unexercised).
    const a = await call(owner, 'POST', '/crm/contacts', { name: 'Mia', email: 'mia@example.test' });
    const b = await call(owner, 'POST', '/crm/contacts', { name: 'Mia B', email: 'mia.b@example.test' });
    expect((await call(owner, 'POST', `/crm/contacts/${encodeURIComponent(String(a.body.contactId))}/merge`, { sourceContactId: b.body.contactId })).status).toBeLessThan(300);
    const key = await call(owner, 'POST', '/developer-keys', { name: 'ro', scopes: ['workspace:read'] });
    expect(key.status, JSON.stringify(key.body)).toBe(201);
    const viaKey = await call({ bearer: key.body.token as string }, 'GET', '/cdp/collected-events');
    expect(viaKey.status, JSON.stringify(viaKey.body)).toBe(200);
    expect(viaKey.body.masked).toBe(true);
    expect(JSON.stringify(viaKey.body.events)).not.toContain('buyer@example.test');
    expect(JSON.stringify(viaKey.body.events), 'nested values are masked by shape').not.toContain('nested@example.test');
    const merges = await call({ bearer: key.body.token as string }, 'GET', '/cdp/merge-events');
    expect(merges.body.masked).toBe(true);
    expect((merges.body.events as unknown[]).length).toBeGreaterThan(0);
    expect(JSON.stringify(merges.body.events)).not.toContain('mia.b@example.test');
    const viaSession = await call(owner, 'GET', '/cdp/collected-events');
    expect(JSON.stringify(viaSession.body.events)).toContain('buyer@example.test');
  });
});

describe('D4.6 — an email under any key is tagged, so the erasure barrier sees it', () => {
  it('tags `to` holding an address, and an erased address under it is refused', async () => {
    await setToggle('consent', 'off');
    const t = tenant();
    const r = await collectEvent(t, 'notify', { to: 'someone@example.test', note: 'x' });
    expect(r.piiFields).toContain('to');
    await writeErasureTombstone(t, 'gone@example.test');
    expect(await codeOf(collectEvent(t, 'notify', { to: 'gone@example.test' }))).toMatchObject({ code: 'subject_erased' });
  });
});
