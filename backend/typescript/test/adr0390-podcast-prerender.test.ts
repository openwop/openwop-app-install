/**
 * ADR 0390 Phase 3 — the podcast crawler prerender + its custom-domain mapping:
 *  - the show prerender serves semantic HTML + `PodcastSeries` JSON-LD; the
 *    episode prerender serves `PodcastEpisode` JSON-LD + a followable audio link;
 *  - unpublished / unknown show or episode → uniform 404 (honest-off); the
 *    prerender kill-switch reverts to 404;
 *  - `/pod/:show[/:episode]` on a bound custom host rewrites to these routes and
 *    serves the semantic document to bots AND humans.
 *
 * Sabotage witnesses (w21 /grade-tests): removing the kill-switch check, serving
 * a null render instead of 404ing, ignoring the show `published` flag, renaming
 * either JSON-LD `@type`, dropping the `Listen (audio)` or `RSS feed` anchor,
 * moving the literal `prerender` route, or disabling either `/pod` rewrite each
 * reddens the case that claims it.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getOrg } from '../src/host/accessControlService.js';
import { storeMediaAsset } from '../src/host/inMemorySurfaces.js';
import { createEpisode, recordEpisodeResult, type PodcastEpisode, type PodcastShow } from '../src/features/podcasts/podcastsService.js';
import { addDomain, verifyDomain, invalidateHostCache, __resetCustomDomains } from '../src/host/customDomains.js';

let BASE: string; let PORT = 0; let server: http.Server; let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { PORT = (server.address() as AddressInfo).port; BASE = `http://127.0.0.1:${PORT}`; res(); }); });
  for (const id of ['podcasts', 'users', 'custom-domains']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
afterEach(() => { delete process.env.OPENWOP_SEO_PRERENDER_DISABLED; });

interface Res<T> { status: number; body: T }
interface Client {
  get: <T>(p: string) => Promise<Res<T>>;
  post: <T>(p: string, b?: unknown) => Promise<Res<T>>;
}
function client(): Client {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    // The ONE typed boundary: the wire body is `unknown` until a case names its shape.
    const out = (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T;
    return { status: res.status, body: out };
  };
  return { get: <T>(p: string) => call<T>('GET', p), post: <T>(p: string, b?: unknown) => call<T>('POST', p, b) };
}

function rawGet(path: string, headers: Record<string, string> = {}, method: 'GET' | 'HEAD' = 'GET'): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

const P = '/host/openwop-app/podcasts';
const PUB = (orgId: string): string => `/host/openwop-app/public/${encodeURIComponent(orgId)}/podcasts`;

async function publishedShowWithEpisode(): Promise<{ c: Client; orgId: string; tenantId: string; showSlug: string; episodeSlug: string }> {
  const c = client();
  await c.post('/host/openwop-app/test/login', { email: `pre-${Date.now()}-${n++}@acme.test` });
  const org = await c.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme Media' });
  const orgId = org.body.orgId;
  const tenantId = (await getOrg(orgId))!.tenantId;
  const created = await c.post<{ show: PodcastShow }>(`${P}/shows`, {
    orgId, title: 'The Acme Hour', author: 'Acme Studios', description: 'Weekly acme talk',
    category: 'Technology', explicit: false, ownerName: 'Acme', ownerEmail: 'pod@acme.test', languageCode: 'en',
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const showId = created.body.show.id;
  const showSlug = created.body.show.slug;
  expect((await c.post(`${P}/shows/${showId}/publish`)).status).toBe(200);
  const asset = await storeMediaAsset(tenantId, { contentBase64: Buffer.alloc(256, 7).toString('base64'), contentType: 'audio/mpeg' });
  const ep = await createEpisode(tenantId, orgId, { notebookId: 'nb-1', episodeProfileId: 'ep-1', title: 'Episode One' });
  await recordEpisodeResult(tenantId, ep.id, { audioMediaRef: asset.url });
  const pub = await c.post<{ episode: PodcastEpisode }>(`${P}/episodes/${ep.id}/publish`, { showId, descriptionOverride: 'A fine first episode.' });
  expect(pub.status, JSON.stringify(pub.body)).toBe(200);
  return { c, orgId, tenantId, showSlug, episodeSlug: pub.body.episode.slug! };
}

describe('ADR 0390 P3 — podcast show prerender', () => {
  it('serves semantic HTML + PodcastSeries JSON-LD', async () => {
    const { orgId, showSlug, episodeSlug } = await publishedShowWithEpisode();
    const res = await rawGet(`${PUB(orgId)}/${showSlug}/prerender`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(String(res.headers['cache-control'])).toContain('public');
    expect(res.body).toContain('<!doctype html>');
    expect(res.body).toContain('<h1>The Acme Hour</h1>');
    expect(res.body).toContain('Acme Studios');
    expect(res.body).toContain('"@type":"PodcastSeries"');
    expect(res.body).toContain('"name":"The Acme Hour"');
    // the episode is listed with a followable link to its page
    expect(res.body).toContain('Episode One');
    expect(res.body).toContain(`/pod/${orgId}/${showSlug}/${episodeSlug}`);
    // a followable ANCHOR to the submittable RSS feed (the JSON-LD `webFeed`
    // carries the same URL, so a bare substring would not prove the link)
    expect(res.body).toMatch(new RegExp(`<a href="[^"]*/podcasts/${showSlug}/feed\\.xml">RSS feed</a>`));
  });

  it('kill-switch and unpublished/unknown → uniform 404', async () => {
    const { c, orgId, showSlug } = await publishedShowWithEpisode();
    process.env.OPENWOP_SEO_PRERENDER_DISABLED = 'true';
    expect((await rawGet(`${PUB(orgId)}/${showSlug}/prerender`)).status).toBe(404);
    delete process.env.OPENWOP_SEO_PRERENDER_DISABLED;
    // the switch is the ONLY reason for that 404: the same show serves once it is off
    expect((await rawGet(`${PUB(orgId)}/${showSlug}/prerender`)).status).toBe(200);
    // an EXISTING but unpublished show in the same org → 404
    const hidden = await c.post<{ show: PodcastShow }>(`${P}/shows`, { orgId, title: 'Hidden Hour', author: 'Acme Studios' });
    expect(hidden.status, JSON.stringify(hidden.body)).toBe(201);
    expect(hidden.body.show.published).toBe(false);
    expect((await rawGet(`${PUB(orgId)}/${hidden.body.show.slug}/prerender`)).status).toBe(404);
    expect((await rawGet(`${PUB(orgId)}/no-such-show/prerender`)).status).toBe(404);
    expect((await rawGet(`${PUB('org-does-not-exist')}/x/prerender`)).status).toBe(404);
  });
});

describe('ADR 0390 P3 — podcast episode prerender', () => {
  it('serves PodcastEpisode JSON-LD + a followable audio link', async () => {
    const { orgId, showSlug, episodeSlug } = await publishedShowWithEpisode();
    const res = await rawGet(`${PUB(orgId)}/${showSlug}/prerender/${episodeSlug}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('<h1>Episode One</h1>');
    expect(res.body).toContain('"@type":"PodcastEpisode"');
    expect(res.body).toContain('A fine first episode.');
    // a followable ANCHOR to the audio enclosure (the JSON-LD `contentUrl` carries
    // the same URL, so a bare substring would not prove the link)
    expect(res.body).toMatch(/<a href="[^"]*\/podcasts\/episodes\/[^"]+\/audio">Listen \(audio\)<\/a>/);
    expect(res.body).toContain('"@type":"PodcastSeries"'); // partOfSeries backref
  });

  // PODCAST-1a: one route per path answers HEAD with `req.method`; the separate
  // `app.head` routes were unreachable. A HEAD must report what a GET sends.
  it('HEAD on both prerender routes reports the GET status, type and length with no body', async () => {
    const { orgId, showSlug, episodeSlug } = await publishedShowWithEpisode();
    for (const path of [`${PUB(orgId)}/${showSlug}/prerender`, `${PUB(orgId)}/${showSlug}/prerender/${episodeSlug}`]) {
      const get = await rawGet(path);
      const head = await rawGet(path, {}, 'HEAD');
      expect(head.status).toBe(200);
      expect(head.headers['content-type']).toContain('text/html');
      expect(Number(head.headers['content-length'])).toBe(Buffer.byteLength(get.body));
      expect(head.body).toBe('');
    }
  });

  it('an unknown episode slug → uniform 404', async () => {
    const { orgId, showSlug } = await publishedShowWithEpisode();
    expect((await rawGet(`${PUB(orgId)}/${showSlug}/prerender/no-such-episode`)).status).toBe(404);
  });
});

describe('ADR 0390 P3 — custom-domain /pod mapping', () => {
  it('/pod/:show and /pod/:show/:episode on a bound host serve the prerender to bots AND humans', async () => {
    const { orgId, tenantId, showSlug, episodeSlug } = await publishedShowWithEpisode();
    await __resetCustomDomains();
    const host = `pod-${n}.example.com`;
    const d = await addDomain({ tenantId, orgId, createdBy: 'u', hostname: host });
    await verifyDomain(tenantId, orgId, host, async () => [[d.verificationToken]]);
    invalidateHostCache();

    // On a bound host the org is the domain's — the podcast path is org-LESS.
    const showHuman = await rawGet(`/pod/${showSlug}`, { host, 'user-agent': 'Mozilla/5.0 Safari' });
    expect(showHuman.status).toBe(200);
    expect(showHuman.body).toContain('<h1>The Acme Hour</h1>');
    const showBot = await rawGet(`/pod/${showSlug}`, { host, 'user-agent': 'GPTBot/1.0' });
    expect(showBot.status).toBe(200);
    expect(showBot.body).toContain('"@type":"PodcastSeries"');

    const epBot = await rawGet(`/pod/${showSlug}/${episodeSlug}`, { host, 'user-agent': 'GPTBot/1.0' });
    expect(epBot.status).toBe(200);
    expect(epBot.body).toContain('<h1>Episode One</h1>');

    // unknown show on the bound host → uniform 404
    expect((await rawGet(`/pod/no-such-show`, { host })).status).toBe(404);
  });
});
