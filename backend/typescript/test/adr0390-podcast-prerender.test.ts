/**
 * ADR 0390 Phase 3 — the podcast crawler prerender + its custom-domain mapping:
 *  - the show prerender serves semantic HTML + `PodcastSeries` JSON-LD; the
 *    episode prerender serves `PodcastEpisode` JSON-LD + a followable audio link;
 *  - unpublished / unknown show or episode → uniform 404 (honest-off); the
 *    prerender kill-switch reverts to 404;
 *  - `/pod/:show[/:episode]` on a bound custom host rewrites to these routes and
 *    serves the semantic document to bots AND humans.
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
import { createEpisode, recordEpisodeResult } from '../src/features/podcasts/podcastsService.js';
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

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}

function rawGet(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

const P = '/v1/host/openwop-app/podcasts';
const PUB = (orgId: string): string => `/v1/host/openwop-app/public/${encodeURIComponent(orgId)}/podcasts`;

async function publishedShowWithEpisode(): Promise<{ orgId: string; showSlug: string; episodeSlug: string }> {
  const c = client();
  await c.post('/v1/host/openwop-app/test/login', { email: `pre-${Date.now()}-${n++}@acme.test` });
  const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme Media' });
  const orgId = org.body.orgId as string;
  const tenantId = (await getOrg(orgId))!.tenantId;
  const created = await c.post(`${P}/shows`, {
    orgId, title: 'The Acme Hour', author: 'Acme Studios', description: 'Weekly acme talk',
    category: 'Technology', explicit: false, ownerName: 'Acme', ownerEmail: 'pod@acme.test', languageCode: 'en',
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const showId = created.body.show.id as string;
  const showSlug = created.body.show.slug as string;
  expect((await c.post(`${P}/shows/${showId}/publish`)).status).toBe(200);
  const asset = await storeMediaAsset(tenantId, { contentBase64: Buffer.alloc(256, 7).toString('base64'), contentType: 'audio/mpeg' });
  const ep = await createEpisode(tenantId, orgId, { notebookId: 'nb-1', episodeProfileId: 'ep-1', title: 'Episode One' });
  await recordEpisodeResult(tenantId, ep.id, { audioMediaRef: asset.url });
  const pub = await c.post(`${P}/episodes/${ep.id}/publish`, { showId, descriptionOverride: 'A fine first episode.' });
  expect(pub.status, JSON.stringify(pub.body)).toBe(200);
  return { orgId, showSlug, episodeSlug: pub.body.episode.slug as string };
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
    // a link to the submittable RSS feed
    expect(res.body).toContain(`/podcasts/${showSlug}/feed.xml`);
  });

  it('kill-switch and unpublished/unknown → uniform 404', async () => {
    const { orgId, showSlug } = await publishedShowWithEpisode();
    process.env.OPENWOP_SEO_PRERENDER_DISABLED = 'true';
    expect((await rawGet(`${PUB(orgId)}/${showSlug}/prerender`)).status).toBe(404);
    delete process.env.OPENWOP_SEO_PRERENDER_DISABLED;
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
    expect(res.body).toContain(`/podcasts/episodes/`); // the audio enclosure URL
    expect(res.body).toContain('"@type":"PodcastSeries"'); // partOfSeries backref
  });

  it('an unknown episode slug → uniform 404', async () => {
    const { orgId, showSlug } = await publishedShowWithEpisode();
    expect((await rawGet(`${PUB(orgId)}/${showSlug}/prerender/no-such-episode`)).status).toBe(404);
  });

  it('the JSON episode route is unaffected by the `prerender` literal segment', async () => {
    const { orgId, showSlug } = await publishedShowWithEpisode();
    // `…/:showSlug/prerender` is the show prerender (HTML), not an episode named "prerender".
    const json = await rawGet(`${PUB(orgId)}/${showSlug}/prerender`);
    expect(json.headers['content-type']).toContain('text/html');
  });
});

describe('ADR 0390 P3 — custom-domain /pod mapping', () => {
  it('/pod/:show and /pod/:show/:episode on a bound host serve the prerender to bots AND humans', async () => {
    const { orgId, showSlug, episodeSlug } = await publishedShowWithEpisode();
    await __resetCustomDomains();
    const host = `pod-${n}.example.com`;
    const d = await addDomain({ tenantId: 't-any', orgId, createdBy: 'u', hostname: host });
    await verifyDomain('t-any', orgId, host, async () => [[d.verificationToken]]);
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
