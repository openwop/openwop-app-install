/**
 * ADR 0945 P5 — the two read routes behind the provenance drawer and the
 * Product shots panel, through the real HTTP boundary.
 *  - provenance: the stamp, the STORED verdict, and each source resolved in the
 *    caller's org; a deleted source reads `present:false`; another org's
 *    asset is a uniform 404; no prompt text and no serve token for an absent source.
 *  - product media: the product's photos with their roles; an unresolvable
 *    photo is the typed 422; commerce off ⇒ refused.
 */
import http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createAsset, deleteAsset } from '../src/features/media/mediaService.js';
import * as mediaStorage from '../src/features/media/mediaStorage.js';
import { createProduct } from '../src/features/commerce/commerceService.js';
import { recordVerdict, FIDELITY_RULESET_VERSION } from '../src/host/creativeFidelity/index.js';
import { getSetCookies } from './headerCookies.js';

let server: http.Server;
let BASE = '';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let n = 0;
interface Source { assetId: string; sha256: string; present?: boolean; serveUrl?: string; role?: string }
interface Body {
  orgId?: string; error?: string; message?: string; verdict?: unknown; sources?: Source[];
  details?: { feature?: string };
}
function client() {
  let cookie = '';
  return async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Body }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Body };
  };
}
const TENANT = `org:g945p5-${Date.now()}`;
let orgId = '';
let otherOrg = '';
let call: ReturnType<typeof client>;

async function asset(org: string, extra: { grounding?: unknown } = {}) {
  const b64 = Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.from(`#${++n}`)]).toString('base64');
  const s = await mediaStorage.put(TENANT, { contentBase64: b64, contentType: 'image/png' });
  const sha = createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
  return { a: await createAsset({ tenantId: TENANT, orgId: org, name: `a${n}.png`, contentType: 'image/png', sizeBytes: s.sizeBytes, storageRef: s.storageRef, serveToken: s.serveToken, uploadedBy: 'u', contentHash: sha, ...(extra.grounding ? { lineage: { generatedBy: 'ai', prompt: 'SECRET PROMPT TEXT' }, grounding: extra.grounding } : {}) }), sha };
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const d = getToggleDefault('commerce'); if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  call = client();
  expect((await call('POST', '/host/openwop-app/test/login', { email: 'g945p5@acme.test', tenantId: TENANT })).status).toBe(201);
  orgId = String((await call('POST', '/host/openwop-app/orgs', { name: 'Client A' })).body.orgId);
  otherOrg = String((await call('POST', '/host/openwop-app/orgs', { name: 'Client B' })).body.orgId);
}, 120_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const M = (org: string, id: string): string => `/host/openwop-app/media/orgs/${encodeURIComponent(org)}/assets/${encodeURIComponent(id)}/provenance`;

describe('GET …/assets/:assetId/provenance', () => {
  it('returns the stamp, the stored verdict and the in-org sources; no prompt text', async () => {
    const src = await asset(orgId);
    const gone = await asset(orgId);
    const verdictId = `fvd:p5-${++n}`;
    const shot = await asset(orgId, { grounding: { mode: 'composite', productId: 'prod:mug', sources: [{ assetId: src.a.assetId, sha256: src.sha }, { assetId: gone.a.assetId, sha256: gone.sha }], provider: 'openwop', model: 'renderer@1', op: 'render', fidelity: { verdictId, outcome: 'needs_review', rulesetVersion: FIDELITY_RULESET_VERSION } } });
    await recordVerdict({ verdictId, tenantId: TENANT, orgId, assetId: shot.a.assetId, assetSha256: shot.sha, mode: 'composite', sources: [], checks: [{ id: 'dhash', status: 'pass', value: 0, threshold: 10, detail: 'd' }], outcome: 'needs_review', rulesetVersion: FIDELITY_RULESET_VERSION, checkedAt: '2026-10-20T00:00:00Z' });
    await deleteAsset(TENANT, orgId, gone.a.assetId);
    const r = await call('GET', M(orgId, shot.a.assetId));
    expect(r.status).toBe(200);
    expect(r.body.verdict).toMatchObject({ verdictId, outcome: 'needs_review', checks: [{ id: 'dhash', value: 0, threshold: 10 }] });
    const sources = r.body.sources ?? [];
    expect(sources[0]).toMatchObject({ assetId: src.a.assetId, present: true });
    expect(sources[0]?.serveUrl).toEqual(expect.any(String));
    expect(sources[1]).toEqual({ assetId: gone.a.assetId, sha256: gone.sha, present: false });
    expect(JSON.stringify(r.body)).not.toContain('SECRET PROMPT TEXT');
  });

  it('another org\'s asset is a uniform 404', async () => {
    const foreign = await asset(otherOrg, { grounding: { mode: 'none', sources: [], provider: 'p', model: 'm', op: 'generate' } });
    const own = await asset(orgId, { grounding: { mode: 'none', sources: [], provider: 'p', model: 'm', op: 'generate' } });
    expect((await call('GET', M(orgId, own.a.assetId))).status).toBe(200);
    const refused = await call('GET', M(orgId, foreign.a.assetId));
    expect(refused).toMatchObject({ status: 404, body: { error: 'not_found', message: 'Asset not found.' } });
    // Uniform: the foreign id reads like an id that does not exist.
    const shape = (b: Body) => ({ error: b.error, message: b.message, keys: Object.keys(b).sort() });
    expect(shape((await call('GET', M(orgId, 'masset:absent'))).body)).toEqual(shape(refused.body));
  });
});

describe('GET …/products/:productId/media', () => {
  const P = (id: string): string => `/host/openwop-app/commerce/orgs/${encodeURIComponent(orgId)}/products/${encodeURIComponent(id)}/media`;
  it('lists the product\'s photos with roles; an unresolvable photo is the typed 422', async () => {
    const hero = await asset(orgId);
    const p = await createProduct({ tenantId: TENANT, orgId, createdBy: 'u', type: 'physical', name: 'Mug', price: 1, imageAssetTokens: [hero.a.serveToken] });
    const ok = await call('GET', P(p.productId));
    expect(ok.status).toBe(200);
    expect(ok.body.sources).toEqual([expect.objectContaining({ assetId: hero.a.assetId, role: 'hero', sha256: hero.sha })]);
    const bad = await createProduct({ tenantId: TENANT, orgId, createdBy: 'u', type: 'physical', name: 'Bad', price: 1, imageAssetTokens: ['not-a-token'] });
    const r = await call('GET', P(bad.productId));
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('product_media_unresolved');
    // A real token whose asset was deleted: the branch the message is written for.
    const gone = await asset(orgId);
    const stale = await createProduct({ tenantId: TENANT, orgId, createdBy: 'u', type: 'physical', name: 'Stale', price: 1, imageAssetTokens: [gone.a.serveToken] });
    expect(await deleteAsset(TENANT, orgId, gone.a.assetId)).toBe(true);
    expect(await call('GET', P(stale.productId))).toMatchObject({ status: 422, body: { error: 'product_media_unresolved' } });
  });

  it('is refused when commerce is off', async () => {
    const hero = await asset(orgId);
    const p = await createProduct({ tenantId: TENANT, orgId, createdBy: 'u', type: 'physical', name: 'Toggled', price: 1, imageAssetTokens: [hero.a.serveToken] });
    expect((await call('GET', P(p.productId))).status).toBe(200);
    const d = getToggleDefault('commerce');
    if (!d) throw new Error('the commerce toggle is not registered');
    await saveConfig({ ...d, status: 'off' }, 'test');
    try {
      expect(await call('GET', P(p.productId))).toMatchObject({ status: 404, body: { error: 'not_found', details: { feature: 'commerce' } } });
    } finally {
      await saveConfig({ ...d, status: 'on' }, 'test');
    }
  });
});
