/**
 * ADR 0945 P0 — product media resolution and the write-once provenance stamp.
 *
 * Exit criteria (ADR 0945 § Phased plan, P0):
 *  - a foreign-org token is refused (`product_media_unresolved`), and so are an
 *    unknown and a deleted one, with the SAME refusal (no existence leak);
 *  - every generation path writes `lineage.grounding`: the generate route, the
 *    derive routes, the node surface (from the adapter's host record), the
 *    renderer (composedFrom) and the video finaliser (covered in
 *    adr0945-p0-render-video-grounding.test.ts);
 *  - `PATCH lineage:null` keeps `grounding` and `generatedBy:'ai'`.
 * Plus the trust boundary the architect review added: no caller (upload body,
 * PATCH body, node `lineage`) can write or forge `grounding`.
 *
 * Breaks if cleanLineage starts accepting `grounding`, the PATCH clear stops
 * preserving it, a dedup hit drops the stamp, the generate route hashes the
 * truncated prompt, getAssetByServeToken stops checking the org, or
 * resolveProductMedia drops an unresolved token instead of refusing.
 */
import http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Storage } from '../src/storage/storage.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildHostSurfaceBundle, storeMediaAsset } from '../src/host/inMemorySurfaces.js';
import { createAsset, deleteAsset, getAssetByServeToken, cleanLineage, cleanMarketing, getAsset, createCollection, deleteCollection, mergeAssetMetadataOnDedup, updateAsset, markUsed, stampGroundingIfAbsent, type MediaAsset, type MediaGrounding } from '../src/features/media/mediaService.js';
import * as mediaStorage from '../src/features/media/mediaStorage.js';
import { createProduct } from '../src/features/commerce/commerceService.js';
import { resolveProductMedia } from '../src/features/commerce/productMedia.js';
import { OpenwopError } from '../src/types.js';

let BASE: string;
let server: http.Server;
let storage: Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'media', 'commerce']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const sha = (b64: string): string => createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
/** The deterministic mock provider's output bytes (aiProvidersHost MOCK_IMAGE_PNG_B64). */
const MOCK_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMEAQDWUFLAAAAAAElFTkSuQmCC';
/** A different 1×1 PNG (a "real" upload). */
const PHOTO_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

interface Res<T> { status: number; body: T }
interface Grounding { mode: string; productId?: string; sources: Array<{ assetId: string; sha256: string }>; promptHash?: string; provider: string; model: string; op: string; runId?: string; nodeId?: string }
interface AssetView { assetId: string; serveUrl: string; lineage?: { generatedBy?: string; prompt?: string; rightsNote?: string; grounding?: Grounding } }
interface AssetsBody { assets: AssetView[] }

function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T };
  };
  return { post: <T>(p: string, b?: unknown) => call<T>('POST', p, b), patch: <T>(p: string, b?: unknown) => call<T>('PATCH', p, b) };
}
const M = (orgId: string, s = ''): string => `/host/openwop-app/media/orgs/${encodeURIComponent(orgId)}${s}`;
const uniq = (): string => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function ownerWithOrg() {
  const c = client();
  const tenantId = `org:g945-${uniq()}`;
  const r = await c.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `g945-${uniq()}@t.test`, tenantId });
  expect(r.status).toBe(201);
  const org = await c.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status).toBe(201);
  return { c, orgId: org.body.orgId, tenantId };
}

describe('the generate route stamps grounding (D4)', () => {
  it('records mode none, the FULL-prompt hash, and the model the adapter ran — and no synthetic run id', async () => {
    const { c, orgId } = await ownerWithOrg();
    const prompt = `A product-less studio backdrop. ${'soft light '.repeat(80)}`; // > 500 chars: lineage.prompt is cut, the hash is not
    expect(prompt.length).toBeGreaterThan(500);
    const r = await c.post<AssetsBody>(M(orgId, '/assets/generate'), { prompt, provider: 'mock' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const g = r.body.assets[0].lineage?.grounding;
    expect(g).toMatchObject({ mode: 'none', sources: [], provider: 'mock', model: 'mock-image-1', op: 'generate' });
    expect(g?.promptHash).toBe(createHash('sha256').update(prompt).digest('hex'));
    expect(g?.promptHash).not.toBe(createHash('sha256').update(prompt.slice(0, 500)).digest('hex'));
    expect(g?.runId, 'a route adapter run id is not a run anyone can open').toBeUndefined();
  });

  it('a dedup hit on an UNSTAMPED row gets the first write; a second generation never replaces it', async () => {
    const { c, orgId } = await ownerWithOrg();
    // A plain upload of the exact bytes the mock will return.
    const up = await c.post<AssetView>(M(orgId, '/assets'), { contentBase64: MOCK_PNG, contentType: 'image/png', name: 'same.png' });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(up.body.lineage?.grounding).toBeUndefined();
    const first = await c.post<AssetsBody>(M(orgId, '/assets/generate'), { prompt: 'first prompt', provider: 'mock' });
    expect(first.body.assets[0].assetId, 'dedup reused the upload').toBe(up.body.assetId);
    expect(first.body.assets[0].lineage?.grounding?.promptHash).toBe(createHash('sha256').update('first prompt').digest('hex'));
    expect(first.body.assets[0].lineage?.generatedBy).toBe('ai');
    const second = await c.post<AssetsBody>(M(orgId, '/assets/generate'), { prompt: 'second prompt', provider: 'mock' });
    expect(second.body.assets[0].lineage?.grounding?.promptHash, 'write-once: first stamp wins').toBe(createHash('sha256').update('first prompt').digest('hex'));
  });
});

describe('the write-once rule and the trust boundary (D4)', () => {
  it('PATCH lineage:null keeps grounding AND generatedBy; a PATCH cannot set or change grounding', async () => {
    const { c, orgId } = await ownerWithOrg();
    const gen = await c.post<AssetsBody>(M(orgId, '/assets/generate'), { prompt: 'keep me', provider: 'mock' });
    const asset = gen.body.assets[0];
    const before = asset.lineage!.grounding!;
    const cleared = await c.patch<AssetView>(M(orgId, `/assets/${encodeURIComponent(asset.assetId)}`), { lineage: null });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.lineage?.grounding).toEqual(before);
    expect(cleared.body.lineage?.generatedBy, 'a clear cannot launder an AI asset').toBe('ai');
    expect(cleared.body.lineage?.prompt, 'the rest of lineage still clears').toBeUndefined();
    const forged = await c.patch<AssetView>(M(orgId, `/assets/${encodeURIComponent(asset.assetId)}`), { lineage: { rightsNote: 'ok', grounding: { ...before, mode: 'composite', productId: 'prod:forged' } } });
    expect(forged.body.lineage?.grounding).toEqual(before);
    expect(forged.body.lineage?.rightsNote).toBe('ok');
  });

  it('an upload body cannot forge grounding', async () => {
    const { c, orgId } = await ownerWithOrg();
    const forged = { mode: 'composite', productId: 'prod:x', sources: [{ assetId: 'masset:x', sha256: 'a'.repeat(64) }], provider: 'p', model: 'm', op: 'render' };
    const up = await c.post<AssetView>(M(orgId, '/assets'), { contentBase64: PHOTO_PNG, contentType: 'image/png', name: 'p.png', lineage: { generatedBy: 'ai', grounding: forged } });
    expect(up.status).toBe(201);
    expect(up.body.lineage?.grounding).toBeUndefined();
    expect(cleanLineage({ grounding: forged }), 'cleanLineage drops the key').toBeUndefined();
  });

  it('derive ops record mode edit with the source pinned by id + hash, and the source product', async () => {
    const { c, orgId } = await ownerWithOrg();
    const src = await c.post<AssetView>(M(orgId, '/assets'), { contentBase64: PHOTO_PNG, contentType: 'image/png', name: 'shoe.png', marketing: { productId: 'prod:shoe-1', shotRole: 'hero' } });
    expect(src.status).toBe(201);
    const r = await c.post<AssetsBody>(M(orgId, `/assets/${encodeURIComponent(src.body.assetId)}/ai-edit`), { op: 'background-remove', provider: 'mock' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.assets[0].lineage?.grounding).toMatchObject({
      mode: 'edit', productId: 'prod:shoe-1', provider: 'mock', op: 'background-remove',
      sources: [{ assetId: src.body.assetId, sha256: sha(PHOTO_PNG) }],
    });
  });
});

describe('the node surface stamps grounding from the HOST record (D4)', () => {
  const TENANT = `org:g945-surface-${uniq()}`;
  const ORG = 'org-s';
  const surface = (runId: string) =>
    buildHostSurfaceBundle({ tenantId: TENANT, runId }).features.media as Record<string, (a: Record<string, unknown>) => Promise<Record<string, unknown>>>;

  it('adapter-minted bytes get run + node, even when the node passes no lineage; a forged grounding is ignored', async () => {
    const stored = await storeMediaAsset(TENANT, { contentBase64: PHOTO_PNG, contentType: 'image/png', aiOrigin: { provider: 'replicate', model: 'flux', op: 'text-to-video', runId: 'run-a', nodeId: 'n-reel', promptHash: 'b'.repeat(64) } });
    const out = await surface('run-a').createAssetFromServeUrl!({ orgId: ORG, url: stored.url, lineage: { grounding: { mode: 'composite', productId: 'prod:lie' } } });
    const row = await getAsset(TENANT, ORG, String(out.assetId));
    expect(row?.lineage?.grounding).toEqual({ mode: 'none', sources: [], promptHash: 'b'.repeat(64), provider: 'replicate', model: 'flux', op: 'text-to-video', runId: 'run-a', nodeId: 'n-reel' });
    expect(row?.lineage?.generatedBy).toBe('ai');
  });

  it('plain bytes with no AI claim get no grounding (an export is not a generation)', async () => {
    const stored = await storeMediaAsset(TENANT, { contentBase64: MOCK_PNG, contentType: 'image/png' });
    const out = await surface('run-b').createAssetFromServeUrl!({ orgId: ORG, url: stored.url });
    expect((await getAsset(TENANT, ORG, String(out.assetId)))?.lineage?.grounding).toBeUndefined();
  });
});

describe('media lookups (D1)', () => {
  const TENANT = `org:g945-media-${uniq()}`;
  async function asset(orgId: string, b64: string, marketing?: unknown) {
    const stored = await mediaStorage.put(TENANT, { contentBase64: b64, contentType: 'image/png' });
    return createAsset({ tenantId: TENANT, orgId, name: 'x.png', contentType: 'image/png', sizeBytes: stored.sizeBytes, storageRef: stored.storageRef, serveToken: stored.serveToken, uploadedBy: 'u', contentHash: sha(b64), ...(marketing ? { marketing } : {}) });
  }

  it('getAssetByServeToken resolves in-org, refuses another org and a deleted asset', async () => {
    const a = await asset('org-a', PHOTO_PNG);
    expect((await getAssetByServeToken(TENANT, 'org-a', a.serveToken))?.assetId).toBe(a.assetId);
    expect(await getAssetByServeToken(TENANT, 'org-b', a.serveToken)).toBeNull();
    expect(await getAssetByServeToken('org:someone-else', 'org-a', a.serveToken)).toBeNull();
    expect(await deleteAsset(TENANT, 'org-a', a.assetId)).toBe(true);
    expect(await getAssetByServeToken(TENANT, 'org-a', a.serveToken)).toBeNull();
  });

  it('cleanMarketing types productId + shotRole and drops junk', () => {
    expect(cleanMarketing({ productId: 'prod:1', shotRole: 'label' })).toEqual({ productId: 'prod:1', shotRole: 'label' });
    expect(cleanMarketing({ productId: 'not an id!', shotRole: 'glamour' })).toBeUndefined();
  });

  it('resolveProductMedia returns org-checked sources with hashes and roles', async () => {
    const hero = await asset('org-p', PHOTO_PNG);
    const label = await asset('org-p', MOCK_PNG, { shotRole: 'label' });
    const p = await createProduct({ tenantId: TENANT, orgId: 'org-p', createdBy: 'u', type: 'physical', name: 'Shoe', price: 10, imageAssetTokens: [hero.serveToken, mediaStorage.serveUrl(label.serveToken)] });
    const sources = await resolveProductMedia({ tenantId: TENANT, orgId: 'org-p', productId: p.productId });
    expect(sources).toEqual([
      { assetId: hero.assetId, serveToken: hero.serveToken, sha256: sha(PHOTO_PNG), role: 'hero' },
      { assetId: label.assetId, serveToken: label.serveToken, sha256: sha(MOCK_PNG), role: 'label' },
    ]);
  });

  it('a foreign-org token, an unknown token and a deleted asset are ALL refused the same way', async () => {
    const own = await asset('org-q', PHOTO_PNG);
    const foreign = await asset('org-other', PHOTO_PNG);
    const gone = await asset('org-q', MOCK_PNG);
    await deleteAsset(TENANT, 'org-q', gone.assetId);
    for (const [bad, label] of [[foreign.serveToken, 'foreign org'], ['not-a-real-token', 'unknown'], [gone.serveToken, 'deleted']] as const) {
      const p = await createProduct({ tenantId: TENANT, orgId: 'org-q', createdBy: 'u', type: 'physical', name: `P ${label}`, price: 1, imageAssetTokens: [own.serveToken, bad] });
      const err = await resolveProductMedia({ tenantId: TENANT, orgId: 'org-q', productId: p.productId }).catch((e: unknown) => e);
      expect(err, label).toBeInstanceOf(OpenwopError);
      expect((err as OpenwopError).code, label).toBe('product_media_unresolved');
      expect((err as OpenwopError).httpStatus).toBe(422);
      expect((err as OpenwopError).details, label).toEqual({ productId: p.productId, index: 1 });
    }
  });

  it('a product of another org is a 404, not a resolution', async () => {
    const own = await asset('org-r', PHOTO_PNG);
    const p = await createProduct({ tenantId: TENANT, orgId: 'org-r', createdBy: 'u', type: 'physical', name: 'R', price: 1, imageAssetTokens: [own.serveToken] });
    const err = await resolveProductMedia({ tenantId: TENANT, orgId: 'org-x', productId: p.productId }).catch((e: unknown) => e);
    expect((err as OpenwopError).code).toBe('not_found');
  });
});


describe('existing media mutations preserve concurrent provenance', () => {
  const TENANT = `org:g945-cas-${uniq()}`;
  const ORG = 'org-cas';
  const grounding: MediaGrounding = { mode: 'none', sources: [], provider: 'mock', model: 'm', op: 'generate', fidelity: { verdictId: 'v1', outcome: 'pass', rulesetVersion: 'r1' } };
  async function asset(collectionId?: string, lineage?: unknown): Promise<MediaAsset> {
    const stored = await mediaStorage.put(TENANT, { contentBase64: PHOTO_PNG, contentType: 'image/png' });
    return createAsset({ tenantId: TENANT, orgId: ORG, name: 'before.png', contentType: 'image/png',
      sizeBytes: stored.sizeBytes, storageRef: stored.storageRef, serveToken: stored.serveToken, uploadedBy: 'u', lineage, ...(collectionId ? { collectionId } : {}) });
  }
  async function stampAfterRead<T>(a: MediaAsset, work: () => Promise<T>): Promise<T> {
    const get = storage.kvGet.bind(storage);
    let fired = false;
    storage.kvGet = async (key) => {
      const captured = await get(key);
      if (!fired && key.includes('media:asset') && captured?.includes(`"assetId":"${a.assetId}"`)) {
        fired = true;
        await stampGroundingIfAbsent(a, grounding);
      }
      return captured;
    };
    try { const result = await work(); expect(fired).toBe(true); return result; }
    finally { storage.kvGet = get; }
  }
  async function afterAssetList<T>(a: MediaAsset, raced: () => Promise<unknown>, work: () => Promise<T>): Promise<T> {
    const list = storage.kvList.bind(storage);
    let fired = false;
    storage.kvList = async (prefix) => {
      const captured = await list(prefix);
      if (!fired && captured.some((r) => r.value.includes(`"assetId":"${a.assetId}"`))) {
        fired = true;
        await raced();
      }
      return captured;
    };
    try { const result = await work(); expect(fired).toBe(true); return result; }
    finally { storage.kvList = list; }
  }

  it.each(['update', 'usage'] as const)('%s rereads a provenance stamp arriving after its snapshot', async (kind) => {
    const a = await asset();
    await stampAfterRead(a, () => kind === 'update'
      ? updateAsset(TENANT, ORG, a.assetId, { name: 'after.png', lineage: null })
      : markUsed(TENANT, ORG, a.assetId));
    const current = await getAsset(TENANT, ORG, a.assetId);
    expect(current?.lineage).toMatchObject({ generatedBy: 'ai', grounding });
    if (kind === 'update') expect(current?.name).toBe('after.png');
    else expect(current?.usageCount).toBe(1);
  });

  it('dedup merges new metadata into the current grounded row rather than its stale argument', async () => {
    const stale = await asset();
    await stampGroundingIfAbsent(stale, grounding);
    const current = await mergeAssetMetadataOnDedup(stale, { tags: ['new-tag'] });
    expect(current.tags).toContain('new-tag');
    expect((await getAsset(TENANT, ORG, stale.assetId))?.lineage).toMatchObject({ generatedBy: 'ai', grounding });
  });

  it('collection rehoming keeps provenance committed after the collection snapshot', async () => {
    const collection = await createCollection(TENANT, ORG, 'old', 'u');
    const a = await asset(collection.collectionId);
    expect(await afterAssetList(a, () => stampGroundingIfAbsent(a, grounding), () => deleteCollection(TENANT, ORG, collection.collectionId))).toEqual({ rehomed: 1 });
    const current = await getAsset(TENANT, ORG, a.assetId);
    expect(current?.collectionId).toBeUndefined();
    expect(current?.lineage).toMatchObject({ generatedBy: 'ai', grounding });
  });

  it('collection deletion does not undo a concurrent move to another collection', async () => {
    const old = await createCollection(TENANT, ORG, 'old', 'u');
    const next = await createCollection(TENANT, ORG, 'next', 'u');
    const a = await asset(old.collectionId);
    expect(await afterAssetList(a, () => updateAsset(TENANT, ORG, a.assetId, { collectionId: next.collectionId }), () => deleteCollection(TENANT, ORG, old.collectionId))).toEqual({ rehomed: 0 });
    expect((await getAsset(TENANT, ORG, a.assetId))?.collectionId).toBe(next.collectionId);
  });

  it('first grounding stays fixed while trusted AI classification can only increase', async () => {
    const a = await asset();
    const photo = await stampGroundingIfAbsent(a, grounding, { ai: false });
    expect(photo.lineage?.generatedBy).toBeUndefined();
    const ai = await stampGroundingIfAbsent(photo, { ...grounding, model: 'later' }, { ai: true });
    expect(ai.lineage).toMatchObject({ generatedBy: 'ai', grounding });
    const stillAi = await stampGroundingIfAbsent(ai, grounding, { ai: false });
    expect(stillAi.lineage).toEqual(ai.lineage);
  });

  it('an older AI asset without grounding cannot lose its AI classification through lineage edits', async () => {
    const a = await asset(undefined, { generatedBy: 'ai', prompt: 'old prompt' });
    const cleared = await updateAsset(TENANT, ORG, a.assetId, { lineage: null });
    expect(cleared?.lineage).toEqual({ generatedBy: 'ai' });
    const replaced = await updateAsset(TENANT, ORG, a.assetId, { lineage: { rightsNote: 'new note' } });
    expect(replaced?.lineage).toEqual({ generatedBy: 'ai', rightsNote: 'new note' });
  });

  it('grounding refuses exhausted CAS retries instead of returning an ungrounded success', async () => {
    const a = await asset();
    const cas = storage.kvCompareAndSwap.bind(storage);
    storage.kvCompareAndSwap = async (...args: Parameters<Storage['kvCompareAndSwap']>) => args[0].includes('media:asset')
      ? { swapped: false, actual: args[1] } : cas(...args);
    try { await expect(stampGroundingIfAbsent(a, grounding)).rejects.toMatchObject({ httpStatus: 409 }); }
    finally { storage.kvCompareAndSwap = cas; }
    expect((await getAsset(TENANT, ORG, a.assetId))?.lineage?.grounding).toBeUndefined();
  });

  it('stale mutation handles never resurrect a deleted asset or report grounding success', async () => {
    const a = await asset();
    expect(await deleteAsset(TENANT, ORG, a.assetId)).toBe(true);
    await expect(stampGroundingIfAbsent(a, grounding)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(mergeAssetMetadataOnDedup(a, { tags: ['new'] })).rejects.toMatchObject({ httpStatus: 404 });
    expect(await updateAsset(TENANT, ORG, a.assetId, { name: 'resurrected' })).toBeNull();
    expect(await markUsed(TENANT, ORG, a.assetId)).toBeNull();
    expect(await getAsset(TENANT, ORG, a.assetId)).toBeNull();
  });
});
