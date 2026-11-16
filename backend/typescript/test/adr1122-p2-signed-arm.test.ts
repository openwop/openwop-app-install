/**
 * ADR 1122 P2 — the signed arm, under `OPENWOP_ASSET_ACCESS=enforce`, with no session:
 *  - a fresh signed URL serves the asset, private, cached no longer than it lives;
 *  - a tampered signature, another asset's signature and an expired one each get the
 *    unknown-token 404;
 *  - a mint is capped at 15 minutes, and a signature claiming longer is refused;
 *  - the signature lives in the query string only: the URL path is the asset's own.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { storeMediaAsset } from '../src/host/inMemorySurfaces.js';
import { assetServeUrl } from '../src/host/assetServePath.js';
import { MAX_SIGNED_SECONDS, PREVIOUS_SECRET_ENV, assetSignatureRemaining, signedAssetUrl } from '../src/host/assetSigning.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const T = `org:p2-${Date.now()}`;
let BASE: string;
let server: http.Server;

const get = async (url: string): Promise<{ status: number; cache: string | null; body: string }> => {
  const res = await fetch(`${BASE}${url}`);
  return { status: res.status, cache: res.headers.get('cache-control'), body: await res.text() };
};
const image = async (): Promise<string> => (await storeMediaAsset(T, { contentBase64: PNG, contentType: 'image/png' })).token;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterEach(() => { delete process.env.OPENWOP_ASSET_ACCESS; });
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 1122 P2 — a signed read serves without a session, briefly', () => {
  it('a fresh signed URL serves the asset, private, for no longer than it lives', async () => {
    process.env.OPENWOP_ASSET_ACCESS = 'enforce';
    const tok = await image();
    expect((await get(assetServeUrl(tok))).status).toBe(404); // unsigned, no session
    const url = signedAssetUrl(tok, 120);
    expect(url.startsWith(`${assetServeUrl(tok)}?`)).toBe(true);
    const r = await get(url);
    expect(r.status).toBe(200);
    const maxAge = Number(/max-age=(\d+)/.exec(r.cache ?? '')?.[1]);
    expect(r.cache).toMatch(/^private, max-age=\d+$/);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(120);
  });

  it('a tampered, another asset’s, or an expired signature gets the unknown-token 404', async () => {
    process.env.OPENWOP_ASSET_ACCESS = 'enforce';
    const tok = await image();
    const other = await image();
    const unknown = await get(assetServeUrl('never-minted-token-p2'));
    const good = signedAssetUrl(tok, 120);
    const sig = good.slice(good.indexOf('asig=') + 5);
    const tampered = `${assetServeUrl(tok)}?asig=${sig.slice(0, -2)}${sig.endsWith('AA') ? 'BB' : 'AA'}`;
    const foreign = `${assetServeUrl(other)}?asig=${sig}`;
    const expired = signedAssetUrl(tok, 60, Date.now() - 10 * 60_000);
    for (const url of [tampered, foreign, expired]) {
      const r = await get(url);
      expect(r.status, url).toBe(404);
      expect(r.body).toBe(unknown.body);
      expect(r.cache).toBe('no-store');
    }
  });

  it('a mint is capped at 15 minutes, and a signature claiming longer is refused', async () => {
    const tok = await image();
    const now = Date.now();
    const url = signedAssetUrl(tok, 24 * 3600, now);
    const remaining = assetSignatureRemaining(tok, url.slice(url.indexOf('asig=') + 5), now);
    expect(remaining).not.toBeNull();
    expect(remaining ?? 0).toBeLessThanOrEqual(MAX_SIGNED_SECONDS);
    // A signature minted "in the future" claims more than any mint allows.
    const far = signedAssetUrl(tok, MAX_SIGNED_SECONDS, now + 60 * 60_000);
    expect(assetSignatureRemaining(tok, far.slice(far.indexOf('asig=') + 5), now)).toBeNull();
    expect(assetSignatureRemaining(tok, undefined)).toBeNull();
    expect(assetSignatureRemaining(tok, 'v2.k.1.x')).toBeNull();
  });

  it('a URL signed under the previous key still verifies during a rotation, and not after', async () => {
    const tok = await image();
    const sigOf = (url: string): string => url.slice(url.indexOf('asig=') + 5);
    const oldSecret = process.env.OPENWOP_SESSION_SECRET ?? '';
    const newSecret = 'rotated-session-secret-at-least-32-characters-long';
    const signedUnderOld = sigOf(signedAssetUrl(tok, 300));
    try {
      process.env.OPENWOP_SESSION_SECRET = newSecret;
      expect(assetSignatureRemaining(tok, signedUnderOld)).toBeNull(); // rotated, old key not held
      process.env[PREVIOUS_SECRET_ENV] = oldSecret;
      expect(assetSignatureRemaining(tok, signedUnderOld)).not.toBeNull(); // held as previous: verifies
      expect(assetSignatureRemaining(tok, sigOf(signedAssetUrl(tok, 300)))).not.toBeNull(); // new mints verify too
    } finally {
      process.env.OPENWOP_SESSION_SECRET = oldSecret;
      delete process.env[PREVIOUS_SECRET_ENV];
    }
  });
});
