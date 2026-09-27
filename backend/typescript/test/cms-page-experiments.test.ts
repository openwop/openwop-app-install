/**
 * CMS page experiments (ADR 0236 — campaign gap D1) — ROUTE + service harness.
 * Covers: the extracted shared bucketing helper (sticky determinism + rough
 * distribution + byte-identity with the toggle engine's assignVariant),
 * experiment validation (weights sum to 100, one-running-per-page, versions
 * must exist), the consent-gated public assignment seam (no vk ⇒ byte-identical
 * response; vk+consent ⇒ variant snapshot + additive stamp; holdout ⇒ published
 * content, still stamped), promote-winner via the EXISTING CMS verbs (restore →
 * publish, or restore → submit + honest `pendingApproval` under the approval
 * gate), the two-proportion results projection (incl. `insufficientSample`
 * honesty), and `cms.experiment.*` audit rows with payload.tenantId.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';
import { hasPendingApprovalForPage } from '../src/host/approvalService.js';
import { assignWeightedVariant, bucketOf } from '../src/host/variantAssignment.js';
import { assignVariant } from '../src/host/featureToggles/bucketing.js';
import { twoProportionZ, findRunningExperiment, assignVariantForVisitor } from '../src/features/cms/pageExperimentsService.js';
import { recordEvent, listEvents, __putRawEventForTests } from '../src/features/analytics/analyticsService.js';

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

async function setToggle(id: string, status: 'on' | 'off'): Promise<void> {
  const d = getToggleDefault(id);
  expect(d, `${id} toggle must be declared`).toBeTruthy();
  if (d) await saveConfig({ ...d, status }, 'test');
}

interface Res<T = any> { status: number; body: T }
interface Client {
  get: (p: string) => Promise<Res>;
  post: (p: string, b?: unknown) => Promise<Res>;
  patch: (p: string, b?: unknown) => Promise<Res>;
  del: (p: string) => Promise<Res>;
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
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}

let n = 0;
async function ownerOrg(): Promise<{ owner: Client; orgId: string; tenantId: string }> {
  const tenantId = `org:px-${Date.now()}-${n++}`;
  const owner = client();
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: `px-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId };
}

const cms = (orgId: string, s = ''): string => `/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${s}`;
const exps = (orgId: string, pageId: string, s = ''): string => cms(orgId, `/pages/${encodeURIComponent(pageId)}/experiments${s}`);
const pub = (orgId: string, s: string): string => `/v1/host/openwop-app/public/${encodeURIComponent(orgId)}${s}`;

/**
 * A page with TWO published snapshots: version 1 ("V1 Title") then the live
 * version 2 ("V2 Title"). Returns the OLD snapshot's versionId — the variant
 * content an experiment serves against the live published page.
 */
async function pageWithHistory(owner: Client, orgId: string): Promise<{ pageId: string; slug: string; v1: string }> {
  const created = await owner.post(cms(orgId, '/pages'), { title: 'V1 Title', sections: [{ type: 'hero', data: { heading: 'Version One Heading' } }] });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const pageId = created.body.pageId as string;
  expect((await owner.post(cms(orgId, `/pages/${pageId}/publish`))).status).toBe(200); // snapshot v1
  expect((await owner.post(cms(orgId, `/pages/${pageId}/unpublish`))).status).toBe(200);
  const patched = await owner.patch(cms(orgId, `/pages/${pageId}`), { title: 'V2 Title', sections: [{ type: 'hero', data: { heading: 'Version Two Heading' } }] });
  expect(patched.status, JSON.stringify(patched.body)).toBe(200);
  const pub2 = await owner.post(cms(orgId, `/pages/${pageId}/publish`));
  expect(pub2.status, JSON.stringify(pub2.body)).toBe(200);
  const versions = await owner.get(cms(orgId, `/pages/${pageId}/versions`));
  expect(versions.status).toBe(200);
  const v1 = (versions.body.versions as Array<{ versionId: string; snapshot: { title: string } }>).find((v) => v.snapshot.title === 'V1 Title');
  expect(v1, 'the v1 snapshot must exist').toBeTruthy();
  return { pageId, slug: pub2.body.slug as string, v1: v1!.versionId };
}

/** 50/50 holdout-vs-snapshot experiment (control = holdout, legacy = v1). */
const fiftyFifty = (v1: string) => ({
  name: 'Hero copy test',
  variants: [
    { key: 'control', versionId: null, weight: 50 },
    { key: 'legacy', versionId: v1, weight: 50 },
  ],
});

/** A visitor key the shared bucketing maps to `wanted` for this experiment. */
function visitorFor(exp: { experimentId: string; salt: string; variants: Array<{ key: string; weight: number }> }, wanted: string): string {
  for (let i = 0; i < 500; i++) {
    const vk = `vis-${wanted}-${i}`;
    if (assignWeightedVariant(vk, exp.experimentId, exp.salt, exp.variants) === wanted) return vk;
  }
  throw new Error(`no visitor key found for variant ${wanted}`);
}

const storage = () => {
  const s = __hostExtStorage();
  expect(s, 'host-ext storage must be wired').toBeTruthy();
  return s!;
};

// ─── the extracted shared helper ─────────────────────────────────────────────

describe('variantAssignment — the extracted shared bucketing helper', () => {
  const variants = [{ key: 'A', weight: 50 }, { key: 'B', weight: 50 }];

  it('is sticky/deterministic for the same (unit, scope, salt, weights)', () => {
    const first = assignWeightedVariant('vis-1', 'pexp:x', 's1', variants);
    for (let i = 0; i < 25; i++) expect(assignWeightedVariant('vis-1', 'pexp:x', 's1', variants)).toBe(first);
    expect(bucketOf('vis-1', 'pexp:x', 's1')).toBe(bucketOf('vis-1', 'pexp:x', 's1'));
  });

  it('roughly honors 50/50 weights over many visitors', () => {
    let a = 0;
    const total = 2000;
    for (let i = 0; i < total; i++) if (assignWeightedVariant(`vis-${i}`, 'pexp:dist', 'salt', variants) === 'A') a++;
    expect(a / total).toBeGreaterThan(0.4);
    expect(a / total).toBeLessThan(0.6);
  });

  it('is byte-identical to the toggle engine assignVariant (extraction, not a fork)', () => {
    for (let i = 0; i < 200; i++) {
      const unit = `unit-${i}`;
      expect(assignWeightedVariant(unit, 'demo.experiment', 's1', variants)).toBe(assignVariant(unit, 'demo.experiment', 's1', variants));
    }
  });
});

describe('twoProportionZ — pure math', () => {
  it('matches the pooled two-proportion z for a known case', () => {
    // 8/40 (20%) vs 20/40 (50%): pooled 0.35 ⇒ z ≈ 2.8130
    expect(twoProportionZ(8, 40, 20, 40)!).toBeCloseTo(2.813, 2);
  });
  it('is null on empty samples and zero pooled variance', () => {
    expect(twoProportionZ(0, 0, 5, 10)).toBeNull();
    expect(twoProportionZ(0, 10, 0, 10)).toBeNull(); // both rates 0 — no variance
    expect(twoProportionZ(10, 10, 10, 10)).toBeNull(); // both rates 1
  });
});

// ─── validation + lifecycle ──────────────────────────────────────────────────

describe('experiments — validation', () => {
  it('rejects weights that do not sum to 100, <2 variants, duplicate keys, and unknown versions', async () => {
    const { owner, orgId } = await ownerOrg();
    const { pageId, v1 } = await pageWithHistory(owner, orgId);
    const post = (variants: unknown) => owner.post(exps(orgId, pageId), { name: 'X', variants });

    expect((await post([{ key: 'a', versionId: null, weight: 50 }, { key: 'b', versionId: v1, weight: 40 }])).status).toBe(400);
    expect((await post([{ key: 'only', versionId: null, weight: 100 }])).status).toBe(400);
    expect((await post([{ key: 'dup', versionId: null, weight: 50 }, { key: 'dup', versionId: v1, weight: 50 }])).status).toBe(400);
    expect((await post([{ key: 'a', versionId: null, weight: 50 }, { key: 'b', versionId: 'pver:nope', weight: 50 }])).status).toBe(400);
    expect((await post([{ key: 'a', versionId: null, weight: 50.5 }, { key: 'b', versionId: v1, weight: 49.5 }])).status).toBe(400);

    const ok = await post(fiftyFifty(v1).variants);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.status).toBe('draft');
    expect(typeof ok.body.salt).toBe('string');
    expect((await owner.get(exps(orgId, pageId))).body.experiments).toHaveLength(1);
  });

  it('enforces ONE running experiment per page; running experiments are immutable', async () => {
    const { owner, orgId } = await ownerOrg();
    const { pageId, v1 } = await pageWithHistory(owner, orgId);
    const e1 = (await owner.post(exps(orgId, pageId), fiftyFifty(v1))).body;
    const e2 = (await owner.post(exps(orgId, pageId), { ...fiftyFifty(v1), name: 'Second' })).body;

    expect((await owner.post(exps(orgId, pageId, `/${e1.experimentId}/start`))).status).toBe(200);
    expect((await owner.post(exps(orgId, pageId, `/${e2.experimentId}/start`))).status).toBe(409);
    // running ⇒ no edits, no delete
    expect((await owner.patch(exps(orgId, pageId, `/${e1.experimentId}`), { name: 'renamed' })).status).toBe(409);
    expect((await owner.del(exps(orgId, pageId, `/${e1.experimentId}`))).status).toBe(409);
    // stop the first ⇒ the second can start
    expect((await owner.post(exps(orgId, pageId, `/${e1.experimentId}/stop`))).status).toBe(200);
    expect((await owner.post(exps(orgId, pageId, `/${e2.experimentId}/start`))).status).toBe(200);
  });
});

// ─── the public assignment seam ──────────────────────────────────────────────

describe('public page read — consent-gated assignment seam', () => {
  it('no vk ⇒ byte-identical response (no experiment exposure)', async () => {
    const { owner, orgId } = await ownerOrg();
    const { pageId, slug, v1 } = await pageWithHistory(owner, orgId);
    const anon = client();
    const before = await anon.get(pub(orgId, `/pages/${slug}`));
    expect(before.status).toBe(200);

    const e = (await owner.post(exps(orgId, pageId), fiftyFifty(v1))).body;
    expect((await owner.post(exps(orgId, pageId, `/${e.experimentId}/start`))).status).toBe(200);

    const after = await anon.get(pub(orgId, `/pages/${slug}`));
    expect(after.status).toBe(200);
    expect(after.body).toEqual(before.body); // the unchanged-shape guarantee
    expect(after.body.experiment).toBeUndefined();
  });

  it('vk + consent ⇒ sticky variant snapshot + additive stamp; holdout serves published', async () => {
    const { owner, orgId } = await ownerOrg();
    const { pageId, slug, v1 } = await pageWithHistory(owner, orgId);
    const e = (await owner.post(exps(orgId, pageId), fiftyFifty(v1))).body;
    await owner.post(exps(orgId, pageId, `/${e.experimentId}/start`));
    const anon = client();

    const vkLegacy = visitorFor(e, 'legacy');
    const vkControl = visitorFor(e, 'control');

    // consent toggle OFF ⇒ permissive (the beacon's exact gate semantics)
    const legacy = await anon.get(pub(orgId, `/pages/${slug}?vk=${encodeURIComponent(vkLegacy)}`));
    expect(legacy.status).toBe(200);
    expect(legacy.body.title).toBe('V1 Title'); // the snapshot's content
    expect(legacy.body.sections[0].data.heading).toBe('Version One Heading');
    expect(legacy.body.experiment).toEqual({ experimentId: e.experimentId, variant: 'legacy' });
    // sticky: same vk, same variant
    expect((await anon.get(pub(orgId, `/pages/${slug}?vk=${encodeURIComponent(vkLegacy)}`))).body.experiment.variant).toBe('legacy');

    // holdout: the LIVE published content, still stamped (tracked)
    const control = await anon.get(pub(orgId, `/pages/${slug}?vk=${encodeURIComponent(vkControl)}`));
    expect(control.body.title).toBe('V2 Title');
    expect(control.body.sections[0].data.heading).toBe('Version Two Heading');
    expect(control.body.experiment).toEqual({ experimentId: e.experimentId, variant: 'control' });

    // an oversized vk is ignored (honest degradation, no exposure)
    const oversized = await anon.get(pub(orgId, `/pages/${slug}?vk=${'x'.repeat(600)}`));
    expect(oversized.body.experiment).toBeUndefined();
    expect(oversized.body.title).toBe('V2 Title');
  });

  it('consent regime ON: no analytics consent ⇒ plain published page; granted ⇒ variant', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const { pageId, slug, v1 } = await pageWithHistory(owner, orgId);
    const e = (await owner.post(exps(orgId, pageId), fiftyFifty(v1))).body;
    await owner.post(exps(orgId, pageId, `/${e.experimentId}/start`));
    const anon = client();
    const vkLegacy = visitorFor(e, 'legacy');

    await setToggle('consent', 'on');
    try {
      const denied = await anon.get(pub(orgId, `/pages/${slug}?vk=${encodeURIComponent(vkLegacy)}`));
      expect(denied.status).toBe(200);
      expect(denied.body.experiment).toBeUndefined();
      expect(denied.body.title).toBe('V2 Title'); // plain published — no exposure

      // CONS-2 — the public capture route no longer accepts a caller-chosen
      // `subjectKey` (it was an anonymous forgery vector into the keyspace
      // shared with contactIds / userIds / emails). A visitor key granted
      // through the ONE consent service is the same write the route now makes.
      const { mergeConsentCategories } = await import('../src/features/consent/consentService.js');
      await mergeConsentCategories({ tenantId, subjectKey: vkLegacy, categories: { analytics: true }, source: 'public' });
      const granted = await anon.get(pub(orgId, `/pages/${slug}?vk=${encodeURIComponent(vkLegacy)}`));
      expect(granted.body.experiment).toEqual({ experimentId: e.experimentId, variant: 'legacy' });
      expect(granted.body.title).toBe('V1 Title');
    } finally {
      await setToggle('consent', 'off');
    }
  });
});

// ─── promote winner ──────────────────────────────────────────────────────────

describe('promote winner — existing CMS verbs', () => {
  it('version variant: restoreVersion → publish; the experiment ends promoted', async () => {
    const { owner, orgId } = await ownerOrg();
    const { pageId, slug, v1 } = await pageWithHistory(owner, orgId);
    const e = (await owner.post(exps(orgId, pageId), fiftyFifty(v1))).body;
    await owner.post(exps(orgId, pageId, `/${e.experimentId}/start`));

    const promoted = await owner.post(exps(orgId, pageId, `/${e.experimentId}/promote`), { variantKey: 'legacy' });
    expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
    expect(promoted.body.pendingApproval).toBe(false);
    expect(promoted.body.experiment.status).toBe('promoted');
    expect(promoted.body.page.status).toBe('published');
    expect(promoted.body.page.title).toBe('V1 Title');

    // the winner is now the LIVE published page
    const anon = client();
    const live = await anon.get(pub(orgId, `/pages/${slug}`));
    expect(live.body.title).toBe('V1 Title');
    expect(live.body.experiment).toBeUndefined(); // stopped — no more exposure

    // promote is a running-only verb (the experiment already ended)
    expect((await owner.post(exps(orgId, pageId, `/${e.experimentId}/promote`), { variantKey: 'legacy' })).status).toBe(409);
    // unknown variant on a fresh running experiment 400s
    const e2 = (await owner.post(exps(orgId, pageId), { ...fiftyFifty(v1), name: 'Again' })).body;
    await owner.post(exps(orgId, pageId, `/${e2.experimentId}/start`));
    expect((await owner.post(exps(orgId, pageId, `/${e2.experimentId}/promote`), { variantKey: 'nope' })).status).toBe(400);
  });

  it('holdout variant: nothing to publish — the live page already won', async () => {
    const { owner, orgId } = await ownerOrg();
    const { pageId, slug, v1 } = await pageWithHistory(owner, orgId);
    const e = (await owner.post(exps(orgId, pageId), fiftyFifty(v1))).body;
    await owner.post(exps(orgId, pageId, `/${e.experimentId}/start`));

    const promoted = await owner.post(exps(orgId, pageId, `/${e.experimentId}/promote`), { variantKey: 'control' });
    expect(promoted.status).toBe(200);
    expect(promoted.body.pendingApproval).toBe(false);
    expect(promoted.body.page).toBeNull();
    expect(promoted.body.experiment.status).toBe('promoted');
    expect((await client().get(pub(orgId, `/pages/${slug}`))).body.title).toBe('V2 Title'); // untouched
  });

  it('approval gate ON: promote lands restore + submit and reports pendingApproval honestly', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const { pageId, v1 } = await pageWithHistory(owner, orgId);
    const e = (await owner.post(exps(orgId, pageId), fiftyFifty(v1))).body;
    await owner.post(exps(orgId, pageId, `/${e.experimentId}/start`));

    await setToggle('cms-approval-gate', 'on');
    try {
      const promoted = await owner.post(exps(orgId, pageId, `/${e.experimentId}/promote`), { variantKey: 'legacy' });
      expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
      expect(promoted.body.pendingApproval).toBe(true);
      expect(promoted.body.page.status).toBe('in_review'); // NOT live — the inbox decides
      expect(promoted.body.experiment.status).toBe('promoted');
      expect(await hasPendingApprovalForPage(tenantId, pageId)).toBe(true);
    } finally {
      await setToggle('cms-approval-gate', 'off');
    }
  });
});

// ─── results projection ──────────────────────────────────────────────────────


// ANLWF-3 / ADR 0651 D3 — stamps are RE-DERIVED at ingest, so a fixture may no
// longer hand-pick a variant per session key (that is the forgery the fix closes).
// Mine keys the deterministic assignment actually places on each variant instead;
// every numeric assertion below is unchanged, the fixture just stopped lying.
async function keysOn(tenantId: string, orgId: string, pageId: string, variant: string, n: number, prefix: string): Promise<string[]> {
  const exp = await findRunningExperiment(tenantId, orgId, pageId);
  if (!exp) throw new Error('keysOn: experiment not running — fixture is vacuous');
  const out: string[] = [];
  for (let i = 0; out.length < n && i < n * 40; i++) {
    const k = `${prefix}-${i}`;
    if (assignVariantForVisitor(exp, k)?.key === variant) out.push(k);
  }
  if (out.length < n) throw new Error(`keysOn: only ${out.length}/${n} keys landed on ${variant}`);
  return out;
}

describe('results — read-time projection over stamped events', () => {
  it('reports insufficientSample honestly below the session floor', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const { pageId, v1 } = await pageWithHistory(owner, orgId);
    const e = (await owner.post(exps(orgId, pageId), fiftyFifty(v1))).body;
    await owner.post(exps(orgId, pageId, `/${e.experimentId}/start`));

    const stamp = (variant: string) => ({ id: e.experimentId as string, variant });
    const ic = await keysOn(tenantId, orgId, pageId, 'control', 3, 'ic');
    const il = await keysOn(tenantId, orgId, pageId, 'legacy', 3, 'il');
    for (let i = 0; i < 3; i++) {
      await recordEvent({ tenantId, orgId, raw: { type: 'pageview', sessionKey: ic[i], experiment: stamp('control') } });
      await recordEvent({ tenantId, orgId, raw: { type: 'pageview', sessionKey: il[i], experiment: stamp('legacy') } });
      await recordEvent({ tenantId, orgId, raw: { type: 'conversion', sessionKey: il[i], experiment: stamp('legacy') } });
    }
    await recordEvent({ tenantId, orgId, raw: { type: 'conversion', sessionKey: ic[0], experiment: stamp('control') } });
    // a duplicate conversion in one session must not double-count. (Was the literal
    // 'il-0', which is not a mined key: with server-derived stamps its assignment is
    // salt-dependent, so the fixture was green by luck — ADR 0651 D3 fold, 2026-09-10.)
    await recordEvent({ tenantId, orgId, raw: { type: 'conversion', sessionKey: il[0], experiment: stamp('legacy') } });

    const r = await owner.get(exps(orgId, pageId, `/${e.experimentId}/results`));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.baselineKey).toBe('control');
    const [control, legacy] = r.body.variants;
    expect(control).toMatchObject({ key: 'control', sessions: 3, conversions: 1, zScore: null, significant: null, insufficientSample: true });
    expect(control.conversionRate).toBeCloseTo(1 / 3, 5);
    expect(legacy).toMatchObject({ key: 'legacy', sessions: 3, conversions: 3, significant: null, insufficientSample: true });
    expect(legacy.conversionRate).toBe(1);
  });

  // ANLWF-3 / ADR 0651 D3 — the ADR 0236 experiment stamp is CLIENT-FORGEABLE.
  // `recordEvent` accepted `experiment.{id,variant}` verbatim (length caps and
  // both-or-neither were the entire validation) and `experimentResults` built its
  // per-variant session/conversion sets from those fields — then ran a
  // two-proportion z-test and emitted `significant`. An unauthenticated caller
  // could POST conversions stamped with a variant no visitor was ever assigned to
  // and move a published A/B test's verdict anywhere. The render side already
  // derives the variant deterministically from (sessionKey, experimentId, salt);
  // ingest must do the same and IGNORE the client's `variant`.
  it('ANLWF-3: a conversion stamped with a variant the session was NOT assigned lands on the ASSIGNED one', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const { pageId, v1 } = await pageWithHistory(owner, orgId);
    const e = (await owner.post(exps(orgId, pageId), fiftyFifty(v1))).body;
    await owner.post(exps(orgId, pageId, `/${e.experimentId}/start`));
    const running = await findRunningExperiment(tenantId, orgId, pageId);
    expect(running, 'the experiment must be running — otherwise this test is vacuous').toBeTruthy();

    // Find a session key the deterministic assignment puts on CONTROL, then forge
    // a conversion claiming LEGACY for that very session.
    let key = '';
    for (let i = 0; i < 200 && !key; i++) {
      const k = `forged-${i}`;
      if (assignVariantForVisitor(running!, k)?.key === 'control') key = k;
    }
    expect(key, 'must find a control-assigned key in 200 tries (50/50 split)').toBeTruthy();
    await recordEvent({ tenantId, orgId, raw: { type: 'pageview', sessionKey: key, experiment: { id: e.experimentId, variant: 'legacy' } } });
    await recordEvent({ tenantId, orgId, raw: { type: 'conversion', sessionKey: key, experiment: { id: e.experimentId, variant: 'legacy' } } });

    const r = await owner.get(exps(orgId, pageId, `/${e.experimentId}/results`));
    const byKey = Object.fromEntries((r.body.variants as Array<{ key: string; sessions: number; conversions: number }>).map((v) => [v.key, v]));
    // The forged stamp must NOT be honoured: the session was assigned control, so
    // its pageview and conversion belong to control and legacy sees nothing.
    expect(byKey.legacy.sessions, 'forged variant must receive no session').toBe(0);
    expect(byKey.legacy.conversions, 'forged variant must receive no conversion').toBe(0);
    expect(byKey.control.sessions).toBe(1);
    expect(byKey.control.conversions).toBe(1);
  });

  // ANL-18 / ANL-21 / ANL-22 (grade-code 2026-09-10) — D3 fixed INGEST and left the
  // STORE: every pre-fix row still carried the client's claimed variant and the
  // projection read it unconditionally, so last week's forgery still decided
  // `significant`. A stamp now counts only when it is server-derived; a client-
  // claimed (legacy) stamp and an ingest-refused stamp are COUNTED as unattributed
  // on the results shape (never silently), and a stopped experiment still
  // attributes the visitors it assigned while running.
  it('ANL-18: a client-claimed (pre-D3) stamp is quarantined, a refused stamp is counted, a stopped experiment still attributes', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const { pageId, v1 } = await pageWithHistory(owner, orgId);
    const e = (await owner.post(exps(orgId, pageId), fiftyFifty(v1))).body;
    await owner.post(exps(orgId, pageId, `/${e.experimentId}/start`));
    const running = await findRunningExperiment(tenantId, orgId, pageId);
    expect(running).toBeTruthy();
    const [ck] = await keysOn(tenantId, orgId, pageId, 'control', 1, 'q18');

    // A pre-D3 row: the client's claim verbatim, no `derived` marker — seeded the way
    // the OLD ingest wrote it, because the new ingest can no longer produce one.
    await __putRawEventForTests({ eventId: 'legacy-row-1', tenantId, orgId, type: 'conversion', ts: new Date().toISOString(), sessionKey: 'forged-legacy-session', experiment: { id: e.experimentId, variant: 'legacy' } });
    // A derived stamp for a control-assigned session.
    await recordEvent({ tenantId, orgId, raw: { type: 'pageview', sessionKey: ck, experiment: { id: e.experimentId, variant: 'legacy' } } });
    // A draft experiment's id on a beacon: KNOWN to this org, never assigned ⇒ dropped WITH id.
    const draft = (await owner.post(exps(orgId, pageId), fiftyFifty(v1))).body;
    await recordEvent({ tenantId, orgId, raw: { type: 'pageview', sessionKey: 'd-1', experiment: { id: draft.experimentId, variant: 'control' } } });
    // An unknown id: dropped WITHOUT id — a client-fabricated string never reaches durable state.
    await recordEvent({ tenantId, orgId, raw: { type: 'pageview', sessionKey: 'u-1', experiment: { id: 'exp-fabricated', variant: 'control' } } });
    const stored = await listEvents(tenantId, orgId, 100);
    const unknownRow = stored.find((x) => x.sessionKey === 'u-1');
    expect(unknownRow?.experiment, 'a fabricated id is not a stamp').toBeUndefined();
    expect(unknownRow?.experimentDropped).toEqual({ reason: 'unknown' });
    expect(stored.find((x) => x.sessionKey === 'd-1')?.experimentDropped).toEqual({ reason: 'not_running', id: draft.experimentId });
    expect(stored.find((x) => x.sessionKey === ck)?.experiment).toEqual({ id: e.experimentId, variant: 'control', derived: true });

    const r = await owner.get(exps(orgId, pageId, `/${e.experimentId}/results`));
    expect(r.status).toBe(200);
    const byKey = Object.fromEntries((r.body.variants as Array<{ key: string; sessions: number; conversions: number }>).map((v) => [v.key, v]));
    expect(byKey.legacy.conversions, 'the pre-D3 forged conversion must NOT count').toBe(0);
    expect(byKey.legacy.sessions).toBe(0);
    expect(byKey.control.sessions).toBe(1);
    expect(r.body.unattributed, 'the projection SAYS what it refused').toEqual({ legacy: 1, dropped: 0 });
    const rd = await owner.get(exps(orgId, pageId, `/${draft.experimentId}/results`));
    expect(rd.status).toBe(200);
    expect(rd.body.unattributed).toEqual({ legacy: 0, dropped: 1 });

    // ANL-22 — Stop, then a conversion from the control-assigned session: attributed.
    await owner.post(exps(orgId, pageId, `/${e.experimentId}/stop`));
    await recordEvent({ tenantId, orgId, raw: { type: 'conversion', sessionKey: ck, experiment: { id: e.experimentId, variant: 'legacy' } } });
    const r2 = await owner.get(exps(orgId, pageId, `/${e.experimentId}/results`));
    const byKey2 = Object.fromEntries((r2.body.variants as Array<{ key: string; sessions: number; conversions: number }>).map((v) => [v.key, v]));
    expect(byKey2.control.conversions, 'a late conversion from an assigned visitor still counts after Stop').toBe(1);
    expect(byKey2.legacy.conversions).toBe(0);
    expect(r2.body.unattributed).toEqual({ legacy: 1, dropped: 0 });
  });

  it('computes the two-proportion z and a 95% verdict once samples suffice', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const { pageId, v1 } = await pageWithHistory(owner, orgId);
    const e = (await owner.post(exps(orgId, pageId), fiftyFifty(v1))).body;
    await owner.post(exps(orgId, pageId, `/${e.experimentId}/start`));

    const stamp = (variant: string) => ({ id: e.experimentId as string, variant });
    // control: 40 sessions, 8 conversions (20%); legacy: 40 sessions, 20 (50%)
    const ck = await keysOn(tenantId, orgId, pageId, 'control', 40, 'c');
    const lk = await keysOn(tenantId, orgId, pageId, 'legacy', 40, 'l');
    for (let i = 0; i < 40; i++) {
      await recordEvent({ tenantId, orgId, raw: { type: 'pageview', sessionKey: ck[i], experiment: stamp('control') } });
      if (i < 8) await recordEvent({ tenantId, orgId, raw: { type: 'conversion', sessionKey: ck[i], experiment: stamp('control') } });
      await recordEvent({ tenantId, orgId, raw: { type: 'pageview', sessionKey: lk[i], experiment: stamp('legacy') } });
      if (i < 20) await recordEvent({ tenantId, orgId, raw: { type: 'conversion', sessionKey: lk[i], experiment: stamp('legacy') } });
    }

    const r = await owner.get(exps(orgId, pageId, `/${e.experimentId}/results`));
    const [control, legacy] = r.body.variants;
    expect(control).toMatchObject({ sessions: 40, conversions: 8, zScore: null, significant: null, insufficientSample: false });
    expect(legacy).toMatchObject({ sessions: 40, conversions: 20, insufficientSample: false });
    expect(legacy.conversionRate).toBeCloseTo(0.5, 5);
    expect(legacy.zScore).toBeCloseTo(2.813, 2);
    expect(legacy.significant).toBe(true);
  });

  // ANLWF-3 / ADR 0651 D3 — this used to post `{id:'pexp:abc', variant:'B'}` for an
  // experiment that did not exist and assert it was PERSISTED VERBATIM. That was the
  // forgery pinned as the contract. The honest contract: the beacon's `id` is looked
  // up, the variant is RE-DERIVED for this session, the client's claimed variant is
  // ignored, and an unknown id yields no stamp at all (the event still lands).
  it('the public beacon persists the DERIVED stamp — never the claimed variant, never an unknown id', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const { pageId, v1 } = await pageWithHistory(owner, orgId);
    const e = (await owner.post(exps(orgId, pageId), fiftyFifty(v1))).body;
    await owner.post(exps(orgId, pageId, `/${e.experimentId}/start`));
    const [key] = await keysOn(tenantId, orgId, pageId, 'control', 1, 'bx');
    const anon = client();
    const base = `/v1/host/openwop-app/public-analytics/${encodeURIComponent(orgId)}/collect`;
    // Claims LEGACY for a session the assignment puts on CONTROL.
    expect((await anon.post(base, { type: 'pageview', path: '/x', sessionKey: key, experiment: { id: e.experimentId, variant: 'legacy' } })).status).toBe(201);
    // An id nothing owns → recorded, but with NO stamp.
    expect((await anon.post(base, { type: 'pageview', path: '/x', sessionKey: 'bx-unknown', experiment: { id: 'pexp:does-not-exist', variant: 'legacy' } })).status).toBe(201);
    // ANL-15 — the HTTP events response is projected to the declared client shape
    // (no stamp rides it), so the STORED row is the witness here.
    const events = await listEvents(tenantId, orgId, 100);
    expect(events.find((x) => x.sessionKey === key)?.experiment).toEqual({ id: e.experimentId, variant: 'control', derived: true });
    expect(events.find((x) => x.sessionKey === 'bx-unknown'), 'the event itself must still land').toBeTruthy();
    expect(events.find((x) => x.sessionKey === 'bx-unknown')?.experiment).toBeUndefined();
  });
});

// ─── audit rows ──────────────────────────────────────────────────────────────

describe('audit — cms.experiment.* rows carry payload.tenantId', () => {
  it('create/start/stop/promote all append tenant-stamped audit rows', async () => {
    const { owner, orgId, tenantId } = await ownerOrg();
    const { pageId, v1 } = await pageWithHistory(owner, orgId);
    const e = (await owner.post(exps(orgId, pageId), fiftyFifty(v1))).body;
    await owner.post(exps(orgId, pageId, `/${e.experimentId}/start`));
    await owner.post(exps(orgId, pageId, `/${e.experimentId}/promote`), { variantKey: 'control' });

    const rows = await storage().listAudit({ actionPrefix: 'cms.experiment.', limit: 100 });
    const mine = rows.filter((r) => (r.payload as { experimentId?: string })?.experimentId === e.experimentId);
    const actions = mine.map((r) => r.action);
    expect(actions).toContain('cms.experiment.create');
    expect(actions).toContain('cms.experiment.start');
    expect(actions).toContain('cms.experiment.promote');
    for (const row of mine) expect((row.payload as { tenantId?: string }).tenantId).toBe(tenantId);
  });
});
