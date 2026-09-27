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
import { describe, it, expect } from 'vitest';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('v2 path space is served, not merely advertised', () => {
  it('every parameterless GET the manifest declares is reachable under major 2 wherever /v1 serves it', async () => {
    const { createApp, loadConfigFromEnv } = await import('../src/index.js');
    process.env.OPENWOP_API_KEYS = 'pathspace-key';
    const app = await createApp({ ...loadConfigFromEnv(), storageDsn: 'memory://' } as never);
    // H41: bind loopback v4 explicitly — a `[::]` wildcard can be answered by a
    // resident 127.0.0.1 listener on the same port (scripts/check-test-ports.mjs).
    const srv = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => srv.once('listening', () => r()));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const H = { authorization: 'Bearer pathspace-key' };

    const manifest = JSON.parse(readFileSync(join(
      dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'schemas', 'v2', 'path-manifest.json',
    ), 'utf8')) as unknown;
    const ops: unknown = Array.isArray(manifest) ? manifest
      : ((manifest as Record<string, unknown>)['operations'] ?? (manifest as Record<string, unknown>)['paths']);
    const paths: string[] = Array.isArray(ops)
      ? ops.map((o) => (typeof o === 'string' ? o : String((o as Record<string, unknown>)['path'] ?? '')))
      : Object.keys((ops ?? {}) as Record<string, unknown>);

    // Parameterless, non-discovery GETs only — a templated path needs a real id,
    // and `/.well-known` is a representation rather than a rewritten twin.
    const probes = [...new Set(paths.filter(
      (p) => p.startsWith('/') && !p.includes('{') && !p.includes(':') && !p.startsWith('/.well-known'),
    ))].sort();
    expect(probes.length, 'the manifest must yield probes, or this test is vacuous').toBeGreaterThan(3);

    const gaps: string[] = [];
    for (const p of probes) {
      const v1 = await fetch(`${base}/v1${p}`, { headers: H });
      const v2 = await fetch(`${base}${p}`, { headers: { ...H, 'OpenWOP-Version': '2' } });
      // Only a surface /v1 actually serves can be a mount gap.
      if (v1.status !== 404 && v2.status === 404) gaps.push(`${p} (/v1=${v1.status}, major2=${v2.status})`);
    }
    srv.close();
    expect(gaps, `served under /v1 but unreachable under major 2:\n  ${gaps.join('\n  ')}`).toEqual([]);
  }, 120_000); // boots a host and probes every manifest pair sequentially
});
