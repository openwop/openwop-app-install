/**
 * Multi-speaker podcasts (ADR 0086) — ROUTE harness. Proves the feature-package
 * vertical slice: toggle-gated (404 while off), org-scoped RBAC + tenant IDOR
 * (uniform 404), 1–4-speaker / 3–20-segment validation, and that generating an
 * episode ENQUEUES a run (202 + a PERSISTED runId) rather than calling a model
 * synchronously. CPU-2: episode reads are gated on the notebook's own access.
 *
 * The toggle is enabled via the saveConfig SERVICE (the global default), the same
 * mechanism the notebooks/projects route tests use.
 *
 * The org-level cases run TWO orgs in ONE tenant on purpose: a cross-TENANT caller
 * never reaches the org check (the tenant-keyed lookup is already null), so a
 * cross-tenant fixture cannot witness an org guard (/grade-tests w21).
 *
 * Sabotage witnesses (w21 g2): `projectStatus` drops the `waiting-`/`cancelled`
 * arms; `normalizeSpeakers` bounds off by one; `createEpisodeProfile` drops
 * `cast.orgId !== orgId`; POST /episodes drops `nbProject.orgId !== orgId`;
 * `enqueueGeneration` drops `setEpisodeRun`; the speaker-profile list / DELETE
 * drop their `workspace:read` gate; `notebookReadable` returns true / denies
 * orphans; the list or GET skips `notebookReadable`; a route skips
 * `requireFeatureEnabled`.
 *
 * @see docs/adr/0086-multi-speaker-podcasts.md
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { projectStatus, PODCAST_LIMITS } from '../src/features/podcasts/podcastsService.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createMember } from '../src/host/accessControlService.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['podcasts', 'notebooks', 'kb', 'users']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

// ── Wire shapes this file reads (declared, never `any`) ──────────────────────
interface ErrorBody { error: string; message: string }
interface LoginBody { user: { userId: string } }
interface OrgBody { orgId: string }
interface NotebookBody { notebook: { id: string } }
interface SpeakerProfileBody { profile: { id: string; speakers: unknown[] } }
interface EpisodeProfileBody { profile: { id: string; segmentCount: number } }
interface ProfileListBody { profiles: Array<{ id: string }> }
interface EpisodeRow { id: string; runId?: string; status: string }
interface EpisodeBody { episode: EpisodeRow }
interface EpisodeListBody { episodes: EpisodeRow[] }

interface Res<T> { status: number; body: T }
interface Client {
  get: <T = ErrorBody>(p: string) => Promise<Res<T>>;
  post: <T = ErrorBody>(p: string, b?: unknown) => Promise<Res<T>>;
  patch: <T = ErrorBody>(p: string, b?: unknown) => Promise<Res<T>>;
  del: <T = ErrorBody>(p: string) => Promise<Res<T>>;
}
function client(): Client {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    // The one boundary where JSON becomes a declared shape; every reader names it.
    const out = (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T;
    return { status: res.status, body: out };
  };
  return {
    get: <T = ErrorBody>(p: string) => call<T>('GET', p),
    post: <T = ErrorBody>(p: string, b?: unknown) => call<T>('POST', p, b),
    patch: <T = ErrorBody>(p: string, b?: unknown) => call<T>('PATCH', p, b),
    del: <T = ErrorBody>(p: string) => call<T>('DELETE', p),
  };
}

const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function ownerWithOrg(who: string): Promise<{ c: Client; orgId: string }> {
  const c = client();
  const r = await c.post<LoginBody>('/host/openwop-app/test/login', { email: uniqEmail(who) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await c.post<OrgBody>('/host/openwop-app/orgs', { name: 'Acme' });
  return { c, orgId: org.body.orgId };
}

// An owner + org pinned to an EXPLICIT tenant so co-tenant callers can share it
// (org membership is tenant-scoped — the default per-session tenant would isolate
// them and every org gate would be masked by the tenant key).
async function ownerInTenant(who: string): Promise<{ c: Client; orgId: string; tenantId: string }> {
  const tenantId = `org:cpu2-${Date.now()}-${n++}`;
  const c = client();
  const r = await c.post<LoginBody>('/host/openwop-app/test/login', { email: uniqEmail(who), tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const orgId = (await c.post<OrgBody>('/host/openwop-app/orgs', { name: 'Acme' })).body.orgId;
  return { c, orgId, tenantId };
}

/** A caller logged in to `tenantId` — NO membership unless `roles` is given. */
async function coTenantUser(tenantId: string, who: string, member?: { orgId: string; roles: string[] }): Promise<{ c: Client; id: string }> {
  const c = client();
  const id = (await c.post<LoginBody>('/host/openwop-app/test/login', { email: uniqEmail(who), tenantId })).body.user.userId;
  if (member) await createMember({ tenantId, orgId: member.orgId, subject: id, displayName: who, roles: member.roles });
  return { c, id };
}

const P = '/host/openwop-app/podcasts';
const oneSpeaker = [{ name: 'Ana', voiceId: 'female-1' }];

describe('podcasts — status projection', () => {
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

describe('podcasts — toggle gate (backend authority)', () => {
  it('404s every podcasts route while the toggle is off', async () => {
    const { c, orgId } = await ownerWithOrg('pod-toggle');
    // CONTROL — the same caller reads while the toggle is on.
    expect((await c.get(`${P}/speaker-profiles?orgId=${orgId}`)).status).toBe(200);
    const d = getToggleDefault('podcasts')!;
    try {
      await saveConfig({ ...d, status: 'off' }, 'test');
      const list = await c.get(`${P}/speaker-profiles?orgId=${orgId}`);
      expect(list.status).toBe(404);
      expect(list.body.error).toBe('not_found');
      expect(list.body.message, 'the TOGGLE refused it, not the org gate').toContain('not enabled');
      const create = await c.post(`${P}/speaker-profiles`, { orgId, name: 'Off', speakers: oneSpeaker });
      expect(create.status).toBe(404);
      expect(create.body.message).toContain('not enabled');
    } finally {
      await saveConfig({ ...d, status: 'on' }, 'test');
    }
  });
});

describe('podcasts — profiles + generation', () => {
  it('creates cast + show-format profiles and enqueues a generation run', async () => {
    const { c, orgId } = await ownerWithOrg('pod-flow');

    // Cast profile (2 speakers).
    const cast = await c.post<SpeakerProfileBody>(`${P}/speaker-profiles`, { orgId, name: 'Duo', speakers: [{ name: 'Ana', voiceId: 'female-1' }, { name: 'Marco', voiceId: 'male-1', personality: 'skeptical' }] });
    expect(cast.status, JSON.stringify(cast.body)).toBe(201);
    const speakerProfileId = cast.body.profile.id;
    expect(cast.body.profile.speakers).toHaveLength(2);

    // Show-format profile referencing the cast.
    const fmt = await c.post<EpisodeProfileBody>(`${P}/episode-profiles`, { orgId, name: 'Weekly', speakerProfileId, segmentCount: 6 });
    expect(fmt.status, JSON.stringify(fmt.body)).toBe(201);
    const episodeProfileId = fmt.body.profile.id;
    expect(fmt.body.profile.segmentCount).toBe(6);

    // A notebook to source from.
    const nb = await c.post<NotebookBody>('/host/openwop-app/notebooks', { orgId, name: 'Research' });
    expect(nb.status).toBe(201);

    // Generate → 202 + a runId (the run does the work async).
    const ep = await c.post<EpisodeBody>(`${P}/episodes`, { orgId, notebookId: nb.body.notebook.id, episodeProfileId, title: 'Ep 1' });
    expect(ep.status, JSON.stringify(ep.body)).toBe(202);
    const runId = ep.body.episode.runId;
    expect(runId).toBeTruthy();

    // The 202 body ECHOES runId/status, so it cannot witness the enqueue. Read the
    // STORED row back: the runId must have been persisted (`setEpisodeRun`), and the
    // status is PROJECTED from the real run (not pinned — the run races this read).
    const got = await c.get<EpisodeBody>(`${P}/episodes/${ep.body.episode.id}`);
    expect(got.status).toBe(200);
    expect(got.body.episode.runId, 'the run id is persisted on the episode, not only echoed').toBe(runId);
    expect(['queued', 'running', 'awaiting-approval', 'done', 'failed']).toContain(got.body.episode.status);

    // It appears in the list, carrying the same persisted run.
    const list = await c.get<EpisodeListBody>(`${P}/episodes?orgId=${orgId}`);
    const row = list.body.episodes.find((e) => e.id === ep.body.episode.id);
    expect(row?.runId).toBe(runId);
  });

  it('validates the 1–4-speaker cast bound', async () => {
    const { c, orgId } = await ownerWithOrg('pod-validate');
    const speakers = (k: number) => Array.from({ length: k }, (_, i) => ({ name: `S${i}`, voiceId: `v${i}` }));
    // Positive boundary: exactly MAX is accepted (the bound is not off by one).
    expect((await c.post(`${P}/speaker-profiles`, { orgId, name: 'Full', speakers: speakers(PODCAST_LIMITS.MAX_SPEAKERS) })).status).toBe(201);
    const tooMany = await c.post(`${P}/speaker-profiles`, { orgId, name: 'Crowd', speakers: speakers(PODCAST_LIMITS.MAX_SPEAKERS + 1) });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error).toBe('validation_error');
    expect(tooMany.body.message).toContain('speakers');
    const none = await c.post(`${P}/speaker-profiles`, { orgId, name: 'Empty', speakers: [] });
    expect(none.status).toBe(400);
    expect(none.body.error).toBe('validation_error');
    expect(none.body.message).toContain('speakers');
  });

  it('rejects a show-format whose cast is in another org', async () => {
    // Same owner, same tenant, TWO orgs — so the lookup finds the cast and only the
    // org comparison can refuse it.
    const { c, orgId: orgA } = await ownerWithOrg('pod-orgA');
    const orgB = (await c.post<OrgBody>('/host/openwop-app/orgs', { name: 'Other' })).body.orgId;
    const cast = await c.post<SpeakerProfileBody>(`${P}/speaker-profiles`, { orgId: orgA, name: 'A cast', speakers: oneSpeaker });
    expect(cast.status).toBe(201);
    // CONTROL — the same cast IS usable in its own org.
    expect((await c.post(`${P}/episode-profiles`, { orgId: orgA, name: 'A fmt', speakerProfileId: cast.body.profile.id })).status).toBe(201);
    const fmt = await c.post(`${P}/episode-profiles`, { orgId: orgB, name: 'B fmt', speakerProfileId: cast.body.profile.id });
    expect(fmt.status).toBe(400);
    expect(fmt.body.error).toBe('validation_error');
    expect(fmt.body.message).toContain('speakerProfileId');
    // And a cross-TENANT caller cannot reference it either.
    const other = await ownerWithOrg('pod-orgX');
    expect((await other.c.post(`${P}/episode-profiles`, { orgId: other.orgId, name: 'X fmt', speakerProfileId: cast.body.profile.id })).status).toBe(400);
  });

  it('rejects generating an episode over a notebook the caller cannot access (cross-org IDOR)', async () => {
    // Same owner, same tenant: the notebook is in org A, the episode is generated in
    // org B. The owner CAN read the notebook — only the org binding refuses it.
    const { c, orgId: orgA } = await ownerWithOrg('pod-nb-a');
    const orgB = (await c.post<OrgBody>('/host/openwop-app/orgs', { name: 'Other' })).body.orgId;
    const nb = await c.post<NotebookBody>('/host/openwop-app/notebooks', { orgId: orgA, name: 'A research' });
    expect(nb.status).toBe(201);
    const cast = await c.post<SpeakerProfileBody>(`${P}/speaker-profiles`, { orgId: orgB, name: 'B cast', speakers: oneSpeaker });
    const fmt = await c.post<EpisodeProfileBody>(`${P}/episode-profiles`, { orgId: orgB, name: 'B fmt', speakerProfileId: cast.body.profile.id });
    expect(fmt.status).toBe(201);
    const ep = await c.post(`${P}/episodes`, { orgId: orgB, notebookId: nb.body.notebook.id, episodeProfileId: fmt.body.profile.id });
    expect(ep.status).toBe(404); // uniform, no existence leak
    expect(ep.body.error).toBe('not_found');
    // The refused generate created nothing.
    expect((await c.get<EpisodeListBody>(`${P}/episodes?orgId=${orgB}`)).body.episodes).toEqual([]);

    // And a cross-TENANT caller pointing at the same notebook is refused too.
    const b = await ownerWithOrg('pod-nb-b');
    const bCast = await b.c.post<SpeakerProfileBody>(`${P}/speaker-profiles`, { orgId: b.orgId, name: 'B cast', speakers: oneSpeaker });
    const bFmt = await b.c.post<EpisodeProfileBody>(`${P}/episode-profiles`, { orgId: b.orgId, name: 'B fmt', speakerProfileId: bCast.body.profile.id });
    expect((await b.c.post(`${P}/episodes`, { orgId: b.orgId, notebookId: nb.body.notebook.id, episodeProfileId: bFmt.body.profile.id })).status).toBe(404);
  });
});

describe('podcasts — episode reads gate on notebook access (CPU-2)', () => {
  const PROJ = '/host/openwop-app/projects';

  async function anEpisodeOverANotebook(owner: Client, orgId: string): Promise<{ notebookId: string; episodeId: string }> {
    const cast = await owner.post<SpeakerProfileBody>(`${P}/speaker-profiles`, { orgId, name: 'Cast', speakers: oneSpeaker });
    const fmt = await owner.post<EpisodeProfileBody>(`${P}/episode-profiles`, { orgId, name: 'Fmt', speakerProfileId: cast.body.profile.id });
    const nb = await owner.post<NotebookBody>('/host/openwop-app/notebooks', { orgId, name: 'Private research' });
    expect(nb.status).toBe(201);
    const ep = await owner.post<EpisodeBody>(`${P}/episodes`, { orgId, notebookId: nb.body.notebook.id, episodeProfileId: fmt.body.profile.id });
    expect(ep.status, JSON.stringify(ep.body)).toBe(202);
    return { notebookId: nb.body.notebook.id, episodeId: ep.body.episode.id };
  }

  const inList = (r: Res<EpisodeListBody>, id: string): boolean => (r.body.episodes ?? []).some((e) => e.id === id);

  it('a private-notebook episode is hidden from a co-org reader who is not a member; restored on membership', async () => {
    const { c: owner, orgId, tenantId } = await ownerInTenant('cpu2-owner');
    const { notebookId, episodeId } = await anEpisodeOverANotebook(owner, orgId);
    // A co-org VIEWER (workspace:read) in the SAME tenant, NOT a notebook member.
    const reader = await coTenantUser(tenantId, 'cpu2-reader', { orgId, roles: ['viewer'] });

    // CONTROL — while the notebook is org-visible, the org reader sees the episode
    // through BOTH read paths. This is what the private flip must take away.
    expect((await reader.c.get(`${P}/episodes/${episodeId}`)).status).toBe(200);
    expect(inList(await reader.c.get<EpisodeListBody>(`${P}/episodes?orgId=${orgId}`), episodeId)).toBe(true);

    // Make the notebook private → the reader is an org member but NOT a notebook
    // member. Born red before CPU-2: org read alone passed, so both still returned it.
    expect((await owner.patch(`${PROJ}/${notebookId}/visibility`, { visibility: 'private' })).status).toBe(200);
    expect((await reader.c.get(`${P}/episodes/${episodeId}`)).status).toBe(404); // uniform, no existence leak
    expect(inList(await reader.c.get<EpisodeListBody>(`${P}/episodes?orgId=${orgId}`), episodeId)).toBe(false);

    // The owner (org writer + notebook member) is unaffected.
    expect((await owner.get(`${P}/episodes/${episodeId}`)).status).toBe(200);
    expect(inList(await owner.get<EpisodeListBody>(`${P}/episodes?orgId=${orgId}`), episodeId)).toBe(true);

    // Add the reader as a notebook member → read is restored on both paths.
    expect((await owner.post(`${PROJ}/${notebookId}/members`, { ref: `user:${reader.id}`, role: 'observer' })).status).toBe(201);
    const back = await reader.c.get<EpisodeBody>(`${P}/episodes/${episodeId}`);
    expect(back.status).toBe(200);
    expect(back.body.episode.id).toBe(episodeId);
    expect(inList(await reader.c.get<EpisodeListBody>(`${P}/episodes?orgId=${orgId}`), episodeId)).toBe(true);
  });

  it('an ORPHANED episode (notebook deleted) stays readable by an org reader — no read-lockout (Option B discriminator)', async () => {
    const { c: owner, orgId, tenantId } = await ownerInTenant('cpu2-orphan-owner');
    const { notebookId, episodeId } = await anEpisodeOverANotebook(owner, orgId);
    await owner.patch(`${PROJ}/${notebookId}/visibility`, { visibility: 'private' });
    const reader = await coTenantUser(tenantId, 'cpu2-orphan-reader', { orgId, roles: ['viewer'] });

    // CONTROL — a private-notebook non-member is denied (as above).
    expect((await reader.c.get(`${P}/episodes/${episodeId}`)).status).toBe(404);

    // Delete the notebook. Project delete does NOT cascade episodes, so the episode is
    // now orphaned. Under the LITERAL !== 'none' gate it would 404 + vanish while DELETE
    // stayed org-scoped — unreachable. Option B falls through to the org-read scope.
    expect((await owner.del(`${PROJ}/${notebookId}`)).status).toBe(200);
    const got = await reader.c.get<EpisodeBody>(`${P}/episodes/${episodeId}`);
    expect(got.status).toBe(200);
    expect(got.body.episode.id).toBe(episodeId);
    expect(inList(await reader.c.get<EpisodeListBody>(`${P}/episodes?orgId=${orgId}`), episodeId)).toBe(true);
  });
});

describe('podcasts — RBAC / IDOR', () => {
  it('404s when the caller has no access to the entity org; cross-tenant is invisible', async () => {
    const { c: owner, orgId, tenantId } = await ownerInTenant('pod-idorA');
    const cast = await owner.post<SpeakerProfileBody>(`${P}/speaker-profiles`, { orgId, name: 'Secret', speakers: oneSpeaker });
    expect(cast.status).toBe(201);
    const castId = cast.body.profile.id;

    // SAME tenant, NOT an org member: the profile row resolves, so only the org
    // read gate can refuse — uniform 404 (no 403, which would confirm existence).
    const outsider = await coTenantUser(tenantId, 'pod-idor-outsider');
    expect((await outsider.c.get(`${P}/speaker-profiles?orgId=${orgId}`)).status).toBe(404);
    const del = await outsider.c.del(`${P}/speaker-profiles/${castId}`);
    expect(del.status).toBe(404);
    expect(del.body.error).toBe('not_found');

    // A different TENANT cannot list or delete it either.
    const b = await ownerWithOrg('pod-idorB');
    expect((await b.c.get(`${P}/speaker-profiles?orgId=${orgId}`)).status).toBe(404);
    expect((await b.c.del(`${P}/speaker-profiles/${castId}`)).status).toBe(404);

    // The owner still sees it — neither refused delete landed.
    expect((await owner.get<ProfileListBody>(`${P}/speaker-profiles?orgId=${orgId}`)).body.profiles.some((p) => p.id === castId)).toBe(true);
  });
});
