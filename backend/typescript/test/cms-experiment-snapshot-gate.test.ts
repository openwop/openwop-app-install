/**
 * ADR 0593 §C3 (CMSA-11) — a page experiment may only bind a REVIEWED snapshot.
 *
 * The batch's class table wrote experiment variants off as "NOT a member — a
 * variant serves an immutable `PageVersion` snapshot, so its CONTENT is
 * frozen". That answers the wrong question: the snapshot is immutable, but
 * WHICH snapshot live traffic gets is chosen by experiment config, and
 * `snapshotPage` fires on SUBMIT as well as on publish (ADR 0206 B1). So a
 * version that was submitted and then REJECTED leaves a durable, addressable
 * row, and `startExperiment` checked neither the page status nor the gate.
 *
 * Two things this witness pins that the fix could easily have got wrong:
 *
 *   1. The report's prescribed cure ("restrict `versionId` to versions with a
 *      `publishedBy` stamp") is a NO-OP — every row has one. The real
 *      discriminator is the new `origin` field.
 *   2. `transitionPage` does NOT bump `page.version`, so an approve lands on
 *      exactly the row SUBMIT captured and `snapshotPage` dedupes it away. A
 *      capture-time-only stamp would therefore mark the canonical PUBLISHED
 *      snapshot `'submit'` and the gate would refuse the one version it must
 *      allow. The `origin` promotion is what prevents that, and the
 *      "binds the APPROVED version" test below is what proves it.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { assignWeightedVariant } from '../src/host/variantAssignment.js';
import * as cmsService from '../src/features/cms/cmsService.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'analytics']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault(id);
  expect(d, `${id} toggle must be declared`).toBeTruthy();
  if (d) await saveConfig({ ...d, status }, 'test');
};
const setGate = (status: 'on' | 'off'): Promise<void> => setToggle('cms-approval-gate', status);

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Res<T = any> { status: number; body: T }
interface Client {
  get: (p: string) => Promise<Res>;
  post: (p: string, b?: unknown) => Promise<Res>;
  patch: (p: string, b?: unknown) => Promise<Res>;
}
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}

let n = 0;
async function ownerOrg(): Promise<{ c: Client; orgId: string }> {
  const tenantId = `org:cmsa11-${Date.now()}-${n++}`;
  const c = client();
  const login = await c.post('/v1/host/openwop-app/test/login', { email: `cmsa11-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { c, orgId: org.body.orgId as string };
}
const cms = (orgId: string, s = ''): string => `/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${s}`;
const exps = (orgId: string, pageId: string, s = ''): string => cms(orgId, `/pages/${encodeURIComponent(pageId)}/experiments${s}`);

const REJECTED = 'REJECTED CONTENT';
const APPROVED = 'APPROVED CONTENT';

async function pendingFor(c: Client, pageId: string): Promise<any> {
  const list = await c.get('/v1/host/openwop-app/approvals?status=pending');
  expect(list.status).toBe(200);
  return (list.body.items as any[]).find((a) => a.kind === 'content-publish' && a.pageId === pageId);
}

/**
 * A gated org whose page has BOTH snapshot kinds:
 *   `rejected` — captured at submit, then refused by a reviewer;
 *   `approved` — captured at submit, then PROMOTED by the approve→publish.
 */
async function pageWithRejectedAndApprovedSnapshots(
  c: Client,
  orgId: string,
): Promise<{ pageId: string; slug: string; rejected: string; approved: string }> {
  await setGate('on');
  const created = await c.post(cms(orgId, '/pages'), { title: REJECTED, sections: [{ type: 'hero', data: { heading: REJECTED } }] });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const pageId = created.body.pageId as string;

  // Submit → a durable snapshot exists NOW, before any reviewer looks at it.
  expect((await c.post(cms(orgId, `/pages/${pageId}/submit`))).status).toBe(200);
  const first = await pendingFor(c, pageId);
  expect(first, 'submit must queue a content-publish approval').toBeTruthy();
  const rej = await c.post(`/v1/host/openwop-app/approvals/${first.approvalId}/reject`, { note: 'No.' });
  expect(rej.status, JSON.stringify(rej.body)).toBe(200);
  expect((await c.get(cms(orgId, `/pages/${pageId}`))).body.status).toBe('draft');

  // Rewrite + submit + APPROVE — the legitimate lane.
  const patched = await c.patch(cms(orgId, `/pages/${pageId}`), { title: APPROVED, sections: [{ type: 'hero', data: { heading: APPROVED } }] });
  expect(patched.status, JSON.stringify(patched.body)).toBe(200);
  expect((await c.post(cms(orgId, `/pages/${pageId}/submit`))).status).toBe(200);
  const second = await pendingFor(c, pageId);
  const claim = await c.post(`/v1/host/openwop-app/approvals/${second.approvalId}/claim`);
  expect(claim.status, JSON.stringify(claim.body)).toBe(200);
  const live = await c.get(cms(orgId, `/pages/${pageId}`));
  expect(live.body.status).toBe('published');

  const versions = await c.get(cms(orgId, `/pages/${pageId}/versions`));
  expect(versions.status).toBe(200);
  const rows = versions.body.versions as Array<{ versionId: string; origin?: string; snapshot: { title: string } }>;
  const rejected = rows.find((v) => v.snapshot.title === REJECTED);
  const approved = rows.find((v) => v.snapshot.title === APPROVED);
  expect(rejected, 'the REJECTED submit left a durable snapshot — that is the defect').toBeTruthy();
  expect(approved, 'the approved version must have a snapshot').toBeTruthy();

  // The stamps themselves, asserted directly. `approved` reads `'publish'` ONLY
  // because the publish arm PROMOTES the row submit captured — `transitionPage`
  // does not bump `page.version`, so `snapshotPage` deduped that write away.
  expect(rejected!.origin).toBe('submit');
  expect(approved!.origin).toBe('publish');

  return { pageId, slug: live.body.slug as string, rejected: rejected!.versionId, approved: approved!.versionId };
}

const twoWay = (name: string, versionId: string) => ({
  name,
  variants: [
    { key: 'control', versionId: null, weight: 50 },
    { key: 'candidate', versionId, weight: 50 },
  ],
});

describe('CMSA-11 — a variant cannot bind a snapshot that was never approved', () => {
  it('refuses at CREATE, names the exit, and still allows the APPROVED snapshot', async () => {
    const { c, orgId } = await ownerOrg();
    const { pageId, rejected, approved } = await pageWithRejectedAndApprovedSnapshots(c, orgId);

    const bad = await c.post(exps(orgId, pageId), twoWay('Rejected copy', rejected));
    expect(bad.status, JSON.stringify(bad.body)).toBe(409);
    const details = bad.body?.error?.details ?? bad.body?.details;
    expect(details.gate).toBe('cms-approval-gate');
    expect(details.reason).toBe('unreviewed_snapshot');
    expect(String(bad.body?.error?.message ?? bad.body?.message)).toMatch(/never approved/i);

    // THE control that a capture-time-only stamp would fail: the version the
    // reviewer actually approved is bindable. Without this the fix could refuse
    // every version on a gated org and this suite would still be green.
    const good = await c.post(exps(orgId, pageId), twoWay('Approved copy', approved));
    expect(good.status, JSON.stringify(good.body)).toBe(201);
  });

  it('refuses at START even when the experiment was created while the gate was OFF', async () => {
    // The CMSA-4 lesson: a decision taken from a toggle read in an EARLIER
    // request is not a decision. START is the moment content reaches traffic.
    const { c, orgId } = await ownerOrg();
    const { pageId, rejected } = await pageWithRejectedAndApprovedSnapshots(c, orgId);

    await setGate('off');
    const exp = await c.post(exps(orgId, pageId), twoWay('Late gate', rejected));
    expect(exp.status, JSON.stringify(exp.body)).toBe(201);

    await setGate('on');
    const start = await c.post(exps(orgId, pageId, `/${exp.body.experimentId}/start`));
    expect(start.status, JSON.stringify(start.body)).toBe(409);
    const details = start.body?.error?.details ?? start.body?.details;
    expect(details.reason).toBe('unreviewed_snapshot');
    expect((await c.get(exps(orgId, pageId, `/${exp.body.experimentId}`))).body.status).toBe('draft');
  });

  it('an UNIDENTIFIABLE snapshot (pre-field row) is ALLOWED — the refusal had no exit', async () => {
    // ADR 0593 §C8 (adversarial review F2). This test asserted the OPPOSITE
    // first, on the CMSA-7 rule ("a guard that cannot identify its subject must
    // refuse"). Building the exit falsified that here: CMSA-7's refusal REPINS
    // in the same call, so it can succeed on retry. This one cannot — making an
    // unstamped historic snapshot bindable means publishing it, publishing it
    // means `restoreVersion`, and `restoreVersion` BUMPS `page.version`, so the
    // publish mints a NEW row and the bound `versionId` stays unstamped
    // forever. And `updateExperiment` refuses a non-`draft` experiment, so a
    // STOPPED experiment could not be repointed at all — on the deploy that
    // adds this field EVERY row is unstamped, so every gated org's stopped
    // experiment would have become unrestartable.
    //
    // The residual is real and bounded: a pre-field snapshot can be bound even
    // if it was rejected. History is capped at 50 rows per page and every new
    // capture is stamped, so it ages out — which a permanent dead end does not.
    const { c, orgId } = await ownerOrg();
    const { pageId, approved } = await pageWithRejectedAndApprovedSnapshots(c, orgId);
    await setGate('off');
    const exp = await c.post(exps(orgId, pageId), twoWay('Legacy row', approved));
    expect(exp.status, JSON.stringify(exp.body)).toBe(201);
    await setGate('on');

    const real = cmsService.getVersion;
    const spy = vi.spyOn(cmsService, 'getVersion').mockImplementation(async (t, o, p, v) => {
      const row = await real(t, o, p, v);
      if (!row) return null;
      const stripped = { ...row };
      delete stripped.origin; // exactly a row written before the field existed
      return stripped;
    });
    try {
      const start = await c.post(exps(orgId, pageId, `/${exp.body.experimentId}/start`));
      expect(start.status, JSON.stringify(start.body)).toBe(200);
      // Non-vacuity: without the spy actually intercepting, this would be the
      // ordinary `origin:'publish'` pass and would prove nothing about absence.
      expect(spy, 'the spy must intercept the start-time version read').toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('a STOPPED experiment bound to an unreviewed snapshot is not a dead end it cannot leave', async () => {
    // The exit the refusal names must exist for the state the experiment is
    // actually in. `updateExperiment` is draft-only, so a STOPPED experiment
    // cannot be repointed — which is exactly why the unknown-origin arm above
    // had to go. Here the origin is POSITIVELY 'submit', so the refusal stands;
    // this pins that the escape (delete + recreate against a published
    // snapshot) is reachable rather than merely asserted in a comment.
    const { c, orgId } = await ownerOrg();
    const { pageId, rejected, approved } = await pageWithRejectedAndApprovedSnapshots(c, orgId);
    await setGate('off');
    const exp = await c.post(exps(orgId, pageId), twoWay('Stuck', rejected));
    expect((await c.post(exps(orgId, pageId, `/${exp.body.experimentId}/start`))).status).toBe(200);
    expect((await c.post(exps(orgId, pageId, `/${exp.body.experimentId}/stop`))).status).toBe(200);
    await setGate('on');

    // Refused (correctly — this snapshot really was rejected)…
    expect((await c.post(exps(orgId, pageId, `/${exp.body.experimentId}/start`))).status).toBe(409);
    // …and repointing is NOT available on a stopped experiment, which is the
    // fact that made an unknown-origin refusal unrecoverable.
    const repoint = await c.patch(exps(orgId, pageId, `/${exp.body.experimentId}`), { variants: twoWay('x', approved).variants });
    expect(repoint.status, JSON.stringify(repoint.body)).toBe(409);
    // The escape that does exist.
    const fresh = await c.post(exps(orgId, pageId), twoWay('Recreated', approved));
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(201);
    const freshStart = await c.post(exps(orgId, pageId, `/${fresh.body.experimentId}/start`));
    expect(freshStart.status, JSON.stringify(freshStart.body)).toBe(200);
  });
});

describe('CMSA-11 — the controls: what the rule must NOT refuse', () => {
  it('UNGATED positive control — with the gate OFF the rejected snapshot starts AND reaches a real visitor', async () => {
    // This is the Blocker itself, witnessed at the delivery boundary: without
    // it the refusals above could be a broken route rather than a gate, and the
    // defect would be unwitnessed.
    const { c, orgId } = await ownerOrg();
    const { pageId, slug, rejected } = await pageWithRejectedAndApprovedSnapshots(c, orgId);
    await setGate('off');
    const exp = await c.post(exps(orgId, pageId), twoWay('Ungated', rejected));
    expect(exp.status, JSON.stringify(exp.body)).toBe(201);
    const start = await c.post(exps(orgId, pageId, `/${exp.body.experimentId}/start`));
    expect(start.status, JSON.stringify(start.body)).toBe(200);

    // A visitor the shared bucketing puts on the rejected variant.
    let vk = '';
    for (let i = 0; i < 500 && !vk; i++) {
      const k = `vis-${i}`;
      if (assignWeightedVariant(k, start.body.experimentId, start.body.salt, start.body.variants) === 'candidate') vk = k;
    }
    expect(vk, 'a visitor key must map to the candidate variant').toBeTruthy();
    const res = await fetch(`${BASE}/v1/host/openwop-app/public/${encodeURIComponent(orgId)}/pages/${encodeURIComponent(slug)}?vk=${vk}`);
    const body = await res.json() as any;
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.title).toBe(REJECTED); // content a reviewer refused, live to the public
    expect(body.experiment?.variant).toBe('candidate');
  });

  it('the HOLDOUT variant is never refused — it binds no snapshot at all', async () => {
    const { c, orgId } = await ownerOrg();
    const { pageId } = await pageWithRejectedAndApprovedSnapshots(c, orgId);
    const exp = await c.post(exps(orgId, pageId), {
      name: 'Holdout only',
      variants: [
        { key: 'control', versionId: null, weight: 50 },
        { key: 'other', versionId: null, weight: 50 },
      ],
    });
    expect(exp.status, JSON.stringify(exp.body)).toBe(201);
    const start = await c.post(exps(orgId, pageId, `/${exp.body.experimentId}/start`));
    expect(start.status, JSON.stringify(start.body)).toBe(200);
  });

  it('a PUBLISHED page is still experimentable under the gate — the page status is NOT gated', async () => {
    // Experiments only run on published pages, so refusing on `published` would
    // disable the whole feature for gated orgs: the gate-with-no-exit shape.
    const { c, orgId } = await ownerOrg();
    const { pageId, approved } = await pageWithRejectedAndApprovedSnapshots(c, orgId);
    expect((await c.get(cms(orgId, `/pages/${pageId}`))).body.status).toBe('published');
    const exp = await c.post(exps(orgId, pageId), twoWay('Live page', approved));
    expect(exp.status, JSON.stringify(exp.body)).toBe(201);
    const start = await c.post(exps(orgId, pageId, `/${exp.body.experimentId}/start`));
    expect(start.status, JSON.stringify(start.body)).toBe(200);
  });
});
