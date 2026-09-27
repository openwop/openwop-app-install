/**
 * ADR 0332 — funnel opt-in capture over the ADR 0330 sink seam, route-level:
 *  - a public form submit carrying `context: { funnelId, stepId, visitor }`
 *    lands a `funnel.step_completed` CDP event stamped `source: 'form-submit'`
 *    and persists the bounded context on the submission;
 *  - context is OPAQUE public input: unknown funnel ids are inert (submission
 *    still captured, no event), oversized/overflowing context entries drop;
 *  - the public funnel step payload exposes the ready-made `formContext`.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { collectEvent, listCollectedEvents } from '../src/features/cdp/collectService.js';
import { recordConsent } from '../src/features/consent/consentService.js';
import { rebuildFunnelStats, getFunnelStats } from '../src/features/funnels/funnelStats.js';

let BASE: string; let server: http.Server; let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'forms', 'funnels', 'cdp']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b) };
}
const anon = client;

async function fixture(): Promise<{ user: ReturnType<typeof client>; orgId: string; tenantId: string; funnelId: string; stepId: string; formId: string; slug: string }> {
  const user = client();
  const login = await user.post('/v1/host/openwop-app/test/login', { email: `ffa-${Date.now()}-${n++}@acme.test` });
  const tenantId = login.body.user?.tenantId ?? '';
  const org = await user.post('/v1/host/openwop-app/orgs', { name: 'Attribution Co' });
  const orgId: string = org.body.orgId;
  const page = await user.post(`/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages`, { title: 'Opt-in' });
  await user.post(`/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages/${page.body.pageId}/publish`);
  const funnel = await user.post(`/v1/host/openwop-app/funnels/orgs/${encodeURIComponent(orgId)}/funnels`, {
    name: 'Launch', slug: `launch-${n}`, steps: [{ kind: 'optin', pageId: page.body.pageId }],
  });
  expect(funnel.status, JSON.stringify(funnel.body)).toBe(201);
  const publish = await user.post(`/v1/host/openwop-app/funnels/orgs/${encodeURIComponent(orgId)}/funnels/${funnel.body.funnel.funnelId}/publish`);
  expect(publish.status, JSON.stringify(publish.body)).toBe(200);
  const stepId: string = funnel.body.funnel.steps[0].stepId;
  const form = await user.post(`/v1/host/openwop-app/forms/orgs/${encodeURIComponent(orgId)}/forms`, {
    title: 'Opt-in form', fields: [{ key: 'email', label: 'Email', type: 'email', required: true }],
  });
  await user.patch(`/v1/host/openwop-app/forms/orgs/${encodeURIComponent(orgId)}/forms/${form.body.formId}/status`, { status: 'published' });
  return { user, orgId, tenantId, funnelId: funnel.body.funnel.funnelId, stepId, formId: form.body.formId, slug: funnel.body.funnel.slug };
}

describe('ADR 0332 — funnel opt-in attribution', () => {
  it('a context-stamped public submit emits funnel.step_completed (source form-submit) and persists bounded context', async () => {
    const { user, orgId, tenantId, funnelId, stepId, formId } = await fixture();
    const sub = await anon().post(`/v1/host/openwop-app/public-forms/${encodeURIComponent(formId)}/submit`, {
      values: { email: 'lead@x.com' },
      context: { funnelId, stepId, visitor: 'vk-attr-1' },
    });
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);

    const events = (await listCollectedEvents(tenantId)).filter((e) => e.eventType === 'funnel.step_completed');
    const hit = events.find((e) => (e.payload as { source?: string }).source === 'form-submit');
    expect(hit, JSON.stringify(events)).toBeTruthy();
    const pl = hit!.payload as { funnelId: string; stepId: string; stepKind: string; visitor: string };
    expect(pl.funnelId).toBe(funnelId);
    expect(pl.stepId).toBe(stepId);
    expect(pl.stepKind).toBe('optin');
    expect(pl.visitor).toBe('vk-attr-1');

    const subs = await user.get(`/v1/host/openwop-app/forms/orgs/${encodeURIComponent(orgId)}/forms/${encodeURIComponent(formId)}/submissions`);
    expect(subs.body.submissions[0].meta.context).toEqual({ funnelId, stepId, visitor: 'vk-attr-1' });
  });

  it('unknown funnel context is inert: submission captured, no event; oversized context entries drop', async () => {
    const { user, orgId, tenantId, formId } = await fixture();
    const bigVal = 'x'.repeat(300);
    const overflow = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, 'v']));
    const sub = await anon().post(`/v1/host/openwop-app/public-forms/${encodeURIComponent(formId)}/submit`, {
      values: { email: 'lead2@x.com' },
      context: { funnelId: 'funnel:nope', stepId: 'step:nope', big: bigVal, ...overflow },
    });
    expect(sub.status).toBe(201);

    const events = (await listCollectedEvents(tenantId)).filter(
      (e) => e.eventType === 'funnel.step_completed' && (e.payload as { source?: string }).source === 'form-submit',
    );
    expect(events).toHaveLength(0);

    const subs = await user.get(`/v1/host/openwop-app/forms/orgs/${encodeURIComponent(orgId)}/forms/${encodeURIComponent(formId)}/submissions`);
    const ctx = subs.body.submissions[0].meta.context as Record<string, string>;
    expect(ctx.big).toBeUndefined(); // oversized value dropped
    expect(Object.keys(ctx).length).toBeLessThanOrEqual(8); // entry cap
  });

  it('the public funnel step payload exposes the ready-made formContext', async () => {
    const { orgId, funnelId, stepId, slug } = await fixture();
    const entry = await anon().get(`/v1/host/openwop-app/public/${encodeURIComponent(orgId)}/funnels/${encodeURIComponent(slug)}`);
    expect(entry.status, JSON.stringify(entry.body)).toBe(200);
    expect(entry.body.step.formContext).toEqual({ funnelId, stepId });
  });

  // GC-FRM-1 — the sink runs the context visitor through the SAME server-side
  // consent gate `/next` uses: with the consent regime active and no record,
  // a context-supplied vk must NOT enter analytics (empty visitor; the
  // completion still counts); a recorded analytics consent lets it through.
  it('consent gates the context visitor exactly like /next (deny without a record, allow with one)', async () => {
    const { tenantId, funnelId, stepId, formId } = await fixture();
    const consentDefault = getToggleDefault('consent');
    expect(consentDefault).toBeTruthy();
    await saveConfig({ ...consentDefault!, status: 'on' }, 'test');
    try {
      const denied = await anon().post(`/v1/host/openwop-app/public-forms/${encodeURIComponent(formId)}/submit`, {
        values: { email: 'gated@x.com' },
        context: { funnelId, stepId, visitor: 'vk-unconsented' },
      });
      expect(denied.status, JSON.stringify(denied.body)).toBe(201);
      let events = (await listCollectedEvents(tenantId)).filter(
        (e) => e.eventType === 'funnel.step_completed' && (e.payload as { source?: string }).source === 'form-submit',
      );
      expect(events).toHaveLength(1); // completion still counts…
      expect((events[0]!.payload as { visitor: string }).visitor).toBe(''); // …but the vk never lands

      await recordConsent({ tenantId, subjectKey: 'vk-consented', categories: { analytics: true }, source: 'test' });
      const allowed = await anon().post(`/v1/host/openwop-app/public-forms/${encodeURIComponent(formId)}/submit`, {
        values: { email: 'ok@x.com' },
        context: { funnelId, stepId, visitor: 'vk-consented' },
      });
      expect(allowed.status).toBe(201);
      events = (await listCollectedEvents(tenantId)).filter(
        (e) => e.eventType === 'funnel.step_completed' && (e.payload as { source?: string }).source === 'form-submit',
      );
      expect(events.map((e) => (e.payload as { visitor: string }).visitor).sort()).toEqual(['', 'vk-consented']);
    } finally {
      await saveConfig({ ...consentDefault!, status: 'off' }, 'test'); // restore the suite's permissive posture
    }
  });

  // GC-FRM-5 — the REAL cross-tenant context test: a submission whose context
  // names ANOTHER tenant's real, published funnel must stay inert (the sink
  // resolves the funnel with the SUBMISSION's tenant, never the context's).
  it('a context naming another tenant\'s real funnel emits nothing', async () => {
    const victim = await fixture();   // owns a real funnel
    const attacker = await fixture(); // its form, its tenant
    const sub = await anon().post(`/v1/host/openwop-app/public-forms/${encodeURIComponent(attacker.formId)}/submit`, {
      values: { email: 'x@x.com' },
      context: { funnelId: victim.funnelId, stepId: victim.stepId, visitor: 'vk-cross' },
    });
    expect(sub.status).toBe(201);
    const victimEvents = (await listCollectedEvents(victim.tenantId)).filter(
      (e) => e.eventType === 'funnel.step_completed' && (e.payload as { source?: string }).source === 'form-submit',
    );
    const attackerEvents = (await listCollectedEvents(attacker.tenantId)).filter(
      (e) => e.eventType === 'funnel.step_completed' && (e.payload as { source?: string }).source === 'form-submit',
    );
    expect(victimEvents).toHaveLength(0);   // never lands in the victim's analytics
    expect(attackerEvents).toHaveLength(0); // and resolves to no funnel in the attacker's tenant
  });

  // GC-FRM-5, ADJUDICATED in round 2 (UX_UPGRADE-funnels VP-R2-1): funnel step
  // COMPLETIONS are a visitor-flow metric — one visitor completing a step
  // counts ONCE per day, however many submissions they made — because the
  // drop-off math pairs it with distinct-visitor VIEWS (event-counted
  // completions against visitor-counted views could exceed 100%). Two
  // submissions are still two LEADS in the forms inbox; the old
  // per-submission-only pin was double-counting the sink+/next pair too.
  it('two distinct submissions by ONE visitor count as ONE step completion (distinct-visitor semantics)', async () => {
    const { tenantId, orgId, funnelId, stepId, formId } = await fixture();
    for (const email of ['a@x.com', 'b@x.com']) {
      const r = await anon().post(`/v1/host/openwop-app/public-forms/${encodeURIComponent(formId)}/submit`, {
        values: { email }, context: { funnelId, stepId, visitor: 'vk-twice' },
      });
      expect(r.status).toBe(201);
    }
    const { rebuildFunnelStats: rebuild, getFunnelStats: getStats } = await import('../src/features/funnels/funnelStats.js');
    await rebuild(tenantId, orgId);
    const days = await getStats(tenantId, orgId, funnelId);
    const total = days.reduce((acc, d) => acc + (d.steps[stepId]?.completions ?? 0), 0);
    expect(total).toBe(1);
  });

  // GC-FRM-2 — attribution idempotency: the event carries the submissionId,
  // and the day-stats rollup counts each submission exactly ONCE however
  // often its event lands in the window (the GC-D1-1 discipline).
  it('form-submit completions carry submissionId and the day-stats rollup dedupes on it', async () => {
    const { tenantId, orgId, funnelId, stepId, formId } = await fixture();
    const sub = await anon().post(`/v1/host/openwop-app/public-forms/${encodeURIComponent(formId)}/submit`, {
      values: { email: 'once@x.com' },
      context: { funnelId, stepId, visitor: 'vk-idem' },
    });
    expect(sub.status).toBe(201);
    const hit = (await listCollectedEvents(tenantId)).find(
      (e) => e.eventType === 'funnel.step_completed' && (e.payload as { source?: string }).source === 'form-submit',
    );
    expect(hit).toBeTruthy();
    const pl = hit!.payload as { submissionId?: string };
    expect(typeof pl.submissionId).toBe('string');
    expect(pl.submissionId!.startsWith('sub:')).toBe(true);

    // A duplicate emission of the SAME submission (re-run / retry class) must
    // not double-count: land a copy of the event, rebuild, expect 1 completion.
    await collectEvent(tenantId, 'funnel.step_completed', { ...(hit!.payload as Record<string, unknown>) });
    await rebuildFunnelStats(tenantId, orgId);
    const days = await getFunnelStats(tenantId, orgId, funnelId);
    const total = days.reduce((acc, d) => acc + (d.steps[stepId]?.completions ?? 0), 0);
    expect(total).toBe(1);
  });
});
