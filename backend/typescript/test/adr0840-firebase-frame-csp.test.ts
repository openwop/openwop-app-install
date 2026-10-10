/**
 * ADR 0840 D3 — Firebase Hosting must not leave a plugin frame with the APP's CSP.
 *
 * Hosting applies the app's own Content-Security-Policy to every non-static path,
 * API rewrites included. Before this ADR the one plugin override named
 * `/api/v1/host/openwop-app/ui-plugin/packs/**​/entry`, a path the SPA had stopped
 * calling, so plugin bytes on app.openwop.dev went out under the app's policy.
 * Nothing broke only because the `srcdoc` meta policy was what held. Under RFC 0238
 * the header IS the boundary.
 *
 * Pinned here, against the backend's own builders (one source):
 *  - every path the SPA loads a frame from carries `pluginFrameCsp()` verbatim;
 *  - the entry path the SPA actually uses carries the deny-egress policy;
 *  - no rule names a `/api/v1/…` plugin path (the stale shape);
 *  - no installed plugin declares `connectSrc`: a Firebase rule cannot vary per
 *    plugin, so one that did would be served a policy that is wrong for it. Allowing
 *    it needs a design and a correction to ADR 0840, never a silent header.
 *
 * What this cannot show is what the CDN actually SENDS (which rule wins, replace
 * versus append). That is measured live (ADR 0840 P3, `verify-deploy.sh`).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginFrameCsp, pluginIframeCsp } from '../src/host/uiPluginRpc.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
type HeaderRule = { source?: string; headers: { key: string; value: string }[] };
const hosting = JSON.parse(readFileSync(join(ROOT, 'firebase.json'), 'utf8')).hosting;
const rules: HeaderRule[] = (Array.isArray(hosting) ? hosting : [hosting]).flatMap((h: { headers?: HeaderRule[] }) => h.headers ?? []);
const csp = (source: string): string | undefined =>
  rules.find((r) => r.source === source)?.headers.find((h) => h.key.toLowerCase() === 'content-security-policy')?.value;

describe('ADR 0840 D3 — Firebase plugin header rules', () => {
  it.each([
    '/api/host/ui-plugins/**/frame',
    '/host/ui-plugins/**/frame',
    '/api/host/openwop-app/ui-plugin/isolation-probe',
  ])('%s carries the frame policy verbatim', (source) => {
    expect(csp(source)).toBe(pluginFrameCsp());
  });

  it('the entry path the SPA calls carries the deny-egress policy', () => {
    expect(csp('/api/host/openwop-app/ui-plugin/packs/**/entry')).toBe(pluginIframeCsp());
  });

  it('no rule names a stale /api/v1 plugin path', () => {
    expect(rules.map((r) => r.source ?? '').filter((s) => s.startsWith('/api/v1/') && s.includes('ui-plugin'))).toEqual([]);
  });

  it('no installed plugin declares connectSrc (a Firebase rule cannot vary per plugin)', () => {
    const packsDir = join(ROOT, 'packs');
    const declaring: string[] = [];
    for (const d of existsSync(packsDir) ? readdirSync(packsDir) : []) {
      const manifest = join(packsDir, d, 'pack.json');
      if (!existsSync(manifest)) continue;
      const m = JSON.parse(readFileSync(manifest, 'utf8')) as { kind?: string; uiPlugins?: { pluginId: string; connectSrc?: unknown[] }[] };
      if (m.kind !== 'frontend-plugin') continue;
      for (const p of m.uiPlugins ?? []) if (Array.isArray(p.connectSrc) && p.connectSrc.length) declaring.push(`${d}/${p.pluginId}`);
    }
    expect(declaring).toEqual([]);
  });
});
