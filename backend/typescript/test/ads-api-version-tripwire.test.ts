/**
 * ADR 0907 D0 — the ad-platform API version tripwire.
 *
 * Google Ads sat on `v18` for about a year after its sunset and Meta on a
 * Marketing API version past its expiry; every Google read and write was
 * failing and no test said so. This file is DELIBERATELY clock-dependent: it
 * goes red 60 days before any pinned version's sunset (or, for a row whose
 * sunset is estimated or unannounced, its `reviewBy` date), so the bump
 * happens on a schedule instead of after an outage.
 *
 * When it reds: open the row's `source`, pick the newest supported version,
 * update `ADS_API_VERSIONS` (version, sunset, basis, reviewBy, checkedAt) and
 * run the ads adapter suites. Do NOT push a date out without reading the source.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ADS_API_VERSIONS, LINKEDIN_VERSION, googleApiBase, metaApiBase, tiktokApiBase, type AdsApiVersionPin,
} from '../src/host/adsAdapter.js';

const WARN_DAYS = 60;
const DAY_MS = 86_400_000;

/** Rows whose sunset or reviewBy falls inside the warning window (or is unparseable). */
function dueRows(pins: readonly AdsApiVersionPin[], now: number): string[] {
  const due: string[] = [];
  for (const pin of pins) {
    for (const [label, iso] of [['sunset', pin.sunset], ['reviewBy', pin.reviewBy]] as const) {
      if (!iso) continue;
      const at = Date.parse(`${iso}T00:00:00Z`);
      if (!Number.isFinite(at) || at - now < WARN_DAYS * DAY_MS) {
        due.push(`${pin.platform} ${pin.version}: ${label} ${iso} (re-read ${pin.source})`);
      }
    }
  }
  return due;
}

describe('ADR 0907 D0 — ad-platform API version tripwire', () => {
  afterEach(() => {
    // The base helpers honour a test override; make sure none leaks in here.
    delete process.env.OPENWOP_META_API_BASE;
    delete process.env.OPENWOP_GOOGLE_ADS_API_BASE;
    delete process.env.OPENWOP_TIKTOK_ADS_API_BASE;
  });

  it('no pinned version is within 60 days of its sunset or review date', () => {
    expect(dueRows(Object.values(ADS_API_VERSIONS), Date.now()), 'ad-platform API versions due for a bump').toEqual([]);
  });

  it('every row that is not `published` carries a reviewBy date (no silent green on an unknown sunset)', () => {
    for (const pin of Object.values(ADS_API_VERSIONS)) {
      if (pin.basis === 'published') expect(pin.sunset, `${pin.platform}: a published row names its sunset`).toBeTruthy();
      else expect(pin.reviewBy, `${pin.platform}: ${pin.basis} rows need reviewBy`).toBeTruthy();
      expect(pin.source).toMatch(/^https:\/\//);
    }
  });

  it('the base URLs and the LinkedIn header DERIVE from the table (no second pin)', () => {
    expect(googleApiBase()).toBe(`https://googleads.googleapis.com/${ADS_API_VERSIONS.google.version}`);
    expect(metaApiBase()).toBe(`https://graph.facebook.com/${ADS_API_VERSIONS.meta.version}`);
    expect(tiktokApiBase()).toBe(`https://business-api.tiktok.com/open_api/${ADS_API_VERSIONS.tiktok.version}`);
    expect(LINKEDIN_VERSION).toBe(ADS_API_VERSIONS.linkedin.version);
  });

  it('the tripwire is not vacuous: a date inside the window, or a garbage date, IS reported', () => {
    const now = Date.parse('2026-10-17T00:00:00Z');
    const base: AdsApiVersionPin = { platform: 'google', version: 'v18', basis: 'published', source: 'https://x.test', checkedAt: '2026-10-17' };
    expect(dueRows([{ ...base, sunset: '2026-11-30' }], now)).toHaveLength(1);       // 44 days out
    expect(dueRows([{ ...base, sunset: '2027-06-01' }], now)).toEqual([]);           // well clear
    expect(dueRows([{ ...base, basis: 'estimated', sunset: '2027-06-01', reviewBy: '2026-12-01' }], now)).toHaveLength(1);
    expect(dueRows([{ ...base, sunset: 'soon' }], now)).toHaveLength(1);
  });

  // ADR 0952 defect P7 — the meta-ads connection pack authorized against Graph
  // v19.0 (expired 2026-05-21) while the adapter called v25.0. The OAuth
  // endpoints a SERVED ads pack declares must carry the version the adapter pins.
  // Only `examples/connection-packs/*-ads` are served; the conformance fixture
  // and inline test samples are not, and are deliberately not checked here.
  it('every served ads connection pack OAuth endpoint carries the pinned API version', () => {
    const root = join(__dirname, '..', '..', '..', 'examples', 'connection-packs');
    const read = (slug: string): { authorize: string; token: string } =>
      (JSON.parse(readFileSync(join(root, slug, 'pack.json'), 'utf8')) as { provider: { auth: { endpoints: { authorize: string; token: string } } } }).provider.auth.endpoints;
    const meta = read('meta-ads');
    expect(meta.authorize).toContain(`/${ADS_API_VERSIONS.meta.version}/`);
    expect(meta.token).toContain(`/${ADS_API_VERSIONS.meta.version}/`);
    expect(read('tiktok-ads').token).toContain(`/${ADS_API_VERSIONS.tiktok.version}/`);
    // Google and LinkedIn OAuth endpoints are unversioned; nothing to pin.
    for (const slug of ['google-ads', 'linkedin-ads']) {
      const e = read(slug);
      expect(`${e.authorize} ${e.token}`).not.toMatch(/\/v\d+\.\d+\//);
    }
  });
});
