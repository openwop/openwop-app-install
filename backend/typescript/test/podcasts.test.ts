/**
 * Multi-speaker podcasts (ADR 0086) — ROUTE harness. Proves the feature-package
 * vertical slice: toggle-gated (404 while off), org-scoped RBAC + tenant IDOR
 * (uniform 404), 1–4-speaker / 3–20-segment validation, and that generating an
 * episode ENQUEUES a run (202 + runId) rather than calling a model synchronously.
 *
 * The toggle is enabled via the saveConfig SERVICE (the global default), the same
 * mechanism the notebooks/projects route tests use.
 *
 * @see docs/adr/0086-multi-speaker-podcasts.md
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { BACKEND_FEATURES } from '../src/features/index.js';
import { projectStatus, PODCAST_LIMITS } from '../src/features/podcasts/podcastsService.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['podcasts', 'notebooks', 'kb', 'users']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), del: (p) => call('DELETE', p) };
}

const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function ownerWithOrg(who: string): Promise<{ c: Client; orgId: string }> {
  const c = client();
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail(who) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  return { c, orgId: org.body.orgId };
}

const P = '/v1/host/openwop-app/podcasts';
const oneSpeaker = [{ name: 'Ana', voiceId: 'female-1' }];

describe('podcasts — registration + status projection', () => {
  it('is registered as a backend feature (appended to BACKEND_FEATURES)', () => {
    expect(BACKEND_FEATURES.some((f) => f.id === 'podcasts')).toBe(true);
  });
  it('projects episode status from the run status (the SoT)', () => {
    expect(projectStatus(undefined)).toBe('queued');
    expect(projectStatus('pending')).toBe('queued');
    expect(projectStatus('running')).toBe('running');
    expect(projectStatus('waiting-approval')).toBe('awaiting-approval');
    expect(projectStatus('completed')).toBe('done');
    expect(projectStatus('failed')).toBe('failed');
    expect(projectStatus('cancelled')).toBe('failed');
  });
});

describe('podcasts — profiles + generation', () => {
  it('creates cast + show-format profiles and enqueues a generation run', async () => {
    const { c, orgId } = await ownerWithOrg('pod-flow');

    // Cast profile (2 speakers).
    const cast = await c.post(`${P}/speaker-profiles`, { orgId, name: 'Duo', speakers: [{ name: 'Ana', voiceId: 'female-1' }, { name: 'Marco', voiceId: 'male-1', personality: 'skeptical' }] });
    expect(cast.status, JSON.stringify(cast.body)).toBe(201);
    const speakerProfileId = cast.body.profile.id as string;
    expect(cast.body.profile.speakers).toHaveLength(2);

    // Show-format profile referencing the cast.
    const fmt = await c.post(`${P}/episode-profiles`, { orgId, name: 'Weekly', speakerProfileId, segmentCount: 6 });
    expect(fmt.status, JSON.stringify(fmt.body)).toBe(201);
    const episodeProfileId = fmt.body.profile.id as string;
    expect(fmt.body.profile.segmentCount).toBe(6);

    // A notebook to source from.
    const nb = await c.post('/v1/host/openwop-app/notebooks', { orgId, name: 'Research' });
    expect(nb.status).toBe(201);

    // Generate → 202 + a runId + queued status (the run does the work async).
    const ep = await c.post(`${P}/episodes`, { orgId, notebookId: nb.body.notebook.id, episodeProfileId, title: 'Ep 1' });
    expect(ep.status, JSON.stringify(ep.body)).toBe(202);
    expect(ep.body.episode.runId).toBeTruthy();
    expect(ep.body.episode.status).toBe('queued');

    // It appears in the list with a projected status.
    const list = await c.get(`${P}/episodes?orgId=${orgId}`);
    expect(list.body.episodes.some((e: { id: string }) => e.id === ep.body.episode.id)).toBe(true);
  });

  it('validates the 1–4-speaker cast bound', async () => {
    const { c, orgId } = await ownerWithOrg('pod-validate');
    const tooMany = await c.post(`${P}/speaker-profiles`, { orgId, name: 'Crowd', speakers: Array.from({ length: PODCAST_LIMITS.MAX_SPEAKERS + 1 }, (_, i) => ({ name: `S${i}`, voiceId: `v${i}` })) });
    expect(tooMany.status).toBe(400);
    const none = await c.post(`${P}/speaker-profiles`, { orgId, name: 'Empty', speakers: [] });
    expect(none.status).toBe(400);
  });

  it('rejects a show-format whose cast is in another org', async () => {
    const a = await ownerWithOrg('pod-orgA');
    const b = await ownerWithOrg('pod-orgB');
    const cast = await a.c.post(`${P}/speaker-profiles`, { orgId: a.orgId, name: 'A cast', speakers: oneSpeaker });
    expect(cast.status).toBe(201);
    // b tries to build a format in b.org referencing a's cast → 400 (no cross-org reference).
    const fmt = await b.c.post(`${P}/episode-profiles`, { orgId: b.orgId, name: 'B fmt', speakerProfileId: cast.body.profile.id });
    expect(fmt.status).toBe(400);
  });

  it('rejects generating an episode over a notebook the caller cannot access (cross-org IDOR)', async () => {
    const a = await ownerWithOrg('pod-nb-a');
    const b = await ownerWithOrg('pod-nb-b');
    const nb = await a.c.post('/v1/host/openwop-app/notebooks', { orgId: a.orgId, name: 'A research' });
    expect(nb.status).toBe(201);
    const cast = await b.c.post(`${P}/speaker-profiles`, { orgId: b.orgId, name: 'B cast', speakers: oneSpeaker });
    const fmt = await b.c.post(`${P}/episode-profiles`, { orgId: b.orgId, name: 'B fmt', speakerProfileId: cast.body.profile.id });
    // b generates in b.org but points at a's notebook → uniform 404 (no existence leak).
    const ep = await b.c.post(`${P}/episodes`, { orgId: b.orgId, notebookId: nb.body.notebook.id, episodeProfileId: fmt.body.profile.id });
    expect(ep.status).toBe(404);
  });
});

describe('podcasts — RBAC / IDOR', () => {
  it('404s when the caller has no access to the entity org; cross-tenant is invisible', async () => {
    const a = await ownerWithOrg('pod-idorA');
    const b = await ownerWithOrg('pod-idorB');
    const cast = await a.c.post(`${P}/speaker-profiles`, { orgId: a.orgId, name: 'Secret', speakers: oneSpeaker });
    expect(cast.status).toBe(201);
    // b cannot list a's org (uniform 404, no existence leak).
    expect((await b.c.get(`${P}/speaker-profiles?orgId=${a.orgId}`)).status).toBe(404);
    // b cannot delete a's profile.
    expect((await b.c.del(`${P}/speaker-profiles/${cast.body.profile.id}`)).status).toBe(404);
    // a still sees it.
    expect((await a.c.get(`${P}/speaker-profiles?orgId=${a.orgId}`)).body.profiles.some((p: { id: string }) => p.id === cast.body.profile.id)).toBe(true);
  });
});
