/**
 * Funnels Phase 4 (ADR 0294 / Funnel A) — step experiments on the SHARED
 * assignment + z-test primitives:
 *  - manage: variant validation (2–4, unique keys, integer weights summing 100,
 *    pages must resolve), replace-on-set (fresh id + salt), stop;
 *  - serving: a consented (vk) visitor gets a sticky variant + stamp; the
 *    assigned variant's PAGE is served; anonymous visitors get the holdout
 *    with NO stamp; an unpublished variant page degrades to holdout unstamped;
 *  - results: distinct-visitor sessions/conversions per variant from the
 *    stamped events, honest insufficientSample below the shared floor;
 *  - edits preserve a step's experiment (carry-over by stepId).
 *
 * TST-DEB-6 — red when: a variant validator (count, unique keys, sum 100,
 * resolving page) is dropped, a re-set reuses the prior experimentId, the
 * assigned variant's page is not served, a completion stops counting, or an
 * anonymous visitor gets assigned. "Anonymous → holdout, unstamped" is a TRIPLE
 * guard: the route's `consentedVisitor` returns '' without a `vk` (OUTER, probed),
 * then `publicFunnelStep` skips resolution for '' and `assignStepVariant` returns
 * null for '' — so a single service-side sabotage stays green by design.
 * The results fixture is made ASYMMETRIC (arm counts differ) so a control↔b
 * swap in the rollup cannot pass.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string; let server: http.Server; let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'funnels', 'cdp']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T }
interface Exp { experimentId: string; status: string }
interface FunnelBody { funnel: { funnelId: string; steps: Array<{ experiment?: Exp }> } }
interface PublicStep { step: { pageSlug: string; experiment?: { experimentId: string; variant: string } } }
interface Results {
  variants: Array<{ key: string; sessions: number; conversions: number; insufficientSample: boolean; significant: boolean | null }>;
  minSessionsPerVariant: number;
  health: { stopEarly: string; srm: { alpha: number; mismatch: boolean } };
}
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
    const text = res.status === 204 ? '' : await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
  };
  return {
    get: <T>(p: string) => call<T>('GET', p),
    post: <T>(p: string, b?: unknown) => call<T>('POST', p, b),
    patch: <T>(p: string, b?: unknown) => call<T>('PATCH', p, b),
    del: <T>(p: string) => call<T>('DELETE', p),
  };
}
function refused(r: Res<unknown>, status: number, error: string, message: string): void {
  expect(r.status).toBe(status);
  expect(r.body).toMatchObject({ error, message });
}

async function marketer(): Promise<{ user: ReturnType<typeof client>; orgId: string }> {
  const user = client();
  await user.post('/host/openwop-app/test/login', { email: `fp4-${Date.now()}-${n++}@acme.test` });
  const org = await user.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Funnel Co' });
  return { user, orgId: org.body.orgId };
}

const authed = (orgId: string, suffix = ''): string => `/host/openwop-app/funnels/orgs/${encodeURIComponent(orgId)}/funnels${suffix}`;
const pub = (orgId: string, suffix = ''): string => `/host/openwop-app/public/${encodeURIComponent(orgId)}/funnels${suffix}`;

async function publishedPage(user: ReturnType<typeof client>, orgId: string, title: string): Promise<{ pageId: string; slug: string }> {
  const created = await user.post<{ pageId: string; slug: string }>(`/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages`, { title });
  await user.post(`/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages/${created.body.pageId}/publish`);
  return { pageId: created.body.pageId, slug: created.body.slug };
}

async function experimentFunnel() {
  const { user, orgId } = await marketer();
  const holdout = await publishedPage(user, orgId, 'P4 Holdout');
  const challenger = await publishedPage(user, orgId, 'P4 Challenger');
  const created = await user.post<FunnelBody>(authed(orgId), {
    name: 'Split Path', slug: 'split-path',
    steps: [{ stepId: 'sp-landing', kind: 'landing', pageId: holdout.pageId }],
  });
  const funnelId = created.body.funnel.funnelId;
  await user.post(authed(orgId, `/${funnelId}/publish`));
  return { user, orgId, funnelId, holdout, challenger };
}

describe('funnels Phase 4 — step experiments', () => {
  it('validates variants and replaces on set (fresh experimentId + salt)', async () => {
    const { user, orgId, funnelId, challenger } = await experimentFunnel();
    const exp = (v: unknown) => user.post<FunnelBody>(authed(orgId, `/${funnelId}/steps/sp-landing/experiment`), { variants: v });

    refused(await exp([{ key: 'a', pageId: null, weight: 100 }]), 400, 'validation_error', 'An experiment needs 2–4 variants.');
    refused(await exp([{ key: 'a', pageId: null, weight: 50 }, { key: 'a', pageId: challenger.pageId, weight: 50 }]), 400, 'validation_error', 'Variant keys must be unique.');
    refused(await exp([{ key: 'a', pageId: null, weight: 50 }, { key: 'b', pageId: challenger.pageId, weight: 40 }]), 400, 'validation_error', 'Variant weights must sum to exactly 100.');
    refused(await exp([{ key: 'a', pageId: null, weight: 50 }, { key: 'b', pageId: 'nope', weight: 50 }]), 400, 'validation_error', 'Variant page not found in this workspace: nope');
    refused(await user.post(authed(orgId, `/${funnelId}/steps/missing/experiment`), { variants: [{ key: 'a', pageId: null, weight: 50 }, { key: 'b', pageId: challenger.pageId, weight: 50 }] }), 404, 'not_found', 'Step not found.');

    const first = await exp([{ key: 'control', pageId: null, weight: 50 }, { key: 'b', pageId: challenger.pageId, weight: 50 }]);
    expect(first.status).toBe(201);
    const id1 = first.body.funnel.steps[0]!.experiment!.experimentId;
    expect(typeof id1).toBe('string');
    const second = await exp([{ key: 'control', pageId: null, weight: 50 }, { key: 'b', pageId: challenger.pageId, weight: 50 }]);
    expect(second.status).toBe(201);
    expect(second.body.funnel.steps[0]!.experiment!.experimentId).not.toBe(id1); // replace = fresh id/salt
  });

  it('serves sticky variants to consented visitors, holdout unstamped to anonymous; edits carry the experiment', async () => {
    const { user, orgId, funnelId, holdout, challenger } = await experimentFunnel();
    await user.post(authed(orgId, `/${funnelId}/steps/sp-landing/experiment`), {
      variants: [{ key: 'control', pageId: null, weight: 50 }, { key: 'b', pageId: challenger.pageId, weight: 50 }],
    });
    const v = client();

    // anonymous: holdout page, no stamp
    const anonRead = await v.get<PublicStep>(pub(orgId, '/split-path'));
    expect(anonRead.body.step.pageSlug).toBe(holdout.slug);
    expect(anonRead.body.step.experiment).toBeUndefined();

    // find a vk assigned to the challenger (bounded scan — assignment is deterministic)
    let bVk = '';
    for (let i = 0; i < 40 && !bVk; i++) {
      const probe = await v.get<PublicStep>(pub(orgId, `/split-path?vk=probe-${i}`));
      if (probe.body.step.experiment?.variant === 'b') bVk = `probe-${i}`;
    }
    expect(bVk).not.toBe('');

    // the challenger visitor is served the VARIANT page, stamped, stickily
    const read1 = await v.get<PublicStep>(pub(orgId, `/split-path?vk=${bVk}`));
    expect(read1.body.step.pageSlug).toBe(challenger.slug);
    const read2 = await v.get<PublicStep>(pub(orgId, `/split-path?vk=${bVk}`));
    expect(read2.body.step.experiment?.variant).toBe('b');
    expect(read2.body.step.pageSlug).toBe(challenger.slug);

    // an edit to the funnel's steps preserves the running experiment
    await user.post(authed(orgId, `/${funnelId}/unpublish`));
    const running = (await user.get<FunnelBody>(authed(orgId, `/${funnelId}`))).body.funnel.steps[0]!.experiment!.experimentId;
    const upd = await user.patch<FunnelBody>(authed(orgId, `/${funnelId}`), {
      steps: [{ stepId: 'sp-landing', kind: 'landing', pageId: holdout.pageId, name: 'renamed' }],
    });
    expect(upd.body.funnel.steps[0]!.experiment?.experimentId).toBe(running);

    // stop → serving reverts to holdout, unstamped
    await user.post(authed(orgId, `/${funnelId}/publish`));
    await user.del(authed(orgId, `/${funnelId}/steps/sp-landing/experiment`));
    const after = await v.get<PublicStep>(pub(orgId, `/split-path?vk=${bVk}`));
    expect(after.body.step.pageSlug).toBe(holdout.slug);
    expect(after.body.step.experiment).toBeUndefined();
  });

  it('results: distinct-visitor sessions/conversions per variant with the honest sample floor', async () => {
    const { user, orgId, funnelId, challenger } = await experimentFunnel();
    await user.post(authed(orgId, `/${funnelId}/steps/sp-landing/experiment`), {
      variants: [{ key: 'control', pageId: null, weight: 50 }, { key: 'b', pageId: challenger.pageId, weight: 50 }],
    });
    const v = client();

    // ≥ 6 visitors view (each twice — same session), grown until the two arms
    // hold DIFFERENT counts (deterministic assignment ⇒ a fixed visitor set), so a
    // control↔b swap in the rollup would change the per-arm numbers.
    const stamps = new Map<string, string>();
    const count = (key: string): number => [...stamps.values()].filter((s) => s === key).length;
    for (let i = 0; i < 30 && (stamps.size < 6 || count('control') === count('b')); i++) {
      const vk = `res-${i}`;
      const read = await v.get<PublicStep>(pub(orgId, `/split-path?vk=${vk}`));
      const variant = read.body.step.experiment?.variant;
      expect(variant, `${vk} was not stamped`).toBeDefined();
      stamps.set(vk, variant!);
      await v.get(pub(orgId, `/split-path?vk=${vk}`)); // repeat view — same session
    }
    expect(count('control')).not.toBe(count('b'));
    await v.get(pub(orgId, `/split-path/next?from=sp-landing&vk=res-0`));
    await v.get(pub(orgId, `/split-path/next?from=sp-landing&vk=res-1`));
    const converted = ['res-0', 'res-1'];

    const results = await user.get<Results>(authed(orgId, `/${funnelId}/steps/sp-landing/experiment/results`));
    expect(results.status).toBe(200);
    const byKey = new Map(results.body.variants.map((r) => [r.key, r]));
    for (const arm of ['control', 'b']) {
      expect(byKey.get(arm)!.sessions, `${arm} sessions`).toBe(count(arm)); // distinct visitors, repeats deduped
      expect(byKey.get(arm)!.conversions, `${arm} conversions`).toBe(converted.filter((vk) => stamps.get(vk) === arm).length);
    }
    // 6 visitors << the shared 30/variant floor — verdicts stay honest
    expect(byKey.get('b')!.insufficientSample).toBe(true);
    expect(byKey.get('b')!.significant).toBeNull();
    expect(results.body.minSessionsPerVariant).toBe(30);
    // ADR 0949 P0 — the split check rides the funnel result too (over the same event window).
    expect(results.body.health.stopEarly).toBe('fixed_horizon_do_not_stop_early');
    expect(results.body.health.srm).toMatchObject({ alpha: 0.001, mismatch: false });
  });
});
