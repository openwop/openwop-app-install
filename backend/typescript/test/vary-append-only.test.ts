/**
 * `Vary` is APPEND-ONLY in this host.
 *
 * The protocol-version middleware declares `Vary: OpenWOP-Version` (and
 * `Accept`) on every unversioned path, because the same URL answers different
 * bodies by request header (ADR 0631). Sixteen later call sites used
 * `res.setHeader('Vary', …)` / `res.set('Vary', …)`, which REPLACES the header,
 * so the run snapshot went out as `Vary: Accept-Encoding` alone: it varied by
 * version and did not say so (found 2026-10-04 while isolating the public
 * origin's lost conditionals). Express's `res.vary()` appends, de-duplicated.
 *
 * Two witnesses, because a ratchet polices a spelling, not the invariant:
 * the source scan stops the overwrite spelling coming back, and the HTTP check
 * pins the symptom on the real route.
 *
 * The scan covers every replacing spelling Express offers: `setHeader`, `set`
 * and its alias `header` with a 'Vary' name (any case), and the object form
 * `res.set({ Vary: … })` / `writeHead(…, { Vary: … })`. MEASURED 2026-10-24 at
 * 6a852d799: 0 offenders over 1,995 `src/**` files (~0.2 s). The baseline is
 * zero; a hit is fixed with `res.vary()`, never allowlisted.
 * Witnessed (grade-tests w63): one `setHeader('Vary', …)` on the snapshot route
 * → both cases red; the middleware's `vary('OpenWOP-Version')` renamed → the
 * HTTP case red.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/index.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
function* tsFiles(dir: string): Generator<string> {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) yield* tsFiles(p);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) yield p;
  }
}

const REPLACES_VARY: readonly RegExp[] = [
  /\.(setHeader|set|header)\(\s*['"]vary['"]/i,
  /\.(set|writeHead)\([^)]*\{[^}]*['"]?\bvary['"]?\s*:/i,
];

describe('Vary is append-only', () => {
  it('no source file REPLACES Vary (setHeader/set/header, or an object form) — use res.vary(), which appends', () => {
    // Non-vacuity: the patterns catch every spelling they name.
    for (const sample of [`res.setHeader('Vary', 'X')`, `res.set("vary", 'X')`, `res.header('Vary', 'X')`, `res.set({ Vary: 'X' })`, `res.writeHead(200, { 'Vary': 'X' })`]) {
      expect(REPLACES_VARY.some((re) => re.test(sample)), sample).toBe(true);
    }
    expect(REPLACES_VARY.some((re) => re.test(`res.vary('Accept-Encoding')`))).toBe(false);
    const offenders: string[] = [];
    for (const f of tsFiles(SRC)) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (REPLACES_VARY.some((re) => re.test(line))) offenders.push(`${f.slice(SRC.length + 1)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  describe('the v2 run snapshot keeps the version middleware\'s Vary', () => {
    let server: http.Server; let base = '';
    const saved: Record<string, string | undefined> = {};
    beforeAll(async () => {
      for (const k of ['OPENWOP_STORAGE_DSN', 'OPENWOP_SESSION_SECRET', 'OPENWOP_API_KEYS', 'OPENWOP_AUTH_ENFORCE_BEARER', 'OPENWOP_DEPLOY_POSTURE']) saved[k] = process.env[k];
      process.env.OPENWOP_STORAGE_DSN = 'memory://';
      process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
      process.env.OPENWOP_API_KEYS = 'k-vary-0001:*';
      process.env.OPENWOP_AUTH_ENFORCE_BEARER = 'true';
      process.env.OPENWOP_DEPLOY_POSTURE = 'bearer-shared';
      const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
      await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', r); });
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      await new Promise<void>((r) => server.close(() => r()));
    });

    it('Vary on GET /runs/{id} names OpenWOP-Version AND Accept-Encoding', async () => {
      const h = { authorization: 'Bearer k-vary-0001', 'content-type': 'application/json', 'OpenWOP-Version': '2' };
      const created = await fetch(`${base}/runs`, { method: 'POST', headers: h, body: JSON.stringify({ workflowId: 'openwop-app.uppercase', inputs: { text: 'x' } }) });
      const body = await created.json() as { runId?: string };
      expect(created.status, JSON.stringify(body)).toBeLessThan(300);
      const runId = String(body.runId);
      const seg = runId.replace(/~/g, '~7E').replace(/\//g, '~2F').replace(/:/g, '~3A');
      const r = await fetch(`${base}/runs/${seg}`, { headers: h });
      await r.text();
      expect(r.status).toBe(200);
      const vary = (r.headers.get('vary') ?? '').split(',').map((s) => s.trim().toLowerCase());
      expect(vary, `Vary was "${r.headers.get('vary')}"`).toContain('openwop-version');
      expect(vary).toContain('accept-encoding');
    });
  });
});
