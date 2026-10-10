/**
 * ADR 0786 — the v1-reliance ratchet's ONE third-party exemption, pinned.
 *
 * `scripts/check-v1-reliance.mjs` counts every `/v1/` code reference as OpenWOP
 * reliance. Stripe's REST API is also `/v1/…`, so ADR 0786 exempts lines that
 * call Stripe's one choke (`stripeRequest(`) inside its one file. An exemption is
 * a hole in a ratchet; this file pins exactly how far it reaches:
 *   1. an ordinary OpenWOP `/v1/runs` line still COUNTS;
 *   2. a same-line `stripeRequest(…'/v1/…')` in the choke file is SKIPPED;
 *   3. a MULTI-LINE call whose `/v1/…` argument sits on its own line is COUNTED
 *      (the scan is line-based — stated, and conservative: it can only under-reach);
 *   4. `stripeRequest(` in ANY other file is not exempt AND is a violation;
 *   5. a choke whose `stripeApiBase()` stops defaulting to api.stripe.com is a
 *      violation;
 *   6. the REAL tree has no violation, and the real entry point runs green on it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanMatches, stripeChokeViolations, V1_PATH } from '../../../scripts/v1RelianceScan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SRC = 'backend/typescript/src';
const CHOKE_OK = `function stripeApiBase(): string {\n  return (process.env.OPENWOP_STRIPE_API_BASE ?? 'https://api.stripe.com').replace(/\\/+$/, '');\n}\n`;

let tmp: string;
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'owp-v1rel-')); });
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmp, 'root-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return dir;
}
const count = (root: string) => scanMatches(root, SRC, V1_PATH, ['*.ts']).filter((m) => !m.startsWith('/v1/host/'));

describe('v1-reliance scanner — the Stripe exemption\'s reach (ADR 0786)', () => {
  it('leg 1: an ordinary OpenWOP /v1/runs reference COUNTS', () => {
    const root = tree({ [`${SRC}/routes/runs.ts`]: "app.get('/v1/runs', handler);\n", [`${SRC}/features/billing/stripeApi.ts`]: CHOKE_OK });
    expect(count(root)).toEqual(['/v1/runs']);
  });

  it('leg 2: a same-line stripeRequest( call in the choke file is SKIPPED', () => {
    const root = tree({ [`${SRC}/features/billing/stripeApi.ts`]: CHOKE_OK + "  const b = await stripeRequest(key, 'GET', `/v1/subscriptions/${id}`);\n" });
    expect(count(root)).toEqual([]);
  });

  it('leg 3: a MULTI-LINE stripeRequest( whose /v1/ path is on its own line is COUNTED (line-based, by design)', () => {
    const root = tree({ [`${SRC}/features/billing/stripeApi.ts`]: CHOKE_OK + "  const b = await stripeRequest(\n    key,\n    'GET',\n    '/v1/customers',\n  );\n" });
    expect(count(root)).toEqual(['/v1/customers']);
  });

  it('leg 4: stripeRequest( in ANY other file is not exempt — and is a violation', () => {
    const root = tree({
      [`${SRC}/features/billing/stripeApi.ts`]: CHOKE_OK,
      [`${SRC}/features/other/wrapper.ts`]: "await stripeRequest(key, 'POST', '/v1/runs');\n",
    });
    expect(count(root)).toEqual(['/v1/runs']);
    expect(stripeChokeViolations(root)).toEqual([expect.stringContaining('features/other/wrapper.ts')]);
  });

  it('leg 5: a choke whose base no longer defaults to api.stripe.com is a violation', () => {
    const root = tree({ [`${SRC}/features/billing/stripeApi.ts`]: "function stripeApiBase(): string {\n  return process.env.X ?? 'http://localhost:8080';\n}\n" });
    expect(stripeChokeViolations(root)).toEqual([expect.stringContaining('api.stripe.com')]);
  });

  it('leg 6: the REAL tree has no violation, and the real entry point runs green', () => {
    expect(stripeChokeViolations(ROOT)).toEqual([]);
    const out = execFileSync('node', [join(ROOT, 'scripts', 'check-v1-reliance.mjs')], { cwd: ROOT, encoding: 'utf8' });
    expect(out).toContain('no new v1 reliance');
  });
});
