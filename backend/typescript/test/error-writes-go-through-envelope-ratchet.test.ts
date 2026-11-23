/**
 * Every error the middleware writes goes through the error envelope, so ONE place
 * decides an error's caching (`no-store`), scrub and locale.
 *
 * MEASURED live on openwop-dev 2026-11-17 (2c83c256e): an unauthenticated v2
 * request's 401 carried NO Cache-Control. The auth middleware wrote its refusals with
 * `res.status(n).json(...)` directly, so #6019's envelope fix (#5841) never reached
 * them, and a header-less error behind Firebase was measured cached for 10 minutes
 * on the URL alone. A cached 401 could be served to the next caller who does
 * present a credential.
 *
 * The ratchet: `src/middleware` writes no error directly; `src/routes` and
 * `src/features` may not GROW past their measured counts per file (move a route onto `sendError` and lower its
 * number here). Red when: a new direct `res.status(4xx|5xx).json(` appears.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '../src');
const DIRECT = /\.status\(\s*[45]\d\d\s*\)\s*\.json\(/g;

function directCounts(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) { if (name !== '__tests__') walk(p); continue; }
      if (!p.endsWith('.ts') || p.endsWith('.test.ts')) continue;
      const n = (readFileSync(p, 'utf8').match(DIRECT) ?? []).length;
      if (n) out[relative(SRC, p).split('\\').join('/')] = n;
    }
  };
  walk(dir);
  return out;
}

/** Measured 2026-11-17. Shrink-only: a route moved onto `sendError` lowers its entry. */
const ROUTES_BASELINE: Record<string, number> = {
  'routes/accessControl.ts': 1,
  'routes/appBrand.ts': 1,
  'routes/artifactTypeSeam.ts': 1,
  'routes/authBreakGlass.ts': 1,
  // The SAML assertion-consume result ({ authenticated: false, reason }), read by the sign-in flow, not error envelopes; the exit guard still makes them no-store.
  'routes/authSaml.ts': 4,
  'routes/compensationSeam.ts': 4,
  'routes/discovery.ts': 2,
  'routes/health.ts': 1,
  // JSON-RPC error responses (rpcError), the MCP wire contract, not error envelopes; the exit guard still makes them no-store.
  'routes/mcp.ts': 2,
  'routes/mcpInvokeSeam.ts': 1,
  'routes/purposePropagationSeam.ts': 2,
  'routes/runs.ts': 1,
  'routes/scheduler.ts': 2,
  'routes/testSeam.ts': 26,
};

/**
 * Measured 2026-11-17 on main ba48f05c9, after #6079. The first cut walked only
 * `src/middleware` and `src/routes`; these 26 writes in 7 feature files were outside it,
 * so a new one in a feature would have passed. Shrink-only, like the routes baseline.
 */
const FEATURES_BASELINE: Record<string, number> = {
  // A webhook sender's contract body ({ outcome: 'unknown_webhook' }), not an error envelope; the exit guard still makes it no-store.
  'features/app-builder/routes.ts': 1,
  // The declined-checkout 402 ({ declined, reason }) the checkout client reads, not an error envelope; the exit guard still makes it no-store.
  'features/commerce/routes.ts': 1,
};

function noGrowth(dir: string, baseline: Record<string, number>): { grew: string[]; shrank: string[] } {
  const now = directCounts(join(SRC, dir));
  return {
    grew: Object.entries(now).filter(([f, n]) => n > (baseline[f] ?? 0)).map(([f, n]) => `${f}: ${n} > ${baseline[f] ?? 0}`),
    shrank: Object.entries(baseline).filter(([f, n]) => (now[f] ?? 0) < n).map(([f, n]) => `${f}: ${now[f] ?? 0} < ${n}`),
  };
}

describe('errors go through the envelope (no direct res.status(4xx|5xx).json)', () => {
  it('src/middleware writes no error directly', () => {
    expect(directCounts(join(SRC, 'middleware'))).toEqual({});
  });

  for (const [dir, baseline] of [['routes', ROUTES_BASELINE], ['features', FEATURES_BASELINE]] as const) {
    it(`src/${dir} never grows past its measured direct writes, and a fixed file lowers its entry`, () => {
      const { grew, shrank } = noGrowth(dir, baseline);
      expect(grew, 'a new direct error write: use sendError / sendErrorBody').toEqual([]);
      expect(shrank, 'lower the baseline to match, so a moved write cannot come back').toEqual([]);
    });
  }
});
