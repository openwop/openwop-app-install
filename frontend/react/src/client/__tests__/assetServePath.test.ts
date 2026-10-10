import { describe, expect, it } from 'vitest';
import { ASSET_SERVE_PATH_RE, canonicalAssetPath } from '../assetServePath.js';
import { mediaSrc } from '../../chat/mediaSrc.js';
import { config } from '../config.js';

/**
 * ADR 0669 — the SPA renders stored asset URLs through one canonicaliser, so an
 * append-only event log carrying `/v1/host/…/assets/…` keeps rendering after v1
 * retires. Version-neutral: any `/v<N>`.
 */
describe('asset serve path (SPA)', () => {
  it('canonicalises any versioned serve path, relative or absolute, and nothing else', () => {
    expect(canonicalAssetPath('/v1/host/openwop-app/assets/tok_A-1')).toBe('/host/openwop-app/assets/tok_A-1');
    expect(canonicalAssetPath('/v9/host/openwop-app/assets/tok')).toBe('/host/openwop-app/assets/tok');
    expect(canonicalAssetPath('https://app.openwop.dev/v1/host/openwop-app/assets/tok')).toBe('https://app.openwop.dev/host/openwop-app/assets/tok');
    expect(canonicalAssetPath('/v1/runs/r1')).toBe('/v1/runs/r1');
    expect(canonicalAssetPath('/host/openwop-app/assets/tok')).toBe('/host/openwop-app/assets/tok');
  });

  it('mediaSrc renders a stored /v1 asset URL at its canonical address', () => {
    expect(mediaSrc('image/png', '/v1/host/openwop-app/assets/tok_1')).toBe(`${config.baseUrl}/host/openwop-app/assets/tok_1`);
    expect(mediaSrc('image/png', 'https://h.example/v1/host/openwop-app/assets/tok_1')).toBe('https://h.example/host/openwop-app/assets/tok_1');
  });

  it('still refuses traversal and foreign relative paths (the token shape is the guard)', () => {
    expect(ASSET_SERVE_PATH_RE.test('/v1/host/openwop-app/assets/../x')).toBe(false);
    expect(mediaSrc('image/png', '/v1/host/openwop-app/assets/a/b')).toBeNull();
    expect(mediaSrc('image/png', '/etc/passwd')).toBeNull();
  });
});
