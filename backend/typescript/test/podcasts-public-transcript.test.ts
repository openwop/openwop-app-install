/**
 * ADR 0603 §4 / `PODU-1` — WCAG 2.1 SC 1.2.1 (Level A): prerecorded audio-only
 * content needs a text alternative. The public episode page shipped a bare
 * `<audio>` and nothing else.
 *
 * The gap was DEFERRED TWICE on a premise that was false — the transcript was said
 * not to exist. It does: `feature.podcasts.nodes.transcript` writes an ADR 0053
 * Document and records `transcriptDocRef`, and the public route's own comment said
 * so. What it correctly refused was leaking that internal ref onto the public wire
 * (a public consumer cannot fetch an authed document). These tests pin the
 * projection it named as the fix.
 *
 * They cover BOTH public consumers: the JSON the SPA reads, and the PRERENDER — the
 * document a bot, a reader-mode client, and any no-JS visitor actually receive, i.e.
 * exactly the consumers least able to play audio.
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
import { createEpisode, recordEpisodeResult, PUBLIC_TRANSCRIPT_MAX } from '../src/features/podcasts/podcastsService.js';
import { createDocument, addVersion } from '../src/features/documents/documentsService.js';

let BASE: string; let PORT = 0; let server: http.Server; let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { PORT = (server.address() as AddressInfo).port; BASE = `http://127.0.0.1:${PORT}`; res(); }); });
  for (const id of ['podcasts', 'users', 'documents']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: any }
function client(): { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res> } {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}

const rawGet = async (path: string): Promise<{ status: number; body: string }> => {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: await res.text() };
};

const P = '/v1/host/openwop-app/podcasts';
const PUB = (orgId: string): string => `/v1/host/openwop-app/public/${encodeURIComponent(orgId)}/podcasts`;

const TRANSCRIPT = '**Host:** Welcome to the show.\n\n**Guest:** Glad to be here.';

/** Publish a show + episode; attach a transcript Document when `transcript` is given. */
async function publish(transcript: string | null): Promise<{ orgId: string; showSlug: string; episodeSlug: string; tenantId: string; episodeId: string }> {
  const c = client();
  await c.post('/v1/host/openwop-app/test/login', { email: `pt-${Date.now()}-${n++}@acme.test` });
  const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme Media' });
  const orgId = org.body.orgId as string;
  const tenantId = (await getOrg(orgId))!.tenantId;
  const created = await c.post(`${P}/shows`, {
    orgId, title: 'The Acme Hour', author: 'Acme Studios', description: 'Weekly acme talk',
    category: 'Technology', explicit: false, ownerName: 'Acme', ownerEmail: 'pod@acme.test', languageCode: 'en',
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const showId = created.body.show.id as string;
  expect((await c.post(`${P}/shows/${showId}/publish`)).status).toBe(200);

  const asset = await storeMediaAsset(tenantId, { contentBase64: Buffer.alloc(256, 7).toString('base64'), contentType: 'audio/mpeg' });
  const ep = await createEpisode(tenantId, orgId, { notebookId: 'nb-1', episodeProfileId: 'ep-1', title: 'Episode One' });
  await recordEpisodeResult(tenantId, ep.id, { audioMediaRef: asset.url });
  if (transcript !== null) {
    // What the `transcript` node does: an ADR 0053 Document, then the ref recorded
    // onto the episode. (`ownerSubject` is omitted — the node binds the notebook
    // project, which would need a real project row here; the transcript PROJECTION
    // reads tenant+org+documentId and is indifferent to the owner subject.)
    const doc = await createDocument({
      tenantId, orgId, title: 'Episode One — transcript', kind: 'podcast-transcript',
      format: 'markdown', createdBy: 'run',
      provenance: { producedBy: { kind: 'run', id: 'run-pt' } },
    });
    await addVersion(tenantId, orgId, doc.documentId, { content: transcript, producedBy: { kind: 'run', id: 'run-pt' } });
    await recordEpisodeResult(tenantId, ep.id, { transcriptDocRef: doc.documentId });
  }
  const pub = await c.post(`${P}/episodes/${ep.id}/publish`, { showId, descriptionOverride: 'A fine first episode.' });
  expect(pub.status, JSON.stringify(pub.body)).toBe(200);
  return { orgId, showSlug: created.body.show.slug as string, episodeSlug: pub.body.episode.slug as string, tenantId, episodeId: ep.id };
}

describe('PODU-1 — the public episode carries its transcript (WCAG 2.1 SC 1.2.1)', () => {
  it('the single-episode JSON serves the transcript CONTENT (never the internal ref)', async () => {
    const { orgId, showSlug, episodeSlug } = await publish(TRANSCRIPT);
    const res = await client().get(`${PUB(orgId)}/${showSlug}/${episodeSlug}`);
    expect(res.status).toBe(200);
    expect(res.body.episode.transcript).toBe(TRANSCRIPT);
    expect(res.body.episode.transcriptTruncated).toBe(false);
    // R2 SP-8 still holds: the AUTHED document id must never ride the public wire.
    expect(JSON.stringify(res.body)).not.toContain('transcriptDocRef');
  });

  it('an episode with NO transcript omits the field (absence is a real state)', async () => {
    // An INGESTED episode (ADR 0562) legitimately has no generated transcript. The
    // route must not fabricate one, and the page states the absence in words.
    const { orgId, showSlug, episodeSlug } = await publish(null);
    const res = await client().get(`${PUB(orgId)}/${showSlug}/${episodeSlug}`);
    expect(res.status).toBe(200);
    expect(res.body.episode.transcript).toBeUndefined();
    expect(res.body.episode.audioUrl).toBeTruthy(); // floor: the episode really did publish
  });

  it('an oversized transcript is bounded and SAYS SO (never silently clipped)', async () => {
    const huge = 'x'.repeat(PUBLIC_TRANSCRIPT_MAX + 5_000);
    const { orgId, showSlug, episodeSlug } = await publish(huge);
    const res = await client().get(`${PUB(orgId)}/${showSlug}/${episodeSlug}`);
    expect(res.body.episode.transcript).toHaveLength(PUBLIC_TRANSCRIPT_MAX);
    expect(res.body.episode.transcriptTruncated).toBe(true);
  });

  it('the transcript does NOT ride the show list (up to 20 episodes of model prose)', async () => {
    const { orgId, showSlug } = await publish(TRANSCRIPT);
    const res = await client().get(`${PUB(orgId)}/${showSlug}`);
    expect(res.status).toBe(200);
    expect(res.body.episodes).toHaveLength(1); // floor: the list is not empty
    expect(res.body.episodes[0].transcript).toBeUndefined();
  });

  it('the PRERENDER carries it too — the no-JS/bot document is the a11y-critical one', async () => {
    const { orgId, showSlug, episodeSlug } = await publish(TRANSCRIPT);
    const res = await rawGet(`${PUB(orgId)}/${showSlug}/prerender/${episodeSlug}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('<h2>Transcript</h2>');
    expect(res.body).toContain('Welcome to the show.');
    expect(res.body).toContain('Glad to be here.');
  });

  it('the prerender STATES the absence rather than omitting the section', async () => {
    const { orgId, showSlug, episodeSlug } = await publish(null);
    const res = await rawGet(`${PUB(orgId)}/${showSlug}/prerender/${episodeSlug}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('<h2>Transcript</h2>');
    expect(res.body).toContain('No transcript is available for this episode.');
  });

  it('`M1`-elevated — a tenant with `documents` OFF does not have its document served publicly', async () => {
    // The direct `documentsService` import bypasses the `featureSurfaces` toggle
    // gate, whose whole purpose is that a feature's data is not read for a tenant
    // that disabled it. So a switched-off `documents` still had its content served
    // on an UNAUTHENTICATED, `public`-cached route. ADR 0603 §4 claimed this edge
    // "degrades rather than breaks, IN BOTH DIRECTIONS"; only one direction was
    // honoured. Both are now.
    const { orgId, showSlug, episodeSlug } = await publish(TRANSCRIPT);
    const before = await client().get(`${PUB(orgId)}/${showSlug}/${episodeSlug}`);
    expect(before.body.episode.transcript, 'floor: it really is served while documents is ON').toBe(TRANSCRIPT);

    const d = getToggleDefault('documents')!;
    try {
      await saveConfig({ ...d, status: 'off' }, 'test');
      const res = await client().get(`${PUB(orgId)}/${showSlug}/${episodeSlug}`);
      expect(res.status, 'the episode itself still publishes — podcasts is still on').toBe(200);
      expect(res.body.episode.transcript).toBeUndefined();
      // The PRERENDER is the a11y-critical consumer and a separate call site, so it
      // is asserted separately — and it states the absence rather than omitting it.
      const pre = await rawGet(`${PUB(orgId)}/${showSlug}/prerender/${episodeSlug}`);
      expect(pre.body).toContain('No transcript is available for this episode.');
      expect(pre.body).not.toContain('Welcome to the show.');
    } finally {
      await saveConfig({ ...d, status: 'on' }, 'test');
    }
  });

  it('`L5` — the ref must point at a TRANSCRIPT: any other document kind is refused', async () => {
    // `transcriptDocRef` is a plain id on a mutable episode row and tenant+org were
    // the only things re-checked, so a mis-set ref could project ANY document in
    // the same tenant+org — a briefing, a decision record — onto a public,
    // 300s-cached, unauthenticated page.
    const { orgId, showSlug, episodeSlug, tenantId, episodeId } = await publish(TRANSCRIPT);
    const secret = await createDocument({
      tenantId, orgId, title: 'Board briefing', kind: 'strategy-decision',
      format: 'markdown', createdBy: 'human',
      provenance: { producedBy: { kind: 'run', id: 'run-x' } },
    });
    await addVersion(tenantId, orgId, secret.documentId, { content: 'CONFIDENTIAL board briefing.', producedBy: { kind: 'run', id: 'run-x' } });
    await recordEpisodeResult(tenantId, episodeId, { transcriptDocRef: secret.documentId });

    const res = await client().get(`${PUB(orgId)}/${showSlug}/${episodeSlug}`);
    expect(res.status).toBe(200);
    expect(res.body.episode.transcript).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('CONFIDENTIAL');
    const pre = await rawGet(`${PUB(orgId)}/${showSlug}/prerender/${episodeSlug}`);
    expect(pre.body).not.toContain('CONFIDENTIAL');
  });

  it('transcript text is HTML-ESCAPED in the prerender', async () => {
    const { orgId, showSlug, episodeSlug } = await publish('<script>alert(1)</script>\n\nsecond para');
    const res = await rawGet(`${PUB(orgId)}/${showSlug}/prerender/${episodeSlug}`);
    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('&lt;script&gt;');
    expect(res.body).toContain('second para'); // floor: the escaping did not eat the content
  });
});
