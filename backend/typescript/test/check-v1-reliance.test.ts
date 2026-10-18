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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanMatches, stripeChokeViolations, keptLines, ownV1Pattern, KEEP_MARKER, V1_PATH } from '../../../scripts/v1RelianceScan.mjs';

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
  // #4484 — the scanner reads the git index, so a fixture tree is a repo with its files added.
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  return dir;
}
/** Built, not written: a literal here would itself count in this repo's testCorpusV1Refs. */
const V1_RUNS = ['', 'v1', 'runs'].join('/');
const count = (root: string) => scanMatches(root, SRC, V1_PATH, ['*.ts']).filter((m) => !m.startsWith('/v1/host/'));

describe('v1-reliance scanner — the Stripe exemption\'s reach (ADR 0786)', () => {
  it('#4484: an UNTRACKED file is not counted (a concurrent run\'s transient file is not reliance)', () => {
    const root = tree({ [`${SRC}/routes/runs.ts`]: `app.get('${V1_RUNS}', handler);\n`, [`${SRC}/features/billing/stripeApi.ts`]: CHOKE_OK });
    writeFileSync(join(root, SRC, 'routes', 'transient.ts'), `fetch('${V1_RUNS}/x');\n`);
    expect(count(root)).toEqual([V1_RUNS]);
  });

  it('#4484: a scan outside a git repo FAILS rather than reading as zero', () => {
    const dir = mkdtempSync(join(tmp, 'norepo-'));
    mkdirSync(join(dir, SRC), { recursive: true });
    writeFileSync(join(dir, SRC, 'a.ts'), `fetch('${V1_RUNS}');\n`);
    expect(() => count(dir)).toThrow();
  });

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

/**
 * ADR 0812 P4 slice 2b — the own-path gate and the KEEP marker. `ownV1PathRefs`
 * fails at any count above zero, so how far its pattern reaches is the whole
 * question: too narrow and it passes a real `/v1` call, too wide and it reds on
 * OpenAI's `/v1/chat/completions` forever.
 */
describe('v1-reliance — own-path gate and KEEP marker (ADR 0812 P4 slice 2b)', () => {
  const own = (root: string) => scanMatches(root, SRC, ownV1Pattern(['runs', 'interrupts']), ['*.ts']);

  it('leg 7: an own path spelled /v1 COUNTS, in every quoting and with :verb suffixes', () => {
    const root = tree({ [`${SRC}/a.ts`]: "f('/v1/runs');\nf(`${o}/v1/runs/${id}`);\nf(\"/v1/interrupts/x\");\nf('/v1/runs:fork');\nf('/v1/host/openwop-app/x');\n" });
    expect(own(root)).toHaveLength(5);
  });

  it('leg 8: a third-party /v1 API and a longer segment do NOT count', () => {
    const root = tree({ [`${SRC}/b.ts`]: "fetch('https://api.openai.com/v1/chat/completions');\nf('/v1/packs/x');\nf('/v1/runsheet');\n" });
    expect(own(root)).toEqual([]);
  });

  it('leg 9: a KEEP-marked line is skipped by the scan and counted by keptLines', () => {
    const root = tree({ [`${SRC}/c.ts`]: `const K = 'POST:/v1/runs';  // ${KEEP_MARKER}: persisted key\nconst L = 'POST:/v1/runs';\n` });
    expect(own(root)).toEqual(["/v1/runs'"]);
    expect(keptLines(root, [SRC], ['*.ts'])).toHaveLength(1);
  });

  it('leg 10: the real entry point FAILS, naming file:line, when an own /v1 path lands in shipped code', () => {
    const root = tree({
      [`${SRC}/features/billing/stripeApi.ts`]: CHOKE_OK,
      [`${SRC}/x.ts`]: 'export const u = `${o}/v1/runs/${id}`;\n',
      'schemas/v2/path-manifest.json': JSON.stringify({ operations: [{ path: '/runs' }] }),
      [`${SRC}/middleware/protocolVersion.ts`]: 'export function preferredVersion(): string {\n  return PROTOCOL_VERSION_V2;\n}\n',
      'scripts/v1-reliance-baseline.json': '{}',
    });
    for (const f of ['check-v1-reliance.mjs', 'v1RelianceScan.mjs']) writeFileSync(join(root, 'scripts', f), readFileSync(join(ROOT, 'scripts', f)));
    let code = 0; let err = '';
    try { execFileSync('node', [join(root, 'scripts', 'check-v1-reliance.mjs')], { cwd: root, encoding: 'utf8', stdio: 'pipe' }); }
    catch (e) { code = (e as { status: number }).status; err = String((e as { stderr: string }).stderr); }
    expect(code).toBe(1);
    expect(err).toContain(`${SRC}/x.ts:1`);
  });
});
