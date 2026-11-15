/**
 * ADR 1115 — podcasts has ONE episode-access rule (`podcastsAccess.ts`), and every lane
 * asks it: the `:id` doors, the generation doors, the run lane (`ctx.features.podcasts`)
 * and the subject eraser's store.
 *
 * Before: the read doors checked the episode's private notebook and the write doors did
 * not (`PODC93-4`: a non-member org writer published a private notebook's episode); the
 * route doors started the run with NO actor (`PODC93-1`: a private notebook was read as
 * nothing and the episode generated ungrounded); and the run lane was tenant-trusted
 * (`PODC93-2`: a run for an org-A member read and wrote org B's episodes by id).
 *
 * Demo mode is OFF (the single-principal demo arm would make every refusal vacuous) and
 * every case runs in a multi-person `org:` tenant with two orgs, so the org guard is what
 * refuses, not the tenant key.
 *
 * Sabotage (each reds the named case on `origin/main`'s code): the run lane's
 * `resolveForRun` returning the row unchecked reds R1–R4; `requireEpisode` skipping
 * `notebookReadableBy` reds D1; `enqueueGeneration` dropping `actingUserId` reds D3;
 * `generateTargetAccess` skipping `notebookAccess` reds D4a; `liveRunOf` reading an
 * absent run as live reds D5c; the publish guard removed reds D5d.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { selectContent, outline } from '../../../packs/feature.podcasts.nodes/index.mjs';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { setProjectVisibility } from '../src/features/projects/projectsService.js';
import { storeMediaAsset } from '../src/host/inMemorySurfaces.js';
import { buildPodcastsSurface } from '../src/features/podcasts/surface.js';
import {
  createEpisode, getEpisode, recordEpisodeResult, createShow, getShow, setEpisodePublish,
  createSpeakerProfile, createEpisodeProfile, claimEpisodeGeneration, isLiveRunStatus,
  erasePodcastsSubject,
} from '../src/features/podcasts/podcastsService.js';

let BASE: string;
let server: http.Server;
let storage: Storage;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'kb', 'notebooks', 'podcasts']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: Record<string, unknown> }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out: unknown = res.status === 204 ? {} : await res.json().catch(() => ({}));
    return { status: res.status, body: JSON.parse(JSON.stringify(out ?? {})) };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), del: (p) => call('DELETE', p) };
}

const H = '/host/openwop-app';
const P = `${H}/podcasts`;

/** JSON round-trip narrowing of a surface result (its contract is Record<string, unknown>). */
function as<T>(v: unknown): T { return JSON.parse(JSON.stringify(v)); }
interface Refusal { error?: { code: string } }
interface Write { found: boolean; recorded: boolean; refused?: string }

async function login(c: Client, tenantId: string, who: string): Promise<string> {
  const r = await c.post(`${H}/test/login`, { email: `pod1113-${who}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return (r.body.user as { userId: string }).userId;
}

/** Owner of orgA + orgB; an editor and a viewer in orgA only; a provisioned notebook in
 *  each org; a cast + format + a SEEDED episode (service-created, no run) in each org. */
async function fixture() {
  const tenantId = `org:pod1113-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId = await login(owner, tenantId, 'owner');
  const editor = client();
  const editorId = await login(editor, tenantId, 'editor');
  const viewer = client();
  const viewerId = await login(viewer, tenantId, 'viewer');
  const orgA = (await owner.post(`${H}/orgs`, { name: 'Everyone' })).body.orgId as string;
  const orgB = (await owner.post(`${H}/orgs`, { name: 'Finance' })).body.orgId as string;
  for (const [subject, roles] of [[editorId, ['editor']], [viewerId, ['viewer']]] as const) {
    const add = await owner.post(`${H}/orgs/${encodeURIComponent(orgA)}/members`, { displayName: 'M', subject, roles });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
  }
  const seed = async (orgId: string, name: string) => {
    const nb = await owner.post(`${H}/notebooks`, { orgId, name });
    expect(nb.status, JSON.stringify(nb.body)).toBe(201);
    const notebookId = (nb.body.notebook as { id: string }).id;
    const cast = await createSpeakerProfile(tenantId, orgId, { name: `${name} cast`, speakers: [{ name: 'Ana', voiceId: 'v1' }] });
    const format = await createEpisodeProfile(tenantId, orgId, { name: `${name} format`, speakerProfileId: cast.id });
    const episode = await createEpisode(tenantId, orgId, { notebookId, episodeProfileId: format.id, title: `${name} episode` });
    return { notebookId, castId: cast.id, formatId: format.id, episodeId: episode.id };
  };
  const a = await seed(orgA, 'Handbook');
  const b = await seed(orgB, 'Finance');
  return { tenantId, owner, editor, viewer, ownerId, editorId, viewerId, orgA, orgB, a, b };
}

/** A run-lane surface for `actingUserId`. With no `runId` the claim check is skipped
 *  (only a test builds one so); R7 passes a `runId` to witness the claim. */
const asActor = (tenantId: string, actingUserId?: string, runId?: string) =>
  buildPodcastsSurface({ tenantId, ...(runId ? { runId } : {}), ...(actingUserId ? { actingUserId } : {}) });

describe('ADR 1115 D2 — the run lane gives the doors\' answer', () => {
  it('R1 a run for an org-A member can neither read nor write an org-B episode', async () => {
    const f = await fixture();
    // The door's answer first: org B's episode does not exist for this person.
    expect((await f.editor.get(`${P}/episodes/${f.b.episodeId}`)).status).toBe(404);
    const s = asActor(f.tenantId, f.editorId);
    expect(as<{ episode: unknown; refused?: string }>(await s.getEpisode({ episodeId: f.b.episodeId }))).toEqual({ episode: null, refused: 'podcast_episode_not_found' });
    expect(as<{ profile: unknown }>(await s.getEpisodeProfile({ id: f.b.formatId })).profile).toBeNull();
    expect(as<{ profile: unknown }>(await s.getSpeakerProfile({ id: f.b.castId })).profile).toBeNull();
    expect(as<Refusal>(await s.authorizeGeneration({ episodeId: f.b.episodeId })).error?.code).toBe('podcast_episode_not_found');
    const w = as<Write>(await s.recordEpisodeResult({ episodeId: f.b.episodeId, audioMediaRef: '/assets/attacker', error: 'x' }));
    expect(w).toMatchObject({ found: false, recorded: false, refused: 'podcast_episode_not_found' });
    expect(as<{ url: string; refused?: string }>(await s.mixClips({ episodeId: f.b.episodeId })).refused).toBe('podcast_episode_not_found');
    const row = await getEpisode(f.tenantId, f.b.episodeId);
    expect(row?.audioMediaRef, 'the refused write landed nothing').toBeUndefined();
    expect(row?.error).toBeUndefined();
    // CONTROL — the same person's run reads and writes their own org's episode.
    expect(as<{ episode: { id: string } | null }>(await s.getEpisode({ episodeId: f.a.episodeId })).episode?.id).toBe(f.a.episodeId);
    expect(as<Write>(await s.recordEpisodeResult({ episodeId: f.a.episodeId, outlineDocRef: 'doc:ok' })).recorded).toBe(true);
  });

  it('R2 a person who can read but not write the episode is refused every write', async () => {
    const f = await fixture();
    const s = asActor(f.tenantId, f.viewerId);
    expect(as<{ episode: { id: string } | null }>(await s.getEpisode({ episodeId: f.a.episodeId })).episode?.id).toBe(f.a.episodeId);
    expect(as<Refusal>(await s.authorizeGeneration({ episodeId: f.a.episodeId })).error?.code).toBe('podcast_write_forbidden');
    expect(as<Write>(await s.recordEpisodeResult({ episodeId: f.a.episodeId, outlineDocRef: 'doc:viewer' })).refused).toBe('podcast_write_forbidden');
    expect((await getEpisode(f.tenantId, f.a.episodeId))?.outlineDocRef).toBeUndefined();
  });

  it('R3 a run with no person is refused everything, with its own code', async () => {
    const f = await fixture();
    const s = asActor(f.tenantId);
    expect(as<{ refused?: string }>(await s.getEpisode({ episodeId: f.a.episodeId })).refused).toBe('podcast_run_needs_person');
    expect(as<Refusal>(await s.authorizeGeneration({ episodeId: f.a.episodeId })).error?.code).toBe('podcast_run_needs_person');
    expect(as<Write>(await s.recordEpisodeResult({ episodeId: f.a.episodeId, error: 'x' })).refused).toBe('podcast_run_needs_person');
    expect(as<{ episodes: unknown[] }>(await s.listEpisodes({ orgId: f.orgA })).episodes).toEqual([]);
  });

  it('R4 a private notebook\'s episode is hidden from an org reader who is not a notebook member', async () => {
    // A non-member reader. Since ADR 1118 a non-member editor is hidden too (below).
    const f = await fixture();
    await setProjectVisibility(f.tenantId, f.a.notebookId, 'private');
    expect((await f.viewer.get(`${P}/episodes/${f.a.episodeId}`)).status).toBe(404); // the door
    expect((await f.editor.get(`${P}/episodes/${f.a.episodeId}`)).status, 'ADR 1118: a non-member org editor is hidden as well').toBe(404);
    const s = asActor(f.tenantId, f.viewerId);
    expect(as<{ episode: unknown }>(await s.getEpisode({ episodeId: f.a.episodeId })).episode).toBeNull();
    const listed = as<{ episodes: Array<{ id: string }> }>(await s.listEpisodes({ orgId: f.orgA })).episodes.map((e) => e.id);
    expect(listed).not.toContain(f.a.episodeId);
    // CONTROL — the owner (a member of the private notebook) still sees it.
    const mine = as<{ episodes: Array<{ id: string }> }>(await asActor(f.tenantId, f.ownerId).listEpisodes({ orgId: f.orgA })).episodes.map((e) => e.id);
    expect(mine).toContain(f.a.episodeId);
  });

  it('R5 authorizeGeneration resolves the episode, its format and its cast for a writer', async () => {
    const f = await fixture();
    const out = as<{ episode?: { id: string }; episodeProfile?: { id: string }; speakerProfile?: { id: string } }>(
      await asActor(f.tenantId, f.ownerId).authorizeGeneration({ episodeId: f.a.episodeId }),
    );
    expect([out.episode?.id, out.episodeProfile?.id, out.speakerProfile?.id]).toEqual([f.a.episodeId, f.a.formatId, f.a.castId]);
  });

  it('R6 mixClips muxes the episode\'s STORED clips, never the URLs a node passes', async () => {
    const f = await fixture();
    const foreign = await storeMediaAsset(f.tenantId, { contentBase64: Buffer.from('ID3fake-mp3').toString('base64'), contentType: 'audio/mpeg' });
    // The episode holds no clips; the node passes a real asset's URL. Nothing is muxed.
    const out = as<{ url: string; refused?: string }>(await asActor(f.tenantId, f.ownerId).mixClips({ episodeId: f.a.episodeId, clips: [{ url: foreign.url }] }));
    expect(out).toEqual({ url: '' });
  });
});

describe('ADR 1115 D2 — a write needs the CLAIMED run and an unpublished episode', () => {
  it('R7 an unclaimed run (a direct start, a fork, a retry\'s loser) writes nothing; the claimed run does', async () => {
    const f = await fixture();
    const read = (await getEpisode(f.tenantId, f.a.episodeId))!;
    await claimEpisodeGeneration(f.tenantId, read, 'run-claimed');
    const stranger = asActor(f.tenantId, f.ownerId, 'run-direct');
    expect(as<Refusal>(await stranger.authorizeGeneration({ episodeId: f.a.episodeId })).error?.code).toBe('podcast_run_not_claimed');
    expect(as<Write>(await stranger.recordEpisodeResult({ episodeId: f.a.episodeId, outlineDocRef: 'doc:stranger' })).refused).toBe('podcast_run_not_claimed');
    expect(as<{ ok?: boolean; error?: { code: string } }>(await stranger.checkWrite({ episodeId: f.a.episodeId })).error?.code).toBe('podcast_run_not_claimed');
    // Reads are not claim-gated: the stranger run can still read the row.
    expect(as<{ episode: { id: string } | null }>(await stranger.getEpisode({ episodeId: f.a.episodeId })).episode?.id).toBe(f.a.episodeId);
    const claimed = asActor(f.tenantId, f.ownerId, 'run-claimed');
    expect(as<Write>(await claimed.recordEpisodeResult({ episodeId: f.a.episodeId, outlineDocRef: 'doc:claimed' })).recorded).toBe(true);
    expect((await getEpisode(f.tenantId, f.a.episodeId))?.outlineDocRef).toBe('doc:claimed');
  });

  it('R7b a FORK (new runId) fails TYPED at its first node and writes nothing — never success-with-nothing', async () => {
    const f = await fixture();
    const read = (await getEpisode(f.tenantId, f.a.episodeId))!;
    await claimEpisodeGeneration(f.tenantId, read, 'run-original');
    const before = JSON.stringify(await getEpisode(f.tenantId, f.a.episodeId));
    // The fork re-executes the unserved nodes against a surface built for ITS run id.
    const fork = asActor(f.tenantId, f.ownerId, 'run-fork');
    const callAI = vi.fn(async () => ({ content: '1. a' }));
    const sel = await selectContent({ inputs: { episodeId: f.a.episodeId }, features: { podcasts: fork, notebooks: { getNotebook: async () => ({ notebook: { id: 'x' } }), ask: async () => ({ augmentedPrompt: 'src' }) } } });
    expect([sel.status, sel.error?.code]).toEqual(['failed', 'podcast_run_not_claimed']);
    const out = await outline({ inputs: { episodeId: f.a.episodeId, context: 'c' }, features: { podcasts: fork }, callAI });
    expect([out.status, out.error?.code]).toEqual(['failed', 'podcast_run_not_claimed']);
    expect(callAI, 'the fork paid for nothing').not.toHaveBeenCalled();
    expect(JSON.stringify(await getEpisode(f.tenantId, f.a.episodeId)), 'the episode is unchanged').toBe(before);
    // CONTROL — the SAME run re-executing (a resume after a crash: same runId) is allowed.
    const same = asActor(f.tenantId, f.ownerId, 'run-original');
    expect(as<{ ok?: boolean }>(await same.checkWrite({ episodeId: f.a.episodeId })).ok).toBe(true);
  });

  it('R8 no run replaces a PUBLISHED episode\'s audio, even its own claimed run', async () => {
    const f = await fixture();
    const read = (await getEpisode(f.tenantId, f.a.episodeId))!;
    await claimEpisodeGeneration(f.tenantId, read, 'run-pub');
    await recordEpisodeResult(f.tenantId, f.a.episodeId, { audioMediaRef: '/assets/public-audio' });
    const show = await createShow(f.tenantId, f.orgA, f.ownerId, { title: 'Show', author: 'Acme' });
    await setEpisodePublish(f.tenantId, f.a.episodeId, { published: true, showId: show.id });
    const s = asActor(f.tenantId, f.ownerId, 'run-pub');
    const w = as<Write>(await s.recordEpisodeResult({ episodeId: f.a.episodeId, clips: [{ speaker: 'A', voiceId: 'v', url: '/assets/x', mimeType: 'audio/mpeg' }] }));
    expect(w.refused).toBe('podcast_episode_published');
    expect(as<{ refused?: string }>(await s.mixClips({ episodeId: f.a.episodeId })).refused).toBe('podcast_episode_published');
    expect((await getEpisode(f.tenantId, f.a.episodeId))?.audioMediaRef).toBe('/assets/public-audio');
  });
});

describe('ADR 1115 D1 — the :id write doors ask the notebook question', () => {
  it('D1 a non-member org reader gets 404, not 403, on retry, publish, unpublish and delete of a private notebook\'s episode', async () => {
    const f = await fixture();
    // CONTROL: on an org-visible notebook the reader is refused for write (403).
    expect((await f.viewer.post(`${P}/episodes/${f.a.episodeId}/publish`, {})).status).toBe(403);
    await setProjectVisibility(f.tenantId, f.a.notebookId, 'private');
    for (const [method, path] of [
      ['post', `${P}/episodes/${f.a.episodeId}/retry`],
      ['post', `${P}/episodes/${f.a.episodeId}/publish`],
      ['post', `${P}/episodes/${f.a.episodeId}/unpublish`],
      ['del', `${P}/episodes/${f.a.episodeId}`],
    ] as const) {
      const r = method === 'del' ? await f.viewer.del(path) : await f.viewer.post(path, {});
      expect(r.status, `${method} ${path}`).toBe(404);
    }
    expect(await getEpisode(f.tenantId, f.a.episodeId), 'nothing was deleted').not.toBeNull();
    // CONTROL — with the notebook org-visible again, an org writer reaches the door
    // (publish then answers its own readiness refusal, not 404).
    await setProjectVisibility(f.tenantId, f.a.notebookId, 'org');
    expect((await f.editor.post(`${P}/episodes/${f.a.episodeId}/publish`, {})).status).toBe(409);
  });
});

describe('ADR 1115 D3/D4 — the generation doors', () => {
  it('D3 a route-started run acts for the caller', async () => {
    const f = await fixture();
    const ep = await f.owner.post(`${P}/episodes`, { orgId: f.orgA, notebookId: f.a.notebookId, episodeProfileId: f.a.formatId });
    expect(ep.status, JSON.stringify(ep.body)).toBe(202);
    const runId = (ep.body.episode as { runId: string }).runId;
    const run = await storage.getRun(runId);
    expect(run?.metadata.actingUserId, 'the run acts for the person the door authorized').toBe(f.ownerId);
    expect((await getEpisode(f.tenantId, (ep.body.episode as { id: string }).id))?.runId).toBe(runId);
  });

  it('D4a a project with no source collection is refused at the door, not at run time', async () => {
    const f = await fixture();
    const project = await f.owner.post(`${H}/projects`, { orgId: f.orgA, name: 'Plain project' });
    expect(project.status, JSON.stringify(project.body)).toBe(201);
    const projectId = ((project.body.project ?? project.body) as { id: string }).id;
    const r = await f.owner.post(`${P}/episodes`, { orgId: f.orgA, notebookId: projectId, episodeProfileId: f.a.formatId });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(JSON.stringify(r.body)).toContain('notebook_has_no_sources');
  });

  it('D4b with notebooks turned off, generation is refused typed', async () => {
    const f = await fixture();
    const d = getToggleDefault('notebooks')!;
    try {
      await saveConfig({ ...d, status: 'off' }, 'test');
      const r = await f.owner.post(`${P}/episodes`, { orgId: f.orgA, notebookId: f.a.notebookId, episodeProfileId: f.a.formatId });
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(JSON.stringify(r.body)).toContain('notebooks_disabled');
    } finally {
      await saveConfig({ ...d, status: 'on' }, 'test');
    }
  });
});

describe('ADR 1115 D5 — retry and publish say no when the state is wrong', () => {
  it('D5a retry of a published episode is 409, and the public audio is untouched', async () => {
    const f = await fixture();
    await recordEpisodeResult(f.tenantId, f.a.episodeId, { audioMediaRef: '/assets/live-audio' });
    const show = await createShow(f.tenantId, f.orgA, f.ownerId, { title: 'Show', author: 'Acme' });
    await setEpisodePublish(f.tenantId, f.a.episodeId, { published: true, showId: show.id });
    const r = await f.owner.post(`${P}/episodes/${f.a.episodeId}/retry`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(JSON.stringify(r.body)).toContain('episode_published');
    const row = await getEpisode(f.tenantId, f.a.episodeId);
    expect([row?.audioMediaRef, row?.runId]).toEqual(['/assets/live-audio', undefined]);
  });

  it('D5b retry while a live run exists is 409 and names the run', async () => {
    const f = await fixture();
    const now = new Date().toISOString();
    const liveRunId = `live-${n++}`;
    await storage.insertRun({ runId: liveRunId, workflowId: 'podcasts.test.live', tenantId: f.tenantId, status: 'waiting-approval', inputs: null, metadata: {}, configurable: {}, createdAt: now, updatedAt: now });
    const read = (await getEpisode(f.tenantId, f.a.episodeId))!;
    expect(await claimEpisodeGeneration(f.tenantId, read, liveRunId)).not.toBeNull();
    const r = await f.owner.post(`${P}/episodes/${f.a.episodeId}/retry`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(JSON.stringify(r.body)).toContain('generation_in_progress');
    expect(JSON.stringify(r.body)).toContain(liveRunId);
  });

  it('D5c an ABSENT run row is not live: retry goes ahead (no lock-forever)', async () => {
    const f = await fixture();
    const read = (await getEpisode(f.tenantId, f.a.episodeId))!;
    expect(await claimEpisodeGeneration(f.tenantId, read, 'run-that-was-purged')).not.toBeNull();
    const r = await f.owner.post(`${P}/episodes/${f.a.episodeId}/retry`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect((r.body.episode as { runId: string }).runId).not.toBe('run-that-was-purged');
  });

  it('D5d publish needs audio; a seeded episode with audio and no run publishes', async () => {
    const f = await fixture();
    const show = await createShow(f.tenantId, f.orgA, f.ownerId, { title: 'Show', author: 'Acme' });
    const none = await f.owner.post(`${P}/episodes/${f.a.episodeId}/publish`, { showId: show.id });
    expect(none.status, JSON.stringify(none.body)).toBe(409);
    expect(JSON.stringify(none.body)).toContain('episode_not_ready');
    await recordEpisodeResult(f.tenantId, f.a.episodeId, { audioMediaRef: '/assets/seeded' });
    const ok = await f.owner.post(`${P}/episodes/${f.a.episodeId}/publish`, { showId: show.id });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('D5f retry of an episode whose notebook was deleted is a 409 that says so, not a 404', async () => {
    const f = await fixture();
    expect((await f.owner.del(`${H}/projects/${f.a.notebookId}`)).status).toBe(200);
    const r = await f.owner.post(`${P}/episodes/${f.a.episodeId}/retry`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(JSON.stringify(r.body)).toContain('notebook_unavailable');
    // and the list says so too, so the Studio does not offer the button.
    const list = await f.owner.get(`${P}/episodes?orgId=${f.orgA}`);
    const row = (list.body.episodes as Array<{ id: string; notebookMissing?: boolean }>).find((e) => e.id === f.a.episodeId);
    expect(row?.notebookMissing).toBe(true);
  });

  it('D5e two retries racing one read: exactly one claim wins', async () => {
    const f = await fixture();
    const read = (await getEpisode(f.tenantId, f.a.episodeId))!;
    const [x, y] = await Promise.all([
      claimEpisodeGeneration(f.tenantId, read, 'run-x'),
      claimEpisodeGeneration(f.tenantId, read, 'run-y'),
    ]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
  });

  it('isLiveRunStatus: absent and terminal are not live', () => {
    expect([undefined, 'completed', 'failed', 'cancelled'].map(isLiveRunStatus)).toEqual([false, false, false, false]);
    expect(['pending', 'running', 'waiting-approval'].map(isLiveRunStatus)).toEqual([true, true, true]);
  });
});

describe('ADR 1115 D2 — audio provenance', () => {
  it('new clips without new audio clear the previous run\'s audio', async () => {
    const f = await fixture();
    await recordEpisodeResult(f.tenantId, f.a.episodeId, { audioMediaRef: '/assets/old-mix' });
    await recordEpisodeResult(f.tenantId, f.a.episodeId, { clips: [{ speaker: 'Ana', voiceId: 'v1', url: '/assets/new-clip', mimeType: 'audio/mpeg' }] });
    expect((await getEpisode(f.tenantId, f.a.episodeId))?.audioMediaRef).toBeUndefined();
  });
});

describe('ADR 1115 D8 — erasure scrubs the person, keeps the show', () => {
  it('an email key removes the owner contact; a user key tombstones createdBy; other shows are untouched', async () => {
    const f = await fixture();
    const mine = await createShow(f.tenantId, f.orgA, f.ownerId, { title: 'Mine', author: 'Acme', ownerName: 'Pat Owner', ownerEmail: 'Pat@Acme.test' });
    const other = await createShow(f.tenantId, f.orgA, f.editorId, { title: 'Other', author: 'Acme', ownerName: 'Sam', ownerEmail: 'sam@acme.test' });
    expect((await erasePodcastsSubject(f.tenantId, 'pat@acme.test')).rowsTouched).toBe(1);
    const scrubbed = await getShow(f.tenantId, mine.id);
    expect([scrubbed?.ownerEmail, scrubbed?.ownerName, scrubbed?.title]).toEqual([undefined, undefined, 'Mine']);
    expect((await erasePodcastsSubject(f.tenantId, f.ownerId)).rowsTouched).toBe(1);
    expect((await getShow(f.tenantId, mine.id))?.createdBy).toBe('erased:subject');
    const kept = await getShow(f.tenantId, other.id);
    expect([kept?.ownerEmail, kept?.createdBy]).toEqual(['sam@acme.test', f.editorId]);
    // Idempotent.
    expect((await erasePodcastsSubject(f.tenantId, 'pat@acme.test')).rowsTouched).toBe(0);
  });
});
