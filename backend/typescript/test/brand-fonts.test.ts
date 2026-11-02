/**
 * ADR 0399 OQ-1 — brand custom fonts: the name-table family extraction (C2),
 * TTF/OTF sniff (C3), the attestation-gated upload/list/delete routes and their
 * cross-tenant IDOR 404, and the brand-delete cascade (C1). The renderer
 * integration (a custom font changes the render's family + composite hash) is
 * `creative-briefs-render.test.ts` › "brand custom fonts in the render".
 *
 * Tracker TST-BEG-3 (w66). Red when: the attestation check is dropped; an
 * unknown role is accepted; the family is read from a name id other than 1;
 * the stored bytes come back in the response; delete stops 404ing an absent
 * font; brand delete stops purging fonts. Double guard (recorded): non-font
 * bytes are refused by the TTF/OTF sniff AND by the family-name parse that
 * follows it (`brandFonts.ts putBrandFont`); only breaking both reds the
 * non-TTF case.
 *
 * Real TTF fixtures come from the renderer's OWN embedded fonts (Inter / PT
 * Serif) — no external files, and they are genuine valid faces.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { bundledFontBuffers } from '../src/features/creative-briefs/render/fonts.js';
import { extractFontFamily, getBrandFont, putBrandFont } from '../src/features/brand/brandFonts.js';
import { createBrand, deleteBrand } from '../src/features/brand/brandService.js';

// Embedded buffers, in order: Inter-Regular, Inter-Bold, PT Serif-Regular, PT Serif-Bold.
const [INTER] = bundledFontBuffers();
const PT_SERIF = bundledFontBuffers()[2]!;
const PT_SERIF_B64 = PT_SERIF.toString('base64');

let BASE = '';
let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T }
type ErrBody = { error?: string; details?: { field?: string } };
type FontMeta = { role: string; family: string; licenseAttested: boolean; contentBase64?: unknown };
function client() {
  let cookie = '';
  const call = async <T>(m: string, p: string, b?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${p}`, { method: m, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(b !== undefined ? { body: JSON.stringify(b) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const mm = /(__session=[^;]+)/.exec(ck); if (mm) cookie = mm[1]; }
    const body: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: body as T };
  };
  return {
    get: <T>(p: string) => call<T>('GET', p),
    post: <T>(p: string, b?: unknown) => call<T>('POST', p, b),
    put: <T>(p: string, b?: unknown) => call<T>('PUT', p, b),
    del: <T>(p: string) => call<T>('DELETE', p),
  };
}
async function ownerWithBrand(): Promise<{ c: ReturnType<typeof client>; orgId: string; brandId: string }> {
  const c = client();
  const r = await c.post<unknown>('/host/openwop-app/test/login', { email: `bf-${Date.now()}-${Math.floor(Math.random() * 1e6)}@t.test`, tenantId: `org:bf-${Date.now()}-${Math.floor(Math.random() * 1e6)}` });
  expect(r.status).toBe(201);
  const org = await c.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' });
  const brand = await c.post<{ brand: { id: string } }>('/host/openwop-app/brand/brands', { orgId: org.body.orgId, name: 'FlashPick' });
  expect(brand.status, JSON.stringify(brand.body)).toBe(201);
  return { c, orgId: org.body.orgId, brandId: brand.body.brand.id };
}
const F = (brandId: string, role = ''): string => `/host/openwop-app/brand/brands/${brandId}/fonts${role ? `/${role}` : ''}`;

describe('extractFontFamily + sniff (C2/C3)', () => {
  it('reads the real internal family from a TTF name table', () => {
    expect(extractFontFamily(INTER!)).toBe('Inter');
    expect(extractFontFamily(PT_SERIF)).toBe('PT Serif');
  });
  it('returns null for non-font bytes', () => {
    expect(extractFontFamily(Buffer.from('not a font at all'))).toBeNull();
  });
});

describe('brand font upload routes (ADR 0399 OQ-1)', () => {
  it('requires the license attestation (hard 400)', async () => {
    const { c, brandId } = await ownerWithBrand();
    const r = await c.put<ErrBody>(F(brandId, 'serif'), { contentBase64: PT_SERIF_B64 });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('validation_error');
    expect(r.body.details?.field).toBe('licenseAttested');
  });

  it('rejects non-TTF/OTF bytes and bad base64 (undecodable input is refused by the font sniff)', async () => {
    const { c, brandId } = await ownerWithBrand();
    const woff = await c.put<ErrBody>(F(brandId, 'serif'), { contentBase64: Buffer.from('WOFF2xxxxxxxx').toString('base64'), licenseAttested: true });
    expect(woff.status).toBe(400);
    expect(woff.body).toMatchObject({ error: 'validation_error', details: { field: 'contentBase64' } });
    // `Buffer.from(…, 'base64')` never throws: garbage decodes to non-font bytes.
    const garbage = await c.put<ErrBody>(F(brandId, 'serif'), { contentBase64: '!!!not base64', licenseAttested: true });
    expect(garbage.status).toBe(400);
    expect(garbage.body).toMatchObject({ error: 'validation_error', details: { field: 'contentBase64' } });
    expect((await c.get<{ fonts: FontMeta[] }>(F(brandId))).body.fonts).toEqual([]); // nothing stored
  });

  it('rejects an unknown role', async () => {
    const { c, brandId } = await ownerWithBrand();
    const r = await c.put<ErrBody>(F(brandId, 'mono'), { contentBase64: PT_SERIF_B64, licenseAttested: true });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: 'validation_error', details: { field: 'role' } });
  });

  it('stores an attested font, reports the REAL family, lists + deletes it', async () => {
    const { c, brandId } = await ownerWithBrand();
    const put = await c.put<{ font: FontMeta }>(F(brandId, 'serif'), { contentBase64: PT_SERIF_B64, licenseAttested: true });
    expect(put.status, JSON.stringify(put.body)).toBe(201);
    expect(put.body.font.family).toBe('PT Serif'); // extracted, not caller-typed
    expect(put.body.font).not.toHaveProperty('contentBase64'); // bytes never returned
    expect(put.body.font.licenseAttested).toBe(true);

    const list = await c.get<{ fonts: FontMeta[] }>(F(brandId));
    expect(list.body.fonts.map((f) => f.role)).toEqual(['serif']);

    expect((await c.del(F(brandId, 'serif'))).status).toBe(204);
    expect((await c.get<{ fonts: FontMeta[] }>(F(brandId))).body.fonts).toEqual([]);
    const again = await c.del<ErrBody>(F(brandId, 'serif'));
    expect(again.status).toBe(404); // idempotent-ish
    expect(again.body.error).toBe('not_found');
  });

  it('cross-tenant access is a uniform 404 (loadBrandScoped IDOR)', async () => {
    const { brandId } = await ownerWithBrand();
    const { c: other } = await ownerWithBrand();
    expect((await other.put(F(brandId, 'serif'), { contentBase64: PT_SERIF_B64, licenseAttested: true })).status).toBe(404);
    expect((await other.get(F(brandId))).status).toBe(404);
  });
});

describe('C1 — brand-delete cascade', () => {
  it('deleting a brand purges its font rows (no orphans)', async () => {
    const t = `org:c1-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const brand = await createBrand(t, 'org-1', 'tester', { name: 'Cascade' });
    await putBrandFont({ tenantId: t, brandId: brand.id, role: 'serif', contentBase64: PT_SERIF_B64, licenseAttested: true, attestedBy: 'tester' });
    expect(await getBrandFont(t, brand.id, 'serif')).not.toBeNull();
    await deleteBrand(t, brand.id);
    expect(await getBrandFont(t, brand.id, 'serif')).toBeNull();
  });
});

