/**
 * ADR 0399 — ad-layout renderer: determinism (same input ⇒ identical bytes),
 * SVG-injection guards, nudge clamping, and the ROUTE surface (template
 * catalog, render + variant fan-out storing hash-deduped media assets,
 * cross-tenant IDOR uniform-404, delete).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { renderAd, composeAdSvg, wrapText, clampNudge, isSafeSvgColor, type RenderAdInput } from '../src/features/creative-briefs/render/renderCreative.js';
import { getTemplate, AD_LAYOUT_TEMPLATES } from '../src/features/creative-briefs/render/templates.js';
import { checkSafeZones } from '../src/features/creative-briefs/render/safeZones.js';
import { stableStringify } from '../src/features/creative-briefs/render/renderService.js';

// THE TIMEOUT CLIFF, fixed as a CLASS this time.
//
// cb65c8a0c raised the budget on ONE test in this file and measured only that
// one. Its neighbour went red on the very next full run — "renders every catalog
// template" costs 4.9s against the 15s default, a 3.1x margin that reads safe
// and is not once 1300 suites contend for the machine. That is the same
// per-instance-instead-of-per-class mistake this programme keeps documenting,
// made by the commit that documented it.
//
// So the budget belongs to the FILE, because the property is a property of the
// file: every test here rasterizes real images. Measured, unloaded:
//   4.9s  renders every catalog template
//   2.8s  deterministic GIF89a from N reveal frames
//   2.6s  route: animate:true stores a GIF asset
//   <1s   everything else
// 60s gives the slowest ~12x, and no future test added here inherits a 15s cliff.
// `hookTimeout` too: the beforeAll boots a real server, and leaving it at the
// default was half of the earlier flake (#2476).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let BASE = '';
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'creative-briefs', 'media', 'brand']) {
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
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), put: (p: string, b?: unknown) => call('PUT', p, b), del: (p: string) => call('DELETE', p) };
}

const CB = (orgId: string, s = ''): string => `/v1/host/openwop-app/creative-briefs/orgs/${encodeURIComponent(orgId)}${s}`;
const M = (orgId: string, s = ''): string => `/v1/host/openwop-app/media/orgs/${encodeURIComponent(orgId)}${s}`;

// A valid 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function ownerWithOrg() {
  const c = client();
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `cbr-${Date.now()}-${Math.floor(Math.random() * 1e6)}@t.test`, tenantId: `org:cbr-${Date.now()}-${Math.floor(Math.random() * 1e6)}` });
  expect(r.status).toBe(201);
  const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status).toBe(201);
  return { c, orgId: org.body.orgId as string };
}

const NEUTRAL_BRAND = {
  colors: { ink: '#111111', paper: '#ffffff', accent: '#3b5bdb', accentInk: '#ffffff' },
  fontFamilies: { sans: 'Inter', serif: 'PT Serif' },
} as const;

function baseInput(): RenderAdInput {
  const template = getTemplate('meta.feed.1x1');
  if (!template) throw new Error('template missing');
  return {
    template,
    content: {
      images: { background: { dataUri: `data:image/png;base64,${PNG}`, sha256: 'x'.repeat(64) } },
      texts: { headline: 'Fresh produce, picked tonight', body: 'Robots that never bruise a tomato', cta: 'Learn more' },
    },
    brand: { colors: { ...NEUTRAL_BRAND.colors }, fontFamilies: { ...NEUTRAL_BRAND.fontFamilies } },
  };
}

describe('renderCreative (pure)', () => {
  it('same input ⇒ byte-identical PNG (the same-pixels guarantee)', () => {
    const a = renderAd(baseInput());
    const b = renderAd(baseInput());
    expect(a.png.length).toBeGreaterThan(500);
    expect(Buffer.compare(a.png, b.png)).toBe(0);
    expect(a.svg).toBe(b.svg);
  });

  it('a changed input changes the SVG (no accidental input-blindness)', () => {
    const changed = baseInput();
    changed.content.texts.headline = 'Different headline';
    expect(composeAdSvg(changed).svg).not.toBe(composeAdSvg(baseInput()).svg);
  });

  it('escapes user copy — markup in a headline never lands raw in the SVG', () => {
    const input = baseInput();
    input.content.texts.headline = `<script>alert('x')</script> & "quotes"`;
    const { svg } = composeAdSvg(input);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });

  it('renders every catalog template without throwing', () => {
    for (const t of AD_LAYOUT_TEMPLATES) {
      const input = { ...baseInput(), template: t };
      const out = renderAd(input);
      expect(out.png.length, t.templateId).toBeGreaterThan(100);
    }
  });

  it('truncates overflowing copy with a warning instead of overflowing the box', () => {
    const input = baseInput();
    input.content.texts.headline = 'word '.repeat(120).trim();
    const { warnings } = composeAdSvg(input);
    expect(warnings.some((w) => w.code === 'text-truncated' && w.layerId === 'headline')).toBe(true);
    const wrapped = wrapText('one two three four five', { widthPx: 100, sizePx: 20, fontRole: 'sans', weight: 400, maxLines: 2 });
    expect(wrapped.truncated).toBe(true);
    expect(wrapped.lines.length).toBe(2);
    expect(wrapped.lines[1]?.endsWith('…')).toBe(true);
  });

  it('nudges are clamped to ±10% translate and the 0.8–1.25 scale window', () => {
    const template = getTemplate('meta.feed.1x1');
    if (!template) throw new Error('template missing');
    const n = clampNudge({ dx: 99999, dy: -99999, scale: 9 }, template);
    expect(n.dx).toBe(108);
    expect(n.dy).toBe(-108);
    expect(n.scale).toBe(1.25);
    const applied = composeAdSvg({ ...baseInput(), overrides: { headline: { dx: 40 } } });
    expect(applied.svg).not.toBe(composeAdSvg(baseInput()).svg);
  });

  it('only #hex colors are accepted into the SVG (attribute-injection guard)', () => {
    expect(isSafeSvgColor('#fff')).toBe(true);
    expect(isSafeSvgColor('#a1b2c3')).toBe(true);
    expect(isSafeSvgColor('#a1b2c3ff')).toBe(true);
    expect(isSafeSvgColor('red')).toBe(false);
    expect(isSafeSvgColor('url(#evil)')).toBe(false);
    expect(isSafeSvgColor('"/><script>')).toBe(false);
  });

  it('stableStringify is insertion-order independent (hash-input stability)', () => {
    expect(stableStringify({ a: 1, b: [{ d: 2, c: 3 }] })).toBe(stableStringify({ b: [{ c: 3, d: 2 }], a: 1 }));
  });
});

describe('render routes', () => {
  it('serves the template catalog', async () => {
    const { c, orgId } = await ownerWithOrg();
    const r = await c.get(CB(orgId, '/render-templates'));
    expect(r.status).toBe(200);
    expect(r.body.templates.length).toBeGreaterThanOrEqual(4);
    expect(r.body.templates[0]).toHaveProperty('safeZones');
    expect(r.body.templates[0]).toHaveProperty('layers');
  });

  it('renders a brief to a stored, hash-deduped media asset; re-render reuses the row', async () => {
    const { c, orgId } = await ownerWithOrg();
    const up = await c.post(M(orgId, '/assets'), { contentBase64: PNG, contentType: 'image/png', name: 'bg.png' });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const brief = await c.post(CB(orgId, '/briefs'), {
      title: 'Hero shot', assetType: 'image', sceneDescription: 'Bright warehouse.',
      directions: [{ label: 'Product in use' }],
      moodBoard: [{ mediaAssetId: up.body.assetId }],
    });
    expect(brief.status).toBe(201);

    const r1 = await c.post(CB(orgId, `/briefs/${brief.body.briefId}/renders`), { templateId: 'meta.feed.1x1', directionIndex: 0, copy: { cta: 'Shop now' } });
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    expect(r1.body.mediaAssetId).toMatch(/^masset:/);
    expect(r1.body.compositeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r1.body.templateId).toBe('meta.feed.1x1');
    expect(r1.body.copy.headline).toBe('Product in use');

    // The composed asset is a real library asset (PNG).
    const asset = await c.get(M(orgId, `/assets/${r1.body.mediaAssetId}`));
    expect(asset.status).toBe(200);
    expect(asset.body.contentType).toBe('image/png');

    // Identical inputs ⇒ identical pixels ⇒ the SAME asset row (dedup).
    const r2 = await c.post(CB(orgId, `/briefs/${brief.body.briefId}/renders`), { templateId: 'meta.feed.1x1', directionIndex: 0, copy: { cta: 'Shop now' } });
    expect(r2.status).toBe(201);
    expect(r2.body.mediaAssetId).toBe(r1.body.mediaAssetId);
    expect(r2.body.compositeHash).toBe(r1.body.compositeHash);

    const list = await c.get(CB(orgId, `/briefs/${brief.body.briefId}/renders`));
    expect(list.status).toBe(200);
    expect(list.body.renders.length).toBe(2);

    const del = await c.del(CB(orgId, `/briefs/${brief.body.briefId}/renders/${r2.body.renderId}`));
    expect(del.status).toBe(204);
    expect((await c.get(CB(orgId, `/briefs/${brief.body.briefId}/renders`))).body.renders.length).toBe(1);
  });

  it('fans one brief across a template family (variant generation)', async () => {
    const { c, orgId } = await ownerWithOrg();
    const brief = await c.post(CB(orgId, '/briefs'), { title: 'Variant test', assetType: 'image', sceneDescription: 'Scene.' });
    expect(brief.status).toBe(201);
    const r = await c.post(CB(orgId, `/briefs/${brief.body.briefId}/renders`), { templateIds: ['meta.feed.1x1', 'linkedin.landscape.191x1', 'nope.bogus'] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.renders.length).toBe(2);
    expect(r.body.failures.length).toBe(1);
    expect(r.body.failures[0].templateId).toBe('nope.bogus');
    // No background asset ⇒ honest warning, not a failure.
    expect(r.body.renders[0].warnings.some((w: { code: string }) => w.code === 'missing-layer-image')).toBe(true);
  });

  it('cross-org access is a uniform 404 (IDOR)', async () => {
    const { c, orgId } = await ownerWithOrg();
    const brief = await c.post(CB(orgId, '/briefs'), { title: 'Mine', assetType: 'image', sceneDescription: 'S.' });
    const { c: other, orgId: otherOrg } = await ownerWithOrg();
    const r = await other.post(CB(otherOrg, `/briefs/${brief.body.briefId}/renders`), { templateId: 'meta.feed.1x1' });
    expect(r.status).toBe(404);
    const l = await other.get(CB(otherOrg, `/briefs/${brief.body.briefId}/renders`));
    expect(l.status).toBe(404);
  });

  it('unknown template is a typed validation error', async () => {
    const { c, orgId } = await ownerWithOrg();
    const brief = await c.post(CB(orgId, '/briefs'), { title: 'T', assetType: 'image', sceneDescription: 'S.' });
    const r = await c.post(CB(orgId, `/briefs/${brief.body.briefId}/renders`), { templateId: 'not.a.template' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('validation_error');
  });
});

describe('safe zones (ADR 0399 §4)', () => {
  it('a default story render is safe-by-design (zero overlap warnings)', () => {
    const template = getTemplate('tiktok.9x16');
    if (!template) throw new Error('template missing');
    const { layerBboxes } = composeAdSvg({ ...baseInput(), template });
    const warnings = checkSafeZones(template, layerBboxes);
    expect(warnings.filter((w) => w.code === 'safe-zone-overlap')).toEqual([]);
  });

  it('a nudged CTA that enters the caption band gets an overlap warning with a pct', () => {
    const template = getTemplate('tiktok.9x16');
    if (!template) throw new Error('template missing');
    const nudged = composeAdSvg({ ...baseInput(), template, overrides: { cta: { dy: 108 } } });
    const warnings = checkSafeZones(template, nudged.layerBboxes);
    const hit = warnings.find((w) => w.code === 'safe-zone-overlap' && w.layerId === 'cta');
    expect(hit).toBeTruthy();
    expect(hit?.safeZoneId).toBe('tiktok-bottom');
    expect(hit?.overlapPct).toBeGreaterThan(0);
  });

  it('imagery under a safe zone does NOT warn (only copy and logos)', () => {
    const template = getTemplate('tiktok.9x16');
    if (!template) throw new Error('template missing');
    const { layerBboxes } = composeAdSvg({ ...baseInput(), template });
    // background covers every safe zone by construction, yet never warns.
    expect(checkSafeZones(template, layerBboxes).some((w) => w.layerId === 'background')).toBe(false);
  });

  it('the textRulePct advisory fires on text-heavy layouts and stays quiet otherwise', () => {
    const template = getTemplate('meta.feed.1x1');
    if (!template) throw new Error('template missing');
    const { layerBboxes } = composeAdSvg(baseInput());
    expect(checkSafeZones(template, layerBboxes, { textRulePct: 90 })).toEqual([]);
    const strict = checkSafeZones(template, layerBboxes, { textRulePct: 1 });
    expect(strict.some((w) => w.code === 'text-rule-exceeded')).toBe(true);
  });
});

describe('media-delete cascade (DATB-1 — the mediaAssetLifecycle seam)', () => {
  it('deleting the COMPOSED asset prunes its render rows; deleting an INPUT asset tolerates', async () => {
    const { c, orgId } = await ownerWithOrg();
    const up = await c.post(M(orgId, '/assets'), { contentBase64: PNG, contentType: 'image/png', name: 'layer.png' });
    expect(up.status).toBe(201);
    const brief = await c.post(CB(orgId, '/briefs'), {
      title: 'Cascade test', assetType: 'image', sceneDescription: 'S.',
      moodBoard: [{ mediaAssetId: up.body.assetId }],
    });
    const briefId = brief.body.briefId;
    const r = await c.post(CB(orgId, `/briefs/${briefId}/renders`), { templateId: 'meta.feed.1x1' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.layerAssets.background.mediaAssetId).toBe(up.body.assetId);

    // Deleting the INPUT layer asset TOLERATES: the render row survives as
    // historical provenance (its layerAssets ref now dangles by design).
    expect((await c.del(M(orgId, `/assets/${up.body.assetId}`))).status).toBe(204);
    const afterInput = await c.get(CB(orgId, `/briefs/${briefId}/renders`));
    expect(afterInput.body.renders.length).toBe(1);

    // Deleting the COMPOSED PNG PRUNES the render row (derived + regenerable —
    // useless without its pixels).
    expect((await c.del(M(orgId, `/assets/${r.body.mediaAssetId}`))).status).toBe(204);
    const afterComposed = await c.get(CB(orgId, `/briefs/${briefId}/renders`));
    expect(afterComposed.body.renders).toEqual([]);
  });
});

describe('explicit layer overrides (the FE layer-picker contract)', () => {
  it('honors an explicit background/product asset that is NOT on the mood board', async () => {
    const { c, orgId } = await ownerWithOrg();
    // Two DISTINCT PNGs — identical bytes would dedup to one asset (and the
    // renderer correctly skips 'product' when it equals 'background').
    const RED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z/C/HgAGgwJ/lK3Q6wAAAABJRU5ErkJggg==';
    const bg = await c.post(M(orgId, '/assets'), { contentBase64: PNG, contentType: 'image/png', name: 'chosen-bg.png' });
    const prod = await c.post(M(orgId, '/assets'), { contentBase64: RED_PNG, contentType: 'image/png', name: 'gen-prod.png' });
    expect(bg.status).toBe(201);
    // Brief with an EMPTY mood board — the picker is the only image source.
    const brief = await c.post(CB(orgId, '/briefs'), { title: 'Explicit layers', assetType: 'image', sceneDescription: 'S.' });
    const r = await c.post(CB(orgId, `/briefs/${brief.body.briefId}/renders`), {
      templateId: 'meta.feed.1x1',
      layers: { background: bg.body.assetId, product: prod.body.assetId },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.layerAssets.background.mediaAssetId).toBe(bg.body.assetId);
    expect(r.body.layerAssets.product.mediaAssetId).toBe(prod.body.assetId);
    // No "missing background" warning — the explicit layer was resolved.
    expect(r.body.warnings.some((w: { code: string; layerId?: string }) => w.code === 'missing-layer-image' && w.layerId === 'background')).toBe(false);
  });

  it('a foreign-org asset id as a layer degrades to a warning, never a cross-tenant read', async () => {
    const { c, orgId } = await ownerWithOrg();
    const { c: other, orgId: otherOrg } = await ownerWithOrg();
    const foreign = await other.post(M(otherOrg, '/assets'), { contentBase64: PNG, contentType: 'image/png', name: 'theirs.png' });
    const brief = await c.post(CB(orgId, '/briefs'), { title: 'IDOR layer', assetType: 'image', sceneDescription: 'S.' });
    const r = await c.post(CB(orgId, `/briefs/${brief.body.briefId}/renders`), {
      templateId: 'meta.feed.1x1', layers: { background: foreign.body.assetId },
    });
    expect(r.status).toBe(201); // renders on paper
    expect(r.body.layerAssets.background).toBeUndefined();
    expect(r.body.warnings.some((w: { code: string }) => w.code === 'layer-asset-missing')).toBe(true);
  });
});

describe('template catalog coverage (ADR 0399 OQ-3)', () => {
  it('ships the four IAB core + six long-tail Google Display sizes', () => {
    const gd = AD_LAYOUT_TEMPLATES.filter((t) => t.platform === 'google-display').map((t) => `${t.width}x${t.height}`).sort();
    expect(gd).toEqual([
      '160x600', '250x250', '300x250', '300x600', '320x100', '320x50', '336x280', '468x60', '728x90', '970x250',
    ].sort());
  });
});

describe('brand custom fonts in the render (ADR 0399 OQ-1)', () => {
  it('an attested brand font sets the render family + changes the composite hash', async () => {
    const { bundledFontBuffers } = await import('../src/features/creative-briefs/render/fonts.js');
    const INTER_B64 = bundledFontBuffers()[0]!.toString('base64');
    const { c, orgId } = await ownerWithOrg();
    const brand = await c.post('/v1/host/openwop-app/brand/brands', { orgId, name: 'Acme' });
    expect(brand.status, JSON.stringify(brand.body)).toBe(201);
    const brandId = brand.body.brand.id;
    const brief = await c.post(CB(orgId, '/briefs'), { title: 'Font brief', assetType: 'image', sceneDescription: 'S.' });
    const briefId = brief.body.briefId;

    // Baseline render (bundled fonts) with the brand.
    const before = await c.post(CB(orgId, `/briefs/${briefId}/renders`), { templateId: 'meta.feed.1x1', brandId });
    expect(before.status, JSON.stringify(before.body)).toBe(201);
    expect(before.body.brand.fontFamilies.serif).toBe('PT Serif'); // bundled default

    // Upload Inter as the custom SERIF font (differs from bundled PT Serif).
    const put = await c.put(`/v1/host/openwop-app/brand/brands/${brandId}/fonts/serif`, { contentBase64: INTER_B64, licenseAttested: true });
    expect(put.status, JSON.stringify(put.body)).toBe(201);

    const after = await c.post(CB(orgId, `/briefs/${briefId}/renders`), { templateId: 'meta.feed.1x1', brandId });
    expect(after.status).toBe(201);
    expect(after.body.brand.fontFamilies.serif).toBe('Inter'); // the custom family (extracted)
    expect(after.body.compositeHash).not.toBe(before.body.compositeHash); // font sha re-pixels
    // The composed asset is still a real PNG.
    const asset = await c.get(M(orgId, `/assets/${after.body.mediaAssetId}`));
    expect(asset.body.contentType).toBe('image/png');
  });
});

describe('animated GIF render (ADR 0399 OQ-2)', () => {
  // `frames` is 3, not 6: this renders every frame TWICE to byte-compare for
  // determinism, and 3 still exercises the multi-frame path (the bound floor is
  // 2, and the frame-COUNT bounds are covered arithmetically by the clamp test
  // below). Halving the work is worth keeping on top of the file-level budget —
  // a cheap test does not drift back to the cliff.
  it('renderAnimatedGif produces a deterministic GIF89a from N reveal frames', async () => {
    const { renderAnimatedGif } = await import('../src/features/creative-briefs/render/renderCreative.js');
    const a = renderAnimatedGif(baseInput(), { preset: 'reveal', frames: 3, fps: 8 });
    const b = renderAnimatedGif(baseInput(), { preset: 'reveal', frames: 3, fps: 8 });
    expect(a.gif.subarray(0, 6).toString('latin1')).toBe('GIF89a');
    expect(a.gif.length).toBeGreaterThan(100);
    expect(Buffer.compare(a.gif, b.gif)).toBe(0);
  });

  // The bounds are arithmetic, so they are asserted as arithmetic. Asserting the
  // MAX clamp end-to-end would render the worst case (30 rasterized frames) —
  // ~14s of the 15s budget, which went red as soon as the suite ran under load.
  it('clamps frames/fps to the safe bounds', async () => {
    const { clampAnimateOptions, ANIMATE_BOUNDS } = await import('../src/features/creative-briefs/render/renderCreative.js');
    // Above the ceiling.
    expect(clampAnimateOptions({ preset: 'reveal', frames: 999, fps: 999 })).toEqual({ frames: 30, fps: 24 });
    // Below the floor (incl. zero/negative — a frame count < 2 would divide by 0
    // in the progress ramp).
    expect(clampAnimateOptions({ preset: 'reveal', frames: 1, fps: 1 })).toEqual({ frames: 2, fps: 2 });
    expect(clampAnimateOptions({ preset: 'reveal', frames: 0, fps: -5 })).toEqual({ frames: 2, fps: 2 });
    // Inside the range passes through, floored to whole frames.
    expect(clampAnimateOptions({ preset: 'reveal', frames: 6.9, fps: 8.9 })).toEqual({ frames: 6, fps: 8 });
    // The bounds themselves are the ones the clamp reports.
    expect(clampAnimateOptions({ preset: 'reveal', frames: 1e9, fps: 1e9 }))
      .toEqual({ frames: ANIMATE_BOUNDS.maxFrames, fps: ANIMATE_BOUNDS.maxFps });
  });

  it('renderAnimatedGif applies the clamp (wiring, at the CHEAP floor end)', async () => {
    const { renderAnimatedGif } = await import('../src/features/creative-briefs/render/renderCreative.js');
    // frames:1 clamps UP to 2 — proves the clamp feeds the encode loop while
    // rasterizing only 2 frames instead of 30.
    const out = renderAnimatedGif(baseInput(), { preset: 'reveal', frames: 1, fps: 1 });
    expect(out.frames).toBe(2);
    expect(out.fps).toBe(2);
    expect(out.gif.subarray(0, 6).toString('latin1')).toBe('GIF89a');
  });

  it('the last reveal frame equals the static SVG (foreground fully shown)', async () => {
    const { composeAdSvg } = await import('../src/features/creative-briefs/render/renderCreative.js');
    const staticSvg = composeAdSvg(baseInput()).svg;
    const lastFrame = composeAdSvg(baseInput(), { revealProgress: 1 }).svg;
    expect(lastFrame).toBe(staticSvg); // progress 1 ⇒ no opacity wrapper
    // A mid frame differs (foreground wrapped in an opacity group).
    expect(composeAdSvg(baseInput(), { revealProgress: 0.5 }).svg).toContain('<g opacity="0.500">');
  });

  it('route: animate:true stores a GIF asset with an animation record + differing hash', async () => {
    const { c, orgId } = await ownerWithOrg();
    const brief = await c.post(CB(orgId, '/briefs'), { title: 'Motion', assetType: 'image', sceneDescription: 'S.', directions: [{ label: 'Reveal it' }] });
    const briefId = brief.body.briefId;
    const stat = await c.post(CB(orgId, `/briefs/${briefId}/renders`), { templateId: 'meta.feed.1x1', copy: { cta: 'Go' } });
    expect(stat.status).toBe(201);
    const anim = await c.post(CB(orgId, `/briefs/${briefId}/renders`), { templateId: 'meta.feed.1x1', copy: { cta: 'Go' }, animate: true });
    expect(anim.status, JSON.stringify(anim.body)).toBe(201);
    expect(anim.body.animation).toMatchObject({ preset: 'reveal', frames: 12, fps: 8 });
    expect(anim.body.compositeHash).not.toBe(stat.body.compositeHash);
    const asset = await c.get(M(orgId, `/assets/${anim.body.mediaAssetId}`));
    expect(asset.body.contentType).toBe('image/gif');
    const served = await fetch(`${BASE}${asset.body.serveUrl}`);
    expect(Buffer.from(await served.arrayBuffer()).subarray(0, 6).toString('latin1')).toBe('GIF89a');
  });
});
