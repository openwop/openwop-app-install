import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ASSET_SERVE_PATH, ASSET_SERVE_PATH_PATTERN, assetServeUrl, assetTokenFromUrl, canonicalAssetUrls, isAssetServePath,
} from '../src/host/assetServePath.js';
import { retiredAssetServePath } from '../src/middleware/protocolVersion.js';

/**
 * `host/assetServePath.ts` is the ONE owner of the media-asset address (ADR
 * 0669). Minted URLs are unversioned, so they survive every major's cut; stored
 * `/v1` URLs are still recognised, and keep resolving after the cut by redirect.
 */
describe('asset serve path — one owner, version-neutral', () => {
  it('the retired-address exception (protocolVersion.ts) agrees with this module', () => {
    // It is spelled separately there (an import would cycle), so pin parity:
    // exactly the versioned serve paths map, each to what this module mints.
    for (const tok of ['abcDEF_12-x', 'a', 'x'.repeat(512)]) {
      expect(retiredAssetServePath(`/v1${assetServeUrl(tok)}`)).toBe(assetServeUrl(tok));
      expect(retiredAssetServePath(`/v9${assetServeUrl(tok)}`)).toBe(assetServeUrl(tok));
      expect(isAssetServePath(`/v1${assetServeUrl(tok)}`)).toBe(true);
    }
    for (const no of [assetServeUrl('abc'), '/v1/host/openwop-app/assets/', '/v1/host/openwop-app/assets/a/b', '/v1/host/openwop-app/assets/a.b', '/v1/host/openwop-app/media/upload', '/runs', `/v1${assetServeUrl('x'.repeat(513))}`]) {
      expect(retiredAssetServePath(no), no).toBeNull();
    }
  });

  it('mints unversioned', () => {
    expect(assetServeUrl('tok_12345678')).toBe('/host/openwop-app/assets/tok_12345678');
    expect(ASSET_SERVE_PATH.startsWith('/v')).toBe(false);
  });

  it('recognises any major or none, relative or absolute, and nothing else', () => {
    for (const u of ['/host/openwop-app/assets/abcDEF_12-x', '/v1/host/openwop-app/assets/abcDEF_12-x', '/v7/host/openwop-app/assets/abcDEF_12-x', 'https://app.example/v1/host/openwop-app/assets/abcDEF_12-x?w=2']) {
      expect(assetTokenFromUrl(u), u).toBe('abcDEF_12-x');
    }
    expect(assetTokenFromUrl('https://evil.example/assets/abc')).toBeNull();
    expect(assetTokenFromUrl(42)).toBeNull();
  });

  it('the stored-src validator and schema still refuse external URLs (ADR 0401)', () => {
    const re = new RegExp(ASSET_SERVE_PATH_PATTERN);
    for (const ok of ['/host/openwop-app/assets/abc', '/v1/host/openwop-app/assets/abc']) {
      expect(isAssetServePath(ok), ok).toBe(true);
      expect(re.test(ok), ok).toBe(true);
    }
    for (const bad of ['https://evil.example/host/openwop-app/assets/abc', '/host/openwop-app/assets/../x', '/host/openwop-app/assets/abc?beacon=1', '/vx/host/openwop-app/assets/abc']) {
      expect(isAssetServePath(bad), bad).toBe(false);
    }
  });

  it('canonicalAssetUrls rewrites every versioned serve path in free text, and is idempotent', () => {
    const before = '![a](/v1/host/openwop-app/assets/t1) <img src="https://h/v2/host/openwop-app/assets/t2"> {"src":"/host/openwop-app/assets/t3"} /v1/runs/r1';
    const once = canonicalAssetUrls(before);
    expect(once).toBe('![a](/host/openwop-app/assets/t1) <img src="https://h/host/openwop-app/assets/t2"> {"src":"/host/openwop-app/assets/t3"} /v1/runs/r1');
    expect(canonicalAssetUrls(once)).toBe(once);
  });

  it('RATCHET: nothing in backend src mints a versioned asset path; it goes through assetServeUrl', () => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { if (name !== '__tests__' && name !== 'node_modules') walk(p); continue; }
        if (!p.endsWith('.ts') || p.endsWith('.test.ts')) continue;
        readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
          const t = line.trimStart();
          if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
          // A route REGISTRATION is not a minted URL: the serve route's own path is
          // re-rooted by the Phase 2 family PR, and the v1-reliance ratchet counts it.
          if (/\bapp\.(get|post|put|patch|delete|use|all)\(/.test(line)) return;
          if (/\/v[0-9]+\/host\/openwop-app\/assets\//.test(line)) hits.push(`${p}:${i + 1}`);
        });
      }
    };
    walk(join(__dirname, '..', 'src'));
    expect(hits).toEqual([]);
  });
});
