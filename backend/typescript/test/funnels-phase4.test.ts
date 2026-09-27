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

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b), del: (p: string) => call('DELETE', p) };
}

async function marketer(): Promise<{ user: ReturnType<typeof client>; orgId: string }> {
  const user = client();
  await user.post('/v1/host/openwop-app/test/login', { email: `fp4-${Date.now()}-${n++}@acme.test` });
  const org = await user.post('/v1/host/openwop-app/orgs', { name: 'Funnel Co' });
  return { user, orgId: org.body.orgId };
}

const authed = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/funnels/orgs/${encodeURIComponent(orgId)}/funnels${suffix}`;
const pub = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/public/${encodeURIComponent(orgId)}/funnels${suffix}`;

async function publishedPage(user: ReturnType<typeof client>, orgId: string, title: string): Promise<{ pageId: string; slug: string }> {
  const created = await user.post(`/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages`, { title });
  await user.post(`/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages/${created.body.pageId}/publish`);
  return { pageId: created.body.pageId, slug: created.body.slug };
}

async function experimentFunnel() {
  const { user, orgId } = await marketer();
  const holdout = await publishedPage(user, orgId, 'P4 Holdout');
  const challenger = await publishedPage(user, orgId, 'P4 Challenger');
  const created = await user.post(authed(orgId), {
    name: 'Split Path', slug: 'split-path',
    steps: [{ stepId: 'sp-landing', kind: 'landing', pageId: holdout.pageId }],
  });
  const funnelId: string = created.body.funnel.funnelId;
  await user.post(authed(orgId, `/${funnelId}/publish`));
  return { user, orgId, funnelId, holdout, challenger };
}

describe('funnels Phase 4 — step experiments', () => {
  it('validates variants and replaces on set (fresh experimentId + salt)', async () => {
    const { user, orgId, funnelId, challenger } = await experimentFunnel();
    const exp = (v: unknown) => user.post(authed(orgId, `/${funnelId}/steps/sp-landing/experiment`), { variants: v });

    expect((await exp([{ key: 'a', pageId: null, weight: 100 }])).status).toBe(400);          // <2 variants
    expect((await exp([{ key: 'a', pageId: null, weight: 50 }, { key: 'a', pageId: challenger.pageId, weight: 50 }])).status).toBe(400); // dup keys
    expect((await exp([{ key: 'a', pageId: null, weight: 50 }, { key: 'b', pageId: challenger.pageId, weight: 40 }])).status).toBe(400); // sum ≠ 100
    expect((await exp([{ key: 'a', pageId: null, weight: 50 }, { key: 'b', pageId: 'nope', weight: 50 }])).status).toBe(400);            // foreign page
    expect((await user.post(authed(orgId, `/${funnelId}/steps/missing/experiment`), { variants: [{ key: 'a', pageId: null, weight: 50 }, { key: 'b', pageId: challenger.pageId, weight: 50 }] })).status).toBe(404);

    const first = await exp([{ key: 'control', pageId: null, weight: 50 }, { key: 'b', pageId: challenger.pageId, weight: 50 }]);
    expect(first.status).toBe(201);
    const id1 = first.body.funnel.steps[0].experiment.experimentId;
    const second = await exp([{ key: 'control', pageId: null, weight: 50 }, { key: 'b', pageId: challenger.pageId, weight: 50 }]);
    expect(second.body.funnel.steps[0].experiment.experimentId).not.toBe(id1); // replace = fresh id/salt
  });

  it('serves sticky variants to consented visitors, holdout unstamped to anonymous; edits carry the experiment', async () => {
    const { user, orgId, funnelId, holdout, challenger } = await experimentFunnel();
    await user.post(authed(orgId, `/${funnelId}/steps/sp-landing/experiment`), {
      variants: [{ key: 'control', pageId: null, weight: 50 }, { key: 'b', pageId: challenger.pageId, weight: 50 }],
    });
    const v = client();

    // anonymous: holdout page, no stamp
    const anonRead = await v.get(pub(orgId, '/split-path'));
    expect(anonRead.body.step.pageSlug).toBe(holdout.slug);
    expect(anonRead.body.step.experiment).toBeUndefined();

    // find a vk assigned to the challenger (bounded scan — assignment is deterministic)
    let bVk = '';
    for (let i = 0; i < 40 && !bVk; i++) {
      const probe = await v.get(pub(orgId, `/split-path?vk=probe-${i}`));
      if (probe.body.step.experiment?.variant === 'b') bVk = `probe-${i}`;
    }
    expect(bVk).not.toBe('');

    // the challenger visitor is served the VARIANT page, stamped, stickily
    const read1 = await v.get(pub(orgId, `/split-path?vk=${bVk}`));
    expect(read1.body.step.pageSlug).toBe(challenger.slug);
    const read2 = await v.get(pub(orgId, `/split-path?vk=${bVk}`));
    expect(read2.body.step.experiment.variant).toBe('b');
    expect(read2.body.step.pageSlug).toBe(challenger.slug);

    // an edit to the funnel's steps preserves the running experiment
    await user.post(authed(orgId, `/${funnelId}/unpublish`));
    const upd = await user.patch(authed(orgId, `/${funnelId}`), {
      steps: [{ stepId: 'sp-landing', kind: 'landing', pageId: holdout.pageId, name: 'renamed' }],
    });
    expect(upd.body.funnel.steps[0].experiment?.experimentId).toBeTruthy();

    // stop → serving reverts to holdout, unstamped
    await user.post(authed(orgId, `/${funnelId}/publish`));
    await user.del(authed(orgId, `/${funnelId}/steps/sp-landing/experiment`));
    const after = await v.get(pub(orgId, `/split-path?vk=${bVk}`));
    expect(after.body.step.pageSlug).toBe(holdout.slug);
    expect(after.body.step.experiment).toBeUndefined();
  });

  it('results: distinct-visitor sessions/conversions per variant with the honest sample floor', async () => {
    const { user, orgId, funnelId, challenger } = await experimentFunnel();
    await user.post(authed(orgId, `/${funnelId}/steps/sp-landing/experiment`), {
      variants: [{ key: 'control', pageId: null, weight: 50 }, { key: 'b', pageId: challenger.pageId, weight: 50 }],
    });
    const v = client();

    // 6 visitors view (some repeat), 2 complete
    const stamps = new Map<string, string>();
    for (let i = 0; i < 6; i++) {
      const vk = `res-${i}`;
      const read = await v.get(pub(orgId, `/split-path?vk=${vk}`));
      stamps.set(vk, read.body.step.experiment.variant);
      await v.get(pub(orgId, `/split-path?vk=${vk}`)); // repeat view — same session
    }
    await v.get(pub(orgId, `/split-path/next?from=sp-landing&vk=res-0`));
    await v.get(pub(orgId, `/split-path/next?from=sp-landing&vk=res-1`));

    const results = await user.get(authed(orgId, `/${funnelId}/steps/sp-landing/experiment/results`));
    expect(results.status).toBe(200);
    const byKey = new Map<string, { sessions: number; conversions: number; insufficientSample: boolean; significant: boolean | null }>(
      results.body.variants.map((r: { key: string }) => [r.key, r]),
    );
    const expectSessions = (key: string) => [...stamps.values()].filter((s) => s === key).length;
    expect(byKey.get('control')!.sessions).toBe(expectSessions('control')); // distinct visitors, repeats deduped
    expect(byKey.get('b')!.sessions).toBe(expectSessions('b'));
    const conv = (byKey.get('control')!.conversions) + (byKey.get('b')!.conversions);
    expect(conv).toBe(2);
    // 6 visitors << the shared 30/variant floor — verdicts stay honest
    expect(byKey.get('b')!.insufficientSample).toBe(true);
    expect(byKey.get('b')!.significant).toBeNull();
    expect(results.body.minSessionsPerVariant).toBe(30);
  });
});
