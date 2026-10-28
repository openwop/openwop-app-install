/**
 * RFC 0172 / `spec/v2/core/versioning.md` — advertising a major is a claim about
 * its PATH SPACE, not only about `/.well-known`.
 *
 * The pair is the point. A lone 404 under major 2 cannot distinguish "this host
 * does not implement the surface" from "it implements it and did not mount it
 * under major 2". Probing `/v1<path>` alongside `<path>` separates them: a
 * surface that answers under `/v1` and 404s under major 2 is a mount gap, and
 * that is exactly what this host shipped — five of five pairable surfaces, live.
 */
import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, loadConfigFromEnv } from '../src/index.js';

// The host boots ONCE, in the hook (the case used to boot it inline, and it
// measured 6.6 s of which the probes were a fraction).
let srv: Server; let base = '';
// Set before the app module graph loads (the case used to import it after setting this).
const savedKeys = vi.hoisted(() => { const k = process.env.OPENWOP_API_KEYS; process.env.OPENWOP_API_KEYS = 'pathspace-key'; return k; });
// ADR 0972 P2 — booted as production runs (`OPENWOP_PROPOSALS_ENABLED=true`), so the
// manifest's `/proposals` is probed as served, not exempted as an unadvertised facet.
const savedProposals = vi.hoisted(() => { const v = process.env.OPENWOP_PROPOSALS_ENABLED; process.env.OPENWOP_PROPOSALS_ENABLED = 'true'; return v; });
const H = { authorization: 'Bearer pathspace-key' };
beforeAll(async () => {
  const app = await createApp({ ...loadConfigFromEnv(), storageDsn: 'memory://' });
  // H41: bind loopback v4 explicitly — a `[::]` wildcard can be answered by a
  // resident 127.0.0.1 listener on the same port (scripts/check-test-ports.mjs).
  srv = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => srv.once('listening', () => r()));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => {
  await new Promise<void>((r) => srv.close(() => r()));
  if (savedKeys === undefined) delete process.env.OPENWOP_API_KEYS; else process.env.OPENWOP_API_KEYS = savedKeys;
  if (savedProposals === undefined) delete process.env.OPENWOP_PROPOSALS_ENABLED; else process.env.OPENWOP_PROPOSALS_ENABLED = savedProposals;
});

describe('v2 path space is served, not merely advertised', () => {
  it('every parameterless GET the manifest declares is reachable under major 2 (bar a pinned not-mounted ledger)', async () => {
    const manifest = JSON.parse(readFileSync(join(
      dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'schemas', 'v2', 'path-manifest.json',
    ), 'utf8')) as unknown;
    const ops: unknown = Array.isArray(manifest) ? manifest
      : ((manifest as Record<string, unknown>)['operations'] ?? (manifest as Record<string, unknown>)['paths']);
    // Only paths the manifest declares a GET for. Probing a POST-only path with GET
    // measures nothing the manifest claims: RFC 0241's `/host/events/test` is POST-only
    // and correctly 404s a GET (the probe set was unfiltered by method until 2.45.28).
    const paths: string[] = Array.isArray(ops)
      ? ops
          .filter((o) => typeof o === 'string' || (o as Record<string, unknown>)['method'] === undefined || (o as Record<string, unknown>)['method'] === 'GET')
          .map((o) => (typeof o === 'string' ? o : String((o as Record<string, unknown>)['path'] ?? '')))
      : Object.keys((ops ?? {}) as Record<string, unknown>);

    // Parameterless, non-discovery GETs only — a templated path needs a real id,
    // and `/.well-known` is a representation rather than a rewritten twin.
    const probes = [...new Set(paths.filter(
      (p) => p.startsWith('/') && !p.includes('{') && !p.includes(':') && !p.startsWith('/.well-known'),
    ))].sort();
    // MEASURED 2026-10-23 on the vendored manifest: 13 parameterless, non-discovery GETs.
    expect(probes.length, 'the manifest yielded fewer probes than measured — the filter or the manifest changed').toBeGreaterThanOrEqual(13);

    // ADR 0781 — a family v2 discovery does NOT advertise answers 404 not_found
    // under major 2 by rule (errors.md § "Unadvertised operations"). That 404 is
    // not a mount gap, but only when BOTH hold: the body names the family, and
    // v2 discovery really omits it. A plain route-miss 404 is still a gap.
    const v2Disco = (await (await fetch(`${base}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2' } })).json()) as Record<string, unknown>;
    // ADR 0812 P3c-0 — the `/v1<path>` twin was this test's oracle ("only a
    // surface /v1 serves can be a mount gap"). With /v1 withdrawn it answers 410
    // for everything, so the oracle is replaced by the ledger it used to imply:
    // the parameterless GETs whose /v1 twin ALSO answered 404 (measured
    // 2026-10-07 with 1.x served) — surfaces this host does not mount at all.
    // Any OTHER major-2 404 is a mount gap. Shrink-only: delete a row when the
    // surface ships.
    const NOT_MOUNTED_ON_EITHER_MAJOR = new Set(['/audit/verify', '/host/events', '/tools']);
    const gaps: string[] = [];
    const unadvertised: string[] = [];
    const stillUnmounted = new Set<string>();
    for (const p of probes) {
      const v2 = await fetch(`${base}${p}`, { headers: { ...H, 'OpenWOP-Version': '2' } });
      if (v2.status === 404) {
        const body = (await v2.json().catch(() => ({}))) as { error?: string; details?: { family?: string } };
        const family = body.details?.family;
        if (body.error === 'not_found' && typeof family === 'string' && v2Disco[family] === undefined) unadvertised.push(p);
        else if (NOT_MOUNTED_ON_EITHER_MAJOR.has(p)) stillUnmounted.add(p);
        else gaps.push(`${p} (major2=${v2.status})`);
      }
    }
    // The ledger cannot outlive its reasons: a row whose surface now answers must be deleted.
    expect([...stillUnmounted].sort(), 'a NOT_MOUNTED_ON_EITHER_MAJOR row now answers — delete it').toEqual([...NOT_MOUNTED_ON_EITHER_MAJOR].sort());
    // Keep the exemption honest: with host i18n off in this boot, `content` is
    // the family it must cover, so the list cannot silently absorb real gaps.
    expect(unadvertised.every((p) => p.startsWith('/content')), `unexpected unadvertised 404s: ${unadvertised.join(', ')}`).toBe(true);
    expect(gaps, `unreachable under major 2:\n  ${gaps.join('\n  ')}`).toEqual([]);
  });
});
