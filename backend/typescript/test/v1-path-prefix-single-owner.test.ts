import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { protocolVersionMiddleware } from '../src/middleware/protocolVersion.js';

/**
 * ADR 0649 — the major-1 path prefix has ONE owner.
 *
 * Before ADR 0649, 346 of 347 route registrations spelled `/v1` themselves, so
 * retiring major 1 (ADR 0642) meant 46 protocol edits across 14 files. ADR 0649
 * routed every protocol route through one helper; ADR 0812 then WITHDREW the
 * `/v1` path space: nothing registers under it, and the negotiator's front
 * (`protocolVersionMiddleware`, the one reader of `V1_PATH_PREFIX`) answers
 * every `/v1` request `410` (or `308` for a held third-party read address).
 *
 * So a `/v1/…` route literal today is an UNREACHABLE registration behind that
 * front — dead code that reads as live. Case 2 is the ratchet that keeps it
 * out (file + line on red). Case 1 pins the front itself: the prefix match is
 * `/v1` exactly or `/v1/…`, never a mere string prefix.
 *
 * Host-extension routes (`/v1/host/…`) and the conformance seams
 * (`/v1/packs-test/…`) are EXCLUDED from the scan on purpose (historical twins).
 *
 * Sabotage: 8fw4g1-v1p-route-r2 (a `/v1/` literal in routes/runs.ts) reds case 2;
 * 8fw4g1-v1p-const-r2 (the prefix constant) reds case 1.
 */
const ROUTE_LITERAL = /app\.(?:get|post|put|patch|delete|all)\(\s*['`](\/v1\/[^'`]*)['`]/g;
const EXEMPT = (p: string) => p.startsWith('/v1/host/') || p.startsWith('/v1/packs-test');

function* tsFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* tsFiles(p);
    else if (e.isFile() && p.endsWith('.ts')) yield p;
  }
}

describe('ADR 0649 — one owner for the v1 path prefix', () => {
  it('the front reads the ONE prefix: /v1 and /v1/… answer 410, /v1x/… is not the retired space', async () => {
    const app = express();
    app.use(protocolVersionMiddleware());
    app.use((_req, res) => { res.status(200).json({ reached: 'downstream' }); });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      for (const path of ['/v1', '/v1/runs']) {
        const res = await fetch(`${base}${path}`, { method: 'POST' });
        expect(res.status, path).toBe(410);
        expect(((await res.json()) as { error?: string }).error, path).toBe('protocol_version_unsupported');
      }
      const other = await fetch(`${base}/v1x/runs`, { method: 'POST', headers: { 'OpenWOP-Version': '2' } });
      expect(other.status, 'a path that merely starts with the letters is not the retired space').not.toBe(410);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('no protocol route registration hard-codes /v1/ (host-extension and seam routes exempt)', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const dir of ['src/routes', 'src/middleware', 'src/features']) {
      for (const f of tsFiles(dir)) {
        scanned += 1;
        const text = readFileSync(f, 'utf8');
        for (const m of text.matchAll(ROUTE_LITERAL)) {
          if (EXEMPT(m[1]!)) continue;
          const line = text.slice(0, m.index).split('\n').length;
          offenders.push(`${f}:${line} ${m[1]}`);
        }
      }
    }
    // MEASURED 1304 .ts files under the three roots on 6a852d799 (non-vacuous: the walk found the sources).
    expect(scanned).toBeGreaterThanOrEqual(1304);
    expect(offenders, `protocol routes still spelling /v1 themselves:\n${offenders.join('\n')}`).toEqual([]);
  });
});
