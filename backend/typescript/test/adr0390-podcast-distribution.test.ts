/**
 * ADR 0390 — public podcast distribution route gates.
 *
 * Proves the vertical slice end-to-end (createApp HTTP harness, the adr0384
 * route-test precedent):
 *  - the show + episode publish flags are the editorial gate: an unpublished
 *    show / episode is a UNIFORM 404 on every public surface (index, show page,
 *    episode page, feed, audio);
 *  - a published show serves `feed.xml` with the iTunes namespace + an
 *    `<enclosure>` (byte length + type) + a stable `<guid>`;
 *  - the Range-capable audio route: 200 full (with Accept-Ranges), 206 for
 *    `Range: bytes=0-99` (with Content-Range), 404 for an unpublished / foreign-
 *    tenant episode;
 *  - publish flips require `workspace:write` (unauthed → 403).
 *
 * Episodes are normally produced by the ADR 0086 generation RUN; the test drives
 * the service directly to set an episode's `audioMediaRef` (a stored Media asset)
 * so the public surface can be exercised without running the pipeline. The
 * publish flips themselves go through the AUTHED HTTP routes (to exercise RBAC).
 *
 * @see docs/adr/0390-podcast-public-distribution.md
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getOrg } from '../src/host/accessControlService.js';
import { storeMediaAsset } from '../src/host/inMemorySurfaces.js';
import { createEpisode, recordEpisodeResult, type PodcastEpisode } from '../src/features/podcasts/podcastsService.js';

let BASE: string; let PORT = 0; let server: http.Server; let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { PORT = (server.address() as AddressInfo).port; BASE = `http://127.0.0.1:${PORT}`; res(); }); });
  for (const id of ['podcasts', 'users']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; put: (p: string, b?: unknown) => Promise<Res>; delete: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), delete: (p) => call('DELETE', p) };
}

/** A raw GET with arbitrary headers, returning text + headers (for feed XML +
 *  the Range/HEAD audio checks). */
function rawGet(path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('binary'), headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

const P = '/v1/host/openwop-app/podcasts';
const PUB = (orgId: string): string => `/v1/host/openwop-app/public/${encodeURIComponent(orgId)}/podcasts`;
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;

async function ownerWithOrg(who: string): Promise<{ c: Client; orgId: string; tenantId: string }> {
  const c = client();
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail(who) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme Media' });
  const orgId = org.body.orgId as string;
  const tenantId = (await getOrg(orgId))!.tenantId;
  return { c, orgId, tenantId };
}

/** Seed an episode with resolvable audio bytes of `size` bytes (via the service,
 *  bypassing the generation run). Returns the tracking record. */
async function seedEpisodeWithAudio(tenantId: string, orgId: string, title: string, size: number): Promise<PodcastEpisode> {
  const contentBase64 = Buffer.alloc(size, 7).toString('base64');
  const asset = await storeMediaAsset(tenantId, { contentBase64, contentType: 'audio/mpeg' });
  const ep = await createEpisode(tenantId, orgId, { notebookId: 'nb-1', episodeProfileId: 'ep-profile-1', title });
  await recordEpisodeResult(tenantId, ep.id, { audioMediaRef: asset.url });
  return ep;
}

/** Create + publish a show, then bind + publish an episode on it. */
async function publishedShowWithEpisode(who: string): Promise<{
  c: Client; orgId: string; tenantId: string; showSlug: string; showId: string; episodeId: string; episodeSlug: string;
}> {
  const { c, orgId, tenantId } = await ownerWithOrg(who);
  const created = await c.post(`${P}/shows`, {
    orgId, title: 'The Acme Hour', author: 'Acme', description: 'Weekly acme talk',
    category: 'Technology', explicit: false, ownerName: 'Acme', ownerEmail: 'pod@acme.test', languageCode: 'en',
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const showId = created.body.show.id as string;
  const showSlug = created.body.show.slug as string;
  expect((await c.post(`${P}/shows/${showId}/publish`)).status).toBe(200);
  const ep = await seedEpisodeWithAudio(tenantId, orgId, 'Episode One', 512);
  const pub = await c.post(`${P}/episodes/${ep.id}/publish`, { showId });
  expect(pub.status, JSON.stringify(pub.body)).toBe(200);
  const episodeSlug = pub.body.episode.slug as string;
  return { c, orgId, tenantId, showSlug, showId, episodeId: ep.id, episodeSlug };
}

describe('ADR 0390 — publish RBAC (workspace:write)', () => {
  it('creating a show requires workspace:write (unauthed → 403); flipping an existing one is a uniform 404', async () => {
    const { orgId, showId } = await publishedShowWithEpisode('rbac');
    const anon = client();
    // Create (no entity yet) → the write gate fires directly: 403.
    expect((await anon.post(`${P}/shows`, { orgId, title: 'X', author: 'Y' })).status).toBe(403);
    // Flip an EXISTING show without even read access → uniform 404 (the routes.ts
    // no-existence-leak IDOR convention: a caller who can't read can't learn it exists).
    expect((await anon.post(`${P}/shows/${showId}/publish`)).status).toBe(404);
  });

  it('publishing an episode requires access + a valid same-org show', async () => {
    const { c, orgId, tenantId, showId } = await publishedShowWithEpisode('rbac2');
    const ep = await seedEpisodeWithAudio(tenantId, orgId, 'Draft Ep', 256);
    // unauthed publish of an existing episode → uniform 404 (no-existence-leak)
    expect((await client().post(`${P}/episodes/${ep.id}/publish`, { showId })).status).toBe(404);
    // publish without a showId → validation error
    expect((await c.post(`${P}/episodes/${ep.id}/publish`, {})).status).toBe(400);
    // cross-org show → uniform 404
    const other = await ownerWithOrg('rbac2-other');
    const otherShow = await other.c.post(`${P}/shows`, { orgId: other.orgId, title: 'O', author: 'O' });
    expect((await c.post(`${P}/episodes/${ep.id}/publish`, { showId: otherShow.body.show.id })).status).toBe(404);
  });
});

describe('ADR 0390 — public reads gated on published + uniform 404', () => {
  it('an unpublished show / episode is a uniform 404 on every public surface', async () => {
    const { c, orgId, tenantId } = await ownerWithOrg('unpub');
    const created = await c.post(`${P}/shows`, { orgId, title: 'Hidden Show', author: 'A' });
    const showSlug = created.body.show.slug as string;
    const showId = created.body.show.id as string;
    // show exists but is NOT published → 404 everywhere
    expect((await rawGet(`${PUB(orgId)}/${showSlug}`)).status).toBe(404);
    expect((await rawGet(`${PUB(orgId)}/${showSlug}/feed.xml`)).status).toBe(404);
    // publish the show, add an UNPUBLISHED episode → episode page still 404
    expect((await c.post(`${P}/shows/${showId}/publish`)).status).toBe(200);
    const ep = await seedEpisodeWithAudio(tenantId, orgId, 'Secret Ep', 128);
    // The episode is not published — its audio + page are 404.
    expect((await rawGet(`${PUB(orgId)}/${showSlug}/secret-ep`)).status).toBe(404);
    expect((await rawGet(`${PUB(orgId)}/episodes/${ep.id}/audio`)).status).toBe(404);
  });

  it('an unknown org is a uniform 404', async () => {
    expect((await rawGet(`${PUB('org-does-not-exist')}`)).status).toBe(404);
    expect((await rawGet(`${PUB('org-does-not-exist')}/whatever/feed.xml`)).status).toBe(404);
  });

  it('the published show index + show page + episode page render publicly', async () => {
    const { orgId, showSlug, episodeSlug } = await publishedShowWithEpisode('pub');
    const index = await rawGet(`${PUB(orgId)}`);
    expect(index.status).toBe(200);
    expect(index.body).toContain(showSlug);
    const showPage = JSON.parse((await rawGet(`${PUB(orgId)}/${showSlug}`)).body);
    expect(showPage.show.slug).toBe(showSlug);
    expect(showPage.episodes.length).toBe(1);
    const epPage = JSON.parse((await rawGet(`${PUB(orgId)}/${showSlug}/${episodeSlug}`)).body);
    expect(epPage.episode.slug).toBe(episodeSlug);
    expect(epPage.episode.audioUrl).toContain('/audio');
  });
});

describe('ADR 0390 — iTunes RSS feed', () => {
  it('serves feed.xml with the iTunes namespace, channel tags, and an <enclosure>', async () => {
    const { orgId, showSlug, episodeId } = await publishedShowWithEpisode('feed');
    const res = await rawGet(`${PUB(orgId)}/${showSlug}/feed.xml`);
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('application/rss+xml');
    expect(String(res.headers['cache-control'])).toContain('public');
    expect(res.body).toContain('xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"');
    expect(res.body).toContain('<itunes:author>Acme</itunes:author>');
    expect(res.body).toContain('<itunes:owner>');
    expect(res.body).toContain('<itunes:category text="Technology"');
    // the enclosure carries the exact byte length (512) + the type + a stable guid
    expect(res.body).toContain('length="512"');
    expect(res.body).toContain('type="audio/mpeg"');
    expect(res.body).toContain(`<guid isPermaLink="false">${episodeId}</guid>`);
    expect(res.body).toContain('rel="self"');
  });
});

describe('ADR 0390 — Range-capable audio route', () => {
  it('serves the full asset (200) with Accept-Ranges', async () => {
    const { orgId, episodeId } = await publishedShowWithEpisode('audio-full');
    const res = await rawGet(`${PUB(orgId)}/episodes/${episodeId}/audio`);
    expect(res.status).toBe(200);
    expect(String(res.headers['accept-ranges'])).toBe('bytes');
    expect(String(res.headers['content-type'])).toBe('audio/mpeg');
    expect(Number(res.headers['content-length'])).toBe(512);
    expect(res.body.length).toBe(512);
  });

  it('honors Range: bytes=0-99 with 206 + Content-Range', async () => {
    const { orgId, episodeId } = await publishedShowWithEpisode('audio-range');
    const res = await rawGet(`${PUB(orgId)}/episodes/${episodeId}/audio`, { Range: 'bytes=0-99' });
    expect(res.status).toBe(206);
    expect(String(res.headers['content-range'])).toBe('bytes 0-99/512');
    expect(Number(res.headers['content-length'])).toBe(100);
    expect(res.body.length).toBe(100);
  });

  it('an out-of-range Range yields 416', async () => {
    const { orgId, episodeId } = await publishedShowWithEpisode('audio-416');
    const res = await rawGet(`${PUB(orgId)}/episodes/${episodeId}/audio`, { Range: 'bytes=99999-100000' });
    expect(res.status).toBe(416);
    expect(String(res.headers['content-range'])).toBe('bytes */512');
  });

  it('HEAD returns headers with no body', async () => {
    const { orgId, episodeId } = await publishedShowWithEpisode('audio-head');
    const res = await rawGet(`${PUB(orgId)}/episodes/${episodeId}/audio`, {}, 'HEAD');
    expect(res.status).toBe(200);
    expect(String(res.headers['accept-ranges'])).toBe('bytes');
    expect(res.body.length).toBe(0);
  });

  it('404s for a foreign-tenant episode id (bytes never cross tenants)', async () => {
    const a = await publishedShowWithEpisode('tenant-a');
    const b = await publishedShowWithEpisode('tenant-b');
    // Org A's audio namespace must not resolve org B's episode id.
    expect((await rawGet(`${PUB(a.orgId)}/episodes/${b.episodeId}/audio`)).status).toBe(404);
  });
});

describe('ADR 0390 (P0PUB-3) — episode slug re-uniquifies on a show move', () => {
  it('moving an episode into a show that already has its slug does not shadow the incumbent', async () => {
    const { c, orgId, tenantId } = await ownerWithOrg('slug-move');
    // Two shows in the SAME org.
    const mk = async (title: string): Promise<{ id: string; slug: string }> => {
      const r = await c.post(`${P}/shows`, { orgId, title, author: 'A', description: 'd', category: 'Technology', explicit: false, languageCode: 'en' });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const id = r.body.show.id as string;
      expect((await c.post(`${P}/shows/${id}/publish`)).status).toBe(200);
      return { id, slug: r.body.show.slug as string };
    };
    const showA = (await mk('Show A')).id;
    const showBRec = await mk('Show B');
    const showB = showBRec.id;

    // Same episode TITLE in both shows → the incumbent on B claims `collision-ep`.
    const incumbent = await seedEpisodeWithAudio(tenantId, orgId, 'Collision Ep', 256);
    const pubB = await c.post(`${P}/episodes/${incumbent.id}/publish`, { showId: showB });
    expect(pubB.status, JSON.stringify(pubB.body)).toBe(200);
    const incumbentSlug = pubB.body.episode.slug as string;

    // The mover first publishes on A (no collision — different show catalog).
    const mover = await seedEpisodeWithAudio(tenantId, orgId, 'Collision Ep', 256);
    const pubA = await c.post(`${P}/episodes/${mover.id}/publish`, { showId: showA });
    expect(pubA.status).toBe(200);
    expect(pubA.body.episode.slug).toBe(incumbentSlug); // same slug OK — different show

    // Now MOVE the mover onto show B, whose catalog already holds that slug.
    const moved = await c.post(`${P}/episodes/${mover.id}/publish`, { showId: showB });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const movedSlug = moved.body.episode.slug as string;
    expect(movedSlug).not.toBe(incumbentSlug); // re-uniquified against B's catalog

    // Both episodes now resolve distinctly on the public show-B surface.
    const showBSlug = showBRec.slug;
    const a = await client().get(`${PUB(orgId)}/${showBSlug}/${incumbentSlug}`);
    const b = await client().get(`${PUB(orgId)}/${showBSlug}/${movedSlug}`);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.episode.title).toBe('Collision Ep');
    expect(b.body.episode.title).toBe('Collision Ep');
    expect(a.body.episode.slug).not.toBe(b.body.episode.slug);
  });
});

/**
 * The WIRING half of `PROBE-P0-1` (ADR 0502's lesson: test the mechanism and the
 * wiring SEPARATELY).
 *
 * `test/adr0390-podcast-show-delete-cascade.test.ts` proves the MECHANISM — that
 * `deleteShow` unpublishes and detaches the show's episodes at the row level. It
 * cannot prove the PUBLIC CONSEQUENCE, which is what the probe actually asked
 * about ("orphaned-PUBLIC-episode census"). These cases assert the consequence
 * over real HTTP.
 *
 * Worth stating plainly, because it changes what the mechanism test is worth:
 * `getPublishedEpisodeById` (podcastsService.ts:547) re-reads the SHOW and
 * requires it to exist and be published, so the audio route fails closed on a
 * deleted show **even if the cascade did nothing**. The row-level cascade is
 * therefore DEFENCE IN DEPTH, not the sole guard. Both halves are worth having —
 * a regression in either alone leaves the other holding the line — but the
 * mechanism test should not be read as the only thing standing between a deleted
 * channel and a public leak.
 */
describe('ADR 0390 / PROBE-P0-1 — deleting a show removes its episodes from every public surface', () => {
  it('404s the show page, the feed, the episode page AND the audio enclosure', async () => {
    const { c, orgId, showSlug, showId, episodeId, episodeSlug } = await publishedShowWithEpisode('cascade-pub');

    // PRECONDITION — every surface is live, so the 404s below mean the delete did it.
    expect((await client().get(`${PUB(orgId)}/${showSlug}`)).status, 'show page was not live pre-delete').toBe(200);
    expect((await rawGet(`${PUB(orgId)}/${showSlug}/feed.xml`)).status, 'feed was not live pre-delete').toBe(200);
    expect((await client().get(`${PUB(orgId)}/${showSlug}/${episodeSlug}`)).status).toBe(200);
    expect((await rawGet(`${PUB(orgId)}/episodes/${episodeId}/audio`)).status, 'audio was not live pre-delete').toBe(200);

    expect((await c.delete(`${P}/shows/${showId}`)).status).toBe(200);

    expect((await client().get(`${PUB(orgId)}/${showSlug}`)).status).toBe(404);
    expect((await rawGet(`${PUB(orgId)}/${showSlug}/feed.xml`)).status).toBe(404);
    expect((await client().get(`${PUB(orgId)}/${showSlug}/${episodeSlug}`)).status).toBe(404);
    expect(
      (await rawGet(`${PUB(orgId)}/episodes/${episodeId}/audio`)).status,
      'the audio enclosure still served bytes for a deleted channel — this is the show-independent route, keyed by episode id',
    ).toBe(404);
  });
});

describe('R2 SP-1 — publish metadata reaches the PUBLIC surface (explicit inherits the show)', () => {
  it('an explicit show marks every episode explicit unless a per-episode override says otherwise', async () => {
    const { c, orgId, tenantId, showId, showSlug } = await publishedShowWithEpisode('sp1');
    // Make the SHOW explicit.
    expect((await c.put(`${P}/shows/${showId}`, { explicit: true })).status).toBe(200);

    // Episode with NO override → inherits true (the old projection hardcoded ?? false).
    const pub = await fetch(`${BASE}/v1/host/openwop-app/public/${encodeURIComponent(orgId)}/podcasts/${encodeURIComponent(showSlug)}`);
    expect(pub.status).toBe(200);
    const body = await pub.json() as { show: { explicit: boolean }; episodes: Array<{ explicit: boolean; description?: string }> };
    expect(body.show.explicit).toBe(true);
    expect(body.episodes[0]!.explicit).toBe(true);

    // A second episode published WITH override false + a public description —
    // the fields the route always accepted and no client ever sent.
    const ep2 = await seedEpisodeWithAudio(tenantId, orgId, 'Clean One', 256);
    const pub2 = await c.post(`${P}/episodes/${ep2.id}/publish`, { showId, explicitOverride: false, descriptionOverride: 'A clean episode.' });
    expect(pub2.status, JSON.stringify(pub2.body)).toBe(200);
    const after = await (await fetch(`${BASE}/v1/host/openwop-app/public/${encodeURIComponent(orgId)}/podcasts/${encodeURIComponent(showSlug)}`)).json() as { episodes: Array<{ title: string; explicit: boolean; description?: string }> };
    const clean = after.episodes.find((e) => e.title === 'Clean One')!;
    expect(clean.explicit).toBe(false);
    expect(clean.description).toBe('A clean episode.');
  });
});

describe('R2 PR2-4 — directory URLs: operator-entered, sanitized, projected', () => {
  it('stores http(s) directory URLs, DROPS a javascript: URL, and projects them publicly', async () => {
    const { c, orgId, showId, showSlug } = await publishedShowWithEpisode('pr24');
    const upd = await c.put(`${P}/shows/${showId}`, {
      appleUrl: 'https://podcasts.apple.com/us/podcast/id123',
      spotifyUrl: 'javascript:alert(1)', // must be DROPPED, never stored
    });
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);
    expect(upd.body.show.appleUrl).toBe('https://podcasts.apple.com/us/podcast/id123');
    expect(upd.body.show.spotifyUrl).toBeUndefined();

    const pub = await (await fetch(`${BASE}/v1/host/openwop-app/public/${encodeURIComponent(orgId)}/podcasts/${encodeURIComponent(showSlug)}`)).json() as { show: { appleUrl?: string; spotifyUrl?: string } };
    expect(pub.show.appleUrl).toBe('https://podcasts.apple.com/us/podcast/id123');
    expect(pub.show.spotifyUrl).toBeUndefined();
  });
});

describe('R2 PR2-1 — duration measured at publish reaches the feed and the public JSON', () => {
  it('a WAV episode publishes with itunes:duration; unmeasurable audio honestly omits it', async () => {
    const { c, orgId, tenantId, showId, showSlug } = await publishedShowWithEpisode('dur');
    // A canonical 60-second WAV (16kHz, 16-bit mono → byteRate 32000).
    const dataSize = 60 * 32_000;
    const wav = Buffer.alloc(44 + dataSize);
    wav.write('RIFF', 0, 'latin1'); wav.writeUInt32LE(36 + dataSize, 4); wav.write('WAVE', 8, 'latin1');
    wav.write('fmt ', 12, 'latin1'); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16_000, 24); wav.writeUInt32LE(32_000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36, 'latin1'); wav.writeUInt32LE(dataSize, 40);
    const asset = await storeMediaAsset(tenantId, { contentBase64: wav.toString('base64'), contentType: 'audio/wav' });
    const ep = await createEpisode(tenantId, orgId, { notebookId: 'nb-1', episodeProfileId: 'ep-profile-1', title: 'Timed One' });
    await recordEpisodeResult(tenantId, ep.id, { audioMediaRef: asset.url });
    const pub = await c.post(`${P}/episodes/${ep.id}/publish`, { showId });
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
    expect(pub.body.episode.durationSeconds).toBe(60);

    // The feed finally carries itunes:duration for the measured episode…
    const feed = await rawGet(`${PUB(orgId)}/${showSlug}/feed.xml`);
    expect(feed.status).toBe(200);
    expect(feed.body).toContain('<itunes:duration>');
    // …and the public JSON carries the seconds for the pages' row furniture.
    const pubJson = await (await fetch(`${BASE}${PUB(orgId)}/${showSlug}`)).json() as { episodes: Array<{ title: string; durationSeconds?: number }> };
    expect(pubJson.episodes.find((e) => e.title === 'Timed One')!.durationSeconds).toBe(60);
    // The garbage-bytes fixture episode ('Episode One') is honestly unmeasured.
    expect(pubJson.episodes.find((e) => e.title === 'Episode One')!.durationSeconds).toBeUndefined();
  });
});

describe('SP-9 (round 3) — shows/episodes lists carry the caller\'s canWrite from the write predicate', () => {
  it('org writer → canWrite true on both lists; same-org viewer → false, and the viewer\'s actual write 403s', async () => {
    // Shared `org:` tenant so a second user can be added as a read-only member
    // (the projects-route #2506 precedent).
    const tenantId = `org:pcw-${Date.now()}-${n++}`;
    const owner = client();
    await owner.post('/v1/host/openwop-app/test/login', { email: uniqEmail('pcw-owner'), tenantId });
    const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'CapCo' })).body.orgId as string;
    expect((await owner.post(`${P}/shows`, { orgId, title: 'Cap Show', author: 'A' })).status).toBe(201);

    // The creator holds workspace:write → both list reads REPORT it.
    const oShows = await owner.get(`${P}/shows?orgId=${encodeURIComponent(orgId)}`);
    expect(oShows.status).toBe(200);
    expect(oShows.body.canWrite).toBe(true);
    const oEps = await owner.get(`${P}/episodes?orgId=${encodeURIComponent(orgId)}`);
    expect(oEps.status).toBe(200);
    expect(oEps.body.canWrite).toBe(true);

    // A same-tenant read-only `viewer`: the reads still 200 (workspace:read),
    // but canWrite is FALSE — and the projection matches the authority (the
    // viewer's actual write on this surface 403s on the same predicate).
    const viewer = client();
    const vlogin = await viewer.post('/v1/host/openwop-app/test/login', { email: uniqEmail('pcw-viewer'), tenantId });
    const add = await owner.post(`/v1/host/openwop-app/orgs/${orgId}/members`, { displayName: 'V', subject: vlogin.body.user.userId, roles: ['viewer'] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    const vShows = await viewer.get(`${P}/shows?orgId=${encodeURIComponent(orgId)}`);
    expect(vShows.status).toBe(200);
    expect(vShows.body.canWrite).toBe(false);
    expect(vShows.body.shows.length).toBe(1); // the read itself is not narrowed
    const vEps = await viewer.get(`${P}/episodes?orgId=${encodeURIComponent(orgId)}`);
    expect(vEps.status).toBe(200);
    expect(vEps.body.canWrite).toBe(false);
    expect((await viewer.post(`${P}/shows`, { orgId, title: 'Sneaky', author: 'V' })).status).toBe(403);
  });
});

describe('R3 XP-R2-4 — <podcast:guid>: minted once, persisted, spec-conformant', () => {
  it('feed.xml declares xmlns:podcast and carries a UUID-shaped <podcast:guid>; a slug RENAME does not re-mint it', async () => {
    const { c, orgId, showSlug, showId } = await publishedShowWithEpisode('guid');
    const feed1 = await rawGet(`${PUB(orgId)}/${showSlug}/feed.xml`);
    expect(feed1.status).toBe(200);
    expect(feed1.body).toContain('xmlns:podcast="https://podcastindex.org/namespace/1.0"');
    const m1 = /<podcast:guid>([0-9a-f-]{36})<\/podcast:guid>/.exec(feed1.body);
    expect(m1, 'feed must carry a UUID-shaped podcast:guid').toBeTruthy();
    expect(m1![1][14]).toBe('5'); // UUIDv5 version nibble

    // Rename the slug → the feed URL CHANGES. A re-derivation over the new URL
    // would yield a different UUID; the persisted mint must survive the move —
    // stability across feed-URL changes is the tag's entire purpose.
    const renamed = await c.put(`${P}/shows/${showId}`, { slug: `moved-${Date.now()}` });
    expect(renamed.status).toBe(200);
    const feed2 = await rawGet(`${PUB(orgId)}/${renamed.body.show.slug}/feed.xml`);
    expect(feed2.status).toBe(200);
    const m2 = /<podcast:guid>([0-9a-f-]{36})<\/podcast:guid>/.exec(feed2.body);
    expect(m2![1]).toBe(m1![1]);
  });

  it('the mint follows the Podcasting 2.0 recipe — the published podnews.net/rss vector', async () => {
    // ensureShowGuid strips the scheme and trailing slashes, then UUIDv5 over
    // the podcastindex namespace. Verified against the spec's own vector
    // (independently reproduced with python uuid.uuid5).
    const { tenantId, orgId } = await ownerWithOrg('guid-vector');
    const svc = await import('../src/features/podcasts/podcastsService.js');
    const show = await svc.createShow(tenantId, orgId, 'tester', { title: 'Vector', author: 'A' });
    const guid = await svc.ensureShowGuid(tenantId, show.id, 'https://podnews.net/rss/');
    expect(guid).toBe('9b024349-ccf0-5f69-a609-6b82873eab3c');
  });
});
