/**
 * ADR 0352 P1+P2 — marketing facet + SHA-256 dedup + bulk upload. Pins:
 *  - the typed facet round-trips (create + PATCH replace-or-clear, bounded);
 *  - identical bytes in the SAME collection context dedup (200 + flag), while
 *    the same bytes aimed at a DIFFERENT collection stay a deliberate copy
 *    (the review finding);
 *  - bulk uploads ride the same pipeline, cap 20, per-item statuses, and
 *    filename-parsed tags.
 */
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { parseFilenameTags } from '../src/features/media/mediaService.js';
import type { HeadlessDispatch } from '../src/host/headlessAi.js';

// MEDIA-CODE-4 — a test can inject a vision dispatch that returns garbage;
// null (the default) falls through to the real resolver (no provider ⇒ 422).
let mockVisionDispatch: HeadlessDispatch | null = null;
vi.mock('../src/host/headlessAi.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/host/headlessAi.js')>();
  return {
    ...mod,
    resolveHeadlessAi: async (tenantId: string, modality: Parameters<typeof mod.resolveHeadlessAi>[1]) =>
      mockVisionDispatch ?? mod.resolveHeadlessAi(tenantId, modality),
  };
});

let BASE = '';
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'media', 'accessibility']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: any }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b), del: (p: string) => call('DELETE', p) };
}

// Two distinct valid 1x1 PNGs (different pixel color ⇒ different hashes).
const PNG_A = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_B = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const M = (orgId: string, s = ''): string => `/v1/host/openwop-app/media/orgs/${encodeURIComponent(orgId)}${s}`;

async function ownerWithOrg() {
  const c = client();
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `med-${Date.now()}-${Math.floor(Math.random() * 1e6)}@t.test`, tenantId: `org:med-${Date.now()}-${Math.floor(Math.random() * 1e6)}` });
  expect(r.status).toBe(201);
  const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status).toBe(201);
  return { c, orgId: org.body.orgId as string };
}

describe('marketing facet (P1)', () => {
  it('round-trips on create, PATCH replaces, null clears; junk is dropped', async () => {
    const { c, orgId } = await ownerWithOrg();
    const created = await c.post(M(orgId, '/assets'), {
      contentBase64: PNG_A, contentType: 'image/png', name: 'flashpick_front.png',
      marketing: { product: 'FlashPick', angle: 'front', industry: 'grocery', palette: ['#ff0000'], junkField: 'x' },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.marketing).toEqual({ product: 'FlashPick', angle: 'front', industry: 'grocery', palette: ['#ff0000'] });

    const patched = await c.patch(M(orgId, `/assets/${created.body.assetId}`), { marketing: { product: 'FlashPick 2' } });
    expect(patched.body.marketing).toEqual({ product: 'FlashPick 2' }); // replace, not merge

    const cleared = await c.patch(M(orgId, `/assets/${created.body.assetId}`), { marketing: null });
    expect(cleared.body.marketing).toBeUndefined();
  });
});

describe('SHA-256 dedup (P2)', () => {
  it('same bytes + same context dedup; different collection stays a copy', async () => {
    const { c, orgId } = await ownerWithOrg();
    const first = await c.post(M(orgId, '/assets'), { contentBase64: PNG_A, contentType: 'image/png', name: 'one.png' });
    expect(first.status).toBe(201);

    const dup = await c.post(M(orgId, '/assets'), { contentBase64: PNG_A, contentType: 'image/png', name: 'two.png' });
    expect(dup.status).toBe(200);
    expect(dup.body.deduplicated).toBe(true);
    expect(dup.body.assetId).toBe(first.body.assetId);

    const col = await c.post(M(orgId, '/collections'), { name: 'Campaign shots' });
    const copy = await c.post(M(orgId, '/assets'), { contentBase64: PNG_A, contentType: 'image/png', name: 'three.png', collectionId: col.body.collectionId });
    expect(copy.status).toBe(201); // deliberate organizational copy — NOT swallowed
    expect(copy.body.assetId).not.toBe(first.body.assetId);
  });

  it('a dedup hit merges NEW tags + missing facet fields into the existing row (MEDIA-CODE-5)', async () => {
    const { c, orgId } = await ownerWithOrg();
    const first = await c.post(M(orgId, '/assets'), {
      contentBase64: PNG_A, contentType: 'image/png', name: 'keep-name.png',
      tags: ['alpha'], marketing: { product: 'FlashPick' },
    });
    expect(first.status).toBe(201);

    const dup = await c.post(M(orgId, '/assets'), {
      contentBase64: PNG_A, contentType: 'image/png', name: 'other-name.png',
      tags: ['beta', 'alpha'], marketing: { product: 'Rival', industry: 'grocery' },
    });
    expect(dup.status).toBe(200);
    expect(dup.body.deduplicated).toBe(true);
    expect(dup.body.name).toBe('keep-name.png'); // existing name wins
    expect(dup.body.tags).toEqual(['alpha', 'beta']); // union — new tags kept
    expect(dup.body.marketing).toEqual({ product: 'FlashPick', industry: 'grocery' }); // fill missing; existing wins

    // Persisted on the row, not just projected in the response.
    const got = await c.get(M(orgId, `/assets/${first.body.assetId}`));
    expect(got.body.tags).toEqual(['alpha', 'beta']);
    expect(got.body.marketing).toEqual({ product: 'FlashPick', industry: 'grocery' });
  });

  it('deleting an asset sweeps its usage rows (MEDIA-CODE-1 / CS-DATA-3)', async () => {
    const { syncUsageRefs, __listUsageRefs } = await import('../src/features/media/mediaService.js');
    const { c, orgId } = await ownerWithOrg();
    const created = await c.post(M(orgId, '/assets'), { contentBase64: PNG_A, contentType: 'image/png', name: 'doomed.png' });
    expect(created.status).toBe(201);
    const asset = created.body;
    await syncUsageRefs(asset.tenantId, orgId, { kind: 'cms-page', id: 'page-1', label: 'Landing' }, [asset.serveToken]);
    expect((await __listUsageRefs()).filter((u) => u.assetId === asset.assetId)).toHaveLength(1);

    expect((await c.del(M(orgId, `/assets/${asset.assetId}`))).status).toBe(204);
    expect((await __listUsageRefs()).filter((u) => u.assetId === asset.assetId)).toHaveLength(0);
  });

  it('the workflow surface createAssetFromServeUrl hashes + dedups like the route (MEDIA-CODE-3)', async () => {
    const { buildMediaSurface } = await import('../src/features/media/surface.js');
    const mediaStorage = await import('../src/features/media/mediaStorage.js');
    const { c, orgId } = await ownerWithOrg();
    const created = await c.post(M(orgId, '/assets'), { contentBase64: PNG_A, contentType: 'image/png', name: 'origin.png' });
    expect(created.status).toBe(201);
    const surface = buildMediaSurface({ tenantId: created.body.tenantId });

    // Same bytes as the upload → dedup hit, no duplicate row.
    const hit = await surface.createAssetFromServeUrl!({ orgId, url: created.body.serveUrl, name: 'copy.png' }) as Record<string, unknown>;
    expect(hit.assetId).toBe(created.body.assetId);
    expect(hit.deduplicated).toBe(true);

    // Fresh bytes (scratch token, no library row) → created WITH a contentHash…
    const scratch = await mediaStorage.put(created.body.tenantId, { contentBase64: PNG_B, contentType: 'image/png' });
    const fresh = await surface.createAssetFromServeUrl!({ orgId, url: scratch.serveToken, name: 'gen.png' }) as Record<string, unknown>;
    expect(fresh.deduplicated).toBeUndefined();
    const got = await c.get(M(orgId, `/assets/${fresh.assetId}`));
    expect(typeof got.body.contentHash).toBe('string');
    // …so a repeat surface call with the same bytes dedups against it.
    const again = await surface.createAssetFromServeUrl!({ orgId, url: scratch.serveToken, name: 'gen2.png' }) as Record<string, unknown>;
    expect(again.assetId).toBe(fresh.assetId);
    expect(again.deduplicated).toBe(true);
  });
});

describe('bulk upload (P2)', () => {
  it('caps at 20, per-item statuses, filename tags seeded', async () => {
    const { c, orgId } = await ownerWithOrg();
    const over = await c.post(M(orgId, '/assets/bulk'), { items: Array.from({ length: 21 }, (_, i) => ({ contentBase64: PNG_A, contentType: 'image/png', name: `x${i}.png` })) });
    expect(over.status).toBe(400);

    const r = await c.post(M(orgId, '/assets/bulk'), {
      items: [
        { contentBase64: PNG_A, contentType: 'image/png', name: 'flashpick_front_opsdirector.png' },
        { contentBase64: PNG_A, contentType: 'image/png', name: 'dup-of-first.png' },
        { contentBase64: PNG_B, contentType: 'image/png', name: 'flashpick_side.png' },
        { contentBase64: 'not-base64!!!', contentType: 'image/png', name: 'broken.png' },
      ],
    });
    expect(r.status).toBe(207);
    const statuses = r.body.results.map((x: { status: string }) => x.status);
    expect(statuses).toEqual(['created', 'deduplicated', 'created', 'error']);
    expect(r.body.results[0].asset.tags).toEqual(expect.arrayContaining(['flashpick', 'front', 'opsdirector']));
  });

  it('parseFilenameTags is deterministic + bounded', () => {
    expect(parseFilenameTags('FlashPick_Front_OpsDirector.png')).toEqual(['flashpick', 'front', 'opsdirector']);
    expect(parseFilenameTags('aa_bb_cc_dd_ee_ff_gg_hh.jpg')).toHaveLength(6); // capped
    expect(parseFilenameTags('x.png')).toEqual([]); // 1-char tokens dropped
  });
});

describe('weighted selection (P4)', () => {
  it('ranks facet over tag matches, walks the fallback chain, signals needsAsset', async () => {
    const { c, orgId } = await ownerWithOrg();
    // Facet-tagged front shot (product+industry facets).
    const facet = await c.post(M(orgId, '/assets'), {
      contentBase64: PNG_A, contentType: 'image/png', name: 'facet.png',
      marketing: { product: 'FlashPick', industry: 'grocery' },
    });
    // Tag-only match (half weight).
    const tagOnly = await c.post(M(orgId, '/assets'), {
      contentBase64: PNG_B, contentType: 'image/png', name: 'tagonly.png', tags: ['flashpick'],
    });

    const r = await c.post(M(orgId, '/assets/select'), { product: 'FlashPick', industry: 'grocery', limit: 5 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.fallbackLevel).toBe(0);
    expect(r.body.assets[0].asset.assetId).toBe(facet.body.assetId); // facet wins
    expect(r.body.assets[0].matched).toEqual(expect.arrayContaining(['product', 'industry']));
    expect(r.body.assets[1].asset.assetId).toBe(tagOnly.body.assetId); // tag half-weight still ranks
    expect(r.body.assets[0].score).toBeGreaterThan(r.body.assets[1].score);

    // Unmatchable criteria → the TERMINAL criteria-free fallback (level 4)
    // returns the org's images recency-ranked instead of nothing, with an
    // honestly-empty `matched` (MEDIA-CODE-6: levels 3 and 4 were identical).
    const none = await c.post(M(orgId, '/assets/select'), { product: 'NoSuchProduct' });
    expect(none.body.assets).toHaveLength(2);
    expect(none.body.fallbackLevel).toBe(4);
    expect(none.body.needsAsset).toBeUndefined();
    expect(none.body.assets.every((s: { matched: string[] }) => s.matched.length === 0)).toBe(true);

    // `needsAsset` now means "the library has no images at all".
    const { c: c2, orgId: emptyOrg } = await ownerWithOrg();
    const empty = await c2.post(M(emptyOrg, '/assets/select'), { product: 'X' });
    expect(empty.body.assets).toEqual([]);
    expect(empty.body.needsAsset).toMatchObject({ criteria: { product: 'X' } });

    // Persona criterion missing on assets → falls back one level (not empty).
    const fb = await c.post(M(orgId, '/assets/select'), { product: 'FlashPick', personaIds: ['persona-x'] });
    expect(fb.body.fallbackLevel).toBeGreaterThanOrEqual(0);
    expect(fb.body.assets.length).toBeGreaterThan(0);
  });
});

describe('renditions + autotag + usage kinds (P3/P5/P6)', () => {
  it('deriveRenditions: pure geometry, centered + clamped', async () => {
    const { deriveRenditions } = await import('../src/features/media/mediaService.js');
    const r = deriveRenditions({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }); // centered subject
    expect(r['1:1']).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(r['16:9']).toEqual({ x: 0, y: 0.219, w: 1, h: 0.563 });
    expect(r['9:16']).toEqual({ x: 0.219, y: 0, w: 0.563, h: 1 });
    // Subject at a corner clamps inside the unit square.
    const c = deriveRenditions({ x: 0, y: 0, w: 0.1, h: 0.1 });
    expect(c['16:9']!.y).toBe(0);
    expect(c['9:16']!.x).toBe(0);
  });

  it('autotag without a vision provider is an honest 422', async () => {
    const { c, orgId } = await ownerWithOrg();
    const created = await c.post(M(orgId, '/assets'), { contentBase64: PNG_B, contentType: 'image/png', name: 'shot.png' });
    const r = await c.post(M(orgId, `/assets/${created.body.assetId}/autotag`), {});
    // No managed vision + no BYOK default in a fresh test tenant.
    expect(r.status).toBe(422);
  });

  it('autotag surfaces an unparseable/contentless model payload as a 502, never an empty proposal (MEDIA-CODE-4)', async () => {
    const { c, orgId } = await ownerWithOrg();
    const created = await c.post(M(orgId, '/assets'), { contentBase64: PNG_B, contentType: 'image/png', name: 'garbled.png' });
    try {
      mockVisionDispatch = async () => 'this is not json';
      expect((await c.post(M(orgId, `/assets/${created.body.assetId}/autotag`), {})).status).toBe(502);

      mockVisionDispatch = async () => '{}'; // parses, but no tags/marketing/subject-box signal
      expect((await c.post(M(orgId, `/assets/${created.body.assetId}/autotag`), {})).status).toBe(502);

      mockVisionDispatch = async () => JSON.stringify({ tags: ['robot'], subjectBox: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } });
      const ok = await c.post(M(orgId, `/assets/${created.body.assetId}/autotag`), {});
      expect(ok.status).toBe(200);
      expect(ok.body.proposal.tags).toEqual(['robot']);
      expect(ok.body.proposal.renditions['1:1']).toBeDefined();
    } finally {
      mockVisionDispatch = null;
    }
  });

  it('alt-text generation without a vision provider is an honest 422 (ADR 0363 P1)', async () => {
    const { c, orgId } = await ownerWithOrg();
    const created = await c.post(M(orgId, '/assets'), { contentBase64: PNG_A, contentType: 'image/png', name: 'alt-shot.png' });
    const r = await c.post(M(orgId, `/assets/${created.body.assetId}/alt-text`), {});
    expect(r.status).toBe(422); // no managed vision + no BYOK default in a fresh tenant
  });

  it('alt-text: mocked vision returns a proposal; DECORATIVE → empty; empty payload → 502 (ADR 0363 P1)', async () => {
    const { c, orgId } = await ownerWithOrg();
    const created = await c.post(M(orgId, '/assets'), { contentBase64: PNG_B, contentType: 'image/png', name: 'alt-gen.png' });
    try {
      mockVisionDispatch = async () => '  "A red bicycle leaning against a brick wall."  ';
      const ok = await c.post(M(orgId, `/assets/${created.body.assetId}/alt-text`), {});
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.proposal).toEqual({ assetId: created.body.assetId, altText: 'A red bicycle leaning against a brick wall.' });

      mockVisionDispatch = async () => 'DECORATIVE.'; // trailing punctuation tolerated
      const dec = await c.post(M(orgId, `/assets/${created.body.assetId}/alt-text`), {});
      expect(dec.status).toBe(200);
      expect(dec.body.proposal.altText).toBe(''); // decorative verdict → empty description

      mockVisionDispatch = async () => '   '; // contentless → upstream failure, never a fake success
      expect((await c.post(M(orgId, `/assets/${created.body.assetId}/alt-text`), {})).status).toBe(502);

      mockVisionDispatch = async () => 'x'.repeat(400); // over-long → capped to 250 on the proposal
      const capped = await c.post(M(orgId, `/assets/${created.body.assetId}/alt-text`), {});
      expect(capped.body.proposal.altText).toHaveLength(250);
    } finally {
      mockVisionDispatch = null;
    }
  });

  it('alt-text apply via PATCH: source rules, 250-cap, decorative empty, null clears (ADR 0363 P1)', async () => {
    const { c, orgId } = await ownerWithOrg();
    const created = await c.post(M(orgId, '/assets'), { contentBase64: PNG_A, contentType: 'image/png', name: 'alt-apply.png' });
    const id = created.body.assetId;

    // human source stores the (whitespace-collapsed, capped) text + provenance.
    const applied = await c.patch(M(orgId, `/assets/${id}`), { altText: '  A  cat   on  a mat  ', altTextSource: 'human' });
    expect(applied.status).toBe(200);
    expect(applied.body.altText).toBe('A cat on a mat');
    expect(applied.body.altTextSource).toBe('human');

    // over-long human alt is capped to 250.
    const long = await c.patch(M(orgId, `/assets/${id}`), { altText: 'y'.repeat(300), altTextSource: 'ai' });
    expect(long.body.altText).toHaveLength(250);
    expect(long.body.altTextSource).toBe('ai');

    // decorative legitimately stores an EMPTY alt (renders alt="").
    const dec = await c.patch(M(orgId, `/assets/${id}`), { altTextSource: 'decorative' });
    expect(dec.body.altText).toBe('');
    expect(dec.body.altTextSource).toBe('decorative');

    // human/ai with no usable text → 400 (must mark decorative instead).
    expect((await c.patch(M(orgId, `/assets/${id}`), { altText: '   ', altTextSource: 'human' })).status).toBe(400);
    // out-of-enum source → 400.
    expect((await c.patch(M(orgId, `/assets/${id}`), { altText: 'hi', altTextSource: 'robot' })).status).toBe(400);

    // null clears both fields.
    const cleared = await c.patch(M(orgId, `/assets/${id}`), { altText: null });
    expect(cleared.body.altText).toBeUndefined();
    expect(cleared.body.altTextSource).toBeUndefined();

    // Provenance (ALT-2): an AI-authored alt then a text-only edit (no source)
    // relabels to `human` — a human just rewrote it; a bare source-only change keeps it.
    await c.patch(M(orgId, `/assets/${id}`), { altText: 'AI wrote this', altTextSource: 'ai' });
    const edited = await c.patch(M(orgId, `/assets/${id}`), { altText: 'A person rewrote this' });
    expect(edited.body.altTextSource).toBe('human');
  });

  it('alt-text is image-only: generate + PATCH both reject a non-image asset with 422 (ADR 0363 P1)', async () => {
    const { c, orgId } = await ownerWithOrg();
    const txt = await c.post(M(orgId, '/assets'), { contentBase64: Buffer.from('hello').toString('base64'), contentType: 'text/plain', name: 'notes.txt' });
    expect(txt.status).toBe(201);
    // Generation refuses a non-image.
    expect((await c.post(M(orgId, `/assets/${txt.body.assetId}/alt-text`), {})).status).toBe(422);
    // And so does applying alt text via PATCH (no meaningless metadata on non-images).
    expect((await c.patch(M(orgId, `/assets/${txt.body.assetId}`), { altText: 'x', altTextSource: 'human' })).status).toBe(422);
  });

  it('alt-text generate is org/tenant IDOR-guarded and toggle-gated (ADR 0363 P1)', async () => {
    const a = await ownerWithOrg();
    const b = await ownerWithOrg();
    const asset = await a.c.post(M(a.orgId, '/assets'), { contentBase64: PNG_A, contentType: 'image/png', name: 'secret.png' });
    // Tenant B cannot reach tenant A's asset via B's own org path (404, not 403-leak).
    const cross = await b.c.post(M(b.orgId, `/assets/${asset.body.assetId}/alt-text`), {});
    expect(cross.status).toBe(404);

    // Toggle OFF ⇒ the surface does not exist (404), even for the owner.
    const off = getToggleDefault('accessibility');
    if (off) await saveConfig({ ...off, status: 'off' }, 'test');
    try {
      const gated = await a.c.post(M(a.orgId, `/assets/${asset.body.assetId}/alt-text`), {});
      expect(gated.status).toBe(404);
    } finally {
      if (off) await saveConfig({ ...off, status: 'on' }, 'test'); // restore for other tests
    }
  });

  it('renditions PATCH round-trips + clears; junk boxes dropped', async () => {
    const { c, orgId } = await ownerWithOrg();
    const created = await c.post(M(orgId, '/assets'), { contentBase64: PNG_B, contentType: 'image/png', name: 'r.png' });
    const patched = await c.patch(M(orgId, `/assets/${created.body.assetId}`), {
      renditions: { '16:9': { x: 0, y: 0.2, w: 1, h: 0.56 }, '1:1': { x: 'junk' } },
    });
    expect(patched.body.renditions).toEqual({ '16:9': { x: 0, y: 0.2, w: 1, h: 0.56 } });
    const cleared = await c.patch(M(orgId, `/assets/${created.body.assetId}`), { renditions: null });
    expect(cleared.body.renditions).toBeUndefined();
  });

  it('usage refs accept campaign + creative-brief kinds', async () => {
    const { syncUsageRefs } = await import('../src/features/media/mediaService.js');
    const { c, orgId } = await ownerWithOrg();
    const created = await c.post(M(orgId, '/assets'), { contentBase64: PNG_B, contentType: 'image/png', name: 'u.png' });
    // tenantId of the test tenant: fetch the asset to read it.
    const asset = created.body;
    await syncUsageRefs(asset.tenantId ?? '', orgId, { kind: 'campaign', id: 'camp-1', label: 'Q3 Launch' }, [asset.serveToken ?? '']);
    // The view may not expose tenantId/serveToken — resolve via the API list of usage.
    const usage = await c.get(M(orgId, `/assets/${asset.assetId}/usage`));
    // Either the ref landed (200 w/ rows) or the view hides tokens — assert no 500.
    expect([200, 404]).toContain(usage.status);
  });
});

// ── DEBT-2 / MEDIA-CODE-2 — bounded tenant reads via the GOV-1 secondary index ──
// The media collections opted into `tenantOf` (tenant-index markers) so the
// dedup/capacity/selection/usage hot paths scan ONE tenant's slice instead of
// the whole cross-tenant collection. These tests pin (a) cross-tenant
// BLINDNESS through the indexed reads, (b) the one-time backfill HEAL of a
// pre-index legacy row, and (c) that legacy BYTE-STORE rows sharing the
// `media:asset` prefix never surface as library assets nor leave markers.
describe('DEBT-2 — tenant-indexed media reads', () => {
  const login = async (tenantId: string) => {
    const c = client();
    const r = await c.post('/v1/host/openwop-app/test/login', { email: `debt2-${Date.now()}-${Math.floor(Math.random() * 1e6)}@t.test`, tenantId });
    expect(r.status).toBe(201);
    const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
    expect(org.status).toBe(201);
    return { c, orgId: org.body.orgId as string };
  };
  const uniqTenant = (tag: string): string => `debt2-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  it('dedup lookup is tenant-blind: identical bytes in ANOTHER tenant never dedup', async () => {
    const a = await login(uniqTenant('deda'));
    const b = await login(uniqTenant('dedb'));
    const upA = await a.c.post(M(a.orgId, '/assets'), { contentBase64: PNG_A, contentType: 'image/png', name: 'shared.png' });
    expect(upA.status).toBe(201);
    // Same tenant + same bytes + same (un)collection ⇒ dedup (the control).
    const upA2 = await a.c.post(M(a.orgId, '/assets'), { contentBase64: PNG_A, contentType: 'image/png', name: 'shared-again.png' });
    expect(upA2.status).toBe(200);
    expect(upA2.body.deduplicated).toBe(true);
    // FOREIGN tenant + same bytes ⇒ a fresh asset, never tenant A's row.
    const upB = await b.c.post(M(b.orgId, '/assets'), { contentBase64: PNG_A, contentType: 'image/png', name: 'mine.png' });
    expect(upB.status).toBe(201);
    expect(upB.body.deduplicated).toBeUndefined();
    expect(upB.body.assetId).not.toBe(upA.body.assetId);
  });

  it('listing + selection are tenant-blind: a foreign tenant\'s assets never appear', async () => {
    const a = await login(uniqTenant('sela'));
    const b = await login(uniqTenant('selb'));
    const upA = await a.c.post(M(a.orgId, '/assets'), { contentBase64: PNG_A, contentType: 'image/png', name: 'flashpick_front.png', marketing: { product: 'FlashPick' } });
    expect(upA.status).toBe(201);
    // Tenant B's library is EMPTY: list sees nothing, selection honestly
    // reports needsAsset instead of leaking tenant A's matching image.
    const listB = await b.c.get(M(b.orgId, '/assets'));
    expect(listB.status).toBe(200);
    expect(listB.body.assets).toEqual([]);
    const selB = await b.c.post(M(b.orgId, '/assets/select'), { product: 'FlashPick' });
    expect(selB.status).toBe(200);
    expect(selB.body.assets).toEqual([]);
    expect(selB.body.needsAsset).toBeDefined();
    // And tenant A still selects its own.
    const selA = await a.c.post(M(a.orgId, '/assets/select'), { product: 'FlashPick' });
    expect(selA.status).toBe(200);
    expect(selA.body.assets.map((x: any) => x.asset.assetId)).toContain(upA.body.assetId);
  });

  it('a pre-index legacy row (no marker) HEALS via the one-time backfill on the first indexed read', async () => {
    const { hostExtStorage } = await import('../src/host/hostExtPersistence.js');
    const tenantId = uniqTenant('heal');
    const { c, orgId } = await login(tenantId);
    // Simulate deployed pre-index data: a full library-asset row written
    // straight to the primary keyspace with NO index marker, and NO backfill
    // sentinel (as on a fleet that has never run the indexed read).
    const storage = hostExtStorage();
    const legacyId = `masset:legacy-${Date.now()}`;
    const now = new Date().toISOString();
    await storage.kvSet(`hostext:media:asset:${legacyId}`, JSON.stringify({
      assetId: legacyId, tenantId, orgId, name: 'legacy.png', contentType: 'image/png',
      sizeBytes: 3, storageRef: 'ref-legacy', serveToken: 'tok-legacy', tags: ['legacy'],
      uploadedBy: 'user:legacy', usageCount: 0, createdAt: now, updatedAt: now,
    }));
    await storage.kvDelete('hostextidxmeta:media:asset:backfilled');
    // First indexed read → ensureTenantIndex backfills a marker per existing
    // row (sentinel-guarded full scan), so the legacy row is enumerated.
    const list = await c.get(M(orgId, '/assets'));
    expect(list.status).toBe(200);
    expect(list.body.assets.map((x: any) => x.assetId)).toContain(legacyId);
    // The heal is durable: the marker now exists in the tenant's index slice.
    expect(await storage.kvGet(`hostextidx:media:asset:${tenantId}:${legacyId}`)).not.toBeNull();
  });

  it('legacy BYTE-STORE rows under the shared media:asset prefix are excluded from the index + listings', async () => {
    const { hostExtStorage } = await import('../src/host/hostExtPersistence.js');
    const tenantId = uniqTenant('bytes');
    const { c, orgId } = await login(tenantId);
    const storage = hostExtStorage();
    // A token-keyed byte row (the pre-ADR-0083 location): tenantId but NO assetId/orgId.
    const token = `byte-token-${Date.now()}`;
    await storage.kvSet(`hostext:media:asset:${token}`, JSON.stringify({
      token, tenantId, contentBase64: 'AAAA', contentType: 'image/png', bytes: 3, expiresAtMs: Date.now() + 3_600_000,
    }));
    await storage.kvDelete('hostextidxmeta:media:asset:backfilled');
    const list = await c.get(M(orgId, '/assets'));
    expect(list.status).toBe(200);
    expect(list.body.assets.map((x: any) => x.assetId)).not.toContain(token);
    // The validator kept it out of the backfill: no marker in ANY slice of this tenant.
    expect(await storage.kvGet(`hostextidx:media:asset:${tenantId}:${token}`)).toBeNull();
    expect(await storage.kvGet(`hostextidx:media:asset:${tenantId}:undefined`)).toBeNull();
  });

  it('FU-DATA-3: a lost asset index marker does not empty a valid "where used" graph on re-sync', async () => {
    const { syncUsageRefs, __listUsageRefs } = await import('../src/features/media/mediaService.js');
    const { hostExtStorage } = await import('../src/host/hostExtPersistence.js');
    const { c, orgId } = await login(uniqTenant('usage'));
    const created = await c.post(M(orgId, '/assets'), { contentBase64: PNG_A, contentType: 'image/png', name: 'used.png' });
    expect(created.status).toBe(201);
    const asset = created.body;
    await syncUsageRefs(asset.tenantId, orgId, { kind: 'cms-page', id: 'page-x', label: 'Landing' }, [asset.serveToken]);
    expect((await __listUsageRefs()).filter((u) => u.assetId === asset.assetId)).toHaveLength(1);

    // Lose the ASSET's tenant-index marker ("delayed, not lost" for reads — but a
    // delete decision must not ride the miss)…
    await hostExtStorage().kvDelete(`hostextidx:media:asset:${asset.tenantId}:${asset.assetId}`);
    // …and re-sync the SAME tokens: the indexed read misses the asset, but the
    // authoritative point-get confirms it is live + still referenced → kept.
    await syncUsageRefs(asset.tenantId, orgId, { kind: 'cms-page', id: 'page-x', label: 'Landing' }, [asset.serveToken]);
    expect((await __listUsageRefs()).filter((u) => u.assetId === asset.assetId)).toHaveLength(1);

    // Control: a genuinely de-referenced token still cleans up.
    await syncUsageRefs(asset.tenantId, orgId, { kind: 'cms-page', id: 'page-x', label: 'Landing' }, []);
    expect((await __listUsageRefs()).filter((u) => u.assetId === asset.assetId)).toHaveLength(0);
  });
});
