/**
 * ADR 0948 P4a (D4) — webinar and application funnel steps.
 *
 *  - Bindings: a webinar step binds a SAME-ORG webinar; an application step a SAME-ORG
 *    form; a binding on the wrong kind, or another org's record, is refused.
 *  - An editor save that omits a binding keeps it (the carry rule); the publish digest
 *    covers the bindings; publish needs the webinar's registration form.
 *  - The public `next` refuses a client-supplied outcome on these kinds
 *    (`outcome_server_derived`) and derives it: after the event, the visitor's own
 *    registration (this funnel + step, a contact) plus the CRM attendance activity →
 *    `accepted`; no attendance → `declined`; before the event, or a registration from
 *    elsewhere → no outcome (sequential).
 *  - The step-kind list is the same everywhere the model or the UI reads it (parity).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPlanningApp, makeClient, enableToggle, uniqEmail, type Client } from './planningHarness.js';
import { createPage, transitionPage } from '../src/features/cms/cmsService.js';
import { createFunnel, updateFunnel, getFunnel, publishFunnel, funnelPublishDigest, FUNNEL_STEP_KINDS } from '../src/features/funnels/funnelsService.js';
import { upsertMarketingEvent } from '../src/features/webinars/entities/marketingEvent.js';
import { createForm, recordSubmission } from '../src/features/forms/formsService.js';
import { createActivity } from '../src/features/crm/entities/activities.js';
import { makeLinkValidators } from '../src/features/crm/entities/tasks.js';

let BASE = '';
let close: () => Promise<void>;
let n = 0;
const H = '/host/openwop-app';
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

beforeAll(async () => {
  const h = await bootPlanningApp(); BASE = h.base; close = h.close;
  for (const id of ['users', 'funnels', 'cms', 'forms', 'crm', 'webinars']) await enableToggle(id, 'on');
});
afterAll(async () => { await close(); });

async function world() {
  const tenantId = `org:p4a-${Date.now()}-${n++}`;
  const c: Client = makeClient(() => BASE);
  const ownerId = (await c.post(`${H}/test/login`, { email: uniqEmail('p4a'), tenantId })).body.user.userId as string;
  const orgA = (await c.post(`${H}/orgs`, { name: 'A' })).body.orgId as string;
  const orgB = (await c.post(`${H}/orgs`, { name: 'B' })).body.orgId as string;
  const page = async (title: string) => {
    const p = await createPage({ tenantId, orgId: orgA, title, createdBy: 'seed' });
    await transitionPage(tenantId, orgA, p.pageId, 'publish', 'seed');
    return p.pageId;
  };
  const form = await createForm({ tenantId, orgId: orgA, title: 'Register', createdBy: ownerId, createToContact: true,
    fields: [{ key: 'email', label: 'Email', type: 'email', required: true }] });
  const formB = await createForm({ tenantId, orgId: orgB, title: 'Other', createdBy: ownerId, fields: [{ key: 'email', label: 'Email', type: 'email', required: true }] });
  const pastEvent = await upsertMarketingEvent({ tenantId, orgId: orgA, provider: 'zoom', providerEventId: `zp-${n}`, title: 'Live class', startsAt: new Date(Date.now() - 3600_000).toISOString(), formId: form.formId });
  const futureEvent = await upsertMarketingEvent({ tenantId, orgId: orgA, provider: 'zoom', providerEventId: `zf-${n}`, title: 'Next class', startsAt: new Date(Date.now() + 86_400_000).toISOString(), formId: form.formId });
  const eventB = await upsertMarketingEvent({ tenantId, orgId: orgB, provider: 'zoom', providerEventId: `zb-${n}`, title: 'B class', formId: formB.formId });
  return { tenantId, c, ownerId, orgA, orgB, page, form, formB, pastEvent, futureEvent, eventB };
}

describe('ADR 0948 P4a — bindings', () => {
  it('same-org bindings only, on their own kind; an omitted binding is kept; the digest covers it; publish needs it', async () => {
    const w = await world();
    const p1 = await w.page('Register'); const p2 = await w.page('Apply');
    const steps = [
      { stepId: 'w', kind: 'webinar', pageId: p1, webinar: { marketingEventId: w.pastEvent.eventId } },
      { stepId: 'a', kind: 'application', pageId: p2, application: { formId: w.form.formId } },
    ];
    const f = await createFunnel({ tenantId: w.tenantId, orgId: w.orgA, createdBy: 'u', name: `Webinar ${n}`, steps });
    expect(f.steps.map((s) => [s.kind, s.webinar?.marketingEventId ?? s.application?.formId])).toEqual([['webinar', w.pastEvent.eventId], ['application', w.form.formId]]);

    await expect(createFunnel({ tenantId: w.tenantId, orgId: w.orgA, createdBy: 'u', name: 'x1', steps: [{ kind: 'webinar', pageId: p1, webinar: { marketingEventId: w.eventB.eventId } }] })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(createFunnel({ tenantId: w.tenantId, orgId: w.orgA, createdBy: 'u', name: 'x2', steps: [{ kind: 'application', pageId: p2, application: { formId: w.formB.formId } }] })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(createFunnel({ tenantId: w.tenantId, orgId: w.orgA, createdBy: 'u', name: 'x3', steps: [{ kind: 'landing', pageId: p1, webinar: { marketingEventId: w.pastEvent.eventId } }] })).rejects.toMatchObject({ httpStatus: 400 });
    await expect(createFunnel({ tenantId: w.tenantId, orgId: w.orgA, createdBy: 'u', name: 'x4', steps: [{ kind: 'webinar', pageId: p1, offer: { productIds: ['p'] } }] })).rejects.toMatchObject({ httpStatus: 400 });

    // An editor that does not know the field re-submits without it: kept.
    const digest0 = funnelPublishDigest(f);
    await updateFunnel(w.tenantId, w.orgA, f.funnelId, { steps: steps.map(({ webinar: _w, application: _a, ...rest }) => rest) });
    const kept = (await getFunnel(w.tenantId, w.orgA, f.funnelId))!;
    expect(kept.steps[0]!.webinar?.marketingEventId).toBe(w.pastEvent.eventId);
    expect(kept.steps[1]!.application?.formId).toBe(w.form.formId);
    // The digest covers the bindings (an approval pins them).
    await updateFunnel(w.tenantId, w.orgA, f.funnelId, { steps: [{ ...steps[0], webinar: { marketingEventId: w.futureEvent.eventId } }, steps[1]] });
    expect(funnelPublishDigest((await getFunnel(w.tenantId, w.orgA, f.funnelId))!)).not.toBe(digest0);

    // Publish refuses a webinar step with no webinar.
    const bare = await createFunnel({ tenantId: w.tenantId, orgId: w.orgA, createdBy: 'u', name: `Bare ${n}`, steps: [{ kind: 'webinar', pageId: p1 }] });
    await expect(publishFunnel(w.tenantId, w.orgA, bare.funnelId)).rejects.toMatchObject({ httpStatus: 400 });
  });
});

describe('ADR 0948 P4a — the server decides a webinar step\'s outcome', () => {
  async function liveFunnel(w: Awaited<ReturnType<typeof world>>, eventId: string) {
    const reg = await w.page(`Register ${n}`); const replay = await w.page(`Replay ${n}`); const missed = await w.page(`Missed ${n}`);
    const f = await createFunnel({ tenantId: w.tenantId, orgId: w.orgA, createdBy: 'u', name: `Live ${n++}`, steps: [
      { stepId: 'reg', kind: 'webinar', pageId: reg, webinar: { marketingEventId: eventId },
        routing: [{ when: { outcome: 'accepted' }, goto: 'attended' }, { when: { outcome: 'declined' }, goto: 'missed' }] },
      { stepId: 'next', kind: 'landing', pageId: reg },
      { stepId: 'attended', kind: 'sales', pageId: replay },
      { stepId: 'missed', kind: 'thankyou', pageId: missed },
    ] });
    await publishFunnel(w.tenantId, w.orgA, f.funnelId);
    return f;
  }
  const next = (w: Awaited<ReturnType<typeof world>>, slug: string, q: Record<string, string>) =>
    w.c.get(`${H}/public/${encodeURIComponent(w.orgA)}/funnels/${encodeURIComponent(slug)}/next?${new URLSearchParams(q).toString()}`);
  async function register(w: Awaited<ReturnType<typeof world>>, funnelId: string, stepId: string): Promise<{ submissionId: string; contactId?: string }> {
    const sub = await recordSubmission(w.form, { email: uniqEmail('visitor') }, { context: { funnelId, stepId } });
    // The CRM sink stamps the contact asynchronously-but-awaited inside recordSubmission.
    const { getSubmission } = await import('../src/features/forms/formsService.js');
    const stored = await getSubmission(w.tenantId, w.orgA, w.form.formId, sub.submissionId);
    return { submissionId: sub.submissionId, ...(stored?.contactId ? { contactId: stored.contactId } : {}) };
  }

  it('a visitor cannot pick the outcome; attended → accepted branch; no attendance → declined branch', async () => {
    const w = await world();
    const f = await liveFunnel(w, w.pastEvent.eventId);
    const forged = await next(w, f.slug, { from: 'reg', outcome: 'accepted' });
    expect(forged.status).toBe(400);
    expect(JSON.stringify(forged.body)).toContain('outcome_server_derived');

    const attendee = await register(w, f.funnelId, 'reg');
    expect(attendee.contactId, 'non-vacuity: the registration names a contact').toBeTruthy();
    await createActivity({ tenantId: w.tenantId, orgId: w.orgA, kind: 'webinar', body: 'Attended', contactId: attendee.contactId!, createdBy: 'test',
      activityId: `act:webinar:${w.pastEvent.providerEventId}:${attendee.contactId}:attended`, validators: makeLinkValidators(w.tenantId, w.orgA) });
    const a = await next(w, f.slug, { from: 'reg', submission: attendee.submissionId });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.step?.stepId).toBe('attended');

    const noShow = await register(w, f.funnelId, 'reg');
    const d = await next(w, f.slug, { from: 'reg', submission: noShow.submissionId });
    expect(d.body.step?.stepId).toBe('missed');

    // A registration from another funnel/step, or none: no outcome, sequential.
    const elsewhere = await register(w, 'some-other-funnel', 'reg');
    expect((await next(w, f.slug, { from: 'reg', submission: elsewhere.submissionId })).body.step?.stepId).toBe('next');
    expect((await next(w, f.slug, { from: 'reg' })).body.step?.stepId).toBe('next');
  });

  it('before the event starts there is no outcome yet (the registration visit continues in order)', async () => {
    const w = await world();
    const f = await liveFunnel(w, w.futureEvent.eventId);
    const r = await register(w, f.funnelId, 'reg');
    expect((await next(w, f.slug, { from: 'reg', submission: r.submissionId })).body.step?.stepId).toBe('next');
  });
});

describe('ADR 0948 P4a — one step-kind list everywhere', () => {
  it('the frontend mirror, the four locales and the agent tool text all carry every kind', async () => {
    const fe = readFileSync(join(REPO, 'frontend/react/src/features/funnels/funnelsClient.ts'), 'utf8');
    const m = /export const FUNNEL_STEP_KINDS = \[([^\]]*)\]/.exec(fe);
    expect(m, 'the FE mirror exists').toBeTruthy();
    expect(m![1]!.split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean)).toEqual([...FUNNEL_STEP_KINDS]);
    for (const loc of ['en', 'es', 'fr', 'pt-BR']) {
      const cat = readFileSync(join(REPO, `frontend/react/src/features/funnels/i18n/${loc}.ts`), 'utf8');
      for (const k of FUNNEL_STEP_KINDS) expect(cat, `${loc} kind_${k}`).toContain(`kind_${k}:`);
    }
    const tools = readFileSync(join(REPO, 'backend/typescript/src/features/funnels/agentTools.ts'), 'utf8');
    expect(tools, 'the draft tool text is generated from the SSoT').toContain("FUNNEL_STEP_KINDS.join('|')");
  });
});
